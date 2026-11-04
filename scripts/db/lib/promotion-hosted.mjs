// The gated, production-capable promotion runner (library). The CLI is scripts/db/promotion-hosted.mjs; the design, threat model and authorization contract are in
// docs/transactions/g6-hosted-promotion-runner.md. This module is separate from lib/promotion.mjs on purpose: that file (and scripts/db/promotion.mjs) stays LOCAL ONLY and still
// refuses every non-local database; nothing here relaxes it. A hosted write needs ALL of the following, each verified by this code from the files and the database themselves:
//   * an owner-signed authorization for this operation, project and manifest (lib/promotion-authorization.mjs)
//   * a verified package (hashes, counts, exclusions), bound to the hosted migration ledger and to the hosted baseline fingerprints
//   * promote only: a backup at level 034 at most six hours old with verified encrypted off-site evidence; a promotion parity record younger than 10 minutes (fresh read-only hosted
//     comparison and fresh logical export identical to that backup); live attribution evidence within its freshness window; the exact REST-visible delta acknowledged by the owner
//   * a verified TLS connection to the pinned project (lib/hosted-connection.mjs)
// Failure policy: every check fails closed; nothing is retried; a result that cannot be told from the connection is resolved by asking the ledger on a NEW read-only connection, and when
// even that fails the attempt stays UNKNOWN and a human decides.
import fs from 'node:fs'
import path from 'node:path'
import { canon, dependents, emergencyWithdraw, finishWithdrawal, loadPackage, openSession, promoteOnce, revertEmergency, statusOf, analyzeStatistics, vacuumAfterWithdrawal, verifyPackage, withdraw } from './promotion.mjs'
import { verifyAuthorization, sha256Hex } from './promotion-authorization.mjs'
import { MAX_BACKUP_AGE_MS, backupStartedAt, contentTreeHash, verifyBackupDir, verifyOffsiteEvidence, verifyPromotionRecordFile } from './final-parity.mjs'

export const EXPECTED_LEVEL = '034'
export const EXPECTED_MLB_TRANSACTIONS = 65
export class HostedPromotionError extends Error { constructor (m, extra = {}) { super(m); Object.assign(this, extra) } }
const refuse = (m, extra) => { throw new HostedPromotionError(m, extra) }
const q = async (c, sql, p) => (await c.query(sql, p)).rows

/** The 12 transaction read-model tables: the content tables must be empty (nothing transactional is public); the bookkeeping rows (refresh log, overview, withdrawal log) are only compared before and after. */
const RM_BOOKKEEPING = ['rm_transaction_overview', 'rm_transaction_refreshes', 'rm_transaction_withdrawals']
export async function readModelState (c) {
  const tabs = (await q(c, `select c.relname t from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relname like 'rm\\_transaction%' order by 1`)).map((r) => r.t)
  const out = { tables: tabs.length, content_rows: 0, bookkeeping: {} }
  for (const t of tabs) { const n = Number((await q(c, `select count(*) n from public."${t}"`))[0].n); if (RM_BOOKKEEPING.includes(t)) out.bookkeeping[t] = n; else out.content_rows += n }
  return out
}

// ---- read-only checks ----------------------------------------------------------------------------------------------------------------------------------------------------------------

/** Every relation a promotion would make readable through the Data API (anon or authenticated), by table privilege and through any non-invoker view over it. rows = what the package adds. */
export async function restPublicDelta (c, manifest) {
  const out = []
  for (const t of manifest.load_order) {
    const r = (await q(c, `select c.oid, c.relkind, has_table_privilege('anon', c.oid, 'SELECT') a, has_table_privilege('authenticated', c.oid, 'SELECT') u from pg_class c where c.oid = $1::regclass`, [t]))[0]
    if (r.a || r.u) out.push({ relation: t, kind: r.relkind === 'v' ? 'view' : 'table', rows: manifest.delta[t].n, readable_by: [r.a && 'anon', r.u && 'authenticated'].filter(Boolean) })
    const views = await q(c, `select distinct v.oid::regclass::text rel, coalesce((select option_value from pg_options_to_table(v.reloptions) where option_name = 'security_invoker'), 'false') inv,
        has_table_privilege('anon', v.oid, 'SELECT') a, has_table_privilege('authenticated', v.oid, 'SELECT') u
      from pg_depend d join pg_rewrite rw on rw.oid = d.objid join pg_class v on v.oid = rw.ev_class where d.refobjid = $1::regclass and v.relkind in ('v', 'm') and v.oid <> $1::regclass`, [t])
    for (const v of views) if ((v.a || v.u) && v.inv !== 'true') out.push({ relation: v.rel, kind: 'owner-rights view', over: t, rows: manifest.delta[t].n, readable_by: [v.a && 'anon', v.u && 'authenticated'].filter(Boolean) })
  }
  return out.sort((x, y) => x.relation.localeCompare(y.relation))
}

/** Everything about the hosted database that must hold before a promotion, in one repeatable-read read-only transaction. Returns { problems, facts }. */
export async function hostedPreflight (c, pkg, { expectedLevel = EXPECTED_LEVEL, requireSupabaseHistory = true, expectedMlb = EXPECTED_MLB_TRANSACTIONS } = {}) {
  const problems = []; const facts = {}
  await c.query('begin isolation level repeatable read read only')
  try {
    facts.snapshot = (await q(c, 'select pg_current_snapshot()::text s'))[0].s
    const ledger = await q(c, 'select version, checksum from bai_meta.schema_migrations order by version')
    const want = pkg.manifest.migrations; const have = Object.fromEntries(ledger.map((r) => [r.version, r.checksum]))
    facts.ledger_versions = ledger.length; facts.ledger_last = ledger.at(-1)?.version
    if (canon(want) !== canon(have)) problems.push('the hosted BAI migration ledger is not the ledger the package was built on (version or checksum differs)')
    if (facts.ledger_last !== expectedLevel) problems.push(`the hosted migration level is ${facts.ledger_last}, not ${expectedLevel}`)
    // hosted always has the platform's history table; only a local restore (whose history lives in a side file) may lack it, and only a library caller can say so (the CLI never does)
    if ((await q(c, "select to_regclass('supabase_migrations.schema_migrations') is not null e"))[0].e) {
      const sb = (await q(c, 'select version from supabase_migrations.schema_migrations order by version')).map((r) => r.version)
      facts.supabase_versions = sb.length
      if (canon(sb) !== canon(ledger.map((r) => r.version))) problems.push('the Supabase migration history and the BAI ledger do not list the same versions')
    } else if (requireSupabaseHistory) problems.push('the Supabase migration history table (supabase_migrations.schema_migrations) does not exist')
    else facts.supabase_versions = 'absent (local restore)'
    if (ledger.some((r) => r.version === '031')) problems.push('migration 031 is reserved and must be absent')
    const scope = (await q(c, 'select unnest(ingest.promotion_scope()) t')).map((r) => r.t)
    if (canon(scope) !== canon(pkg.manifest.baseline.scope)) problems.push('the hosted promotion scope differs from the package\'s')
    const drift = []
    for (const t of scope) { const f = (await q(c, 'select ingest.promotion_fingerprint($1) f', [t]))[0].f; if (canon(f) !== canon(pkg.manifest.baseline.fingerprints[t])) drift.push(t) }
    facts.tables_checked = scope.length; facts.drifted_tables = drift
    if (drift.length) problems.push(`the hosted baseline differs from the package's baseline in ${drift.length} table(s): ${drift.slice(0, 5).join(', ')}`)
    const st = await statusOf(c, pkg.sha); facts.state = st.state
    if (st.state !== 'NOT_PROMOTED') problems.push(`this manifest is ${st.state}, not NOT_PROMOTED`)
    const other = (await q(c, 'select count(*)::int n from ingest.promotion_manifests'))[0].n; facts.other_manifests = other
    if (other !== 0) problems.push(`the hosted database already holds ${other} promotion manifest(s)`)
    const rm = await readModelState(c); facts.rm = rm
    if (rm.tables !== 12) problems.push(`the database has ${rm.tables} transaction read-model tables, expected 12`)
    if (rm.content_rows !== 0) problems.push(`the transaction read models hold ${rm.content_rows} row(s); a promotion starts from empty read models`)
    const grant = (await q(c, 'select basis_reference, scope_note, granted_at from ingest.source_publication_grants where attribution_category = $1', [pkg.manifest.category]))[0]
    const bind = grant ? sha256Hex(grant.basis_reference + '\n' + grant.scope_note) : null; facts.grant_present = Boolean(grant)
    if (!grant) problems.push(`there is no ${pkg.manifest.category} publication grant on the hosted database`)
    else if (bind !== pkg.manifest.authorization.grant_binding_sha256) problems.push('the hosted publication grant is not the grant the package was bound to')
    const exp = (pkg.manifest.authorization.expires_on); facts.authorization_expires_on = exp
    if (!(new Date(exp + 'T23:59:59Z').getTime() > Date.now())) problems.push(`the package's authorization window ended ${exp}`)
    const mlb = (await q(c, `select count(*)::int n from public.transactions t join public.sources s on s.id = t.source_id where s.attribution_category = 'MLB'`))[0].n; facts.mlb_transactions = mlb
    if (mlb !== expectedMlb) problems.push(`the hosted database holds ${mlb} MLB transactions, expected ${expectedMlb}`)
    facts.rest_public_delta = await restPublicDelta(c, pkg.manifest)
  } finally { await c.query('rollback').catch(() => {}) }
  return { problems, facts }
}

/** The attribution evidence file: recomputed hash, the pages it covers, its age. */
export function checkEvidence (file, manifest, { now = Date.now() } = {}) {
  const p = []; let ev
  try { ev = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return ['the attribution evidence file is missing or unreadable'] }
  const { evidence_sha256: claimed, ...doc } = ev
  const actual = sha256Hex(JSON.stringify(doc, null, 1))
  if (ev.format !== 'bai-live-attribution-evidence/1') p.push('unknown attribution evidence format')
  if (claimed !== actual) p.push('the attribution evidence does not match its own hash')
  if (claimed !== manifest.attribution.evidence_sha256) p.push('the attribution evidence is not the evidence the package pins')
  if (ev.all_pages_carry_the_statement !== true) p.push('the attribution evidence does not show the statement on every page')
  if (ev.captured_utc !== manifest.attribution.verified_at) p.push('the evidence capture time is not the package\'s verified_at')
  const age = now - Date.parse(ev.captured_utc); const max = (manifest.attribution.max_age_hours ?? 72) * 3600e3
  if (!(age >= -60000 && age <= max)) p.push(`the attribution evidence is ${(age / 3600e3).toFixed(1)} hours old; the limit is ${max / 3600e3}`)
  if (!/^dpl_/.test(ev.deployment ?? '') || !/^[0-9a-f]{40}$/.test(ev.commit ?? '')) p.push('the attribution evidence names no real deployment and commit')
  return p
}

// ---- attempt records ------------------------------------------------------------------------------------------------------------------------------------------------------------------

const RESOLVED_OK_TO_RETRY = (s) => ['REFUSED_BEFORE_WRITE', 'ROLLED_BACK', 'NOT_PROMOTED_CONFIRMED'].includes(s) || /^RESOLVED_/.test(s)
/** Starts an attempt after checking the earlier ones. Returns the attempt (with update()). */
export function beginAttempt (ledger, { manifest, operation, authSha, afterAttempt, now = new Date() }) {
  const prev = ledger.attempts(manifest).filter((a) => a.operation === operation)
  const last = prev.at(-1)
  if (operation === 'promote' && prev.some((a) => a.state === 'COMMITTED')) refuse('an earlier attempt already committed this promotion')
  if (last && !RESOLVED_OK_TO_RETRY(last.state)) refuse(`the previous ${operation} attempt ${last.id} is ${last.state}: resolve it first with "status" (read-only); it is never repeated automatically`)
  if (last && afterAttempt !== last.id) refuse(`an earlier ${operation} attempt (${last.id}, ${last.state}) exists: the owner's authorization must name it in after_attempt before another attempt is made`)
  if (!last && afterAttempt) refuse('the authorization names an earlier attempt that this host has no record of')
  return ledger.start({ manifest, operation, authorization_sha256: authSha, started_at: now.toISOString() })
}

// ---- operations -----------------------------------------------------------------------------------------------------------------------------------------------------------------------

const SQLSTATE = /^[0-9A-Z]{5}$/
/** A failure that carries a SQLSTATE was reported by the server, which then aborted the transaction. Anything else (socket, timeout in the client) leaves the outcome unknown. */
export const serverReported = (e) => typeof e?.code === 'string' && SQLSTATE.test(e.code)

/** Asks the database, on a NEW read-only connection, what became of a manifest. Polls briefly so a transaction still finishing on the server is not misread. Never writes. */
export async function resolveState (connect, sha, { tries = 6, waitMs = 2500, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let last
  for (let i = 0; i < tries; i++) {
    let session
    try {
      session = await connect(); const c = session.client
      await c.query('begin read only')
      try {
        const st = await statusOf(c, sha)
        const live = (await q(c, `select count(*)::int n from pg_stat_activity where application_name = 'bai-promotion-hosted' and pid <> pg_backend_pid() and state <> 'idle'`))[0].n
        last = { state: st.state, writer_sessions_still_active: live }
        if (live === 0) return { ...last, resolved: true }
      } finally { await c.query('rollback').catch(() => {}) }
    } catch (e) { last = { error: String(e.message).split('\n')[0].slice(0, 160) } } finally { await session?.client?.end().catch(() => {}) }
    await sleep(waitMs)
  }
  return { ...(last ?? {}), resolved: false }
}

const classify = (state) => (state === 'PROMOTED' ? 'COMMITTED' : state === 'NOT_PROMOTED' ? 'NOT_PROMOTED_CONFIRMED' : state === 'WITHDRAWN' ? 'WITHDRAWN' : state ?? 'UNKNOWN')

/** The checks that need no database, for a promotion. Returns { problems, pkg, auth, record }. */
export function promoteInputs ({ pkgDir, authFile, evidenceFile, parityFile, env, projectRef, keyring, pinned, ledger, now = Date.now() }) {
  const problems = []
  const pv = verifyPackage(pkgDir); problems.push(...pv.map((x) => `package: ${x}`))
  if (pv.length) return { problems }
  const pkg = loadPackage(pkgDir)
  const va = verifyAuthorization(authFile, { operation: 'promote', projectRef, manifest: pkg.sha, keyring, pinned, now, isConsumed: ledger.isConsumed })
  problems.push(...va.problems.map((x) => `authorization: ${x}`))
  problems.push(...checkEvidence(evidenceFile, pkg.manifest, { now }).map((x) => `attribution evidence: ${x}`))
  if (va.auth && !problems.some((x) => x.startsWith('attribution evidence'))) {
    const evHash = JSON.parse(fs.readFileSync(evidenceFile, 'utf8')).evidence_sha256
    if (va.auth.attribution_evidence_sha256 !== evHash) problems.push('authorization: it names another attribution evidence')
  }
  const rp = verifyPromotionRecordFile(parityFile, { manifest: pkg.manifest, manifestSha: pkg.sha, projectRef, expectLevel: EXPECTED_LEVEL, now }); problems.push(...rp.map((x) => `parity record: ${x}`))
  if (!rp.length && va.auth) {
    const rec = JSON.parse(fs.readFileSync(parityFile, 'utf8'))
    if (rec.offsite?.method !== 'automated-record' || !/^[0-9a-f]{64}$/.test(rec.offsite?.verification_record_sha256 ?? '')) problems.push('parity record: it was not made from the backup tool\'s verified off-site record (give --offsite-record to final-parity.mjs, not bare hashes)')
    if (sha256Hex(fs.readFileSync(parityFile)) !== va.auth.parity_record_sha256) problems.push('authorization: it names another parity record')
    const b = va.auth.backup ?? {}
    if (path.basename(rec.backup.dir) !== b.name) problems.push('authorization: it names another backup')
    if (rec.backup.started_at !== new Date(Date.parse(b.t0)).toISOString()) problems.push('authorization: it names another backup T0')
    if (rec.backup.manifest_sha256 !== b.manifest_sha256 || rec.offsite.encrypted_sha256 !== b.archive_sha256 || rec.backup.tree_sha256 !== b.content_tree_sha256 || rec.offsite.verification_record_sha256 !== b.offsite_record_sha256) problems.push('authorization: its backup hashes are not the parity record\'s')
  }
  return { problems, pkg, auth: va.auth, authSha: va.sha256 }
}

/**
 * Promote. ONE transaction, ONE attempt, no retry. ctx: { connect, projectRef, keyring, pinned, ledger, env, log, now }.
 * Returns the report; throws HostedPromotionError (with .report) for a refusal or a failure.
 */
export async function promoteHosted (ctx, { pkgDir, authFile, evidenceFile, parityFile }) {
  const { connect, ledger, log = () => {}, now = () => Date.now() } = ctx
  const r = promoteInputs({ pkgDir, authFile, evidenceFile, parityFile, env: ctx.env, projectRef: ctx.projectRef, keyring: ctx.keyring, pinned: ctx.pinned, ledger, now: now() })
  if (r.problems.length) refuse(`PROMOTION REFUSED before any connection:\n  ${r.problems.join('\n  ')}`, { report: { stage: 'inputs', problems: r.problems } })
  const { pkg, auth, authSha } = r
  const session = await connect(); const c = await openSession(session.client)
  let attempt
  try {
    const pre = await hostedPreflight(c, pkg, { requireSupabaseHistory: ctx.requireSupabaseHistory !== false, expectedMlb: ctx.expectedMlb ?? EXPECTED_MLB_TRANSACTIONS })
    const delta = canon(pre.facts.rest_public_delta.map(({ relation, rows, readable_by: by }) => ({ relation, rows, by })))
    if (canon(auth.rest_public_delta) !== delta) pre.problems.push(`the REST-visible delta differs from the one the owner acknowledged (hosted would expose ${JSON.stringify(pre.facts.rest_public_delta.map((x) => `${x.relation}:${x.rows}`))})`)
    log(`preflight: ${pre.problems.length ? 'FAILED' : 'ok'} (${pre.facts.tables_checked} tables compared, state ${pre.facts.state}, REST-visible: ${pre.facts.rest_public_delta.map((x) => `${x.relation}:${x.rows}`).join(', ') || 'none'})`)
    if (pre.problems.length) refuse(`PROMOTION REFUSED by the hosted preflight (nothing written):\n  ${pre.problems.join('\n  ')}`, { report: { stage: 'preflight', problems: pre.problems, facts: pre.facts } })
    // the artifact is spent and the attempt recorded BEFORE the first write
    attempt = beginAttempt(ledger, { manifest: pkg.sha, operation: 'promote', authSha, afterAttempt: auth.after_attempt })
    ledger.consume(authSha, { operation: 'promote', manifest: pkg.sha, attempt: attempt.id })
    attempt.update({ state: 'STARTED' })
    const t0 = Date.now(); let outcome
    try { outcome = await promoteOnce(c, pkg) } catch (e) {
      const ms = Date.now() - t0
      if (serverReported(e)) { attempt.update({ state: 'ROLLED_BACK', error: String(e.message).split('\n')[0].slice(0, 200), sqlstate: e.code }); refuse(`NOT PROMOTED: the server refused and rolled back (${e.code}): ${String(e.message).split('\n')[0]}`, { report: { stage: 'promote', state: 'ROLLED_BACK', attempt: attempt.id, ms } }) }
      attempt.update({ state: 'AMBIGUOUS', error: String(e.message).split('\n')[0].slice(0, 200) })
      try { c.connection?.stream?.destroy() } catch { /* the connection is abandoned either way */ }
      const st = await resolveState(connect, pkg.sha)
      attempt.update({ state: st.resolved ? classify(st.state) : 'UNKNOWN', resolved_with: st })
      refuse(`AMBIGUOUS RESULT (${String(e.message).split('\n')[0].slice(0, 120)}). Read-only ledger check: ${JSON.stringify(st)}. Attempt ${attempt.id} is recorded; NOTHING WAS RETRIED. Decide with the owner: run "status", then a new authorization naming after_attempt=${attempt.id}.`, { report: { stage: 'promote', state: st.resolved ? classify(st.state) : 'UNKNOWN', attempt: attempt.id, resolution: st } })
    }
    const ms = Date.now() - t0
    attempt.update({ state: outcome === 'PROMOTED' ? 'COMMITTED' : outcome === 'ALREADY_PROMOTED' ? 'COMMITTED' : outcome, ms })
    const post = await verifyPromoted(c, pkg, { expectedMlb: ctx.expectedMlb ?? EXPECTED_MLB_TRANSACTIONS, before: pre.facts.rm })
    attempt.update({ post_verification: post.ok ? 'PASS' : 'FAIL' })
    return { outcome, attempt: attempt.id, ms, preflight: pre.facts, post }
  } finally { await session.client.end().catch(() => {}) }
}

/** After a committed promotion, read-only: the state, the ledger counts, the baseline outside the delta unchanged, MLB trades, empty read models, the grant unchanged, the REST-visible delta. */
export async function verifyPromoted (c, pkg, { expectedMlb = EXPECTED_MLB_TRANSACTIONS, before = null } = {}) {
  const problems = []; const facts = {}
  await c.query('begin isolation level repeatable read read only')
  try {
    const st = await statusOf(c, pkg.sha); facts.state = st.state; if (st.state !== 'PROMOTED') problems.push(`state is ${st.state}`)
    const ledgerRows = (await q(c, 'select table_name t, n from ingest.promotion_ledger where manifest_sha256 = $1 order by 1', [pkg.sha]))
    facts.ledger_tables = ledgerRows.length; facts.ledger_rows = ledgerRows.reduce((a, r) => a + r.n, 0)
    const wantRows = Object.values(pkg.manifest.delta).reduce((a, d) => a + d.n, 0); if (facts.ledger_rows !== wantRows) problems.push(`the ledger holds ${facts.ledger_rows} rows, the manifest ${wantRows}`)
    const perTable = Object.fromEntries(ledgerRows.map((r) => [r.t, r.n])); for (const [tb, d] of Object.entries(pkg.manifest.delta)) if (perTable[tb] !== d.n) problems.push(`ledger rows for ${tb}: ${perTable[tb]}, manifest ${d.n}`)
    const bad = []; const scope = pkg.manifest.baseline.scope
    for (const t of scope) {
      const f = (await q(c, 'select ingest.promotion_fingerprint($1) f', [t]))[0].f
      const want = pkg.manifest.after[t] ?? pkg.manifest.baseline.fingerprints[t]
      if (canon(f) !== canon(want)) bad.push(t)
    }
    facts.tables_compared = scope.length; facts.tables_differing = bad; if (bad.length) problems.push(`tables differ from the release state: ${bad.slice(0, 5).join(', ')}`)
    facts.mlb_transactions = (await q(c, `select count(*)::int n from public.transactions t join public.sources s on s.id = t.source_id where s.attribution_category = 'MLB'`))[0].n
    if (facts.mlb_transactions !== expectedMlb) problems.push(`MLB transactions: ${facts.mlb_transactions}`)
    const rm = await readModelState(c); facts.rm = rm
    if (rm.content_rows) problems.push(`read-model rows: ${rm.content_rows}`)
    if (before && canon(rm.bookkeeping) !== canon(before.bookkeeping)) problems.push('the read-model bookkeeping changed: a refresh ran')
    const g = (await q(c, 'select count(*)::int n from ingest.source_publication_grants'))[0].n; facts.grants = g; if (g !== 1) problems.push(`publication grants: ${g}`)
    facts.rest_public_delta = await restPublicDelta(c, pkg.manifest)
  } finally { await c.query('rollback').catch(() => {}) }
  return { ok: problems.length === 0, problems, facts }
}

/** withdraw | emergency | finish | revert | analyze: the exact manifest, an owner-signed authorization each, one call, no retry. */
export async function operateHosted (ctx, operation, { manifest, authFile }) {
  const { connect, ledger } = ctx
  if (!/^[0-9a-f]{64}$/.test(manifest ?? '')) refuse('--manifest must be a 64-hex manifest SHA-256')
  const va = verifyAuthorization(authFile, { operation, projectRef: ctx.projectRef, manifest, keyring: ctx.keyring, pinned: ctx.pinned, now: (ctx.now ?? Date.now)(), isConsumed: ledger.isConsumed })
  if (va.problems.length) refuse(`${operation.toUpperCase()} REFUSED before any connection:\n  ${va.problems.join('\n  ')}`, { report: { stage: 'inputs', problems: va.problems } })
  const auth = va.auth; const reason = auth.reason
  const session = await connect(); const c = await openSession(session.client)
  let attempt
  try {
    await c.query('begin read only')
    const before = await statusOf(c, manifest); await c.query('rollback')
    const need = { withdraw: 'PROMOTED', emergency: 'PROMOTED', finish: 'EMERGENCY', revert: 'EMERGENCY' }[operation]
    if (need && before.state !== need) refuse(`${operation.toUpperCase()} REFUSED: the manifest is ${before.state}, not ${need} (nothing written)`, { report: { stage: 'state', state: before.state } })
    if (operation === 'analyze' && before.state === 'NOT_PROMOTED') refuse('ANALYZE REFUSED: the manifest was never promoted (nothing written)')
    attempt = beginAttempt(ledger, { manifest, operation, authSha: va.sha256, afterAttempt: auth.after_attempt ?? null })
    ledger.consume(va.sha256, { operation, manifest, attempt: attempt.id }); attempt.update({ state: 'STARTED', state_before: before.state })
    const t0 = Date.now(); let result
    try {
      if (operation === 'withdraw') result = await withdraw(c, manifest, reason, { withdrawGrant: auth.options?.with_grant === true })
      else if (operation === 'emergency') result = await emergencyWithdraw(c, manifest, reason, { closeApi: auth.options?.close_api === true })
      else if (operation === 'finish') result = await finishWithdrawal(c, manifest, reason)
      else if (operation === 'revert') result = await revertEmergency(c, manifest, reason)
      else result = await analyzeStatistics(c, manifest)
    } catch (e) {
      const ms = Date.now() - t0
      if (serverReported(e)) { attempt.update({ state: 'ROLLED_BACK', error: String(e.message).split('\n')[0].slice(0, 200), sqlstate: e.code }); refuse(`${operation.toUpperCase()} REFUSED by the server (${e.code}): ${String(e.message).split('\n')[0]}. Nothing changed (the call is atomic).`, { report: { stage: operation, state: 'ROLLED_BACK', attempt: attempt.id, ms } }) }
      attempt.update({ state: 'AMBIGUOUS', error: String(e.message).split('\n')[0].slice(0, 200) })
      try { c.connection?.stream?.destroy() } catch { /* abandoned */ }
      const st = await resolveState(connect, manifest)
      attempt.update({ state: st.resolved ? `RESOLVED_${st.state}` : 'UNKNOWN', resolved_with: st })
      refuse(`AMBIGUOUS RESULT of ${operation} (${String(e.message).split('\n')[0].slice(0, 120)}). Read-only ledger check: ${JSON.stringify(st)}. Attempt ${attempt.id} recorded; NOTHING WAS RETRIED. A withdrawal that did not commit leaves planner statistics to repair: run "analyze" only with a new authorization.`, { report: { stage: operation, state: st.resolved ? st.state : 'UNKNOWN', attempt: attempt.id, resolution: st } })
    }
    attempt.update({ state: operation === 'withdraw' || operation === 'finish' ? 'WITHDRAWN' : 'COMMITTED', ms: Date.now() - t0 })
    const after = await statusOf(c, manifest)
    return { operation, attempt: attempt.id, ms: Date.now() - t0, result, state_after: after.state, dependents: operation === 'emergency' ? await dependents(c, manifest).catch(() => null) : undefined }
  } finally { await session.client.end().catch(() => {}) }
}

/** Read-only status of a manifest (no authorization needed), resolving any unresolved local attempt records from what the database says. */
export async function statusHosted (ctx, manifest) {
  if (!/^[0-9a-f]{64}$/.test(manifest ?? '')) refuse('--manifest must be a 64-hex manifest SHA-256')
  const session = await ctx.connect(); const c = await openSession(session.client)
  try {
    await c.query('begin read only')
    const st = await statusOf(c, manifest); const blockers = await dependents(c, manifest).catch(() => null)
    await c.query('rollback')
    for (const a of ctx.ledger.attempts(manifest)) if (['STARTED', 'AMBIGUOUS', 'UNKNOWN', 'CREATED'].includes(a.state)) ctx.ledger.mark(manifest, a.id, { state: a.operation === 'promote' ? classify(st.state) : `RESOLVED_${st.state}`, resolved_by: 'status', resolved_at: new Date().toISOString() })
    return { ...st, blockers, attempts: ctx.ledger.attempts(manifest).map((a) => ({ id: a.id, operation: a.operation, state: a.state })) }
  } finally { await session.client.end().catch(() => {}) }
}

/** Read-only: the post-promotion checks, runnable at any time (for example after an ambiguous result). Needs no authorization. */
export async function verifyPromotedHosted (ctx, pkgDir) {
  const pv = verifyPackage(pkgDir); if (pv.length) refuse(`package: ${pv.join('; ')}`)
  const pkg = loadPackage(pkgDir); const session = await ctx.connect(); const c = await openSession(session.client)
  try { return await verifyPromoted(c, pkg, { expectedMlb: ctx.expectedMlb ?? EXPECTED_MLB_TRANSACTIONS }) } finally { await session.client.end().catch(() => {}) }
}
