-- Row Level Security. Permissions derive only from the authenticated user's membership rows.
-- Managers/owners see every pool; staff see Shared plus their configured workspaces.
-- Inventory ledger tables have no write policies: they change only through the audited
-- SECURITY DEFINER functions in the next migration.

-- ---------------------------------------------------------------- helpers
-- SECURITY DEFINER so policies can read memberships without recursive RLS evaluation.

create or replace function app.is_member(p_org uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.memberships m where m.org_id = p_org and m.user_id = auth.uid());
$$;

create or replace function app.is_manager(p_org uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.memberships m where m.org_id = p_org and m.user_id = auth.uid() and m.role in ('owner', 'manager'));
$$;

create or replace function app.can_workspace(p_org uuid, p_ws text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.memberships m
    where m.org_id = p_org and m.user_id = auth.uid() and (m.role in ('owner', 'manager') or p_ws = any(m.workspaces)));
$$;

create or replace function app.can_pool(p_org uuid, p_pool text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.memberships m
    where m.org_id = p_org and m.user_id = auth.uid()
      and (m.role in ('owner', 'manager') or p_pool = 'shared' or p_pool = any(m.workspaces)));
$$;

revoke all on function app.is_member(uuid), app.is_manager(uuid), app.can_workspace(uuid, text), app.can_pool(uuid, text) from public;
grant usage on schema app to authenticated;
grant execute on function app.is_member(uuid), app.is_manager(uuid), app.can_workspace(uuid, text), app.can_pool(uuid, text) to authenticated;

-- ---------------------------------------------------------------- cross-org integrity for nullable/public references

create or replace function app.check_recipe_ref() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_recipe_org uuid; v_version_recipe text;
begin
  if new.recipe_id is not null then
    select org_id into v_recipe_org from public.recipes where id = new.recipe_id;
    if not found then raise exception 'recipe % not found', new.recipe_id; end if;
    if v_recipe_org is not null and v_recipe_org <> new.org_id then
      raise exception 'cross-organization recipe reference denied' using errcode = 'insufficient_privilege';
    end if;
  end if;
  if tg_table_name in ('menu_items', 'prep_batches') and new.recipe_version_id is not null then
    select recipe_id into v_version_recipe from public.recipe_versions where id = new.recipe_version_id;
    if v_version_recipe is distinct from new.recipe_id then
      raise exception 'recipe version does not belong to recipe' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;

create trigger menu_items_recipe_ref before insert or update on public.menu_items for each row execute function app.check_recipe_ref();
create trigger prep_batches_recipe_ref before insert or update on public.prep_batches for each row execute function app.check_recipe_ref();

create or replace function app.check_version_org() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_org uuid;
begin
  select org_id into v_org from public.recipes where id = new.recipe_id;
  if v_org is distinct from new.org_id then
    raise exception 'recipe version org must match recipe org' using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;
create trigger recipe_versions_org before insert or update on public.recipe_versions for each row execute function app.check_version_org();

-- ---------------------------------------------------------------- enable RLS everywhere

alter table public.organizations enable row level security;
alter table public.memberships enable row level security;
alter table public.starter_ingredients enable row level security;
alter table public.ingredients enable row level security;
alter table public.confirmed_staples enable row level security;
alter table public.lots enable row level security;
alter table public.lot_movements enable row level security;
alter table public.recipes enable row level security;
alter table public.recipe_versions enable row level security;
alter table public.menu_items enable row level security;
alter table public.protections enable row level security;
alter table public.plans enable row level security;
alter table public.reservations enable row level security;
alter table public.prep_batches enable row level security;
alter table public.shopping_lists enable row level security;
alter table public.imports enable row level security;
alter table public.audit_events enable row level security;
alter table public.idempotency_keys enable row level security;
alter table public.ai_requests enable row level security;

-- Least privilege: anon gets nothing; authenticated gets table privileges gated by RLS.
revoke all on all tables in schema public from anon;
revoke all on all tables in schema public from authenticated;
grant select on all tables in schema public to authenticated;
grant insert, update, delete on public.ingredients, public.recipes, public.recipe_versions, public.menu_items,
  public.protections, public.plans, public.shopping_lists, public.organizations, public.memberships to authenticated;

-- organizations
create policy org_select on public.organizations for select to authenticated using (app.is_member(id));
create policy org_update on public.organizations for update to authenticated using (app.is_manager(id)) with check (app.is_manager(id));

-- memberships: members can see colleagues; only managers manage membership; nobody can grant
-- themselves into another org (insert requires manager of that org).
create policy mem_select on public.memberships for select to authenticated using (app.is_member(org_id));
create policy mem_insert on public.memberships for insert to authenticated with check (app.is_manager(org_id));
create policy mem_update on public.memberships for update to authenticated using (app.is_manager(org_id)) with check (app.is_manager(org_id));
create policy mem_delete on public.memberships for delete to authenticated using (app.is_manager(org_id));

-- public starter catalog
create policy starter_ing_select on public.starter_ingredients for select to authenticated using (true);

-- ingredient catalog
create policy ing_select on public.ingredients for select to authenticated using (app.is_member(org_id));
create policy ing_insert on public.ingredients for insert to authenticated with check (app.is_member(org_id));
create policy ing_update on public.ingredients for update to authenticated using (app.is_member(org_id)) with check (app.is_member(org_id));
create policy ing_delete on public.ingredients for delete to authenticated using (app.is_manager(org_id));
create policy staples_select on public.confirmed_staples for select to authenticated using (app.is_member(org_id));

-- inventory: pool-scoped reads; writes only via functions
create policy lots_select on public.lots for select to authenticated using (app.can_pool(org_id, pool));
create policy mov_select on public.lot_movements for select to authenticated using (
  exists (select 1 from public.lots l where l.org_id = lot_movements.org_id and l.id = lot_movements.lot_id and app.can_pool(l.org_id, l.pool)));

-- recipes: public starter content readable by any signed-in user; private recipes by members only
create policy rec_select on public.recipes for select to authenticated using (org_id is null or app.is_member(org_id));
create policy rec_insert on public.recipes for insert to authenticated with check (org_id is not null and app.is_member(org_id));
create policy rec_update on public.recipes for update to authenticated using (org_id is not null and app.is_member(org_id)) with check (org_id is not null and app.is_member(org_id));
create policy rv_select on public.recipe_versions for select to authenticated using (org_id is null or app.is_member(org_id));
create policy rv_insert on public.recipe_versions for insert to authenticated with check (org_id is not null and app.is_member(org_id));
-- Updating versions is limited to confirmation by trigger; confirmation itself goes through confirm_recipe_version().

-- menus & protection
create policy menu_select on public.menu_items for select to authenticated using (app.is_member(org_id));
create policy menu_write on public.menu_items for all to authenticated using (app.can_workspace(org_id, workspace)) with check (app.can_workspace(org_id, workspace));
create policy prot_select on public.protections for select to authenticated using (app.is_member(org_id));
create policy prot_write on public.protections for all to authenticated using (app.can_workspace(org_id, workspace)) with check (app.can_workspace(org_id, workspace));

-- plans: workspace-scoped; drafts editable directly; reserve/complete via functions
create policy plans_select on public.plans for select to authenticated using (app.can_workspace(org_id, workspace));
create policy plans_insert on public.plans for insert to authenticated with check (app.can_workspace(org_id, workspace) and status = 'draft');
create policy plans_update on public.plans for update to authenticated
  using (app.can_workspace(org_id, workspace) and status = 'draft') with check (app.can_workspace(org_id, workspace) and status = 'draft');

create policy res_select on public.reservations for select to authenticated using (app.can_workspace(org_id, workspace) or app.is_manager(org_id));
create policy prep_select on public.prep_batches for select to authenticated using (app.is_member(org_id) and app.can_pool(org_id, pool));
create policy shop_all on public.shopping_lists for all to authenticated using (app.can_workspace(org_id, workspace)) with check (app.can_workspace(org_id, workspace));
create policy imports_select on public.imports for select to authenticated using (app.is_member(org_id));
create policy audit_select on public.audit_events for select to authenticated using (app.is_manager(org_id));
-- idempotency_keys and ai_requests: no policies => no direct access.
