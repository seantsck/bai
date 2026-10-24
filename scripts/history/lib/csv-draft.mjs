// Staging CSV for draft selections: a deterministic, no-AI route for any table that a person can supply with provenance. Pure functions
// (no I/O): the same CSV and register text always give the same rows, holds and batches. The rows only ever become BAI records through a
// release directory, so the release checks apply unchanged: source permissions, collision preview, identity tiers, maxima, audit.
//
// Rules (nothing here relaxes a BAI rule):
//   - blank means unknown: a blank bonus is NULL (never zero), a blank signing status is UNKNOWN (never DID_NOT_SIGN);
//   - a bonus needs an explicit SIGNED status (a bonus never implies SIGNED);
//   - every row cites a source URL, a pinned revision and the catalog source that governs the URL; a source the catalog does not
//     permit for publication holds the row, whoever typed it (a copied MLB or Baseball-Reference table is not a licence);
//   - identity is never by name alone: a supplied MLBAM id must exist in the Chadwick register under the same name; a row without one is
//     imported name-only only when the register has no same-name person in the plausible birth window, otherwise it is held. A
//     release carries identifiers only with recorded Wikidata corroboration, so a row with an MLBAM id also needs the Wikidata map
//     (mlbam -> item) and an agreeing birth date, otherwise it is held;
//   - a release carries no signing status, date or bonus: the signing columns are kept as proposals for a separate reviewed path and every
//     selection is built with signing unknown.
import crypto from 'node:crypto'
import { parseCsv, indexShard } from './chadwick.mjs'
import { sourceForUrl, checkUse } from './permissions.mjs'
import { roundCode, selectionType, schoolFromLabel } from './mlb.mjs'
import { roundStructure } from '../../research/lib/import-format.mjs'
import { WIKI_TEAMS } from './wikipedia-draft.mjs'

export const CSV_COLUMNS = ['draft_year', 'overall_pick', 'round_code', 'round_pick', 'team', 'player_name', 'player_mlbam_id', 'position', 'school', 'signing_status', 'signing_bonus', 'source_url', 'source_revision', 'source_permission']
export const FRANCHISE_KEYS = [...new Set(Object.values(WIKI_TEAMS))].sort()
export const csvTemplate = () => `${CSV_COLUMNS.join(',')}\n`

const sha8 = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 8)
export const fold = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim()

/** CSV text -> { rows (each with its line number), problems }. The header must name exactly the template's columns (any order). */
export function readCsv (text) {
  const all = parseCsv(String(text).replace(/^﻿/, ''))
  const head = (all.shift() ?? []).map((h) => h.trim())
  const problems = []
  const missing = CSV_COLUMNS.filter((c) => !head.includes(c)); const extra = head.filter((c) => !CSV_COLUMNS.includes(c))
  if (missing.length) problems.push(`missing columns: ${missing.join(', ')}`)
  if (extra.length) problems.push(`unknown columns: ${extra.join(', ')}`)
  const rows = []
  all.forEach((cells, i) => {
    if (cells.every((c) => !String(c).trim())) return
    if (cells.length !== head.length) { problems.push(`line ${i + 2}: ${cells.length} cells, the header has ${head.length}`); return }
    rows.push({ line: i + 2, ...Object.fromEntries(head.map((h, k) => [h, cells[k].trim()])) })
  })
  return { rows, problems }
}

/** One row -> { errors, clean }. A row with errors is held with those reasons; nothing is repaired or guessed. */
export function validateRow (r, { year, catalog, root, orgKeys = FRANCHISE_KEYS }) {
  const errors = []
  const int = (v, min = 1) => (/^\d+$/.test(v) && Number(v) >= min ? Number(v) : null)
  if (Number(r.draft_year) !== year) errors.push(`draft_year ${r.draft_year || '(blank)'} is not ${year}`)
  const overall = int(r.overall_pick); if (!overall) errors.push('overall_pick must be a positive whole number')
  const code = r.round_code ? roundCode(r.round_code) : null
  if (!code || !roundStructure(code)) errors.push(`round_code ${r.round_code || '(blank)'} is not a recognised round (1..N, C-n, S-n, CB-A, CB-B, PPI)`)
  const roundPick = r.round_pick === '' ? null : int(r.round_pick); if (r.round_pick !== '' && !roundPick) errors.push('round_pick must be blank or a positive whole number')
  const team = orgKeys.includes(r.team.toUpperCase()) ? r.team.toUpperCase() : WIKI_TEAMS[r.team] ?? null
  if (!team) errors.push(`team ${r.team || '(blank)'} is not a franchise key or a known club name`)
  if (!r.player_name) errors.push('player_name required')
  if (r.player_mlbam_id !== '' && !/^\d{4,9}$/.test(r.player_mlbam_id)) errors.push('player_mlbam_id must be blank or 4 to 9 digits')
  const status = r.signing_status === '' ? 'UNKNOWN' : r.signing_status.toUpperCase()
  if (!['UNKNOWN', 'SIGNED', 'DID_NOT_SIGN'].includes(status)) errors.push('signing_status must be blank, SIGNED, DID_NOT_SIGN or UNKNOWN')
  let bonus = null
  if (r.signing_bonus !== '') {
    const n = Number(r.signing_bonus.replace(/[$,\s]/g, ''))
    if (!Number.isFinite(n) || n < 0) errors.push('signing_bonus must be blank or a non-negative amount'); else bonus = n
    if (status !== 'SIGNED') errors.push('signing_bonus needs signing_status SIGNED (a bonus never implies SIGNED; blank never means zero)')
  }
  if (!/^https:\/\//.test(r.source_url)) errors.push('source_url must be an https URL')
  if (!r.source_revision) errors.push('source_revision required (the pinned revision, edition or retrieval of the source)')
  if (!r.source_permission) errors.push('source_permission required (the source-catalog id that governs the URL)')
  let gov = null
  if (/^https:\/\//.test(r.source_url) && r.source_permission) {
    gov = sourceForUrl(catalog, r.source_url)
    if (!gov) errors.push('source_url is on a host the source catalog does not know: no permission can be established')
    else if (gov.id !== r.source_permission) errors.push(`source_permission ${r.source_permission} does not match the catalog source that governs the URL (${gov.id})`)
    else {
      const use = checkUse(catalog, gov, 'publish_site', { year }, { root })
      if (!use.ok) errors.push(`rights: ${use.reason}`)
    }
  }
  return { errors, clean: errors.length ? null : { line: r.line, year, overall_pick: overall, round_code: code, round_pick: roundPick, organization: team, name: r.player_name, mlbam: r.player_mlbam_id || null, position: r.position || null, school: r.school || null, signing_status: status, bonus_usd: bonus, source_url: r.source_url, source_revision: r.source_revision, gov } }
}

/**
 * Validated rows + Chadwick shard texts -> identity decisions, held rows and one import batch per club. Deterministic.
 * `chadwick` = { commit7, commitFull, shardTexts }, `retrieved` = the source retrieval date (YYYY-MM-DD).
 */
export function buildCsvBatches ({ rows, year, chadwick, retrieved, csvSha256, wikidata = {} }) {
  const held = []
  const signingProposals = []
  const picks = []   // identity.json-compatible
  const seenPick = new Map(); const seenMlbam = new Map()
  const ok = []
  for (const c of rows) {   // duplicates inside the file are held (the draft allows a pick and a player once)
    if (seenPick.has(c.overall_pick)) { held.push({ pick: c.overall_pick, name: c.name, org: c.organization, reason: `pick ${c.overall_pick} appears twice in the file (lines ${seenPick.get(c.overall_pick)} and ${c.line})` }); continue }
    if (c.mlbam && seenMlbam.has(c.mlbam)) { held.push({ pick: c.overall_pick, name: c.name, org: c.organization, reason: `MLBAM ${c.mlbam} appears twice in the file (a player is selected once per draft)` }); continue }
    seenPick.set(c.overall_pick, c.line); if (c.mlbam) seenMlbam.set(c.mlbam, c.line); ok.push(c)
  }
  const wanted = new Set(ok.filter((c) => c.mlbam).map((c) => c.mlbam))
  const register = new Map()
  const names = new Map()   // folded full name -> count of register people born in the plausible window
  for (const text of chadwick.shardTexts) {
    indexShard(text, wanted, register)
    const t = parseCsv(text); const head = t.shift(); const col = Object.fromEntries(head.map((h, i) => [h, i]))
    for (const r of t) { const by = Number(r[col.birth_year]); if (by >= year - 26 && by <= year - 16) { const k = fold(`${r[col.name_first]} ${r[col.name_last]}`); names.set(k, (names.get(k) ?? 0) + 1) } }
  }
  const cwKey = `hist:chadwick-register-${chadwick.commit7}`
  const wdKey = `hist:wikidata-${year}-identity-csv`
  const bySource = new Map(); const sourceKeyOf = (c) => {
    const k = `${c.source_url}|${c.source_revision}`
    if (!bySource.has(k)) {
      const prefix = c.gov.source_key_prefixes?.[0]
      if (!prefix) throw new Error(`catalog source ${c.gov.id} has no source key prefix: cannot key a CSV source`)
      bySource.set(k, { source_key: `${prefix}csv-${year}-${sha8(k)}`, source_type: c.gov.source_type ?? 'REFERENCE_DATABASE', authority_level: c.gov.authority_level, title: `Staged CSV source (${c.gov.id}), revision ${c.source_revision}`, publisher: c.gov.publisher, url: c.source_url, retrieved_date: retrieved, notes: `Rows supplied through the staging CSV (sha256 ${csvSha256}); revision ${c.source_revision}. Permission basis: catalog source ${c.gov.id}.` })
    }
    return bySource.get(k).source_key
  }
  const byOrg = new Map()
  for (const c of ok) {
    let identity = null
    const player = { full_name: c.name }
    let status; let basis
    if (c.mlbam) {
      const reg = register.get(c.mlbam)
      if (!reg) { held.push({ pick: c.overall_pick, name: c.name, org: c.organization, reason: `MLBAM ${c.mlbam} is not in the pinned Chadwick register` }); picks.push({ overall_pick: c.overall_pick, name: c.name, club: c.organization, status: 'AMBIGUOUS', reason: 'MLBAM not in the register' }); continue }
      if (fold(reg.name) !== fold(c.name)) { held.push({ pick: c.overall_pick, name: c.name, org: c.organization, reason: `MLBAM ${c.mlbam} belongs to "${reg.name}" in the register, not "${c.name}": identity needs review` }); picks.push({ overall_pick: c.overall_pick, name: c.name, club: c.organization, status: 'AMBIGUOUS', reason: 'MLBAM and name disagree' }); continue }
      const wd = wikidata[c.mlbam]
      const regBirth = reg.birth[0] && reg.birth[1] && reg.birth[2] ? `${reg.birth[0]}-${String(reg.birth[1]).padStart(2, '0')}-${String(reg.birth[2]).padStart(2, '0')}` : null
      if (!wd?.qid) { held.push({ pick: c.overall_pick, name: c.name, org: c.organization, reason: `MLBAM ${c.mlbam} agrees with the register but has no Wikidata corroboration: supply the Wikidata map or review the identity` }); picks.push({ overall_pick: c.overall_pick, name: c.name, club: c.organization, status: 'SINGLE_SOURCE', reason: 'no Wikidata corroboration' }); continue }
      if (wd.birth && regBirth && wd.birth !== regBirth) { held.push({ pick: c.overall_pick, name: c.name, org: c.organization, reason: `birth dates disagree (register ${regBirth}, Wikidata ${wd.birth}): identity needs review` }); picks.push({ overall_pick: c.overall_pick, name: c.name, club: c.organization, status: 'AMBIGUOUS', reason: 'birth dates disagree' }); continue }
      status = 'VERIFIED'; basis = ['SUPPLIED_MLBAM', 'REGISTER_NAME_AGREES', 'WIKIDATA_MLBAM_TIE']
      identity = { ids: { MLBAM: c.mlbam, ...reg.ids }, birth: reg.birth, qid: wd.qid }
    } else {
      const n = names.get(fold(c.name)) ?? 0
      if (n > 0) { held.push({ pick: c.overall_pick, name: c.name, org: c.organization, reason: `${n} register person(s) share the name in the plausible birth window: supply the MLBAM id` }); picks.push({ overall_pick: c.overall_pick, name: c.name, club: c.organization, status: 'AMBIGUOUS', reason: 'same-name register candidates' }); continue }
      status = 'SINGLE_SOURCE'; basis = ['NAME_ONLY_NO_REGISTER_CANDIDATE']
    }
    picks.push({ overall_pick: c.overall_pick, name: c.name, club: c.organization, status, basis, chadwick: identity ? { ids: identity.ids, birth: identity.birth } : null, wikidata: identity ? { qid: identity.qid } : null })
    const sk = sourceKeyOf(c)
    player.source_key = sk
    const rec = { type: 'DRAFT_SELECTION', source_key: sk, draft_key: `${year}-JUNE_AMATEUR`, round_code: c.round_code, overall_pick: c.overall_pick, round_pick: c.round_pick, organization: c.organization, selection_type: selectionType(c.round_code), player }
    if (identity) {
      player.external_ids = identity.ids
      player.external_id_sources = Object.fromEntries(Object.keys(identity.ids).map((k) => [k, cwKey]))
      const b = identity.birth
      if (b[0] && b[1] && b[2]) { player.birth_date = `${b[0]}-${String(b[1]).padStart(2, '0')}-${String(b[2]).padStart(2, '0')}`; rec.field_sources = { birth_date: cwKey } }
    }
    if (c.position) rec.position = c.position
    if (c.school) { const s = schoolFromLabel(c.school); rec.school = { name: s?.name ?? c.school, school_type: s?.school_type ?? undefined, source_key: sk } }
    if (identity) rec.evidence = [{ subject: 'player', field: 'wikidata_item', value: identity.qid, source_key: wdKey }, { subject: 'player', field: 'identity_basis', value: basis.join('+'), source_key: wdKey }]
    // A release carries no signing facts: they are kept as proposals for a separate reviewed path; the selection itself is built unknown.
    if (c.signing_status !== 'UNKNOWN' || c.bonus_usd != null) signingProposals.push({ pick: c.overall_pick, organization: c.organization, name: c.name, signing_status: c.signing_status, bonus_usd: c.bonus_usd, source_url: c.source_url, source_revision: c.source_revision })
    rec.signing = { status: 'UNKNOWN' }
    rec.notes = `From a staged CSV row (line ${c.line}). Identity: ${status} (${basis.join(', ')}). Signing status not researched here: unknown, not "did not sign". Bonus unknown, not zero.`
    if (!byOrg.has(c.organization)) byOrg.set(c.organization, [])
    byOrg.get(c.organization).push(rec)
  }
  const usedCw = (recs) => recs.some((r) => r.player.external_ids)
  const batches = []
  for (const [org, records] of [...byOrg].sort(([a], [b]) => a.localeCompare(b))) {
    records.sort((a, b) => a.overall_pick - b.overall_pick)
    const mine = held.filter((h) => h.org === org)
    const srcs = [...new Set(records.map((r) => r.source_key))].map((k) => [...bySource.values()].find((s) => s.source_key === k))
    const wdSource = { source_key: wdKey, source_type: 'REFERENCE_DATABASE', authority_level: 'AGGREGATOR', title: `Wikidata identity corroboration for the ${year} draft (staged CSV)`, publisher: 'Wikimedia Foundation (Wikidata contributors)', url: 'https://www.wikidata.org/', retrieved_date: retrieved, notes: 'Items tied to the supplied MLB id; CC0.' }
    const sources = [...srcs, ...(usedCw(records) ? [wdSource, { source_key: cwKey, source_type: 'REFERENCE_DATABASE', authority_level: 'AGGREGATOR', title: `Chadwick Baseball Bureau Register, commit ${chadwick.commit7}`, publisher: 'Chadwick Baseball Bureau', url: `https://github.com/chadwickbureau/register/tree/${chadwick.commitFull}`, retrieved_date: retrieved, notes: 'MLBAM to other systems\' ids; birth dates. Open Data Commons Attribution License 1.0.' }] : [])]
    batches.push({ org, doc: { format: 'bai-research-import/1', batch_key: `hist-${year}-june-amateur-${org.toLowerCase()}-csv`, channel: 'DRAFT', description: `${org}, ${year} June draft: ${records.length} selection(s) from a staged CSV (local research import).`, coverage_claims: [{ domain: 'DRAFT', scope_key: `${year}-JUNE_AMATEUR`, organization: org, coverage_state: 'PARTIAL_RECONSTRUCTION', source_key: records[0].source_key,
      gap_notes: `A supplied CSV lists ${records.length} selection(s) for the club in the ${year} June draft. A supplied file is not proof of the population. ${mine.length ? `Held, not imported: ${mine.map((h) => `#${h.pick} (${h.reason})`).join('; ')}. ` : ''}Signing status, bonuses and outcomes are unknown unless a row states them with its source.` }], sources, records } })
  }
  return { batches, picks, held, signingProposals, sourceCount: bySource.size }
}
