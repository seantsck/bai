// The encrypted-backup procedure (scripts/db/backup-pack.sh): GnuPG symmetric AES-256 over tar + zstd, tested end to end on SYNTHETIC data with a throwaway
// passphrase in a private GNUPGHOME. No real backup, credential or network is involved.
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-pack-'))
const env = { PATH: process.env.PATH, HOME: process.env.HOME, GNUPGHOME: path.join(tmp, 'gnupg'), LANG: 'C.UTF-8' }
fs.mkdirSync(env.GNUPGHOME, { mode: 0o700 })
const pw = (name, text) => { const f = path.join(tmp, name); fs.writeFileSync(f, text, { mode: 0o600 }); return f }
const run = (...a) => spawnSync('bash', ['scripts/db/backup-pack.sh', ...a], { cwd: root, encoding: 'utf8', env })

test('pack, verify and unpack round-trip; the ciphertext holds no plaintext; a wrong passphrase, a tampered file and an overwrite are refused', { skip }, () => {
  const src = path.join(tmp, 'sample'); fs.mkdirSync(src)
  fs.writeFileSync(path.join(src, 'public.players.ndjson'), '{"slug":"a-distinctive-marker-9d3c"}\n'.repeat(500))
  fs.writeFileSync(path.join(src, 'manifest.json'), '{"ok":true}\n')
  spawnSync('sh', ['-c', 'sha256sum public.players.ndjson manifest.json > SHA256SUMS'], { cwd: src })
  const good = pw('good', 'throwaway passphrase, not a secret'); const bad = pw('bad', 'another')
  const enc = path.join(tmp, 'backup.tar.zst.gpg')
  const packed = run('pack', src, enc, '--passphrase-file', good)
  assert.equal(packed.status, 0, packed.stderr); assert.match(packed.stdout, /file SHA-256 : [0-9a-f]{64}/)
  assert.ok(!fs.readFileSync(enc).includes('a-distinctive-marker-9d3c'), 'no plaintext in the encrypted file')
  assert.ok(fs.existsSync(`${enc}.sha256`) && fs.existsSync(`${enc}.tree-sha256`))
  assert.equal(run('pack', src, enc, '--passphrase-file', good).status, 2, 'never overwrites')
  const v = run('verify', enc, src, '--passphrase-file', good); assert.equal(v.status, 0, v.stderr); assert.match(v.stdout, /verified: decrypts, content hash matches/)
  const out = path.join(tmp, 'restored'); const u = run('unpack', enc, out, '--passphrase-file', good); assert.equal(u.status, 0, u.stderr)
  assert.equal(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'), '{"ok":true}\n')
  assert.notEqual(run('unpack', enc, path.join(tmp, 'out-bad'), '--passphrase-file', bad).status, 0, 'a wrong passphrase does not decrypt')
  const t = path.join(tmp, 'tampered.gpg'); fs.copyFileSync(enc, t); fs.copyFileSync(`${enc}.sha256`, `${t}.sha256`)
  const buf = fs.readFileSync(t); buf[buf.length >> 1] ^= 0xff; fs.writeFileSync(t, buf)
  const tp = run('unpack', t, path.join(tmp, 'out-t'), '--passphrase-file', good); assert.equal(tp.status, 1); assert.match(tp.stderr, /does not match its recorded SHA-256/)
  assert.notEqual(run('unpack', enc, out, '--passphrase-file', good).status, 0, 'unpack refuses a non-empty directory')
  fs.rmSync(tmp, { recursive: true, force: true })
})
