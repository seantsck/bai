// One authorized operation: a verified, encrypted, OFF-SITE copy of a BAI backup, with a PASS/FAIL report. See docs/transactions/offsite-automation.md.
//
//   node --env-file=<hosted env> scripts/db/backup-run.mjs all     --gate <gate.json> [--root ~/bai-backups]   capture -> restore-check -> off-site (one command)
//   node --env-file=<hosted env> scripts/db/backup-run.mjs capture --expect-level 028 [--gate <gate.json>]     snapshot + export (read-only on hosted), verify, restore, strict preflight
//   node scripts/db/backup-run.mjs run   --backup-dir ~/bai-backups/g1-<UTC>      pack -> wrap key -> upload -> download -> decrypt -> evidence (idempotent: PASS is a no-op)
//   node scripts/db/backup-run.mjs check --backup-dir ~/bai-backups/g1-<UTC>      re-verify the evidence from the files (exit 0 only if recovery is still verified and fresh)
//   node scripts/db/backup-run.mjs setup-check                                    storage, key and tools; writes nothing
//   node scripts/db/backup-run.mjs selftest                                       the whole off-site path on a tiny synthetic directory (no database, no backup)
//   node scripts/db/backup-run.mjs recover --archive <f.tar.zst.gpg> --key <f.key.pgp> --out <new dir> [--gnupg-home <home with YOUR private key>]   owner-side
//
// Settings (flags override environment override ~/.config/bai-backup/config.json): remote, recipient_fingerprint, gnupg_home (a keyring with the owner's PUBLIC key
// only), rclone_config (mode 600), rclone_bin. Hosted is only READ, and only by `capture`. Nothing here applies a migration or authorizes one.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { NAME_RE, Rclone, keyring, recordPaths, recover, renderReport, runOffsite, scrub, stampNow, verifyRecord } from './lib/offsite-auto.mjs'
import { MAX_BACKUP_AGE_MS } from './lib/final-parity.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const [cmd, ...argv] = process.argv.slice(2)
const opt = (k, d = null) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d }
const die = (m, code = 1) => { console.error(m); process.exit(code) }
const HOME = os.homedir()
let cfg = {}
try { cfg = JSON.parse(fs.readFileSync(opt('config', path.join(HOME, '.config/bai-backup/config.json')), 'utf8')) } catch { /* optional */ }
const setting = (flag, envName, key, d = null) => opt(flag) ?? process.env[envName] ?? cfg[key] ?? d
const settings = () => ({
  remote: setting('remote', 'BAI_BACKUP_REMOTE', 'remote'),
  fingerprint: setting('recipient-fingerprint', 'BAI_BACKUP_RECIPIENT', 'recipient_fingerprint'),
  gnupgHome: setting('gnupg-home', 'BAI_BACKUP_GNUPGHOME', 'gnupg_home', path.join(HOME, '.config/bai-backup/gnupg')),
  rcloneConfig: setting('rclone-config', 'BAI_RCLONE_CONFIG', 'rclone_config', path.join(HOME, '.config/bai-backup/rclone.conf')),
  rcloneBin: setting('rclone-bin', 'BAI_RCLONE', 'rclone_bin', 'rclone')
})
const need = (s) => { if (!s.remote) die('no remote configured: set --remote "name:path" (or BAI_BACKUP_REMOTE / config.json)', 2); if (!s.fingerprint) die('no owner key configured: set --recipient-fingerprint (40 hex characters of the owner\'s PUBLIC key)', 2) }
const log = (m) => console.log(m)
const mkRclone = (s, sub = '') => new Rclone({ bin: s.rcloneBin, config: s.rcloneConfig, remote: sub ? `${s.remote.replace(/\/+$/, '')}/${sub}` : s.remote })

function offsite (backupDir, s, kind = 'backup') {
  need(s)
  const out = runOffsite({ backupDir, rclone: mkRclone(s, kind === 'selftest' ? 'selftest' : ''), gnupgHome: s.gnupgHome, fingerprint: s.fingerprint, kind, log })
  const f = out.files
  if (out.result === 'PASS') {
    console.log('\n' + (out.alreadyVerified ? 'ALREADY VERIFIED (no work was repeated; evidence re-checked)\n' : '') + fs.readFileSync(f.report, 'utf8'))
    console.log(`record  ${f.record}\nrecord SHA-256  ${out.record.record_sha256}\narchive SHA-256 ${out.record.archive.sha256}\ntree SHA-256    ${out.record.backup.tree_sha256}`)
    if (kind === 'backup') console.log(`\nNext (not done by this command): the owner's backup-specific authorization, then final-parity with --offsite-sha256 ${out.record.archive.sha256} --offsite-tree ${out.record.backup.tree_sha256}`)
    return 0
  }
  console.error('\n' + renderReport(out.record, out.problems)); console.error(`kept for inspection: ${out.record.quarantined_in}`)
  return 1
}

if (cmd === 'run') {
  const dir = opt('backup-dir'); if (!dir) die('usage: run --backup-dir <dir>', 2)
  process.exit(offsite(dir, settings()))
} else if (cmd === 'check') {
  const dir = opt('backup-dir'); const rec = opt('record') ?? (dir ? recordPaths(path.dirname(path.resolve(dir)), path.basename(path.resolve(dir))).record : null)
  if (!rec) die('usage: check --backup-dir <dir> | --record <file>', 2)
  const p = verifyRecord(rec)
  if (p.length) { console.error(`NOT VERIFIED\n  ${p.join('\n  ')}`); process.exit(1) }
  const r = JSON.parse(fs.readFileSync(rec, 'utf8')); console.log(`VERIFIED  ${r.backup.name}  archive ${r.archive.sha256}  tree ${r.backup.tree_sha256}  eligible until ${r.backup.eligible_until}`)
} else if (cmd === 'setup-check') {
  const s = settings(); const problems = []
  for (const t of ['gpg', 'tar', 'zstd', 'sha256sum', s.rcloneBin]) if (spawnSync('sh', ['-c', `command -v ${t}`]).status !== 0) problems.push(`missing tool: ${t}`)
  problems.push(...Rclone.checkConfig(s.rcloneConfig))
  if (s.fingerprint) { const kr = keyring(s.gnupgHome, s.fingerprint); problems.push(...kr.problems) } else problems.push('no owner key fingerprint configured')
  if (!s.remote) problems.push('no remote configured')
  else if (!problems.some((p) => /rclone/.test(p))) { try { mkRclone(s).list(''); log(`remote ${s.remote} is reachable`) } catch (e) { problems.push(scrub(e.message)) } }
  if (problems.length) { console.error(`SETUP INCOMPLETE\n  ${problems.join('\n  ')}`); process.exit(1) }
  log('SETUP OK: tools present, rclone config is private, only the owner\'s public key is on this host, the remote answers')
} else if (cmd === 'selftest') {
  const s = settings(); need(s)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-selftest-')); const dir = path.join(root, `selftest-${stampNow()}`); fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, 'a.bin'), crypto.randomBytes(4096)); fs.writeFileSync(path.join(dir, 'b.txt'), 'synthetic self-test content\n')
  const code = offsite(dir, s, 'selftest'); log(code === 0 ? 'SELFTEST PASS: the storage, the key wrap, the download and the decryption all work end to end' : 'SELFTEST FAIL'); log(`(synthetic data kept in ${root}; the remote objects are under ${s.remote}/selftest)`); process.exit(code)
} else if (cmd === 'recover') {
  const archive = opt('archive'); const key = opt('key'); const out = opt('out'); if (!archive || !key || !out) die('usage: recover --archive <f.tar.zst.gpg> --key <f.key.pgp> --out <new dir> [--gnupg-home <home>] [--expect-tree <hex>]', 2)
  try { const tree = recover({ archive: path.resolve(archive), keyFile: path.resolve(key), outDir: path.resolve(out), gnupgHome: opt('gnupg-home'), expectTree: opt('expect-tree') }); log(`RECOVERED into ${out}; content-tree ${tree}`) } catch (e) { die(`RECOVERY FAILED: ${scrub(e.message)}`) }
} else if (cmd === 'capture' || cmd === 'all') {
  const root = path.resolve(opt('root', path.join(HOME, 'bai-backups')))
  let level = opt('expect-level'); const gateFile = opt('gate')
  if (gateFile) { const g = JSON.parse(fs.readFileSync(gateFile, 'utf8')); level = level ?? g.from_level }
  if (!/^\d{3}$/.test(level ?? '')) die('capture needs --expect-level <NNN> (or --gate <gate.json>, whose starting level is used)', 2)
  const name = `g1-${stampNow()}`; const dir = path.join(root, name)
  const logDir = path.resolve(opt('log-dir', path.join(HOME, 'bai-backup-logs', name)))
  if (!NAME_RE.test(name) || fs.existsSync(dir)) die(`refusing: ${dir} exists`, 2)
  fs.mkdirSync(dir, { mode: 0o700, recursive: true }); fs.mkdirSync(logDir, { mode: 0o700, recursive: true })
  const local = process.env.BAI_CAPTURE_ALLOW_LOCAL === '1'
  const step = (n, file, args, env = {}) => {
    const r = spawnSync(file, args, { cwd: path.resolve(here, '../..'), encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 1 << 26 })
    const out = scrub((r.stdout ?? '') + (r.stderr ?? '')); fs.writeFileSync(path.join(logDir, `${n}.log`), out, { mode: 0o600 })
    log(`${r.status === 0 ? 'PASS' : 'FAIL'} ${n}: ${out.trim().split('\n').slice(-1)[0].slice(0, 160)}`)
    if (r.status !== 0) { console.error(`CAPTURE STOPPED at ${n}; logs in ${logDir}; the partial backup ${dir} is kept, unused`); process.exit(1) }
  }
  log(`backup ${name}  T0 ${new Date().toISOString()}  (six-hour eligibility ends ${new Date(Date.now() + MAX_BACKUP_AGE_MS).toISOString()})`)
  if (gateFile) step('gate-offline', process.execPath, ['scripts/db/gate.mjs', 'check', '--gate', path.resolve(gateFile), '--offline'])
  step('snapshot', process.execPath, ['scripts/db/bench/snapshot-hosted.mjs', '--out', path.join(dir, 'snapshot'), ...(local ? ['--allow-local'] : [])])
  const exporter = local && process.env.BAI_EXPORT_SCRIPT ? process.env.BAI_EXPORT_SCRIPT : path.resolve(here, 'logical-export.sh')
  step('export', 'bash', [exporter, path.join(dir, 'export')])
  step('verify-snapshot', process.execPath, ['scripts/db/verify-snapshot.mjs', path.join(dir, 'snapshot')])
  step('restore-check', process.execPath, ['scripts/db/restore-check.mjs', '--backup-dir', dir, '--expect-level', level, '--log-dir', path.join(logDir, 'restore'), ...(local && process.env.BAI_EXPORT_SCRIPT ? ['--no-export-check'] : [])])
  step('hosted-preflight', process.execPath, ['scripts/db/hosted-preflight.mjs', '--snapshot-dir', path.join(dir, 'snapshot'), '--expect-level', level])
  log(`CAPTURE OK: ${dir}  (logs ${logDir})`)
  if (cmd === 'all') process.exit(offsite(dir, settings()))
} else die('usage: backup-run.mjs all|capture|run|check|setup-check|selftest|recover (see the header of this file)', 2)
