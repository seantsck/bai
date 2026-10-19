// Hosted parity: builds a known-good reference database from migrations 001..NNN on a throwaway local PostgreSQL 17
// (BAI runner, no Supabase tooling involved) and compares its BAI-owned catalog with the target database
// (BAI_DATABASE_URL, usually the hosted BAI Supabase project). Reports BAI-owned differences, which fail the check, and
// platform-managed details (other schemas, extensions outside BAI schemas, Supabase roles), which are listed but never
// confused with BAI objects. Seed data is compared too until research data has been imported into the target.
//
//   npm run db:parity            (reads .env.local)       npm run hosted:parity   (reads .env.hosted.local)
//   add -- --json for machine-readable output
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import pg from 'pg'
import EmbeddedPostgres from 'embedded-postgres'
import { applyMigrations, supabaseHistory, listMigrations } from './lib/migrations.mjs'
import { ownerDatabaseUrl } from './lib/connection.mjs'
import { catalogSnapshot, seedFingerprint, diffSnapshots, BAI_SCHEMAS, BAI_ROLES } from './lib/catalog.mjs'

const json = process.argv.includes('--json')
const log = (...a) => { if (!json) console.log(...a) }
const q = async (db, sql, p) => (await db.query(sql, p)).rows

async function referenceSnapshot () {
  const port = 20000 + Math.floor(Math.random() * 30000)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-parity-'))
  const server = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port, persistent: false, onLog: () => {} })
  await server.initialise()
  await server.start()
  try {
    await server.createDatabase('bai_reference')
    const db = new pg.Client({ host: '127.0.0.1', port, user: 'postgres', password: 'postgres', database: 'bai_reference' })
    await db.connect()
    try {
      await applyMigrations(db)
      return { catalog: await catalogSnapshot(db), seed: await seedFingerprint(db), version: (await q(db, 'show server_version'))[0].server_version }
    } finally { await db.end() }
  } finally {
    await server.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** Facts about the target that belong to the platform, not to BAI: reported, never diffed against the reference. */
async function platformFacts (db) {
  const schemas = (await q(db, `select nspname from pg_namespace where nspname <> all($1) and nspname !~ '^pg_' and nspname <> 'information_schema' order by 1`, [BAI_SCHEMAS])).map((r) => r.nspname)
  const extensions = (await q(db, 'select e.extname, e.extversion, n.nspname from pg_extension e join pg_namespace n on n.oid = e.extnamespace order by 1')).map((r) => `${r.extname} ${r.extversion} (${r.nspname})`)
  const foreignAcl = (await q(db, `select count(*)::int n from (
      select unnest(c.relacl)::text a from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = any($1)
      union all select unnest(p.proacl)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = any($1)) x
    where split_part(a, '=', 1) <> '' and split_part(a, '=', 1) <> all($2)`, [BAI_SCHEMAS, BAI_ROLES]))[0].n
  const defaultAcl = (await q(db, `select pg_get_userbyid(d.defaclrole) owner, coalesce(n.nspname, '*') schema, d.defaclobjtype type, d.defaclacl::text acl
      from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace where n.nspname is null or n.nspname = any($1) order by 1, 2, 3`, [BAI_SCHEMAS]))
  return { schemas, extensions, acl_entries_for_platform_roles: foreignAcl, default_privileges: defaultAcl }
}

/**
 * Differences that the platform creates and BAI cannot (and need not) remove. Each entry matches one exact difference
 * and carries the reason; anything else still fails the check.
 */
const PLATFORM_DIFFERENCES = [
  {
    key: 'schema|public',
    onlyInTarget: ['postgres:USAGE'],
    reason: 'Supabase grants postgres USAGE on the public schema when the project is created. postgres owns the database ' +
      '(and so already acts as pg_database_owner, which owns public), so the extra entry grants nothing new.'
  }
]
const aclEntries = (v) => new Set(v ? (JSON.parse(v).acl ?? '').split(' ').filter(Boolean) : [])
function explain (d) {
  for (const p of PLATFORM_DIFFERENCES) {
    if (p.key !== d.key) continue
    const a = aclEntries(d.reference)
    const b = aclEntries(d.target)
    const extra = [...b].filter((x) => !a.has(x)).sort()
    const missing = [...a].filter((x) => !b.has(x))
    if (missing.length === 0 && JSON.stringify(extra) === JSON.stringify([...p.onlyInTarget].sort())) return p.reason
  }
  return null
}

const ref = await referenceSnapshot()
const target = new pg.Client({ connectionString: ownerDatabaseUrl() })
await target.connect()
let result
try {
  const imported = (await q(target, "select to_regclass('ingest.import_batches') is not null e"))[0].e
    ? (await q(target, 'select count(*)::int n from ingest.import_batches'))[0].n : 0
  const catalog = await catalogSnapshot(target)
  // Platform roles (e.g. supabase_admin, postgres's own grantor entries) can appear in ACLs on a hosted database; they
  // are dropped from the comparison and counted under platform facts.
  const keep = (s) => s.split(' ').filter((e) => BAI_ROLES.includes(e.split(':')[0])).join(' ')
  for (const [k, v] of catalog) if (k.startsWith('grant|') || k.startsWith('execute|')) catalog.set(k, keep(v))
  for (const [k, v] of ref.catalog) if (k.startsWith('grant|') || k.startsWith('execute|')) ref.catalog.set(k, keep(v))
  const allDiffs = diffSnapshots(ref.catalog, catalog)
  const explained = allDiffs.map((d) => ({ ...d, platform_reason: explain(d) })).filter((d) => d.platform_reason)
  const schemaDiffs = allDiffs.filter((d) => !explain(d))
  const seedDiffs = imported ? null : diffSnapshots(ref.seed, await seedFingerprint(target))
  const history = await supabaseHistory(target)
  const files = listMigrations().map((m) => m.version)
  result = {
    reference_server: ref.version,
    target_server: (await q(target, 'show server_version'))[0].server_version,
    bai_objects_compared: ref.catalog.size,
    kinds: Object.fromEntries([...ref.catalog.keys()].reduce((m, k) => m.set(k.split('|')[0], (m.get(k.split('|')[0]) ?? 0) + 1), new Map())),
    schema_differences: schemaDiffs,
    explained_platform_differences: explained,
    seed_data: seedDiffs === null ? `not compared: target holds ${imported} import batch(es); see hosted:verify-pilot` : { tables: ref.seed.size, differences: seedDiffs },
    supabase_migration_history: history ? { versions: [...history.keys()].sort(), matches_files: JSON.stringify([...history.keys()].sort()) === JSON.stringify(files) } : 'none (not a Supabase-pushed database)',
    platform: await platformFacts(target)
  }
} finally { await target.end() }

const ok = result.schema_differences.length === 0 && (typeof result.seed_data === 'string' || result.seed_data.differences.length === 0) &&
  (typeof result.supabase_migration_history === 'string' || result.supabase_migration_history.matches_files)
if (json) console.log(JSON.stringify({ ok, ...result }, null, 2))
else {
  log(`reference PostgreSQL ${result.reference_server} (migrations via BAI runner) vs target PostgreSQL ${result.target_server}`)
  log(`BAI-owned objects compared: ${result.bai_objects_compared}  ${Object.entries(result.kinds).map(([k, v]) => `${k}=${v}`).join(' ')}`)
  log(`BAI-owned differences: ${result.schema_differences.length}`)
  for (const d of result.schema_differences.slice(0, 50)) log(`  ${d.key}\n    reference: ${d.reference}\n    target:    ${d.target}`)
  for (const d of result.explained_platform_differences) log(`explained platform difference ${d.key}: ${d.platform_reason}`)
  log(`seed data: ${typeof result.seed_data === 'string' ? result.seed_data : `${result.seed_data.tables} tables, ${result.seed_data.differences.length} differences`}`)
  if (typeof result.seed_data !== 'string') for (const d of result.seed_data.differences) log(`  ${d.key}: reference ${d.reference} target ${d.target}`)
  log(`supabase migration history: ${typeof result.supabase_migration_history === 'string' ? result.supabase_migration_history : `${result.supabase_migration_history.versions.length} versions, matches files: ${result.supabase_migration_history.matches_files}`}`)
  log(`platform-managed (reported, not compared): schemas ${result.platform.schemas.join(', ') || 'none'}`)
  log(`  extensions: ${result.platform.extensions.join(', ')}`)
  log(`  ACL entries in BAI schemas for platform roles: ${result.platform.acl_entries_for_platform_roles}`)
  log(`  default privileges touching BAI schemas: ${result.platform.default_privileges.map((d) => `${d.owner}/${d.schema}/${d.type}=${d.acl}`).join('; ') || 'none'}`)
  log(ok ? 'PARITY OK' : 'PARITY FAILED')
}
process.exit(ok ? 0 : 1)
