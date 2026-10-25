// Builds the benchmark databases from the fixed snapshot (no hosted access):
//   bai_base   migrations 001-027, the snapshot rows, then 028 (BAI's 65 trades), ANALYZEd
//   bai_scale  bai_base plus the 336 local Retrosheet trade candidates (applied by the real importer), ANALYZEd
// The candidates batch checksum is recorded. Everything lives in the persistent disk cluster (see cluster.mjs).
//   node scripts/db/bench/build-datasets.mjs [--batch .local/retrosheet/out/candidates-batch.json]
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { startCluster, benchDir, hardware } from './cluster.mjs'
import { applyMigrations } from '../lib/migrations.mjs'
import * as P from '../../research/lib/pipeline.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const argv = process.argv.slice(2)
const batchFile = path.resolve(root, argv[argv.indexOf('--batch') + 1] ?? '.local/retrosheet/out/candidates-batch.json')
const snap = path.join(benchDir, 'snapshot')
const manifest = JSON.parse(fs.readFileSync(path.join(snap, 'manifest.json'), 'utf8'))
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')
const cluster = await startCluster()
const q = async (db, sql, p) => (await db.query(sql, p)).rows
try {
  for (const [t, m] of Object.entries(manifest.tables)) if (sha(fs.readFileSync(path.join(snap, `${t}.ndjson`))) !== m.sha256) throw new Error(`snapshot file ${t} does not match its checksum`)
  await cluster.create('bai_base')
  const db = await cluster.connect('bai_base')
  await applyMigrations(db, { through: '027' })
  const tables = Object.keys(manifest.tables).filter((t) => t !== 'bai_meta.schema_migrations')
  await db.query('set session_replication_role = replica')
  await db.query(`truncate ${tables.join(', ')} restart identity`)
  for (const t of tables) {
    const rows = fs.readFileSync(path.join(snap, `${t}.ndjson`), 'utf8').split('\n').filter(Boolean)
    const [s, n] = t.split('.')
    const cols = (await q(db, `select column_name c from information_schema.columns where table_schema = $1 and table_name = $2 and is_generated = 'NEVER' order by ordinal_position`, [s, n])).map((r) => `"${r.c}"`)
    for (let i = 0; i < rows.length; i += 200) await db.query(`insert into ${t} (${cols.join(', ')}) overriding system value select ${cols.join(', ')} from jsonb_populate_recordset(null::${t}, $1::jsonb)`, ['[' + rows.slice(i, i + 200).join(',') + ']'])
  }
  for (const r of await q(db, `select s.nspname sch, c.relname tbl, a.attname col from pg_class c join pg_namespace s on s.oid = c.relnamespace join pg_attribute a on a.attrelid = c.oid where a.attidentity <> '' and s.nspname in ('public','ingest','research') and c.relkind = 'r'`)) {
    await db.query(`select setval(pg_get_serial_sequence('${r.sch}.${r.tbl}', '${r.col}'), greatest(coalesce((select max(${r.col}) from ${r.sch}.${r.tbl}), 0), 1), (select count(*) > 0 from ${r.sch}.${r.tbl}))`)
  }
  await db.query('reset session_replication_role')
  await applyMigrations(db)
  await db.query('analyze')
  const base = (await q(db, 'select (select count(*) from public.transactions)::int trades, (select count(*) from public.players)::int players, (select count(*) from public.war_observations)::int war'))[0]
  console.log('bai_base', JSON.stringify(base))
  await db.end()
  await cluster.clone('bai_base', 'bai_scale')
  const s = await cluster.connect('bai_scale')
  const raw = fs.readFileSync(batchFile)
  const tmp = path.join(os.tmpdir(), `bench-batch-${process.pid}.json`)
  fs.writeFileSync(tmp, raw)
  const { batch } = await P.stageFile(s, tmp, { allowFixtures: true })
  const v = await P.validateBatch(s, batch.id)
  const out = await P.applyBatch(s, batch.id, { write: true, allowPartial: true })
  fs.rmSync(tmp)
  await s.query('analyze')
  const scale = (await q(s, 'select (select count(*) from public.transactions)::int trades, (select count(*) from public.players)::int players, (select count(*) from public.trade_package_assets)::int assets'))[0]
  console.log('bai_scale', JSON.stringify(scale), JSON.stringify(out.report.actions), `valid ${v.counts.valid}/${v.counts.records}`)
  await s.end()
  fs.mkdirSync(path.join(benchDir, 'results'), { recursive: true })
  fs.writeFileSync(path.join(benchDir, 'results', 'datasets.json'), JSON.stringify({ built_at: new Date().toISOString(), snapshot_sha256: manifest.manifest_sha256, snapshot_taken_at: manifest.taken_at, candidates_batch_sha256: sha(raw), base, scale, actions: out.report.actions, hardware: hardware() }, null, 1) + '\n')
} finally { await cluster.stop() }
