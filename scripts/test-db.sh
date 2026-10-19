#!/usr/bin/env bash
# Runs migrations, RLS, and concurrency tests against a real, throwaway PostgreSQL 16 cluster
# with a minimal Supabase auth shim (tests/db/supabase-shim.sql).
# Uses $PG_TEST_URL if set (e.g. a local `supabase start` database); otherwise creates a temp cluster.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -n "${PG_TEST_URL:-}" ]]; then
  exec npx vitest run --config vitest.db.config.ts
fi
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
[[ -x "$PGBIN/initdb" ]] || { echo "PostgreSQL server binaries not found; set PGBIN or PG_TEST_URL" >&2; exit 2; }
DIR="$(mktemp -d /tmp/tzml-pg.XXXXXX)"
PORT="${PG_TEST_PORT:-54329}"
RUNAS=()
if [[ "$(id -u)" == "0" ]]; then chown postgres "$DIR"; RUNAS=(runuser -u postgres --); fi
cleanup() { "${RUNAS[@]}" "$PGBIN/pg_ctl" -D "$DIR/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$DIR"; }
trap cleanup EXIT
"${RUNAS[@]}" "$PGBIN/initdb" -D "$DIR/data" -U postgres --auth=trust >/dev/null
"${RUNAS[@]}" "$PGBIN/pg_ctl" -D "$DIR/data" -o "-p $PORT -k $DIR -c listen_addresses=127.0.0.1" -l "$DIR/log" -w start >/dev/null
export PG_TEST_URL="postgres://postgres@127.0.0.1:$PORT/postgres"
npx vitest run --config vitest.db.config.ts
