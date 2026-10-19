-- Transactional inventory operations. Each function:
--   * derives permissions from auth.uid() membership (never from arguments),
--   * locks affected lots FOR UPDATE in id order (deadlock-free) before validating,
--   * validates atomically (no negative stock, no over-reservation, eligibility on service date),
--   * writes the append-only ledger and an audit event,
--   * is idempotent per (org, idempotency key).
-- Errors use SQLSTATE P0001 with a stable "code: message" prefix the client maps to UI states.

-- ---------------------------------------------------------------- helpers

create or replace function app.fail(p_code text, p_msg text) returns void language plpgsql as $$
begin
  raise exception '%: %', p_code, p_msg using errcode = 'P0001';
end $$;

create or replace function app.membership(p_org uuid) returns public.memberships
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare m public.memberships;
begin
  if auth.uid() is null then perform app.fail('unauthenticated', 'sign in required'); end if;
  select * into m from public.memberships where org_id = p_org and user_id = auth.uid();
  if not found then perform app.fail('forbidden', 'not a member of this organization'); end if;
  return m;
end $$;

create or replace function app.m_is_manager(m public.memberships) returns boolean language sql immutable as $$
  select m.role in ('owner', 'manager');
$$;

create or replace function app.m_can_pool(m public.memberships, p_pool text) returns boolean language sql immutable as $$
  select m.role in ('owner', 'manager') or p_pool = 'shared' or p_pool = any(m.workspaces);
$$;

create or replace function app.m_can_ws(m public.memberships, p_ws text) returns boolean language sql immutable as $$
  select m.role in ('owner', 'manager') or p_ws = any(m.workspaces);
$$;

create or replace function app.org_today(p_org uuid) returns date language sql stable security definer set search_path = public, pg_temp as $$
  select (now() at time zone o.timezone)::date from public.organizations o where o.id = p_org;
$$;

-- Returns a cached result for a retried call, serializing concurrent retries on the same key.
create or replace function app.idem_get(p_org uuid, p_key text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v jsonb;
begin
  if p_key is null or length(p_key) = 0 then perform app.fail('invalid', 'idempotency key required'); end if;
  perform pg_advisory_xact_lock(hashtextextended(p_org::text || ':' || p_key, 0));
  select result into v from public.idempotency_keys where org_id = p_org and key = p_key;
  if found then return coalesce(v, 'null'::jsonb) || jsonb_build_object('replayed', true); end if;
  return null;
end $$;

create or replace function app.idem_put(p_org uuid, p_key text, p_result jsonb) returns jsonb
language sql security definer set search_path = public, pg_temp as $$
  insert into public.idempotency_keys(org_id, key, result) values (p_org, p_key, p_result) returning result;
$$;

create or replace function app.audit(p_org uuid, p_action text, p_entity text, p_id text, p_reason text, p_details jsonb, p_source text default 'ui')
returns void language sql security definer set search_path = public, pg_temp as $$
  insert into public.audit_events(org_id, actor_id, action, entity, entity_id, reason, details, source)
  values (p_org, auth.uid(), p_action, p_entity, p_id, p_reason, p_details, p_source);
$$;

create or replace function app.reserved_on(p_lot text) returns numeric language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(quantity - consumed), 0) from public.reservations where lot_id = p_lot and status = 'active';
$$;

-- Earliest applicable hard cutoff for a lot under the org policy.
create or replace function app.hard_cutoff(l public.lots, p_policy jsonb) returns date language sql immutable as $$
  select least(
    l.hard_discard_date,
    l.operational_discard_date,
    case when coalesce((p_policy->>'useByIsHard')::boolean, true) then l.use_by_date end,
    case when coalesce((p_policy->>'expirationIsHard')::boolean, true) then l.expiration_date end,
    case when l.lineage is not null and not coalesce((l.lineage->>'cutoffRuleVerified')::boolean, false)
         then nullif(l.lineage->>'inheritedCutoff', '')::date end
  );
$$;

-- Null if the lot may be reserved/used for service on p_date; otherwise the reason it may not.
create or replace function app.lot_block_reason(l public.lots, p_date date, p_org uuid) returns text
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_policy jsonb; v_cut date; v_incl boolean; v_perishable boolean;
begin
  select policy into v_policy from public.organizations where id = p_org;
  v_incl := coalesce((v_policy->>'cutoffInclusive')::boolean, true);
  if l.status <> 'available' then return 'lot status is ' || l.status; end if;
  if l.quantity is null then return 'quantity unknown'; end if;
  v_cut := app.hard_cutoff(l, v_policy);
  if v_cut is not null and ((v_incl and p_date > v_cut) or (not v_incl and p_date >= v_cut)) then
    return 'past hard cutoff ' || v_cut;
  end if;
  if l.quality_date is not null and ((v_incl and p_date > l.quality_date) or (not v_incl and p_date >= l.quality_date))
     and not (l.quality_review is not null and (l.quality_review->>'validThrough')::date >= p_date) then
    return 'quality date passed; manager review required';
  end if;
  select i.perishable or l.form <> 'raw' into v_perishable from public.ingredients i where i.org_id = l.org_id and i.id = l.ingredient_id;
  if v_perishable and v_cut is null and coalesce((v_policy->>'requireCutoffForPerishable')::boolean, true) then
    return 'perishable lot has no cutoff date';
  end if;
  if v_perishable and v_cut is not null and l.date_verification <> 'verified' and coalesce((v_policy->>'requireVerifiedDatesForPerishable')::boolean, true) then
    return 'perishable lot date is unverified';
  end if;
  return null;
end $$;

create or replace function app.movement(p_org uuid, p_lot text, p_type text, p_delta numeric, p_reason text, p_extra jsonb default '{}', p_source text default 'ui')
returns void language sql security definer set search_path = public, pg_temp as $$
  insert into public.lot_movements(org_id, lot_id, type, delta, reason, actor_id, source, from_pool, to_pool, plan_id, reservation_id, prep_batch_id, idempotency_key)
  values (p_org, p_lot, p_type, p_delta, p_reason, auth.uid(), p_source, p_extra->>'from_pool', p_extra->>'to_pool', p_extra->>'plan_id',
          p_extra->>'reservation_id', p_extra->>'prep_batch_id', p_extra->>'idempotency_key');
$$;

-- ---------------------------------------------------------------- organizations

create or replace function public.create_organization(p_name text, p_timezone text, p_display_name text default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_org uuid;
begin
  if auth.uid() is null then perform app.fail('unauthenticated', 'sign in required'); end if;
  perform now() at time zone p_timezone; -- validates timezone name
  insert into public.organizations(name, timezone) values (p_name, p_timezone) returning id into v_org;
  insert into public.memberships(org_id, user_id, role, workspaces, display_name) values (v_org, auth.uid(), 'owner', '{food,bar}', p_display_name);
  insert into public.ingredients(org_id, id, name, category, dimension, aliases, allergens, allergens_verified, diet, alcoholic, abv,
                                 perishable, pantry_staple, conversions, edible_yield, reference_cost, spirit_style)
  select v_org, s.id, s.data->>'name', s.data->>'category', s.data->>'dimension', coalesce(s.data->'aliases', '[]'),
         case when s.data->'allergens' = 'null'::jsonb or s.data->'allergens' is null then null
              else array(select jsonb_array_elements_text(s.data->'allergens')) end,
         coalesce((s.data->>'allergensVerified')::boolean, false), coalesce(s.data->'diet', '{}'),
         (s.data->>'alcoholic')::boolean, (s.data->>'abv')::numeric, coalesce((s.data->>'perishable')::boolean, true),
         coalesce((s.data->>'pantryStaple')::boolean, false), coalesce(s.data->'conversions', '[]'), (s.data->>'edibleYield')::numeric,
         nullif(s.data->'referenceCost', 'null'::jsonb), s.data->>'spiritStyle'
  from public.starter_ingredients s;
  perform app.audit(v_org, 'org.create', 'organization', v_org::text, null, jsonb_build_object('name', p_name));
  return v_org;
end $$;

-- ---------------------------------------------------------------- lots

create or replace function public.receive_lot(p_org uuid, p_lot jsonb, p_idem text, p_source text default 'ui')
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare m public.memberships; v_cached jsonb; v_id text; v_qty numeric; v_result jsonb;
begin
  m := app.membership(p_org);
  v_cached := app.idem_get(p_org, p_idem);
  if v_cached is not null then return v_cached; end if;
  if not app.m_can_pool(m, p_lot->>'pool') then perform app.fail('forbidden', 'no access to pool ' || coalesce(p_lot->>'pool', '?')); end if;
  v_qty := nullif(p_lot->>'quantity', '')::numeric;
  if v_qty is not null and v_qty < 0 then perform app.fail('invalid', 'quantity cannot be negative'); end if;
  v_id := coalesce(p_lot->>'id', 'lot_' || gen_random_uuid());
  insert into public.lots(id, org_id, ingredient_id, form, brand, product, quantity, entered_quantity, entered_unit, package_size, pool, storage, location,
    received_at, opened_on, prepared_on, package_date, quality_date, sell_by_date, use_by_date, expiration_date, operational_discard_date, hard_discard_date,
    label_wording, label_date_type, date_provenance, date_verification, cost, supplier, lot_ref, allergens, notes, status)
  values (v_id, p_org, p_lot->>'ingredientId', coalesce(p_lot->>'form', 'raw'), p_lot->>'brand', p_lot->>'product', v_qty,
    nullif(p_lot->>'enteredQuantity', '')::numeric, coalesce(p_lot->>'enteredUnit', 'each'), nullif(p_lot->'packageSize', 'null'::jsonb), p_lot->>'pool',
    coalesce(p_lot->>'storage', 'dry'), p_lot->>'location', coalesce(nullif(p_lot->>'receivedAt', '')::timestamptz, now()),
    nullif(p_lot->>'openedOn', '')::date, nullif(p_lot->>'preparedOn', '')::date, nullif(p_lot->>'packageDate', '')::date, nullif(p_lot->>'qualityDate', '')::date,
    nullif(p_lot->>'sellByDate', '')::date, nullif(p_lot->>'useByDate', '')::date, nullif(p_lot->>'expirationDate', '')::date,
    nullif(p_lot->>'operationalDiscardDate', '')::date, nullif(p_lot->>'hardDiscardDate', '')::date, p_lot->>'labelWording', p_lot->>'labelDateType',
    coalesce(p_lot->>'dateProvenance', 'unknown'), coalesce(p_lot->>'dateVerification', 'unverified'), nullif(p_lot->'cost', 'null'::jsonb),
    p_lot->>'supplier', p_lot->>'lotRef', null, p_lot->>'notes', coalesce(p_lot->>'status', 'available'));
  perform app.movement(p_org, v_id, 'receipt', coalesce(v_qty, 0), case when v_qty is null then 'Received (quantity unknown)' else 'Received' end,
    jsonb_build_object('idempotency_key', p_idem), p_source);
  perform app.audit(p_org, 'lot.receive', 'lot', v_id, null, jsonb_build_object('quantity', v_qty, 'pool', p_lot->>'pool'), p_source);
  v_result := jsonb_build_object('lotId', v_id);
  return app.idem_put(p_org, p_idem, v_result);
end $$;

create or replace function public.update_lot_details(p_org uuid, p_lot_id text, p_patch jsonb, p_reason text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare m public.memberships; l public.lots; k text;
  allowed text[] := array['brand','product','storage','location','openedOn','preparedOn','packageDate','qualityDate','sellByDate','useByDate',
    'expirationDate','operationalDiscardDate','hardDiscardDate','labelWording','labelDateType','dateProvenance','dateVerification','cost','supplier','lotRef','notes'];
begin
  m := app.membership(p_org);
  select * into l from public.lots where org_id = p_org and id = p_lot_id for update;
  if not found then perform app.fail('not_found', 'lot not found'); end if;
  if not app.m_can_pool(m, l.pool) then perform app.fail('forbidden', 'no access to this lot'); end if;
  for k in select jsonb_object_keys(p_patch) loop
    if not (k = any(allowed)) then perform app.fail('invalid', 'field not editable: ' || k); end if;
  end loop;
  if l.lineage is not null and p_patch ? 'hardDiscardDate' and p_patch->>'hardDiscardDate' is null then
    perform app.fail('invalid', 'cannot remove a hard cutoff from a prepared lot');
  end if;
  update public.lots set
    brand = case when p_patch ? 'brand' then p_patch->>'brand' else brand end,
    product = case when p_patch ? 'product' then p_patch->>'product' else product end,
    storage = case when p_patch ? 'storage' then p_patch->>'storage' else storage end,
    location = case when p_patch ? 'location' then p_patch->>'location' else location end,
    opened_on = case when p_patch ? 'openedOn' then nullif(p_patch->>'openedOn', '')::date else opened_on end,
    prepared_on = case when p_patch ? 'preparedOn' then nullif(p_patch->>'preparedOn', '')::date else prepared_on end,
    package_date = case when p_patch ? 'packageDate' then nullif(p_patch->>'packageDate', '')::date else package_date end,
    quality_date = case when p_patch ? 'qualityDate' then nullif(p_patch->>'qualityDate', '')::date else quality_date end,
    sell_by_date = case when p_patch ? 'sellByDate' then nullif(p_patch->>'sellByDate', '')::date else sell_by_date end,
    use_by_date = case when p_patch ? 'useByDate' then nullif(p_patch->>'useByDate', '')::date else use_by_date end,
    expiration_date = case when p_patch ? 'expirationDate' then nullif(p_patch->>'expirationDate', '')::date else expiration_date end,
    operational_discard_date = case when p_patch ? 'operationalDiscardDate' then nullif(p_patch->>'operationalDiscardDate', '')::date else operational_discard_date end,
    hard_discard_date = case when p_patch ? 'hardDiscardDate' then nullif(p_patch->>'hardDiscardDate', '')::date else hard_discard_date end,
    label_wording = case when p_patch ? 'labelWording' then p_patch->>'labelWording' else label_wording end,
    label_date_type = case when p_patch ? 'labelDateType' then p_patch->>'labelDateType' else label_date_type end,
    date_provenance = case when p_patch ? 'dateProvenance' then p_patch->>'dateProvenance' else date_provenance end,
    date_verification = case when p_patch ? 'dateVerification' then p_patch->>'dateVerification' else date_verification end,
    cost = case when p_patch ? 'cost' then nullif(p_patch->'cost', 'null'::jsonb) else cost end,
    supplier = case when p_patch ? 'supplier' then p_patch->>'supplier' else supplier end,
    lot_ref = case when p_patch ? 'lotRef' then p_patch->>'lotRef' else lot_ref end,
    notes = case when p_patch ? 'notes' then p_patch->>'notes' else notes end,
    version = version + 1
  where id = p_lot_id;
  perform app.audit(p_org, 'lot.update', 'lot', p_lot_id, p_reason, jsonb_build_object('patch', p_patch));
end $$;

create or replace function public.adjust_lot(p_org uuid, p_lot_id text, p_new_quantity numeric, p_reason text, p_idem text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare m public.memberships; l public.lots; v_cached jsonb; v_delta numeric; v_res numeric;
begin
  m := app.membership(p_org);
  v_cached := app.idem_get(p_org, p_idem);
  if v_cached is not null then return v_cached; end if;
  if coalesce(trim(p_reason), '') = '' then perform app.fail('invalid', 'reason required'); end if;
  if p_new_quantity is null or p_new_quantity < 0 then perform app.fail('invalid', 'quantity cannot be negative'); end if;
  select * into l from public.lots where org_id = p_org and id = p_lot_id for update;
  if not found then perform app.fail('not_found', 'lot not found'); end if;
  if not app.m_can_pool(m, l.pool) then perform app.fail('forbidden', 'no access to this lot'); end if;
  v_res := app.reserved_on(p_lot_id);
  if p_new_quantity < v_res then perform app.fail('conflict', 'cannot set below reserved quantity ' || v_res); end if;
  v_delta := p_new_quantity - coalesce(l.quantity, 0);
  update public.lots set quantity = p_new_quantity, version = version + 1,
    status = case when p_new_quantity = 0 and status = 'available' then 'depleted'
                  when p_new_quantity > 0 and status = 'depleted' then 'available' else status end
  where id = p_lot_id;
  perform app.movement(p_org, p_lot_id, 'adjustment', v_delta, p_reason, jsonb_build_object('idempotency_key', p_idem));
  perform app.audit(p_org, 'lot.adjust', 'lot', p_lot_id, p_reason, jsonb_build_object('delta', v_delta));
  return app.idem_put(p_org, p_idem, jsonb_build_object('delta', v_delta));
end $$;

create or replace function public.record_waste(p_org uuid, p_lot_id text, p_quantity numeric, p_reason text, p_idem text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare m public.memberships; l public.lots; v_cached jsonb;
begin
  m := app.membership(p_org);
  v_cached := app.idem_get(p_org, p_idem);
  if v_cached is not null then return v_cached; end if;
  if coalesce(trim(p_reason), '') = '' then perform app.fail('invalid', 'waste reason required'); end if;
  if p_quantity is null or p_quantity <= 0 then perform app.fail('invalid', 'waste quantity must be positive'); end if;
  select * into l from public.lots where org_id = p_org and id = p_lot_id for update;
  if not found then perform app.fail('not_found', 'lot not found'); end if;
  if not app.m_can_pool(m, l.pool) then perform app.fail('forbidden', 'no access to this lot'); end if;
  if l.quantity is null then perform app.fail('invalid', 'set a known quantity first'); end if;
  if p_quantity > l.quantity - app.reserved_on(p_lot_id) then perform app.fail('conflict', 'waste exceeds unreserved quantity'); end if;
  update public.lots set quantity = quantity - p_quantity, version = version + 1,
    status = case when quantity - p_quantity = 0 and status = 'available' then 'depleted' else status end
  where id = p_lot_id;
  perform app.movement(p_org, p_lot_id, 'waste', -p_quantity, p_reason, jsonb_build_object('idempotency_key', p_idem));
  perform app.audit(p_org, 'lot.waste', 'lot', p_lot_id, p_reason, jsonb_build_object('quantity', p_quantity));
  return app.idem_put(p_org, p_idem, '{}'::jsonb);
end $$;

create or replace function public.set_lot_status(p_org uuid, p_lot_id text, p_status text, p_reason text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare m public.memberships; l public.lots;
begin
  m := app.membership(p_org);
  if coalesce(trim(p_reason), '') = '' then perform app.fail('invalid', 'reason required'); end if;
  select * into l from public.lots where org_id = p_org and id = p_lot_id for update;
  if not found then perform app.fail('not_found', 'lot not found'); end if;
  if not app.m_can_pool(m, l.pool) then perform app.fail('forbidden', 'no access to this lot'); end if;
  if p_status = 'available' and l.status in ('quarantined','spoiled','discarded','depleted','recalled') and not app.m_is_manager(m) then
    perform app.fail('forbidden', 'only managers can return a blocked lot to available');
  end if;
  update public.lots set status = p_status, version = version + 1 where id = p_lot_id;
  perform app.movement(p_org, p_lot_id, 'status_change', 0, l.status || ' -> ' || p_status || ': ' || p_reason);
  perform app.audit(p_org, 'lot.status', 'lot', p_lot_id, p_reason, jsonb_build_object('from', l.status, 'to', p_status));
end $$;

create or replace function public.approve_quality_review(p_org uuid, p_lot_id text, p_valid_through date, p_note text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare m public.memberships; l public.lots; v_cut date; v_policy jsonb;
begin
  m := app.membership(p_org);
  if not app.m_is_manager(m) then perform app.fail('forbidden', 'only managers can approve quality reviews'); end if;
  if coalesce(trim(p_note), '') = '' then perform app.fail('invalid', 'describe the review performed'); end if;
  select * into l from public.lots where org_id = p_org and id = p_lot_id for update;
  if not found then perform app.fail('not_found', 'lot not found'); end if;
  select policy into v_policy from public.organizations where id = p_org;
  v_cut := app.hard_cutoff(l, v_policy);
  if v_cut is not null and p_valid_through > v_cut then perform app.fail('invalid', 'review cannot extend past hard cutoff ' || v_cut); end if;
  update public.lots set quality_review = jsonb_build_object('approvedBy', coalesce(m.display_name, auth.uid()::text), 'approvedAt', now(), 'validThrough', p_valid_through, 'note', p_note),
    version = version + 1 where id = p_lot_id;
  perform app.audit(p_org, 'lot.quality_review', 'lot', p_lot_id, p_note, jsonb_build_object('validThrough', p_valid_through));
end $$;

-- Preserves lot identity, dates, cost, and provenance. Partial transfers split into a child lot.
create or replace function public.transfer_lot(p_org uuid, p_lot_id text, p_quantity numeric, p_to_pool text, p_reason text, p_idem text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare m public.memberships; l public.lots; v_cached jsonb; v_child text; v_res numeric;
begin
  m := app.membership(p_org);
  v_cached := app.idem_get(p_org, p_idem);
  if v_cached is not null then return v_cached; end if;
  if not app.m_is_manager(m) then perform app.fail('forbidden', 'only managers can transfer between pools'); end if;
  if p_to_pool not in ('food', 'bar', 'shared') then perform app.fail('invalid', 'unknown pool'); end if;
  if coalesce(trim(p_reason), '') = '' then perform app.fail('invalid', 'reason required'); end if;
  select * into l from public.lots where org_id = p_org and id = p_lot_id for update;
  if not found then perform app.fail('not_found', 'lot not found'); end if;
  if l.pool = p_to_pool then perform app.fail('invalid', 'lot already in that pool'); end if;
  if l.status in ('quarantined','spoiled','discarded','depleted','recalled') then perform app.fail('invalid', 'blocked lots cannot be transferred'); end if;
  v_res := app.reserved_on(p_lot_id);
  if p_quantity is null or p_quantity = l.quantity then
    if v_res > 0 then perform app.fail('conflict', 'release reservations before moving the whole lot'); end if;
    update public.lots set pool = p_to_pool, version = version + 1 where id = p_lot_id;
    perform app.movement(p_org, p_lot_id, 'transfer_out', 0, p_reason, jsonb_build_object('from_pool', l.pool, 'to_pool', p_to_pool, 'idempotency_key', p_idem));
    perform app.movement(p_org, p_lot_id, 'transfer_in', 0, p_reason, jsonb_build_object('from_pool', l.pool, 'to_pool', p_to_pool));
    v_child := p_lot_id;
  else
    if l.quantity is null then perform app.fail('invalid', 'quantity unknown'); end if;
    if p_quantity <= 0 or p_quantity > l.quantity - v_res then perform app.fail('conflict', 'transfer exceeds unreserved quantity'); end if;
    v_child := 'lot_' || gen_random_uuid();
    insert into public.lots
      select (jsonb_populate_record(null::public.lots, to_jsonb(l) || jsonb_build_object(
        'id', v_child, 'pool', p_to_pool, 'quantity', p_quantity, 'entered_quantity', null, 'parent_lot_id', l.id, 'version', 1, 'created_at', now()))).*;
    update public.lots set quantity = quantity - p_quantity, version = version + 1,
      status = case when quantity - p_quantity = 0 and status = 'available' then 'depleted' else status end
    where id = l.id;
    perform app.movement(p_org, l.id, 'transfer_out', -p_quantity, p_reason, jsonb_build_object('from_pool', l.pool, 'to_pool', p_to_pool, 'idempotency_key', p_idem));
    perform app.movement(p_org, v_child, 'transfer_in', p_quantity, p_reason, jsonb_build_object('from_pool', l.pool, 'to_pool', p_to_pool));
  end if;
  perform app.audit(p_org, 'lot.transfer', 'lot', p_lot_id, p_reason, jsonb_build_object('to', p_to_pool, 'quantity', p_quantity, 'lotId', v_child));
  return app.idem_put(p_org, p_idem, jsonb_build_object('lotId', v_child));
end $$;

-- ---------------------------------------------------------------- plans

-- Atomically revalidate and reserve concrete lots for a draft plan. The client computes the
-- deterministic allocation (FEFO, menu protection, components); the server re-checks every
-- hard constraint under row locks so concurrent reservations can never over-commit a lot.
create or replace function public.reserve_plan(p_org uuid, p_plan_id text, p_allocations jsonb, p_basis_hash text, p_idem text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  m public.memberships; p public.plans; l public.lots; v_cached jsonb; a record; v_reason text; v_reserved numeric; v_ids text[] := '{}'; v_id text;
begin
  m := app.membership(p_org);
  v_cached := app.idem_get(p_org, p_idem);
  if v_cached is not null then return v_cached; end if;
  select * into p from public.plans where org_id = p_org and id = p_plan_id for update;
  if not found then perform app.fail('not_found', 'plan not found'); end if;
  if not app.m_can_ws(m, p.workspace) then perform app.fail('forbidden', 'no access to the ' || p.workspace || ' workspace'); end if;
  if p.status <> 'draft' then perform app.fail('invalid', 'plan is ' || p.status); end if;
  if p.service_date < app.org_today(p_org) then perform app.fail('invalid', 'service date is in the past'); end if;
  if p.source = 'ai_draft' and exists (
      select 1 from jsonb_array_elements(p.targets) t join public.recipe_versions v on v.id = t->>'recipeVersionId' where not v.confirmed) then
    perform app.fail('invalid', 'AI-drafted recipes must be reviewed and confirmed before reserving');
  end if;
  if jsonb_typeof(p_allocations) <> 'array' or jsonb_array_length(p_allocations) = 0 then perform app.fail('invalid', 'no allocations'); end if;

  -- Lock every lot involved, in id order, before validating anything.
  perform 1 from public.lots where org_id = p_org and id in (select x->>'lotId' from jsonb_array_elements(p_allocations) x) order by id for update;

  for a in
    select x->>'lotId' as lot_id, max(x->>'ingredientId') as ingredient_id, max(x->>'form') as form,
           sum((x->>'quantity')::numeric) as quantity, max((x->>'lotVersion')::int) as lot_version
    from jsonb_array_elements(p_allocations) x group by x->>'lotId' order by x->>'lotId'
  loop
    if a.quantity is null or a.quantity <= 0 then perform app.fail('invalid', 'allocation quantity must be positive'); end if;
    select * into l from public.lots where org_id = p_org and id = a.lot_id;
    if not found then perform app.fail('not_found', 'lot ' || a.lot_id || ' not found'); end if;
    if not (l.pool = p.workspace or l.pool = 'shared') then perform app.fail('forbidden', 'lot ' || coalesce(l.lot_ref, l.id) || ' is in the ' || l.pool || ' pool'); end if;
    if l.ingredient_id <> a.ingredient_id or l.form <> a.form then perform app.fail('invalid', 'allocation does not match lot ingredient/form'); end if;
    if a.lot_version is not null and l.version <> a.lot_version then
      perform app.fail('stale_plan', 'lot ' || coalesce(l.lot_ref, l.id) || ' changed since the plan was checked; re-check and try again');
    end if;
    v_reason := app.lot_block_reason(l, p.service_date, p_org);
    if v_reason is not null then perform app.fail('not_eligible', coalesce(l.lot_ref, l.id) || ': ' || v_reason); end if;
    v_reserved := app.reserved_on(l.id);
    if v_reserved + a.quantity > l.quantity then
      perform app.fail('over_reservation', coalesce(l.lot_ref, l.id) || ' has only ' || (l.quantity - v_reserved) || ' unreserved');
    end if;
    insert into public.reservations(org_id, plan_id, lot_id, ingredient_id, form, quantity, workspace, service_date, created_by)
    values (p_org, p_plan_id, l.id, l.ingredient_id, l.form, a.quantity, p.workspace, p.service_date, auth.uid())
    returning id into v_id;
    v_ids := v_ids || v_id;
  end loop;
  update public.plans set status = 'reserved', allocations = p_allocations, basis_hash = coalesce(p_basis_hash, basis_hash), updated_at = now() where id = p_plan_id;
  perform app.audit(p_org, 'plan.reserve', 'plan', p_plan_id, null, jsonb_build_object('reservations', cardinality(v_ids)));
  return app.idem_put(p_org, p_idem, jsonb_build_object('reservationIds', to_jsonb(v_ids)));
end $$;

create or replace function public.release_plan(p_org uuid, p_plan_id text, p_reason text, p_cancel boolean)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare m public.memberships; p public.plans; v_n int;
begin
  m := app.membership(p_org);
  select * into p from public.plans where org_id = p_org and id = p_plan_id for update;
  if not found then perform app.fail('not_found', 'plan not found'); end if;
  if not app.m_can_ws(m, p.workspace) then perform app.fail('forbidden', 'no access to this workspace'); end if;
  if p.status = 'completed' then perform app.fail('invalid', 'plan already completed'); end if;
  update public.reservations set status = 'released' where org_id = p_org and plan_id = p_plan_id and status = 'active';
  get diagnostics v_n = row_count;
  update public.plans set status = case when p_cancel then 'cancelled' else 'draft' end, updated_at = now() where id = p_plan_id;
  perform app.audit(p_org, case when p_cancel then 'plan.cancel' else 'plan.release' end, 'plan', p_plan_id, p_reason, jsonb_build_object('released', v_n));
  return jsonb_build_object('released', v_n);
end $$;

-- Record preparation/usage: inputs decrease once, outputs appear once with lineage, unused
-- reservation remainders are released, and waste is recorded separately.
create or replace function public.complete_plan(p_org uuid, p_plan_id text, p_usage jsonb, p_waste jsonb, p_outputs jsonb, p_note text, p_idem text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  m public.memberships; p public.plans; r public.reservations; l public.lots; o jsonb; w jsonb; v_cached jsonb; v_policy jsonb;
  v_used numeric; v_wasted numeric; v_reason text; v_sources jsonb := '[]'; v_inherited date; v_cost numeric := 0; v_cost_known boolean := true;
  v_unit_cost numeric; v_out_id text; v_batch text; v_outs text[] := '{}'; v_released int := 0; v_recipe public.recipes; v_version text; v_today date;
begin
  m := app.membership(p_org);
  v_cached := app.idem_get(p_org, p_idem);
  if v_cached is not null then return v_cached; end if;
  select * into p from public.plans where org_id = p_org and id = p_plan_id for update;
  if not found then perform app.fail('not_found', 'plan not found'); end if;
  if not app.m_can_ws(m, p.workspace) then perform app.fail('forbidden', 'no access to this workspace'); end if;
  if p.status <> 'reserved' then perform app.fail('invalid', 'reserve the plan before recording preparation'); end if;
  select policy into v_policy from public.organizations where id = p_org;
  v_today := app.org_today(p_org);

  perform 1 from public.lots where org_id = p_org and id in (select lot_id from public.reservations where plan_id = p_plan_id and status = 'active') order by id for update;
  for r in select * from public.reservations where org_id = p_org and plan_id = p_plan_id and status = 'active' order by lot_id for update loop
    select * into l from public.lots where id = r.lot_id;
    v_reason := app.lot_block_reason(l, p.service_date, p_org);
    if v_reason is not null then perform app.fail('not_eligible', coalesce(l.lot_ref, l.id) || ': ' || v_reason); end if;
    v_used := coalesce((select (u->>'used')::numeric from jsonb_array_elements(coalesce(p_usage, '[]')) u where u->>'reservationId' = r.id limit 1), r.quantity - r.consumed);
    v_wasted := coalesce((select sum((x->>'quantity')::numeric) from jsonb_array_elements(coalesce(p_waste, '[]')) x where x->>'reservationId' = r.id), 0);
    if v_used < 0 or v_wasted < 0 then perform app.fail('invalid', 'quantities cannot be negative'); end if;
    if v_used + v_wasted > r.quantity - r.consumed then perform app.fail('invalid', 'usage plus waste exceeds reserved quantity'); end if;
    if l.quantity < v_used + v_wasted then perform app.fail('conflict', 'lot does not have enough stock'); end if;
    if v_used > 0 then
      update public.lots set quantity = quantity - v_used where id = l.id;
      perform app.movement(p_org, l.id, 'usage', -v_used, 'Used for ' || p.name, jsonb_build_object('plan_id', p_plan_id, 'reservation_id', r.id, 'idempotency_key', p_idem));
      v_sources := v_sources || jsonb_build_array(jsonb_build_object('lotId', l.id, 'ingredientId', l.ingredient_id, 'quantity', v_used));
      v_inherited := least(v_inherited, app.hard_cutoff(l, v_policy));
      -- cost.perBase is the per-base-unit cost normalized with ingredient conversions at entry.
      v_unit_cost := case
        when l.cost is null then null
        when l.cost ? 'perBase' then (l.cost->>'perBase')::numeric
        when l.cost->>'perUnit' in ('g', 'ml', 'each') and (l.cost->>'perQuantity')::numeric > 0 then (l.cost->>'amount')::numeric / (l.cost->>'perQuantity')::numeric
      end;
      if v_unit_cost is null then v_cost_known := false; else v_cost := v_cost + v_unit_cost * v_used; end if;
    end if;
    for w in select * from jsonb_array_elements(coalesce(p_waste, '[]')) x where x->>'reservationId' = r.id loop
      if coalesce(trim(w->>'reason'), '') = '' then perform app.fail('invalid', 'waste reason required'); end if;
      update public.lots set quantity = quantity - (w->>'quantity')::numeric where id = l.id;
      perform app.movement(p_org, l.id, 'waste', -(w->>'quantity')::numeric, w->>'reason', jsonb_build_object('plan_id', p_plan_id, 'reservation_id', r.id));
    end loop;
    update public.lots set version = version + 1, status = case when quantity = 0 and status = 'available' then 'depleted' else status end where id = l.id;
    if v_used + v_wasted < r.quantity - r.consumed then v_released := v_released + 1; end if;
    update public.reservations set consumed = consumed + v_used + v_wasted, status = 'consumed' where id = r.id;
  end loop;

  for o in select * from jsonb_array_elements(coalesce(p_outputs, '[]')) loop
    select * into v_recipe from public.recipes where id = o->>'recipeId' and (org_id is null or org_id = p_org);
    if not found or v_recipe.produces is null then perform app.fail('invalid', 'output recipe does not produce a component'); end if;
    if v_recipe.produces->>'ingredientId' <> o->>'ingredientId' or v_recipe.produces->>'form' <> o->>'form' then
      perform app.fail('invalid', 'output does not match what the recipe produces');
    end if;
    if not app.m_can_pool(m, o->>'pool') then perform app.fail('forbidden', 'no access to output pool'); end if;
    if (o->>'quantity')::numeric <= 0 then perform app.fail('invalid', 'output quantity must be positive'); end if;
    select coalesce((select t->>'recipeVersionId' from jsonb_array_elements(p.targets) t where t->>'recipeId' = v_recipe.id limit 1), v_recipe.current_version_id) into v_version;
    v_out_id := 'lot_' || gen_random_uuid();
    v_batch := 'prep_' || gen_random_uuid();
    insert into public.lots(id, org_id, ingredient_id, form, quantity, entered_quantity, entered_unit, pool, storage, location, received_at, prepared_on,
      use_by_date, label_date_type, date_provenance, date_verification, cost, status, lot_ref, lineage, notes)
    values (v_out_id, p_org, o->>'ingredientId', o->>'form', (o->>'quantity')::numeric, nullif(o->>'enteredQuantity', '')::numeric, coalesce(o->>'enteredUnit', 'g'),
      o->>'pool', coalesce(o->>'storage', 'refrigerated'), o->>'location', now(), v_today, nullif(o->>'useByDate', '')::date,
      case when nullif(o->>'useByDate', '') is null then 'none' else 'use_by' end,
      case when nullif(o->>'useByDate', '') is null then 'unknown' else 'staff_entry' end,
      case when coalesce((o->>'dateVerified')::boolean, false) then 'verified' else 'unverified' end,
      case when v_cost_known and jsonb_array_length(v_sources) > 0 then jsonb_build_object('amount', round(v_cost, 4), 'perQuantity', (o->>'quantity')::numeric, 'perUnit', coalesce(o->>'baseUnit', 'g')) end,
      'available', 'PREP-' || v_today,
      jsonb_build_object('prepBatchId', v_batch, 'recipeId', v_recipe.id, 'recipeVersionId', v_version, 'sources', v_sources,
                         'inheritedCutoff', v_inherited, 'cutoffRuleVerified', false),
      p_note);
    perform app.movement(p_org, v_out_id, 'prep_output', (o->>'quantity')::numeric, 'Prepared via ' || v_recipe.name, jsonb_build_object('plan_id', p_plan_id, 'prep_batch_id', v_batch));
    insert into public.prep_batches(id, org_id, plan_id, recipe_id, recipe_version_id, output_lot_id, output_quantity, prepared_on, pool, created_by)
    values (v_batch, p_org, p_plan_id, v_recipe.id, v_version, v_out_id, (o->>'quantity')::numeric, v_today, o->>'pool', auth.uid());
    v_outs := v_outs || v_out_id;
  end loop;

  update public.plans set status = 'completed', updated_at = now() where id = p_plan_id;
  perform app.audit(p_org, 'plan.complete', 'plan', p_plan_id, p_note, jsonb_build_object('outputs', to_jsonb(v_outs), 'released', v_released));
  return app.idem_put(p_org, p_idem, jsonb_build_object('outputLotIds', to_jsonb(v_outs), 'released', v_released));
end $$;

-- ---------------------------------------------------------------- recipes & settings

create or replace function public.confirm_recipe_version(p_org uuid, p_version_id text, p_note text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare m public.memberships; v public.recipe_versions;
begin
  m := app.membership(p_org);
  select * into v from public.recipe_versions where id = p_version_id and org_id = p_org for update;
  if not found then perform app.fail('not_found', 'recipe version not found in this organization'); end if;
  if exists (select 1 from jsonb_array_elements(v.lines) l
             where not coalesce((l->>'optional')::boolean, false) and (l->>'ingredientId' is null or l->>'quantity' is null)) then
    perform app.fail('invalid', 'map every required ingredient and enter its quantity before confirming');
  end if;
  update public.recipe_versions set confirmed = true where id = p_version_id;
  perform app.audit(p_org, 'recipe.confirm', 'recipe_version', p_version_id, p_note, null);
end $$;

create or replace function public.set_staple(p_org uuid, p_ingredient_id text, p_confirmed boolean, p_zero_cost boolean)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare m public.memberships;
begin
  m := app.membership(p_org);
  if not app.m_is_manager(m) then perform app.fail('forbidden', 'only managers can confirm staple assumptions'); end if;
  delete from public.confirmed_staples where org_id = p_org and ingredient_id = p_ingredient_id;
  if p_confirmed then
    insert into public.confirmed_staples(org_id, ingredient_id, assume_zero_cost, confirmed_by)
    values (p_org, p_ingredient_id, p_zero_cost, coalesce(m.display_name, auth.uid()::text));
  end if;
  perform app.audit(p_org, case when p_confirmed then 'staple.confirm' else 'staple.remove' end, 'ingredient', p_ingredient_id, null, null);
end $$;

-- Records an import batch once per (org, kind, content hash); returns false if already committed.
create or replace function public.register_import(p_org uuid, p_kind text, p_file text, p_hash text, p_rows int, p_ids text[])
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare m public.memberships;
begin
  m := app.membership(p_org);
  insert into public.imports(id, org_id, kind, file_name, content_hash, row_count, created_ids, actor_id)
  values ('imp_' || gen_random_uuid(), p_org, p_kind, p_file, p_hash, p_rows, p_ids, auth.uid())
  on conflict (org_id, kind, content_hash) do nothing;
  return found;
end $$;

-- Per-user AI rate limit, called by the edge function with the caller's JWT.
create or replace function public.ai_rate_check(p_org uuid, p_limit_per_hour int default 20)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare m public.memberships; v_n int;
begin
  m := app.membership(p_org);
  perform pg_advisory_xact_lock(hashtextextended(p_org::text || auth.uid()::text, 1));
  select count(*) into v_n from public.ai_requests where org_id = p_org and user_id = auth.uid() and at > now() - interval '1 hour';
  if v_n >= least(p_limit_per_hour, 60) then return false; end if;
  insert into public.ai_requests(org_id, user_id) values (p_org, auth.uid());
  return true;
end $$;

-- ---------------------------------------------------------------- grants

revoke all on all functions in schema public from public, anon;
revoke all on all functions in schema app from public, anon;
grant execute on function
  public.create_organization(text, text, text), public.receive_lot(uuid, jsonb, text, text), public.update_lot_details(uuid, text, jsonb, text),
  public.adjust_lot(uuid, text, numeric, text, text), public.record_waste(uuid, text, numeric, text, text), public.set_lot_status(uuid, text, text, text),
  public.approve_quality_review(uuid, text, date, text), public.transfer_lot(uuid, text, numeric, text, text, text),
  public.reserve_plan(uuid, text, jsonb, text, text), public.release_plan(uuid, text, text, boolean),
  public.complete_plan(uuid, text, jsonb, jsonb, jsonb, text, text), public.confirm_recipe_version(uuid, text, text),
  public.set_staple(uuid, text, boolean, boolean), public.register_import(uuid, text, text, text, int, text[]), public.ai_rate_check(uuid, int)
to authenticated;
grant execute on function app.is_member(uuid), app.is_manager(uuid), app.can_workspace(uuid, text), app.can_pool(uuid, text) to authenticated;
