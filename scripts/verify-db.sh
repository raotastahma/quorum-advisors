#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
compose_file=tests/database/compose.yaml
project=quorum-advisors-demo
cleanup() { docker compose -p "$project" -f "$compose_file" down --volumes >/dev/null; }
trap cleanup EXIT INT TERM
if ! docker compose -p "$project" -f "$compose_file" up -d --wait --wait-timeout 60; then
  docker compose -p "$project" -f "$compose_file" logs db
  exit 1
fi
docker compose -p "$project" -f "$compose_file" exec -T db sh -eu -c '
  psql -X -U postgres -d quorum_demo -v ON_ERROR_STOP=1 -f /workspace/tests/database/bootstrap.sql >/dev/null
  for migration in /workspace/supabase/migrations/*.sql; do
    psql -X -U postgres -d quorum_demo -v ON_ERROR_STOP=1 -f "$migration" >/dev/null
  done
  psql -X -U postgres -d quorum_demo -v ON_ERROR_STOP=1 -f /workspace/supabase/seed/demo.sql >/dev/null
  psql -X -U postgres -d quorum_demo -v ON_ERROR_STOP=1 -f /workspace/tests/database/smoke.sql
'
