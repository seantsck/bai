// A consistent snapshot of the hosted BAI data: ONE REPEATABLE READ, READ ONLY transaction (migration level and every table from the same database snapshot),
// every row of every BAI table as newline-delimited JSON with a SHA-256 manifest (library: scripts/db/lib/snapshot.mjs). Hosted is never written.
//   node --env-file=.env.hosted.local scripts/db/bench/snapshot-hosted.mjs --out <new directory>
// Without --out the historical benchmark location (BAI_BENCH_DIR/snapshot) is used, but an existing, non-empty snapshot is never overwritten or deleted:
// the fixed input of the benchmarks stays as it was. The snapshot stays on local disk.
import fs from 'node:fs'
import path from 'node:path'
import pg from 'pg'
import { ownerDatabaseUrl, isLocalUrl } from '../lib/connection.mjs'
import { takeSnapshot, verifySnapshot } from '../lib/snapshot.mjs'
import { benchDir } from './cluster.mjs'

const argv = process.argv.slice(2)
const o = argv.indexOf('--out')
const dir = path.resolve(o >= 0 ? argv[o + 1] : path.join(benchDir, 'snapshot'))
const url = ownerDatabaseUrl()
if (isLocalUrl(url) && !argv.includes('--allow-local')) throw new Error('point this at the hosted read-only source')
const db = new pg.Client({ connectionString: url }); await db.connect()
let manifest
try { manifest = await takeSnapshot(db, dir) } finally { await db.end() }
const problems = verifySnapshot(dir)
if (problems.length) { console.error(`snapshot written to ${dir} but verification FAILED:\n  ${problems.join('\n  ')}`); process.exit(1) }
fs.chmodSync(dir, 0o700)
console.log(`snapshot: ${Object.keys(manifest.tables).length} tables, ${manifest.total_rows} rows, migrations ${manifest.migrations.v}, ${manifest.snapshot.isolation} read-only, sha256 ${manifest.manifest_sha256}\n  verified: manifest, per-file SHA-256, row counts, columns -> ${dir}`)
