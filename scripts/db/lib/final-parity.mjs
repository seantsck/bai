// G1 release protocol v2 (docs/transactions/g1-protocol-v2-proposal.md): the pure/IO helpers behind scripts/db/final-parity.mjs and the push guard.
// A backup may authorize a gate when (a) it is not older than SIX HOURS (measured from the snapshot start to the push), (b) a final READ-ONLY comparison
// (strict hosted preflight + a fresh logical export diffed against the backup's) passed immediately before the push, and (c) the off-site verification
// evidence names THIS backup's content. The comparison result is a small, hashed, short-lived record that the push guard re-verifies against the files.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { verifySnapshot } from './snapshot.mjs'
import { validateGateShape } from './gate.mjs'
import { inspectFile } from './openpgp-outer.mjs'

/** The reviewed switch that makes the record MANDATORY for `db push`. It stays false until the owner approves activation of protocol v2 (a code change). */
export const PROTOCOL_V2_ENFORCED = true
export const MAX_BACKUP_AGE_MS = 6 * 3600 * 1000
export const RECORD_VALIDITY_MS = 10 * 60 * 1000
export const EXPORT_FILES = ['roles.sql', 'schema.sql', 'data.sql', 'supabase_migrations_history.json']
const HEX64 = /^[0-9a-f]{64}$/
export const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex')

/** pg_dump 18 writes a random `\restrict <token>` / `\unrestrict <token>` line on every run; nothing else is ignored. */
export const normalizeExport = (text) => text.split('\n').filter((l) => !/^(-- )?\\(un)?restrict(\s|$)/.test(l)).join('\n')

/** Same value as backup-pack.sh's tree_hash: find . -type f | LC_ALL=C sort | xargs sha256sum | sha256sum */
export function contentTreeHash (dir) {
  const files = []
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.isFile()) files.push('./' + path.relative(dir, p).split(path.sep).join('/')) } }
  walk(dir)
  files.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
  return sha256(files.map((f) => `${sha256(fs.readFileSync(path.join(dir, f)))}  ${f}\n`).join(''))
}

/** The OLDEST evidence of when the backup began: manifest taken_at, the g1-<UTC> directory name, the manifest file's mtime. (Older = more conservative.) */
export function backupStartedAt (backupDir) {
  const times = []
  try { const m = JSON.parse(fs.readFileSync(path.join(backupDir, 'snapshot/manifest.json'), 'utf8')); const t = Date.parse(m.taken_at); if (Number.isFinite(t)) times.push(t) } catch { /* reported by verifyBackupDir */ }
  const nm = path.basename(backupDir).match(/-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/)
  if (nm) times.push(Date.UTC(+nm[1], +nm[2] - 1, +nm[3], +nm[4], +nm[5], +nm[6]))
  try { times.push(fs.statSync(path.join(backupDir, 'snapshot/manifest.json')).mtimeMs) } catch { /* idem */ }
  return times.length ? Math.min(...times) : null
}

/** Problems with a backup directory (<dir>/snapshot, <dir>/export), without a database. Empty list = sound. */
export function verifyBackupDir (backupDir) {
  const p = []
  if (!fs.existsSync(backupDir) || !fs.statSync(backupDir).isDirectory()) return [`backup directory ${backupDir} not found`]
  for (const x of verifySnapshot(path.join(backupDir, 'snapshot'))) p.push(`snapshot: ${x}`)
  const exp = path.join(backupDir, 'export')
  let sums
  try { sums = fs.readFileSync(path.join(exp, 'SHA256SUMS'), 'utf8').split('\n').filter(Boolean).map((l) => l.match(/^([0-9a-f]{64}) [ *](.+)$/)) } catch { return [...p, 'export/SHA256SUMS is missing'] }
  if (sums.some((m) => !m)) return [...p, 'export/SHA256SUMS is malformed']
  const byName = new Map(sums.map((m) => [m[2], m[1]]))
  for (const f of EXPORT_FILES) {
    const file = path.join(exp, f)
    if (!byName.has(f)) { p.push(`export/SHA256SUMS does not list ${f}`); continue }
    if (!fs.existsSync(file) || fs.statSync(file).size === 0) { p.push(`export/${f} is missing or empty`); continue }
  }
  for (const [name, h] of byName) { const file = path.join(exp, name); if (!fs.existsSync(file) || sha256(fs.readFileSync(file)) !== h) p.push(`export/${name} does not match SHA256SUMS`) }
  return p
}

/**
 * What the code CAN check about the off-site evidence (the rest is the owner's own verified report): the encrypted archive beside the backup
 * (<dir>.tar.zst.gpg) is an AES-256 OpenPGP file whose SHA-256 is the reported one and whose companions agree, its recorded content hash is this backup
 * directory's, and the copy that came back from the owner's machine (returned-<name>/<name>.tar.zst.gpg) is byte-identical. Decryption of the returned
 * copy needs the passphrase, so it is attested by the owner (`backup-offsite.sh check`, Windows helper Check), never inferred from these hashes.
 */
export function verifyOffsiteEvidence (backupDir, encrypted, tree) {
  const p = []
  const dir = path.resolve(backupDir); const name = path.basename(dir)
  const archive = `${dir}.tar.zst.gpg`; const returned = path.join(path.dirname(dir), `returned-${name}`, `${name}.tar.zst.gpg`)
  if (!HEX64.test(encrypted ?? '') || !HEX64.test(tree ?? '')) return ['the off-site hashes are not 64 hex characters']
  if (!fs.existsSync(archive)) return [`the encrypted archive ${archive} is missing`]
  try { inspectFile(archive) } catch (e) { p.push(`the encrypted archive is not the AES-256 OpenPGP file backup-pack.sh makes (${e.message})`) }
  if (sha256(fs.readFileSync(archive)) !== encrypted) p.push('the reported encrypted SHA-256 is not the archive\'s')
  const comp = (ext) => { try { return fs.readFileSync(archive + ext, 'utf8').trim() } catch { return null } }
  if (comp('.sha256') !== encrypted) p.push('the archive\'s .sha256 companion does not equal the reported encrypted SHA-256')
  if (comp('.tree-sha256') !== tree) p.push('the archive\'s .tree-sha256 companion does not equal the reported content hash')
  if (contentTreeHash(dir) !== tree) p.push('the reported content hash is not this backup directory\'s')
  if (!fs.existsSync(returned)) p.push(`the copy returned from the off-site round trip is missing (${returned})`)
  else if (sha256(fs.readFileSync(returned)) !== encrypted) p.push('the returned copy is not byte-identical to the archive')
  return p
}

/** Normalized comparison of two export directories. Never prints content (data.sql is data): file names and line numbers only. */
export function compareExports (a, b) {
  const problems = []; const hashes = {}
  for (const f of EXPORT_FILES) {
    const fa = path.join(a, f); const fb = path.join(b, f)
    if (!fs.existsSync(fa) || !fs.existsSync(fb)) { problems.push(`${f}: missing in ${!fs.existsSync(fa) ? 'the backup export' : 'the fresh export'}`); continue }
    const ta = normalizeExport(fs.readFileSync(fa, 'utf8')); const tb = normalizeExport(fs.readFileSync(fb, 'utf8'))
    if (ta.trim() === '' || tb.trim() === '') { problems.push(`${f}: empty`); continue }
    hashes[f] = sha256(tb)
    if (ta !== tb) {
      const la = ta.split('\n'); const lb = tb.split('\n'); let i = 0
      while (i < Math.max(la.length, lb.length) && la[i] === lb[i]) i++
      problems.push(`${f}: DIFFERS from the backup export (${la.length} vs ${lb.length} lines; first difference at line ${i + 1})`)
    }
  }
  return { ok: problems.length === 0, problems, hashes }
}

const canonical = (o) => JSON.stringify(o, Object.keys(o).sort())
export function recordHash (rec) { const { record_sha256, ...rest } = rec; return sha256(JSON.stringify(rest)) }

export function buildRecord ({ backupDir, gate, offsite, preflight, exportHashes, now = Date.now() }) {
  const manifest = JSON.parse(fs.readFileSync(path.join(backupDir, 'snapshot/manifest.json'), 'utf8'))
  const rec = {
    kind: 'g1-final-parity', version: 1, result: 'PASS',
    gate: { commit: gate.commit, through: gate.through, from_level: gate.from_level, project_ref: gate.project_ref, migrations_hash: gate.migrations_hash },
    backup: { dir: path.resolve(backupDir), started_at: new Date(backupStartedAt(backupDir)).toISOString(), manifest_sha256: manifest.manifest_sha256, tree_sha256: contentTreeHash(backupDir) },
    offsite: { encrypted_sha256: offsite.encrypted, tree_sha256: offsite.tree, authorization_ref: offsite.authorizationRef },
    preflight: { ok: true, expect_level: gate.from_level, expect_checksum: `${gate.through}:${gate.checksums[gate.through]}` },
    export_compare: { identical: true, files: exportHashes },
    max_age_ms: MAX_BACKUP_AGE_MS, checked_at: new Date(now).toISOString(), expires_at: new Date(now + RECORD_VALIDITY_MS).toISOString()
  }
  rec.record_sha256 = recordHash(rec)
  return rec
}

/** Everything the push guard re-checks from the files themselves. Returns problems (empty = the record authorizes a push NOW under this gate). */
export function verifyRecordFile (file, { gate, now = Date.now() }) {
  const p = []
  let rec
  try { rec = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { return [`parity record unreadable: ${e.message}`] }
  if (rec?.kind !== 'g1-final-parity' || rec.version !== 1) return ['not a g1-final-parity record (version 1)']
  if (rec.record_sha256 !== recordHash(rec)) return ['parity record was altered (its own hash does not match)']
  if (rec.result !== 'PASS' || rec.preflight?.ok !== true || rec.export_compare?.identical !== true) p.push('parity record is not a PASS')
  const gp = validateGateShape(gate); if (gp.length) p.push(`gate file: ${gp.join('; ')}`)
  for (const k of ['commit', 'through', 'from_level', 'project_ref', 'migrations_hash']) if (rec.gate?.[k] !== gate[k]) p.push(`parity record is for another gate (${k})`)
  if (rec.preflight?.expect_level !== gate.from_level || rec.preflight?.expect_checksum !== `${gate.through}:${gate.checksums?.[gate.through]}`) p.push('parity record did not check this gate\'s level and migration checksum')
  const t0 = Date.parse(rec.checked_at); const t1 = Date.parse(rec.expires_at)
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 - t0 > RECORD_VALIDITY_MS) p.push('parity record has no valid time window')
  else if (now < t0 - 1000) p.push('parity record is dated in the future')
  else if (now > t1) p.push(`parity record expired ${Math.round((now - t1) / 1000)} s ago: run the final parity check again immediately before the push`)
  if (!(rec.max_age_ms <= MAX_BACKUP_AGE_MS)) p.push('parity record claims a longer backup age than the six hours allowed')
  const dir = rec.backup?.dir
  if (!dir) return [...p, 'parity record names no backup']
  const bp = verifyBackupDir(dir); if (bp.length) return [...p, ...bp.map((x) => `backup: ${x}`)]
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'snapshot/manifest.json'), 'utf8'))
  if (manifest.manifest_sha256 !== rec.backup.manifest_sha256) p.push('the backup\'s manifest differs from the record')
  if (manifest.migrations?.v !== gate.from_level) p.push(`the backup is at migration ${manifest.migrations?.v}, the gate starts from ${gate.from_level}`)
  const tree = contentTreeHash(dir)
  if (tree !== rec.backup.tree_sha256) p.push('the backup directory content changed since the record was written')
  if (![rec.offsite?.encrypted_sha256, rec.offsite?.tree_sha256].every((h) => HEX64.test(h ?? ''))) p.push('the record has no off-site verification hashes')
  if (rec.offsite?.tree_sha256 !== tree) p.push('the off-site verified content hash is not this backup\'s content hash')
  else for (const x of verifyOffsiteEvidence(dir, rec.offsite?.encrypted_sha256, rec.offsite?.tree_sha256)) p.push(`off-site evidence: ${x}`)
  if (!String(rec.offsite?.authorization_ref ?? '').trim()) p.push('the record has no owner authorization reference')
  const started = backupStartedAt(dir)
  if (started == null) p.push('the backup start time cannot be determined')
  else if (now - started > MAX_BACKUP_AGE_MS) p.push(`the backup is ${((now - started) / 3600000).toFixed(1)} hours old; the maximum is 6`)
  return p
}
