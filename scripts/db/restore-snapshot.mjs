// LOCAL-ONLY restore of a hosted snapshot into a fresh database: the data side of a "restorable backup".
//   node scripts/db/restore-snapshot.mjs --snapshot-dir <dir> --database-url postgresql://…@127.0.0.1:…/<new empty database>
// The snapshot (scripts/db/bench/snapshot-hosted.mjs: every row of every BAI table as checksummed NDJSON, taken in one read-only transaction) is
// loaded into a database whose schema is built by the BAI runner from the committed migrations through the snapshot's own migration level.
// Refuses a non-local target (a restore onto hosted is a separate, deliberate act) and a database that already holds BAI objects.
// What it restores: the BAI-owned schemas and rows. What it does not: Supabase platform state (auth, storage, roles and their passwords, project settings).
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import pg from 'pg'
import { applyMigrations } from './lib/migrations.mjs'
import { isLocalUrl } from './lib/connection.mjs'

const argv = process.argv.slice(2)
const opt = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : null }
const dir = opt('snapshot-dir'); const url = opt('database-url')
if (!dir || !url) { console.error('usage: --snapshot-dir <dir> --database-url <local empty database>'); process.exit(2) }
if (!isLocalUrl(url)) { console.error('refusing: restore is local-only (restoring onto hosted needs its own authorization)'); process.exit(2) }
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
for (const [t, m] of Object.entries(manifest.tables)) {
  if (crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, `${t}.ndjson`))).digest('hex') !== m.sha256) throw new Error(`snapshot file ${t} does not match its checksum; refusing`)
}
const db = new pg.Client({ connectionString: url }); await db.connect()
try {
  if ((await db.query("select count(*)::int n from information_schema.schemata where schema_name in ('bai_meta','analytics','research','ingest')")).rows[0].n > 0) throw new Error('the target already holds BAI schemas; restore into a new empty database')
  const level = manifest.migrations?.v
  await applyMigrations(db, { through: level })
  const tables = Object.keys(manifest.tables).filter((t) => t !== 'bai_meta.schema_migrations')
  await db.query('set session_replication_role = replica')
  await db.query(`truncate ${tables.join(', ')} restart identity`)
  let rows = 0
  for (const t of tables) {
    const lines = fs.readFileSync(path.join(dir, `${t}.ndjson`), 'utf8').split('\n').filter(Boolean)
    const [sch, n] = t.split('.')
    const cols = (await db.query(`select column_name c from information_schema.columns where table_schema = $1 and table_name = $2 and is_generated = 'NEVER' order by ordinal_position`, [sch, n])).rows.map((r) => `"${r.c}"`)
    for (let i = 0; i < lines.length; i += 200) await db.query(`insert into ${t} (${cols.join(', ')}) overriding system value select ${cols.join(', ')} from jsonb_populate_recordset(null::${t}, $1::jsonb)`, ['[' + lines.slice(i, i + 200).join(',') + ']'])
    rows += lines.length
  }
  for (const r of (await db.query(`select s.nspname sch, c.relname tbl, a.attname col from pg_class c join pg_namespace s on s.oid = c.relnamespace join pg_attribute a on a.attrelid = c.oid where a.attidentity <> '' and s.nspname in ('public','ingest','research','analytics','bai_meta') and c.relkind = 'r' and not a.attisdropped`)).rows) {
    await db.query(`select setval(pg_get_serial_sequence('${r.sch}.${r.tbl}', '${r.col}'), greatest(coalesce((select max(${r.col}) from ${r.sch}.${r.tbl}), 0), 1), (select count(*) > 0 from ${r.sch}.${r.tbl}))`)
  }
  await db.query('reset session_replication_role')
  console.log(`restored ${tables.length} tables, ${rows} rows, schema at migration ${level}; verify with: scripts/db/hosted-preflight.mjs --snapshot-dir ${dir} --expect-level ${level}`)
} finally { await db.end() }
