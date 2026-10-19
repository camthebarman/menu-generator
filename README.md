# Table Zero Menu Lab

Inventory-driven menu and recipe planning for independent restaurants and bars. It has separate **Food** and **Bar** workspaces on one shared inventory (Food, Bar, and Shared pools), a deterministic matching engine that groups results into *Make now / Need 1 / Need 2 / Needs review*, FEFO lot allocation, menu-stock protection, prep components with lineage, atomic reservations, combined shopping lists, and optional AI suggestions. The AI never replaces the engine's checks.

Stack: React 19 + TypeScript + Vite + Tailwind, Supabase (PostgreSQL, Auth, RLS, SQL functions, one Edge Function), and a pure TypeScript domain engine shared by demo and live modes.

## Quick start (demo, no accounts needed)

```bash
npm install
npm run dev            # http://localhost:5173
```

With no Supabase variables set, the app runs in **demo mode**:

- The demo has clearly labelled seed data: 106 ingredients, 56 original starter recipes (28 Food, 28 Bar), 85 lots, and current menus. Dates are relative to the day it is seeded.
- Data persists in this browser's `localStorage` under its own key, never touches a live organization, and **does not sync across devices**. Settings → Demo mode lets you switch role (manager / Food staff / Bar staff), freeze the demo clock, or reset.
- Deterministic URL for testing: `/?demoReset=1&demoDate=2026-10-19#/discover`.

The demo seed covers every required scenario: Make now, one-away (Garlic shrimp, Margarita), two-away (Basil pesto: 2 missing; Espresso martini: 1 missing + 1 insufficient), menu-protection conflicts (Beef bowl vs. the burger menu), Needs review cases (passed best-by parmesan, unknown-quantity cream, unverified ginger syrup date, an unconfirmed imported recipe with an unmapped ingredient), a hard-discard-past cooked-rice lot (never used; fried rice prepares fresh rice instead), at-risk chicken and mushrooms, Shared limes/lemons/cream/sugar, and prepared components (aioli, vinaigrette, juices, syrups).

## Core workflow

1. **Inventory**: quick add, bulk grid, or CSV import (column mapping → validation → preview → fix mappings → atomic commit; re-importing the same file has no effect). Example templates are in `public/templates/`. Unknown quantities, dates, and conversions stay visibly unresolved.
2. **Discover**: choose workspace, mode (Make now / Use older inventory / Create a special / Make one component), portions or batches, service date, ingredients or specific lots to prioritize, filters, and the *Protect current menu stock* toggle, which shows the effect of relaxing it.
3. **Inspect**: open a result to see exact scaled requirements, FEFO lot allocations with pool, dates and urgency, components to prepare, shortfalls rounded up, menu conflicts, assumptions, optional omissions, allergens and alcohol status, cost completeness, and separately revalidated substitutions.
4. **Plan**: *Save draft plan* never changes inventory. Combined specials share one demand calculation.
5. **Reserve**: the plan is re-checked against current stock and must be Make now. Actual lots are held but not consumed. Plans show a stale warning when inventory, dates, reservations, protection, or recipe versions change.
6. **Record**: record prep or usage with per-lot actual amounts. Unused remainders are released and waste is recorded separately. Prep outputs appear once, with source lineage, and inherit the earliest input cutoff.

## Live mode (Supabase)

```bash
supabase start                       # local stack (Docker), or use a hosted project
supabase db reset                    # applies supabase/migrations/* and supabase/seed.sql
cp .env.example .env.local           # set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY
npm run dev
```

Sign up, then create an organization. This copies the starter ingredient catalog into it, and starter recipes are public read-only content. Invite staff by inserting `memberships` rows (as a manager) with role `staff` and `workspaces` `{food}` or `{bar}`.

- **Migrations:** `20261019000001_schema.sql` (org-scoped composite FKs, numeric quantities, append-only ledger, immutable recipe versions), `…02_rls.sql` (RLS on every table, helper functions, least-privilege grants, cross-org reference triggers), `…03_functions.sql` (transactional RPCs: `receive_lot`, `adjust_lot`, `record_waste`, `set_lot_status`, `approve_quality_review`, `transfer_lot`, `reserve_plan`, `release_plan`, `complete_plan`, `confirm_recipe_version`, `set_staple`, `register_import`, `ai_rate_check`, `create_organization`).
- **Concurrency:** quantity-changing functions lock the affected lots `FOR UPDATE` in id order, then validate eligibility, pool, lot version (stale-plan detection), and `reserved + requested ≤ quantity`. Retried calls with the same idempotency key return the original result.
- `supabase/seed.sql` is generated from the TypeScript seed: `npm run gen:seed`.

## Optional AI

The core product works fully without AI. To enable it:

```bash
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...      # server-side only
supabase functions deploy ai-assist
# then set VITE_AI_ENABLED=true in the web app env
```

`supabase/functions/ai-assist` calls the Anthropic Messages API (`claude-opus-5-5` by default; override with `AI_MODEL`). It uses JSON-schema structured output and server-side refusal fallback. It runs as the calling user, so membership is checked under RLS. A per-user hourly rate limit, body size limit, and 90 s timeout apply. The provider receives only ingredient ids, names, units, and free quantities; costs, suppliers, and lot refs are never sent.

The browser re-validates every response (`src/domain/ai.ts`) and recomputes it through the engine. Disagreements are shown, for example a claimed "Make now" that is really Need 1, undisclosed additions, or more servings than stock supports. Results can only be saved as unconfirmed **AI draft** recipes. AI drafts sit in Needs review, cannot be reserved until a person confirms them, and can never set dates, change stock, or reserve.

## Tests

| Command | What it runs |
|---|---|
| `npm test` | 56 Vitest unit and integration tests with frozen time: engine, ops, imports/CSV, shopping, AI validation, seed coverage, demo repository |
| `npm run test:db` | 15 tests against a real throwaway PostgreSQL 16 cluster with a minimal Supabase auth shim: migrations, RLS on every table, cross-org denial for direct, nested, and mutation paths, pool permissions, true concurrent Shared reservations (row-lock blocking proven), stale versions, hard cutoffs, quality review, negative stock, idempotent receive/complete, prep lineage, ledger balance, append-only ledger, immutable versions |
| `npm run test:e2e` | Playwright happy paths on the production build: discover → draft → reserve → record (persists across reload), one-away → shopping list → CSV, Needs review and protection toggle, plus phone-width checks for no horizontal scroll |
| `npm run check` | Everything above plus typecheck and build |

`test:db` needs PostgreSQL server binaries (`initdb`/`pg_ctl`). Alternatively, set `PG_TEST_URL` to run against a local `supabase start` database.

## Project layout

```
src/domain/     pure engine: units, dates, eligibility, stock/protection, allocation, matching, ops, imports, shopping, AI validation
src/data/       repositories: demo (localStorage) and Supabase; AI client
src/seed/       starter ingredients and recipes (original content) and demo inventory
src/ui/         React screens: Discover, Inventory, Current menu, Recipes, Plans, Shopping, Settings
supabase/       migrations, seed.sql (generated), config.toml, functions/ai-assist
tests/          unit, integration, db (real Postgres), e2e (Playwright)
docs/RULES.md   date, eligibility, matching, protection, and costing rules
```

## Scope boundary

No billing, POS, OCR, automated purchasing, ERP, remote deployment, paid recipe APIs, or scraping. External recipe retrieval would go behind a provider interface, and none is configured.

## Important

Date alerts, eligibility rules, and allergen filters are planning aids. They are not food-safety guarantees, regulatory compliance determinations, or cross-contact certification. Configure policies to match your jurisdiction and verified procedures. See `docs/RULES.md` for references.
