#!/usr/bin/env bash
# Supabase-compatible LOGICAL export of the hosted BAI database: roles, schema, data, produced by the scripts the official `supabase db dump` prints
# (`--dry-run`) for the three documented dumps, run here with the local pg_dump/pg_dumpall because Docker (which the CLI would use) is not available to
# this user. Every dump is read-only (pg_dump uses REPEATABLE READ, READ ONLY; the session is also forced read-only). Passwords come from the environment
# and are never written to a file or printed.
#
#   set -a; . ./.env.hosted.local; set +a
#   scripts/db/logical-export.sh <new, empty directory>
#
# Writes roles.sql (no role passwords), schema.sql, data.sql (COPY), the three generated scripts (placeholders only), supabase_migrations_history.json
# (the CLI's own migration history, which `db dump` excludes), SHA256SUMS and MANIFEST.txt. Verify with scripts/db/verify-logical-export.mjs.
set -euo pipefail
out="${1:?usage: logical-export.sh <new directory>}"
if [ -e "$out" ] && [ -n "$(ls -A "$out" 2>/dev/null)" ]; then echo "refusing: $out is not empty (an export is never overwritten)" >&2; exit 2; fi
: "${BAI_SUPABASE_PROJECT_REF:?set BAI_SUPABASE_PROJECT_REF (source .env.hosted.local)}" "${BAI_SUPABASE_DB_PASSWORD:?set BAI_SUPABASE_DB_PASSWORD}"
mkdir -p -m 700 "$out"
root="$(cd "$(dirname "$0")/../.." && pwd)"
placeholder='postgresql://postgres:x@db.placeholder.supabase.co:5432/postgres' # credential-scan:allow (a placeholder host and password; the real connection comes from the environment)
for kind in roles schema data; do
  case "$kind" in roles) flags=(--role-only) ;; schema) flags=() ;; data) flags=(--data-only --use-copy) ;; esac
  # the generated script, with the connection lines removed (they are supplied by the environment below)
  (cd "$root" && npx supabase db dump --db-url "$placeholder" "${flags[@]}" --dry-run 2>/dev/null) | sed -E '/^export PG(HOST|PORT|USER|PASSWORD|DATABASE)=/d' > "$out/$kind.sh"
  grep -q 'pg_dump' "$out/$kind.sh" || grep -q 'pg_dumpall' "$out/$kind.sh" || { echo "the CLI printed no dump script for $kind" >&2; exit 1; }
done
export PGHOST="db.${BAI_SUPABASE_PROJECT_REF}.supabase.co" PGPORT=5432 PGUSER=postgres PGDATABASE=postgres PGPASSWORD="$BAI_SUPABASE_DB_PASSWORD"
export PGSSLMODE=verify-full PGSSLROOTCERT="$root/supabase/prod-ca-2021.crt" PGOPTIONS='-c default_transaction_read_only=on'
for kind in roles schema data; do bash "$out/$kind.sh" > "$out/$kind.sql" 2> "$out/$kind.err"; done
# the CLI's migration history is not part of any dump; without it a restored project would try to re-apply every migration
psql -X -At -v ON_ERROR_STOP=1 -c "select coalesce(json_agg(json_build_object('version', version, 'name', name, 'statements', statements) order by version), '[]') from supabase_migrations.schema_migrations" > "$out/supabase_migrations_history.json"
unset PGPASSWORD
for f in roles schema data; do rm -f "$out/$f.err.empty"; [ -s "$out/$f.err" ] || rm -f "$out/$f.err"; done
{
  echo "BAI logical export (read-only) of project ${BAI_SUPABASE_PROJECT_REF}"
  echo "taken_at_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "pg_dump: $(pg_dump --version)"
  echo "supabase_cli: $(cd "$root" && npx supabase --version 2>/dev/null | head -1)"
  echo "note: platform roles are commented out of roles.sql; role passwords are not exported; auth/storage/realtime/vault are platform state, not restored."
} > "$out/MANIFEST.txt"
(cd "$out" && sha256sum roles.sql schema.sql data.sql roles.sh schema.sh data.sh supabase_migrations_history.json > SHA256SUMS)
chmod 600 "$out"/* 2>/dev/null || true
echo "exported to $out: $(stat -c%s "$out/roles.sql") B roles, $(stat -c%s "$out/schema.sql") B schema, $(stat -c%s "$out/data.sql") B data"
