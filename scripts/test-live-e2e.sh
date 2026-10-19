#!/usr/bin/env bash
# Browser test of LIVE mode: real Postgres + migrations + PostgREST + the production build pointed at it.
# Supabase Auth (GoTrue) is not run; tests inject a signed session into supabase-js storage.
# Requires PostgreSQL server binaries and PostgREST ($POSTGREST_BIN or on PATH).
set -euo pipefail
cd "$(dirname "$0")/.."
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
POSTGREST="${POSTGREST_BIN:-$(command -v postgrest || true)}"
[[ -x "$PGBIN/initdb" && -n "$POSTGREST" ]] || { echo "Need PostgreSQL binaries and PostgREST" >&2; exit 2; }
DIR="$(mktemp -d /tmp/tzml-live.XXXXXX)"; PORT=54339; REST_PORT=54340; PROXY_PORT=54341; APP_PORT=4174
RUNAS=(); if [[ "$(id -u)" == "0" ]]; then chown postgres "$DIR"; RUNAS=(runuser -u postgres --); fi
PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; "${RUNAS[@]}" "$PGBIN/pg_ctl" -D "$DIR/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$DIR"; }
trap cleanup EXIT
"${RUNAS[@]}" "$PGBIN/initdb" -D "$DIR/data" -U postgres --auth=trust >/dev/null
"${RUNAS[@]}" "$PGBIN/pg_ctl" -D "$DIR/data" -o "-p $PORT -k $DIR -c listen_addresses=127.0.0.1" -l "$DIR/log" -w start >/dev/null
DB="postgres://postgres@127.0.0.1:$PORT/postgres"
for f in tests/db/supabase-shim.sql tests/live/postgrest-roles.sql supabase/migrations/*.sql; do psql -q -v ON_ERROR_STOP=1 "$DB" -f "$f" >/dev/null; done
export LIVE_JWT_SECRET="test-only-jwt-secret-at-least-32-characters-long"
PGRST_DB_URI="postgres://authenticator:authenticator@127.0.0.1:$PORT/postgres" PGRST_DB_SCHEMAS=public PGRST_DB_ANON_ROLE=anon \
  PGRST_JWT_SECRET="$LIVE_JWT_SECRET" PGRST_SERVER_PORT=$REST_PORT PGRST_SERVER_HOST=127.0.0.1 "$POSTGREST" >"$DIR/postgrest.log" 2>&1 & PIDS+=($!)
node scripts/rest-proxy.mjs $PROXY_PORT "http://127.0.0.1:$REST_PORT" >"$DIR/proxy.log" 2>&1 & PIDS+=($!)
for _ in $(seq 1 100); do curl -s "http://127.0.0.1:$REST_PORT/" >/dev/null && break; sleep 0.3; done
VITE_SUPABASE_URL="http://127.0.0.1:$PROXY_PORT" VITE_SUPABASE_ANON_KEY="test-anon" VITE_ALLOW_DEMO=false npx vite build --outDir "$DIR/dist" >/dev/null
node node_modules/vite/bin/vite.js preview --outDir "$DIR/dist" --host 127.0.0.1 --port $APP_PORT --strictPort >"$DIR/preview.log" 2>&1 & PIDS+=($!)
wait_for() { for _ in $(seq 1 100); do curl -sf "$1" >/dev/null && return 0; sleep 0.3; done; echo "Timed out waiting for $1" >&2; tail -20 "$DIR"/*.log >&2 || true; exit 1; }
wait_for "http://127.0.0.1:$APP_PORT/"
LIVE_APP_URL="http://127.0.0.1:$APP_PORT" npx playwright test --config playwright.live.config.ts
