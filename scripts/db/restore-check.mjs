// Proves a backup directory restores: the snapshot is restored into a DISPOSABLE local PostgreSQL 17 (embedded, random port, removed afterwards), the strict
// preflight compares the restored database with the snapshot's manifest at the expected migration level, and the logical export is checked against the snapshot.
// Nothing here can reach hosted: the only database URL it uses is the one it creates itself.
//   node scripts/db/restore-check.mjs --backup-dir ~/bai-backups/g1-<UTC> --expect-level 028 [--log-dir <dir outside the backup>]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import EmbeddedPostgres from 'embedded-postgres'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const argv = process.argv.slice(2)
const opt = (k, d = null) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d }
const backup = opt('backup-dir'); const level = opt('expect-level'); const logDir = opt('log-dir')
const skipExport = argv.includes('--no-export-check')   // tests only: a stand-in exporter does not write a restorable pg_dump
if (!backup || !/^\d{3}$/.test(level ?? '')) { console.error('usage: restore-check.mjs --backup-dir <dir> --expect-level <NNN> [--log-dir <dir>]'); process.exit(2) }
const B = path.resolve(backup)
if (logDir && path.resolve(logDir).startsWith(B + path.sep)) { console.error('the log directory must be OUTSIDE the backup directory'); process.exit(2) }
const port = 20000 + Math.floor(Math.random() * 30000)
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-restore-'))
const server = new EmbeddedPostgres({ databaseDir: dataDir, user: 'postgres', password: 'postgres', port, persistent: false, onLog: () => {} })
let failed = false
try {
  await server.initialise(); await server.start()
  const c = new pg.Client({ host: '127.0.0.1', port, user: 'postgres', password: 'postgres', database: 'postgres' }); await c.connect(); await c.query('create database restore_check'); await c.end()
  const url = `postgresql://postgres:postgres@127.0.0.1:${port}/restore_check`
  const base = Object.fromEntries(['PATH', 'HOME', 'LANG', 'TMPDIR'].filter((k) => process.env[k]).map((k) => [k, process.env[k]]))
  const run = (name, args, env = {}) => {
    const r = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', env: { ...base, ...env } })
    const out = (r.stdout ?? '') + (r.stderr ?? '')
    if (logDir) { fs.mkdirSync(logDir, { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(logDir, `${name}.log`), out.replace(/postgres(ql)?:\/\/\S+/g, '[url]')) }
    console.log(`${r.status === 0 ? 'PASS' : 'FAIL'} ${name}: ${out.trim().split('\n').slice(-1)[0].slice(0, 200)}`)
    if (r.status !== 0) failed = true
  }
  run('restore', ['scripts/db/restore-snapshot.mjs', '--snapshot-dir', `${B}/snapshot`, '--database-url', url])
  if (!failed) run('preflight-restored', ['scripts/db/hosted-preflight.mjs', '--snapshot-dir', `${B}/snapshot`, '--expect-level', level], { BAI_DATABASE_URL: url })
  if (!failed && !skipExport) run('verify-logical-export', ['scripts/db/verify-logical-export.mjs', '--export-dir', `${B}/export`, '--snapshot-dir', `${B}/snapshot`])
} finally { await server.stop().catch(() => {}); fs.rmSync(dataDir, { recursive: true, force: true }) }
console.log(failed ? 'RESTORE CHECK FAILED' : 'RESTORE CHECK OK')
process.exit(failed ? 1 : 0)
