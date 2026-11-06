// R8B evidence packages: a LOCAL-ONLY, structured RESEARCH PROPOSAL for one published trade. A package records what is known (from BAI's own record), which candidate second sources
// were found (citation metadata only), what each would cover, whether it looks independent, whether BAI may display it, and what is still unresolved. It is never a verification:
// every human-verification field must be null, and the strongest statements a package may make are "proposed". Source text is never stored (fields are short and bounded), source
// categories are derived from the host and cannot be declared, and packages are written outside every git work tree.
import fs from 'node:fs'
import path from 'node:path'
import { assertOutputAllowed } from './r8b-queue.mjs'

export const FORMAT = 'bai-r8b-evidence-package/1'
export const OPEN_CATEGORIES = ['CHADWICK_REGISTER', 'WIKIPEDIA', 'BAI_RESEARCH', 'WIKIDATA']   // displayable without a publication grant (migration 030)
export const GRANTED_CATEGORIES = ['RETROSHEET']                                                   // publication grants held today (ingest.source_publication_grants)
export const ORIGIN_GROUP = 'retrosheet-archive'

/** The category of a citation follows from its host. It is NEVER declared by the researcher, so it cannot be relabelled to get around a permission. */
const HOSTS = [[/(^|\.)mlb\.com$/, 'MLB'], [/(^|\.)baseball-reference\.com$|(^|\.)sports-reference\.com$/, 'BASEBALL_REFERENCE'], [/(^|\.)wikipedia\.org$/, 'WIKIPEDIA'], [/(^|\.)wikidata\.org$/, 'WIKIDATA'], [/(^|\.)retrosheet\.org$/, 'RETROSHEET'], [/(^|\.)chadwick-bureau\.com$|(^|\.)github\.com$/, 'CHADWICK_REGISTER']]
export const categoryOfUrl = (url) => { const host = new URL(url).hostname.toLowerCase(); return (HOSTS.find(([re]) => re.test(host)) ?? [null, 'OTHER_PUBLICATION'])[1] }
export const rightsStatus = (category) => (OPEN_CATEGORIES.includes(category) ? 'DISPLAY_CLEARED' : GRANTED_CATEGORIES.includes(category) ? 'GRANTED' : 'NEEDS_PERMISSION')
/** Hosts whose records are known to be partly derived from the origin (Retrosheet): never better than LIKELY_DERIVED without a human lineage review. */
const DERIVED_HOSTS = /(^|\.)retrosheet\.org$|(^|\.)baseball-reference\.com$|(^|\.)sports-reference\.com$|(^|\.)chadwick-bureau\.com$/

export const ROLES = ['PRIMARY_ANNOUNCEMENT', 'CORROBORATION', 'REFERENCE']
export const INDEPENDENCE = ['UNASSESSED', 'LIKELY_DERIVED', 'LIKELY_INDEPENDENT']        // a proposal can say no more; "confirmed" belongs to a human review outside this file
export const COVERAGE = ['UNRESOLVED', 'UNSUPPORTED', 'PARTIAL', 'PROPOSED_CORROBORATED']   // never "CORROBORATED" / "VERIFIED": those are human acts
const FORBIDDEN_KEYS = /^(text|excerpt|quote|body|content|article|snippet|abstract|summary_text|html)$/i
const LIMIT = { title: 200, publisher: 120, locator: 200, note: 500, url: 500 }

/** An empty package for one published trade: every package side and every asset starts UNRESOLVED, no candidates, nothing verified. */
export function newPackage (tx) {
  const sides = [...new Set(tx.assets.map((a) => `${a.from_key}>${a.to_key}`))]
  return {
    format: FORMAT, kind: 'RESEARCH_PROPOSAL', human_verification: null, human_reviewer: null, created_on: tx.created_on,
    transaction: { id: tx.id, season: tx.season, date: tx.date, clubs: tx.clubs, external_ids: tx.external_ids, assets: tx.assets, origin_sources: tx.origin_sources },
    origin: { category: 'RETROSHEET', independence_group: ORIGIN_GROUP, note: 'BAI record imported from the pinned Retrosheet batches; it is one independence group and never counts as its own corroboration' },
    candidates: [],
    corroboration: { packages: sides.map((s) => ({ side: s, status: 'UNRESOLVED', candidate_ids: [] })), assets: tx.assets.map((a) => ({ position: a.position, status: 'UNRESOLVED', candidate_ids: [] })) },
    gaps: [], recommended_human_action: [], unresolved_claims: []
  }
}

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s))
const walk = (o, f, p = '') => { for (const [k, v] of Object.entries(o ?? {})) { f(k, v, `${p}.${k}`); if (v && typeof v === 'object') walk(v, f, `${p}.${k}`) } }

/** All the problems of a package. An empty list means the package is a well-formed PROPOSAL, nothing more. */
export function validatePackage (pkg, { retrievedAfter = '2000-01-01' } = {}) {
  const p = []
  if (pkg?.format !== FORMAT) return [`format is not ${FORMAT}`]
  if (pkg.kind !== 'RESEARCH_PROPOSAL') p.push('kind must be RESEARCH_PROPOSAL')
  if (pkg.human_verification !== null || pkg.human_reviewer !== null) p.push('a research proposal carries no human verification: human_verification and human_reviewer must be null')
  walk(pkg, (k, v, at) => { if (FORBIDDEN_KEYS.test(k)) p.push(`${at}: source text is never stored (field ${k})`); if (typeof v === 'string' && v.length > LIMIT.note) p.push(`${at}: longer than ${LIMIT.note} characters`) })
  const t = pkg.transaction; if (!t?.id || !isDate(t.date) || !Array.isArray(t.assets) || !t.assets.length) p.push('transaction identity (id, date, assets) is incomplete')
  const ids = new Set()
  for (const c of pkg.candidates ?? []) {
    const w = `candidate ${c.id}`
    if (!c.id || ids.has(c.id)) p.push(`${w}: id missing or duplicated`); ids.add(c.id)
    let host = null; try { const u = new URL(c.url); host = u.hostname; if (u.protocol !== 'https:') p.push(`${w}: url must be https`); if (u.username || u.password) p.push(`${w}: url carries credentials`); if (c.url.length > LIMIT.url) p.push(`${w}: url too long`) } catch { p.push(`${w}: url is not a valid URL`) }
    for (const k of ['title', 'publisher', 'locator']) if (!c[k] || String(c[k]).length > LIMIT[k]) p.push(`${w}: ${k} is required and at most ${LIMIT[k]} characters`)
    if (!ROLES.includes(c.role)) p.push(`${w}: role must be one of ${ROLES.join(', ')}`)
    if (!isDate(c.retrieved_on) || c.retrieved_on < retrievedAfter) p.push(`${w}: retrieved_on must be a real date`)
    if (c.found_by !== 'WEB_SEARCH' && c.found_by !== 'HUMAN') p.push(`${w}: found_by must say how the candidate was found (WEB_SEARCH or HUMAN)`)
    if (host) {
      const cat = categoryOfUrl(c.url)
      if (c.rights?.category !== cat) p.push(`${w}: the source category follows from the host (${cat}); it cannot be declared as ${c.rights?.category}`)
      if (c.rights?.status !== rightsStatus(cat)) p.push(`${w}: rights status for ${cat} is ${rightsStatus(cat)}`)
      if (c.rights?.display_consequence !== (rightsStatus(cat) === 'NEEDS_PERMISSION' ? 'WITHDRAWN_UNTIL_PERMITTED' : 'NONE')) p.push(`${w}: display_consequence must be ${rightsStatus(cat) === 'NEEDS_PERMISSION' ? 'WITHDRAWN_UNTIL_PERMITTED' : 'NONE'}`)
      if (!INDEPENDENCE.includes(c.independence?.assessment)) p.push(`${w}: independence.assessment must be one of ${INDEPENDENCE.join(', ')} (a proposal cannot confirm independence)`)
      else if (c.independence.assessment === 'LIKELY_INDEPENDENT' && DERIVED_HOSTS.test(host)) p.push(`${w}: ${host} is known to be partly derived from the origin; it cannot be LIKELY_INDEPENDENT without a human lineage review`)
      if (c.independence?.assessment === 'LIKELY_INDEPENDENT' && (!c.independence.lineage_note || c.independence.group === ORIGIN_GROUP || !c.independence.group)) p.push(`${w}: LIKELY_INDEPENDENT needs a lineage note and a group other than ${ORIGIN_GROUP}`)
    }
  }
  const known = new Set((pkg.candidates ?? []).map((c) => c.id)); const cand = (id) => (pkg.candidates ?? []).find((c) => c.id === id)
  const cover = (rows, label, expected) => {
    const seen = new Set()
    for (const r of rows ?? []) {
      seen.add(String(r.position ?? r.side))
      if (!COVERAGE.includes(r.status)) p.push(`${label} ${r.position ?? r.side}: status ${r.status} is not a proposal status (${COVERAGE.join(', ')})`)
      for (const id of r.candidate_ids ?? []) if (!known.has(id)) p.push(`${label} ${r.position ?? r.side}: unknown candidate ${id}`)
      if (r.status === 'PROPOSED_CORROBORATED') {
        const good = (r.candidate_ids ?? []).map(cand).filter((c) => c?.independence?.assessment === 'LIKELY_INDEPENDENT')
        if (!good.length) p.push(`${label} ${r.position ?? r.side}: PROPOSED_CORROBORATED needs at least one LIKELY_INDEPENDENT candidate`)
      }
      if (r.status === 'UNRESOLVED' && (r.candidate_ids ?? []).length) p.push(`${label} ${r.position ?? r.side}: UNRESOLVED cannot cite candidates (use PARTIAL or UNSUPPORTED)`)
    }
    for (const e of expected) if (!seen.has(String(e))) p.push(`${label} ${e} has no entry: every side and asset must be listed, unresolved ones included`)
  }
  cover(pkg.corroboration?.packages, 'package', [...new Set((t?.assets ?? []).map((a) => `${a.from_key}>${a.to_key}`))])
  cover(pkg.corroboration?.assets, 'asset', (t?.assets ?? []).map((a) => a.position))
  return p
}

/** What a human still has to do, computed from the package (never from a claim in it): the VERIFIED_COMPLETE requirements of research.transaction_gaps that are not yet proposed as met. */
export function readiness (pkg) {
  const need = []; const cs = pkg.candidates ?? []
  if (!cs.some((c) => c.role === 'PRIMARY_ANNOUNCEMENT')) need.push('NO_PRIMARY_ANNOUNCEMENT_CANDIDATE')
  if (!cs.some((c) => c.independence?.assessment === 'LIKELY_INDEPENDENT')) need.push('NO_LIKELY_INDEPENDENT_SECOND_SOURCE')
  for (const r of pkg.corroboration.packages) if (r.status !== 'PROPOSED_CORROBORATED') need.push(`PACKAGE_${r.side}_${r.status}`)
  for (const r of pkg.corroboration.assets) if (r.status !== 'PROPOSED_CORROBORATED') need.push(`ASSET_${r.position}_${r.status}`)
  const blocked = cs.filter((c) => c.rights?.status === 'NEEDS_PERMISSION')
  if (blocked.length) need.push(`RIGHTS_BLOCKED_${blocked.map((c) => c.id).join(',')}`)
  return need
}

export function writePackages (pkgs, outDir) {
  const abs = assertOutputAllowed(outDir); fs.mkdirSync(abs, { recursive: true, mode: 0o700 })
  for (const k of pkgs) { const bad = validatePackage(k); if (bad.length) throw new Error(`package ${k.transaction.id} is invalid: ${bad[0]}`); fs.writeFileSync(path.join(abs, `p-${k.transaction.id}.json`), JSON.stringify(k, null, 1) + '\n', { mode: 0o600 }) }
  return abs
}

/** Updates a package that already exists in a private directory (outside git); validates before writing and keeps the file private. */
export function savePackage (dir, pkg) {
  const abs = path.resolve(dir)
  for (let d = abs; ; d = path.dirname(d)) { if (fs.existsSync(path.join(d, '.git'))) throw new Error(`${abs} is inside the git work tree ${d}`); if (d === path.dirname(d)) break }
  const bad = validatePackage(pkg); if (bad.length) throw new Error(`package ${pkg.transaction?.id} is invalid: ${bad[0]}`)
  fs.writeFileSync(path.join(abs, `p-${pkg.transaction.id}.json`), JSON.stringify(pkg, null, 1) + '\n', { mode: 0o600 })
}

// ---- reading BAI's own published record (read-only) -----------------------------------------------------------------------------------------------------------------------------------
export const DETAIL_SQL = {
  tx: `select r.transaction_id as id, r.season, r.transaction_date::text as date, r.club_keys as clubs from public.rm_transactions r where r.transaction_id = any ($1::bigint[]) and r.transaction_type = 'TRADE' order by r.transaction_id`,
  ext: `select transaction_id, external_id from public.transaction_external_ids where transaction_id = any ($1::bigint[]) order by 1, 2`,
  assets: `select transaction_id, position, from_key, to_key, asset_kind as kind, player_name, detail, conditional, condition_text, amount_status, resolution_kind from public.rm_transaction_assets where transaction_id = any ($1::bigint[]) order by 1, 2`,
  src: `select transaction_id, position, role, independence_group, attribution_category as category from public.rm_transaction_sources where transaction_id = any ($1::bigint[]) order by 1, 2`
}
export async function fetchTransactions (client, ids) {
  const g = async (k) => (await client.query(DETAIL_SQL[k], [ids])).rows; const [tx, ext, assets, src] = await Promise.all([g('tx'), g('ext'), g('assets'), g('src')])
  const by = (rows) => rows.reduce((m, r) => ((m[r.transaction_id] ??= []).push(r), m), {})
  const E = by(ext); const A = by(assets); const S = by(src); const created_on = new Date().toISOString().slice(0, 10)
  return tx.map((t) => ({ id: Number(t.id), season: t.season, date: t.date, clubs: t.clubs, external_ids: (E[t.id] ?? []).map((x) => x.external_id), created_on,
    assets: (A[t.id] ?? []).map(({ transaction_id, ...a }) => a), origin_sources: (S[t.id] ?? []).map(({ transaction_id, ...s }) => s) }))
}

/** The PTBNL triage view: one row per unresolved player-to-be-named asset, with the question a human must answer and structured search terms (clubs, window) -- hints, not evidence. */
export function triageRows (txs) {
  return txs.flatMap((t) => t.assets.filter((a) => a.kind === 'PLAYER_TO_BE_NAMED' && !a.resolution_kind).map((a) => {
    const orCash = /cash/i.test(a.condition_text ?? '')
    const others = t.assets.filter((x) => x.position !== a.position)
    const cashUnknown = others.some((x) => ['CASH', 'INTERNATIONAL_POOL_SPACE'].includes(x.kind) && (x.amount_status ?? 'UNKNOWN') === 'UNKNOWN')
    return { transaction_id: t.id, date: t.date, season: t.season, ptbnl_position: a.position, from: a.from_key, to: a.to_key, may_resolve_as_cash: orCash, other_assets: others.length, other_cash_unknown: cashUnknown,
      question: orCash ? 'Who was named, or was cash paid instead (and how much, if disclosed)?' : 'Who was named?',
      search_window: `${t.date}..+12 months`, search_terms: `${a.from} ${a.to} player to be named ${t.date.slice(0, 4)}`,
      action: orCash ? 'RESOLVE_PLAYER_OR_CASH' : 'RESOLVE_PLAYER', identity_task: 'the named player must already exist in BAI players; a missing player is a separate identity task', priority: cashUnknown ? 'P1B' : 'P1A' }
  }))
}
