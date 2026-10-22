// Comparison of a reconstructed draft (Wikipedia rows) with another published list, row by row, by overall pick.
// Facts only (pick, club, name, school label). Nothing here resolves a disagreement: each one becomes a finding that
// needs a reviewer. Evidence files live under .local/ and are never committed.
import { compareNames } from './retrosheet.mjs'
import { WIKI_TEAMS } from './wikipedia-draft.mjs'

/** "pick|club|player|school" lines -> rows. Blank lines and # comments are skipped; malformed lines throw. */
export function parseEvidenceRows (text) {
  const rows = []
  for (const [i, raw] of text.split('\n').entries()) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const p = line.split('|')
    if (p.length < 4 || !/^\d+$/.test(p[0])) throw new Error(`evidence line ${i + 1}: expected pick|club|player|school`)
    rows.push({ pick: Number(p[0]), club: p[1].trim(), player: p[2].trim(), school: p.slice(3).join('|').trim() })
  }
  return rows
}

const fold = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
const STOP = new Set(['hs', 'high', 'school', 'university', 'college', 'of', 'the', 'academy', 'senior', 'catholic', 'state', 'ss', 'cc', 'institute', 'univ'])
// Abbreviations that differ between outlets for the same school; state tails (", IL", "(Ill.)") are ignored.
const ALIAS = { nc: 'north carolina', mt: 'mount', ill: 'il', calif: 'ca', fla: 'fl', ore: 'or', pa: 'pa', ga: 'ga', tenn: 'tn', okla: 'ok', ont: 'on', ariz: 'az', colo: 'co', hawaii: 'hi' }
const tokens = (s) => fold(s).replace(/\([^)]*\)/g, ' ').replace(/,\s*[a-z]{2}\s*$/, ' ').replace(/[^a-z0-9]+/g, ' ').split(' ').flatMap((t) => (ALIAS[t] ?? t).split(' ')).filter((t) => t && !STOP.has(t))

/** 'SAME' | 'DIFFERENT' (token sets disjoint, or neither contained in the other) — conservative, a reviewer sees every DIFFERENT. */
export function compareSchools (a, b) {
  const x = tokens(a)
  const y = tokens(b)
  if (!x.length || !y.length) return 'UNKNOWN'
  const xs = new Set(x)
  const ys = new Set(y)
  return x.every((t) => ys.has(t)) || y.every((t) => xs.has(t)) ? 'SAME' : 'DIFFERENT'
}

const normClub = (s) => WIKI_TEAMS[String(s).replace(/\s*\(baseball\)$/, '').trim()] ?? null

/** Compare `picks` (wikipedia-draft parse) with evidence rows. Returns { matched, findings, summary }. */
export function compareLists (picks, rows) {
  const byPick = new Map(rows.map((r) => [r.pick, r]))
  const findings = []
  const per = []
  for (const p of picks) {
    const r = byPick.get(p.overall_pick)
    if (!r) { findings.push({ pick: p.overall_pick, kind: 'NOT_IN_EVIDENCE', detail: `${p.name} (${p.franchise})` }); per.push({ pick: p.overall_pick, club: p.franchise, status: 'ABSENT' }); continue }
    const club = normClub(r.club)
    const clubOk = club === p.franchise
    const name = compareNames(p.name, r.player)
    const school = compareSchools(p.school_label ?? '', r.school)
    const issues = []
    if (!clubOk) issues.push({ kind: 'CLUB_DIFFERS', detail: `${p.franchise} vs ${r.club}` })
    if (name === 'DIFFERENT_SURNAME') issues.push({ kind: 'SURNAME_SPELLING_DIFFERS', detail: `${p.name} vs ${r.player}` })
    else if (name === 'SAME_SURNAME_DIFFERENT_FIRST') issues.push({ kind: 'GIVEN_NAME_DIFFERS', detail: `${p.name} vs ${r.player}` })
    if (school === 'DIFFERENT') issues.push({ kind: 'SCHOOL_DIFFERS', detail: `${p.school_label} vs ${r.school}` })
    for (const i of issues) findings.push({ pick: p.overall_pick, ...i })
    per.push({ pick: p.overall_pick, club: p.franchise, status: issues.length ? 'DISAGREES' : 'AGREES', name_match: name, school_match: school })
  }
  const extra = rows.filter((r) => !picks.some((p) => p.overall_pick === r.pick))
  for (const r of extra) findings.push({ pick: r.pick, kind: 'NOT_IN_RECONSTRUCTION', detail: `${r.player} (${r.club})` })
  const clubs = {}
  for (const x of per) { const c = (clubs[x.club] ??= { picks: 0, agree: 0, disagree: 0, absent: 0 }); c.picks++; c[x.status === 'AGREES' ? 'agree' : x.status === 'DISAGREES' ? 'disagree' : 'absent']++ }
  const count = (s) => per.filter((x) => x.status === s).length
  return { per, findings, clubs, summary: { picks: picks.length, evidence_rows: rows.length, agree: count('AGREES'), disagree: count('DISAGREES'), absent: count('ABSENT'), evidence_only: extra.length } }
}
