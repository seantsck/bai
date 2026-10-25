// Later-dated members of a Retrosheet trade group (docs/transactions/later-added-assets-proposal.md). A trade id can carry rows dated after the
// trade: a player named for a PTBNL, a player simply added, a source-stated "added to trade", a later cash row, a void or return. This classifier
// only LABELS them, deterministically, from what the source states; it never merges groups, never invents a placeholder and never reinterprets a
// record BAI already holds. The labels are the proposal's `addition_kind` values.
export const ADDITION_KINDS = {
  PTBNL_NAMED: 'exactly one player-to-be-named placeholder exists in the same direction: a formal PTBNL resolution (already modeled by migration 028)',
  PTBNL_AMBIGUOUS: 'several placeholders in the direction, or the placeholder is already matched by another later row: a person decides the pairing',
  ADDED_TO_TRADE: 'the source types the row "Tp" (added to a trade, usually because an original player refused to report or retired): an amendment, not a PTBNL',
  ADDED_LATER_UNSTATED: 'a player row under the trade id, dated later, with no placeholder in the original rows: the source does not say why',
  LATER_NON_PLAYER_ROW: 'a later row with no player (cash, a pick, slot money or text)',
  LATER_VOID_OR_RETURN: 'a later void, return or refusal row (Tv, Tr, Tn, Cr)'
}

/** Labels for every member of `group` dated after the group's first date. Returns [{ line, kind, direction, days_after, player_kind, new_direction, type }]. */
export function classifyLaterMembers (group) {
  if (group.family !== 'TRADE') return []
  const first = group.date.text
  const dir = (r) => (r.from.kind === 'MLB' && r.to.kind === 'MLB' ? `${r.from.franchise}>${r.to.franchise}` : null)
  const earliest = group.rows.filter((r) => r.date.text === first)
  const placeholders = new Map()
  for (const r of earliest) if (r.assets_from_info.some((a) => a.kind === 'PTBNL')) placeholders.set(dir(r), (placeholders.get(dir(r)) ?? 0) + 1)
  const originalDirs = new Set(earliest.map(dir).filter(Boolean))
  const claimed = new Map()
  const out = []
  const days = (a, b) => { const d = (s) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8) || 1); return Math.round((d(a) - d(b)) / 86400000) }
  for (const r of group.rows) {
    if (r.date.text <= first) continue
    const d = dir(r)
    let kind
    if (['Tv', 'Tr', 'Tn', 'Cr'].includes(r.type)) kind = 'LATER_VOID_OR_RETURN'
    else if (r.player.kind === 'NONE') kind = 'LATER_NON_PLAYER_ROW'
    else if (r.type === 'Tp') kind = 'ADDED_TO_TRADE'
    else if ((placeholders.get(d) ?? 0) === 1 && !claimed.has(d)) { kind = 'PTBNL_NAMED'; claimed.set(d, r.line) }
    else if ((placeholders.get(d) ?? 0) >= 1) kind = 'PTBNL_AMBIGUOUS'
    else kind = 'ADDED_LATER_UNSTATED'
    out.push({ line: r.line, kind, direction: d, days_after: days(r.date.text, first), player_kind: r.player.kind, new_direction: d !== null && !originalDirs.has(d), type: r.type })
  }
  return out
}

/** Aggregate study over groups: counts by kind and player kind, gap distribution, new directions. */
export function laterMemberStudy (groups) {
  const study = { groups_with_later_members: 0, members: 0, by_kind: {}, by_kind_player: {}, groups_by_kind_mix: {}, new_direction_members: 0, days_after: { '0-7': 0, '8-30': 0, '31-90': 0, '91-365': 0, '366+': 0 }, groups_with_ptbnl_placeholder: 0, groups_with_placeholder_and_later_member: 0 }
  for (const g of groups) {
    if (g.family !== 'TRADE') continue
    const hasPlaceholder = g.rows.some((r) => r.assets_from_info.some((a) => a.kind === 'PTBNL'))
    if (hasPlaceholder) study.groups_with_ptbnl_placeholder++
    const later = classifyLaterMembers(g)
    if (!later.length) continue
    study.groups_with_later_members++
    if (hasPlaceholder) study.groups_with_placeholder_and_later_member++
    const kinds = [...new Set(later.map((m) => m.kind))].sort().join('+')
    study.groups_by_kind_mix[kinds] = (study.groups_by_kind_mix[kinds] ?? 0) + 1
    for (const m of later) {
      study.members++
      study.by_kind[m.kind] = (study.by_kind[m.kind] ?? 0) + 1
      const k = `${m.kind}|${m.player_kind}`; study.by_kind_player[k] = (study.by_kind_player[k] ?? 0) + 1
      if (m.new_direction) study.new_direction_members++
      const b = m.days_after <= 7 ? '0-7' : m.days_after <= 30 ? '8-30' : m.days_after <= 90 ? '31-90' : m.days_after <= 365 ? '91-365' : '366+'
      study.days_after[b]++
    }
  }
  return study
}
