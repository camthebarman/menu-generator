# Go-live runbook

Everything needed to take Table Zero Menu Lab from this repo to a production URL. Steps marked **(you)** need your accounts; everything else is already in the repo.

**Architecture in production:** a static site (Vercel, Netlify, or Cloudflare Pages) → Supabase (Auth + PostgreSQL with RLS + SQL functions) → optionally one Supabase Edge Function that calls Anthropic. There are no other servers.

---

## 0. What you need (you)

| Need | Why | Notes |
|---|---|---|
| Supabase account and project | Database, auth, API | **Pro plan recommended** for daily backups. Add Point-in-Time Recovery if losing a day of inventory edits would hurt. |
| Static host (Vercel, Netlify, or Cloudflare Pages) | Serves the web app | Config is included: `vercel.json`, `netlify.toml`, and `public/_headers` (Netlify and Cloudflare). |
| Transactional email (SMTP) | Sign-up confirmation and password-reset emails | Supabase's built-in sender is rate-limited and meant for testing. Use Resend, Postmark, SES, or similar. |
| Domain (optional) | e.g. `app.yourrestaurant.com` | Point it at the static host. |
| GitHub repo access | CI and database deploys | Already connected. |
| Anthropic API key (optional) | AI suggestions | Leave it out to run without AI. |

## 1. Create the Supabase project (you)

1. In the Supabase dashboard, create a project. Pick a region near the restaurant, and save the **database password** in your password manager.
2. From **Project Settings → API**, note the **Project URL** (`https://<ref>.supabase.co`), the **anon public key**, and the **project ref**.
3. Never put the `service_role` key anywhere in this app. Nothing here needs it.

## 2. Configure Auth (you, in the Supabase dashboard)

**Authentication → URL Configuration**
- Site URL: your app URL, e.g. `https://app.yourrestaurant.com`
- Redirect URLs: the same URL, plus any preview-deploy URL pattern you use.

**Authentication → Providers → Email**
- Keep *Confirm email* **on**.
- Set the minimum password length to at least 8.
- Turn on leaked-password protection if your plan offers it.

**Authentication → Emails → SMTP Settings**
- Enter your SMTP provider's details and a sender such as `no-reply@yourrestaurant.com`.
- Optionally edit the confirmation and reset email templates to mention your restaurant name.

Keep sign-ups enabled: staff create an account, then join with an invite code. A new account can't see any organization until it creates its own or redeems an invite.

## 3. Apply the database

From a machine with the [Supabase CLI](https://supabase.com/docs/guides/cli):

```bash
supabase login
supabase link --project-ref <ref>          # asks for the database password
supabase db push                           # applies all 5 migrations
```

The migrations create the schema, RLS policies, transactional functions, team and invite functions, and the public starter catalog: 106 ingredients and 56 recipes. `db push` does not run seed files, so the starter content ships as migration `20261020000005_starter_content.sql`.

Then open **Database → Advisors** (security and performance) and resolve anything flagged as an error. Every table has RLS enabled, and `anon` has no table or function access.

## 4. Optional: enable AI

```bash
supabase secrets set ANTHROPIC_API_KEY=sk-ant-... ALLOWED_ORIGIN=https://app.yourrestaurant.com
# optional: AI_MODEL=claude-opus-5-5 AI_RATE_PER_HOUR=20
supabase functions deploy ai-assist
```

Then set `VITE_AI_ENABLED=true` in step 5. Leave AI off and the app shows an honest "not configured" message, with everything else working.

## 5. Deploy the web app (you)

Connect this GitHub repo to your host. Build command: `npm run build`. Output directory: `dist`. Node 22.

Environment variables (Production):

| Variable | Value |
|---|---|
| `VITE_SUPABASE_URL` | `https://<ref>.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | the anon public key |
| `VITE_ALLOW_DEMO` | `false`: hides the local demo on the sign-in page (set `true` on a preview/demo site) |
| `VITE_AI_ENABLED` | `true` only after step 4 |

Security headers (CSP, HSTS, frame-ancestors, nosniff, Permissions-Policy) and caching are applied by `vercel.json` (Vercel) or `public/_headers` (Netlify and Cloudflare Pages). The CSP allows connections to `*.supabase.co`. **If you use a Supabase custom domain**, add it to `connect-src` in both files.

The app uses hash routes (`/#/inventory`), so no SPA rewrite rules are needed.

## 6. CI/CD (you: add the secrets)

`.github/workflows/ci.yml` runs on every pull request and every push to `main`: typecheck, unit tests, real-Postgres and PostgREST tests, build, demo browser tests, and live-mode browser tests.

`.github/workflows/deploy-supabase.yml` applies new migrations and redeploys the function after CI passes on `main`, or when run manually. In GitHub, go to **Settings → Environments → New environment** and name it `production`. Add required reviewers so database changes need an approval, then add:
- Secrets: `SUPABASE_ACCESS_TOKEN` (from supabase.com → Account → Access Tokens) and `SUPABASE_DB_PASSWORD`
- Variable: `SUPABASE_PROJECT_REF`

The web host redeploys from its own Git integration.

## 7. Smoke test the live system

Create a dedicated account (e.g. `smoke@yourrestaurant.com`) by signing up in the app, then run:

```bash
SUPABASE_URL=https://<ref>.supabase.co SUPABASE_ANON_KEY=<anon key> \
SMOKE_EMAIL=smoke@yourrestaurant.com SMOKE_PASSWORD='...' APP_URL=https://app.yourrestaurant.com \
node scripts/smoke-live.mjs
```

It checks:
- Anonymous users are denied.
- The starter library is present.
- Org provisioning works.
- Receiving is idempotent.
- Negative stock is refused.
- The ledger balances and is append-only.
- The site serves its CSP.
- The AI function is reachable, if deployed.

It writes only to an org named "Smoke test (do not use)". Re-run it after every deploy.

## 8. First-day setup in the app (you)

1. The owner signs up, confirms their email, and chooses **Create an organization** with the **correct timezone**: every date decision depends on it.
2. **Settings → Organization & date policy:** match your jurisdiction and written procedures (use-by/expiration as hard cutoffs, sell-by handling, alert days), and set the target ingredient-cost %.
3. **Settings → Pantry staples:** confirm only what you genuinely don't track (salt, water, ice…).
4. **Settings → Team:** create an invite code for each person, as staff (Food and/or Bar) or manager. Codes are single-use, expire in 7 days, and are shown once.
5. **Inventory → CSV import:** start from `public/templates/inventory-example.csv`. Review every row; unknown dates and quantities stay flagged instead of being guessed.
6. **Current menu:** add items, map each one to a recipe, **confirm the mapping**, and enter expected portions. Until then the app says "Current menu protection incomplete".
7. **Recipes:** create house recipes or import them. Imported recipes stay unconfirmed until someone reviews them.
8. Run Discover for tonight's service date.

## 9. Operating it

- **Backups:** confirm daily backups under **Database → Backups**. Do a restore drill into a scratch project before you depend on them.
- **Monitoring:**
  - Add an uptime check on `APP_URL`.
  - Use **Logs** in Supabase (API, Postgres, Auth, Edge Functions) for errors.
  - Use **Reports** for API volume.
  - Any 5xx from `/rest/v1/rpc/*` deserves a look.
- **Schema changes:**
  - Add a new file under `supabase/migrations/`; never edit one that has already been applied.
  - Test with `npm run test:db`, open a PR, and let the workflow apply it after CI passes.
  - Recipe versions are immutable by design.
- **Rollback:**
  - Frontend: redeploy the previous build from the host's dashboard.
  - Database: write a forward-fix migration. Use point-in-time recovery only for disasters, because it rewinds everyone's inventory.
- **Data export:** use the Inventory "Export lots CSV" button and the shopping-list CSV. For a full dump, run `supabase db dump --data-only -f backup.sql`.
- **Access reviews:**
  - When someone leaves, remove them in Settings → Team.
  - Rotate the Anthropic key if it might be exposed (`supabase secrets set`).
  - The anon key is public by design; RLS is the protection.
- **Concurrency:**
  - The app refreshes on tab focus and every 2 minutes.
  - Reservations are re-validated under row locks on the server, so a stale screen can never over-reserve; it gets a "changed since checked" error and re-checks.

## 10. Go-live checklist

- [ ] Supabase project created (Pro plan, backups confirmed)
- [ ] Auth: Site URL and redirect URLs set, email confirmation on, custom SMTP sending successfully (test a password reset)
- [ ] `supabase db push` applied 5 migrations; Advisors show no errors
- [ ] Web host connected; env vars set; `VITE_ALLOW_DEMO=false`
- [ ] Custom domain + HTTPS (if used); CSP updated for any custom Supabase domain
- [ ] GitHub `production` environment with secrets, variable, and required reviewers
- [ ] `node scripts/smoke-live.mjs` passes against production with `APP_URL`
- [ ] Owner org created with the correct timezone; date policy reviewed against local rules
- [ ] Staff invited and able to sign in; a Food staff member cannot see Bar-only stock (and vice versa)
- [ ] Inventory imported; menu mappings confirmed and portions entered (no "protection incomplete" banner)
- [ ] Dry run: one special planned, reserved, and recorded; balances look right
- [ ] Optional AI: function deployed, `ALLOWED_ORIGIN` set, one suggestion reviewed end to end
- [ ] Uptime monitor on the app URL

## What was and wasn't verified before launch

Verified automatically in this repo (and in CI):
- **Migrations, RLS and SQL functions:** real PostgreSQL 16.
- **The app's Supabase data layer (`supabase-js`):** against real PostgREST with signed JWTs, covering every command.
- **The live-mode UI in Chromium:** org creation, receiving, a full plan, invites, and staff scoping.
- **The smoke script:** self-tested via `scripts/smoke-selftest.sh`.

Not verifiable without your project:
- **Supabase Auth email flows** (sign-up confirmation, password reset). The tests inject sessions instead.
- **The Edge Function calling Anthropic.**
- **The hosted Supabase environment itself.**

Steps 7 and 10 cover these on day one.

## Known limitations at launch

- **Live-mode recipe and menu imports** commit one item at a time. A network failure partway through can leave a partial import; check the Recipes/Menu list and re-import only what's missing. (Inventory imports are a single transaction.)
- **No push updates between devices:** screens refresh on focus and every 2 minutes, and the server rejects reservations built on changed stock.
- **No in-app account deletion or org deletion:** do these from the Supabase dashboard, and keep in mind that the inventory ledger is append-only.
