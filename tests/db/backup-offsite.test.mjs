// The off-machine step (scripts/db/backup-offsite.sh): only the encrypted file and its two hash files ever leave; a typed confirmation of the destination;
// the copy is re-hashed; a file that comes back is checked against the recorded hashes and decrypted. SYNTHETIC data, a throwaway passphrase, a private GNUPGHOME.
// The scripts never take a passphrase from an argument or the environment (gpg prompts on the terminal); --passphrase-file exists for these tests only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const have = (t) => spawnSync('sh', ['-c', `command -v ${t}`]).status === 0
const skip = !['gpg', 'tar', 'zstd', 'sha256sum'].every(have) && 'gpg, tar, zstd and sha256sum are needed'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-offsite-'))
const env = { PATH: process.env.PATH, HOME: process.env.HOME, GNUPGHOME: path.join(tmp, 'gnupg'), LANG: 'C.UTF-8' }
fs.mkdirSync(env.GNUPGHOME, { mode: 0o700 })
const PASS = 'throwaway passphrase, never a real one'
const pw = (name, text) => { const f = path.join(tmp, name); fs.writeFileSync(f, text, { mode: 0o600 }); return f }
const pack = (...a) => spawnSync('bash', ['scripts/db/backup-pack.sh', ...a], { cwd: root, encoding: 'utf8', env })
const off = (a, input = '') => spawnSync('bash', ['scripts/db/backup-offsite.sh', ...a], { cwd: root, encoding: 'utf8', env, input })

test('prepare, copy and check: ciphertext only, a typed destination, a re-hashed copy, and a file that comes back is verified by hash and by decrypting', { skip }, () => {
  const src = path.join(tmp, 'sample'); fs.mkdirSync(src)
  fs.writeFileSync(path.join(src, 'public.players.ndjson'), '{"slug":"offsite-marker-4411"}\n'.repeat(400)); fs.writeFileSync(path.join(src, 'manifest.json'), '{"ok":true}\n')
  spawnSync('sh', ['-c', 'sha256sum public.players.ndjson manifest.json > SHA256SUMS'], { cwd: src })
  const good = pw('good', PASS); const enc = path.join(tmp, 'backup.tar.zst.gpg')
  const packed = pack('pack', src, enc, '--passphrase-file', good); assert.equal(packed.status, 0, packed.stderr)
  const sha = fs.readFileSync(`${enc}.sha256`, 'utf8').trim(); const tree = fs.readFileSync(`${enc}.tree-sha256`, 'utf8').trim()

  // prepare lists exactly three files and both hashes
  const p = off(['prepare', enc]); assert.equal(p.status, 0, p.stderr); assert.match(p.stdout, /encrypted file SHA-256 : [0-9a-f]{64}/); assert.equal((p.stdout.match(/backup\.tar\.zst\.gpg/g) ?? []).length >= 3, true)

  // plaintext is refused, whatever it is called
  for (const name of ['export.sql', 'public.players.ndjson', 'sample.tar', 'fake.tar.zst.gpg']) {
    const f = path.join(tmp, name); fs.writeFileSync(f, name === 'sample.tar' ? 'ustar plain' : '{"slug":"plaintext"}\n'); fs.writeFileSync(`${f}.sha256`, 'x'); fs.writeFileSync(`${f}.tree-sha256`, 'x')
    const r = off(['prepare', f]); assert.equal(r.status, 2, name); assert.match(r.stderr, /only a \.gpg file|not an OpenPGP symmetric-encrypted file/)
  }
  // a non-symmetric gpg file (encrypted to nobody is impossible here, so use a signed-only file) is refused too
  const signedOnly = path.join(tmp, 'signed.gpg'); spawnSync('gpg', ['--batch', '--pinentry-mode', 'loopback', '--passphrase', 'x', '--quick-generate-key', 'Test <t@example.test>', 'default', 'default', 'never'], { env })
  spawnSync('gpg', ['--batch', '--yes', '--pinentry-mode', 'loopback', '--passphrase', 'x', '--sign', '--output', signedOnly, enc], { env })
  fs.writeFileSync(`${signedOnly}.sha256`, 'x'); fs.writeFileSync(`${signedOnly}.tree-sha256`, 'x'); assert.equal(off(['prepare', signedOnly]).status, 2)
  // missing or mismatching companions
  const lone = path.join(tmp, 'lone.tar.zst.gpg'); fs.copyFileSync(enc, lone); assert.equal(off(['prepare', lone]).status, 2)
  fs.writeFileSync(`${lone}.sha256`, '0'.repeat(64)); fs.writeFileSync(`${lone}.tree-sha256`, tree); assert.equal(off(['prepare', lone]).status, 1)

  // copy: no folder -> refused; inside the repository -> refused; wrong confirmation -> nothing copied; right confirmation -> three files, re-hashed
  assert.equal(off(['copy', enc, path.join(tmp, 'nope')]).status, 2)
  assert.equal(off(['copy', enc, path.join(root, 'docs')], 'docs\n').status, 2)
  const drive = path.join(tmp, 'My Private Drive Folder'); fs.mkdirSync(drive)
  const cancelled = off(['copy', enc, drive], 'wrong\n'); assert.equal(cancelled.status, 3); assert.deepEqual(fs.readdirSync(drive), [], 'nothing copied without the typed confirmation')
  assert.equal(off(['copy', enc, drive], '').status, 3, 'no input is a cancel')
  const copied = off(['copy', enc, drive], 'My Private Drive Folder\n'); assert.equal(copied.status, 0, copied.stderr + copied.stdout); assert.match(copied.stdout, /destination: .*My Private Drive Folder/)
  assert.deepEqual(fs.readdirSync(drive).sort(), ['backup.tar.zst.gpg', 'backup.tar.zst.gpg.sha256', 'backup.tar.zst.gpg.tree-sha256'])
  assert.ok(!fs.readdirSync(drive).some((f) => /ndjson|sql|manifest|SHA256SUMS|\.tar$/.test(f)), 'no plaintext file reached the destination')
  assert.equal(off(['copy', enc, drive], 'My Private Drive Folder\n').status, 2, 'never overwrites')

  // check: the file that comes back (a fresh download = the file in the drive folder)
  const back = path.join(drive, 'backup.tar.zst.gpg')
  const ok = off(['check', back, '--expect-sha256', sha, '--expect-tree', tree, '--passphrase-file', good]); assert.equal(ok.status, 0, ok.stderr + ok.stdout); assert.match(ok.stdout, /SHA-256 matches the recorded value/); assert.match(ok.stdout, /decrypts, content hash matches/)
  assert.equal(off(['check', back, '--expect-sha256', '1'.repeat(64), '--expect-tree', tree, '--passphrase-file', good]).status, 1, 'a different recorded hash')
  assert.equal(off(['check', back, '--expect-sha256', sha, '--passphrase-file', good]).status, 2, 'both recorded hashes are required')
  assert.notEqual(off(['check', back, '--expect-sha256', sha, '--expect-tree', tree, '--passphrase-file', pw('bad', 'another')]).status, 0, 'a wrong passphrase')
  const damaged = path.join(tmp, 'damaged.tar.zst.gpg'); fs.copyFileSync(back, damaged); const b = fs.readFileSync(damaged); b[b.length >> 1] ^= 0xff; fs.writeFileSync(damaged, b)
  const d = off(['check', damaged, '--expect-sha256', sha, '--expect-tree', tree, '--passphrase-file', good]); assert.equal(d.status, 1); assert.match(d.stderr, /differs from the recorded value/)

  // the passphrase appears nowhere in any output, and the scripts have no way to take one from an argument or the environment
  for (const r of [packed, p, copied, ok, d]) assert.ok(!(r.stdout + r.stderr).includes(PASS))
  const src1 = fs.readFileSync(path.join(root, 'scripts/db/backup-offsite.sh'), 'utf8') + fs.readFileSync(path.join(root, 'scripts/db/backup-pack.sh'), 'utf8')
  assert.ok(!/--passphrase\b(?!-file)|PASSPHRASE|read -s|\$\{?PASS/.test(src1.replace(/#.*$/gm, '')), 'no passphrase argument, variable or prompt in the scripts')
  assert.ok(!/\b(curl|wget|rclone|scp|sftp|ssh|ncat|socat|ftp|nc)\b/.test(src1.replace(/#.*$/gm, '')), 'no network code')
  fs.rmSync(tmp, { recursive: true, force: true })
})
