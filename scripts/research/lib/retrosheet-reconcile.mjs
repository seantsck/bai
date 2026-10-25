// Reconcile Retrosheet trade groups with the trades BAI already holds. Nothing is written: BAI's rows and ids are only read
// (a snapshot), never replaced. snapshot.transactions[]: { id, date, date_precision, packages: [{ from, to, assets: [{ asset_type, player_id, mlbam, retro, name, amount_usd, description }] }] }.
import { holdReasons } from './retrosheet-adapter.mjs'

const dayNumber = (iso) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86400000)
export const CLASSES = ['EXISTING_CONFIRMED_MATCH', 'EXISTING_POSSIBLE_MATCH', 'NEW_TRANSACTION', 'SOURCE_DISAGREEMENT', 'IDENTITY_CONFLICT', 'INCOMPLETE_TRANSACTION']
const NEAR_DAYS = 7        // same clubs within a week: a possible match even with no shared player
const DISAGREE_DAYS = 30   // a shared player within a month: the same transaction, so a different date or direction is a disagreement
// A player appears in many trades over his career: sharing a player counts only when the dates are close.

function baiShape (t) {
  const parties = new Set()
  const players = new Map()   // mlbam -> direction
  const nameless = []
  for (const p of t.packages) {
    parties.add(p.from); parties.add(p.to)
    for (const a of p.assets) if (a.mlbam) players.set(String(a.mlbam), `${p.from}>${p.to}`); else if (a.asset_type === 'PLAYER') nameless.push(a.player_id)
  }
  return { id: t.id, date: t.date, precision: t.date_precision, parties: [...parties].sort(), players, nameless }
}

export function reconcileTrades (groups, resolved, snapshot, { from, to }) {
  const bai = snapshot.transactions.map(baiShape)
  const out = []
  const matchedBai = new Map()
  for (const g of groups) {
    if (g.family !== 'TRADE' || g.season < from || g.season > to) continue
    const holds = holdReasons(g, resolved)
    const members = []
    const conflicts = []
    let unresolved = 0
    for (const r of g.rows) {
      if (r.player.kind !== 'RETROSHEET_ID') { if (r.player.kind === 'NAME_ONLY') unresolved++; continue }
      const s = resolved.get(r.player.retro_id)
      const dir = r.from.kind === 'MLB' && r.to.kind === 'MLB' ? `${r.from.franchise}>${r.to.franchise}` : null
      if (s?.state === 'STRONG') members.push({ retro_id: r.player.retro_id, mlbam: s.evidence.mlbam, dir, line: r.line })
      else { unresolved++; if (s?.state === 'BAI_CONFLICT') conflicts.push({ retro_id: r.player.retro_id, evidence: s.evidence }) }
    }
    const day = g.date.iso ? dayNumber(g.date.iso) : null
    const cands = bai.map((b) => {
      const shared = []; const opposite = []
      for (const m of members) { const d = b.players.get(m.mlbam); const rev = m.dir ? m.dir.split('>').reverse().join('>') : null; if (d && d === m.dir) shared.push(m.mlbam); else if (d && d === rev) opposite.push(m.mlbam) }   // a player in a trade between other clubs is not evidence about this one
      const partyOverlap = b.parties.filter((p) => g.parties.includes(p)).length
      const near = day !== null && b.date ? Math.abs(dayNumber(b.date) - day) : null
      const baiOnly = [...b.players.keys()].filter((k) => !members.some((m) => m.mlbam === k))
      return { b, shared, opposite, partyOverlap, daysApart: near, baiOnly }
    }).filter((c) => (c.daysApart === null ? (c.shared.length || c.opposite.length) : c.daysApart <= DISAGREE_DAYS && (c.shared.length || c.opposite.length || (c.partyOverlap >= 2 && c.daysApart <= NEAR_DAYS))))
    const entry = { key: g.key, source_id: g.source_id, date: g.date.text, date_precision: g.date.precision, season: g.season, parties: g.parties, retro_lines: g.rows.map((r) => r.line), identified_players: members.length, unresolved_players: unresolved, retro_hold_reasons: holds }
    if (conflicts.length) Object.assign(entry, { classification: 'IDENTITY_CONFLICT', identity_conflicts: conflicts, bai_transaction_ids: cands.map((c) => c.b.id) })
    else if (cands.length) {
      cands.sort((a, b) => b.shared.length - a.shared.length || (a.daysApart ?? 999) - (b.daysApart ?? 999) || a.b.id - b.b.id)
      const best = cands[0]
      const evidence = { bai_transaction_id: best.b.id, bai_date: best.b.date, days_apart: best.daysApart, shared_players: best.shared, players_in_opposite_direction: best.opposite, bai_players_not_in_retrosheet_group: best.baiOnly, retrosheet_players_not_in_bai: members.filter((m) => !best.b.players.has(m.mlbam)).map((m) => m.mlbam), other_candidates: cands.slice(1).map((c) => c.b.id) }
      entry.bai_transaction_ids = cands.map((c) => c.b.id)
      entry.evidence = evidence
      if (best.opposite.length) entry.classification = 'SOURCE_DISAGREEMENT', entry.disagreement = 'direction'
      else if (best.shared.length && best.daysApart !== 0) entry.classification = 'SOURCE_DISAGREEMENT', entry.disagreement = 'date'
      else if (best.shared.length) { entry.classification = 'EXISTING_CONFIRMED_MATCH'; entry.assets_equal = !evidence.bai_players_not_in_retrosheet_group.length && !evidence.retrosheet_players_not_in_bai.length && unresolved === 0 && !holds.length }
      else entry.classification = 'EXISTING_POSSIBLE_MATCH'
      if (best.shared.length || entry.classification === 'EXISTING_POSSIBLE_MATCH') matchedBai.set(best.b.id, [...(matchedBai.get(best.b.id) ?? []), g.key])
    } else entry.classification = holds.length ? 'INCOMPLETE_TRANSACTION' : 'NEW_TRANSACTION'
    out.push(entry)
  }
  const counts = Object.fromEntries(CLASSES.map((c) => [c, out.filter((e) => e.classification === c).length]))
  const baiOnly = snapshot.transactions.filter((t) => !matchedBai.has(t.id) && t.date >= `${from}-01-01` && t.date <= `${to}-12-31`).map((t) => ({ bai_transaction_id: t.id, date: t.date }))
  const baiOutside = snapshot.transactions.filter((t) => t.date < `${from}-01-01` || t.date > `${to}-12-31`).length
  return { entries: out, counts, bai_transactions: snapshot.transactions.length, bai_in_period_without_retrosheet_counterpart: baiOnly, bai_outside_period: baiOutside }
}
