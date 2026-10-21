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
export const sourceForKey = (catalog, sourceKey) =>
  catalog.sources.find((s) => s.id === sourceKey || (s.source_key_prefixes ?? []).some((p) => sourceKey.startsWith(p))) ?? null
export const sourceForHost = (catalog, host) => catalog.sources.find((s) => (s.hosts ?? []).includes(host)) ?? null

function scopeProblem (scope, ctx) {
  if (!scope) return null
  if (scope.years) {
    if (ctx.year == null) return 'the scope is limited to certain years and no year was given'
    if (!scope.years.includes(Number(ctx.year))) return `year ${ctx.year} is outside the scope (${scope.years.join(', ')})`
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
