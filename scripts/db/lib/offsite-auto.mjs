// Automated, verified OFF-SITE copy of a BAI backup (docs/transactions/offsite-automation.md). One operation: pack -> wrap the session key -> upload -> download an
// independent copy -> decrypt and compare -> evidence. It reuses backup-pack.sh (AES-256 symmetric GnuPG over tar + zstd), openpgp-outer.mjs and the evidence
// layout that scripts/db/final-parity.mjs already checks, so the protocol-v2 gate is unchanged.
//
// KEY CUSTODY (envelope encryption). Every backup gets a fresh random session passphrase S. The archive is encrypted with S (so it is the same file format as
// before); S is also encrypted to the OWNER'S PUBLIC KEY (<name>.key.pgp) and exists unwrapped only in a mode-700 temporary directory for the duration of the run,
// where it is used to decrypt the downloaded copy for the verification, then overwritten and removed. This machine holds only the PUBLIC key (the run refuses
// if a secret key is present in its keyring): whoever steals the database host, the backup directory, the archive, the wrapped key and the Drive token still
// cannot open a backup. Opening one needs the owner's private key (`backup-run.mjs recover`).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { MAX_BACKUP_AGE_MS, backupStartedAt, contentTreeHash, sha256, verifyBackupDir, verifyOffsiteEvidence } from './final-parity.mjs'
import { inspectFile } from './openpgp-outer.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
export const PACK = path.resolve(here, '../backup-pack.sh')
export const REPO_ROOT = path.resolve(here, '../../..')
export const NAME_RE = /^g1-\d{8}T\d{6}Z$/
export const stampNow = (ms = Date.now()) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
export const md5 = (b) => crypto.createHash('md5').update(b).digest('hex')   // only to compare with the storage provider's own checksum

// ---------------------------------------------------------------------------------------------------------------- secrets never reach a log
const SECRET_PATTERNS = [
  /ya29\.[\w-]+/g, /1\/\/[\w-]{20,}/g, /GOCSPX-[\w-]+/g,
  /"?(access_token|refresh_token|client_secret|token)"?\s*[:=]\s*"?[^\s",}]+/gi,
  /postgres(ql)?:\/\/[^\s'"]+/gi,
  /(pass(word|phrase)?|secret)\s*[:=]\s*[^\s'",}]+/gi
]
/** Removes anything that looks like a credential, plus every literal in `known` (the session key, tokens read from a config). */
export function scrub (text, known = []) {
  let t = String(text ?? '')
  for (const k of known) if (k && String(k).length >= 6) t = t.split(String(k)).join('[redacted]')
  for (const re of SECRET_PATTERNS) t = t.replace(re, (m) => (m.includes('=') || m.includes(':') ? m.replace(/[:=]\s*"?.+$/, '=[redacted]') : '[redacted]'))
  return t
}

const ENV_KEEP = ['PATH', 'HOME', 'LANG', 'TMPDIR', 'GNUPGHOME', 'XDG_RUNTIME_DIR']
export function sh (cmd, args, { cwd, env = {}, input } = {}) {
  // rclone's own RCLONE_* variables are passed through (its documented configuration mechanism); nothing else, so no database credential reaches a child by accident
  const base = Object.fromEntries(Object.keys(process.env).filter((k) => ENV_KEEP.includes(k) || /^RCLONE_/.test(k)).map((k) => [k, process.env[k]]))
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', input, env: { ...base, ...env }, maxBuffer: 1 << 26 })
  return { status: r.status ?? 1, out: r.stdout ?? '', err: r.stderr ?? '', error: r.error }
}

// ---------------------------------------------------------------------------------------------------------------- the storage side (rclone)
export class Rclone {
  /** @param {{bin?: string, config: string, remote: string, known?: string[], env?: object}} o  remote = "name:path/in/the/remote" (no trailing slash); env = extra variables for rclone only */
  constructor ({ bin = 'rclone', config, remote, known = [], env = {} }) { Object.assign(this, { bin, config, remote: remote.replace(/\/+$/, ''), known, env }) }
  static checkConfig (config) {
    const p = []
    let st; try { st = fs.statSync(config) } catch { return [`the rclone config ${config} does not exist`] }
    if (!st.isFile()) p.push(`${config} is not a file`)
    if (st.mode & 0o077) p.push(`${config} must be mode 600 (it holds an OAuth token)`)
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) p.push(`${config} must belong to the user running the backup`)
    const abs = path.resolve(config)
    if (abs.startsWith(REPO_ROOT + path.sep)) p.push(`${config} must not be inside the repository`)
    return p
  }
  run (args) {
    const r = sh(this.bin, ['--config', this.config, ...args], { env: this.env })
    if (r.error && r.error.code === 'ENOENT') return { ...r, status: 127, err: `${this.bin} is not installed` }
    return { ...r, err: scrub(r.err, this.known), out: r.out }
  }
  /** Objects directly under remote/dir. A directory that does not exist yet is an empty listing (rclone exit 3). */
  list (dir = '') {
    const r = this.run(['lsjson', '--hash', '--no-modtime', `${this.remote}${dir ? '/' + dir : ''}`])
    if (r.status === 3) return []
    if (r.status !== 0) throw new Error(`rclone lsjson failed (${r.status}): ${r.err.trim().split('\n').slice(-2).join(' | ').slice(0, 300)}`)
    try { return JSON.parse(r.out) } catch { throw new Error('rclone lsjson returned unreadable output') }
  }
  /** Upload one local file to a remote path that must not exist yet. Never overwrites. */
  upload (local, dir, name) {
    const r = this.run(['copyto', '--immutable', '--no-traverse', local, `${this.remote}/${dir}/${name}`])
    if (r.status !== 0) throw new Error(`upload of ${name} failed (${r.status}): ${r.err.trim().split('\n').slice(-2).join(' | ').slice(0, 300)}`)
  }
  /** Download one remote file into a local path that must not exist yet. */
  download (dir, name, local) {
    if (fs.existsSync(local)) throw new Error(`refusing to download over existing ${local}`)
    const r = this.run(['copyto', '--no-traverse', `${this.remote}/${dir}/${name}`, local])
    if (r.status !== 0) throw new Error(`download of ${name} failed (${r.status}): ${r.err.trim().split('\n').slice(-2).join(' | ').slice(0, 300)}`)
    if (!fs.existsSync(local)) throw new Error(`download of ${name} reported success but wrote no file`)
  }
}

// ---------------------------------------------------------------------------------------------------------------- the key side (GnuPG public key only)
export function keyring (gnupgHome, fingerprint) {
  const env = { GNUPGHOME: gnupgHome }
  const fpr = String(fingerprint ?? '').replace(/\s+/g, '').toUpperCase()
  const problems = []
  if (!/^[0-9A-F]{40}$/.test(fpr)) return { problems: ['the recipient fingerprint must be 40 hex characters (the owner\'s public key)'], keyids: [], env, fpr }
  const secret = sh('gpg', ['--batch', '--list-secret-keys', '--with-colons'], { env })
  if (secret.status === 0 && /^(sec|ssb):/m.test(secret.out)) problems.push(`the keyring ${gnupgHome} holds a SECRET key: the backup host must hold only the owner's public key (refusing)`)
  const pub = sh('gpg', ['--batch', '--list-keys', '--with-colons', fpr], { env })
  if (pub.status !== 0) { problems.push(`no public key ${fpr} in ${gnupgHome}`); return { problems, keyids: [], env, fpr } }
  const lines = pub.out.split('\n')
  const fprs = lines.filter((l) => l.startsWith('fpr:')).map((l) => l.split(':')[9])
  if (!fprs.includes(fpr)) problems.push('the keyring does not contain exactly that fingerprint')
  const keyids = lines.filter((l) => /^(pub|sub):/.test(l)).map((l) => l.split(':')[4].toUpperCase())
  // expired / revoked keys cannot receive new data
  for (const l of lines) if (/^(pub|sub):[ier]:/.test(l)) problems.push('the recipient key (or subkey) is expired or revoked')
  return { problems, keyids, env, fpr }
}
export function wrapSessionKey (secretFile, outFile, kr) {
  if (fs.existsSync(outFile)) throw new Error(`refusing to overwrite ${outFile}`)
  const r = sh('gpg', ['--batch', '--yes', '--trust-model', 'always', '--recipient', kr.fpr, '--encrypt', '--output', outFile, secretFile], { env: kr.env })
  if (r.status !== 0 || !fs.existsSync(outFile)) throw new Error(`wrapping the session key failed: ${scrub(r.err).trim().split('\n').slice(-1)[0]}`)
  fs.chmodSync(outFile, 0o600)
}
/** The packet headers only (never decrypts): exactly one public-key-encrypted session-key packet, addressed to one of the owner's key ids. */
export function inspectWrapped (file, keyids) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-lp-'))
  const r = sh('gpg', ['--batch', '--list-packets', file], { env: { GNUPGHOME: home } })
  fs.rmSync(home, { recursive: true, force: true })
  const ids = [...r.out.matchAll(/pubkey enc packet:.*?keyid ([0-9A-F]{16})/gi)].map((m) => m[1].toUpperCase())
  const problems = []
  if (ids.length !== 1) problems.push(`the wrapped key must be addressed to exactly one public key (found ${ids.length})`)
  else if (!keyids.includes(ids[0])) problems.push(`the wrapped key is addressed to ${ids[0]}, not to the owner's key`)
  if (/symkey enc packet/i.test(r.out)) problems.push('the wrapped key also carries a passphrase packet')
  return problems
}

// ---------------------------------------------------------------------------------------------------------------- evidence record
export const RECORD_KIND = 'g1-offsite-verification'
export const recordHash = (rec) => { const { record_sha256, ...rest } = rec; return sha256(JSON.stringify(rest)) }
export function recordPaths (root, name) {
  return {
    record: path.join(root, `${name}.offsite-verification.json`), report: path.join(root, `${name}.offsite-verification.txt`),
    archive: path.join(root, `${name}.tar.zst.gpg`), key: path.join(root, `${name}.key.pgp`), returnedDir: path.join(root, `returned-${name}`)
  }
}
const sha256File = (f) => sha256(fs.readFileSync(f))

/** Re-derives the PASS from the files themselves; the record's own claims are never trusted. Returns problems (empty = recovery verified and still intact). */
export function verifyRecord (recordFile, { now = Date.now(), maxAgeMs = MAX_BACKUP_AGE_MS, requireFresh = true } = {}) {
  let rec; try { rec = JSON.parse(fs.readFileSync(recordFile, 'utf8')) } catch (e) { return [`record unreadable: ${e.message}`] }
  if (rec?.kind !== RECORD_KIND || rec.version !== 1) return ['not a g1-offsite-verification record (version 1)']
  if (rec.record_sha256 !== recordHash(rec)) return ['the record was altered (its own hash does not match)']
  const p = []
  if (rec.result !== 'PASS') p.push('the record is not a PASS')
  const steps = rec.steps ?? []
  for (const s of ['pack', 'wrap', 'upload', 'download', 'decrypt', 'evidence']) if (!steps.some((x) => x.name === s && x.ok === true)) p.push(`step "${s}" is not recorded as passed`)
  const dir = rec.backup?.dir; const name = rec.backup?.name
  const isBackup = (rec.backup?.kind ?? 'backup') === 'backup'
  if (!dir || !(isBackup ? NAME_RE.test(name ?? '') : /^[\w.-]+$/.test(name ?? '')) || path.basename(dir) !== name) return [...p, 'the record names no valid backup']
  const root = path.dirname(dir); const f = recordPaths(root, name)
  const bp = isBackup ? verifyBackupDir(dir) : []; for (const x of bp) p.push(`backup: ${x}`)
  if (!bp.length && contentTreeHash(dir) !== rec.backup.tree_sha256) p.push('the backup directory content changed since the verification')
  if (requireFresh && isBackup) {
    const started = backupStartedAt(dir)
    if (started == null) p.push('the backup start time cannot be determined')
    else if (now - started > maxAgeMs) p.push(`the backup is ${((now - started) / 3600000).toFixed(1)} hours old; the maximum is 6`)
  }
  if (!fs.existsSync(f.archive)) p.push('the encrypted archive is missing')
  else if (sha256File(f.archive) !== rec.archive?.sha256) p.push('the archive differs from the verified one')
  const ret = path.join(f.returnedDir, `${name}.tar.zst.gpg`)
  if (!fs.existsSync(ret)) p.push('the downloaded copy is missing')
  else if (sha256File(ret) !== rec.archive?.sha256) p.push('the downloaded copy is not byte-identical to the verified archive')
  if (!fs.existsSync(f.key)) p.push('the wrapped session key is missing')
  else if (sha256File(f.key) !== rec.key_wrap?.sha256) p.push('the wrapped session key differs from the verified one')
  if (!p.length) for (const x of verifyOffsiteEvidence(dir, rec.archive.sha256, rec.backup.tree_sha256)) p.push(`evidence: ${x}`)
  return p
}

export function renderReport (rec, problems = []) {
  const L = []
  L.push(`BAI off-site backup verification: ${rec.result}`)
  L.push(`backup            ${rec.backup?.name}   (started ${rec.backup?.started_at}; eligible for a push until ${rec.backup?.eligible_until})`)
  L.push(`manifest SHA-256  ${rec.backup?.manifest_sha256}`)
  L.push(`archive SHA-256   ${rec.archive?.sha256}   (${rec.archive?.size} bytes)`)
  L.push(`content-tree      ${rec.backup?.tree_sha256}`)
  L.push(`remote            ${rec.remote?.path}   md5 checked against the provider: ${rec.remote?.md5_checked}`)
  L.push(`wrapped key       ${rec.key_wrap?.file}  -> owner key ${rec.key_wrap?.recipient_fingerprint}`)
  for (const s of rec.steps ?? []) L.push(`  ${s.ok ? 'PASS' : 'FAIL'}  ${s.name}${s.detail ? ' - ' + s.detail : ''}`)
  for (const x of problems) L.push(`  PROBLEM  ${x}`)
  L.push(rec.result === 'PASS'
    ? 'Recovery is verified from an independent off-site download. This is NOT an authorization: the migration still needs the owner\'s backup-specific authorization.'
    : 'NOT verified. Do not rely on this backup off-site; the failed attempt is kept for inspection.')
  return L.join('\n') + '\n'
}

// ---------------------------------------------------------------------------------------------------------------- the pipeline
export const shred = (file) => { try { const n = fs.statSync(file).size; fs.writeFileSync(file, Buffer.alloc(n)); fs.rmSync(file) } catch { /* already gone */ } }
function sessionDir () {
  const bases = [process.env.XDG_RUNTIME_DIR, '/dev/shm', os.tmpdir()].filter((b) => b && fs.existsSync(b))
  const d = fs.mkdtempSync(path.join(bases[0], 'bai-session-')); fs.chmodSync(d, 0o700); return d
}
const move = (from, to) => fs.renameSync(from, to)

/**
 * Packs, wraps, uploads, downloads and verifies one backup directory. Returns { result, record, problems, files }.
 * kind 'backup': a real g1-<UTC> backup (its soundness and age are checked first). kind 'selftest': any directory of files, a distinct name, never usable as evidence.
 */
export function runOffsite ({ backupDir, rclone, gnupgHome, fingerprint, kind = 'backup', now = Date.now(), maxAgeMs = MAX_BACKUP_AGE_MS, log = () => {}, force = false }) {
  const dir = path.resolve(backupDir); const name = path.basename(dir); const root = path.dirname(dir); const f = recordPaths(root, name)
  const stamp = stampNow(now)
  const steps = []; const warnings = []
  const known = []
  const step = (n, detail) => { steps.push({ name: n, ok: true, at: new Date().toISOString(), ...(detail ? { detail } : {}) }); log(`PASS ${n}${detail ? ' - ' + detail : ''}`) }
  const fail = (n, e) => { const msg = scrub(e instanceof Error ? e.message : String(e), known); steps.push({ name: n, ok: false, at: new Date().toISOString(), detail: msg }); log(`FAIL ${n} - ${msg}`); const err = new Error(msg); err.step = n; throw err }
  const attempt = { started: new Date().toISOString() }
  let sdir = null; const created = []
  const quarantine = (why) => {
    const q = path.join(root, `${name}.failed-${stamp}`); fs.mkdirSync(q, { mode: 0o700, recursive: true })
    for (const p of [f.archive, `${f.archive}.sha256`, `${f.archive}.tree-sha256`, f.key, f.returnedDir, `${f.returnedDir}.partial-${process.pid}`]) if (fs.existsSync(p)) move(p, path.join(q, path.basename(p)))
    fs.writeFileSync(path.join(q, 'WHY.txt'), `${why}\n`, { mode: 0o600 })
    return q
  }
  // already verified? then this is a no-op that re-checks the evidence
  if (fs.existsSync(f.record) && !force) {
    const pr = verifyRecord(f.record, { now, maxAgeMs, requireFresh: kind === 'backup' })
    if (!pr.length) return { result: 'PASS', alreadyVerified: true, record: JSON.parse(fs.readFileSync(f.record, 'utf8')), problems: [], files: f }
    throw new Error(`a verification record already exists for ${name} but no longer verifies (${pr.join('; ')}); it is never overwritten`)
  }
  if (fs.existsSync(f.record)) throw new Error(`${f.record} exists; it is never overwritten`)
  let result = 'FAIL'; let record = null; let problems = []
  try {
    // 0. the backup itself, and its age
    let tree, started
    if (kind === 'backup') {
      if (!NAME_RE.test(name)) fail('backup', `the backup directory must be named g1-<UTC> (got ${name})`)
      const bp = verifyBackupDir(dir); if (bp.length) fail('backup', bp.join('; '))
      started = backupStartedAt(dir); if (started == null) fail('backup', 'the backup start time cannot be determined')
      if (now - started > Math.min(maxAgeMs, MAX_BACKUP_AGE_MS)) fail('backup', `the backup is ${((now - started) / 3600000).toFixed(1)} hours old; the maximum is 6 (take a new one)`)
    } else { if (!fs.statSync(dir).isDirectory()) fail('backup', 'not a directory'); started = now }
    tree = contentTreeHash(dir)
    step('backup', kind === 'backup' ? 'snapshot and export verified, within the age limit' : 'self-test directory')
    // anything left by an earlier attempt is set aside (never deleted) so that nothing stale can be mistaken for this attempt
    if (fs.existsSync(f.archive) || fs.existsSync(f.key) || fs.existsSync(f.returnedDir)) { const q = quarantine('leftovers of an earlier unfinished attempt'); log(`earlier leftovers kept in ${q}`) }
    // 1. the key custody preconditions
    const kr = keyring(gnupgHome, fingerprint); if (kr.problems.length) fail('wrap', kr.problems.join('; '))
    const rcfg = Rclone.checkConfig(rclone.config); if (rcfg.length) fail('upload', rcfg.join('; '))
    // 2. the session key and the encrypted archive (the proven backup-pack.sh format)
    sdir = sessionDir(); const sfile = path.join(sdir, 's'); const S = crypto.randomBytes(32).toString('base64url'); known.push(S)
    fs.writeFileSync(sfile, S + '\n', { mode: 0o600 })
    let r = sh('bash', [PACK, 'pack', dir, f.archive, '--passphrase-file', sfile]); created.push(f.archive, `${f.archive}.sha256`, `${f.archive}.tree-sha256`)
    if (r.status !== 0) fail('pack', scrub(r.err, known).trim().split('\n').slice(-1)[0] || 'pack failed')
    try { inspectFile(f.archive) } catch (e) { fail('pack', `the archive is not AES-256 symmetric OpenPGP (${e.message})`) }
    const archSha = sha256File(f.archive); const archSize = fs.statSync(f.archive).size
    if (fs.readFileSync(`${f.archive}.sha256`, 'utf8').trim() !== archSha || fs.readFileSync(`${f.archive}.tree-sha256`, 'utf8').trim() !== tree) fail('pack', 'the companions do not match the archive')
    step('pack', `${archSize} bytes, AES-256 OpenPGP, tree ${tree.slice(0, 12)}…`)
    // 3. the session key, wrapped to the owner's PUBLIC key only
    try { wrapSessionKey(sfile, f.key, kr) } catch (e) { fail('wrap', e) }
    created.push(f.key)
    const wp = inspectWrapped(f.key, kr.keyids); if (wp.length) fail('wrap', wp.join('; '))
    step('wrap', `session key encrypted to ${kr.fpr.slice(-16)}`)
    // 4. upload (a new remote directory per attempt; nothing is ever overwritten) and the provider's own checksums
    const remoteDir = `${name}/attempt-${stamp}`
    const files = [[f.archive, `${name}.tar.zst.gpg`], [`${f.archive}.sha256`, `${name}.tar.zst.gpg.sha256`], [`${f.archive}.tree-sha256`, `${name}.tar.zst.gpg.tree-sha256`], [f.key, `${name}.key.pgp`]]
    let existing; try { existing = rclone.list(remoteDir) } catch (e) { fail('upload', e) }
    if (existing.length) fail('upload', `the remote directory ${remoteDir} is not empty`)
    let md5Checked = true; const objects = []
    for (const [local, remoteName] of files) {
      try { rclone.upload(local, remoteDir, remoteName) } catch (e) { fail('upload', e) }
    }
    let listing; try { listing = rclone.list(remoteDir) } catch (e) { fail('upload', e) }
    for (const [local, remoteName] of files) {
      const o = listing.find((x) => x.Name === remoteName)
      if (!o) fail('upload', `${remoteName} is not in the remote listing after the upload`)
      const buf = fs.readFileSync(local)
      if (o.Size !== buf.length) fail('upload', `${remoteName}: the remote reports ${o.Size} bytes, not ${buf.length}`)
      const rm = o.Hashes?.md5 ?? o.Hashes?.MD5
      if (rm) { if (rm.toLowerCase() !== md5(buf)) fail('upload', `${remoteName}: the provider's MD5 differs from the local file`) } else { md5Checked = false; warnings.push(`${remoteName}: the provider returned no MD5`) }
      objects.push({ name: remoteName, size: buf.length, local_sha256: sha256(buf), provider_md5: rm ?? null })
    }
    step('upload', `${files.length} objects in ${remoteDir}; provider checksums ${md5Checked ? 'match' : 'not available'}`)
    // 5. an INDEPENDENT copy: a new empty directory, every file fetched back from the remote
    const dl = `${f.returnedDir}.partial-${process.pid}`; if (fs.existsSync(dl)) fail('download', `${dl} exists`)
    fs.mkdirSync(dl, { mode: 0o700 }); created.push(dl)
    for (const [local, remoteName] of files) {
      const dst = path.join(dl, remoteName)
      try { rclone.download(remoteDir, remoteName, dst) } catch (e) { fail('download', e) }
      if (sha256File(dst) !== sha256File(local)) fail('download', `${remoteName}: the downloaded bytes differ from the original (corrupted or substituted in storage)`)
    }
    if (fs.statSync(path.join(dl, `${name}.tar.zst.gpg`)).ino === fs.statSync(f.archive).ino) fail('download', 'the "downloaded" archive is the original file')
    step('download', 'every object fetched back from the remote and byte-identical to the original')
    // 6. decrypt the DOWNLOADED copy and compare it with the backup directory (the session key exists only in this run)
    const dlGpg = path.join(dl, `${name}.tar.zst.gpg`)
    try { inspectFile(dlGpg) } catch (e) { fail('decrypt', `the downloaded archive is not AES-256 symmetric OpenPGP (${e.message})`) }
    if (fs.readFileSync(`${dlGpg}.tree-sha256`, 'utf8').trim() !== tree) fail('decrypt', 'the downloaded content-tree companion is not this backup\'s')
    r = sh('bash', [PACK, 'verify', dlGpg, dir, '--passphrase-file', sfile])
    if (r.status !== 0) fail('decrypt', `decryption or verification of the downloaded copy failed: ${scrub(r.err, known).trim().split('\n').slice(-1)[0] || 'no detail'}`)
    step('decrypt', 'downloaded copy decrypts; content hash and internal SHA256SUMS match; equals the backup directory')
    // 7. evidence in the layout final-parity checks, then the same check final-parity will run
    move(dl, f.returnedDir); created.splice(created.indexOf(dl), 1, f.returnedDir)
    fs.rmSync(path.join(f.returnedDir, `${name}.tar.zst.gpg.sha256`)); fs.rmSync(path.join(f.returnedDir, `${name}.tar.zst.gpg.tree-sha256`)); fs.rmSync(path.join(f.returnedDir, `${name}.key.pgp`))
    const ev = verifyOffsiteEvidence(dir, archSha, tree); if (ev.length) fail('evidence', ev.join('; '))
    step('evidence', 'the off-site evidence passes the protocol-v2 final-parity check')
    const manifest = kind === 'backup' ? JSON.parse(fs.readFileSync(path.join(dir, 'snapshot/manifest.json'), 'utf8')) : {}
    record = {
      kind: RECORD_KIND, version: 1, result: 'PASS',
      backup: { name, dir, kind, started_at: new Date(started).toISOString(), eligible_until: new Date(started + MAX_BACKUP_AGE_MS).toISOString(), manifest_sha256: manifest.manifest_sha256 ?? null, tree_sha256: tree },
      archive: { sha256: archSha, size: archSize },
      key_wrap: { file: f.key, sha256: sha256File(f.key), recipient_fingerprint: kr.fpr, keyid: kr.keyids.join(',') },
      remote: { path: `${rclone.remote}/${remoteDir}`, objects, md5_checked: md5Checked },
      steps, warnings, started_at: attempt.started, finished_at: new Date().toISOString(),
      tools: { node: process.version, gpg: (sh('gpg', ['--version']).out.split('\n')[0] ?? '').trim(), rclone: (sh(rclone.bin, ['version']).out.split('\n')[0] ?? '').trim() }
    }
    record.record_sha256 = recordHash(record)
    fs.writeFileSync(f.record, JSON.stringify(record, null, 1) + '\n', { flag: 'wx', mode: 0o600 })
    const pv = verifyRecord(f.record, { now, maxAgeMs, requireFresh: kind === 'backup' }); if (pv.length) { fs.rmSync(f.record); fail('evidence', `the record does not re-verify: ${pv.join('; ')}`) }
    fs.writeFileSync(f.report, renderReport(record), { mode: 0o600 })
    result = 'PASS'
  } catch (e) {
    problems = [scrub(e.message, known)]
    if (!e.step) steps.push({ name: 'internal', ok: false, at: new Date().toISOString(), detail: problems[0] })
    const q = quarantine(`FAILED at ${e.step ?? 'internal'}: ${problems[0]}`)
    record = { kind: RECORD_KIND, version: 1, result: 'FAIL', backup: { name, dir }, steps, warnings, started_at: attempt.started, finished_at: new Date().toISOString(), quarantined_in: q }
    record.record_sha256 = recordHash(record)
    fs.writeFileSync(path.join(q, 'attempt-record.json'), JSON.stringify(record, null, 1) + '\n', { mode: 0o600 })
    fs.writeFileSync(path.join(q, 'report.txt'), renderReport(record, problems), { mode: 0o600 })
  } finally {
    if (sdir) { for (const x of fs.readdirSync(sdir)) shred(path.join(sdir, x)); fs.rmSync(sdir, { recursive: true, force: true }) }
  }
  return { result, record, problems, files: f }
}

// ---------------------------------------------------------------------------------------------------------------- owner-side recovery (the only place the private key is used)
/** Downloads (or reads local) archive + wrapped key, unwraps the session key with the owner's PRIVATE key (gpg asks for its passphrase), decrypts and verifies. */
export function recover ({ archive, keyFile, outDir, gnupgHome, expectTree }) {
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length) throw new Error(`${outDir} is not empty`)
  const sdir = sessionDir(); const sfile = path.join(sdir, 's')
  try {
    const env = gnupgHome ? { GNUPGHOME: gnupgHome } : {}
    const u = spawnSync('gpg', ['--decrypt', '--output', sfile, keyFile], { stdio: ['inherit', 'inherit', 'inherit'], env: { ...process.env, ...env } })
    if (u.status !== 0 || !fs.existsSync(sfile)) throw new Error('the session key could not be unwrapped with your private key')
    fs.chmodSync(sfile, 0o600)
    const r = sh('bash', [PACK, 'unpack', archive, outDir, '--passphrase-file', sfile])
    if (r.status !== 0) throw new Error(scrub(r.err).trim().split('\n').slice(-1)[0] || 'decryption failed')
    if (expectTree && contentTreeHash(outDir) !== expectTree) throw new Error('the recovered content does not match the expected tree hash')
    return contentTreeHash(outDir)
  } finally { shred(sfile); fs.rmSync(sdir, { recursive: true, force: true }) }
}
