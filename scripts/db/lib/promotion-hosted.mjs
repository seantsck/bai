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
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { canon, dependents, emergencyWithdraw, finishWithdrawal, loadPackage, openSession, promoteOnce, revertEmergency, statusOf, analyzeStatistics, vacuumAfterWithdrawal, verifyPackage, withdraw } from './promotion.mjs'
import { AUTHORIZATION_FORMAT, OPERATIONS, verifyAuthorization, sha256Hex } from './promotion-authorization.mjs'
import { MAX_BACKUP_AGE_MS, backupStartedAt, contentTreeHash, verifyBackupDir, verifyOffsiteEvidence, verifyPromotionRecordFile } from './final-parity.mjs'

export const EXPECTED_LEVEL = '034'
export const EXPECTED_MLB_TRANSACTIONS = 65
export class HostedPromotionError extends Error { constructor (m, extra = {}) { super(m); Object.assign(this, extra) } }
const refuse = (m, extra) => { throw new HostedPromotionError(m, extra) }
const q = async (c, sql, p) => (await c.query(sql, p)).rows

/** The 12 transaction read-model tables: the content tables must be empty (nothing transactional is public); the bookkeeping rows (refresh log, overview, withdrawal log) are only compared before and after. */
const RM_BOOKKEEPING = ['rm_transaction_overview', 'rm_transaction_refreshes', 'rm_transaction_withdrawals']
export async function readModelState (c) {
  const tabs = (await q(c, `select quote_ident(c.relname) t from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relname like 'rm\\_transaction%' order by 1`)).map((r) => r.t)
  const out = { tables: tabs.length, content_rows: 0, bookkeeping: {} }
  for (const t of tabs) { const n = Number((await q(c, `select count(*) n from public.${t}`))[0].n); if (RM_BOOKKEEPING.includes(t.replace(/"/g, ''))) out.bookkeeping[t] = n; else out.content_rows += n }
  return out
}

/**
 * Which lifecycle the transaction read models are in, taken from the database's OWN bookkeeping and never from a flag the caller supplies:
 *   PROMOTED   no refresh and no withdrawal is recorded: every read-model table must be empty (the state between the promotion and R7)
 *   REFRESHED  the latest recorded event is a refresh: the read model must be populated AND consistent with the refresh record, the overview and the publication grant
 *   WITHDRAWN  the latest recorded event is a withdrawal (rm_withdraw_transactions / rm_withdraw_category, migration 030). A withdrawal removes the named transactions and their child rows and
 *              invalidates the aggregates (overview, coverage, club-seasons are deleted) but KEEPS every other published transaction. So the remaining published count must equal the latest refresh's
 *              count minus the withdrawn counts logged since, the aggregates must be gone, and what remains must still be consistent (one generation, authorized categories, a source row each, no orphan
 *              child rows). A complete withdrawal is the case where nothing remains: every content table is then empty. A later refresh rebuilds everything and the state is REFRESHED again.
 * Anything else (rows without the matching record, a count that does not reconcile, stale aggregates, leaked categories, orphans) is a problem in every lifecycle.
 */
export async function readModelFacts (c) {
  const rm = await readModelState(c)
  const ref = (await q(c, 'select count(*)::int n, max(refreshed_at) at from public.rm_transaction_refreshes'))[0]
  const last = ref.n ? (await q(c, 'select generation_id::text g, transactions t, withheld_unauthorized w, refreshed_at at from public.rm_transaction_refreshes order by refreshed_at desc, generation_id desc limit 1'))[0] : null
  const wd = (await q(c, 'select count(*)::int n, max(withdrawn_at) at from public.rm_transaction_withdrawals'))[0]
  const since = (await q(c, 'select count(*)::int n, coalesce(sum(withdrawn_transactions), 0)::int withdrawn from public.rm_transaction_withdrawals where $1::timestamptz is null or withdrawn_at >= $1::timestamptz', [last?.at ?? null]))[0]
  const ov = await q(c, 'select generation_id::text g, transactions t, withheld_unauthorized w, verified_complete vc, display_authorized_categories cats from public.rm_transaction_overview')
  const pub = (await q(c, `select count(*)::int n, count(*) filter (where status = 'VERIFIED_COMPLETE')::int vc,
    coalesce(array_agg(distinct generation_id::text) filter (where generation_id is not null), '{}') gens,
    count(*) filter (where not exists (select 1 from public.transactions t where t.id = r.transaction_id))::int orphans,
    count(*) filter (where not exists (select 1 from public.rm_transaction_sources s where s.transaction_id = r.transaction_id))::int no_source from public.rm_transactions r`))[0]
  const childOrphans = (await q(c, `select ((select count(*) from public.rm_transaction_sources x where not exists (select 1 from public.rm_transactions r where r.transaction_id = x.transaction_id))
    + (select count(*) from public.rm_transaction_players x where not exists (select 1 from public.rm_transactions r where r.transaction_id = x.transaction_id))
    + (select count(*) from public.rm_transaction_assets x where not exists (select 1 from public.rm_transactions r where r.transaction_id = x.transaction_id))
    + (select count(*) from public.rm_transaction_packages x where not exists (select 1 from public.rm_transactions r where r.transaction_id = x.transaction_id))
    + (select count(*) from public.rm_transaction_returns x where not exists (select 1 from public.rm_transactions r where r.transaction_id = x.transaction_id))
    + (select count(*) from public.rm_transaction_followups x where not exists (select 1 from public.rm_transactions r where r.transaction_id = x.transaction_id)
                                                                  or not exists (select 1 from public.rm_transactions r where r.transaction_id = x.later_transaction_id)))::int as n`))[0].n
  const aggregates = (await q(c, 'select (select count(*) from public.rm_transaction_coverage)::int coverage, (select count(*) from public.rm_transaction_club_seasons)::int club_seasons'))[0]
  const granted = (await q(c, 'select attribution_category c from ingest.source_publication_grants')).map((r) => r.c)
  const cats = ov[0]?.cats ?? []
  const outside = cats.length ? (await q(c, 'select count(*)::int n from public.rm_transactions where not (source_categories <@ $1::text[])', [cats]))[0].n : pub.n
  const unauthorizedNow = (await q(c, 'select count(*)::int n from public.rm_transactions where not (source_categories <@ $1::text[])', [[...OPEN_CATEGORIES, ...granted]]))[0].n
  const lifecycle = wd.n && (!ref.n || new Date(wd.at) >= new Date(ref.at)) ? 'WITHDRAWN' : ref.n ? 'REFRESHED' : 'PROMOTED'
  return { lifecycle, rm, refreshes: { n: ref.n, last }, withdrawals: { n: wd.n, since_refresh: since.n, withdrawn_since_refresh: since.withdrawn }, overview: ov, aggregates, child_orphans: childOrphans,
    published: { ...pub, outside_authorized: outside, unauthorized_now: unauthorizedNow }, granted }
}

/** The openly licensed groups that migration 030 displays without a publication grant (rm_grant_changed lists the same four). */
const OPEN_CATEGORIES = ['CHADWICK_REGISTER', 'WIKIPEDIA', 'BAI_RESEARCH', 'WIKIDATA']

/** What every remaining published transaction must satisfy, whatever the lifecycle. */
const publishedProblems = (f, generation) => {
  const p = []; const { published } = f
  if (published.n && (published.gens.length !== 1 || published.gens[0] !== generation)) p.push(`published rows carry generation(s) ${published.gens.join(',') || 'none'}, the latest refresh is ${generation}`)
  if (published.unauthorized_now) p.push(`${published.unauthorized_now} published transaction(s) carry a source category that has no publication grant and is not openly licensed`)
  if (published.orphans) p.push(`${published.orphans} published transaction(s) do not exist`)
  if (published.no_source) p.push(`${published.no_source} published transaction(s) have no source row (no attribution)`)
  if (f.child_orphans) p.push(`${f.child_orphans} read-model child row(s) belong to a transaction that is not published`)
  return p
}

/** The problems a lifecycle's facts show. Pure, so every rule is tested without a database. */
export function readModelProblems (f) {
  const p = []; const { rm, refreshes, withdrawals, overview, published } = f
  if (f.lifecycle === 'PROMOTED') {
    if (rm.content_rows) p.push(`read-model rows: ${rm.content_rows} (no refresh is recorded)`)
    if (refreshes.n || withdrawals.n || (rm.bookkeeping.rm_transaction_overview ?? 0)) p.push('read-model bookkeeping exists without a recorded refresh')
  } else if (f.lifecycle === 'WITHDRAWN') {
    const base = refreshes.last?.t ?? 0; const expected = base - withdrawals.withdrawn_since_refresh
    if (expected < 0) p.push(`the withdrawal log removes ${withdrawals.withdrawn_since_refresh} transactions, the latest refresh published ${base}`)
    else if (published.n !== expected) p.push(`read-model rows after a withdrawal: ${published.n} published, ${expected} expected (refresh ${base} minus ${withdrawals.withdrawn_since_refresh} withdrawn)`)
    if (overview.length) p.push('the overview survived a withdrawal (a withdrawal deletes it)')
    if (f.aggregates.coverage || f.aggregates.club_seasons) p.push(`coverage (${f.aggregates.coverage}) or club-season (${f.aggregates.club_seasons}) aggregates survived a withdrawal`)
    if (published.n === 0 && rm.content_rows) p.push(`a complete withdrawal left ${rm.content_rows} content row(s)`)
    if (published.n && !refreshes.last) p.push('published rows without a recorded refresh')
    p.push(...publishedProblems(f, refreshes.last?.g))
  } else if (f.lifecycle === 'REFRESHED') {
    if (overview.length !== 1) p.push(`the overview has ${overview.length} row(s)`)
    else {
      const o = overview[0]; const l = refreshes.last
      if (o.g !== l.g) p.push(`the overview is generation ${o.g}, the latest refresh ${l.g}`)
      if (o.t !== published.n) p.push(`the overview says ${o.t} published transactions, the read model holds ${published.n}`)
      if (o.t !== l.t || o.w !== l.w) p.push('the overview differs from the refresh record')
      if (o.vc !== published.vc) p.push(`verified complete: overview ${o.vc}, read model ${published.vc}`)
      for (const cat of o.cats ?? []) if (!OPEN_CATEGORIES.includes(cat) && !f.granted.includes(cat)) p.push(`category ${cat} is displayed without a publication grant`)
    }
    if (published.outside_authorized) p.push(`${published.outside_authorized} published transaction(s) carry a source category that is not authorized for display`)
    p.push(...publishedProblems(f, refreshes.last?.g))
  }
  return p
}

// ---- read-only checks ----------------------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * Every relation through which the rows of a promotion could be read, found from the catalog: the delta tables, their inheritance parents and children, and every view or materialized view
 * that depends on any of them, transitively (a view over a view). A role can read a relation by a table-level or a COLUMN-level SELECT grant (has_any_column_privilege). A view that is
 * security_invoker needs the reader to hold the underlying privilege, so it exposes nothing by itself but is still traversed (an owner-rights view over it would expose the data).
 */
async function reachableRelations (c, manifest) {
  const out = new Map()   // oid -> { relation, kind, over, rows, invoker }
  for (const t of manifest.load_order) {
    const root = (await q(c, 'select $1::regclass::oid::int o, $1::regclass::text r', [t]))[0]; const rows = manifest.delta[t].n
    const queue = [{ oid: root.o, over: t }]; const seen = new Set()
    while (queue.length) {
      const { oid, over } = queue.shift(); if (seen.has(oid)) continue; seen.add(oid)
      const info = (await q(c, `select c.oid::int o, format('%I.%I', n.nspname, c.relname) r, c.relkind k, coalesce((select option_value from pg_options_to_table(c.reloptions) where option_name = 'security_invoker'), 'false') inv from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.oid = $1`, [oid]))[0]
      if (!out.has(oid)) out.set(oid, { oid, relation: info.r, kind: ({ r: 'table', p: 'table', v: 'view', m: 'materialized view', f: 'foreign table' })[info.k] ?? info.k, over, rows, invoker: ['true', 'on'].includes(String(info.inv).toLowerCase()) })
      const next = await q(c, `select v.oid::int o from pg_depend d join pg_rewrite rw on rw.oid = d.objid join pg_class v on v.oid = rw.ev_class where d.classid = 'pg_rewrite'::regclass and d.refobjid = $1 and v.relkind in ('v', 'm') and v.oid <> $1
        union select inhrelid::int from pg_inherits where inhparent = $1 union select inhparent::int from pg_inherits where inhrelid = $1`, [oid])
      for (const n of next) queue.push({ oid: n.o, over })
    }
  }
  return [...out.values()]
}
const readers = async (c, rels, roles) => {
  const out = []
  for (const r of rels) { const by = []; for (const role of roles) if ((await q(c, `select has_any_column_privilege($1, $2::oid, 'SELECT') ok`, [role, r.oid]))[0].ok) by.push(role); if (by.length) out.push({ ...r, by }) }
  return out
}
const shape = (list) => list.filter((x) => !(x.kind.endsWith('view') && x.invoker)).map(({ relation, rows, by, kind }) => ({ relation, rows, by, kind })).sort((x, y) => x.relation.localeCompare(y.relation))
/** What Data API clients (anon, authenticated) could read after the promotion, as the owner must acknowledge it. */
export async function restPublicDelta (c, manifest) { return shape(await readers(c, await reachableRelations(c, manifest), ['anon', 'authenticated'])).map(({ relation, rows, by }) => ({ relation, rows, by })) }
/** What the WEBSITE role (bai_site) could read: the real publication of the identities at commit. */
export async function websiteVisibleDelta (c, manifest) { return shape(await readers(c, await reachableRelations(c, manifest), ['bai_site'])).map(({ relation, rows, by }) => ({ relation, rows, by })) }

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
    facts.rest_public_delta = await restPublicDelta(c, pkg.manifest); facts.website_visible_delta = await websiteVisibleDelta(c, pkg.manifest)
  } finally { await c.query('rollback').catch(() => {}) }
  return { problems, facts }
}

/** The attribution evidence file: recomputed hash, the pages it covers, its age. */
export function checkEvidence (file, manifest, { now = Date.now(), bytes = null } = {}) {   // bytes: read once by the caller
  const p = []; let ev
  try { ev = JSON.parse(bytes ? bytes.toString('utf8') : fs.readFileSync(file, 'utf8')) } catch { return ['the attribution evidence file is missing or unreadable'] }
  const { evidence_sha256: claimed, ...doc } = ev
  const actual = sha256Hex(JSON.stringify(doc, null, 1))
  if (ev.format !== 'bai-live-attribution-evidence/1') p.push('unknown attribution evidence format')
  if (claimed !== actual) p.push('the attribution evidence does not match its own hash')
  if (claimed !== manifest.attribution.evidence_sha256) p.push('the attribution evidence is not the evidence the package pins')
  if (ev.all_pages_carry_the_statement !== true) p.push('the attribution evidence does not show the statement on every page')
  if (ev.captured_utc !== manifest.attribution.verified_at) p.push('the evidence capture time is not the package\'s verified_at')
  if (!(manifest.attribution.max_age_hours <= 72)) p.push('the package allows attribution evidence older than 72 hours')
  const age = now - Date.parse(ev.captured_utc); const max = Math.min(manifest.attribution.max_age_hours ?? 72, 72) * 3600e3
  if (!(age >= -60000 && age <= max)) p.push(`the attribution evidence is ${(age / 3600e3).toFixed(1)} hours old; the limit is ${max / 3600e3}`)
  if (!/^dpl_/.test(ev.deployment ?? '') || !/^[0-9a-f]{40}$/.test(ev.commit ?? '')) p.push('the attribution evidence names no real deployment and commit')
  return p
}

// ---- attempt records ------------------------------------------------------------------------------------------------------------------------------------------------------------------

const AMBIGUOUS_STATES = ['CREATED', 'STARTED', 'AMBIGUOUS', 'UNKNOWN']
const FAILED_STATES = (s) => ['REFUSED_BEFORE_WRITE', 'ROLLED_BACK', 'NOT_PROMOTED_CONFIRMED'].includes(s) || /^RESOLVED_/.test(s)
/**
 * Starts an attempt after checking the earlier ones of the same operation. An earlier attempt whose outcome is unresolved blocks everything until `status` resolves it. A repeat of an attempt
 * that FAILED (rolled back, or confirmed not to have happened) needs an owner authorization that names it (after_attempt). An earlier attempt that SUCCEEDED does not block a new, separately
 * authorized operation of the same kind (a second emergency after a revert, a second analyze): the database state decides whether that is allowed. A committed promotion is never repeated.
 */
export function beginAttempt (ledger, { manifest, operation, authSha, afterAttempt, now = new Date() }) {
  const prev = ledger.attempts(manifest).filter((a) => a.operation === operation)
  const last = prev.at(-1)
  if (operation === 'promote' && prev.some((a) => a.state === 'COMMITTED')) refuse('an earlier attempt already committed this promotion')
  if (last && AMBIGUOUS_STATES.includes(last.state)) refuse(`the previous ${operation} attempt ${last.id} is ${last.state}: resolve it first with "status" (read-only); it is never repeated automatically`)
  if (last && FAILED_STATES(last.state) && afterAttempt !== last.id) refuse(`an earlier ${operation} attempt (${last.id}, ${last.state}) did not complete: the owner's authorization must name it in after_attempt before another attempt is made`)
  if (afterAttempt && !(last && afterAttempt === last.id)) refuse('the authorization names an earlier attempt that is not this host\'s latest attempt')
  return ledger.start({ manifest, operation, authorization_sha256: authSha, started_at: now.toISOString() })
}

// ---- operations -----------------------------------------------------------------------------------------------------------------------------------------------------------------------

const readOnce = (f) => { try { return fs.readFileSync(f) } catch { return null } }
const SQLSTATE = /^[0-9A-Z]{5}$/
/**
 * A failure is "server-reported" only if it is an ERROR the server itself raised (a pg DatabaseError with severity ERROR and a SQLSTATE) outside the connection (08), operator-intervention (57P),
 * system (58) and internal (XX) classes: the server then aborted the transaction. Node socket codes that look like SQLSTATEs (EPIPE, EBUSY, EPERM), FATAL/PANIC messages and everything
 * without a severity leave the outcome unknown.
 */
export const serverReported = (e) => e?.severity === 'ERROR' && typeof e.code === 'string' && SQLSTATE.test(e.code) && !/^(08|57P|58|XX)/.test(e.code)

/** One consistent look at a manifest: writer sessions counted before and after the state is read twice; the answer is trustworthy only if no writer existed at either end and the state did not change. */
export async function observeState (c, sha) {
  const live = async () => (await q(c, `select count(*)::int n from pg_stat_activity where application_name = 'bai-promotion-hosted' and pid <> pg_backend_pid() and state <> 'idle'`))[0].n
  const w1 = await live(); const s1 = (await statusOf(c, sha)).state; const w2 = await live(); const s2 = (await statusOf(c, sha)).state
  return { state: s2, writers_before: w1, writers_after: w2, stable: s1 === s2, resolved: w1 === 0 && w2 === 0 && s1 === s2 }
}

/** Asks the database, on a NEW read-only connection, what became of a manifest. Polls while a writer session of the runner is still active. Never writes. */
export async function resolveState (connect, sha, { tries = 8, waitMs = 2500, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let last
  for (let i = 0; i < tries; i++) {
    let session
    try {
      session = await connect(); const c = session.client
      await c.query('begin read only')
      try { last = await observeState(c, sha); if (last.resolved) return last } finally { await c.query('rollback').catch(() => {}) }
    } catch (e) { last = { error: String(e.message).split('\n')[0].slice(0, 160), resolved: false } } finally { await session?.client?.end().catch(() => {}) }
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
  const evBytes = readOnce(evidenceFile); const parityBytes = readOnce(parityFile)   // each file is read ONCE; what is checked is what is hashed and used
  const va = verifyAuthorization(authFile, { operation: 'promote', projectRef, manifest: pkg.sha, keyring, pinned, now, isConsumed: ledger.isConsumed })
  problems.push(...va.problems.map((x) => `authorization: ${x}`))
  const evProblems = evBytes ? checkEvidence(evidenceFile, pkg.manifest, { now, bytes: evBytes }) : ['the attribution evidence file is missing or unreadable']
  problems.push(...evProblems.map((x) => `attribution evidence: ${x}`))
  if (va.auth && !evProblems.length && JSON.parse(evBytes.toString('utf8')).evidence_sha256 !== va.auth.attribution_evidence_sha256) problems.push('authorization: it names another attribution evidence')
  const rp = parityBytes ? verifyPromotionRecordFile(parityFile, { manifest: pkg.manifest, manifestSha: pkg.sha, projectRef, expectLevel: EXPECTED_LEVEL, now, bytes: parityBytes }) : ['parity record unreadable']; problems.push(...rp.map((x) => `parity record: ${x}`))
  if (!rp.length && va.auth) {
    const rec = JSON.parse(parityBytes.toString('utf8'))
    if (rec.offsite?.method !== 'automated-record' || !/^[0-9a-f]{64}$/.test(rec.offsite?.verification_record_sha256 ?? '')) problems.push('parity record: it was not made from the backup tool\'s verified off-site record (give --offsite-record to final-parity.mjs, not bare hashes)')
    if (sha256Hex(parityBytes) !== va.auth.parity_record_sha256) problems.push('authorization: it names another parity record')
    const b = va.auth.backup ?? {}
    if (path.basename(rec.backup.dir) !== b.name) problems.push('authorization: it names another backup')
    if (rec.backup.started_at !== new Date(Date.parse(b.t0)).toISOString()) problems.push('authorization: it names another backup T0')
    if (rec.backup.manifest_sha256 !== b.manifest_sha256 || rec.offsite.encrypted_sha256 !== b.archive_sha256 || rec.backup.tree_sha256 !== b.content_tree_sha256 || rec.offsite.verification_record_sha256 !== b.offsite_record_sha256) problems.push('authorization: its backup hashes are not the parity record\'s')
  }
  const parityExpires = parityBytes && !rp.length ? Date.parse(JSON.parse(parityBytes.toString('utf8')).expires_at) : null
  return { problems, pkg, auth: va.auth, authSha: va.sha256, parityExpires }
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
    const delta = canon(pre.facts.rest_public_delta)
    if (canon(auth.rest_public_delta) !== delta) pre.problems.push(`the REST-visible delta differs from the one the owner acknowledged (hosted would expose ${JSON.stringify(pre.facts.rest_public_delta.map((x) => `${x.relation}:${x.rows}`))})`)
    if (canon(auth.website_visible_delta) !== canon(pre.facts.website_visible_delta)) pre.problems.push(`the website-visible delta differs from the one the owner acknowledged (the website role would read ${JSON.stringify(pre.facts.website_visible_delta.map((x) => `${x.relation}:${x.rows}`))})`)
    log(`preflight: ${pre.problems.length ? 'FAILED' : 'ok'} (${pre.facts.tables_checked} tables compared, state ${pre.facts.state}, REST-visible: ${pre.facts.rest_public_delta.map((x) => `${x.relation}:${x.rows}`).join(', ') || 'none'})`)
    if (pre.problems.length) refuse(`PROMOTION REFUSED by the hosted preflight (nothing written):\n  ${pre.problems.join('\n  ')}`, { report: { stage: 'preflight', problems: pre.problems, facts: pre.facts } })
    // the preflight took time: the parity record must still be valid at the moment the write begins (15 s margin for the transaction's own start)
    if (!(r.parityExpires - now() > 15e3)) refuse('PROMOTION REFUSED: the parity record would expire before the write could begin; run the final parity again (nothing written)', { report: { stage: 'freshness', problems: ['parity record too old'] } })
    // the artifact is spent and the attempt recorded BEFORE the first write
    attempt = beginAttempt(ledger, { manifest: pkg.sha, operation: 'promote', authSha, afterAttempt: auth.after_attempt })
    ledger.consume(authSha, { operation: 'promote', manifest: pkg.sha, attempt: attempt.id })
    attempt.update({ state: 'STARTED' })
    const t0 = Date.now(); let outcome
    try { outcome = await promoteOnce(c, pkg) } catch (e) {
      const ms = Date.now() - t0
      if (serverReported(e)) {
        const check = await resolveState(connect, pkg.sha, { tries: 2, waitMs: 1000 })   // the server said it rolled back; ask anyway
        if (check.resolved && check.state === 'PROMOTED') { attempt.update({ state: 'AMBIGUOUS', error: 'server error but the ledger says PROMOTED', resolved_with: check }); refuse(`CONTRADICTION: the server reported an error (${e.code}) but the ledger says PROMOTED. Nothing was retried. Attempt ${attempt.id}.`, { report: { stage: 'promote', state: 'PROMOTED', attempt: attempt.id, resolution: check } }) }
        attempt.update({ state: 'ROLLED_BACK', error: String(e.message).split('\n')[0].slice(0, 200), sqlstate: e.code, resolved_with: check }); refuse(`NOT PROMOTED: the server refused and rolled back (${e.code}): ${String(e.message).split('\n')[0]}`, { report: { stage: 'promote', state: 'ROLLED_BACK', attempt: attempt.id, ms } })
      }
      attempt.update({ state: 'AMBIGUOUS', error: String(e.message).split('\n')[0].slice(0, 200) })
      try { c.connection?.stream?.destroy() } catch { /* the connection is abandoned either way */ }
      const st = await resolveState(connect, pkg.sha)
      attempt.update({ state: st.resolved ? classify(st.state) : 'UNKNOWN', resolved_with: st })
      refuse(`AMBIGUOUS RESULT (${String(e.message).split('\n')[0].slice(0, 120)}). Read-only ledger check: ${JSON.stringify(st)}. Attempt ${attempt.id} is recorded; NOTHING WAS RETRIED. Decide with the owner: run "status", then a new authorization naming after_attempt=${attempt.id}.`, { report: { stage: 'promote', state: st.resolved ? classify(st.state) : 'UNKNOWN', attempt: attempt.id, resolution: st } })
    }
    const ms = Date.now() - t0
    attempt.update({ state: outcome === 'PROMOTED' || outcome === 'ALREADY_PROMOTED' ? 'COMMITTED' : outcome, note: outcome === 'ALREADY_PROMOTED' ? 'the database reported ALREADY_PROMOTED (nothing was written by this attempt)' : undefined, ms })
    const post = await verifyPromoted(c, pkg, { expectedMlb: ctx.expectedMlb ?? EXPECTED_MLB_TRANSACTIONS, before: pre.facts.rm })
    attempt.update({ post_verification: post.ok ? 'PASS' : 'FAIL' })
    return { outcome, attempt: attempt.id, ms, preflight: pre.facts, post }
  } finally { await session.client.end().catch(() => {}) }
}

/** After a committed promotion, read-only: the state, the ledger counts, the baseline outside the delta unchanged, MLB trades, the read models in the lifecycle the database itself records (readModelFacts; expectLifecycle can only add a requirement), the grant unchanged, the REST-visible delta. */
export async function verifyPromoted (c, pkg, { expectedMlb = EXPECTED_MLB_TRANSACTIONS, before = null, expectLifecycle = null } = {}) {
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
    const rmf = await readModelFacts(c); facts.rm = rmf.rm; facts.read_model_lifecycle = rmf.lifecycle
    facts.read_model = { refreshes: rmf.refreshes.n, withdrawals: rmf.withdrawals.n, withdrawn_since_refresh: rmf.withdrawals.withdrawn_since_refresh, published: rmf.published.n, verified_complete: rmf.published.vc, generation: rmf.refreshes.last?.g ?? null }
    problems.push(...readModelProblems(rmf))
    if (before) {   // the promote runner's own post-check: nothing may have refreshed or withdrawn since the pre-check
      if (rmf.rm.content_rows) problems.push(`the read models hold ${rmf.rm.content_rows} row(s) straight after a promotion`)
      if (canon(rmf.rm.bookkeeping) !== canon(before.bookkeeping)) problems.push('the read-model bookkeeping changed: a refresh ran')
    }
    if (expectLifecycle && rmf.lifecycle !== expectLifecycle) problems.push(`read-model lifecycle is ${rmf.lifecycle}, expected ${expectLifecycle}`)
    const g = (await q(c, 'select count(*)::int n from ingest.source_publication_grants'))[0].n; facts.grants = g; if (g !== 1) problems.push(`publication grants: ${g}`)
    facts.rest_public_delta = await restPublicDelta(c, pkg.manifest); facts.website_visible_delta = await websiteVisibleDelta(c, pkg.manifest)
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
    const obs = await observeState(c, manifest); const st = { manifest_sha256: manifest, state: obs.state }; const blockers = await dependents(c, manifest).catch(() => null)
    await c.query('rollback')
    if (obs.resolved) for (const a of ctx.ledger.attempts(manifest)) if (AMBIGUOUS_STATES.includes(a.state) && Date.now() - Date.parse(a.started_at) > 60e3) ctx.ledger.mark(manifest, a.id, { state: a.operation === 'promote' ? classify(st.state) : `RESOLVED_${st.state}`, resolved_by: 'status', resolved_at: new Date().toISOString() })
    return { ...st, observation: obs, blockers, attempts: ctx.ledger.attempts(manifest).map((a) => ({ id: a.id, operation: a.operation, state: a.state })) }
  } finally { await session.client.end().catch(() => {}) }
}

/** Read-only: the post-promotion checks, runnable at any time (for example after an ambiguous result). Needs no authorization. */
export async function verifyPromotedHosted (ctx, pkgDir) {
  const pv = verifyPackage(pkgDir); if (pv.length) refuse(`package: ${pv.join('; ')}`)
  const pkg = loadPackage(pkgDir); const session = await ctx.connect(); const c = await openSession(session.client)
  try { return await verifyPromoted(c, pkg, { expectedMlb: ctx.expectedMlb ?? EXPECTED_MLB_TRANSACTIONS }) } finally { await session.client.end().catch(() => {}) }
}

/**
 * An UNSIGNED draft of the owner authorization for an operation, filled in from the files and (read-only) from the database, for the owner to review field by field and sign with their own
 * key. It carries no signature and is worthless until the owner signs it: this tool never signs anything, and a draft for an emergency close-api has the outage acknowledgement set to false
 * on purpose (the owner must change it to true deliberately).
 */
export async function draftAuthorization (ctx, { operation, manifest, pkgDir, parityFile, evidenceFile, reason, closeApi = false, withGrant = false, afterAttempt = null, hours = 1, now = Date.now() }) {
  if (!OPERATIONS.includes(operation)) refuse(`unknown operation ${operation}`)
  if (!Number.isFinite(hours) || hours <= 0) refuse('--hours must be a positive number')
  const draft = { format: AUTHORIZATION_FORMAT, operation, project_ref: ctx.projectRef, manifest_sha256: manifest, not_before: new Date(now).toISOString(), expires_at: new Date(now + Math.min(Math.max(hours, 0.1), 24) * 3600e3).toISOString(), nonce: crypto.randomBytes(16).toString('hex'), after_attempt: afterAttempt }
  if (operation !== 'promote') {
    if (!/^[0-9a-f]{64}$/.test(manifest ?? '')) refuse('--manifest must be a 64-hex manifest SHA-256')
    if (['withdraw', 'emergency', 'finish', 'revert'].includes(operation)) { if (!String(reason ?? '').trim()) refuse(`${operation} needs a --reason`); draft.reason = reason }
    if (operation === 'withdraw' && withGrant) draft.options = { with_grant: true }
    if (operation === 'emergency' && closeApi) draft.options = { close_api: true, acknowledge_site_outage: false }
    return draft
  }
  const pv = verifyPackage(pkgDir); if (pv.length) refuse(`package: ${pv.join('; ')}`)
  const pkg = loadPackage(pkgDir); draft.manifest_sha256 = pkg.sha
  const bad = [...checkEvidence(evidenceFile, pkg.manifest, { now }).map((x) => `attribution evidence: ${x}`), ...verifyPromotionRecordFile(parityFile, { manifest: pkg.manifest, manifestSha: pkg.sha, projectRef: ctx.projectRef, expectLevel: EXPECTED_LEVEL, now }).map((x) => `parity record: ${x}`)]
  if (bad.length) refuse(`cannot draft:\n  ${bad.join('\n  ')}`)
  const rec = JSON.parse(fs.readFileSync(parityFile, 'utf8')); const ev = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'))
  const session = await ctx.connect(); const c = await openSession(session.client)
  try {
    await c.query('begin read only'); let delta; let web; try { delta = await restPublicDelta(c, pkg.manifest); web = await websiteVisibleDelta(c, pkg.manifest) } finally { await c.query('rollback').catch(() => {}) }
    Object.assign(draft, { backup: { name: path.basename(rec.backup.dir), t0: rec.backup.started_at, manifest_sha256: rec.backup.manifest_sha256, archive_sha256: rec.offsite.encrypted_sha256, content_tree_sha256: rec.backup.tree_sha256, offsite_record_sha256: rec.offsite.verification_record_sha256 },
      parity_record_sha256: sha256Hex(fs.readFileSync(parityFile)), attribution_evidence_sha256: ev.evidence_sha256, rest_public_delta: delta, website_visible_delta: web })
  } finally { await session.client.end().catch(() => {}) }
  return draft
}
