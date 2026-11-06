// Cumulative-release verification: R6 promotion invariants plus LATER, OWNER-AUTHORIZED, audited historical draft releases.
//
// verify-promoted compares every in-scope table's fingerprint with the R6 release state. A later draft release (scripts/history/release.mjs) legitimately adds rows to some of those tables, so the
// plain comparison fails after it. This module accepts such a difference ONLY when ALL of these hold for the release:
//   1. its authorization is signed by the pinned owner signing key (the same verification the runner uses for hosted writes), names this project, and carries exact expected row deltas;
//   2. its evidence file is SIGNED by the same pinned owner key (detached signature over the exact evidence bytes: an unsigned file, or any edit, substitution or regeneration of it, is
//      rejected), is bound to that authorization (SHA-256) and to the R6 manifest, names the same tables and deltas, and chains: n_before + delta = n_after from the R6 manifest (or from the
//      previous release's recorded state), and each release names the SHA-256 of the previous release's evidence (the first names null), so a release cannot be dropped, reordered or inserted;
//   3. the database holds exactly one release audit with the authorization's release key and manifest checksum, applied AFTER the promotion, with the audited selection count;
//   4. each affected table's CURRENT fingerprint equals the state recorded for that release. Any later change to those tables (an edited row, an extra row, a deleted row) is a difference
//      from the recorded state and fails; so does any table outside the authorized set.
// An audit row alone accepts nothing: a table is excused only through all four. Evidence never excuses a table the authorization does not list.
import fs from 'node:fs'
import path from 'node:path'
import { canon } from './promotion.mjs'
import { verifyDetachedSignature, sha256Hex } from './promotion-authorization.mjs'

export const RELEASE_EVIDENCE_FORMAT = 'bai-draft-release-evidence/2'
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
export async function cumulativeReleases (c, pkg, dirs, { keyring, pinned, projectRef, expectHead = null }) {
  const problems = []; const accepted = {}; const facts = []
  const r6fp = (t) => pkg.manifest.after?.[t] ?? pkg.manifest.baseline.fingerprints?.[t]
  const r6n = (t) => r6fp(t)?.n
  if (typeof projectRef !== 'string' || !/^[a-z0-9]{20}$/.test(projectRef)) problems.push('cumulative verification needs the project reference')
  const promoted = (await q(c, "select max(at) at from ingest.promotion_events where manifest_sha256 = $1 and event = 'PROMOTED'", [pkg.sha]))[0]?.at
  const loaded = []
  for (const dir of dirs) {
    const name = path.basename(dir); const bad = (m) => problems.push(`release ${name}: ${m}`)
    let bytes; let evBytes; let ev; let auth
    try { bytes = fs.readFileSync(path.join(dir, 'authorization.json')); auth = JSON.parse(bytes.toString('utf8')); evBytes = fs.readFileSync(path.join(dir, 'evidence.json')); ev = JSON.parse(evBytes.toString('utf8')) } catch (e) { bad(`authorization.json or evidence.json is missing or not JSON (${e.code ?? e.message})`); continue }
    const sig = verifyDetachedSignature(bytes, path.join(dir, 'authorization.json.sig'), { keyring, pinned }); if (!sig.ok) { bad(`the authorization is not signed by the pinned owner key: ${sig.problems.join('; ')}`); continue }
    const esig = verifyDetachedSignature(evBytes, path.join(dir, 'evidence.json.sig'), { keyring, pinned }); if (!esig.ok) { bad(`the evidence is not signed by the pinned owner key (an unsigned, edited or substituted evidence file excuses nothing): ${esig.problems.join('; ')}`); continue }
    if (auth?.format !== DRAFT_AUTHORIZATION_FORMAT || auth.operation !== 'apply-draft-release') { bad('not a draft-release authorization'); continue }
    if (auth.project_ref !== projectRef) { bad('the authorization names another project'); continue }
    if (!HEX64.test(auth.manifest_sha256 ?? '') || typeof auth.release_key !== 'string' || !Number.isInteger(auth.selections) || auth.selections < 1) { bad('the authorization lacks a manifest checksum, a release key or a selection count'); continue }
    const exp = auth.expected_after_apply; if (!exp || typeof exp !== 'object' || Array.isArray(exp) || !Object.keys(exp).length || !Object.entries(exp).every(([t, n]) => TABLE.test(t) && Number.isInteger(n) && n > 0)) { bad('the authorization has no exact, positive expected row deltas'); continue }
    if (ev?.format !== RELEASE_EVIDENCE_FORMAT) { bad('the evidence has an unknown format (an unsigned v1 evidence file is never accepted)'); continue }
    if (ev.r6_manifest_sha256 !== pkg.sha) { bad('the evidence is for another R6 promotion'); continue }
    if (ev.previous_evidence_sha256 !== null && !HEX64.test(ev.previous_evidence_sha256 ?? '')) { bad('the evidence has no valid previous-evidence reference (null for the first release)'); continue }
    const an = ev.anchor; if (!an || !HEX64.test(an.snapshot_manifest_sha256 ?? '') || !HEX64.test(an.before_manifest_sha256 ?? '') || !HEX64.test(an.post_apply_report_sha256 ?? '')) { bad('the evidence carries no independent anchor (snapshot, before-snapshot and post-apply report checksums)'); continue }
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
    loaded.push({ dir, name, auth, ev, audit: a, exp, tabs, evSha: sha256Hex(evBytes) })
  }
  loaded.sort((x, y) => Number(x.audit.id) - Number(y.audit.id))
  // every audit applied after the promotion needs signed evidence: an audited release without it is a difference nobody vouched for
  const later = await q(c, 'select id::text id, release_key from ingest.release_audits where ($1::timestamptz is null or applied_at > $1::timestamptz) order by id', [promoted ?? null])
  for (const a of later) if (promoted && !loaded.some((r) => r.audit.id === a.id)) problems.push(`audit ${a.id} (${a.release_key}) was applied after the R6 promotion and has no signed release evidence`)
  const seen = new Set(); const state = {}   // table -> { n, md5 } as recorded by the latest accepted release
  let prevSha = null
  for (const r of loaded) {
    const bad = (m) => problems.push(`release ${r.name}: ${m}`)
    if (seen.has(r.audit.id)) { bad('a second evidence directory for the same audit'); continue } seen.add(r.audit.id)
    if (r.ev.previous_evidence_sha256 !== prevSha) { bad(`the release chain is broken: this evidence names ${r.ev.previous_evidence_sha256 ?? 'no'} as the previous release evidence, the verified previous one is ${prevSha ?? 'none'}`); continue }
    let ok = true; const touched = []
    for (const [t, d] of Object.entries(r.exp)) {
      const rec = r.tabs[t]; const before = state[t]?.n ?? r6n(t)
      if (!Number.isInteger(before)) { bad(`${t} has no known R6 state to start from`); ok = false; continue }
      if (!rec || !Number.isInteger(rec.n_before) || !Number.isInteger(rec.delta) || !Number.isInteger(rec.n_after) || typeof rec.md5_after !== 'string' || typeof rec.md5_before !== 'string') { bad(`${t}: the evidence record is incomplete`); ok = false; continue }
      const beforeMd5 = state[t]?.md5 ?? r6fp(t)?.md5
      if (rec.md5_before !== beforeMd5) { bad(`${t}: the content before the release (${rec.md5_before}) is not the previously recorded state (${beforeMd5}): the table was changed between the previous state and this release`); ok = false; continue }
      if (rec.delta !== d) { bad(`${t}: the evidence delta ${rec.delta} differs from the authorized ${d}`); ok = false; continue }
      if (rec.n_before !== before || rec.n_before + rec.delta !== rec.n_after) { bad(`${t}: counts do not chain from the previous state (${before}) by the authorized delta ${d}`); ok = false; continue }
      touched.push([t, rec])
    }
    if (!ok) continue
    for (const [t, rec] of touched) state[t] = { n: rec.n_after, md5: rec.md5_after, release: r.name }
    prevSha = r.evSha
    facts.push({ release_key: r.auth.release_key, audit_id: r.audit.id, selections: r.auth.selections, tables: touched.map(([t]) => t) })
  }
  if (expectHead !== undefined && expectHead !== null) { if (!HEX64.test(expectHead)) problems.push('--expect-head must be a SHA-256'); else if (prevSha !== expectHead) problems.push(`the last verified release evidence is ${prevSha ?? 'none'}, the expected head is ${expectHead}: a release is missing or the history was rolled back`) }
  for (const [t, s] of Object.entries(state)) {   // the CURRENT state must be exactly the last recorded one
    const f = (await q(c, 'select ingest.promotion_fingerprint($1) f', [t]))[0].f
    if (Number(f.n) === s.n && f.md5 === s.md5) accepted[t] = true
    else problems.push(`${t} differs from the state recorded for release ${s.release}: now ${f.n} rows, recorded ${s.n}; it was changed after that release or the evidence is wrong`)
  }
  return { problems, accepted, facts }
}

/**
 * The evidence for one release, built ONLY from an independent anchor (anchor-release-evidence.mjs: the post-release backup snapshot restored on a disposable database, the pre-release snapshot's counts and
 * the executor's post-apply report), never silently from the current database. The current database is then CHECKED against the anchor and the build refuses if it differs. The result is unsigned data: the
 * owner reviews and signs the exact bytes (evidence.json.sig); only a signed evidence file is ever accepted by the verifier.
 */
export async function buildReleaseEvidence (c, { authorizationFile, anchorFile, previousEvidenceFile = null, r6ManifestSha256 }) {
  const bytes = fs.readFileSync(authorizationFile); const auth = JSON.parse(bytes.toString('utf8')); const authSha = sha256Hex(bytes)
  const anchor = JSON.parse(fs.readFileSync(anchorFile, 'utf8'))
  if (anchor.format !== ANCHOR_FORMAT) throw new Error('the anchor file has an unknown format')
  if (anchor.authorization_sha256 !== authSha) throw new Error('the anchor was produced for another authorization')
  if (!HEX64.test(r6ManifestSha256 ?? '')) throw new Error('the R6 manifest checksum is required')
  const aud = await q(c, 'select id::text id from ingest.release_audits where release_key = $1 and manifest_sha256 = $2', [auth.release_key, auth.manifest_sha256])
  if (aud.length !== 1) throw new Error(`the database holds ${aud.length} audit(s) for ${auth.release_key}, expected exactly one`)
  if (canon(Object.keys(anchor.tables).sort()) !== canon(Object.keys(auth.expected_after_apply ?? {}).sort())) throw new Error('the anchor tables are not exactly the authorized tables')
  const tables = {}
  for (const [t, d] of Object.entries(auth.expected_after_apply)) {
    if (!TABLE.test(t)) throw new Error(`bad table name ${t}`)
    const a = anchor.tables[t]; if (!a || a.delta !== d || a.n_before + a.delta !== a.n_after || typeof a.md5_before !== 'string') throw new Error(`${t}: the anchor does not carry the authorized delta ${d}`)
    const f = (await q(c, 'select ingest.promotion_fingerprint($1) f', [t]))[0].f
    if (Number(f.n) !== a.n_after || f.md5 !== a.md5_after) throw new Error(`${t}: the database no longer matches the independently anchored release state (now ${f.n} rows); the evidence is not written`)
    tables[t] = { n_before: a.n_before, md5_before: a.md5_before, delta: d, n_after: a.n_after, md5_after: a.md5_after }
  }
  return { format: RELEASE_EVIDENCE_FORMAT, release_key: auth.release_key, manifest_sha256: auth.manifest_sha256, audit_id: aud[0].id, authorization_sha256: authSha, r6_manifest_sha256: r6ManifestSha256,
    previous_evidence_sha256: previousEvidenceFile ? sha256Hex(fs.readFileSync(previousEvidenceFile)) : null,
    anchor: { snapshot_manifest_sha256: anchor.snapshot_manifest_sha256, before_manifest_sha256: anchor.before_manifest_sha256, post_apply_report_sha256: anchor.post_apply_report_sha256 }, captured_at: new Date().toISOString(), tables }
}
export const ANCHOR_FORMAT = 'bai-draft-release-anchor/1'

/** Pure checks (exported for the tests): the two snapshot manifests, the authorization and the executor's report. Returns { problems, tables }. */
export function anchorChecks (auth, mAfter, mBefore, report) {
  const problems = []; const tables = {}
  const exp = auth.expected_after_apply; const refresh = new Set(auth.allowed_refresh_changes ?? [])
  if (!exp || typeof exp !== 'object' || !Object.keys(exp).length) return { problems: ['the authorization has no expected row deltas'], tables }
  for (const [t, d] of Object.entries(exp)) {
    const a = mAfter.tables?.[t]; const b = mBefore.tables?.[t]
    if (!a || !b) { problems.push(`${t}: not in both snapshots`); continue }
    if (a.rows - b.rows !== d) problems.push(`${t}: the snapshots differ by ${a.rows - b.rows} rows, the authorization allows exactly ${d}`)
    tables[t] = { n_before: b.rows, delta: d, n_after: a.rows }
  }
  for (const t of Object.keys(mAfter.tables ?? {})) {
    if (Object.hasOwn(exp, t) || refresh.has(t)) continue
    if (mAfter.tables[t].sha256 !== mBefore.tables?.[t]?.sha256 || mAfter.tables[t].rows !== mBefore.tables?.[t]?.rows) problems.push(`${t}: changed between the snapshots but is neither an authorized table nor an authorized refresh table`)
  }
  for (const t of Object.keys(mBefore.tables ?? {})) if (!Object.hasOwn(mAfter.tables ?? {}, t)) problems.push(`${t}: missing from the post-release snapshot`)
  const deltas = Object.fromEntries((report.diffs ?? []).filter((d) => d.change === 'ROW COUNT').map((d) => [d.table, d.after - d.before]))
  for (const [t, d] of Object.entries(exp)) if (deltas[t] !== d) problems.push(`${t}: the executor's report shows delta ${deltas[t] ?? 'none'}, authorized ${d}`)
  for (const t of Object.keys(deltas)) if (!Object.hasOwn(exp, t) && !refresh.has(t)) problems.push(`${t}: the executor's report shows a row-count change that is not authorized`)
  if (!Array.isArray(report.row_level_old_rows_missing_or_modified) || report.row_level_old_rows_missing_or_modified.some((x) => !refresh.has(x.table))) problems.push("the executor's report shows pre-existing rows missing or modified in a table that is not an authorized refresh table (or has no row-level section)")
  return { problems, tables }
}

