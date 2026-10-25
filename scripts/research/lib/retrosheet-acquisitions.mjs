// Retrosheet rows -> ACQUISITION records (scripts/research/lib/acquisitions.mjs): free-agent signings, amateur free-agent signings, waiver claims,
// purchases and Rule 5 selections. Everything else the archive records is classified and COUNTED but never staged as an acquisition:
//   departures (free agent granted, release), voids, returns, roster-status rows, and DRAFT SELECTIONS (the draft tables hold those; a source
//   reporting a draft event does not make a signing). Trades go through the trade adapter. One archive is one source lineage; nothing here makes
//   a record verified or complete. Salaries, contract values, bonuses and service time are not in the archive and are never inferred: the row's own
//   note is kept verbatim and never parsed.
import { ACQUISITION_CLASSES, prepareAcquisitionDoc } from './acquisitions.mjs'
import { RETRO_GROUP } from './retrosheet-adapter.mjs'

const BLOCKING_FLAGS = ['DATE_MONTH_ONLY', 'DATE_PRESEASON_ONLY', 'DATE_APPROXIMATE', 'INVALID_DATE', 'UNKNOWN_TYPE_CODE', 'BLANK_TYPE_CODE', 'UNMAPPED_TEAM_CODE', 'UNDOCUMENTED_TIME_CODE', 'MALFORMED_ROW']
export const NOT_ACQUISITIONS = {
  departure: ['FREE_AGENT_GRANTED', 'RELEASE'],
  void: ['FREE_AGENT_SIGNING_VOIDED', 'PURCHASE_VOIDED', 'WAIVER_VOIDED', 'TRADE_VOIDED', 'AMATEUR_DRAFT_VOIDED'],
  return: ['WAIVER_RETURN', 'PURCHASE_RETURN', 'DRAFT_RETURN', 'TRADE_RETURN', 'CONDITIONAL_TRADE_RETURN', 'MOVEMENT_RETURN', 'EXPANSION_RETURN'],
  draft_selection: ['AMATEUR_DRAFT_SELECTION', 'MINOR_LEAGUE_DRAFT_SELECTION', 'SPECIAL_DRAFT_SELECTION', 'EXPANSION_DRAFT_SELECTION', 'AMATEUR_DRAFT_NOT_SIGNED'],
  roster_status: ['ROSTER_STATUS']
}

/** Which kind of record a group is, for the inventory: an acquisition class, or why it is not one. */
export function recordKind (g) {
  if (g.acquisition_class && ACQUISITION_CLASSES[g.acquisition_class]) return g.acquisition_class
  for (const [kind, cats] of Object.entries(NOT_ACQUISITIONS)) if (cats.includes(g.category)) return `NOT_AN_ACQUISITION:${kind}`
  if (g.acquisition_class === 'TRADE') return 'TRADE'
  return `OTHER:${g.category}`
}

/** Void rows by (retrosheet id, to franchise): the earliest void date, so a signing the source itself voids is held. */
export function voidIndex (groups) {
  const idx = new Map()
  for (const g of groups) {
    if (g.family !== 'SINGLE' || NOT_ACQUISITIONS.void.indexOf(g.category) < 0) continue
    const r = g.rows[0]
    if (r.player.kind !== 'RETROSHEET_ID') continue
    for (const club of [r.to, r.from]) {
      if (club.kind !== 'MLB') continue
      const k = `${r.player.retro_id}|${club.franchise}`
      if (!idx.has(k) || r.date.text < idx.get(k)) idx.set(k, r.date.text)
    }
  }
  return idx
}

export function acquisitionHoldReasons (g, resolved, voids) {
  const cls = ACQUISITION_CLASSES[g.acquisition_class]
  if (g.family !== 'SINGLE' || !cls) return ['NOT_AN_ACQUISITION_GROUP']
  const r = g.rows[0]
  const why = []
  for (const f of g.flags) if (BLOCKING_FLAGS.includes(f)) why.push(f)
  if (!cls.codes.includes(r.type)) why.push('EVENT_CODE_NOT_AN_ACQUISITION_CODE')
  if (r.player.kind === 'NAME_ONLY') why.push('NAME_ONLY_PLAYER')
  else if (r.player.kind !== 'RETROSHEET_ID') why.push('NO_PLAYER')
  else { const s = resolved.get(r.player.retro_id); if (!s || s.state !== 'STRONG') why.push(`IDENTITY_${s?.state ?? 'UNRESOLVED'}`) }
  if (r.to.kind !== 'MLB') why.push('ACQUIRER_NOT_AN_MLB_CLUB')
  if (cls.from === 'NONE' && r.from.kind !== 'NONE') why.push('UNEXPECTED_FROM_TEAM')
  if (cls.from === 'ORGANIZATION' && r.from.kind !== 'MLB') why.push('FROM_NOT_AN_MLB_CLUB')
  if (cls.from === 'ANY' && r.from.kind === 'NONE') why.push('PURCHASE_WITHOUT_SELLER')
  if (cls.from === 'ANY' && !['MLB', 'NAMED_CLUB', 'NONE'].includes(r.from.kind)) why.push('SELLER_UNRECOGNIZED')
  if (r.from.kind === 'MLB' && r.to.kind === 'MLB' && r.from.franchise === r.to.franchise) why.push('SAME_CLUB')
  if (r.player.kind === 'RETROSHEET_ID' && r.to.kind === 'MLB') {
    const v = voids.get(`${r.player.retro_id}|${r.to.franchise}`)
    if (v && v >= r.date.text) why.push('VOIDED_BY_SOURCE_ROW')
  }
  return [...new Set(why)].sort()
}

export function toAcquisitionRecord (g, resolved, keys) {
  const cls = ACQUISITION_CLASSES[g.acquisition_class]
  const r = g.rows[0]
  const e = resolved.get(r.player.retro_id).evidence
  const ids = { MLBAM: e.mlbam, RETROSHEET: r.player.retro_id, ...(e.bbref ? { BBREF: e.bbref } : {}) }
  const person = { full_name: e.name, external_ids: ids, external_id_sources: Object.fromEntries(Object.keys(ids).map((k) => [k, keys.chadwick])), ...(e.birth_date ? { birth_date: e.birth_date } : {}), source_key: keys.retro }
  return {
    type: 'ACQUISITION', schema: 1, ref: `rs-${g.key.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`, organization: r.to.franchise, acquisition_class: g.acquisition_class, transaction_type: cls.transaction_type,
    date: r.date.iso, date_precision: 'DAY', source_key: keys.retro,
    sources: [{ source_key: keys.retro, role: 'REFERENCE', independence_group: RETRO_GROUP, locator: `tran.txt line ${r.line}` }],
    external_ids: [{ scheme: 'RETROSHEET_TXN', id: g.key, source_key: keys.retro }],
    move: { player: person, to_organization: r.to.franchise, from_organization: r.from.kind === 'MLB' ? r.from.franchise : null, from_club_text: r.from.kind === 'NAMED_CLUB' ? `${r.from.name}${r.from.league ? ' ' + r.from.league : ''}`.trim() : null, source_event_code: r.type, source_info: r.info || null }
  }
}

/** Stage every acquisition in [from, to]: { doc, candidates, holds, inventory }. */
export function buildAcquisitionCandidates (groups, resolved, { from, to, declarations, keys, batchKey }) {
  const voids = voidIndex(groups)
  const inRange = groups.filter((g) => g.family !== 'MALFORMED' && g.season >= from && g.season <= to)
  const records = []; const holds = []
  const kinds = {}
  const bySeasonClass = {}
  for (const g of inRange) {
    const kind = recordKind(g)
    kinds[kind] = (kinds[kind] ?? 0) + 1
    if (!ACQUISITION_CLASSES[g.acquisition_class]) continue
    const why = acquisitionHoldReasons(g, resolved, voids)
    const k = `${g.season}|${g.acquisition_class}`
    bySeasonClass[k] ??= { candidates: 0, held: 0 }
    if (why.length) { holds.push({ key: g.key, class: g.acquisition_class, season: g.season, date: g.date.text, line: g.rows[0].line, reasons: why }); bySeasonClass[k].held++ }
    else { records.push(toAcquisitionRecord(g, resolved, keys)); bySeasonClass[k].candidates++ }
  }
  const doc = prepareAcquisitionDoc({ format: 'bai-research-import/1', batch_key: batchKey, channel: 'ACQUISITIONS',
    description: `Retrosheet non-trade acquisitions ${from}-${to}: one source lineage, PARTIAL only, no contract terms`, sources: declarations, records })
  const holdReasons = {}
  for (const h of holds) for (const r of h.reasons) holdReasons[r] = (holdReasons[r] ?? 0) + 1
  const byClass = {}
  for (const [k, v] of Object.entries(bySeasonClass)) { const c = k.split('|')[1]; byClass[c] ??= { candidates: 0, held: 0 }; byClass[c].candidates += v.candidates; byClass[c].held += v.held }
  return { doc, candidates: records.length, holds: holds.sort((a, b) => (a.date + a.key < b.date + b.key ? -1 : 1)), inventory: { record_kinds: kinds, by_class: byClass, by_season_class: bySeasonClass, hold_reasons: holdReasons } }
}
