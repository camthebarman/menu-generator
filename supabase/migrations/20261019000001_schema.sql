-- Table Zero Menu Lab — core schema.
-- Conventions:
--   * Every tenant row carries org_id; child rows reference parents with (org_id, id) composite
--     foreign keys so a row can never point at another organization's data.
--   * Quantities are numeric(20,6) in the ingredient's base unit (g, ml, each); money numeric(14,4).
--   * Lots carry a balance; lot_movements is the append-only ledger.
--   * Quantity-changing writes happen only through SECURITY DEFINER functions (see functions migration).

create extension if not exists pgcrypto;

create schema if not exists app;

-- ---------------------------------------------------------------- organizations & membership

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 120),
  timezone text not null default 'America/New_York',
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  policy jsonb not null default jsonb_build_object(
    'cutoffInclusive', true, 'useByIsHard', true, 'expirationIsHard', true, 'sellByPassed', 'info',
    'requireCutoffForPerishable', true, 'requireVerifiedDatesForPerishable', true, 'alertDays', 2,
    'jurisdictionNote', 'Configure to match your local health code and verified operating procedures.'),
  target_cost_pct numeric(6,4) check (target_cost_pct is null or (target_cost_pct > 0 and target_cost_pct < 1)),
  equipment text[] not null default '{}',
  created_at timestamptz not null default now()
);

create table public.memberships (
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null,
  role text not null check (role in ('owner', 'manager', 'staff')),
  workspaces text[] not null default '{food,bar}' check (workspaces <@ array['food','bar']::text[]),
  display_name text,
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index memberships_user_idx on public.memberships(user_id);

-- ---------------------------------------------------------------- ingredient catalog

-- Public starter catalog: copied into each organization at provisioning time.
create table public.starter_ingredients (
  id text primary key,
  data jsonb not null
);

create table public.ingredients (
  org_id uuid not null references public.organizations(id) on delete cascade,
  id text not null check (length(id) between 1 and 80),
  name text not null check (length(name) between 1 and 120),
  category text not null,
  dimension text not null check (dimension in ('mass', 'volume', 'count')),
  aliases jsonb not null default '[]' check (jsonb_typeof(aliases) = 'array'),
  allergens text[],                      -- null = unknown
  allergens_verified boolean not null default false,
  diet jsonb not null default '{"vegetarian": null, "vegan": null}',
  alcoholic boolean,                     -- null = unknown
  abv numeric(5,2),
  perishable boolean not null default true,
  pantry_staple boolean not null default false,
  conversions jsonb not null default '[]' check (jsonb_typeof(conversions) = 'array'),
  edible_yield numeric(7,6) check (edible_yield is null or (edible_yield > 0 and edible_yield <= 1)),
  reference_cost jsonb,
  spirit_style text,
  notes text,
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  unique (org_id, name)
);

create table public.confirmed_staples (
  org_id uuid not null,
  ingredient_id text not null,
  assume_zero_cost boolean not null default false,
  confirmed_by text not null,
  confirmed_at timestamptz not null default now(),
  primary key (org_id, ingredient_id),
  foreign key (org_id, ingredient_id) references public.ingredients(org_id, id) on delete cascade
);

-- ---------------------------------------------------------------- inventory

create table public.lots (
  id text primary key,
  org_id uuid not null references public.organizations(id) on delete cascade,
  ingredient_id text not null,
  form text not null check (form in ('raw', 'cooked', 'prepared')),
  brand text, product text,
  quantity numeric(20,6) check (quantity is null or quantity >= 0),   -- null = unknown
  entered_quantity numeric(20,6),
  entered_unit text not null,
  package_size jsonb,
  pool text not null check (pool in ('food', 'bar', 'shared')),
  storage text not null default 'dry' check (storage in ('dry', 'refrigerated', 'frozen', 'bar_rail', 'other')),
  location text,
  received_at timestamptz not null default now(),
  opened_on date, prepared_on date, package_date date, quality_date date, sell_by_date date,
  use_by_date date, expiration_date date, operational_discard_date date, hard_discard_date date,
  label_wording text,
  label_date_type text,
  date_provenance text not null default 'unknown',
  date_verification text not null default 'unverified' check (date_verification in ('verified', 'unverified')),
  cost jsonb,
  supplier text, lot_ref text, allergens text[], notes text,
  status text not null default 'available'
    check (status in ('available', 'needs_review', 'quarantined', 'spoiled', 'discarded', 'depleted', 'recalled')),
  quality_review jsonb,
  lineage jsonb,
  parent_lot_id text,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, ingredient_id) references public.ingredients(org_id, id),
  foreign key (org_id, parent_lot_id) references public.lots(org_id, id)
);
create index lots_org_ing_idx on public.lots(org_id, ingredient_id, form);

create table public.lot_movements (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  lot_id text not null,
  type text not null check (type in ('receipt', 'opening', 'adjustment', 'waste', 'usage', 'prep_output', 'transfer_out', 'transfer_in', 'status_change')),
  delta numeric(20,6) not null default 0,
  from_pool text, to_pool text,
  plan_id text, reservation_id text, prep_batch_id text,
  reason text not null,
  actor_id uuid,
  source text not null default 'ui' check (source in ('ui', 'import', 'system', 'api')),
  at timestamptz not null default now(),
  idempotency_key text,
  foreign key (org_id, lot_id) references public.lots(org_id, id)
);
create index lot_movements_lot_idx on public.lot_movements(org_id, lot_id);

-- ---------------------------------------------------------------- recipes

create table public.recipes (
  id text primary key,
  org_id uuid references public.organizations(id) on delete cascade,   -- null = public starter
  name text not null check (length(name) between 1 and 160),
  workspaces text[] not null check (workspaces <@ array['food','bar']::text[] and cardinality(workspaces) > 0),
  category text not null check (category in ('main','side','sauce','dessert','special','cocktail','zero_proof','syrup','garnish','batched')),
  tags text[] not null default '{}',
  cuisine text,
  description text,
  provenance jsonb not null check (provenance ? 'kind' and provenance->>'kind' in ('house', 'starter', 'imported', 'ai_draft')),
  current_version_id text not null,
  produces jsonb,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  -- starter content is public; everything else must belong to an org
  check ((org_id is null) = (provenance->>'kind' = 'starter'))
);
create unique index recipes_org_id_key on public.recipes(org_id, id) where org_id is not null;

create table public.recipe_versions (
  id text primary key,
  recipe_id text not null references public.recipes(id) on delete cascade,
  org_id uuid references public.organizations(id) on delete cascade,
  version integer not null check (version > 0),
  lines jsonb not null check (jsonb_typeof(lines) = 'array'),
  yield jsonb not null,
  servings numeric(12,4) not null check (servings > 0),
  method jsonb not null default '[]',
  equipment text[] not null default '{}',
  active_minutes integer, total_minutes integer,
  allergen_status text not null default 'unverified',
  confirmed boolean not null default false,
  output_hold_days integer, output_hold_verified boolean not null default false,
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid,
  unique (recipe_id, version)
);

-- Versions are immutable except for the human confirmation flag.
create or replace function app.recipe_version_immutable() returns trigger language plpgsql as $$
begin
  if (new.lines, new.yield, new.servings, new.method, new.recipe_id, new.version, new.org_id)
     is distinct from (old.lines, old.yield, old.servings, old.method, old.recipe_id, old.version, old.org_id) then
    raise exception 'recipe versions are immutable; create a new version' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger recipe_versions_immutable before update on public.recipe_versions
  for each row execute function app.recipe_version_immutable();

-- ---------------------------------------------------------------- menus

create table public.menu_items (
  id text primary key,
  org_id uuid not null references public.organizations(id) on delete cascade,
  workspace text not null check (workspace in ('food', 'bar')),
  name text not null,
  recipe_id text references public.recipes(id),
  recipe_version_id text references public.recipe_versions(id),
  mapping_status text not null check (mapping_status in ('confirmed', 'unverified', 'missing')),
  expected_portions numeric(12,4) check (expected_portions is null or expected_portions >= 0),
  sale_price numeric(14,4),
  active boolean not null default true,
  unique (org_id, id)
);

create table public.protections (
  id text primary key,
  org_id uuid not null,
  workspace text not null check (workspace in ('food', 'bar')),
  ingredient_id text not null,
  form text not null check (form in ('raw', 'cooked', 'prepared')),
  quantity numeric(20,6) not null check (quantity > 0),
  unit text not null,
  note text,
  foreign key (org_id, ingredient_id) references public.ingredients(org_id, id)
);

-- ---------------------------------------------------------------- plans & reservations

create table public.plans (
  id text primary key,
  org_id uuid not null references public.organizations(id) on delete cascade,
  workspace text not null check (workspace in ('food', 'bar')),
  name text not null,
  kind text not null check (kind in ('special', 'prep', 'drink', 'component')),
  service_date date not null,
  targets jsonb not null check (jsonb_typeof(targets) = 'array'),
  status text not null default 'draft' check (status in ('draft', 'reserved', 'completed', 'cancelled')),
  options jsonb not null default '{}',
  basis_hash text,
  allocations jsonb not null default '[]',
  notes text,
  source text not null default 'manual' check (source in ('manual', 'ai_draft')),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, id)
);

create table public.reservations (
  id text primary key default ('res_' || gen_random_uuid()),
  org_id uuid not null,
  plan_id text not null,
  lot_id text not null,
  ingredient_id text not null,
  form text not null,
  quantity numeric(20,6) not null check (quantity > 0),
  consumed numeric(20,6) not null default 0 check (consumed >= 0 and consumed <= quantity),
  status text not null default 'active' check (status in ('active', 'consumed', 'released')),
  purpose text not null default 'plan' check (purpose in ('plan', 'menu')),
  workspace text not null check (workspace in ('food', 'bar')),
  menu_item_id text,
  service_date date not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  foreign key (org_id, plan_id) references public.plans(org_id, id),
  foreign key (org_id, lot_id) references public.lots(org_id, id)
);
create index reservations_lot_active_idx on public.reservations(lot_id) where status = 'active';

create table public.prep_batches (
  id text primary key,
  org_id uuid not null,
  plan_id text not null,
  recipe_id text not null references public.recipes(id),
  recipe_version_id text not null references public.recipe_versions(id),
  output_lot_id text not null,
  output_quantity numeric(20,6) not null,
  prepared_on date not null,
  pool text not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  foreign key (org_id, plan_id) references public.plans(org_id, id),
  foreign key (org_id, output_lot_id) references public.lots(org_id, id)
);

-- ---------------------------------------------------------------- shopping, imports, audit, idempotency

create table public.shopping_lists (
  id text primary key,
  org_id uuid not null references public.organizations(id) on delete cascade,
  workspace text not null check (workspace in ('food', 'bar')),
  service_date date not null,
  selections jsonb not null,
  created_at timestamptz not null default now()
);

create table public.imports (
  id text primary key,
  org_id uuid not null references public.organizations(id) on delete cascade,
  kind text not null check (kind in ('inventory', 'recipes', 'menu')),
  file_name text not null,
  content_hash text not null,
  row_count integer not null check (row_count between 0 and 2000),
  created_ids text[] not null default '{}',
  actor_id uuid,
  committed_at timestamptz not null default now(),
  unique (org_id, kind, content_hash)
);

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  actor_id uuid,
  action text not null,
  entity text not null,
  entity_id text not null,
  reason text,
  source text not null default 'ui',
  details jsonb,
  at timestamptz not null default now()
);
create index audit_events_org_idx on public.audit_events(org_id, at desc);

create table public.idempotency_keys (
  org_id uuid not null references public.organizations(id) on delete cascade,
  key text not null check (length(key) between 8 and 200),
  result jsonb,
  created_at timestamptz not null default now(),
  primary key (org_id, key)
);

create table public.ai_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null,
  at timestamptz not null default now(),
  ok boolean not null default false
);
create index ai_requests_rate_idx on public.ai_requests(org_id, user_id, at desc);

-- Ledger is append-only.
create or replace function app.append_only() returns trigger language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = 'insufficient_privilege';
end $$;
create trigger lot_movements_append_only before update or delete on public.lot_movements
  for each row execute function app.append_only();
create trigger audit_events_append_only before update or delete on public.audit_events
  for each row execute function app.append_only();
