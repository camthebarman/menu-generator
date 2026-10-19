-- Team management (invite codes, roles, workspaces), atomic inventory import, and identity helper.

-- ---------------------------------------------------------------- identity

create or replace function public.whoami()
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('userId', auth.uid());
$$;

-- ---------------------------------------------------------------- invites
-- Codes are shown once to the manager who creates them; only a SHA-256 hash is stored.

create table public.org_invites (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  code_hash text not null unique,
  role text not null check (role in ('manager', 'staff')),
  workspaces text[] not null check (workspaces <@ array['food','bar']::text[] and cardinality(workspaces) > 0),
  note text,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  used_by uuid,
  used_at timestamptz,
  revoked boolean not null default false
);
alter table public.org_invites enable row level security;
grant select on public.org_invites to authenticated;
create policy invites_select on public.org_invites for select to authenticated using (app.is_manager(org_id));

create or replace function public.create_invite(p_org uuid, p_role text, p_workspaces text[], p_note text default null, p_days int default 7)
returns jsonb language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare m public.memberships; v_code text; v_id uuid;
begin
  m := app.membership(p_org);
  if not app.m_is_manager(m) then perform app.fail('forbidden', 'only managers can invite'); end if;
  if p_role = 'manager' and m.role <> 'owner' then perform app.fail('forbidden', 'only owners can invite managers'); end if;
  if p_days < 1 or p_days > 30 then perform app.fail('invalid', 'expiry must be 1-30 days'); end if;
  v_code := upper(translate(encode(gen_random_bytes(9), 'base64'), '+/=', 'XYZ'));
  insert into public.org_invites(org_id, code_hash, role, workspaces, note, created_by, expires_at)
  values (p_org, encode(digest(v_code, 'sha256'), 'hex'), p_role, p_workspaces, p_note, auth.uid(), now() + make_interval(days => p_days))
  returning id into v_id;
  perform app.audit(p_org, 'invite.create', 'invite', v_id::text, p_note, jsonb_build_object('role', p_role, 'workspaces', p_workspaces));
  return jsonb_build_object('inviteId', v_id, 'code', v_code);
end $$;

create or replace function public.accept_invite(p_code text, p_display_name text)
returns uuid language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare i public.org_invites;
begin
  if auth.uid() is null then perform app.fail('unauthenticated', 'sign in first'); end if;
  select * into i from public.org_invites where code_hash = encode(digest(upper(trim(p_code)), 'sha256'), 'hex') for update;
  if not found or i.revoked or i.used_by is not null or i.expires_at < now() then
    perform app.fail('invalid', 'invite code is invalid, used, or expired');
  end if;
  if exists (select 1 from public.memberships where org_id = i.org_id and user_id = auth.uid()) then
    perform app.fail('conflict', 'you are already a member of this organization');
  end if;
  insert into public.memberships(org_id, user_id, role, workspaces, display_name) values (i.org_id, auth.uid(), i.role, i.workspaces, nullif(trim(p_display_name), ''));
  update public.org_invites set used_by = auth.uid(), used_at = now() where id = i.id;
  perform app.audit(i.org_id, 'invite.accept', 'membership', auth.uid()::text, null, jsonb_build_object('role', i.role));
  return i.org_id;
end $$;

create or replace function public.revoke_invite(p_org uuid, p_invite uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare m public.memberships;
begin
  m := app.membership(p_org);
  if not app.m_is_manager(m) then perform app.fail('forbidden', 'only managers can revoke invites'); end if;
  update public.org_invites set revoked = true where id = p_invite and org_id = p_org;
  perform app.audit(p_org, 'invite.revoke', 'invite', p_invite::text, null, null);
end $$;

-- Role/workspace changes go through this function so owners can't be demoted by managers and the
-- last owner can't be removed.
create or replace function public.update_member(p_org uuid, p_user uuid, p_role text, p_workspaces text[], p_remove boolean default false)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare m public.memberships; t public.memberships;
begin
  m := app.membership(p_org);
  if not app.m_is_manager(m) then perform app.fail('forbidden', 'only managers can change members'); end if;
  select * into t from public.memberships where org_id = p_org and user_id = p_user for update;
  if not found then perform app.fail('not_found', 'member not found'); end if;
  if (t.role = 'owner' or p_role = 'owner' or p_role = 'manager') and m.role <> 'owner' then
    perform app.fail('forbidden', 'only owners can change owners or managers');
  end if;
  if t.role = 'owner' and (p_remove or p_role <> 'owner')
     and (select count(*) from public.memberships where org_id = p_org and role = 'owner') = 1 then
    perform app.fail('invalid', 'an organization needs at least one owner');
  end if;
  if p_remove then
    delete from public.memberships where org_id = p_org and user_id = p_user;
  else
    if p_role not in ('owner', 'manager', 'staff') then perform app.fail('invalid', 'unknown role'); end if;
    update public.memberships set role = p_role, workspaces = p_workspaces where org_id = p_org and user_id = p_user;
  end if;
  perform app.audit(p_org, case when p_remove then 'member.remove' else 'member.update' end, 'membership', p_user::text, null,
    jsonb_build_object('role', p_role, 'workspaces', p_workspaces));
end $$;

-- Direct membership writes are no longer needed by the app; keep them manager-gated by RLS but route
-- the UI through the functions above.

-- ---------------------------------------------------------------- atomic inventory import

-- All rows are received in one transaction; a repeated file (same content hash) is a no-op.
create or replace function public.import_lots(p_org uuid, p_file text, p_hash text, p_lots jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare m public.memberships; v_existing public.imports; l jsonb; v_res jsonb; v_ids text[] := '{}'; v_i int := 0;
begin
  m := app.membership(p_org);
  if jsonb_typeof(p_lots) <> 'array' then perform app.fail('invalid', 'lots must be an array'); end if;
  if jsonb_array_length(p_lots) > 2000 then perform app.fail('invalid', 'import limit is 2000 rows'); end if;
  perform pg_advisory_xact_lock(hashtextextended(p_org::text || ':import:' || p_hash, 0));
  select * into v_existing from public.imports where org_id = p_org and kind = 'inventory' and content_hash = p_hash;
  if found then return jsonb_build_object('importId', v_existing.id, 'created', cardinality(v_existing.created_ids), 'replayed', true); end if;
  for l in select * from jsonb_array_elements(p_lots) loop
    v_i := v_i + 1;
    v_res := public.receive_lot(p_org, l, 'import-' || p_hash || '-' || v_i, 'import');
    v_ids := v_ids || (v_res->>'lotId');
  end loop;
  insert into public.imports(id, org_id, kind, file_name, content_hash, row_count, created_ids, actor_id)
  values ('imp_' || gen_random_uuid(), p_org, 'inventory', p_file, p_hash, jsonb_array_length(p_lots), v_ids, auth.uid());
  return jsonb_build_object('importId', p_hash, 'created', cardinality(v_ids));
end $$;

revoke all on function public.whoami(), public.create_invite(uuid, text, text[], text, int), public.accept_invite(text, text),
  public.revoke_invite(uuid, uuid), public.update_member(uuid, uuid, text, text[], boolean), public.import_lots(uuid, text, text, jsonb) from public, anon;
grant execute on function public.whoami(), public.create_invite(uuid, text, text[], text, int), public.accept_invite(text, text),
  public.revoke_invite(uuid, uuid), public.update_member(uuid, uuid, text, text[], boolean), public.import_lots(uuid, text, text, jsonb) to authenticated;

-- Membership changes now go only through create_organization / accept_invite / update_member,
-- which enforce owner/manager rules that a plain RLS policy cannot.
drop policy if exists mem_insert on public.memberships;
drop policy if exists mem_update on public.memberships;
drop policy if exists mem_delete on public.memberships;
revoke insert, update, delete on public.memberships from authenticated;

-- Hosted Supabase grants anon/authenticated broad default privileges on new objects. Remove anon's
-- grants on objects created here and make later migrations (run as postgres) least-privilege by default.
revoke all on public.org_invites from anon;
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke execute on functions from anon, public;
