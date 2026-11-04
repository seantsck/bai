// Offline validation of the owner-signing-key pin of the hosted promotion runner against DISPOSABLE keys and a NON-PRODUCTION authorization fixture. Nothing here touches the owner's real keys,
// a database or any network. The structure mirrors what the owner is asked to make: a certify-only primary key with a dedicated Ed25519 signing subkey (the pin) plus other subkeys that must NOT
// be accepted. Then the shipped pin itself is checked structurally (40 hex, a signing subkey, not the primary, not the backup-encryption key).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { AUTHORIZATION_FORMAT, OWNER_SIGNING_FINGERPRINTS, verifyAuthorization, verifyDetachedSignature } from '../../scripts/db/lib/promotion-authorization.mjs'

const REF = 'dbnmktidheefoxaztivm'; const MANIFEST = 'a'.repeat(64)
let tmp, sec, pub, other, P, SUB_A, SUB_B, ENC, EXP, n = 0
const old = () => path.join(tmp, 'old')
const gpg = (home, args, extra = {}, input) => { const r = spawnSync('gpg', ['--batch', '--no-tty', '--pinentry-mode', 'loopback', '--passphrase', '', ...args], { encoding: 'utf8', input, env: { PATH: process.env.PATH, HOME: process.env.HOME, GNUPGHOME: home, LANG: 'C', ...extra } }); return r }
const ok = (r) => { assert.equal(r.status, 0, r.stderr); return r.stdout }
const colons = (home) => ok(gpg(home, ['--with-colons', '--fixed-list-mode', '--list-keys']))
const subkeys = (home) => { const out = []; let cur = null; for (const l of colons(home).split('\n')) { const f = l.split(':'); if (f[0] === 'sub') cur = { caps: f[11], algo: f[3], expires: f[6] }; else if (f[0] === 'fpr' && cur) { out.push({ ...cur, fpr: f[9] }); cur = null } } return out }
const mkAuth = (op = 'withdraw', over = {}) => {
  const now = Date.now(); const a = { format: AUTHORIZATION_FORMAT, operation: op, project_ref: REF, manifest_sha256: MANIFEST, not_before: new Date(now - 60e3).toISOString(), expires_at: new Date(now + 3600e3).toISOString(), nonce: crypto.randomBytes(16).toString('hex'), after_attempt: null, reason: 'pin test', ...over }
  const f = path.join(tmp, `a-${++n}.json`); fs.writeFileSync(f, JSON.stringify(a, null, 1)); return f
}
const signWith = (file, fpr, home = sec, extra = [], env = {}) => ok(gpg(home, ['--yes', '--local-user', `${fpr}!`, ...extra, '--detach-sign', '--output', `${file}.sig`, file], env))
const check = (file, o = {}) => verifyAuthorization(file, { operation: 'withdraw', projectRef: REF, manifest: MANIFEST, keyring: pub, pinned: [SUB_A], ...o })

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-pin-')); sec = path.join(tmp, 'sec'); pub = path.join(tmp, 'pub'); other = path.join(tmp, 'other')
  for (const d of [sec, pub, other]) fs.mkdirSync(d, { mode: 0o700 })
  ok(gpg(sec, ['--quick-generate-key', 'Pin Test Primary', 'ed25519', 'cert', 'never'])); P = /^fpr:::::::::([0-9A-F]{40}):/m.exec(colons(sec))[1]
  ok(gpg(sec, ['--quick-add-key', P, 'ed25519', 'sign', 'never'])); ok(gpg(sec, ['--quick-add-key', P, 'ed25519', 'sign', 'never'])); ok(gpg(sec, ['--quick-add-key', P, 'cv25519', 'encr', 'never']))
  const subs = subkeys(sec); const signers = subs.filter((s) => s.caps.includes('s')); assert.equal(signers.length, 2); SUB_A = signers[0].fpr; SUB_B = signers[1].fpr; ENC = subs.find((s) => s.caps.includes('e') && !s.caps.includes('s')).fpr
  const pubFile = path.join(tmp, 'owner.pub')
  // a key that was made and used with a faked clock in 2024 and was valid for one day only: it has long expired
  const oldHome = old(); fs.mkdirSync(oldHome, { mode: 0o700 }); ok(gpg(oldHome, ['--faked-system-time', '20240101T000000', '--quick-generate-key', 'Expired Test Key', 'ed25519', 'sign', '1d'])); EXP = /^fpr:::::::::([0-9A-F]{40}):/m.exec(colons(oldHome))[1]
  const oldPub = path.join(tmp, 'old.pub'); ok(gpg(oldHome, ['--export', '--output', oldPub])); ok(gpg(pub, ['--import', oldPub]))
  ok(gpg(sec, ['--export', '--output', pubFile])); ok(gpg(pub, ['--import', pubFile]))
})
after(() => { for (const h of [sec, pub, other, old()]) spawnSync('gpgconf', ['--kill', 'gpg-agent'], { env: { PATH: process.env.PATH, HOME: process.env.HOME, GNUPGHOME: h } }); fs.rmSync(tmp, { recursive: true, force: true }) })

test('GnuPG identifies the precise signing subkey: the pinned subkey is accepted and reported as the signer; the primary is certify-only and the encryption subkey cannot sign', () => {
  const f = mkAuth(); signWith(f, SUB_A)
  const v = verifyAuthorization(f, { operation: 'withdraw', projectRef: REF, manifest: MANIFEST, keyring: pub, pinned: [SUB_A] })
  assert.deepEqual(v.problems, []); assert.equal(v.signature.fingerprint, SUB_A); assert.equal(v.signature.primary, P); assert.notEqual(SUB_A, P)
  const primaryCaps = colons(sec).split('\n').find((l) => l.startsWith('pub:')).split(':')[11]; assert.ok(!primaryCaps.includes('s'), `the primary key does not sign (${primaryCaps})`)
  const bad = mkAuth(); assert.notEqual(gpg(sec, ['--yes', '--local-user', `${ENC}!`, '--detach-sign', '--output', `${bad}.sig`, bad]).status, 0, 'an encryption subkey cannot sign')
})

test('a signature by an UNPINNED subkey of the same primary key is rejected (the pin names the subkey, not the whole key); pinning the primary would accept every subkey', () => {
  const f = mkAuth(); signWith(f, SUB_B)
  assert.match(check(f).problems.join(), /not one of the keys pinned/)
  assert.deepEqual(check(f, { pinned: [P] }).problems, [], 'documented trade-off: pinning the primary fingerprint trusts all its signing subkeys, which is why the pin is the subkey')
  assert.deepEqual(check(f, { pinned: [SUB_B] }).problems, [])
})

test('a signature by a different key, a tampered file, a missing signature and a missing public key are all rejected', () => {
  const f = mkAuth(); signWith(f, SUB_A); fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('pin test', 'pin tesT')); assert.match(check(f).problems.join(), /not a good signature|no valid signature/)
  const g = mkAuth(); assert.match(check(g).problems.join(), /signature file .* missing|missing or unreadable/)
  ok(gpg(other, ['--quick-generate-key', 'Someone Else', 'ed25519', 'sign', 'never'])); const of = /^fpr:::::::::([0-9A-F]{40}):/m.exec(colons(other))[1]
  const h = mkAuth(); signWith(h, of, other); assert.match(check(h).problems.join(), /not a good signature|no valid signature|not one of the keys pinned/, 'a key that is not in the verification keyring at all (NO_PUBKEY); the imported-but-unpinned case is the sibling-subkey test')
  const empty = path.join(tmp, 'empty'); fs.mkdirSync(empty, { mode: 0o700 }); const k = mkAuth(); signWith(k, SUB_A)
  assert.match(check(k, { keyring: empty }).problems.join(), /not a good signature|no valid signature/, 'no public key in the verification keyring')
  assert.match(check(k, { keyring: path.join(tmp, 'absent') }).problems.join(), /does not exist/)
})

test('an expired key and an expired signature are rejected', () => {
  assert.ok(EXP, 'the expired signing subkey exists in the fixture')
  const f = mkAuth(); ok(gpg(old(), ['--yes', '--faked-system-time', '20240101T120000', '--local-user', `${EXP}!`, '--detach-sign', '--output', `${f}.sig`, f]))
  assert.match(check(f, { pinned: [EXP] }).problems.join(), /not a good signature|no valid signature/, 'a subkey whose validity ended is refused even when pinned')
  const g = mkAuth(); ok(gpg(sec, ['--yes', '--default-sig-expire', 'seconds=1', '--local-user', `${SUB_A}!`, '--detach-sign', '--output', `${g}.sig`, g])); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2500)   // the signature's own validity (one second) has ended
  assert.match(check(g).problems.join(), /not a good signature|no valid signature/, 'a signature whose own validity ended is refused')
})

test('a keyring that contains any private key is rejected; wrong operation, project, manifest and a consumed authorization are rejected', () => {
  const f = mkAuth(); signWith(f, SUB_A)
  assert.match(check(f, { keyring: sec }).problems.join(), /holds a SECRET key/)
  assert.match(check(f, { operation: 'finish' }).problems.join(), /is for "withdraw", not "finish"/)
  assert.match(check(f, { projectRef: 'b'.repeat(20) }).problems.join(), /another project/)
  assert.match(check(f, { manifest: 'c'.repeat(64) }).problems.join(), /another manifest/)
  const sha = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
  assert.match(check(f, { isConsumed: (x) => x === sha }).problems.join(), /already used/)
  assert.deepEqual(check(f).problems, [], 'control: unchanged inputs verify')
})

test('the shipped pin: exactly one 40-hex upper-case fingerprint that is a signing subkey (not the primary, not the backup-encryption key)', () => {
  assert.equal(OWNER_SIGNING_FINGERPRINTS.length, 1, 'exactly one pinned signing key')
  const [pin] = OWNER_SIGNING_FINGERPRINTS; assert.match(pin, /^[0-9A-F]{40}$/)
  assert.notEqual(pin, '47AB7918CDED25B47AE056C5E204499803387355', 'not the owner\'s existing certify/encrypt primary key')
  assert.notEqual(pin, '6458A33EDC92FA39C9A008327E21FB694F673D79', 'not the backup-encryption subkey')
  assert.ok(Object.isFrozen(OWNER_SIGNING_FINGERPRINTS))
})
