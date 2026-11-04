// Owner authorization artifacts for the hosted promotion runner.
//
// A hosted write needs a file that only the OWNER can make: a small JSON document naming the exact operation, project and manifest, plus a detached OpenPGP signature over its bytes by the
// owner's release-signing key. The runner verifies the signature with `gpg` against a keyring that holds only PUBLIC keys and against the key fingerprints PINNED in this repository
// (OWNER_SIGNING_FINGERPRINTS, empty until the owner pins a signing key in a reviewed commit: while it is empty every hosted write is refused). A developer, a script or this tool cannot
// produce a valid artifact; nothing here signs anything. One artifact authorizes one operation once: the runner records its hash in the operator-host attempt ledger and refuses a second use.
//
// What an artifact binds (all of it is checked against what the runner computes itself, never taken on trust):
//   operation        promote | withdraw | emergency | finish | revert | analyze          (one operation per artifact)
//   project_ref      the Supabase project (must equal BAI_SUPABASE_PROJECT_REF)
//   manifest_sha256  the reviewed package (promote: also the package directory's own hash)
//   window           not_before / expires_at, at most 24 hours apart, and the current time must lie inside it
//   promote only     backup (name, T0, manifest, encrypted archive, content tree, off-site record), the parity record hash, the attribution evidence hash,
//                    `rest_public_delta` and `website_visible_delta` (the exact sets of relations the Data API roles and the website role could read afterwards), `after_attempt` (null, or the id of an earlier unresolved attempt)
//   withdraw/finish/emergency/revert   `reason`; emergency with close_api also `acknowledge_site_outage: true`; withdraw with_grant
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export const AUTHORIZATION_FORMAT = 'bai-promotion-authorization/1'
export const OPERATIONS = Object.freeze(['promote', 'withdraw', 'emergency', 'finish', 'revert', 'analyze'])
export const MAX_WINDOW_MS = 24 * 3600e3
/** The owner's release-signing key fingerprints (40 hex, upper case). EMPTY until the owner has made a signing key and pinned it by a reviewed commit: the runner then refuses every write. */
export const OWNER_SIGNING_FINGERPRINTS = Object.freeze([])
const HEX64 = /^[0-9a-f]{64}$/
const REF_RE = /^[a-z0-9]{20}$/

export const sha256Hex = (b) => crypto.createHash('sha256').update(b).digest('hex')

/**
 * `gpg --verify` of a detached signature over EXACTLY the bytes given (fed on stdin, so a file swapped after reading cannot be what gpg checks), public keyring only. The signature file is read
 * once and copied into a private temporary directory. Returns { ok, fingerprint, primary, problems }.
 */
export function verifyDetachedSignature (dataBytes, signatureFile, { keyring, pinned = OWNER_SIGNING_FINGERPRINTS }) {
  const problems = []
  if (!pinned.length) return { ok: false, problems: ['no owner signing key is pinned in this build (OWNER_SIGNING_FINGERPRINTS is empty): every hosted write is refused until the owner pins a key'] }
  if (!keyring || !fs.existsSync(keyring)) return { ok: false, problems: [`the owner keyring ${keyring ?? '(none)'} does not exist`] }
  let sigBytes; try { sigBytes = fs.readFileSync(signatureFile) } catch { return { ok: false, problems: ['the signature file (.sig) is missing or unreadable'] } }
  if (sigBytes.length < 20 || sigBytes.length > 65536) return { ok: false, problems: ['the signature file has an implausible size'] }
  const env = { PATH: process.env.PATH, HOME: os.userInfo().homedir, GNUPGHOME: keyring, LANG: 'C' }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-sig-')); const sigCopy = path.join(tmp, 'auth.sig')
  try {
    fs.writeFileSync(sigCopy, sigBytes, { mode: 0o600 })
    const secret = spawnSync('gpg', ['--batch', '--with-colons', '--list-secret-keys'], { env, encoding: 'utf8' })
    if (secret.status === 0 && /^(sec|ssb):/m.test(secret.stdout)) problems.push('the verification keyring holds a SECRET key: the runner host must hold only the owner\'s public key')
    const r = spawnSync('gpg', ['--batch', '--no-tty', '--status-fd', '1', '--trust-model', 'always', '--verify', '--', sigCopy, '-'], { env, encoding: 'utf8', input: dataBytes })
    const st = r.stdout ?? ''
    if (/\[GNUPG:\] (BADSIG|ERRSIG|EXPSIG|EXPKEYSIG|REVKEYSIG|NO_PUBKEY)/.test(st) || r.status !== 0) problems.push('the signature is not a good signature by a current public key in the owner keyring')
    const good = /\[GNUPG:\] GOODSIG /.test(st); const valid = /\[GNUPG:\] VALIDSIG (\S+) (?:\S+ ){8}(\S+)/.exec(st)
    if (!good || !valid) problems.push('there is no valid signature')
    const used = valid?.[1]?.toUpperCase(); const primary = valid?.[2]?.toUpperCase()
    if (valid && !pinned.map((x) => x.toUpperCase()).some((f) => f === used || f === primary)) problems.push('the signing key is not one of the keys pinned for the owner')
    return { ok: problems.length === 0, fingerprint: used ?? null, primary: primary ?? null, problems }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
}

/**
 * Reads and checks an authorization artifact. `expect` says what this invocation is about to do; every field is compared. Returns { problems, auth, sha256 }.
 * @param {string} file          the artifact (JSON)
 * @param {object} o
 * @param {string} o.operation   the requested operation
 * @param {string} o.projectRef  the project the runner would write to
 * @param {string} o.manifest    the manifest SHA-256 the operation targets
 * @param {string} o.keyring     GNUPGHOME holding the owner's public key
 * @param {string[]} [o.pinned]  pinned fingerprints (tests inject their own; the CLI never does)
 * @param {number} [o.now]
 * @param {(sha: string) => boolean} [o.isConsumed]  has this artifact already been used on this host
 */
export function verifyAuthorization (file, { operation, projectRef, manifest, keyring, pinned = OWNER_SIGNING_FINGERPRINTS, now = Date.now(), isConsumed = () => false }) {
  const problems = []
  let bytes; try { bytes = fs.readFileSync(file) } catch { return { problems: [`the authorization ${file} is missing or unreadable`] } }
  const sha = sha256Hex(bytes)
  const sig = verifyDetachedSignature(bytes, `${file}.sig`, { keyring, pinned }); problems.push(...sig.problems)
  let a; try { a = JSON.parse(bytes.toString('utf8')) } catch { return { problems: [...problems, 'the authorization is not valid JSON'], sha256: sha } }
  if (!a || typeof a !== 'object' || Array.isArray(a)) return { problems: [...problems, 'the authorization is not a JSON object'], sha256: sha }
  if (a?.format !== AUTHORIZATION_FORMAT) problems.push(`unknown authorization format ${a?.format}`)
  if (!OPERATIONS.includes(operation)) problems.push(`unknown operation ${operation}`)
  if (a.operation !== operation) problems.push(`the authorization is for "${a.operation}", not "${operation}"`)
  if (!REF_RE.test(a.project_ref ?? '') || a.project_ref !== projectRef) problems.push('the authorization names another project')
  if (!HEX64.test(a.manifest_sha256 ?? '') || a.manifest_sha256 !== manifest) problems.push('the authorization names another manifest')
  const t0 = Date.parse(a.not_before); const t1 = Date.parse(a.expires_at)
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0 || t1 - t0 > MAX_WINDOW_MS) problems.push('the authorization has no valid window (at most 24 hours)')
  else if (now < t0) problems.push('the authorization is not yet valid')
  else if (now >= t1) problems.push('the authorization has expired')
  if (!String(a.nonce ?? '').match(/^[0-9a-f]{32,}$/)) problems.push('the authorization has no nonce (at least 32 hex characters)')
  if (isConsumed(sha)) problems.push('this authorization was already used on this host: one artifact authorizes one operation once')
  if (['withdraw', 'emergency', 'finish', 'revert'].includes(operation) && !String(a.reason ?? '').trim()) problems.push(`${operation} needs a stated reason in the authorization`)
  if (operation === 'emergency' && a.options?.close_api === true && a.options?.acknowledge_site_outage !== true) problems.push('emergency --close-api deliberately switches off public endpoints and website pages: the authorization must acknowledge the outage')
  if (operation === 'promote') {
    for (const k of ['name', 't0']) if (!String(a.backup?.[k] ?? '').trim()) problems.push(`the authorization names no backup ${k}`)
    for (const k of ['manifest_sha256', 'archive_sha256', 'content_tree_sha256', 'offsite_record_sha256']) if (!HEX64.test(a.backup?.[k] ?? '')) problems.push(`the authorization names no valid backup ${k}`)
    for (const k of ['parity_record_sha256', 'attribution_evidence_sha256']) if (!HEX64.test(a[k] ?? '')) problems.push(`the authorization names no valid ${k}`)
    if (!Array.isArray(a.rest_public_delta)) problems.push('the authorization lists no rest_public_delta (the Data API-readable relations the promotion makes visible)')
    if (!Array.isArray(a.website_visible_delta)) problems.push('the authorization lists no website_visible_delta (what the website role reads after the promotion)')
    if (!(a.after_attempt === null || /^[0-9a-f]{16,}$/.test(a.after_attempt ?? ''))) problems.push('after_attempt must be null or an attempt id')
  }
  return { problems, auth: a, sha256: sha, signature: sig }
}

/**
 * Operator-host attempt ledger: one file per attempt and per consumed artifact, created exclusively (O_EXCL), so a second use of either is refused even by a parallel process.
 * It is a safeguard against operator error on this host, not a database fact: the database's own manifest state (PROMOTED cannot be promoted again) is the final word.
 */
export function attemptLedger (dir = path.join(os.userInfo().homedir, '.local/state/bai-promotion')) {   // the account's home directory, not $HOME (an environment variable must not choose where replays are remembered)
  const ensure = () => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); const st = fs.statSync(dir)
    if (st.uid !== process.getuid() || (st.mode & 0o077) !== 0) throw new Error(`the attempt ledger ${dir} must be owned by this user and not accessible to others (mode 0700)`)
  }
  const consumedFile = (sha) => path.join(dir, `authorization-${sha}.json`)
  const attemptFile = (manifest, id) => path.join(dir, `attempt-${manifest}-${id}.json`)
  const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'))
  const api = {
    dir,
    isConsumed: (sha) => fs.existsSync(consumedFile(sha)),
    consume (sha, info) { ensure(); fs.writeFileSync(consumedFile(sha), JSON.stringify({ ...info, consumed_at: new Date().toISOString() }, null, 1), { flag: 'wx', mode: 0o600 }) },
    start (info) {
      ensure(); const id = crypto.randomBytes(12).toString('hex'); const rec = { id, ...info, state: 'CREATED' }
      fs.writeFileSync(attemptFile(info.manifest, id), JSON.stringify(rec, null, 1), { flag: 'wx', mode: 0o600 })
      return { id, update: (patch) => api.mark(info.manifest, id, patch) }
    },
    mark (manifest, id, patch) { const f = attemptFile(manifest, id); fs.writeFileSync(f, JSON.stringify({ ...read(f), ...patch, updated_at: new Date().toISOString() }, null, 1), { mode: 0o600 }) },
    attempts (manifest) {
      if (!fs.existsSync(dir)) return []
      return fs.readdirSync(dir).filter((f) => f.startsWith(`attempt-${manifest}-`)).map((f) => read(path.join(dir, f))).sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)))
    }
  }
  return api
}
