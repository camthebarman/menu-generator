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

**Taking it to production: follow [`docs/GO-LIVE.md`](docs/GO-LIVE.md).** It covers project setup, auth/SMTP, `supabase db push`, hosting with security headers, CI/CD secrets, the smoke test, first-day setup, and operations.

Local development against Supabase:

```bash
supabase start                       # local stack (Docker), or use a hosted project
supabase db reset                    # applies supabase/migrations/* (starter content is a migration)
cp .env.example .env.local           # set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY
npm run dev
```

- Sign up, then create an organization; you become its owner, and it gets a copy of the starter ingredient catalog. Starter recipes are public read-only content.
- Teammates sign up, then **join with an invite code** created under Settings → Team. Codes are single-use, hashed at rest, and expire after 7 days. Owners invite managers; managers invite staff. Staff are scoped to Food and/or Bar.
- Membership changes go only through `create_organization`, `accept_invite`, and `update_member`, which enforce the owner/manager rules and keep at least one owner.
- **Migrations:**
  - `…01_schema.sql`: org-scoped composite FKs, numeric quantities, append-only ledger, immutable recipe versions.
  - `…02_rls.sql`: RLS on every table, least-privilege grants, cross-org reference triggers.
  - `…03_functions.sql`: transactional RPCs for receive, adjust, waste, status, quality review, transfer, reserve, release, and complete, plus recipe confirmation, staples, and the AI rate limit.
  - `…04_team_imports.sql`: invites, member management, atomic `import_lots`, `whoami`, and default-privilege hardening.
  - `…05_starter_content.sql`: generated by `npm run gen:seed`.
- **Concurrency:** quantity-changing functions lock the affected lots `FOR UPDATE` in id order, then validate eligibility, pool, lot version (stale-plan detection), and `reserved + requested ≤ quantity`. Retried calls with the same idempotency key return the original result.

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
| `npm run test:db` | 17 tests on a real throwaway PostgreSQL 16 cluster: migrations, RLS on every table, cross-org denial for direct, nested, and mutation paths, pool permissions, concurrent Shared reservations (row-lock blocking proven), stale versions, cutoffs, quality review, negative stock, idempotency, prep lineage, ledger rules, invites and member rules, atomic import. **Plus 6 tests that drive the app's real `SupabaseRepository` (supabase-js) through PostgREST** with signed JWTs, covering every command (needs `POSTGREST_BIN`). |
| `npm run test:e2e` | Playwright on the production build in demo mode: discover → draft → reserve → record, one-away → shopping list → CSV, Needs review and protection toggle, phone-width checks |
| `npm run test:e2e:live` | Playwright on a production build **in live mode** against Postgres + PostgREST: create org, receive stock, plan → reserve → record, invite → staff joins with workspace scoping, stranger isolation |
| `bash scripts/smoke-selftest.sh` | Runs the production smoke test (`scripts/smoke-live.mjs`) against the local stack |
| `npm run check` | typecheck, unit, db, build, demo e2e |

The database suites need PostgreSQL server binaries (`initdb`/`pg_ctl`), or set `PG_TEST_URL` for `tests/db`. The live suites need [PostgREST](https://github.com/PostgREST/postgrest/releases) at `$POSTGREST_BIN`. CI (`.github/workflows/ci.yml`) installs both and runs everything.

## Project layout

```
src/domain/     pure engine: units, dates, eligibility, stock/protection, allocation, matching, ops, imports, shopping, AI validation
src/data/       repositories: demo (localStorage) and Supabase; AI client
src/seed/       starter ingredients and recipes (original content) and demo inventory
src/ui/         React screens: Discover, Inventory, Current menu, Recipes, Plans, Shopping, Settings
supabase/       migrations (incl. generated starter content), config.toml, functions/ai-assist
scripts/        test runners, seed generator, PostgREST proxy, production smoke test
.github/        CI and Supabase deploy workflows
tests/          unit, integration, db (real Postgres), e2e (Playwright)
docs/RULES.md   date, eligibility, matching, protection, and costing rules
docs/GO-LIVE.md production runbook and checklist
```

## Scope boundary

No billing, POS, OCR, automated purchasing, ERP, paid recipe APIs, or scraping. Deployment is to your own Supabase project and static host (see `docs/GO-LIVE.md`). External recipe retrieval would go behind a provider interface, and none is configured.

## Important

Date alerts, eligibility rules, and allergen filters are planning aids. They are not food-safety guarantees, regulatory compliance determinations, or cross-contact certification. Configure policies to match your jurisdiction and verified procedures. See `docs/RULES.md` for references.
