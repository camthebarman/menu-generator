#!/usr/bin/env bash
# Runs scripts/smoke-live.mjs against a local Postgres + PostgREST to prove the smoke test itself works
# (everything except password sign-in and the hosted web app checks). Needs PostgREST ($POSTGREST_BIN).
set -euo pipefail
cd "$(dirname "$0")/.."
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
POSTGREST="${POSTGREST_BIN:-$(command -v postgrest || true)}"
DIR="$(mktemp -d /tmp/tzml-smoke.XXXXXX)"; PORT=54349; REST_PORT=54350; PROXY_PORT=54351
RUNAS=(); if [[ "$(id -u)" == "0" ]]; then chown postgres "$DIR"; RUNAS=(runuser -u postgres --); fi
PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; "${RUNAS[@]}" "$PGBIN/pg_ctl" -D "$DIR/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$DIR"; }
trap cleanup EXIT
"${RUNAS[@]}" "$PGBIN/initdb" -D "$DIR/data" -U postgres --auth=trust >/dev/null
"${RUNAS[@]}" "$PGBIN/pg_ctl" -D "$DIR/data" -o "-p $PORT -k $DIR -c listen_addresses=127.0.0.1" -l "$DIR/log" -w start >/dev/null
DB="postgres://postgres@127.0.0.1:$PORT/postgres"
for f in tests/db/supabase-shim.sql tests/live/postgrest-roles.sql supabase/migrations/*.sql; do psql -q -v ON_ERROR_STOP=1 "$DB" -f "$f" >/dev/null; done
SECRET="test-only-jwt-secret-at-least-32-characters-long"
PGRST_DB_URI="postgres://authenticator:authenticator@127.0.0.1:$PORT/postgres" PGRST_DB_SCHEMAS=public PGRST_DB_ANON_ROLE=anon \
  PGRST_JWT_SECRET="$SECRET" PGRST_SERVER_PORT=$REST_PORT PGRST_SERVER_HOST=127.0.0.1 "$POSTGREST" >"$DIR/pgrst.log" 2>&1 & PIDS+=($!)
node scripts/rest-proxy.mjs $PROXY_PORT "http://127.0.0.1:$REST_PORT" >/dev/null 2>&1 & PIDS+=($!)
for _ in $(seq 1 50); do curl -s "http://127.0.0.1:$REST_PORT/" >/dev/null && break; sleep 0.2; done
TOKEN=$(node -e '
const c=require("crypto");const b=o=>Buffer.from(JSON.stringify(o)).toString("base64url");
const h=b({alg:"HS256",typ:"JWT"}),p=b({sub:"30000000-0000-4000-8000-000000000001",role:"authenticated",aud:"authenticated",exp:Math.floor(Date.now()/1000)+600});
console.log(h+"."+p+"."+c.createHmac("sha256",process.argv[1]).update(h+"."+p).digest("base64url"))' "$SECRET")
# anon requests need a JWT with role anon, like a Supabase anon key
ANON=$(node -e '
const c=require("crypto");const b=o=>Buffer.from(JSON.stringify(o)).toString("base64url");
const h=b({alg:"HS256",typ:"JWT"}),p=b({role:"anon",exp:Math.floor(Date.now()/1000)+600});
console.log(h+"."+p+"."+c.createHmac("sha256",process.argv[1]).update(h+"."+p).digest("base64url"))' "$SECRET")
SUPABASE_URL="http://127.0.0.1:$PROXY_PORT" SUPABASE_ANON_KEY="$ANON" SMOKE_ACCESS_TOKEN="$TOKEN" node scripts/smoke-live.mjs
echo "--- second run (reuses org) ---"
SUPABASE_URL="http://127.0.0.1:$PROXY_PORT" SUPABASE_ANON_KEY="$ANON" SMOKE_ACCESS_TOKEN="$TOKEN" node scripts/smoke-live.mjs
