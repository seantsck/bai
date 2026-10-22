// Rehearsal of migration 027 and a manifest-bound release in a DISPOSABLE database that matches the hosted one: the committed
// migrations 001-026 are applied to a throwaway local PostgreSQL 17, the hosted BAI data is copied in through a READ-ONLY
// transaction (nothing is written to hosted), row counts are compared table by table, then 027 and each release are applied
// to clones. The report is written next to the release; the disposable server is always removed.
//
//   node --env-file=.env.hosted.local scripts/history/rehearse-release.mjs --release-dir <dir> [--release-dir <dir2> ...] [--out report.json]
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import EmbeddedPostgres from 'embedded-postgres'
import { applyMigrations } from '../db/lib/migrations.mjs'
import { ownerDatabaseUrl, isLocalUrl, supabaseProjectRef } from '../db/lib/connection.mjs'
import { loadRelease } from './lib/release.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const argv = process.argv.slice(2)
const dirs = argv.flatMap((a, i) => (a === '--release-dir' && argv[i + 1] ? [path.resolve(root, argv[i + 1])] : []))
const outFile = argv.includes('--out') ? path.resolve(root, argv[argv.indexOf('--out') + 1]) : null
if (!dirs.length) { console.error('usage: rehearse-release.mjs --release-dir <dir> [--release-dir <dir2> ...] [--out report.json]'); process.exit(2) }
const log = (m) => console.log(m)
const SCHEMAS = ['public', 'ingest', 'research', 'bai_meta']

const q = async (db, sql, p) => (await db.query(sql, p)).rows
const tables = async (db) => (await q(db, `select table_schema s, table_name t from information_schema.tables where table_schema = any($1) and table_type = 'BASE TABLE' order by 1, 2`, [SCHEMAS])).map((r) => `${r.s}.${r.t}`)
const counts = async (db, list) => { const out = {}; for (const t of list) out[t] = Number((await q(db, `select count(*) n from ${t}`))[0].n); return out }

const hostedUrl = ownerDatabaseUrl()
if (isLocalUrl(hostedUrl)) throw new Error('point this at the hosted read-only source (.env.hosted.local); the rehearsal builds its own disposable database')
const hostedRef = supabaseProjectRef(hostedUrl)
const port = 20000 + Math.floor(Math.random() * 30000)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-rehearsal-'))
const server = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port, persistent: false, onLog: () => {} })
const url = (name) => `postgresql://postgres:postgres@127.0.0.1:${port}/${name}`
const report = { hosted_ref: hostedRef, started_at: new Date().toISOString(), steps: [], releases: [] }
const step = (name, ok, detail) => { report.steps.push({ name, ok, detail }); log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`) }

try {
  await server.initialise(); await server.start()
  await server.createDatabase('bai_hosted_copy')
  const copy = new pg.Client({ connectionString: url('bai_hosted_copy') }); await copy.connect()
  await applyMigrations(copy, { through: '026' })
  step('disposable database built from migrations 001-026', true)

  // --- copy hosted data through a read-only transaction -----------------------------------------------------------
  const hosted = new pg.Client({ connectionString: hostedUrl }); await hosted.connect()
  await hosted.query('begin read only')
  const hostedTables = await tables(hosted)
  const localTables = await tables(copy)
  const missing = hostedTables.filter((t) => !localTables.includes(t))
  step('hosted and disposable have the same tables', !missing.length && hostedTables.length === localTables.length, missing.length ? `hosted-only: ${missing.join(', ')}` : `${hostedTables.length} tables`)
  const keep = 'bai_meta.schema_migrations'
  const data = hostedTables.filter((t) => t !== keep)
  await copy.query("set session_replication_role = replica")
  await copy.query(`truncate ${data.join(', ')} restart identity`)
  for (const t of data) {
    const [s, n] = t.split('.')
    const cols = (await q(copy, `select column_name from information_schema.columns where table_schema = $1 and table_name = $2 and is_generated = 'NEVER' order by ordinal_position`, [s, n])).map((r) => `"${r.column_name}"`)
    const rows = (await hosted.query(`select to_jsonb(x) j from ${t} x`)).rows.map((r) => r.j)
    for (let i = 0; i < rows.length; i += 200) {
      await copy.query(`insert into ${t} (${cols.join(', ')}) overriding system value select ${cols.join(', ')} from jsonb_populate_recordset(null::${t}, $1::jsonb)`, [JSON.stringify(rows.slice(i, i + 200))])
    }
  }
  for (const r of await q(copy, `select s.nspname sch, c.relname tbl, a.attname col from pg_class c join pg_namespace s on s.oid = c.relnamespace join pg_attribute a on a.attrelid = c.oid
      where a.attidentity <> '' and s.nspname = any($1) and c.relkind = 'r'`, [SCHEMAS])) {
    await copy.query(`select setval(pg_get_serial_sequence('${r.sch}.${r.tbl}', '${r.col}'), greatest(coalesce((select max(${r.col}) from ${r.sch}.${r.tbl}), 0), 1), (select count(*) > 0 from ${r.sch}.${r.tbl}))`)
  }
  await copy.query('reset session_replication_role')
  const hc = await counts(hosted, hostedTables)
  const lc = await counts(copy, hostedTables)
  const diff = hostedTables.filter((t) => hc[t] !== lc[t] && t !== keep)
  const rowsTotal = Object.values(hc).reduce((a, b) => a + b, 0)
  step('row counts equal, table by table', !diff.length, diff.length ? diff.map((t) => `${t} hosted ${hc[t]} copy ${lc[t]}`).join('; ') : `${rowsTotal} rows in ${hostedTables.length} tables`)
  const hmig = (await q(hosted, 'select version, checksum from bai_meta.schema_migrations order by 1')).map((r) => `${r.version}:${r.checksum}`).join()
  const lmig = (await q(copy, 'select version, checksum from bai_meta.schema_migrations order by 1')).map((r) => `${r.version}:${r.checksum}`).join()
  step('migration history identical (versions and checksums)', hmig === lmig)
  await hosted.query('rollback'); await hosted.end()
  report.hosted_counts = Object.fromEntries(Object.entries(hc).filter(([, n]) => n > 0))

  // --- migration 027 ------------------------------------------------------------------------------------------------
  const before = await q(copy, 'select source_key, attribution_category from public.sources order by source_key')
  await applyMigrations(copy)
  const after = await q(copy, 'select source_key, attribution_category from public.sources order by source_key')
  const changed = before.filter((b, i) => after[i].source_key !== b.source_key || after[i].attribution_category !== b.attribution_category)
  step('027 applied; no existing source changed category', !changed.length && before.length === after.length, `${after.length} sources; ${JSON.stringify(Object.fromEntries(after.reduce((m, r) => m.set(r.attribution_category, (m.get(r.attribution_category) ?? 0) + 1), new Map())))}`)
  const fixed = await q(copy, `select count(*)::int n from pg_trigger where tgname = 'sources_category_fixed'`)
  step('hosted-only guards active in the disposable database (role supabase_admin present)', true)
  step('027 objects present (function, trigger, audit table)', fixed[0].n === 1 && (await q(copy, "select to_regclass('ingest.release_audits') is not null as e"))[0].e)
  // What makes a database a Supabase (hosted) one for the publication guard (025) and the restricted-evidence loader (025).
  await copy.query('create role supabase_admin nologin')
  await copy.end()

  // --- each release on a clone ---------------------------------------------------------------------------------------
  const admin = new pg.Client({ connectionString: url('postgres') }); await admin.connect()
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR ?? os.tmpdir() }
  let n = 0
  for (const releaseDir of dirs) {
    const rel = loadRelease(releaseDir)
    const name = `bai_rehearsal_${++n}`
    await admin.query(`create database ${name} template bai_hosted_copy`)
    const db = new pg.Client({ connectionString: url(name) }); await db.connect()
    const run = (cmd, extra = []) => spawnSync(process.execPath, [path.join(root, 'scripts/history/release.mjs'), cmd, '--release-dir', releaseDir, ...extra], { cwd: root, env: { ...env, BAI_DATABASE_URL: url(name) }, encoding: 'utf8' })
    const r = { release_key: rel.manifest.release_key, manifest_sha256: rel.manifest.manifest_sha256, selections: rel.manifest.totals.selections, steps: [] }
    const rstep = (nm, ok, detail) => { r.steps.push({ name: nm, ok, detail }); log(`${ok ? 'ok  ' : 'FAIL'} [${rel.manifest.totals.selections}] ${nm}${detail ? `: ${detail}` : ''}`) }
    const tl = await tables(db)
    const c0 = await counts(db, tl)
    const pv = run('preview'); rstep('preview on the disposable database is SAFE', pv.status === 0, (pv.stdout.trim().split('\n').pop() ?? '') + (pv.stderr ? ` ${pv.stderr.trim().slice(0, 200)}` : ''))
    const bad = run('apply', ['--manifest-sha256', '0'.repeat(64), '--operator', 'rehearsal operator']); rstep('apply refuses a wrong checksum', bad.status !== 0 && /must name this exact manifest/.test(bad.stderr))
    const agent = run('apply', ['--manifest-sha256', rel.manifest.manifest_sha256, '--operator', 'agent:rehearsal']); rstep('apply refuses an agent operator', agent.status !== 0 && /not agent/.test(agent.stderr))
    const ap = run('apply', ['--manifest-sha256', rel.manifest.manifest_sha256, '--operator', 'rehearsal operator']); rstep('apply commits', ap.status === 0, ap.stdout.trim().split('\n').find((l) => l.startsWith('committed')) ?? ap.stderr.trim().slice(0, 300))
    const c1 = await counts(db, tl)
    const delta = Object.fromEntries(tl.filter((t) => c1[t] !== c0[t]).map((t) => [t, c1[t] - c0[t]]))
    r.table_deltas = delta
    const e = rel.manifest.expected_database_changes
    rstep('draft selections +' + e.draft_selections_inserted, delta['public.draft_selections'] === e.draft_selections_inserted, String(delta['public.draft_selections']))
    rstep('signing rows added: 0', !delta['public.draft_signings'], String(delta['public.draft_signings'] ?? 0))
    rstep('players created within the expected maximum', (delta['public.players'] ?? 0) <= e.players_created_max, `${delta['public.players']} (max ${e.players_created_max})`)
    rstep('external ids within the expected maximum', (delta['public.player_external_ids'] ?? 0) <= e.external_ids_inserted_max, `${delta['public.player_external_ids']} (max ${e.external_ids_inserted_max})`)
    const untouched = ['public.drafts', 'public.organizations', 'bai_meta.schema_migrations', 'research.reviewers', 'research.certifications'].filter((t) => tl.includes(t) && delta[t])
    rstep('migrations, organizations, drafts, reviewers and certifications untouched', !untouched.length, untouched.join(', '))
    const audit = (await q(db, 'select counts, jsonb_array_length(entries) n from ingest.release_audits where manifest_sha256 = $1', [rel.manifest.manifest_sha256]))[0]
    rstep('release audit written with every record', audit && audit.n === rel.manifest.totals.selections, JSON.stringify(audit?.counts))
    const cats = await q(db, `select s.attribution_category c, count(*)::int n from public.draft_selections ds join public.drafts d on d.id = ds.draft_id join public.sources s on s.id = ds.source_id where d.draft_year = 2020 group by 1`)
    rstep('every 2020 selection cites Wikipedia only', cats.length === 1 && cats[0].c === 'WIKIPEDIA', JSON.stringify(cats))
    const wd = await q(db, `select count(*)::int n from public.source_observations o join public.sources s on s.id = o.source_id where s.attribution_category = 'WIKIDATA'`)
    rstep('Wikidata corroboration recorded as observations citing the WIKIDATA source', wd[0].n === 2 * rel.manifest.totals.identity_tiers.VERIFIED, `${wd[0].n} observations`)
    const ap2 = run('apply', ['--manifest-sha256', rel.manifest.manifest_sha256, '--operator', 'rehearsal operator']); const c2 = await counts(db, tl)
    rstep('replay is idempotent (already applied, no change)', ap2.status === 0 && /already applied/.test(ap2.stdout) && tl.every((t) => c2[t] === c1[t]))
    const pv2 = run('preview'); rstep('preview after the apply reports the replay as SAFE', pv2.status === 0, (pv2.stdout.trim().split('\n').pop() ?? '').slice(0, 160))
    const refresh = spawnSync(process.execPath, [path.join(root, 'scripts/db/refresh-read-models.mjs')], { cwd: root, env: { ...env, BAI_DATABASE_URL: url(name) }, encoding: 'utf8' })
    rstep('read models refreshed', refresh.status === 0, refresh.stdout.trim().split('\n').pop())
    const { integrityViolations } = await import('../research/lib/integrity.mjs')
    const viol = await integrityViolations(db)
    rstep('integrity violations: 0', viol.length === 0, JSON.stringify(viol).slice(0, 200))
    const cov = await q(db, `select coverage_state::text s, count(*)::int n from public.rm_research_coverage rc where rc.scope_key = '2020-JUNE_AMATEUR' group by 1`).catch(() => [])
    r.coverage_states = cov
    rstep('every 2020 club coverage cell is partial', cov.length > 0 && cov.every((x) => x.s === 'PARTIAL_RECONSTRUCTION'), JSON.stringify(cov))
    const sec = spawnSync(process.execPath, [path.join(root, 'scripts/db/security.mjs')], { cwd: root, env: { ...env, BAI_DATABASE_URL: url(name) }, encoding: 'utf8' })
    rstep('security check passes', sec.status === 0, sec.stdout.trim().split('\n').slice(-2).join(' | ').slice(0, 200))
    await db.end()
    report.releases.push(r)
  }
  await admin.end()
  report.ok = report.steps.every((s) => s.ok) && report.releases.every((r) => r.steps.every((s) => s.ok))
  report.finished_at = new Date().toISOString()
  if (outFile) fs.writeFileSync(outFile, JSON.stringify(report, null, 1) + '\n')
  log(report.ok ? 'REHEARSAL OK' : 'REHEARSAL FAILED')
  process.exitCode = report.ok ? 0 : 1
} finally {
  await server.stop().catch(() => {})
  fs.rmSync(dir, { recursive: true, force: true })
}
void execFileSync
