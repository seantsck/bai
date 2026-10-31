// Restoring a Supabase logical export (roles.sql, schema.sql, data.sql from scripts/db/logical-export.sh) into a disposable LOCAL PostgreSQL, as the staging baseline of a promotion (G5-5E).
// Why this and not restore-snapshot.mjs: the snapshot is a table-by-table row copy; it does not carry sequence values (restore-snapshot sets each to the highest id: 16 of them differ from
// hosted) or the migration ledger's applied_at (re-applied at restore time). The logical export carries both exactly (pg_dump's setval lines and the ledger rows), plus the schema as
// hosted holds it. Everything here is local-only and read-only toward the export.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { listMigrations } from './migrations.mjs'

export const BAI_SCHEMAS = ['public', 'ingest', 'research', 'analytics', 'bai_meta']

/** Stand-ins for the platform roles the export refers to: no passwords, no privileges of their own. */
export const STAND_IN_ROLES = ['anon', 'authenticated', 'service_role', 'authenticator', 'supabase_admin', 'supabase_auth_admin', 'supabase_storage_admin', 'supabase_realtime_admin', 'dashboard_user']

/** Errors that exist only because the target is not a Supabase project. Each class says why; anything unmatched fails. */
export const PLATFORM_ONLY = [
  [/extension "(pg_stat_statements|supabase_vault)" is not available|could not open extension control file.*(pg_stat_statements|supabase_vault)/, 'a Supabase-provided extension (pg_stat_statements, supabase_vault) is not installed on plain PostgreSQL'],
  [/role "(supabase_[a-z_]+|dashboard_user|pgbouncer|cli_login[a-z_]*)" does not exist/, 'a Supabase platform role is absent'],
  [/schema "(vault|extensions)" does not exist/, 'a Supabase platform schema is absent'],
  [/parameter "log_min_messages"|GRANT SET ON PARAMETER/, 'a platform-role parameter grant (supabase_realtime_admin)'],
  [/relation "vault\./, 'an object that depends on the supabase_vault extension'],
  [/schema "(auth|storage)" does not exist|relation "(auth|storage)\.[a-z_]+" does not exist/, 'Supabase auth/storage platform tables in the data dump (BAI keeps nothing there)'],
  [/publication "supabase_realtime" does not exist/, 'the Supabase realtime publication'],
  [/role "bai_(automation|reviewer|web)" already exists/, 'BAI\'s own roles are cluster-wide: this server already holds them (from an earlier restore or migration run); a fresh server creates them here']
]

/**
 * The one BAI-schema function that Supabase's platform owns: public.rls_auto_enable(), the handler of the event trigger `ensure_rls` (ddl_command_end, tags CREATE TABLE | CREATE TABLE AS |
 * SELECT INTO; observed read-only on the hosted project on 2026-10-31, G5-5D). pg_dump writes the function but not the event trigger, so a plain-PostgreSQL restore has a SECURITY DEFINER
 * function that nothing calls and the security audit (which skips only functions that are event-trigger handlers) rightly reports it. The restore re-creates the trigger exactly as hosted has
 * it; it acts only on tables created in schema public, and migration 032 creates none there.
 */
export const PLATFORM_EVENT_TRIGGERS = Object.freeze([{ name: 'ensure_rls', event: 'ddl_command_end', tags: ['CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO'], fn: 'public.rls_auto_enable' }])
export const PLATFORM_EVENT_FUNCTIONS = Object.freeze(PLATFORM_EVENT_TRIGGERS.map((t) => `${t.fn}()`))

/** Catalog differences that the platform or pg_dump itself explains. Anything not matched here fails. */
export const explainCatalog = (d) => {
  if (/^(function|execute)\|public\.rls_auto_enable\(\)$/.test(d.key)) return 'public.rls_auto_enable() is Supabase\'s event-trigger function; it exists on hosted and is not created by BAI\'s migrations'
  if (d.key === 'schema|public' && String(d.target).replace(/postgres:USAGE ?/, '') === String(d.reference)) return 'Supabase grants postgres USAGE on schema public (the same platform difference scripts/db/parity.mjs explains)'
  if (/^view\|/.test(d.key)) {
    const norm = (t) => String(t).replace(/\s+AS\s+("?[?a-z_0-9]+"?)(?=[,\s]|$)/gi, '').replace(/\s+/g, ' ').trim()
    if (norm(d.reference) === norm(d.target)) return 'pg_dump writes explicit aliases (AS text) for unnamed view columns; the definition is otherwise identical'
  }
  return null
}

const SETTINGS = ["set local timezone = 'UTC'", "set local datestyle = 'ISO, YMD'", 'set local extra_float_digits = 1', "set local bytea_output = 'hex'", "set local intervalstyle = 'postgres'"]

/** Stand-in roles and the schema the platform extensions live in. Run before the export's SQL. */
export async function prepareStandIns (db) {
  for (const r of STAND_IN_ROLES) await db.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${r}') then create role ${r} nologin; end if; end $$`)
  await db.query('create schema if not exists extensions')
}

/** Runs roles.sql, schema.sql, data.sql through psql into the (local, empty) database; every error must be a known platform-only class. */
export function runExport (url, exportDir) {
  const results = []; const classes = {}; const unexpected = []
  for (const file of ['roles.sql', 'schema.sql', 'data.sql']) {
    const r = spawnSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=0', '-d', url, '-f', path.join(exportDir, file)], { encoding: 'utf8', maxBuffer: 1 << 28 })
    if (r.error) throw new Error(`psql is required: ${r.error.message}`)
    if (r.status !== 0 && r.status !== null) unexpected.push(`${file}: psql exited ${r.status}`)
    for (const e of (r.stderr ?? '').split('\n').filter((l) => /ERROR:/.test(l)).map((l) => l.replace(/^.*ERROR:\s*/, '').trim())) {
      const known = PLATFORM_ONLY.find(([re]) => re.test(e))
      if (known) classes[known[1]] = (classes[known[1]] ?? 0) + 1; else unexpected.push(`${file}: ${e.slice(0, 200)}`)
    }
    results.push(file)
  }
  return { classes, unexpected }
}

/** Re-creates the platform's event triggers that touch BAI schemas (see PLATFORM_EVENT_TRIGGERS), after the data is loaded. Returns what it created. */
export async function emulatePlatformEventTriggers (db) {
  const made = []
  for (const t of PLATFORM_EVENT_TRIGGERS) {
    if (!(await db.query('select to_regprocedure($1) p', [`${t.fn}()`])).rows[0].p) continue
    if ((await db.query('select 1 from pg_event_trigger where evtname = $1', [t.name])).rowCount) continue
    await db.query(`create event trigger ${t.name} on ${t.event} when tag in (${t.tags.map((x) => `'${x}'`).join(', ')}) execute function ${t.fn}()`); made.push(t.name)
  }
  return made
}

/** Every function in a BAI schema that is the handler of an event trigger (the security audit does not examine these). */
export const eventTriggerFunctions = async (db) => (await db.query(`select distinct n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' f from pg_event_trigger e join pg_proc p on p.oid = e.evtfoid join pg_namespace n on n.oid = p.pronamespace where n.nspname = any ($1)`, [BAI_SCHEMAS])).rows.map((r) => r.f)

/** Sequence values the export says (pg_dump's setval lines) for the BAI schemas: { "schema.seq": { value, isCalled } }. */
export function sequencesInExport (exportDir) {
  const out = {}
  for (const m of fs.readFileSync(path.join(exportDir, 'data.sql'), 'utf8').matchAll(/SELECT pg_catalog\.setval\('"?([a-z_]+)"?\."?([a-z_0-9]+)"?', (\d+), (true|false)\);/g)) if (BAI_SCHEMAS.includes(m[1])) out[`${m[1]}.${m[2]}`] = { value: m[3], isCalled: m[4] === 'true' }
  return out
}

/** The restored database's sequences, as { "schema.seq": last_value-or-null } (null = never called). */
export async function sequencesInDatabase (db) {
  return Object.fromEntries((await db.query('select schemaname || \'.\' || sequencename s, last_value::text lv from pg_sequences where schemaname = any ($1) order by 1', [BAI_SCHEMAS])).rows.map((r) => [r.s, r.lv]))
}

export function compareSequences (inExport, inDatabase) {
  const problems = []
  for (const [s, e] of Object.entries(inExport)) { const want = e.isCalled ? e.value : null; if (!(s in inDatabase)) problems.push(`${s}: in the export, missing in the database`); else if (inDatabase[s] !== want) problems.push(`${s}: export ${want}, restored ${inDatabase[s]}`) }
  for (const s of Object.keys(inDatabase)) if (!(s in inExport)) problems.push(`${s}: in the database, not in the export`)
  return problems
}

/** The migration ledger: the committed files' versions and checksums, the CLI history's versions, and applied_at kept (earlier than the export was taken, so not re-applied). */
export async function checkMigrations (db, exportDir, level) {
  const problems = []
  const files = listMigrations().filter((m) => m.version <= level)
  const rows = (await db.query('select version, checksum, applied_at from bai_meta.schema_migrations order by version')).rows
  if (JSON.stringify(rows.map((r) => [r.version, r.checksum])) !== JSON.stringify(files.map((m) => [m.version, m.checksum]))) problems.push(`the ledger is not exactly the committed migrations 001..${level} with their checksums`)
  try {
    const hist = JSON.parse(fs.readFileSync(path.join(exportDir, 'supabase_migrations_history.json'), 'utf8')).map((h) => h.version)
    if (JSON.stringify(hist) !== JSON.stringify(files.map((m) => m.version))) problems.push(`the CLI history in the export (${hist.length} versions) differs from the committed migrations (${files.length})`)
  } catch { problems.push('supabase_migrations_history.json is missing or unreadable') }
  const taken = fs.readFileSync(path.join(exportDir, 'MANIFEST.txt'), 'utf8').match(/taken_at_utc: (\S+)/)?.[1]
  if (!taken) problems.push('MANIFEST.txt has no taken_at_utc')
  else if (rows.some((r) => !(new Date(r.applied_at) < new Date(taken)))) problems.push('a migration was applied AFTER the export was taken: the ledger was re-applied, not restored')
  return { problems, versions: rows.length }
}

/** Scope, per-table row fingerprints, sequences and grants of a database: the collector of G5-5D (identical on hosted and on a restore). Runs its own REPEATABLE READ READ ONLY transaction. */
export async function collectBaseline (db) {
  await db.query('begin isolation level repeatable read read only')
  try {
    for (const s of SETTINGS) await db.query(s)
    const q = async (s, p) => (await db.query(s, p)).rows
    const scope = (await q(`select n.nspname || '.' || c.relname t from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r','p') and n.nspname in ('public','ingest','research')
      and not (n.nspname = 'ingest' and c.relname like 'promotion\\_%') and not (n.nspname = 'public' and (c.relname like 'rm\\_%' or c.relname = 'read_model_refreshes')) order by n.nspname collate "C", c.relname collate "C"`)).map((r) => r.t)
    const fingerprints = {}
    for (const t of scope) { const r = (await q(`select count(*)::bigint n, md5(coalesce(string_agg(h, '' order by h collate "C"), '')) d from (select md5(t::text) h from ${t} t) s`))[0]; fingerprints[t] = { n: Number(r.n), md5: r.d } }
    const sequences = await q('select schemaname || \'.\' || sequencename s, last_value::text lv from pg_sequences where schemaname = any ($1) order by 1', [BAI_SCHEMAS])
    const grants = (await q('select to_jsonb(g) j from ingest.source_publication_grants g order by 1')).map((x) => x.j)
    return { scope, fingerprints, sequences, grants }
  } finally { await db.query('rollback') }
}

/** Compares a collectBaseline() result with a recorded one (the hosted collector's `state`). `skip` lists tables whose difference is expected (e.g. what migration 032 adds). */
export function compareBaselines (recorded, restored, { skip = [] } = {}) {
  const problems = []
  const sk = new Set(skip)
  if (JSON.stringify(recorded.scope) !== JSON.stringify(restored.scope)) problems.push('the promotion-scope table list differs')
  for (const t of new Set([...Object.keys(recorded.fingerprints), ...Object.keys(restored.fingerprints)])) if (!sk.has(t) && JSON.stringify(recorded.fingerprints[t]) !== JSON.stringify(restored.fingerprints[t])) problems.push(`fingerprint of ${t}: recorded ${JSON.stringify(recorded.fingerprints[t])}, restored ${JSON.stringify(restored.fingerprints[t])}`)
  const seq = (a) => Object.fromEntries(a.map((r) => [r.s, r.lv]))
  const rs = seq(recorded.sequences); const ds = seq(restored.sequences)
  for (const s of Object.keys(rs)) if (rs[s] !== ds[s]) problems.push(`sequence ${s}: recorded ${rs[s]}, restored ${ds[s]}`)
  if (JSON.stringify(recorded.grants) !== JSON.stringify(restored.grants)) problems.push('the source publication grants differ (compare the rows, including granted_at to the microsecond)')
  return problems
}
