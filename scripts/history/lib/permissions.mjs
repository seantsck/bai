// Source permission gates for the historical importer (research/history/sources.json, format bai-history-sources/2).
//
// A hostname on the allowlist is not a permission. Every use of a source is a separate grant, checked before the work runs:
//   fetch_targeted      a bounded, per-class request (one class or one page at a time)
//   fetch_bulk          automated league-wide or multi-year collection
//   process_local       reading cached copies to build batches, reports, plans or a local database
//   publish_repository  committing source-derived records, extracts or counts to the public Git repository
//   publish_site        writing source-derived records to the hosted database, which the public site reads
//
// Each grant has a state:
//   CLEARED     the source's license permits the use (an optional scope still applies)
//   LIMITED     permitted only inside its scope (years, request count); a LIMITED grant without a scope is refused
//   AUTHORIZED  permitted only with a documented authorization on file that names this use and covers the scope: a
//               reference, who granted it, when, an expiry (or none), and the document itself with its SHA-256
//   PENDING     a person must decide; refused
//   PROHIBITED  refused
// A source whose review date has passed is refused for every use except CLEARED processing, until it is reviewed again.
// Permission to download never implies permission to publish: the uses are independent.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const USES = ['fetch_targeted', 'fetch_bulk', 'process_local', 'publish_repository', 'publish_site']
export const STATES = ['CLEARED', 'LIMITED', 'AUTHORIZED', 'PENDING', 'PROHIBITED']

export class PermissionDenied extends Error {
  constructor (message, { source, use } = {}) { super(message); this.name = 'PermissionDenied'; this.source = source; this.use = use }
}

const today = (now) => (now ?? new Date()).toISOString().slice(0, 10)

export function loadCatalog (root) {
  const catalog = JSON.parse(fs.readFileSync(path.join(root, 'research/history/sources.json'), 'utf8'))
  const problems = validateCatalog(catalog)
  if (problems.length) throw new Error(`research/history/sources.json is invalid: ${problems.join('; ')}`)
  return catalog
}

/** Structural problems with a catalog (an empty list when it is well formed). */
export function validateCatalog (catalog) {
  const out = []
  if (catalog?.format !== 'bai-history-sources/2') out.push('format must be bai-history-sources/2')
  const ids = new Set()
  for (const s of catalog?.sources ?? []) {
    const at = s.id ?? '(no id)'
    if (!s.id || ids.has(s.id)) out.push(`${at}: missing or duplicate id`)
    ids.add(s.id)
    if (!s.review?.reviewed_on || !s.review?.review_due) out.push(`${at}: review.reviewed_on and review.review_due are required`)
    if (!s.license?.name) out.push(`${at}: license.name is required`)
    if (s.identity && (!((s.identity.hosts ?? []).length || (s.identity.url_prefixes ?? []).length) || !(s.identity.publisher || (s.identity.publishers ?? []).length) || !s.identity.source_type || !s.identity.key_pattern)) out.push(`${at}: identity needs hosts or url_prefixes, a publisher, source_type and key_pattern`)
    for (const use of USES) {
      const g = s.uses?.[use]
      if (!g) { out.push(`${at}: no grant for ${use}`); continue }
      if (!STATES.includes(g.state)) out.push(`${at}.${use}: unknown state ${g.state}`)
      if (g.state === 'LIMITED' && !g.scope) out.push(`${at}.${use}: LIMITED needs a scope`)
      if (!g.basis) out.push(`${at}.${use}: basis (why this state) is required`)
    }
    for (const use of Object.keys(s.uses ?? {})) if (!USES.includes(use)) out.push(`${at}: unknown use ${use}`)
  }
  return out
}

/** The catalog source that owns a source key (by prefix) or a host; null when none does. */
export const sourceForKey = (catalog, sourceKey) => {
  const k = String(sourceKey ?? '').trim().toLowerCase()
  return catalog.sources.find((s) => s.id === k || (s.source_key_prefixes ?? []).some((p) => k.startsWith(p))) ?? null
}
/**
 * The catalog source that governs a URL, by the hosts and URL patterns it declares for governance (governs_hosts,
 * governs_url_patterns): e.g. any statsapi.mlb.com URL, or an archive capture of a baseball-reference.com page.
 */
export function sourceForUrl (catalog, url) {
  if (!url) return null
  let host
  try { host = new URL(url).hostname.toLowerCase() } catch { return null }
  const u = String(url).toLowerCase()
  const matchHost = (h) => host === h || host.endsWith(`.${h}`)
  return catalog.sources.find((s) => (s.governs_hosts ?? []).some(matchHost) || (s.governs_url_patterns ?? []).some((p) => u.includes(p))) ?? null
}
/**
 * Every catalog source governing a cited source ({ source_key, url, source_type }): by key (case-insensitive prefix, and
 * the declared source_type when the entry requires one) AND by URL. All of them must permit a use, so an alias key or a
 * borrowed label cannot carry a governed source's data. A hist: key the catalog does not know is reported as `unknownHist`.
 */
export function governingSources (catalog, cited) {
  const out = []
  const byKey = sourceForKey(catalog, cited.source_key)
  if (byKey && (!byKey.required_source_type || byKey.required_source_type === cited.source_type)) out.push(byKey)
  const byUrl = sourceForUrl(catalog, cited.url)
  if (byUrl && !out.includes(byUrl)) out.push(byUrl)
  // An entry that declares an identity (hosts, publisher, type, key pattern) is matched by key only for a source that
  // really carries it: a label alone never makes a source "the" Wikidata source.
  const misidentified = out.filter((e) => e.identity && !matchesIdentity(e.identity, cited)).map((e) => e.id)
  return { sources: out, misidentified, unknownHist: !out.length && /^hist:/i.test(String(cited.source_key ?? '').trim()) }
}

/**
 * Whether a cited source carries the identity an entry requires: an https URL on one of its hosts (or under one of its URL
 * prefixes, ending at a path, query or the end), a publisher from its list, its source type and its key pattern. All of
 * them, never one label.
 */
export function matchesIdentity (identity, cited) {
  const url = String(cited.url ?? '')
  const under = (prefix) => url.startsWith(prefix) && ['/', '?', ''].includes(url.charAt(prefix.length))
  const urlOk = !/\s/.test(url) && ((identity.hosts ?? []).some((h) => under(`https://${h}`)) || (identity.url_prefixes ?? []).some(under))
  const publishers = identity.publishers ?? (identity.publisher ? [identity.publisher] : [])
  return urlOk &&
    (!publishers.length || publishers.includes(cited.publisher)) &&
    (!identity.source_type || cited.source_type === identity.source_type) &&
    (!identity.key_pattern || new RegExp(identity.key_pattern).test(String(cited.source_key ?? '')))
}

function scopeProblem (scope, ctx) {
  if (!scope) return null
  if (scope.years) {
    if (ctx.year == null) return 'the scope is limited to certain years and no year was given'
    if (!scope.years.includes(Number(ctx.year))) return `year ${ctx.year} is outside the scope (${scope.years.join(', ')})`
  }
  if (scope.years_from != null || scope.years_to != null) {
    if (ctx.year == null) return 'the scope is limited to a range of years and no year was given'
    if (scope.years_from != null && Number(ctx.year) < scope.years_from) return `year ${ctx.year} is before the scope (from ${scope.years_from})`
    if (scope.years_to != null && Number(ctx.year) > scope.years_to) return `year ${ctx.year} is after the scope (to ${scope.years_to})`
  }
  if (scope.max_requests_per_run != null && (ctx.requests ?? 0) > scope.max_requests_per_run) return `${ctx.requests} requests exceed the scope's ${scope.max_requests_per_run} per run`
  return null
}

function authorizationProblem (s, use, ctx, root) {
  const a = s.authorization
  if (!a) return 'no authorization is on file'
  for (const k of ['reference', 'granted_by', 'granted_on', 'document', 'document_sha256']) if (!a[k]) return `the authorization has no ${k}`
  if (!(a.uses ?? []).includes(use)) return `the authorization does not cover ${use}`
  const d = today(ctx.now)
  if (a.granted_on > d) return `the authorization starts on ${a.granted_on}`
  if (a.expires_on && a.expires_on < d) return `the authorization expired on ${a.expires_on}`
  if (!root) return 'the authorization document cannot be checked (no repository root)'
  const doc = path.resolve(root, a.document)
  if (!doc.startsWith(path.resolve(root) + path.sep) || !fs.existsSync(doc)) return `the authorization document ${a.document} is missing`
  if (crypto.createHash('sha256').update(fs.readFileSync(doc)).digest('hex') !== a.document_sha256) return `the authorization document ${a.document} does not match its checksum`
  return scopeProblem(a.scope, ctx)
}

/**
 * Whether `use` of the source is permitted for `ctx` ({ year, requests, now }). Returns { ok, state, reason }.
 * `source` is a catalog entry, or a source id / source key resolved through the catalog.
 */
export function checkUse (catalog, source, use, ctx = {}, { root } = {}) {
  const s = typeof source === 'string' ? sourceForKey(catalog, source) : source
  const name = typeof source === 'string' ? source : source?.id
  if (!s) return { ok: false, state: null, reason: `${name} is not in the source catalog` }
  if (!USES.includes(use)) return { ok: false, state: null, reason: `unknown use ${use}` }
  const g = s.uses?.[use]
  if (!g) return { ok: false, state: null, reason: `${s.id} has no grant for ${use}` }
  const deny = (reason) => ({ ok: false, state: g.state, reason: `${s.id}: ${use} refused: ${reason}` })
  if (s.review?.review_due && s.review.review_due < today(ctx.now) && !(g.state === 'CLEARED' && use === 'process_local')) return deny(`the permissions review was due on ${s.review.review_due}`)
  switch (g.state) {
    case 'CLEARED': { const p = scopeProblem(g.scope, ctx); return p ? deny(p) : { ok: true, state: g.state, reason: g.basis } }
    case 'LIMITED': { if (!g.scope) return deny('LIMITED without a scope'); const p = scopeProblem(g.scope, ctx); return p ? deny(p) : { ok: true, state: g.state, reason: g.basis } }
    case 'AUTHORIZED': { const p = authorizationProblem(s, use, ctx, root); return p ? deny(p) : { ok: true, state: g.state, reason: `authorization ${s.authorization.reference}` } }
    case 'PENDING': return deny(`a decision is pending (${g.basis})`)
    case 'PROHIBITED': return deny(`prohibited (${g.basis})`)
    default: return deny(`unknown state ${g.state}`)
  }
}

export function requireUse (catalog, source, use, ctx = {}, opts = {}) {
  const r = checkUse(catalog, source, use, ctx, opts)
  if (!r.ok) throw new PermissionDenied(r.reason, { source: typeof source === 'string' ? source : source?.id, use })
  return r
}

/**
 * Checks a research batch document (bai-research-import/1) for `use`: every source it cites that the catalog governs must
 * permit the use for the batch's year. Sources the catalog does not govern are returned in `ungoverned` (they follow the
 * research pipeline's own rules). Returns { governed, ungoverned }.
 */
export function requireBatchUse (catalog, doc, use, ctx = {}, opts = {}) {
  const year = ctx.year ?? batchYear(doc)
  const governed = []
  const ungoverned = []
  for (const key of new Set((doc.sources ?? []).map((s) => s.source_key))) {
    const s = sourceForKey(catalog, key)
    if (!s) { ungoverned.push(key); continue }
    const cited = doc.sources.find((x) => x.source_key === key)
    if (s.identity && !matchesIdentity(s.identity, cited)) throw new PermissionDenied(`${key}: claims to be ${s.id} but does not carry its identity (hosts, publisher, type, key pattern)`, { source: key, use })
    requireUse(catalog, s, use, { ...ctx, year }, opts)
    governed.push(key)
  }
  return { governed, ungoverned }
}

/** The draft year a batch is about, from its coverage claims (scope_key "1985-JUNE_AMATEUR"), else null. */
export function batchYear (doc) {
  const y = (doc.coverage_claims ?? []).map((c) => Number(String(c.scope_key ?? '').slice(0, 4))).find((n) => n >= 1965 && n <= 2100)
  return y ?? null
}

/**
 * Every year a batch touches: coverage claims; records' draft keys, period keys and signing dates; the acquisitions they
 * reference; and, for records that create no acquisition, the date or season they observe.
 */
export function batchYears (doc) {
  const years = new Set()
  const add = (v) => { const n = Number(String(v ?? '').slice(0, 4)); if (Number.isInteger(n) && n > 1800) years.add(n) }
  for (const c of doc.coverage_claims ?? []) add(c.scope_key)
  for (const r of doc.records ?? []) {
    add(r.draft_key); add(r.period_key); add(r.signing_date); add(r.acquisition?.draft_key); add(r.acquisition?.period_key)
    // Records that create no acquisition (outcome audits, trades) are dated by what they observe.
    add(r.date); add(r.observation_through_season)
  }
  return [...years].sort()
}

/**
 * Hosted publication gate. The hosted database feeds the public site, so a batch may be staged or applied there only if
 * every source it cites is catalogued (fail closed: an uncatalogued, aliased or unknown source has no approved permission
 * basis) and every catalog entry governing it, by key or by URL, grants publish_site for every year the batch touches.
 * Historical years (before catalog.historical_before) are also locked per database (025). A batch whose years cannot be
 * determined counts as historical; a batch with no sources is refused. Throws PermissionDenied on the first refusal.
 */
export function requireHostedPublication (catalog, doc, ctx = {}, opts = {}) {
  const before = catalog.historical_before ?? 2015
  const years = batchYears(doc)
  const historical = !years.length || years.some((y) => y < before)
  if (!(doc.sources ?? []).length) throw new PermissionDenied('a batch with no declared sources cannot reach hosted', { use: 'publish_site' })
  for (const cited of doc.sources) {
    const { sources, unknownHist, misidentified } = governingSources(catalog, cited)
    if (misidentified.length) throw new PermissionDenied(`${cited.source_key}: claims to be ${misidentified.join(', ')} but does not carry its identity (hosts, publisher, type, key pattern)`, { source: cited.source_key, use: 'publish_site' })
    if (unknownHist) throw new PermissionDenied(`${cited.source_key}: a hist: source key the catalog does not govern`, { source: cited.source_key, use: 'publish_site' })
    if (!sources.length) throw new PermissionDenied(`${cited.source_key}: not in the source catalog, so there is no approved basis to publish it on hosted (research/history/sources.json)`, { source: cited.source_key, use: 'publish_site' })
    for (const source of sources) for (const year of years.length ? years : [null]) requireUse(catalog, source, 'publish_site', { ...ctx, year }, opts)
  }
  return { years, historical }
}
