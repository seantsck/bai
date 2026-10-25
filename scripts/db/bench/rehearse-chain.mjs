// Stepwise rehearsal of the pending migration chain on a clone of the hosted snapshot (a disposable local database, never hosted):
//   node scripts/db/bench/rehearse-chain.mjs [--from bai_base] [--to bai_rehearsal]
// Built from the fixed hosted snapshot (checksummed local files; hosted is not contacted): migrations 001-027 plus the snapshot rows, i.e. hosted's state.
// 027 -> 028 -> 029 -> 030, one version at a time, with the object counts each step adds, the base data compared afterwards, then the repository security audit.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { startCluster, benchDir } from './cluster.mjs'
import { applyMigrations } from '../lib/migrations.mjs'
import { migrationProblems } from '../../history/lib/release.mjs'

const argv = process.argv.slice(2)
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d }
const to = opt('to', 'bai_rehearsal')
const snap = path.join(benchDir, 'snapshot')
const manifest = JSON.parse(fs.readFileSync(path.join(snap, 'manifest.json'), 'utf8'))
const c = await startCluster()
let failed = false
try {
  for (const [t, m] of Object.entries(manifest.tables)) if (crypto.createHash('sha256').update(fs.readFileSync(path.join(snap, `${t}.ndjson`))).digest('hex') !== m.sha256) throw new Error(`snapshot file ${t} does not match its checksum`)
  await c.create(to)
  const db = await c.connect(to)
  await applyMigrations(db, { through: '027' })
  const tables = Object.keys(manifest.tables).filter((t) => t !== 'bai_meta.schema_migrations')
  await db.query('set session_replication_role = replica')
  await db.query(`truncate ${tables.join(', ')} restart identity`)
  for (const t of tables) {
    const rows = fs.readFileSync(path.join(snap, `${t}.ndjson`), 'utf8').split('\n').filter(Boolean)
    const [sch, n] = t.split('.')
    const cols = (await db.query(`select column_name c from information_schema.columns where table_schema = $1 and table_name = $2 and is_generated = 'NEVER' order by ordinal_position`, [sch, n])).rows.map((r) => `"${r.c}"`)
    for (let i = 0; i < rows.length; i += 200) await db.query(`insert into ${t} (${cols.join(', ')}) overriding system value select ${cols.join(', ')} from jsonb_populate_recordset(null::${t}, $1::jsonb)`, ['[' + rows.slice(i, i + 200).join(',') + ']'])
  }
  for (const r of (await db.query(`select s.nspname sch, c.relname tbl, a.attname col from pg_class c join pg_namespace s on s.oid = c.relnamespace join pg_attribute a on a.attrelid = c.oid where a.attidentity <> '' and s.nspname in ('public','ingest','research','analytics','bai_meta') and c.relkind = 'r' and not a.attisdropped`)).rows) {
    await db.query(`select setval(pg_get_serial_sequence('${r.sch}.${r.tbl}', '${r.col}'), greatest(coalesce((select max(${r.col}) from ${r.sch}.${r.tbl}), 0), 1), (select count(*) > 0 from ${r.sch}.${r.tbl}))`)
  }
  await db.query('reset session_replication_role')
  const before = (await db.query(`select (select count(*) from public.transactions)::int tx, (select count(*) from public.trade_packages)::int packages, (select count(*) from public.draft_selections)::int draft_selections, (select count(*) from public.international_signings)::int intl`)).rows[0]
  console.log('hosted snapshot state (027):', JSON.stringify(before))
  // compare ORIGINAL columns only (028 adds columns); registries may only gain rows
  const cols = {}
  for (const t of tables) { const [sch, n] = t.split('.'); cols[t] = (await db.query(`select column_name c from information_schema.columns where table_schema = $1 and table_name = $2 order by ordinal_position`, [sch, n])).rows.map((r) => `"${r.c}"`).join(', ') }
  const REGISTRIES = ['public.internal_objects', 'public.provenance_fact_tables']
  const fp = async () => { const o = {}; for (const t of tables) { const rows = (await db.query(`select row(${cols[t]})::text x from ${t} order by 1`)).rows.map((r) => r.x); o[t] = { n: rows.length, rows: REGISTRIES.includes(t) ? new Set(rows) : null, h: crypto.createHash('md5').update(rows.join('|')).digest('hex') } } return o }
  const fp027 = await fp()
  const version = async () => (await db.query('select max(version) v from bai_meta.schema_migrations')).rows[0].v
  const objects = async () => (await db.query(`select n.nspname s, c.relkind k, count(*)::int n from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public','analytics','research','ingest','bai_meta') and c.relkind in ('r','v') group by 1, 2`)).rows
  const total = (rows) => rows.reduce((a, r) => a + r.n, 0)
  console.log(`start: version ${await version()}`)
  if ((await version()) !== '027') throw new Error(`expected the snapshot at 027, found ${await version()}`)
  // The historical-release guard (the pending 2025 draft release goes through it) must accept hosted's state at every step, with all of 028-030 committed.
  const guard = async (label) => { const p = await migrationProblems(db); console.log(`  release migration guard at ${label}: ${p.length ? 'PROBLEMS ' + p.join('; ') : 'ok'}`); if (p.length) throw new Error('release guard refused the database') }
  await guard('027 (hosted today, 028-030 committed but unapplied)')
  for (const v of ['028', '029', '030']) {
    const b = await objects(); const t0 = Date.now()
    await applyMigrations(db, { through: v })
    const a = await objects()
    console.log(`  ${v}: applied in ${((Date.now() - t0) / 1000).toFixed(1)}s, version ${await version()}, tables+views ${total(b)} -> ${total(a)}`)
    if ((await version()) !== v) throw new Error(`expected version ${v}`)
    await guard(v)
  }
  await applyMigrations(db)   // idempotent: nothing further to apply
  console.log(`re-apply: version ${await version()} (no change)`)
  const counts = (await db.query(`select (select count(*) from public.transactions)::int tx, (select count(*) from public.organizations)::int orgs, (select count(*) from public.players)::int players, (select count(*) from public.draft_selections)::int draft_selections, (select count(*) from public.international_signings)::int intl, (select count(*) from public.rm_transactions)::int published`)).rows[0]
  console.log('after:', JSON.stringify(counts))
  if (counts.tx !== before.tx || counts.draft_selections !== before.draft_selections || counts.intl !== before.intl) throw new Error('migrations 028-030 changed existing record counts')
  const fpAfter = await fp()
  const changed = tables.filter((t) => (REGISTRIES.includes(t) ? ![...fp027[t].rows].every((x) => fpAfter[t].rows.has(x)) : fp027[t].n !== fpAfter[t].n || fp027[t].h !== fpAfter[t].h))
  console.log(`existing tables compared: ${tables.length}; existing rows changed or removed: ${changed.join(', ') || 'none'}; registries only gained rows: ${REGISTRIES.map((t) => `${t} +${fpAfter[t].n - fp027[t].n}`).join(', ')}`)
  if (changed.length) throw new Error('migrations 028-030 changed existing data')
  await db.end()
  const { port } = { port: 54329 }
  const r = spawnSync(process.execPath, ['scripts/db/security.mjs'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, BAI_DATABASE_URL: c.url(to) } })
  console.log(r.stdout.split('\n').slice(-3).join('\n').trim() || r.stderr.slice(-300)); if (r.status !== 0) failed = true
} catch (e) { failed = true; console.error(e.message) } finally { await c.stop() }
process.exit(failed ? 1 : 0)
