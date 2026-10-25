// Fixed input snapshot of hosted BAI data for the benchmarks: one READ-ONLY transaction, every row of every BAI table as
// newline-delimited JSON, with a SHA-256 manifest. Hosted is never written. The snapshot stays on local disk (gitignored area).
//   node --env-file=.env.hosted.local scripts/db/bench/snapshot-hosted.mjs
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import pg from 'pg'
import { ownerDatabaseUrl, isLocalUrl } from '../lib/connection.mjs'
import { benchDir } from './cluster.mjs'

const url = ownerDatabaseUrl()
if (isLocalUrl(url)) throw new Error('point this at the hosted read-only source')
const dir = path.join(benchDir, 'snapshot')
fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true })
const db = new pg.Client({ connectionString: url }); await db.connect()
const manifest = { taken_at: new Date().toISOString(), tables: {} }
try {
  await db.query('begin read only')
  manifest.migrations = (await db.query('select max(version) v, count(*)::int n from bai_meta.schema_migrations')).rows[0]
  const tables = (await db.query(`select table_schema s, table_name t from information_schema.tables where table_schema in ('public','ingest','research') and table_type = 'BASE TABLE' order by 1, 2`)).rows
  for (const { s, t } of tables) {
    const rows = (await db.query(`select to_jsonb(x) j from ${s}.${t} x`)).rows.map((r) => JSON.stringify(r.j))
    const text = rows.join('\n') + (rows.length ? '\n' : '')
    const file = `${s}.${t}.ndjson`
    fs.writeFileSync(path.join(dir, file), text)
    manifest.tables[`${s}.${t}`] = { rows: rows.length, sha256: crypto.createHash('sha256').update(text).digest('hex') }
  }
  await db.query('rollback')
} finally { await db.end() }
manifest.total_rows = Object.values(manifest.tables).reduce((a, b) => a + b.rows, 0)
manifest.manifest_sha256 = crypto.createHash('sha256').update(JSON.stringify(manifest.tables)).digest('hex')
fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n')
console.log(`snapshot: ${Object.keys(manifest.tables).length} tables, ${manifest.total_rows} rows, migrations ${manifest.migrations.v}, sha256 ${manifest.manifest_sha256}`)
