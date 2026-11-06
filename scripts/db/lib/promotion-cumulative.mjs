// Cumulative-release verification: R6 promotion invariants plus LATER, OWNER-AUTHORIZED, audited historical draft releases.
//
// verify-promoted compares every in-scope table's fingerprint with the R6 release state. A later draft release (scripts/history/release.mjs) legitimately adds rows to some of those tables, so the
// plain comparison fails after it. This module accepts such a difference ONLY when ALL of these hold for the release:
//   1. its authorization is signed by the pinned owner signing key (the same verification the runner uses for hosted writes), names this project, and carries exact expected row deltas;
//   2. its evidence file is bound to that exact authorization (SHA-256) and names the same tables and the same deltas, with n_before + delta = n_after chained from the R6 manifest (or from
//      the previous release's recorded state when several releases touch a table);
//   3. the database holds exactly one release audit with the authorization's release key and manifest checksum, applied AFTER the promotion, with the audited selection count;
//   4. each affected table's CURRENT fingerprint equals the state recorded for that release. Any later change to those tables (an edited row, an extra row, a deleted row) is a difference
//      from the recorded state and fails; so does any table outside the authorized set.
// An audit row alone accepts nothing: a table is excused only through all four. Evidence never excuses a table the authorization does not list.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { canon } from './promotion.mjs'
import { verifyDetachedSignature, sha256Hex } from './promotion-authorization.mjs'

export const RELEASE_EVIDENCE_FORMAT = 'bai-draft-release-evidence/1'
export const DRAFT_AUTHORIZATION_FORMAT = 'bai-draft-release-authorization/1'
const HEX64 = /^[0-9a-f]{64}$/; const TABLE = /^[a-z_]+\.[a-z_0-9]+$/
const q = async (c, sql, p) => (await c.query(sql, p)).rows

/** The release directories under `root` (one subdirectory per release: authorization.json, authorization.json.sig, evidence.json), in name order. */
export function releaseDirs (root) {
  const abs = path.resolve(root)
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error(`release evidence directory ${abs} does not exist`)
  const dirs = fs.readdirSync(abs, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(abs, d.name)).sort()
  if (!dirs.length) throw new Error(`release evidence directory ${abs} holds no release`)
  return dirs
}

/**
 * @param c    a read-only session (verifyPromoted's)
 * @param pkg  the loaded R6 promotion package (its manifest holds the R6 table counts)
 * @returns { problems, accepted: { table -> true }, facts: [...] }; a table is in `accepted` only when every check passed and its current fingerprint equals the recorded one
 */
export async function cumulativeReleases (c, pkg, dirs, { keyring, pinned, projectRef }) {
  const problems = []; const accepted = {}; const facts = []
  const r6n = (t) => (pkg.manifest.after?.[t] ?? pkg.manifest.baseline.fingerprints?.[t])?.n
  const promoted = (await q(c, "select max(at) at from ingest.promotion_events where manifest_sha256 = $1 and event = 'PROMOTED'", [pkg.sha]))[0]?.at
  const loaded = []
  for (const dir of dirs) {
    const name = path.basename(dir); const bad = (m) => problems.push(`release ${name}: ${m}`)
    let bytes; let ev; let auth
    try { bytes = fs.readFileSync(path.join(dir, 'authorization.json')); auth = JSON.parse(bytes.toString('utf8')); ev = JSON.parse(fs.readFileSync(path.join(dir, 'evidence.json'), 'utf8')) } catch (e) { bad(`authorization.json or evidence.json is missing or not JSON (${e.code ?? e.message})`); continue }
    const sig = verifyDetachedSignature(bytes, path.join(dir, 'authorization.json.sig'), { keyring, pinned }); if (!sig.ok) { bad(`the authorization is not signed by the pinned owner key: ${sig.problems.join('; ')}`); continue }
    if (auth?.format !== DRAFT_AUTHORIZATION_FORMAT || auth.operation !== 'apply-draft-release') { bad('not a draft-release authorization'); continue }
    if (auth.project_ref !== projectRef) { bad('the authorization names another project'); continue }
    if (!HEX64.test(auth.manifest_sha256 ?? '') || typeof auth.release_key !== 'string' || !Number.isInteger(auth.selections) || auth.selections < 1) { bad('the authorization lacks a manifest checksum, a release key or a selection count'); continue }
    const exp = auth.expected_after_apply; if (!exp || typeof exp !== 'object' || Array.isArray(exp) || !Object.keys(exp).length || !Object.entries(exp).every(([t, n]) => TABLE.test(t) && Number.isInteger(n) && n > 0)) { bad('the authorization has no exact, positive expected row deltas'); continue }
    if (ev?.format !== RELEASE_EVIDENCE_FORMAT) { bad('the evidence has an unknown format'); continue }
    if (ev.authorization_sha256 !== sha256Hex(bytes)) { bad('the evidence is not bound to this authorization (SHA-256 differs)'); continue }
    if (ev.release_key !== auth.release_key || ev.manifest_sha256 !== auth.manifest_sha256) { bad('the evidence names another release'); continue }
    const aud = await q(c, 'select id::text id, release_key, manifest_sha256, applied_at, counts from ingest.release_audits where release_key = $1 and manifest_sha256 = $2', [auth.release_key, auth.manifest_sha256])
    if (aud.length !== 1) { bad(`the database holds ${aud.length} release audit(s) for this release key and manifest, expected exactly one`); continue }
    const a = aud[0]
    if (String(ev.audit_id) !== a.id) { bad(`the evidence names audit ${ev.audit_id}, the database audit is ${a.id}`); continue }
    if (promoted && new Date(a.applied_at) <= new Date(promoted)) { bad('the audit pre-dates the R6 promotion: it cannot explain a change made after it'); continue }
    if (a.counts?.selections !== auth.selections || a.counts?.imported !== auth.selections || a.counts?.held !== 0 || a.counts?.skipped !== 0) { bad(`the audit counts ${JSON.stringify(a.counts)} do not match the authorized ${auth.selections} selections`); continue }
    const tabs = ev.tables
    if (!tabs || typeof tabs !== 'object' || canon(Object.keys(tabs).sort()) !== canon(Object.keys(exp).sort())) { bad('the evidence tables are not exactly the authorized tables'); continue }
    loaded.push({ dir, name, auth, ev, audit: a, exp, tabs })
  }
  loaded.sort((x, y) => Number(x.audit.id) - Number(y.audit.id))
  const seen = new Set(); const state = {}   // table -> { n, md5 } as recorded by the latest accepted release
  for (const r of loaded) {
    const bad = (m) => problems.push(`release ${r.name}: ${m}`)
    if (seen.has(r.audit.id)) { bad('a second evidence directory for the same audit'); continue } seen.add(r.audit.id)
    let ok = true; const touched = []
    for (const [t, d] of Object.entries(r.exp)) {
      const rec = r.tabs[t]; const before = state[t]?.n ?? r6n(t)
      if (!Number.isInteger(before)) { bad(`${t} has no known R6 state to start from`); ok = false; continue }
      if (!rec || !Number.isInteger(rec.n_before) || !Number.isInteger(rec.delta) || !Number.isInteger(rec.n_after) || typeof rec.md5_after !== 'string') { bad(`${t}: the evidence record is incomplete`); ok = false; continue }
      if (rec.delta !== d) { bad(`${t}: the evidence delta ${rec.delta} differs from the authorized ${d}`); ok = false; continue }
      if (rec.n_before !== before || rec.n_before + rec.delta !== rec.n_after) { bad(`${t}: counts do not chain from the previous state (${before}) by the authorized delta ${d}`); ok = false; continue }
      touched.push([t, rec])
    }
    if (!ok) continue
    for (const [t, rec] of touched) state[t] = { n: rec.n_after, md5: rec.md5_after, release: r.name }
    facts.push({ release_key: r.auth.release_key, audit_id: r.audit.id, selections: r.auth.selections, tables: touched.map(([t]) => t) })
  }
  for (const [t, s] of Object.entries(state)) {   // the CURRENT state must be exactly the last recorded one
    const f = (await q(c, 'select ingest.promotion_fingerprint($1) f', [t]))[0].f
    if (Number(f.n) === s.n && f.md5 === s.md5) accepted[t] = true
    else problems.push(`${t} differs from the state recorded for release ${s.release}: now ${f.n} rows, recorded ${s.n}; it was changed after that release or the evidence is wrong`)
  }
  return { problems, accepted, facts }
}

/** The evidence for one release, read from the database RIGHT AFTER the release was verified (see docs). Pure data; the caller writes it. proofs: files whose SHA-256 are recorded (e.g. the post-apply invariants). */
export async function buildReleaseEvidence (c, { authorizationFile, proofFiles = [] }) {
  const bytes = fs.readFileSync(authorizationFile); const auth = JSON.parse(bytes.toString('utf8'))
  const aud = await q(c, 'select id::text id from ingest.release_audits where release_key = $1 and manifest_sha256 = $2', [auth.release_key, auth.manifest_sha256])
  if (aud.length !== 1) throw new Error(`the database holds ${aud.length} audit(s) for ${auth.release_key}, expected exactly one`)
  const tables = {}
  for (const [t, d] of Object.entries(auth.expected_after_apply ?? {})) {
    if (!TABLE.test(t)) throw new Error(`bad table name ${t}`)
    const f = (await q(c, 'select ingest.promotion_fingerprint($1) f', [t]))[0].f
    tables[t] = { n_before: Number(f.n) - d, delta: d, n_after: Number(f.n), md5_after: f.md5 }
  }
  return { format: RELEASE_EVIDENCE_FORMAT, release_key: auth.release_key, manifest_sha256: auth.manifest_sha256, audit_id: aud[0].id, authorization_sha256: sha256Hex(bytes), captured_at: new Date().toISOString(), tables,
    proofs: proofFiles.map((f) => ({ file: path.basename(f), sha256: crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') })) }
}
