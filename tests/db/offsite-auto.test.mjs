// The automated off-site workflow (scripts/db/backup-run.mjs, lib/offsite-auto.mjs) against a FAKE rclone (a local directory standing in for Google Drive), a
// disposable PostgreSQL for real snapshots, and throwaway GnuPG keyrings: nothing here reaches hosted, a real storage account or a real backup.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as h from './harness.mjs'
import { applyMigrations } from '../../scripts/db/lib/migrations.mjs'
import { takeSnapshot } from '../../scripts/db/lib/snapshot.mjs'
import * as fp from '../../scripts/db/lib/final-parity.mjs'
import * as oa from '../../scripts/db/lib/offsite-auto.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const have = (t) => spawnSync('sh', ['-c', `command -v ${t}`]).status === 0
const skip = !['gpg', 'tar', 'zstd', 'sha256sum', 'node'].every(have) && 'gpg, tar, zstd and sha256sum are needed'
const exporter = path.join(root, 'tests/db/fixtures/local-export.sh')
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')
let tmp, db, env, ownerHome, hostHome, fpr, rcConf, fakeBin, n = 0
const gpg = (home, ...a) => spawnSync('gpg', ['--batch', '--homedir', home, ...a], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8' } })

before(async () => {
  await h.startServer()
  tmp = fs.mkdtempSync('/tmp/bai-oa-')
  process.env.GNUPGHOME = path.join(tmp, 'sym'); fs.mkdirSync(process.env.GNUPGHOME, { mode: 0o700 })   // the keyring symmetric packing uses
  ownerHome = path.join(tmp, 'owner'); hostHome = path.join(tmp, 'host'); fs.mkdirSync(ownerHome, { mode: 0o700 }); fs.mkdirSync(hostHome, { mode: 0o700 })
  let r = gpg(ownerHome, '--passphrase', '', '--pinentry-mode', 'loopback', '--quick-generate-key', 'BAI test owner <owner@example.test>', 'ed25519', 'cert', 'never'); assert.equal(r.status, 0, r.stderr)
  fpr = gpg(ownerHome, '--list-keys', '--with-colons').stdout.split('\n').find((l) => l.startsWith('fpr:')).split(':')[9]
  r = gpg(ownerHome, '--passphrase', '', '--pinentry-mode', 'loopback', '--quick-add-key', fpr, 'cv25519', 'encr', 'never'); assert.equal(r.status, 0, r.stderr)
  const pub = gpg(ownerHome, '--export', fpr).stdout; r = spawnSync('gpg', ['--batch', '--homedir', hostHome, '--import'], { input: Buffer.from(pub, 'latin1'), env: { PATH: process.env.PATH, HOME: process.env.HOME } })
  // (binary export through a string would be lossy; re-export as a file)
  fs.writeFileSync(path.join(tmp, 'owner.pub'), spawnSync('gpg', ['--batch', '--homedir', ownerHome, '--export', fpr], { env: { PATH: process.env.PATH, HOME: process.env.HOME } }).stdout)
  r = gpg(hostHome, '--import', path.join(tmp, 'owner.pub')); assert.equal(r.status, 0, r.stderr)
  rcConf = path.join(tmp, 'rclone.conf'); fs.writeFileSync(rcConf, '[fake]\ntype = local\n', { mode: 0o600 })
  fakeBin = path.join(tmp, 'rclone'); fs.copyFileSync(path.join(root, 'tests/db/fixtures/fake-rclone.mjs'), fakeBin); fs.chmodSync(fakeBin, 0o755)
  db = await h.freshDatabase({ migrate: false }); await applyMigrations(db, { through: '027' })
  const { port, database } = db.connectionParameters
  env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: os.tmpdir(), BAI_DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${port}/${database}` }
  await db.query("insert into players (slug, full_name, display_name) values ('oa-1', 'Offsite One', 'Offsite One')")
}, { timeout: 180000 })
after(async () => {
  for (const home of [process.env.GNUPGHOME, ownerHome, hostHome, path.join(tmp, 'other')]) if (home) spawnSync('gpgconf', ['--homedir', home, '--kill', 'gpg-agent'])
  await h.stopServer(); fs.rmSync(tmp, { recursive: true, force: true })
})

/** a real backup directory <holder>/g1-<UTC> (snapshot + export) of the disposable database */
async function backup (ageMs = 0) {
  const holder = path.join(tmp, `h${++n}`); fs.mkdirSync(holder)
  const dir = path.join(holder, `g1-${stamp(Date.now() - ageMs)}`)
  await takeSnapshot(db, path.join(dir, 'snapshot'))
  const r = spawnSync('bash', [exporter, path.join(dir, 'export')], { encoding: 'utf8', env }); assert.equal(r.status, 0, r.stderr)
  return dir
}
/** a fake remote of its own, with a call log and failure injection through `inject` */
function remote (inject = {}) {
  const base = path.join(tmp, `remote${++n}`); fs.mkdirSync(base)
  const rc = new oa.Rclone({ bin: fakeBin, config: rcConf, remote: 'fake:bk', env: { RCLONE_FAKE_RCLONE_ROOT: base, RCLONE_FAKE_RCLONE_LOG: path.join(base, '.calls'), ...inject } })
  const calls = () => (fs.existsSync(path.join(base, '.calls')) ? fs.readFileSync(path.join(base, '.calls'), 'utf8').trim().split('\n') : [])
  return { rc, base, calls, objects: () => (fs.existsSync(path.join(base, 'bk')) ? fs.readdirSync(path.join(base, 'bk'), { recursive: true }).filter((f) => fs.statSync(path.join(base, 'bk', f)).isFile()) : []) }
}
const go = (dir, rc, extra = {}) => oa.runOffsite({ backupDir: dir, rclone: rc, gnupgHome: hostHome, fingerprint: fpr, ...extra })
const sessionDirs = () => [...new Set([process.env.XDG_RUNTIME_DIR, '/dev/shm', os.tmpdir()].filter(Boolean))].flatMap((b) => { try { return fs.readdirSync(b).filter((x) => x.startsWith('bai-session-')) } catch { return [] } })
const siblings = (dir) => fs.readdirSync(path.dirname(dir)).sort()

test('PASS: pack, wrap, upload, independent download, decrypt, evidence; the record re-verifies and the evidence passes the protocol-v2 final-parity check', { skip }, async () => {
  const dir = await backup(); const rm = remote(); const before = sessionDirs().length
  const out = go(dir, rm.rc); assert.equal(out.result, 'PASS', JSON.stringify(out.problems))
  const f = oa.recordPaths(path.dirname(dir), path.basename(dir)); const rec = JSON.parse(fs.readFileSync(f.record, 'utf8'))
  assert.deepEqual(rec.steps.map((s) => s.name), ['backup', 'pack', 'wrap', 'upload', 'download', 'decrypt', 'evidence']); assert.ok(rec.steps.every((s) => s.ok))
  assert.equal(rec.record_sha256, oa.recordHash(rec)); assert.deepEqual(oa.verifyRecord(f.record), []); assert.equal(rec.remote.md5_checked, true)
  assert.equal(rec.archive.sha256, sha(fs.readFileSync(f.archive)))
  // the independent copy really came from the remote, and the remote holds exactly the four objects of this attempt
  assert.equal(rm.objects().length, 4);   assert.equal(rm.calls().filter((c) => /^copyto --no-traverse fake:/.test(c)).length, 4, 'four downloads from the remote')
  assert.ok(rm.calls().filter((c) => c.startsWith('copyto') && c.includes('--immutable')).length === 4, 'uploads are immutable (never overwrite)')
  assert.deepEqual(fp.verifyOffsiteEvidence(dir, rec.archive.sha256, rec.backup.tree_sha256), [], 'exactly what final-parity checks')
  assert.equal(fs.statSync(f.record).mode & 0o777, 0o600); assert.match(fs.readFileSync(f.report, 'utf8'), /PASS/)
  assert.equal(fp.verifyBackupDir(dir).length, 0); assert.deepEqual(fs.readdirSync(dir).sort(), ['export', 'snapshot'], 'nothing was written into the backup directory')
  // key custody: the wrapped key is not openable on this host, the session key is gone, and the owner's private key recovers the backup
  assert.equal(sessionDirs().length, before, 'the session-key directory was removed')
  const hostTry = spawnSync('gpg', ['--batch', '--homedir', hostHome, '--decrypt', f.key], { encoding: 'utf8' }); assert.notEqual(hostTry.status, 0, 'the host cannot unwrap the key')
  const dl = path.join(tmp, `rec${++n}`)
  const tree = oa.recover({ archive: f.archive, keyFile: f.key, outDir: dl, gnupgHome: ownerHome, expectTree: rec.backup.tree_sha256 }); assert.equal(tree, rec.backup.tree_sha256)
  assert.equal(fp.contentTreeHash(dl), fp.contentTreeHash(dir))
  // the archive is not decryptable by the session passphrase alone being absent: no file in the evidence holds a passphrase
  for (const x of [f.record, f.report]) assert.doesNotMatch(fs.readFileSync(x, 'utf8'), /pass(word|phrase)|BEGIN PGP|ya29/i)
})

test('idempotent: a second run is a no-op that re-checks the evidence; a damaged PASS record is never overwritten', { skip }, async () => {
  const dir = await backup(); const rm = remote(); assert.equal(go(dir, rm.rc).result, 'PASS')
  const f = oa.recordPaths(path.dirname(dir), path.basename(dir)); const callsBefore = rm.calls().length; const recBefore = fs.readFileSync(f.record, 'utf8')
  const again = go(dir, rm.rc); assert.equal(again.result, 'PASS'); assert.equal(again.alreadyVerified, true); assert.equal(rm.calls().length, callsBefore, 'no storage call was repeated'); assert.equal(fs.readFileSync(f.record, 'utf8'), recBefore)
  fs.appendFileSync(f.archive, 'x')   // the evidence no longer matches
  assert.throws(() => go(dir, rm.rc), /no longer verifies/); assert.equal(fs.readFileSync(f.record, 'utf8'), recBefore)
})

const failing = [
  ['a failed upload', { RCLONE_FAKE_FAIL_UPLOAD: 'tar.zst.gpg.tree' }, 'upload', /upload of .* failed/],
  ['a truncated upload (size differs)', { RCLONE_FAKE_TRUNC: '.key.pgp' }, 'upload', /remote reports \d+ bytes/],
  ['a provider checksum that differs', { RCLONE_FAKE_WRONG_MD5: '1' }, 'upload', /provider's MD5 differs/],
  ['an object missing from the remote listing after upload', { RCLONE_FAKE_HIDE: '.key.pgp' }, 'upload', /not in the remote listing/],
  ['a failed download', { RCLONE_FAKE_FAIL_DOWNLOAD: '.tar.zst.gpg' }, 'download', /download of .* failed/],
  ['a download that reports success and writes nothing (missing archive)', { RCLONE_FAKE_NO_DOWNLOAD: 'g1-' }, 'download', /wrote no file/],
  ['a corrupted download', { RCLONE_FAKE_CORRUPT: '.tar.zst.gpg' }, 'download', /differ from the original/]
]
for (const [what, inject, atStep, re] of failing) {
  test(`FAIL closed on ${what}: no PASS, no returned copy, the attempt is kept, no secret in the output`, { skip }, async () => {
    const dir = await backup(); const rm = remote(inject); const before = sessionDirs().length
    const out = go(dir, rm.rc); assert.equal(out.result, 'FAIL', 'never a success'); assert.equal(out.record.steps.at(-1).name, atStep); assert.match(out.problems.join(' '), re)
    const f = oa.recordPaths(path.dirname(dir), path.basename(dir))
    for (const p of [f.record, f.archive, f.key, f.returnedDir]) assert.ok(!fs.existsSync(p), `${path.basename(p)} must not exist after a failure`)
    const q = out.record.quarantined_in; assert.ok(fs.existsSync(path.join(q, 'attempt-record.json')) && fs.existsSync(path.join(q, 'WHY.txt')), 'evidence of the failed attempt is kept')
    assert.equal(sessionDirs().length, before, 'the session key was removed even though the run failed')
    assert.deepEqual(fs.readdirSync(dir).sort(), ['export', 'snapshot'])
    assert.doesNotMatch(JSON.stringify(out) + fs.readFileSync(path.join(q, 'report.txt'), 'utf8'), /ya29|FAKE-SECRET/, 'tokens in the storage tool\'s error output are scrubbed')
    assert.ok(fp.verifyOffsiteEvidence(dir, sha('x'), sha('y')).length > 0, 'final-parity cannot use a failed attempt')
  })
}

test('FAIL closed when the archive passes every outer check (size, provider MD5, identical download) but cannot be decrypted with the session key', { skip }, async () => {
  const dir = await backup(); const rm = remote({ RCLONE_FAKE_SWAP_ARCHIVE: '1' }); const before = sessionDirs().length
  const out = go(dir, rm.rc); assert.equal(out.result, 'FAIL'); assert.deepEqual(out.record.steps.filter((s) => s.ok).map((s) => s.name), ['backup', 'pack', 'wrap', 'upload', 'download'], 'the outer checks all passed')
  assert.equal(out.record.steps.at(-1).name, 'decrypt'); assert.match(out.problems.join(' '), /decrypt/i)
  const f = oa.recordPaths(path.dirname(dir), path.basename(dir))
  for (const p of [f.record, f.archive, f.key, f.returnedDir]) assert.ok(!fs.existsSync(p), `${path.basename(p)} must not exist after a failure`)
  assert.ok(fs.existsSync(path.join(out.record.quarantined_in, 'WHY.txt')), 'the failed attempt is kept'); assert.equal(sessionDirs().length, before)
  assert.ok(fp.verifyOffsiteEvidence(dir, sha('x'), sha('y')).length > 0)
})

test('FAIL closed when the archive decrypts but its content is not the backup directory (internal verification)', { skip }, async () => {
  const dir = await backup(); const rm = remote({ RCLONE_FAKE_MUTATE_DIR: dir })
  const out = go(dir, rm.rc); assert.equal(out.result, 'FAIL'); assert.equal(out.record.steps.at(-1).name, 'decrypt')
  const f = oa.recordPaths(path.dirname(dir), path.basename(dir)); for (const p of [f.record, f.returnedDir]) assert.ok(!fs.existsSync(p))
  assert.ok(fs.existsSync(path.join(out.record.quarantined_in, 'WHY.txt')))
})

test('a retry after a failure succeeds in a NEW remote attempt; the failed attempt and its remote objects are kept, nothing is overwritten', { skip }, async () => {
  const dir = await backup(); const rm = remote({ RCLONE_FAKE_FAIL_UPLOAD: 'tree-sha256' })
  const first = go(dir, rm.rc, { now: Date.now() }); assert.equal(first.result, 'FAIL'); const leftovers = rm.objects().length; assert.ok(leftovers > 0, 'a partial upload exists remotely')
  delete rm.rc.env.RCLONE_FAKE_FAIL_UPLOAD
  const second = go(dir, rm.rc, { now: Date.now() + 2000 }); assert.equal(second.result, 'PASS', JSON.stringify(second.problems))
  assert.equal(rm.objects().length, leftovers + 4, 'the retry added a full new attempt and removed nothing')
  assert.equal(fs.readdirSync(path.dirname(dir)).filter((x) => x.includes('.failed-')).length, 1)
  assert.deepEqual(oa.verifyRecord(oa.recordPaths(path.dirname(dir), path.basename(dir)).record), [])
})

test('refuses before anything is transferred: expired or damaged backup, a secret key on the host, a wrong or missing owner key, a world-readable storage config', { skip }, async () => {
  const noTransfer = (rm) => assert.equal(rm.calls().filter((c) => c.startsWith('copyto')).length, 0, 'no upload was attempted')
  // expired: seven hours old
  let rm = remote(); let out = go(await backup(7 * 3600e3), rm.rc); assert.equal(out.result, 'FAIL'); assert.match(out.problems.join(), /7\.\d hours old; the maximum is 6/); noTransfer(rm)
  // damaged snapshot
  const bad = await backup(); fs.appendFileSync(path.join(bad, 'snapshot/public.players.ndjson'), '{"x":1}\n'); rm = remote(); out = go(bad, rm.rc); assert.equal(out.result, 'FAIL'); assert.match(out.problems.join(), /snapshot/); noTransfer(rm)
  // the host must not hold the private key
  rm = remote(); out = oa.runOffsite({ backupDir: await backup(), rclone: rm.rc, gnupgHome: ownerHome, fingerprint: fpr }); assert.equal(out.result, 'FAIL'); assert.match(out.problems.join(), /SECRET key/); noTransfer(rm)
  // wrong fingerprint, malformed fingerprint
  rm = remote(); out = oa.runOffsite({ backupDir: await backup(), rclone: rm.rc, gnupgHome: hostHome, fingerprint: 'A'.repeat(40) }); assert.equal(out.result, 'FAIL'); assert.match(out.problems.join(), /no public key/); noTransfer(rm)
  out = oa.runOffsite({ backupDir: await backup(), rclone: rm.rc, gnupgHome: hostHome, fingerprint: 'zz' }); assert.equal(out.result, 'FAIL'); assert.match(out.problems.join(), /40 hex/)
  // storage config readable by others
  const open = path.join(tmp, 'open.conf'); fs.writeFileSync(open, '[fake]\n', { mode: 0o644 }); rm = remote(); rm.rc.config = open
  out = go(await backup(), rm.rc); assert.equal(out.result, 'FAIL'); assert.match(out.problems.join(), /mode 600/); noTransfer(rm)
  // a directory that is not a backup
  out = go(path.join(tmp, 'not-a-backup'), remote().rc); void out
}, { timeout: 120000 })

test('the record is re-derived from the files: any change to the evidence, or an old backup, no longer verifies', { skip }, async () => {
  const dir = await backup(); assert.equal(go(dir, remote().rc).result, 'PASS')
  const f = oa.recordPaths(path.dirname(dir), path.basename(dir)); const orig = fs.readFileSync(f.record, 'utf8')
  const set = (mut) => { const r = JSON.parse(orig); mut(r); fs.writeFileSync(f.record, JSON.stringify(r)); return oa.verifyRecord(f.record) }
  assert.match(set((r) => { r.result = 'FAIL' })[0], /altered/)
  assert.match(set((r) => { r.archive.sha256 = 'a'.repeat(64); r.record_sha256 = oa.recordHash(r) }).join(), /differs from the verified one|not byte-identical/)
  assert.match(set((r) => { r.steps = r.steps.filter((s) => s.name !== 'download'); r.record_sha256 = oa.recordHash(r) }).join(), /step "download"/)
  fs.writeFileSync(f.record, orig); assert.deepEqual(oa.verifyRecord(f.record), [])
  assert.match(oa.verifyRecord(f.record, { now: Date.now() + 7 * 3600e3 }).join(), /hours old; the maximum is 6/)
  const ret = path.join(f.returnedDir, `${path.basename(dir)}.tar.zst.gpg`); const b = fs.readFileSync(ret); fs.writeFileSync(ret, Buffer.concat([b.subarray(0, -1), Buffer.from([b.at(-1) ^ 1])]))
  assert.match(oa.verifyRecord(f.record).join(), /not byte-identical/); fs.writeFileSync(ret, b)
  fs.appendFileSync(path.join(dir, 'export/extra.txt'), 'x'); assert.match(oa.verifyRecord(f.record).join(), /changed since the verification/); fs.rmSync(path.join(dir, 'export/extra.txt'))
  fs.renameSync(f.key, f.key + '.x'); assert.match(oa.verifyRecord(f.record).join(), /wrapped session key is missing/); fs.renameSync(f.key + '.x', f.key)
  assert.deepEqual(oa.verifyRecord(f.record), [])
})

test('recovery needs the owner\'s private key: a different key cannot open the wrapped session key', { skip }, async () => {
  const dir = await backup(); assert.equal(go(dir, remote().rc).result, 'PASS'); const f = oa.recordPaths(path.dirname(dir), path.basename(dir))
  const other = path.join(tmp, 'other'); fs.mkdirSync(other, { mode: 0o700 })
  const r = gpg(other, '--passphrase', '', '--pinentry-mode', 'loopback', '--quick-generate-key', 'Someone else <x@example.test>', 'ed25519', 'cert', 'never'); assert.equal(r.status, 0)
  assert.throws(() => oa.recover({ archive: f.archive, keyFile: f.key, outDir: path.join(tmp, `nope${++n}`), gnupgHome: other }), /could not be unwrapped/)
  // the right key but a wrong expected hash is refused as well
  assert.throws(() => oa.recover({ archive: f.archive, keyFile: f.key, outDir: path.join(tmp, `nope${++n}`), gnupgHome: ownerHome, expectTree: 'f'.repeat(64) }), /does not match the expected tree hash/)
})

test('secrets are scrubbed from anything printed or recorded', () => {
  const t = oa.scrub(`token ya29.A0ARrdaM-abc_DEF and "refresh_token": "1//0gXYZ_abcdefghijklmnop" ${['postgresql', '://u:pw@h/db'].join('')} password=hunter2 client_secret: GOCSPX-abc123 S3cretSessionKey`, ['S3cretSessionKey'])
  assert.doesNotMatch(t, /ya29|1\/\/0g|pw@|hunter2|GOCSPX|S3cretSessionKey/)
})

test('CLI: setup-check, run, check, selftest and a second run, with settings from the environment', { skip }, async () => {
  const dir = await backup(); const rm = remote()
  const cenv = { PATH: process.env.PATH, HOME: tmp, GNUPGHOME: process.env.GNUPGHOME, BAI_BACKUP_REMOTE: 'fake:bk', BAI_BACKUP_RECIPIENT: fpr, BAI_BACKUP_GNUPGHOME: hostHome, BAI_RCLONE_CONFIG: rcConf, BAI_RCLONE: fakeBin, ...rm.rc.env }
  const cli = (...a) => spawnSync(process.execPath, ['scripts/db/backup-run.mjs', ...a], { cwd: root, encoding: 'utf8', env: cenv })
  let r = cli('setup-check'); assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /SETUP OK/)
  r = cli('run', '--backup-dir', dir); assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /off-site backup verification: PASS/); assert.match(r.stdout, /archive SHA-256 [0-9a-f]{64}/)
  r = cli('check', '--backup-dir', dir); assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /VERIFIED/)
  r = cli('run', '--backup-dir', dir); assert.equal(r.status, 0); assert.match(r.stdout, /ALREADY VERIFIED/)
  r = cli('selftest'); assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /SELFTEST PASS/)
  const bad = spawnSync(process.execPath, ['scripts/db/backup-run.mjs', 'setup-check'], { cwd: root, encoding: 'utf8', env: { ...cenv, BAI_RCLONE_CONFIG: path.join(tmp, 'missing.conf') } }); assert.equal(bad.status, 1); assert.match(bad.stderr, /SETUP INCOMPLETE/)
  const failRun = spawnSync(process.execPath, ['scripts/db/backup-run.mjs', 'run', '--backup-dir', await backup()], { cwd: root, encoding: 'utf8', env: { ...cenv, RCLONE_FAKE_FAIL_UPLOAD: '1' } })
  assert.equal(failRun.status, 1); assert.match(failRun.stderr, /NOT verified/); assert.doesNotMatch(failRun.stdout + failRun.stderr, /ya29/)
}, { timeout: 180000 })

test('CLI: capture (read-only snapshot + export, verified, restored into a disposable database, strict preflight) and `all`, against a LOCAL stand-in', { skip }, async () => {
  const rm = remote(); const out = path.join(tmp, 'capture-root'); fs.mkdirSync(out)
  const cenv = { ...env, GNUPGHOME: process.env.GNUPGHOME, BAI_CAPTURE_ALLOW_LOCAL: '1', BAI_EXPORT_SCRIPT: exporter, BAI_BACKUP_REMOTE: 'fake:bk', BAI_BACKUP_RECIPIENT: fpr, BAI_BACKUP_GNUPGHOME: hostHome, BAI_RCLONE_CONFIG: rcConf, BAI_RCLONE: fakeBin, ...rm.rc.env }
  const r = spawnSync(process.execPath, ['scripts/db/backup-run.mjs', 'all', '--root', out, '--expect-level', '027', '--log-dir', path.join(tmp, 'capture-logs')], { cwd: root, encoding: 'utf8', env: cenv })
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /CAPTURE OK/); assert.match(r.stdout, /off-site backup verification: PASS/)
  const dirs = fs.readdirSync(out).filter((x) => /^g1-\d{8}T\d{6}Z$/.test(x)); assert.equal(dirs.length, 1); assert.deepEqual(fs.readdirSync(path.join(out, dirs[0])).sort(), ['export', 'snapshot'], 'logs are outside the backup directory')
  assert.ok(fs.readdirSync(path.join(tmp, 'capture-logs')).includes('restore-check.log'))
  assert.deepEqual(oa.verifyRecord(oa.recordPaths(out, dirs[0]).record), [])
  // capture refuses without a level, and a hosted run without the local override never reaches the snapshot of a local database
  const noLevel = spawnSync(process.execPath, ['scripts/db/backup-run.mjs', 'capture', '--root', out, '--log-dir', path.join(tmp, 'x-logs')], { cwd: root, encoding: 'utf8', env: cenv }); assert.equal(noLevel.status, 2)
  const hostedGuard = spawnSync(process.execPath, ['scripts/db/backup-run.mjs', 'capture', '--root', out, '--expect-level', '027', '--log-dir', path.join(tmp, 'guard-logs')], { cwd: root, encoding: 'utf8', env: { ...cenv, BAI_CAPTURE_ALLOW_LOCAL: '' } }); assert.equal(hostedGuard.status, 1); assert.match(hostedGuard.stdout + hostedGuard.stderr, /CAPTURE STOPPED at snapshot/)
  assert.match(fs.readFileSync(path.join(tmp, 'guard-logs/snapshot.log'), 'utf8'), /point this at the hosted/, 'a local database is refused as a capture source unless the test override is set')
}, { timeout: 300000 })
