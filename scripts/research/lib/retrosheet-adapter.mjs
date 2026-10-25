// Retrosheet trade groups -> version-2 TRADE records for the Phase 16 importer (migration 028, scripts/research/lib/transactions.mjs).
//
// What is staged: only a trade group the source states completely enough that nothing has to be guessed. Everything else is a
// HOLD with its reasons. Retrosheet is ONE source lineage (independence group "retrosheet-archive", role REFERENCE): the record
// can never reach VERIFIED_COMPLETE on this source alone (no primary announcement, one independent group), whatever transaction
// id the archive supplies. Dollar amounts are never read: "$" is cash of UNKNOWN amount; international slot money is of unknown amount.
import { prepareTradeDoc } from './transactions.mjs'
import { RETROSHEET_ARCHIVE } from './retrosheet-transactions.mjs'

export const RETRO_GROUP = 'retrosheet-archive'
const BLOCKING_FLAGS = ['ONE_DIRECTION_ONLY', 'NON_MLB_PARTY', 'PARTY_MISSING', 'FREE_TEXT_ASSET', 'NAME_ONLY_PLAYER', 'DATE_MONTH_ONLY', 'DATE_PRESEASON_ONLY', 'DATE_APPROXIMATE',
  'INVALID_DATE', 'UNKNOWN_TYPE_CODE', 'BLANK_TYPE_CODE', 'UNMAPPED_TEAM_CODE', 'VOID_RETURN_OR_REFUSAL_MEMBER', 'EMPTY_ASSET_ROW', 'UNDOCUMENTED_TIME_CODE', 'MALFORMED_ROW']

export const sourceKeys = (archiveSha256, registerCommit) => ({
  retro: `hist:retrosheet-transactions-${archiveSha256.slice(0, 10)}`,
  chadwick: `hist:chadwick-register-${registerCommit}`
})

export function sourceDeclarations ({ archiveSha256, retrievedOn, registerCommit, registerCommitFull = registerCommit, registerRetrievedOn }) {
  const k = sourceKeys(archiveSha256, registerCommit)
  return [
    { source_key: k.retro, source_type: 'REFERENCE_DATABASE', authority_level: 'REPUTABLE_SECONDARY', title: 'Retrosheet transactions database (tranDB.zip)', publisher: 'Retrosheet',
      url: RETROSHEET_ARCHIVE.url, reference: `archive sha256 ${archiveSha256}`, retrieved_date: retrievedOn, notes: RETROSHEET_ARCHIVE.attribution },
    { source_key: k.chadwick, source_type: 'REFERENCE_DATABASE', authority_level: 'AGGREGATOR', title: `Chadwick Baseball Bureau Register, commit ${registerCommit}`, publisher: 'Chadwick Baseball Bureau',
      url: `https://github.com/chadwickbureau/register/tree/${registerCommitFull}`, retrieved_date: registerRetrievedOn, notes: 'ODC-BY 1.0; identity crosswalk only' }
  ]
}

/** Why a group cannot be staged (empty = it can). resolved: Map retro -> {state, evidence}. */
export function holdReasons (g, resolved) {
  const why = []
  if (g.family !== 'TRADE') return ['NOT_A_TRADE_GROUP']
  if (g.category !== 'TRADE') why.push(g.category === 'CONDITIONAL_TRADE' ? 'CONDITIONAL_TRADE_CONDITION_NOT_STATED' : `CATEGORY_${g.category}`)
  for (const f of g.flags) if (BLOCKING_FLAGS.includes(f)) why.push(f)
  const unresolved = new Set()
  for (const r of g.rows) {
    if (r.player.kind !== 'RETROSHEET_ID') continue
    const s = resolved.get(r.player.retro_id)
    if (!s || s.state !== 'STRONG') unresolved.add(`${r.player.retro_id}:${s?.state ?? 'UNRESOLVED'}`)
  }
  if (unresolved.size) why.push(...[...unresolved].sort().map((u) => `IDENTITY_${u}`))
  // a player in two directions, or listed twice, is a package the source did not state cleanly
  const seen = new Map()
  for (const r of g.rows) {
    if (r.player.kind !== 'RETROSHEET_ID') continue
    const dir = `${r.from.franchise}>${r.to.franchise}`
    if (seen.has(r.player.retro_id)) why.push(seen.get(r.player.retro_id) === dir ? 'PLAYER_LISTED_TWICE' : 'PLAYER_IN_TWO_DIRECTIONS')
    seen.set(r.player.retro_id, dir)
  }
  const plan = buildPackages(g)
  if (plan.problems.length) why.push(...plan.problems)
  return [...new Set(why)].sort()
}

/** Packages from rows. Later-dated player rows are accepted only as the resolution of exactly one PTBNL placeholder in the same direction. */
export function buildPackages (g) {
  const problems = []
  const first = g.date.text
  const dirs = new Map()
  const dirOf = (r) => `${r.from.franchise}>${r.to.franchise}`
  for (const r of g.rows) {
    if (r.from.kind !== 'MLB' || r.to.kind !== 'MLB') continue
    const d = dirOf(r)
    if (!dirs.has(d)) dirs.set(d, { from: r.from.franchise, to: r.to.franchise, rows: [] })
    dirs.get(d).rows.push(r)
  }
  const packages = []
  for (const d of [...dirs.keys()].sort()) {
    const { from, to, rows } = dirs.get(d)
    const pkg = { from, to, players: [], others: [], lines: rows.map((r) => r.line) }
    const placeholders = []
    const later = []
    for (const r of rows) {
      if (r.player.kind === 'RETROSHEET_ID') {
        if (r.date.text > first) later.push(r); else pkg.players.push({ retro_id: r.player.retro_id, line: r.line })
      }
      for (const a of r.assets_from_info) {
        if (a.kind === 'OTHER_TEXT') { problems.push('FREE_TEXT_ASSET'); continue }
        const asset = { ...a, line: r.line }
        if (a.kind === 'PTBNL') placeholders.push(asset)
        pkg.others.push(asset)
      }
    }
    for (const r of later) {
      if (placeholders.length === 1 && !placeholders[0].resolution && r.date.precision === 'DAY' && !r.date.approximate) {
        placeholders[0].resolution = { retro_id: r.player.retro_id, resolved_on: r.date.iso, line: r.line }
      } else problems.push('LATER_DATED_MEMBER_WITHOUT_ONE_PTBNL_PLACEHOLDER')
    }
    packages.push(pkg)
  }
  return { packages, problems: [...new Set(problems)] }
}

/** The v2 record for a stageable group. */
export function toRecord (g, resolved, keys) {
  const { packages } = buildPackages(g)
  const person = (retro) => {
    const e = resolved.get(retro).evidence
    const [first, ...last] = e.name.split(' ')
    const ids = { MLBAM: e.mlbam, RETROSHEET: retro, ...(e.bbref ? { BBREF: e.bbref } : {}) }
    const src = Object.fromEntries(Object.keys(ids).map((k) => [k, keys.chadwick]))
    return { full_name: e.name || [first, ...last].join(' '), external_ids: ids, external_id_sources: src, ...(e.birth_date ? { birth_date: e.birth_date } : {}), source_key: keys.retro }
  }
  const S = [keys.retro]
  const lines = g.rows.map((r) => r.line)
  const rec = {
    type: 'TRADE', schema: 2, ref: `rs-${g.source_id}-${g.date.text}`, organization: g.parties[0], date: g.date.iso, date_precision: 'DAY', source_key: keys.retro,
    description: `Retrosheet transaction ${g.source_id}: ${g.rows.length} record(s), type ${[...new Set(g.rows.map((r) => r.type))].join('/')}`,
    external_ids: [{ scheme: 'RETROSHEET_TXN', id: g.key, source_key: keys.retro }],
    sources: [{ source_key: keys.retro, role: 'REFERENCE', independence_group: RETRO_GROUP, locator: `tran.txt lines ${lines.join(',')}` }],
    packages: packages.map((p) => {
      const used = new Map()
      const label = (a, base) => { const n = (used.get(base) ?? 0) + 1; used.set(base, n); return n === 1 ? base : `${base} #${n}` }
      return {
        from: p.from, to: p.to, source_keys: S,
        players: p.players.map((x) => ({ player: person(x.retro_id), source_keys: S })),
        other_assets: p.others.map((a) => {
          if (a.kind === 'CASH') return { asset_type: 'CASH', description: label(a, `cash (Retrosheet info: ${a.text})`), amount_disclosure: 'UNKNOWN', source_keys: S }
          if (a.kind === 'INTERNATIONAL_POOL_SPACE') return { asset_type: 'INTERNATIONAL_POOL_SPACE', description: label(a, `international bonus slot money (Retrosheet info: ${a.text})`), amount_disclosure: 'UNKNOWN', source_keys: S }
          if (a.kind === 'DRAFT_PICK') return { asset_type: 'DRAFT_PICK', description: label(a, a.text), source_keys: S }
          const out = { asset_type: 'PLAYER_TO_BE_NAMED', description: label(a, 'player to be named'), source_keys: S, ...(a.condition_text ? { condition_text: a.condition_text } : {}) }
          if (a.resolution) out.resolution = { kind: 'PLAYER', player: person(a.resolution.retro_id), resolved_on: a.resolution.resolved_on, source_key: keys.retro, notes: `Retrosheet row ${a.resolution.line}: later-dated player under the same transaction id` }
          return out
        })
      }
    })
  }
  return rec
}

/** Stage every trade group in [from, to]: { doc, candidates, holds }. Same-day same-club trades name each other (the source gives them different ids). */
export function buildCandidates (groups, resolved, { from, to, declarations, keys, batchKey }) {
  const candidates = []
  const holds = []
  for (const g of groups) {
    if (g.family !== 'TRADE' || g.season < from || g.season > to) continue
    const why = holdReasons(g, resolved)
    if (why.length) holds.push({ key: g.key, source_id: g.source_id, season: g.season, date: g.date.text, parties: g.parties, lines: g.rows.map((r) => r.line), reasons: why })
    else candidates.push({ g, record: toRecord(g, resolved, keys) })
  }
  for (const a of candidates) {
    a.record.distinct_from = candidates.filter((b) => b !== a && b.record.date === a.record.date && b.g.parties.filter((p) => a.g.parties.includes(p)).length >= 2).map((b) => `RETROSHEET_TXN:${b.g.key}`).sort()
  }
  const doc = prepareTradeDoc({ format: 'bai-research-import/1', batch_key: batchKey, channel: 'TRADES',
    description: `Retrosheet trades ${from}-${to}: one source lineage, never verified complete by this source alone`, sources: declarations, records: candidates.map((c) => c.record) })
  return { doc, candidates: candidates.map((c) => c.g.key).sort(), holds: holds.sort((a, b) => (a.date + a.key < b.date + b.key ? -1 : 1)) }
}
