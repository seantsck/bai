// Outer-packet validation of the encrypted backup (scripts/db/lib/openpgp-outer.mjs, used by scripts/db/backup-offsite.sh).
// Regression: `gpg --list-packets` DECRYPTS when it can (a cached passphrase in gpg-agent, or a known session key) and then prints the inner literal packet, which the
// old check took for plaintext. The new check reads only the outer headers. Negative-security: everything that is not exactly [SKESK v4 AES-256 iterated+salted,
// SEIPD v1] is refused. SYNTHETIC data and throwaway passphrases only; a private GNUPGHOME.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { inspectBuffer, parseOuterPackets, OuterPacketError } from '../../scripts/db/lib/openpgp-outer.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const have = (t) => spawnSync('sh', ['-c', `command -v ${t}`]).status === 0
const skipGpg = !['gpg', 'tar', 'zstd', 'sha256sum'].every(have) && 'gpg, tar, zstd and sha256sum are needed'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-outer-'))
const GNUPGHOME = path.join(tmp, 'gnupg'); fs.mkdirSync(GNUPGHOME, { mode: 0o700 })
const env = { PATH: process.env.PATH, HOME: process.env.HOME, GNUPGHOME, LANG: 'C.UTF-8' }
const PF = path.join(tmp, 'pf'); fs.writeFileSync(PF, 'throwaway passphrase, never a real one', { mode: 0o600 })

// ---- packet builders
const lenNew = (n) => (n < 192 ? Buffer.from([n]) : n < 8384 ? Buffer.from([((n - 192) >> 8) + 192, (n - 192) & 255]) : Buffer.from([255, (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]))
const newPkt = (tag, body) => Buffer.concat([Buffer.from([0xc0 | tag]), lenNew(body.length), body])
const oldPkt = (tag, body) => (body.length < 256 ? Buffer.concat([Buffer.from([0x80 | (tag << 2), body.length]), body]) : Buffer.concat([Buffer.from([0x80 | (tag << 2) | 1, body.length >> 8, body.length & 255]), body]))
const oldIndeterminate = (tag, body) => Buffer.concat([Buffer.from([0x80 | (tag << 2) | 3]), body])
const partialPkt = (tag, body, chunk = 512) => { const parts = [Buffer.from([0xc0 | tag])]; let o = 0; while (body.length - o > chunk) { parts.push(Buffer.from([224 + Math.log2(chunk)]), body.subarray(o, o + chunk)); o += chunk } parts.push(lenNew(body.length - o), body.subarray(o)); return Buffer.concat(parts) }
const skesk = ({ version = 4, cipher = 9, s2k = 3, hash = 10, count = 255 } = {}) => Buffer.concat([Buffer.from([version, cipher, s2k, hash]), Buffer.alloc(8, 7), Buffer.from([count])])
const seipd = ({ version = 1, size = 3000 } = {}) => Buffer.concat([Buffer.from([version]), Buffer.alloc(size, 0x5a)])
const ok = (buf) => inspectBuffer(buf)
const refused = (buf, re) => assert.throws(() => inspectBuffer(buf), (e) => e instanceof OuterPacketError && re.test(e.message), `${re} for ${buf.subarray(0, 12).toString('hex')}`)

test('accepts exactly [SKESK v4 AES-256 iterated+salted, SEIPD v1] in every packet format GnuPG can write', () => {
  const a = ok(Buffer.concat([oldPkt(3, skesk()), newPkt(18, seipd())]))
  assert.deepEqual([a.tags, a.cipher, a.s2k.type, a.s2k.hash, a.s2k.count, a.integrity], [[3, 18], 'AES-256', 'iterated+salted', 'SHA512', 65011712, 'MDC (SEIPD v1)'])
  assert.deepEqual(ok(Buffer.concat([newPkt(3, skesk()), partialPkt(18, seipd({ size: 5000 }))])).formats, ['new', 'new/partial'])
  assert.deepEqual(ok(Buffer.concat([oldPkt(3, skesk()), newPkt(18, seipd({ size: 70000 }))])).formats, ['old', 'new'], 'a 5-byte length for a large body')
  // old-format packets carry only 4-bit tags, so tag 18 can never be old-format; an old-format indeterminate length runs to the end of the file
  const ind = parseOuterPackets((o, n) => Buffer.concat([oldPkt(3, skesk()), oldIndeterminate(11, Buffer.alloc(100))]).subarray(o, o + n), oldPkt(3, skesk()).length + 1 + 100)
  assert.deepEqual(ind.map((q) => q.tag), [3, 11]); assert.equal(ind[1].bodyLen, 100)
  assert.equal(ok(Buffer.concat([oldPkt(3, skesk({ count: 100 })), newPkt(18, seipd())])).s2k.count, (16 + (100 & 15)) << ((100 >> 4) + 6), 'the iteration count is decoded')
  assert.equal(ok(Buffer.concat([oldPkt(3, skesk()), partialPkt(18, seipd({ size: 100000 }), 8192)])).tags.join(), '3,18', 'GnuPG streams with 8192-byte partial chunks')
})

test('refuses every other outer structure, with the reason', () => {
  const S = oldPkt(3, skesk()); const D = newPkt(18, seipd())
  refused(Buffer.concat([S]), /only \d+ bytes/); refused(Buffer.concat([D]), /only \d+ bytes|outer packets are \[18\]/)
  refused(Buffer.concat([D, S]), /outer packets are \[18, 3\]/); refused(Buffer.concat([S, D, D]), /outer packets are \[3, 18, 18\]/); refused(Buffer.concat([S, S, D]), /outer packets are \[3, 3, 18\]/)
  refused(Buffer.concat([S, D, newPkt(11, Buffer.alloc(100))]), /unexpected outer packet.*11 literal data/); refused(Buffer.concat([S, newPkt(11, Buffer.alloc(3000))]), /unexpected outer packet.*11 literal data/)
  refused(Buffer.concat([S, newPkt(9, Buffer.alloc(3000))]), /unexpected outer packet.*9 symmetrically encrypted data \(no integrity/)
  refused(Buffer.concat([newPkt(1, Buffer.alloc(300)), D]), /unexpected outer packet.*1 public-key encrypted/)
  refused(Buffer.concat([newPkt(8, Buffer.alloc(3000))]), /unexpected outer packet.*8 compressed/); refused(Buffer.concat([newPkt(2, Buffer.alloc(300)), newPkt(11, Buffer.alloc(3000))]), /unexpected outer packet.*(2 signature|11)/)
  refused(Buffer.concat([newPkt(4, Buffer.alloc(13)), newPkt(11, Buffer.alloc(3000)), newPkt(2, Buffer.alloc(300))]), /unexpected outer packet/); refused(Buffer.concat([S, newPkt(20, Buffer.alloc(3000))]), /unexpected outer packet.*20 AEAD/)
  // the session-key packet
  refused(Buffer.concat([oldPkt(3, skesk({ version: 5 })), D]), /version 5, expected 4/); refused(Buffer.concat([oldPkt(3, skesk({ cipher: 7 })), D]), /cipher is AES-128, not AES-256/)
  refused(Buffer.concat([oldPkt(3, skesk({ cipher: 2 })), D]), /3DES, not AES-256/); refused(Buffer.concat([oldPkt(3, skesk({ cipher: 13 })), D]), /Camellia-256, not AES-256/)
  refused(Buffer.concat([oldPkt(3, skesk({ cipher: 0 })), D]), /algorithm 0, not AES-256/); refused(Buffer.concat([oldPkt(3, skesk({ s2k: 0 })), D]), /S2K type 0/); refused(Buffer.concat([oldPkt(3, skesk({ s2k: 1 })), D]), /S2K type 1/)
  refused(Buffer.concat([oldPkt(3, Buffer.from([4, 9, 3])), D]), /too short/); refused(Buffer.concat([oldPkt(3, Buffer.from([4, 9])), D]), /too short to name/)
  // the data packet
  refused(Buffer.concat([S, newPkt(18, seipd({ version: 2 }))]), /version 2, expected 1/); refused(Buffer.concat([S, newPkt(18, seipd({ version: 0 }))]), /version 0, expected 1/); refused(Buffer.concat([S, newPkt(18, seipd({ size: 30 }))]), /too short to be a real archive/)
})

test('refuses damaged, truncated, extended, armored and non-OpenPGP files', () => {
  const good = Buffer.concat([oldPkt(3, skesk()), partialPkt(18, seipd({ size: 20000 }), 1024)])
  assert.equal(ok(good).tags.join(), '3,18')
  refused(good.subarray(0, good.length - 1), /truncated|past the end/); refused(good.subarray(0, good.length - 700), /truncated|past the end/); refused(good.subarray(0, 20), /only \d+ bytes/); refused(good.subarray(0, 60), /truncated|past the end/)
  refused(Buffer.concat([good, Buffer.from([0])]), /data follows the last packet|not an OpenPGP packet header/); refused(Buffer.concat([good, good]), /outer packets are \[3, 18, 3, 18\]/)
  const bad = Buffer.from(good); bad[0] = 0x0c; refused(bad, /not an OpenPGP packet header/)
  refused(Buffer.from('-----BEGIN PGP MESSAGE-----\n\nhQEMA...\n-----END PGP MESSAGE-----\n'.repeat(3)), /ASCII-armored/)
  for (const plain of [Buffer.alloc(0), Buffer.from('{"slug":"x"}\n'.repeat(50)), Buffer.from('PK\x03\x04'.padEnd(500, 'z')), Buffer.concat([Buffer.from('ustar'), Buffer.alloc(600)]), Buffer.from('\x28\xb5\x2f\xfd'.padEnd(500, 'z'), 'latin1'), Buffer.alloc(2000, 0xff), Buffer.alloc(100, 0x41)]) {
    assert.throws(() => inspectBuffer(plain), OuterPacketError)
  }
  // random bytes never pass
  let seed = 1; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed & 255 }
  for (let i = 0; i < 300; i++) assert.throws(() => inspectBuffer(Buffer.from(Array.from({ length: 64 + (i % 200) }, rnd))), OuterPacketError)
  assert.throws(() => parseOuterPackets((o, n) => good.subarray(o, o + n), good.length - 5), OuterPacketError)
})

const gpg = (args, input) => spawnSync('gpg', ['--batch', '--yes', '--pinentry-mode', 'loopback', '--passphrase-file', PF, ...args], { env, input, encoding: 'buffer' })
const SAMPLE = Buffer.from('{"slug":"outer-marker-7788"}\n'.repeat(2000))

test('real GnuPG output: the backup pipeline and plain symmetric AES-256 are accepted; AES-128, 3DES, simple/salted S2K, public-key, signed, stored and armored output are refused', { skip: skipGpg }, () => {
  const trySym = (extra, input = SAMPLE) => { const r = gpg(['--symmetric', '--compress-algo', 'none', ...extra, '-o', '-'], input); return r.status === 0 && r.stdout.length ? r.stdout : null }
  const sym = (extra) => { const out = trySym(extra); assert.ok(out, `gpg could not create ${extra.join(' ')}`); return out }
  assert.deepEqual(ok(sym(['--cipher-algo', 'AES256', '--s2k-mode', '3'])).tags, [3, 18])                                  // streamed from stdin: partial lengths
  const f = path.join(tmp, 'sample.bin'); fs.writeFileSync(f, SAMPLE)
  const viaFile = gpg(['--symmetric', '--cipher-algo', 'AES256', '--compress-algo', 'none', '-o', path.join(tmp, 'file-in.gpg'), f]); assert.equal(viaFile.status, 0, viaFile.stderr.toString())
  assert.equal(ok(fs.readFileSync(path.join(tmp, 'file-in.gpg'))).cipher, 'AES-256')
  // weaker variants: refused whenever this GnuPG will write them at all (modern GnuPG may refuse some itself)
  let weak = 0
  for (const [extra, re] of [[['--cipher-algo', 'AES128'], /AES-128, not AES-256/], [['--cipher-algo', 'AES192'], /AES-192, not AES-256/], [['--cipher-algo', '3DES'], /3DES, not AES-256/], [['--cipher-algo', 'AES256', '--s2k-mode', '1'], /S2K type 1/], [['--cipher-algo', 'AES256', '--s2k-mode', '0'], /S2K type 0/]]) {
    const out = trySym(extra); if (out) { weak++; refused(out, re) }
  }
  assert.ok(weak >= 2, `at least AES-128 and AES-192 variants were created and refused (${weak})`)
  const armored = gpg(['--armor', '--symmetric', '--cipher-algo', 'AES256', '-o', '-'], SAMPLE); assert.equal(armored.status, 0, armored.stderr.toString()); refused(armored.stdout, /ASCII-armored/)
  // public-key encrypted, signed, stored (literal only)
  const key = spawnSync('gpg', ['--batch', '--pinentry-mode', 'loopback', '--passphrase', 'x', '--quick-generate-key', 'Outer Test <o@example.test>', 'default', 'default', 'never'], { env, encoding: 'utf8' }); assert.equal(key.status, 0, key.stderr)
  refused(gpg(['--encrypt', '--trust-model', 'always', '-r', 'o@example.test', '-o', '-'], SAMPLE).stdout, /unexpected outer packet.*1 public-key encrypted/)
  refused(spawnSync('gpg', ['--batch', '--yes', '--pinentry-mode', 'loopback', '--passphrase', 'x', '--sign', '-o', '-'], { env, input: SAMPLE }).stdout, /unexpected outer packet/)
  refused(gpg(['--store', '-o', '-'], SAMPLE).stdout, /unexpected outer packet\(s\): (8 compressed|11 literal)/)
})

test('REGRESSION: when gpg can decrypt, --list-packets prints the inner literal packet (the old false positive); the outer check does not care and accepts the archive', { skip: skipGpg }, () => {
  // the production pipeline, byte for byte: tar | zstd | gpg symmetric AES-256
  const src = path.join(tmp, 'sample'); fs.mkdirSync(src); fs.writeFileSync(path.join(src, 'public.players.ndjson'), SAMPLE); fs.writeFileSync(path.join(src, 'incompressible.bin'), crypto.randomBytes(200000))   // like a real backup, it does not shrink, so GnuPG streams it with partial lengths
  spawnSync('sh', ['-c', 'sha256sum public.players.ndjson > SHA256SUMS'], { cwd: src })
  const enc = path.join(tmp, 'archive.tar.zst.gpg')
  const packed = spawnSync('bash', ['scripts/db/backup-pack.sh', 'pack', src, enc, '--passphrase-file', PF], { cwd: root, env, encoding: 'utf8' }); assert.equal(packed.status, 0, packed.stderr)
  const summary = ok(fs.readFileSync(enc)); assert.deepEqual(summary.tags, [3, 18]); assert.deepEqual(summary.formats, ['old', 'new/partial'], 'the shape of the real rehearsal archive: an old-format session-key packet, a new-format partial-length data packet')
  // give gpg the session key (what a warm agent effectively does): it now decrypts and lists the INNER packets
  const sk = gpg(['--decrypt', '--show-session-key', '-o', '/dev/null', enc]); const m = /session key: '([0-9]:[0-9A-F]+)'/.exec(sk.stderr.toString()); assert.ok(m, sk.stderr.toString())
  const listed = spawnSync('gpg', ['--batch', '--list-packets', '--override-session-key', m[1], enc], { env, encoding: 'utf8' }).stdout
  assert.match(listed, /:literal data packet:/, 'the old check\'s trigger: an inner literal packet is visible')
  assert.match(listed, /:symkey enc packet:/); assert.match(listed, /:encrypted data packet:/)
  assert.equal(ok(fs.readFileSync(enc)).tags.join(), '3,18', 'the new check is unaffected')
  // the same file through the real command, with a warm GNUPGHOME and with none at all
  const prep = spawnSync('bash', ['scripts/db/backup-offsite.sh', 'prepare', enc], { cwd: root, env, encoding: 'utf8' }); assert.equal(prep.status, 0, prep.stderr + prep.stdout); assert.match(prep.stdout, /ready to transfer/)
  const cold = spawnSync('bash', ['scripts/db/backup-offsite.sh', 'prepare', enc], { cwd: root, env: { ...env, GNUPGHOME: path.join(tmp, 'does-not-exist') }, encoding: 'utf8' }); assert.equal(cold.status, 0, cold.stderr)
  // the validator needs no gpg, no agent, no PATH at all
  const bare = spawnSync(process.execPath, [path.join(root, 'scripts/db/lib/openpgp-outer.mjs'), enc], { env: { PATH: '' }, encoding: 'utf8' }); assert.equal(bare.status, 0, bare.stderr); assert.equal(JSON.parse(bare.stdout).cipher, 'AES-256')
  // and the scripts no longer ask gpg to list packets at all (it decrypts, and can prompt)
  for (const f of ['scripts/db/backup-offsite.sh', 'scripts/db/backup-pack.sh']) assert.ok(!/list-packets/.test(fs.readFileSync(path.join(root, f), 'utf8').replace(/^\s*#.*$/gm, '')), f)
})

test('the command refuses every wrong kind of file with exit 2 and a reason, and prepare never reads a passphrase', { skip: skipGpg }, () => {
  const mk = (name, buf) => { const f = path.join(tmp, name); fs.writeFileSync(f, buf); fs.writeFileSync(`${f}.sha256`, require_sha(buf)); fs.writeFileSync(`${f}.tree-sha256`, 'a'.repeat(64)); return f }
  const require_sha = (b) => spawnSync('sha256sum', { input: b, encoding: 'utf8' }).stdout.split(' ')[0]
  const S = oldPkt(3, skesk()); const D = newPkt(18, seipd())
  const cases = { 'plain.tar.zst.gpg': Buffer.from('ustar'.padEnd(2000, 'x')), 'ndjson.tar.zst.gpg': SAMPLE, 'cipher128.tar.zst.gpg': Buffer.concat([oldPkt(3, skesk({ cipher: 7 })), D]), 'literal.tar.zst.gpg': Buffer.concat([S, newPkt(11, Buffer.alloc(3000))]),
    'extra.tar.zst.gpg': Buffer.concat([S, D, D]), 'trailing.tar.zst.gpg': Buffer.concat([S, D, Buffer.from('x')]), 'armor.tar.zst.gpg': Buffer.from('-----BEGIN PGP MESSAGE-----\n'.padEnd(500, 'x')) }
  for (const [name, buf] of Object.entries(cases)) {
    const r = spawnSync('bash', ['scripts/db/backup-offsite.sh', 'prepare', mk(name, buf)], { cwd: root, env, encoding: 'utf8', input: '' })
    assert.equal(r.status, 2, `${name}: ${r.stdout}${r.stderr}`); assert.match(r.stderr, /not an OpenPGP symmetric-encrypted file made by backup-pack\.sh \(/, name)
    assert.doesNotMatch(r.stderr + r.stdout, /passphrase|pinentry|agent/i, 'it never mentions or asks for a passphrase')
  }
  const good = mk('good.tar.zst.gpg', Buffer.concat([S, D])); const okRun = spawnSync('bash', ['scripts/db/backup-offsite.sh', 'prepare', good], { cwd: root, env, encoding: 'utf8', input: '' }); assert.equal(okRun.status, 0, okRun.stderr)
  fs.rmSync(tmp, { recursive: true, force: true })
})
