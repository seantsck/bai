// R8B evidence packages: a LOCAL-ONLY, structured RESEARCH PROPOSAL for one published trade. A package records what is known (from BAI's own record), which candidate second sources
// were found (citation metadata only), what each would cover, whether it looks independent, whether BAI may display it, and what is still unresolved. It is never a verification:
// every human-verification field must be null, and the strongest statements a package may make are "proposed". Source text is never stored (fields are short and bounded), source
// categories are derived from the host and cannot be declared, and packages are written outside every git work tree.
import fs from 'node:fs'
import path from 'node:path'
import { assertOutputAllowed } from './r8b-queue.mjs'

export const FORMAT = 'bai-r8b-evidence-package/1'
export const ORIGIN_GROUP = 'retrosheet-archive'

// ---- source identity, licensing and CURRENT authorization -------------------------------------------------------------------------------------------------------------------------------
// A host name is a LABEL, never proof of an open licence. Only a registry rule (a host AND a path that name one specific publisher) can place a candidate in an openly licensed category,
// and only with licence evidence: built into the rule for sitewide licences (Wikimedia), or recorded by a human per candidate (Chadwick). Anything else -- every other GitHub repository,
// every unknown publisher -- is OTHER_PUBLICATION and needs permission review. Publication grants are NOT assumed: they come from a snapshot of the database read at the time of the check.
export const OPEN_SPDX = ['CC0-1.0', 'CC-BY-4.0', 'CC-BY-SA-4.0', 'ODC-By-1.0', 'PDDL-1.0', 'ODbL-1.0']
const WIKIMEDIA_TERMS = 'https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use'
/** An article title only: percent-decoded first, so File%3AX, Special%3A... and Category%3A... are namespaces too. */
const wikiArticlePath = (p) => { try { const d = decodeURIComponent(p); return /^\/wiki\/[^:/]+$/.test(d) && !/%/.test(d) } catch { return false } }
export const SOURCE_RULES = [
  { id: 'wikipedia-article', category: 'WIKIPEDIA', test: (u) => /^([a-z-]+\.)?wikipedia\.org$/.test(u.hostname) && wikiArticlePath(u.pathname),   // articles only: File:, Special:, Draft: and other namespaces may carry other licences
    license: { spdx: 'CC-BY-SA-4.0', evidence_url: WIKIMEDIA_TERMS } },
  { id: 'wikidata-entity', category: 'WIKIDATA', test: (u) => u.hostname === 'www.wikidata.org' && /^\/wiki\/(Q\d+)$/.test(u.pathname), license: { spdx: 'CC0-1.0', evidence_url: WIKIMEDIA_TERMS } },
  { id: 'chadwick-register-repository', category: 'CHADWICK_REGISTER', test: (u) => u.hostname === 'github.com' && /^\/chadwickbureau\/register(\/|$)/i.test(u.pathname), license: null, licensePath: /^\/chadwickbureau\/register\/(blob|raw)\/[^/]+\/(LICENSE|COPYING)(\.(md|txt))?$/i },
  { id: 'chadwick-bureau-site', category: 'CHADWICK_REGISTER', test: (u) => u.hostname === 'chadwick-bureau.com' || u.hostname === 'www.chadwick-bureau.com', license: null, licensePath: /^\/(license|copying)(\.(md|txt|html))?$/i }
]
/** Labels for sources that are RESTRICTED or derived. A wrong label can only make the treatment stricter, so a host match is enough for these. */
const RESTRICTED_HOSTS = [[/(^|\.)mlb\.com$/, 'MLB'], [/(^|\.)baseball-reference\.com$|(^|\.)sports-reference\.com$/, 'BASEBALL_REFERENCE'], [/(^|\.)retrosheet\.org$/, 'RETROSHEET']]
const LIMIT_URL = 500
/** A clean https URL: no credentials, no port, bounded length; the host is lower-cased and loses one trailing dot. Anything else is not classifiable (null). */
const httpsUrl = (v) => { try { const u = new URL(v); if (u.protocol !== 'https:' || u.username || u.password || u.port || String(v).length > LIMIT_URL) return null; return { hostname: u.hostname.toLowerCase().replace(/\.$/, ''), pathname: u.pathname, href: u.href } } catch { return null } }

export function licenseProblems (rule, license, today = new Date().toISOString().slice(0, 10)) {
  const p = []; if (!rule || rule.license) return p
  if (!license || typeof license !== 'object') return ['licence evidence is required for this source (spdx, evidence_url on the same source, checked_on, checked_by)']
  if (!OPEN_SPDX.includes(license.spdx)) p.push(`licence ${license.spdx} is not a recognised open licence (${OPEN_SPDX.join(', ')})`)
  const ev = httpsUrl(license.evidence_url); if (!ev || !rule.test(ev) || !rule.licensePath?.test(ev.pathname)) p.push('licence evidence_url must be an https URL on the same identified source that points at its LICENSE / COPYING file')
  if (!isDate(license.checked_on) || license.checked_on > today) p.push('licence checked_on must be a real date, not in the future'); if (license.checked_by !== 'HUMAN') p.push('licence evidence must be checked_by HUMAN (a script cannot establish a licence)')
  return p
}

/** What a candidate URL IS: a registry rule match (identity basis REGISTRY_RULE), a restricted-host label, or unknown. */
export function classifySource (url) {
  const u = httpsUrl(url); if (!u) return { category: 'OTHER_PUBLICATION', rule: null, basis: 'UNKNOWN' }
  const rule = SOURCE_RULES.find((r) => r.test(u)); if (rule) return { category: rule.category, rule, basis: 'REGISTRY_RULE' }
  const hit = RESTRICTED_HOSTS.find(([re]) => re.test(u.hostname)); return hit ? { category: hit[1], rule: null, basis: 'HOST_LABEL' } : { category: 'OTHER_PUBLICATION', rule: null, basis: 'UNKNOWN' }
}
/** Sources whose records are partly derived from, or republish, the origin: never better than LIKELY_DERIVED without a human lineage review. Keyed on the CLASSIFIED source, not the raw host. */
export const isDerivedSource = (url) => {
  if (['RETROSHEET', 'BASEBALL_REFERENCE', 'CHADWICK_REGISTER'].includes(classifySource(url).category)) return true
  let u; try { u = new URL(url) } catch { return false }; const h = u.hostname.toLowerCase().replace(/\.$/, '')
  return /(^|\.)(retrosheet\.org|baseball-reference\.com|sports-reference\.com|chadwick-bureau\.com|chadwickbureau\.github\.io)$/.test(h) || (['github.com', 'raw.githubusercontent.com', 'gist.github.com'].includes(h) && /^\/chadwickbureau(\/|$)/i.test(u.pathname))
}
export const categoryOfUrl = (url) => classifySource(url).category

/** A grant counts only if the snapshot names it AND its expiry is known and has not passed: { grants: [{ category, expires_on: 'YYYY-MM-DD' | 'NONE' }] }; 'NONE' is an explicit statement that the grant does not lapse. No snapshot, or an unknown expiry, means no grant is assumed. */
export const grantActive = (authorization, category, today) => (authorization?.grants ?? []).some((g) => g.category === category && (g.expires_on === 'NONE' || (isDate(g.expires_on) && today <= g.expires_on)))   // an unknown expiry (null) clears nothing

/** The rights of one candidate, derived from its URL, its licence evidence and the CURRENT authorization -- never declared and never remembered. */
export function assessRights (url, { license = null, authorization = null, today = new Date().toISOString().slice(0, 10) } = {}) {
  const c = classifySource(url); let status = 'NEEDS_PERMISSION'; let reason
  if (c.basis === 'REGISTRY_RULE') {
    const lp = licenseProblems(c.rule, license, today)
    if (lp.length) reason = `licence evidence missing or invalid: ${lp[0]}`; else { status = 'DISPLAY_CLEARED'; reason = 'identified open source with licence evidence' }
  } else if (c.basis === 'HOST_LABEL') {
    if (grantActive(authorization, c.category, today)) { status = 'GRANTED'; reason = 'a current publication grant is recorded for this category' } else reason = 'no current publication grant for this category'
  } else reason = 'unknown source: permission review needed (a category-wide grant does not clear an unreviewed publisher)'
  const lic = c.basis === 'REGISTRY_RULE' ? (c.rule.license ?? license ?? null) : null
  return { category: c.category, status, display_consequence: status === 'NEEDS_PERMISSION' ? 'WITHDRAWN_UNTIL_PERMITTED' : 'NONE', identity: { basis: c.basis, rule_id: c.rule?.id ?? null }, license: lic, reason, assessed_on: today }
}

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

export const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s   // a real calendar day (no 2099-02-31)
const walk = (o, f, p = '') => { for (const [k, v] of Object.entries(o ?? {})) { f(k, v, `${p}.${k}`); if (v && typeof v === 'object') walk(v, f, `${p}.${k}`) } }

/** All the problems of a package. An empty list means the package is a well-formed PROPOSAL, nothing more. */
const SHAPE = {
  '': ['format', 'kind', 'human_verification', 'human_reviewer', 'created_on', 'transaction', 'origin', 'candidates', 'corroboration', 'gaps', 'recommended_human_action', 'unresolved_claims'],
  transaction: ['id', 'season', 'date', 'clubs', 'external_ids', 'assets', 'origin_sources'], origin: ['category', 'independence_group', 'note'],
  asset: ['position', 'from_key', 'to_key', 'kind', 'player_name', 'detail', 'conditional', 'condition_text', 'amount_status', 'resolution_kind'], origin_source: ['position', 'role', 'independence_group', 'category'],
  candidate: ['id', 'url', 'title', 'publisher', 'role', 'locator', 'retrieved_on', 'found_by', 'rights', 'independence', 'evidence_basis', 'page_read'],
  rights: ['category', 'status', 'display_consequence', 'identity', 'license', 'reason', 'assessed_on'], identity: ['basis', 'rule_id'], license: ['spdx', 'evidence_url', 'checked_on', 'checked_by'], independence: ['assessment', 'group', 'lineage_note'],
  corroboration: ['packages', 'assets'], package_cover: ['side', 'status', 'candidate_ids'], asset_cover: ['position', 'status', 'candidate_ids'], note: ['code', 'detail']
}
/** A closed schema: any key not listed is a problem, so no status-like or text-like field can ride along unnoticed. */
function shapeProblems (pkg) {
  const p = []; const chk = (o, kind, at) => { if (o == null || typeof o !== 'object' || Array.isArray(o)) { p.push(`${at}: must be an object`); return false } for (const k of Object.keys(o)) if (!SHAPE[kind].includes(k)) p.push(`${at}: unexpected field ${k} (the package schema is closed)`); return true }
  const arr = (v, at) => { if (!Array.isArray(v)) { p.push(`${at}: must be a list`); return [] } return v }
  if (!chk(pkg, '', 'package')) return p
  if (chk(pkg.transaction, 'transaction', 'transaction')) { arr(pkg.transaction.assets, 'transaction.assets').forEach((a, i) => chk(a, 'asset', `transaction.assets[${i}]`)); arr(pkg.transaction.origin_sources, 'transaction.origin_sources').forEach((a, i) => chk(a, 'origin_source', `transaction.origin_sources[${i}]`)) }
  chk(pkg.origin, 'origin', 'origin')
  arr(pkg.candidates, 'candidates').forEach((c, i) => { if (chk(c, 'candidate', `candidates[${i}]`)) { if (chk(c.rights, 'rights', `candidates[${i}].rights`)) { if (c.rights.identity != null) chk(c.rights.identity, 'identity', `candidates[${i}].rights.identity`); if (c.rights.license != null) chk(c.rights.license, 'license', `candidates[${i}].rights.license`) } chk(c.independence, 'independence', `candidates[${i}].independence`) } })
  if (chk(pkg.corroboration, 'corroboration', 'corroboration')) { arr(pkg.corroboration.packages, 'corroboration.packages').forEach((r, i) => chk(r, 'package_cover', `corroboration.packages[${i}]`)); arr(pkg.corroboration.assets, 'corroboration.assets').forEach((r, i) => chk(r, 'asset_cover', `corroboration.assets[${i}]`)) }
  for (const k of ['gaps', 'recommended_human_action', 'unresolved_claims']) arr(pkg[k], k).forEach((g, i) => { if (typeof g !== 'string') chk(g, 'note', `${k}[${i}]`) })
  return p
}

const str = (v, max = 500) => typeof v === 'string' && v.length <= max
const strOrNull = (v, max = 500) => v === null || v === undefined || str(v, max)
/** Value types of every listed field: nothing may carry a nested object, an array where text belongs, or a number where an id is a string. */
function typeProblems (pkg) {
  const p = []; const t = pkg.transaction
  if (!Number.isSafeInteger(t.id) || t.id < 1) p.push('transaction.id must be a positive integer')
  if (!Array.isArray(t.clubs) || !t.clubs.every((x) => str(x, 20))) p.push('transaction.clubs must be a list of short strings')
  if (!Array.isArray(t.external_ids) || !t.external_ids.every((x) => str(x, 200))) p.push('transaction.external_ids must be a list of strings')
  t.assets.forEach((a, i) => { for (const k of ['from_key', 'to_key', 'kind', 'player_name', 'detail', 'condition_text', 'amount_status', 'resolution_kind']) if (!strOrNull(a[k])) p.push(`transaction.assets[${i}].${k} must be text or null`); if (!Number.isInteger(a.position)) p.push(`transaction.assets[${i}].position must be an integer`); if (typeof a.conditional !== 'boolean' && a.conditional != null) p.push(`transaction.assets[${i}].conditional must be true or false`) })
  t.origin_sources.forEach((a, i) => { for (const k of ['role', 'independence_group', 'category']) if (!strOrNull(a[k])) p.push(`transaction.origin_sources[${i}].${k} must be text or null`) })
  for (const k of ['note', 'category', 'independence_group']) if (!strOrNull(pkg.origin[k])) p.push(`origin.${k} must be text`)
  pkg.candidates.forEach((c, i) => { for (const k of ['id', 'url', 'title', 'publisher', 'role', 'locator', 'retrieved_on', 'found_by']) if (!str(c[k])) p.push(`candidates[${i}].${k} must be text`); for (const k of ['evidence_basis', 'page_read']) if (!strOrNull(c[k], 200) && typeof c[k] !== 'boolean') p.push(`candidates[${i}].${k} must be short text, true/false or null`); for (const k of ['assessment', 'group', 'lineage_note']) if (!strOrNull(c.independence?.[k])) p.push(`candidates[${i}].independence.${k} must be text`) })
  for (const [k, rows] of [['packages', pkg.corroboration.packages], ['assets', pkg.corroboration.assets]]) rows.forEach((r, i) => { if (!Array.isArray(r.candidate_ids) || !r.candidate_ids.every((x) => str(x))) p.push(`corroboration.${k}[${i}].candidate_ids must be a list of candidate ids`); if (!str(r.status)) p.push(`corroboration.${k}[${i}].status must be text`) })
  for (const k of ['gaps', 'recommended_human_action', 'unresolved_claims']) pkg[k].forEach((g, i) => { if (typeof g !== 'string' && !(strOrNull(g?.code) && strOrNull(g?.detail))) p.push(`${k}[${i}] must be text or a { code, detail } note`) })
  for (const k of ['created_on']) if (!isDate(pkg[k])) p.push(`${k} must be a real date`)
  return p
}

/** All the problems of a package; a structurally broken package yields problems, never an exception. */
export function validatePackage (pkg, opts = {}) {
  if (pkg?.format !== FORMAT) return [`format is not ${FORMAT}`]
  const shape = shapeProblems(pkg); if (shape.length) return shape
  const types = (() => { try { return typeProblems(pkg) } catch (e) { return [`package fields have the wrong types (${e.message})`] } })(); if (types.length) return types
  try { return validateChecked(pkg, opts) } catch (e) { return [`package is structurally malformed (${e.message})`] }
}
function validateChecked (pkg, { retrievedAfter = '2000-01-01', authorization = null, today = new Date().toISOString().slice(0, 10) } = {}) {
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
    if (!isDate(c.retrieved_on) || c.retrieved_on < retrievedAfter || c.retrieved_on > today) p.push(`${w}: retrieved_on must be a real date, not in the future`)
    if (c.found_by !== 'WEB_SEARCH' && c.found_by !== 'HUMAN') p.push(`${w}: found_by must say how the candidate was found (WEB_SEARCH or HUMAN)`)
    if (host) {
      const exp = assessRights(c.url, { license: c.rights?.license ?? null, authorization, today }); const r = c.rights ?? {}
      if (r.category !== exp.category) p.push(`${w}: the source category follows from the identified source (${exp.category}); it cannot be declared as ${r.category}`)
      if (r.identity?.basis !== exp.identity.basis || r.identity?.rule_id !== exp.identity.rule_id) p.push(`${w}: source identity is ${exp.identity.basis}${exp.identity.rule_id ? ` (${exp.identity.rule_id})` : ''}, not ${r.identity?.basis}`)
      if (JSON.stringify(r.license ?? null) !== JSON.stringify(exp.license ?? null)) p.push(`${w}: rights.license does not match the licence evidence for this source`)
      if (r.reason !== exp.reason) p.push(`${w}: rights.reason must be the assessed reason (${exp.reason})`)
      if (r.status !== exp.status) p.push(`${w}: rights status is ${exp.status} under the current authorization (${exp.reason}); the package says ${r.status}, so it is stale or wrong and must be re-assessed`)
      if (r.display_consequence !== exp.display_consequence) p.push(`${w}: display_consequence must be ${exp.display_consequence}`)
      if (!isDate(r.assessed_on) || r.assessed_on > today) p.push(`${w}: rights.assessed_on must be a real date, not in the future`)
      if (!INDEPENDENCE.includes(c.independence?.assessment)) p.push(`${w}: independence.assessment must be one of ${INDEPENDENCE.join(', ')} (a proposal cannot confirm independence)`)
      else if (c.independence.assessment === 'LIKELY_INDEPENDENT' && isDerivedSource(c.url)) p.push(`${w}: ${host} is known to be partly derived from the origin; it cannot be LIKELY_INDEPENDENT without a human lineage review`)
      if (c.independence?.assessment === 'LIKELY_INDEPENDENT' && (!c.independence.lineage_note || String(c.independence.group).trim().toLowerCase() === ORIGIN_GROUP || !c.independence.group)) p.push(`${w}: LIKELY_INDEPENDENT needs a lineage note and a group other than ${ORIGIN_GROUP}`)
    }
  }
  const known = new Set((pkg.candidates ?? []).map((c) => c.id)); const cand = (id) => (pkg.candidates ?? []).find((c) => c.id === id)
  const cover = (rows, label, expected) => {
    const seen = new Set()
    for (const r of rows ?? []) {
      const key = String(r.position ?? r.side); if (seen.has(key)) p.push(`${label} ${key}: listed more than once`); if (!expected.map(String).includes(key)) p.push(`${label} ${key}: is not a side or asset of this transaction`); seen.add(key)
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

export function writePackages (pkgs, outDir, opts = {}) {
  const abs = assertOutputAllowed(outDir)
  for (const k of pkgs) { const bad = validatePackage(k, opts); if (bad.length) throw new Error(`package ${k.transaction.id} is invalid: ${bad[0]}`) }   // all validated before anything is written
  fs.mkdirSync(abs, { recursive: true, mode: 0o700 })
  for (const k of pkgs) { fs.writeFileSync(path.join(abs, `p-${k.transaction.id}.json`), JSON.stringify(k, null, 1) + '\n', { mode: 0o600 }) }
  return abs
}

/** Updates a package that already exists in a private directory (outside git); validates before writing and keeps the file private. */
export function savePackage (dir, pkg, opts = {}) {
  const abs = path.resolve(dir)
  for (let d = abs; ; d = path.dirname(d)) { if (fs.existsSync(path.join(d, '.git'))) throw new Error(`${abs} is inside the git work tree ${d}`); if (d === path.dirname(d)) break }
  const bad = validatePackage(pkg, opts); if (bad.length) throw new Error(`package ${pkg.transaction?.id} is invalid: ${bad[0]}`)
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

// ---- requested vs delivered: nothing is silently omitted ---------------------------------------------------------------------------------------------------------------------------------
/** The transaction ids of a queue CSV, by the NAME of its transaction_id column. Anything unexpected is an error, never a skipped row. */
export function parseQueueIds (csv, count = null) {
  if (/"/.test(String(csv))) throw new Error('quoted CSV fields are not supported in a queue (a quote could hide a line break); regenerate the queue')
  const lines = String(csv).replace(/\r\n/g, '\n').trim().split('\n'); const header = lines[0].split(','); const col = header.indexOf('transaction_id')
  if (col < 0) throw new Error('the queue has no transaction_id column')
  const ids = lines.slice(1).map((l, i) => { const v = l.split(',')[col]; if (!/^[1-9]\d{0,15}$/.test(v ?? '') || !Number.isSafeInteger(Number(v))) throw new Error(`queue row ${i + 1}: transaction_id ${JSON.stringify(v)} is not a positive integer`); return Number(v) })
  if (new Set(ids).size !== ids.length) throw new Error('the queue lists a transaction more than once')
  if (count != null) { if (ids.length < count) throw new Error(`the queue has ${ids.length} rows but ${count} were requested`); return ids.slice(0, count) }
  if (!ids.length) throw new Error('the queue is empty')
  return ids
}
/** Fails unless the database returned exactly the requested transactions: a trade that is no longer published (or was never a TRADE) is reported, not dropped. */
export function assertComplete (requested, txs) {
  const got = new Set(txs.map((t) => t.id)); const missing = requested.filter((id) => !got.has(id)); const extra = [...got].filter((id) => !requested.includes(id))
  if (missing.length || extra.length || txs.length !== requested.length) throw new Error(`requested ${requested.length} transactions, found ${txs.length}; missing from the published record: [${missing.join(', ')}]${extra.length ? `; unexpected: [${extra.join(', ')}]` : ''}`)
}
/** A snapshot of the CURRENT publication grants (read-only). Expiry is not stored in the database, so the caller must state it for every granted category ({ RETROSHEET: '2027-01-22' } or 'NONE'); a category without a stated expiry is reported and clears nothing, and an expiry for a category that has no grant is an error. */
export async function fetchAuthorization (client, expiries = {}) {
  const rows = (await client.query('select attribution_category as category from ingest.source_publication_grants order by 1')).rows
  const have = new Set(rows.map((r) => r.category)); for (const [cat, e] of Object.entries(expiries)) { if (!have.has(cat)) throw new Error(`--grant-expiry names ${cat}, which has no publication grant in the database (typo?)`); if (e !== 'NONE' && !isDate(e)) throw new Error(`expiry for ${cat} must be YYYY-MM-DD or NONE`) }
  return { grants: rows.map((r) => ({ category: r.category, expires_on: expiries[r.category] ?? null })), read_on: new Date().toISOString().slice(0, 10), expiry_unknown: rows.map((r) => r.category).filter((c) => !expiries[c]) }
}
