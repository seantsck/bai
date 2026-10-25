// A consistent, checksummed, row-for-row snapshot of every BAI table: the data side of a backup, and the input to hosted-preflight / restore-snapshot.
//   * ONE transaction, REPEATABLE READ and READ ONLY: the migration metadata and every table are read from the same database snapshot, so a write that
//     commits while the snapshot is being taken can appear in none of them or in all of them (never in some). The server enforces read-only.
//   * Format: one `<schema>.<table>.ndjson` per table (`to_jsonb(row)`, natural order) and `manifest.json`. The original keys (taken_at, tables{rows,sha256},
//     migrations, total_rows, manifest_sha256) are unchanged, so every earlier consumer keeps working; this adds `columns` (each table's column list) and
//     `snapshot` (isolation, the PostgreSQL snapshot descriptor, server version).
//   * takeSnapshot never writes into an existing directory: an existing snapshot (for instance the historical benchmark input) cannot be overwritten.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex')
export const SNAPSHOT_SCHEMAS = ['public', 'ingest', 'research']

/**
 * @param {import('pg').ClientBase} client a connected client (never written to)
 * @param {string} outDir must not exist or must be empty
 * @param {{ isolation?: string, hooks?: { afterTable?: (name: string) => Promise<void> } }} [opts] isolation is for the consistency test's control only
 */
export async function takeSnapshot (client, outDir, opts = {}) {
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length) throw new Error(`refusing to write into ${outDir}: it is not empty (a snapshot is never overwritten)`)
  fs.mkdirSync(outDir, { recursive: true })
  const isolation = opts.isolation ?? 'repeatable read'
  const manifest = { taken_at: new Date().toISOString(), tables: {}, columns: {} }
  await client.query(`begin isolation level ${isolation} read only`)
  try {
    // The first query fixes the snapshot; everything below belongs to it.
    const s = (await client.query(`select pg_current_snapshot()::text snap, current_setting('transaction_isolation') iso, current_setting('transaction_read_only') ro,
      current_setting('server_version') v, current_database() d, (select max(version) from bai_meta.schema_migrations) mv, (select count(*)::int from bai_meta.schema_migrations) mn`)).rows[0]
    if (isolation === 'repeatable read' && (s.iso !== 'repeatable read' || s.ro !== 'on')) throw new Error(`the snapshot transaction is ${s.iso} / read-only ${s.ro}`)
    manifest.migrations = { v: s.mv, n: s.mn }
    manifest.snapshot = { isolation: s.iso, read_only: s.ro === 'on', pg_snapshot: s.snap, server_version: s.v, database: s.d }
    const tables = (await client.query(`select table_schema s, table_name t from information_schema.tables where table_schema = any($1) and table_type = 'BASE TABLE' order by 1, 2`, [SNAPSHOT_SCHEMAS])).rows
    for (const { s: sch, t } of tables) {
      const key = `${sch}.${t}`
      const rows = (await client.query(`select to_jsonb(x) j from "${sch}"."${t}" x`)).rows.map((r) => JSON.stringify(r.j))
      const text = rows.join('\n') + (rows.length ? '\n' : '')
      fs.writeFileSync(path.join(outDir, `${key}.ndjson`), text)
      manifest.tables[key] = { rows: rows.length, sha256: sha256(text) }
      manifest.columns[key] = (await client.query(`select column_name c from information_schema.columns where table_schema = $1 and table_name = $2 order by ordinal_position`, [sch, t])).rows.map((r) => r.c)
      if (opts.hooks?.afterTable) await opts.hooks.afterTable(key)
    }
    // the metadata must still describe the same snapshot after the last table
    const again = (await client.query(`select pg_current_snapshot()::text snap, (select max(version) from bai_meta.schema_migrations) mv, (select count(*)::int from bai_meta.schema_migrations) mn`)).rows[0]
    if (isolation === 'repeatable read' && (again.snap !== s.snap || again.mv !== s.mv || again.mn !== s.mn)) throw new Error('the database snapshot changed while it was being read')
  } finally { await client.query('rollback') }
  manifest.total_rows = Object.values(manifest.tables).reduce((a, b) => a + b.rows, 0)
  manifest.manifest_sha256 = sha256(JSON.stringify(manifest.tables))
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n')
  return manifest
}

/** Everything that can be checked about a snapshot without a database. Returns a list of problems (empty = sound). Works on earlier snapshots too. */
export function verifySnapshot (dir) {
  const problems = []
  let manifest
  try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) } catch (e) { return [`manifest.json unreadable: ${e.message}`] }
  if (!manifest.tables || typeof manifest.tables !== 'object') return ['manifest.json has no tables']
  const listed = new Set(Object.keys(manifest.tables).map((t) => `${t}.ndjson`))
  for (const f of fs.readdirSync(dir)) if (f !== 'manifest.json' && !listed.has(f)) problems.push(`file ${f} is not listed in the manifest`)
  let total = 0
  for (const [t, m] of Object.entries(manifest.tables)) {
    const file = path.join(dir, `${t}.ndjson`)
    if (!fs.existsSync(file)) { problems.push(`${t}: file missing`); continue }
    const buf = fs.readFileSync(file)
    if (sha256(buf) !== m.sha256) problems.push(`${t}: SHA-256 differs from the manifest`)
    const lines = buf.toString('utf8').split('\n').filter(Boolean)
    if (lines.length !== m.rows) problems.push(`${t}: ${lines.length} rows, manifest says ${m.rows}`)
    total += lines.length
    const cols = manifest.columns?.[t]
    let keys0 = null
    for (const [i, line] of lines.entries()) {
      let j
      try { j = JSON.parse(line) } catch { problems.push(`${t}: row ${i + 1} is not JSON`); break }
      const keys = Object.keys(j)
      if (cols) { if (keys.length !== cols.length || !cols.every((c) => c in j)) { problems.push(`${t}: row ${i + 1} does not have the manifest's columns`); break } }
      else if (keys0 && JSON.stringify(keys0) !== JSON.stringify(keys)) { problems.push(`${t}: row ${i + 1} has different columns from row 1`); break }
      keys0 ??= keys
    }
  }
  if (manifest.total_rows !== total) problems.push(`total_rows ${manifest.total_rows} != ${total}`)
  if (manifest.manifest_sha256 !== sha256(JSON.stringify(Object.fromEntries(Object.entries(manifest.tables).map(([k, v]) => [k, { rows: v.rows, sha256: v.sha256 }]))))) problems.push('manifest_sha256 does not match the table entries')
  if (!manifest.migrations?.v) problems.push('manifest has no migration level')
  return problems
}
