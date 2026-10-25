// Retrosheet transaction archive (tranDB.zip -> tran.txt): a deterministic parser, classifier and grouper. Source notice:
// https://www.retrosheet.org/notice.txt (free use, including commercial, if the attribution statement appears prominently).
// Format: https://www.retrosheet.org/transactions/readme.txt (16 comma-separated, quoted fields per record).
//
// Principles (docs/transactions/retrosheet-integration.md):
//   * The original rows are never edited. A parsed row keeps every raw field, its line number and a hash; anything this
//     parser does not understand (a blank type, 'FG', an undocumented time code) is flagged, never corrected.
//   * One row is not one transaction. A trade is a GROUP of rows sharing a transaction id (it may include players added or
//     named later). A transaction id is NOT unique across the file for other types (a free-agent id can recur across
//     decades), so every non-trade row is its own record and carries its raw-line hash in its identity.
//   * An unknown date is never turned into an exact date: a "00" day gives MONTH precision with no ISO date; "0000" gives
//     PRESEASON (year only); an "@" marks a guess.
//   * Free text in the info field is kept verbatim. Only an exact, closed vocabulary becomes an asset kind, and no dollar
//     amount, bonus or contract value is ever read from it ("$" means money changed hands, amount not stated).
//   * Retrosheet is ONE source lineage however many rows it supplies: it can never corroborate itself.
import crypto from 'node:crypto'
import { parseCsv } from '../../history/lib/chadwick.mjs'
import { RETRO_TEAM_CODES, RETROSHEET_ATTRIBUTION } from '../../history/lib/retrosheet.mjs'

export { RETROSHEET_ATTRIBUTION }
export const RETROSHEET_ARCHIVE = {
  url: 'https://www.retrosheet.org/transactions/tranDB.zip',
  readme_url: 'https://www.retrosheet.org/transactions/readme.txt',
  notice_url: 'https://www.retrosheet.org/notice.txt',
  attribution: RETROSHEET_ATTRIBUTION
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')
const FIELDS = 16

// ---------------------------------------------------------------------------------------------------------------
// Type codes (readme.txt). category = BAI's normalized grouping; flow = what the row does for its clubs.
// ---------------------------------------------------------------------------------------------------------------
const T = (category, flow, note) => ({ category, flow, note })
export const TYPE_CODES = {
  A: T('ASSIGNMENT', 'MOVED', 'assigned from one team to another without compensation'),
  C: T('CONDITIONAL_TRADE', 'MOVED', 'conditional deal'),
  Cr: T('CONDITIONAL_TRADE_RETURN', 'RETURN', 'returned after conditional deal'),
  D: T('RULE_5_SELECTION', 'MOVED', 'rule 5 draft pick'),
  Da: T('AMATEUR_DRAFT_SELECTION', 'ACQUIRED', 'amateur draft pick'),
  Df: T('AMATEUR_DRAFT_SELECTION', 'ACQUIRED', 'first year draft pick'),
  Dm: T('MINOR_LEAGUE_DRAFT_SELECTION', 'ACQUIRED', 'minor league draft pick'),
  Dn: T('AMATEUR_DRAFT_NOT_SIGNED', 'STATUS', 'selected in amateur draft, did not sign'),
  Dr: T('DRAFT_RETURN', 'RETURN', 'returned to original team after draft selection'),
  Ds: T('SPECIAL_DRAFT_SELECTION', 'ACQUIRED', 'special draft pick'),
  Dv: T('AMATEUR_DRAFT_VOIDED', 'VOID', 'amateur draft pick voided'),
  F: T('FREE_AGENT_SIGNING', 'ACQUIRED', 'free agent signing'),
  Fa: T('AMATEUR_FREE_AGENT_SIGNING', 'ACQUIRED', 'amateur free agent signing'),
  Fb: T('AMATEUR_FREE_AGENT_SIGNING', 'ACQUIRED', 'bonus baby signing'),
  Fc: T('FREE_AGENT_COMPENSATION_PICK', 'ACQUIRED', 'free agent compensation pick'),
  Fg: T('FREE_AGENT_GRANTED', 'DEPARTED', 'free agent granted (the club loses the player; not an acquisition)'),
  Fo: T('FREE_AGENT_SIGNING_FIRST_ML_TEAM', 'ACQUIRED', 'free agent signing with first ML team'),
  Fv: T('FREE_AGENT_SIGNING_VOIDED', 'VOID', 'free agent signing voided'),
  Hb: T('ROSTER_STATUS', 'STATUS', 'bereavement list'), Hbr: T('ROSTER_STATUS', 'STATUS', 'off the bereavement list'),
  Hd: T('ROSTER_STATUS', 'STATUS', 'declared ineligible'), Hdr: T('ROSTER_STATUS', 'STATUS', 'reinstated from ineligible list'),
  Hf: T('ROSTER_STATUS', 'STATUS', 'demoted to the minor league'), Hfr: T('ROSTER_STATUS', 'STATUS', 'promoted from the minor league'),
  Hh: T('ROSTER_STATUS', 'STATUS', 'held out'), Hhr: T('ROSTER_STATUS', 'STATUS', 'ended hold out'),
  Hi: T('ROSTER_STATUS', 'STATUS', 'disabled list'), Hir: T('ROSTER_STATUS', 'STATUS', 'off the disabled list'),
  Hm: T('ROSTER_STATUS', 'STATUS', 'military service'), Hmr: T('ROSTER_STATUS', 'STATUS', 'returned from military service'),
  Hs: T('ROSTER_STATUS', 'STATUS', 'suspended'), Hsr: T('ROSTER_STATUS', 'STATUS', 'reinstated after suspension'),
  Hu: T('ROSTER_STATUS', 'STATUS', 'unavailable but not on DL'), Hur: T('ROSTER_STATUS', 'STATUS', 'returned from unavailable'),
  Hv: T('ROSTER_STATUS', 'STATUS', 'voluntarily retired'), Hvr: T('ROSTER_STATUS', 'STATUS', 'unretired'),
  J: T('OTHER_MOVEMENT', 'MOVED', 'jumped teams'), Jr: T('MOVEMENT_RETURN', 'RETURN', 'returned after jumping'),
  L: T('OTHER_MOVEMENT', 'MOVED', 'loaned to another team'), Lr: T('MOVEMENT_RETURN', 'RETURN', 'returned after loan'),
  M: T('OTHER_MOVEMENT', 'MOVED', 'rights obtained with a working agreement'), Mr: T('MOVEMENT_RETURN', 'RETURN', 'rights returned'),
  P: T('PURCHASE', 'MOVED', 'purchase'), Pr: T('PURCHASE_RETURN', 'RETURN', 'returned after purchase'), Pv: T('PURCHASE_VOIDED', 'VOID', 'purchase voided'),
  R: T('RELEASE', 'DEPARTED', 'release'),
  T: T('TRADE', 'MOVED', 'trade'), Tn: T('TRADE_REFUSED_TO_REPORT', 'MOVED', 'traded but refused to report'),
  Tp: T('TRADE', 'MOVED', 'added to trade'), Tr: T('TRADE_RETURN', 'RETURN', 'returned after trade'), Tv: T('TRADE_VOIDED', 'VOID', 'trade voided'),
  U: T('UNKNOWN_TYPE', 'STATUS', 'unknown (could have been two separate transactions)'),
  Vg: T('OTHER_MOVEMENT', 'MOVED', 'assigned to league control'), V: T('OTHER_MOVEMENT', 'MOVED', 'purchased or assigned from league'),
  W: T('WAIVER_ACQUISITION', 'MOVED', 'waiver pick'), Wf: T('WAIVER_ACQUISITION', 'MOVED', 'first year waiver pick'),
  Wr: T('WAIVER_RETURN', 'RETURN', 'returned after waiver pick'), Wv: T('WAIVER_VOIDED', 'VOID', 'waiver pick voided'),
  X: T('EXPANSION_DRAFT_SELECTION', 'ACQUIRED', 'expansion draft'), Xe: T('EXPANSION_DRAFT_SELECTION', 'ACQUIRED', 'premium phase of expansion draft'),
  Xm: T('EXPANSION_DRAFT_SELECTION', 'ACQUIRED', 'minor league expansion draft'), Xp: T('EXPANSION_DRAFT_SELECTION', 'ACQUIRED', 'expansion pick added later'),
  Xr: T('EXPANSION_RETURN', 'RETURN', 'returned after expansion draft'),
  Z: T('ROSTER_STATUS', 'STATUS', 'voluntarily retired'), Zr: T('ROSTER_STATUS', 'STATUS', 'returned from voluntarily retired list')
}
/** Coarse acquisition classes used by the inventory. */
export const ACQUISITION_CLASS = {
  TRADE: 'TRADE', CONDITIONAL_TRADE: 'TRADE', TRADE_REFUSED_TO_REPORT: 'TRADE',
  FREE_AGENT_SIGNING: 'FREE_AGENT', FREE_AGENT_SIGNING_FIRST_ML_TEAM: 'FREE_AGENT',   // Fc (a compensation PICK) is not a signing: it has no acquisition class
  AMATEUR_FREE_AGENT_SIGNING: 'AMATEUR_FREE_AGENT',
  WAIVER_ACQUISITION: 'WAIVER', PURCHASE: 'PURCHASE', RULE_5_SELECTION: 'RULE_5',
  AMATEUR_DRAFT_SELECTION: 'DRAFT', MINOR_LEAGUE_DRAFT_SELECTION: 'DRAFT', SPECIAL_DRAFT_SELECTION: 'DRAFT', EXPANSION_DRAFT_SELECTION: 'DRAFT'
}
export const TRADE_FAMILY = new Set(['T', 'Tp', 'Tn', 'Tr', 'Tv', 'C', 'Cr'])

// ---------------------------------------------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------------------------------------------

const validDay = (y, m, d) => { const t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d }

/**
 * yyyymmdd with the readme's conventions. Precision: DAY, MONTH ("dd" = 00), PRESEASON ("mmdd" = 0000: sometime before the
 * season, possibly the previous year). iso exists only for DAY. approximate = the "@" marker (a guess, not merely partial).
 */
export function parseRetroDate (text, approx = '') {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(text ?? '')
  if (!m) return { text, precision: 'INVALID', iso: null, year: null, month: null, day: null, approximate: approx === '@' }
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const out = { text, year: y, month: mo || null, day: d || null, approximate: approx === '@' }
  if (mo === 0 && d === 0) return { ...out, precision: 'PRESEASON', iso: null }
  if (mo === 0 || mo > 12) return { ...out, precision: 'INVALID', iso: null }
  if (d === 0) return { ...out, precision: 'MONTH', iso: null }
  if (!validDay(y, mo, d)) return { ...out, precision: 'INVALID', iso: null }
  return { ...out, precision: 'DAY', iso: `${m[1]}-${m[2]}-${m[3]}` }
}

// ---------------------------------------------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------------------------------------------

export function classifyPlayer (v) {
  if (v === '') return { kind: 'NONE' }
  if (v.length === 8 && /^[a-z][a-z-]{3}[a-z]\d{3}$/.test(v)) return { kind: 'RETROSHEET_ID', retro_id: v }
  return { kind: 'NAME_ONLY', name: v }
}
export function classifyTeam (team, league) {
  if (team === '' && league === '') return { kind: 'NONE' }
  if (RETRO_TEAM_CODES[team]) return { kind: 'MLB', code: team, franchise: RETRO_TEAM_CODES[team], league }
  if (/^[A-Z0-9]{3}$/.test(team) && /^(AL|NL|)$/.test(league)) return { kind: 'UNMAPPED_MLB_CODE', code: team, league }
  return { kind: 'NAMED_CLUB', name: team, league }
}
const TIME_CODES = { '': 'BEFORE_GAMES', 1: 'BETWEEN_GAMES', 2: 'AFTER_GAMES' }

export function normalizeRow (f, line) {
  const flags = []
  if (f.length !== FIELDS) return { line, raw: f, flags: ['MALFORMED_ROW'], malformed: true, row_sha256: sha(f.join(',')) }
  const type = f[7].trim()
  const t = TYPE_CODES[type]
  if (!t) flags.push(type === '' ? 'BLANK_TYPE_CODE' : 'UNKNOWN_TYPE_CODE')
  const date = parseRetroDate(f[0], f[2])
  if (date.precision === 'INVALID') flags.push('INVALID_DATE')
  if (date.precision === 'MONTH') flags.push('DATE_MONTH_ONLY')
  if (date.precision === 'PRESEASON') flags.push('DATE_PRESEASON_ONLY')
  if (date.approximate) flags.push('DATE_APPROXIMATE')
  if (!(f[1] in TIME_CODES)) flags.push('UNDOCUMENTED_TIME_CODE')
  const secondary = f[3] ? parseRetroDate(f[3], f[4]) : null
  const from = classifyTeam(f[8], f[9])
  const to = classifyTeam(f[10], f[11])
  for (const s of [from, to]) {
    if (s.kind === 'UNMAPPED_MLB_CODE') flags.push('UNMAPPED_TEAM_CODE')
  }
  return {
    line, raw: f, row_sha256: sha(f.join('\u0001')), source_id: f[5], date, time: f[1], time_meaning: TIME_CODES[f[1]] ?? null, secondary_date: secondary,
    player: classifyPlayer(f[6]), type_raw: f[7], type, category: t?.category ?? 'UNCLASSIFIED', flow: t?.flow ?? 'UNKNOWN', trade_family: TRADE_FAMILY.has(type),
    from, to, draft: { type: f[12], round: f[13], pick: f[14] }, info: f[15], flags
  }
}

/** Parse tran.txt text. Rows keep their file order (line numbers are 1-based). */
export function parseTran (text) {
  const rows = parseCsv(text.replace(/\n$/, '')).map((f, i) => normalizeRow(f, i + 1))
  return rows
}

// ---------------------------------------------------------------------------------------------------------------
// The info field: a closed vocabulary only; nothing is parsed into an amount.
// ---------------------------------------------------------------------------------------------------------------

/** What a row's info text says an asset is. Unrecognized text stays text (OTHER_TEXT) and holds the group. */
export function classifyInfo (info) {
  const s = (info ?? '').trim()
  if (s === '') return []
  const l = s.toLowerCase().replace(/\.$/, '')
  if (s === '$') return [{ kind: 'CASH', amount: 'UNKNOWN', text: s }]
  if (/^player to be named( later)?$|^a player to be named$/.test(l)) return [{ kind: 'PTBNL', condition_text: null, text: s }]
  if (l === 'player to be named or cash') return [{ kind: 'PTBNL', condition_text: s, text: s }]
  if (l === 'cash and a player to be named') return [{ kind: 'CASH', amount: 'UNKNOWN', text: s }, { kind: 'PTBNL', condition_text: null, text: s }]
  if (/^(two |three )?international bonus (slot|slots|pool)( money)?$|^international bonus pool money$/.test(l)) return [{ kind: 'INTERNATIONAL_POOL_SPACE', amount: 'UNKNOWN', text: s }]
  if (/^\d{4} (competitive balance( round [ab])? pick|supplemental (first|second)-round (draft )?pick)$/.test(l)) return [{ kind: 'DRAFT_PICK', text: s }]
  return [{ kind: 'OTHER_TEXT', text: s }]
}

// ---------------------------------------------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------------------------------------------

const dateKey = (d) => d.text

/**
 * Groups of rows that are one transaction according to the source. Trade-family rows sharing an id are one TRADE group
 * (later-dated members are kept and flagged: the id links a trade to players added or named later). Every other row is its
 * own group: ids repeat across unrelated rows, so the identity carries the raw-line hash.
 */
export function groupRows (rows) {
  const groups = []
  const trades = new Map()
  for (const r of rows) {
    if (r.malformed) { groups.push({ key: `MALFORMED@${r.line}`, family: 'MALFORMED', source_id: null, rows: [r] }); continue }
    if (r.trade_family) {
      if (!trades.has(r.source_id)) { const g = { family: 'TRADE', source_id: r.source_id, rows: [] }; trades.set(r.source_id, g); groups.push(g) }
      trades.get(r.source_id).rows.push(r)
    } else groups.push({ family: 'SINGLE', source_id: r.source_id, rows: [r] })
  }
  for (const g of groups) finishGroup(g)
  return groups
}

function finishGroup (g) {
  if (g.family === 'MALFORMED') return
  const rows = g.rows
  const dates = rows.map((r) => r.date)
  const first = [...dates].sort((a, b) => (dateKey(a) < dateKey(b) ? -1 : dateKey(a) > dateKey(b) ? 1 : 0))[0]
  g.date = first
  g.season = first.year
  g.flags = new Set()
  for (const r of rows) for (const f of r.flags) g.flags.add(f)
  if (g.family === 'TRADE') {
    g.key = `${g.source_id}@${first.text}`
    g.category = rows.some((r) => r.type === 'C') ? 'CONDITIONAL_TRADE' : rows.every((r) => r.category === 'TRADE_VOIDED') ? 'TRADE_VOIDED' : rows.every((r) => r.category === 'TRADE_RETURN') ? 'TRADE_RETURN' : 'TRADE'
    if (rows.some((r) => r.category === 'TRADE_VOIDED' || r.category === 'TRADE_RETURN' || r.category === 'CONDITIONAL_TRADE_RETURN' || r.type === 'Tn')) g.flags.add('VOID_RETURN_OR_REFUSAL_MEMBER')
    const later = rows.filter((r) => dateKey(r.date) > dateKey(first))
    if (later.length) g.flags.add('LATER_DATED_MEMBERS')
    const dirs = new Set()
    const parties = new Set()
    let nonMlb = false
    for (const r of rows) {
      for (const s of [r.from, r.to]) { if (s.kind === 'MLB') parties.add(s.franchise); else if (s.kind !== 'NONE') nonMlb = true }
      if (r.from.kind === 'MLB' && r.to.kind === 'MLB') dirs.add(`${r.from.franchise}>${r.to.franchise}`)
    }
    g.parties = [...parties].sort()
    g.directions = [...dirs].sort()
    if (nonMlb) g.flags.add('NON_MLB_PARTY')
    if (g.directions.length < 2) g.flags.add('ONE_DIRECTION_ONLY')
    if (g.parties.length > 2) g.flags.add('MULTI_TEAM')
    if (rows.some((r) => r.from.kind === 'NONE' || r.to.kind === 'NONE')) g.flags.add('PARTY_MISSING')
  } else {
    const r = rows[0]
    g.key = `${r.source_id}@${r.date.text}#${r.row_sha256.slice(0, 8)}`
    g.category = r.category
    g.parties = [r.from, r.to].filter((s) => s.kind === 'MLB').map((s) => s.franchise).sort()
    g.directions = []
  }
  g.acquisition_class = ACQUISITION_CLASS[g.category] ?? null
  for (const r of rows) {
    r.assets_from_info = classifyInfo(r.info)
    if (r.assets_from_info.some((a) => a.kind === 'OTHER_TEXT')) g.flags.add('FREE_TEXT_ASSET')
    if (r.player.kind === 'NAME_ONLY') g.flags.add('NAME_ONLY_PLAYER')
    if (r.player.kind === 'NONE' && r.assets_from_info.length === 0 && g.family === 'TRADE') g.flags.add('EMPTY_ASSET_ROW')
  }
  g.flags = [...g.flags].sort()
}

// ---------------------------------------------------------------------------------------------------------------
// Statistics (separate counts; nothing is a census)
// ---------------------------------------------------------------------------------------------------------------

export const inSeasons = (rows, from, to) => rows.filter((r) => !r.malformed && r.date.year >= from && r.date.year <= to)

export function inventory (rows, groups, { from, to }) {
  const R = inSeasons(rows, from, to)
  const G = groups.filter((g) => g.season >= from && g.season <= to)
  const count = (m, k, n = 1) => { m[k] = (m[k] ?? 0) + n }
  const out = {
    seasons: [from, to],
    raw_records: R.length,
    unique_source_transaction_ids: new Set(R.map((r) => r.source_id)).size,
    ids_with_several_groups: 0,
    groups: G.length,
    by_class: {}, by_category: {}, by_season: {}, by_club: {}, by_season_club_category: {},
    trade_groups: 0, trade_groups_two_or_more_directions: 0, trades_by_party_count: {},
    group_flag_counts: {}, groups_with_any_flag: 0,
    date_precision_rows: {}, approximate_date_rows: 0, same_day_ordered_rows: 0,
    row_flag_counts: {}, name_only_player_rows: 0, no_player_rows: 0, retrosheet_id_rows: 0,
    unclassified_rows: 0
  }
  const idGroups = new Map()
  for (const g of G) idGroups.set(g.source_id, (idGroups.get(g.source_id) ?? 0) + 1)
  out.ids_with_several_groups = [...idGroups.values()].filter((n) => n > 1).length
  for (const r of R) {
    count(out.date_precision_rows, r.date.precision)
    if (r.date.approximate) out.approximate_date_rows++
    if (r.time) out.same_day_ordered_rows++
    for (const f of r.flags) count(out.row_flag_counts, f)
    if (r.player.kind === 'NAME_ONLY') out.name_only_player_rows++
    else if (r.player.kind === 'NONE') out.no_player_rows++
    else out.retrosheet_id_rows++
    if (r.category === 'UNCLASSIFIED') out.unclassified_rows++
  }
  for (const g of G) {
    count(out.by_category, g.category)
    count(out.by_class, g.acquisition_class ?? 'NOT_AN_ACQUISITION')
    count(out.by_season, g.season)
    if (g.flags.length) out.groups_with_any_flag++
    for (const f of g.flags) count(out.group_flag_counts, f)
    // clubs: an acquisition counts for the club that receives; a departure for the club that loses; both listed per party
    for (const r of g.rows) {
      const clubs = new Set()
      for (const s of [r.to, r.from]) if (s.kind === 'MLB') clubs.add(s.franchise)
      for (const club of clubs) {
        count(out.by_club, club)
        count(out.by_season_club_category, `${g.season}|${club}|${g.category}`)
      }
    }
    if (g.family === 'TRADE') {
      out.trade_groups++
      if (g.directions.length >= 2) out.trade_groups_two_or_more_directions++
      count(out.trades_by_party_count, g.parties.length)
    }
  }
  return out
}
