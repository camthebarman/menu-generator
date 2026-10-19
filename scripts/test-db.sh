#!/usr/bin/env bash
# Database + live-data-layer tests against a real, throwaway PostgreSQL cluster.
#   * tests/db   — migrations, RLS, concurrency, idempotency (SQL level)
#   * tests/live — the app's SupabaseRepository (supabase-js) over a real PostgREST with signed JWTs,
#                  run when a PostgREST binary is available ($POSTGREST_BIN or `postgrest` on PATH).
# Uses $PG_TEST_URL if set (e.g. a `supabase start` database) for tests/db only.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -n "${PG_TEST_URL:-}" ]]; then
  exec npx vitest run --config vitest.db.config.ts tests/db
fi
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
[[ -x "$PGBIN/initdb" ]] || { echo "PostgreSQL server binaries not found; set PGBIN or PG_TEST_URL" >&2; exit 2; }
DIR="$(mktemp -d /tmp/tzml-pg.XXXXXX)"
PORT="${PG_TEST_PORT:-54329}"
REST_PORT="${REST_TEST_PORT:-54330}"
RUNAS=()
if [[ "$(id -u)" == "0" ]]; then chown postgres "$DIR"; RUNAS=(runuser -u postgres --); fi
REST_PID=""
cleanup() {
  [[ -n "$REST_PID" ]] && kill "$REST_PID" 2>/dev/null || true
  "${RUNAS[@]}" "$PGBIN/pg_ctl" -D "$DIR/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$DIR"
}
trap cleanup EXIT
"${RUNAS[@]}" "$PGBIN/initdb" -D "$DIR/data" -U postgres --auth=trust >/dev/null
"${RUNAS[@]}" "$PGBIN/pg_ctl" -D "$DIR/data" -o "-p $PORT -k $DIR -c listen_addresses=127.0.0.1" -l "$DIR/log" -w start >/dev/null
export PG_TEST_URL="postgres://postgres@127.0.0.1:$PORT/postgres"

POSTGREST="${POSTGREST_BIN:-$(command -v postgrest || true)}"
if [[ -n "$POSTGREST" && -x "$POSTGREST" ]]; then
  LIVE_DB="postgres://postgres@127.0.0.1:$PORT/tzml_live"
  psql -q "$PG_TEST_URL" -c "create database tzml_live" >/dev/null
  for f in tests/db/supabase-shim.sql tests/live/postgrest-roles.sql supabase/migrations/*.sql; do
    psql -q -v ON_ERROR_STOP=1 "$LIVE_DB" -f "$f" >/dev/null
  done
  export LIVE_JWT_SECRET="test-only-jwt-secret-at-least-32-characters-long"
  PGRST_DB_URI="postgres://authenticator:authenticator@127.0.0.1:$PORT/tzml_live" PGRST_DB_SCHEMAS=public PGRST_DB_ANON_ROLE=anon \
    PGRST_JWT_SECRET="$LIVE_JWT_SECRET" PGRST_SERVER_PORT="$REST_PORT" PGRST_SERVER_HOST=127.0.0.1 "$POSTGREST" >"$DIR/postgrest.log" 2>&1 &
  REST_PID=$!
  for _ in $(seq 1 50); do curl -s "http://127.0.0.1:$REST_PORT/" >/dev/null && break; sleep 0.2; done
  export LIVE_REST_URL="http://127.0.0.1:$REST_PORT"
else
  echo "PostgREST not found — skipping tests/live (set POSTGREST_BIN to run them)." >&2
fi
npx vitest run --config vitest.db.config.ts
