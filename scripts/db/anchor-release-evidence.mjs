// LOCAL-ONLY (no hosted connection exists in this process): the INDEPENDENT anchor for the release evidence of one owner-authorized draft release.
//   node scripts/db/anchor-release-evidence.mjs --authorization <signed authorization.json> --snapshot-dir <post-release backup snapshot> --before-snapshot-dir <pre-release backup snapshot>
//                                               --post-apply-report <the executor's post-apply report> --out <new anchor.json>
// It uses only artifacts that were captured independently of the evidence: the pre-release and post-release backup SNAPSHOTS (each verified with verify-snapshot) and the release executor's
// row-level post-apply report. It checks, for the tables the authorization lists: the snapshot row counts differ by exactly the authorized delta; the report's row-count deltas are exactly the
// authorized ones and it found no pre-existing row missing or modified; and that NO other table changed between the two snapshots except the authorized read-model refresh tables. The post-release
// state's fingerprints (ingest.promotion_fingerprint, the same function the verifier uses) are then computed on a DISPOSABLE database restored from the post-release snapshot, never from the
// live database. The anchor is data for `record-release-evidence`, which refuses to write evidence unless the live database equals it. Nothing here signs anything.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import EmbeddedPostgres from 'embedded-postgres'
import { ANCHOR_FORMAT, anchorChecks } from './lib/promotion-cumulative.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const argv = process.argv.slice(2)
const opt = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : null }
const die = (m, c = 1) => { console.error(`anchor: ${m}`); process.exit(c) }
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')
const [authFile, after, before, reportFile, out] = ['authorization', 'snapshot-dir', 'before-snapshot-dir', 'post-apply-report', 'out'].map(opt)
if (![authFile, after, before, reportFile, out].every(Boolean)) die('usage: --authorization <file> --snapshot-dir <dir> --before-snapshot-dir <dir> --post-apply-report <file> --out <new file>', 2)
if (fs.existsSync(out)) die(`${out} already exists`, 2)

{
  const authBytes = fs.readFileSync(authFile); const auth = JSON.parse(authBytes.toString('utf8'))
  for (const d of [after, before]) { const r = spawnSync(process.execPath, ['scripts/db/verify-snapshot.mjs', d], { cwd: root, encoding: 'utf8' }); if (r.status !== 0) die(`verify-snapshot failed for ${d}: ${(r.stdout + r.stderr).trim().split('\n').pop()}`) }
  const mAfter = JSON.parse(fs.readFileSync(path.join(after, 'manifest.json'), 'utf8')); const mBefore = JSON.parse(fs.readFileSync(path.join(before, 'manifest.json'), 'utf8'))
  const reportBytes = fs.readFileSync(reportFile); const report = JSON.parse(reportBytes.toString('utf8'))
  const { problems, tables } = anchorChecks(auth, mAfter, mBefore, report)
  if (problems.length) { for (const p of problems) console.error(`  - ${p}`); die('the independent artifacts do not support this release; no anchor written') }
  const dataDir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'bai-anchor-')); const port = 20000 + Math.floor(Math.random() * 30000)
  const server = new EmbeddedPostgres({ databaseDir: dataDir, user: 'postgres', password: 'postgres', port, persistent: false, onLog: () => {} })
  try {
    await server.initialise(); await server.start()
    const a = new pg.Client({ host: '127.0.0.1', port, user: 'postgres', password: 'postgres', database: 'postgres' }); await a.connect(); await a.query('create database anchor_restore'); await a.end()
    const url = `postgresql://postgres:postgres@127.0.0.1:${port}/anchor_restore`
    const env = Object.fromEntries(['PATH', 'HOME', 'LANG', 'TMPDIR'].filter((k) => process.env[k]).map((k) => [k, process.env[k]]))
    const r = spawnSync(process.execPath, ['scripts/db/restore-snapshot.mjs', '--snapshot-dir', after, '--database-url', url], { cwd: root, encoding: 'utf8', env }); if (r.status !== 0) die(`restore of the post-release snapshot failed: ${(r.stdout + r.stderr).trim().split('\n').pop()}`)
    const c = new pg.Client({ connectionString: url }); await c.connect()
    for (const t of Object.keys(tables)) {
      const f = (await c.query('select ingest.promotion_fingerprint($1) f', [t])).rows[0].f
      if (Number(f.n) !== tables[t].n_after) die(`${t}: the restored snapshot holds ${f.n} rows, the manifest says ${tables[t].n_after}`)
      tables[t].md5_after = f.md5
    }
    await c.end()
  } finally { await server.stop().catch(() => {}); fs.rmSync(dataDir, { recursive: true, force: true }) }
  const anchor = { format: ANCHOR_FORMAT, authorization_sha256: sha(authBytes), release_key: auth.release_key, snapshot_manifest_sha256: mAfter.manifest_sha256, before_manifest_sha256: mBefore.manifest_sha256, post_apply_report_sha256: sha(reportBytes), computed_on: 'a disposable database restored from the post-release snapshot', tables }
  fs.writeFileSync(out, JSON.stringify(anchor, null, 1) + '\n', { flag: 'wx', mode: 0o600 }); console.log(JSON.stringify({ anchor: out, tables: Object.keys(tables).length, snapshot_manifest_sha256: anchor.snapshot_manifest_sha256 }))
}
