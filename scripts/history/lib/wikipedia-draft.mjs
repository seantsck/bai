// Wikipedia '<year> Major League Baseball draft' wikitext -> normalized selections. Pure (no I/O): the same revision always
// gives the same picks. Facts only (pick, round table, club, position, school label as printed); article text is not kept.
// Wikipedia is an aggregator: its rows are one source, so a class built from them alone is a partial reconstruction.
import { roundCode, selectionType, schoolFromLabel } from './mlb.mjs'

// Wikipedia club names -> BAI franchise keys (a name not listed is reported, never guessed).
export const WIKI_TEAMS = {
  'Arizona Diamondbacks': 'ARI', 'Atlanta Braves': 'ATL', 'Baltimore Orioles': 'BAL', 'Boston Red Sox': 'BOS', 'Chicago Cubs': 'CHC', 'Chicago White Sox': 'CWS',
  'Cincinnati Reds': 'CIN', 'Cleveland Indians': 'CLE', 'Cleveland Guardians': 'CLE', 'Colorado Rockies': 'COL', 'Detroit Tigers': 'DET', 'Houston Astros': 'HOU',
  'Kansas City Royals': 'KC', 'Los Angeles Angels': 'LAA', 'Los Angeles Dodgers': 'LAD', 'Miami Marlins': 'MIA', 'Milwaukee Brewers': 'MIL', 'Minnesota Twins': 'MIN',
  'New York Mets': 'NYM', 'New York Yankees': 'NYY', 'Oakland Athletics': 'ATH', 'Athletics': 'ATH', 'Philadelphia Phillies': 'PHI', 'Pittsburgh Pirates': 'PIT',
  'San Diego Padres': 'SD', 'San Francisco Giants': 'SF', 'Seattle Mariners': 'SEA', 'St. Louis Cardinals': 'STL', 'Tampa Bay Rays': 'TB', 'Texas Rangers': 'TEX',
  'Toronto Blue Jays': 'TOR', 'Washington Nationals': 'WSH'
}

/** Remove refs, footnote templates, comments and tags; resolve links; keep readable text. */
export function plain (wikitext) {
  let s = String(wikitext)
  s = s.replace(/<!--[\s\S]*?-->/g, '')
  s = s.replace(/<ref\b[^>]*\/>/gi, '').replace(/<ref\b[^>]*>[\s\S]*?<\/ref>/gi, '')
  // nested {{#tag:ref|...}} / {{efn|...}} footnotes: drop with brace matching
  for (;;) {
    const i = s.search(/\{\{\s*(#tag:ref|efn|NoteTag|sfn)\b/i)
    if (i < 0) break
    let depth = 0; let j = i
    for (; j < s.length; j++) {
      if (s.startsWith('{{', j)) { depth++; j++ } else if (s.startsWith('}}', j)) { depth--; j++; if (depth === 0) { j++; break } }
    }
    s = s.slice(0, i) + s.slice(j)
  }
  s = s.replace(/\{\{\s*sortname\s*\|([^{}]*)\}\}/gi, (_, a) => {
    const p = a.split('|').filter((x) => !/=/.test(x)).map((x) => x.trim())
    return [p[0], p[1]].filter(Boolean).join(' ')
  })
  s = s.replace(/\{\{[^{}]*\}\}/g, '')
  s = s.replace(/\[\[(?:[^\]|]*\|)?([^\]]+)\]\]/g, '$1')
  s = s.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/'''?/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  return s.replace(/\s+/g, ' ').trim()
}

/** The Wikipedia page a player cell links to: a sortname template (with its dab) or a [[target|label]] link; null for plain text. */
export function linkTitle (rawCell) {
  const body = cellValue(rawCell)
  const sn = body.match(/\{\{\s*sortname\s*\|([^{}]*)\}\}/i)
  if (sn) {
    const parts = sn[1].split('|').map((x) => x.trim())
    const named = Object.fromEntries(parts.filter((x) => x.includes('=')).map((x) => [x.slice(0, x.indexOf('=')).trim(), x.slice(x.indexOf('=') + 1).trim()]))
    if (named.nolink) return null
    const pos = parts.filter((x) => !x.includes('='))
    if (pos.length < 2) return null
    return `${pos[0]} ${pos[1]}${named.dab ? ` (${named.dab})` : ''}`
  }
  const l = body.match(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/)
  return l ? l[1].trim() : null
}

/** The text before the first top-level `|` of a cell, e.g. `style="..."|value` -> value. */
const cellValue = (line) => {
  const body = line.replace(/^[|!]/, '')
  const m = body.match(/^((?:[a-z-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s|]+)\s*)+)\|(?!\|)([\s\S]*)$/i)
  if (m) return m[2]
  // Wiki markup typed with a curly quote (style="...;”|value) breaks the attribute pattern; strip a leading attribute run anyway.
  const loose = body.match(/^(?:scope|style|class|colspan|rowspan)\s*=[^|{]*\|(?!\|)([\s\S]*)$/i)
  return loose ? loose[1] : body
}

const ROUND_TITLES = [
  [/^first round$/i, '1'], [/^second round$/i, '2'], [/^third round$/i, '3'], [/^fourth round$/i, '4'], [/^fifth round$/i, '5'],
  [/^competitive balance round a$/i, 'CBA'], [/^competitive balance round b$/i, 'CBB'],
  // The Prospect Promotion Incentive pick (2022 CBA): one added pick after the first round's numbered picks and before Competitive Balance A.
  [/^prospect promotion incentive picks?$/i, 'PPI']
]
// Compensation picks (for a club that lost a qualifying free agent) are placed after the second round and the competitive
// balance round B in the article; BAI's convention for them is C-2. This label is derived from the table title, not from
// MLB's own pick label, and is reported as such.
// A "Compensatory round" table that comes BEFORE the second round (2024 and 2025 list one after the first round's incentive picks) holds
// compensation picks for the first round: C-1. One after the second round's competitive balance picks is C-2.
const roundFor = (title, { afterSecondRound = true } = {}) => {
  const t = title.replace(/\s+/g, ' ').trim()
  for (const [re, code] of ROUND_TITLES) if (re.test(t)) return roundCode(code)
  if (/^compensat(?:ory|ion) round$/i.test(t)) return afterSecondRound ? 'C-2' : 'C-1'
  return null
}

/** A cell line may hold several cells joined by "||" ("|3||81"). Splits at "||" outside [[links]] and {{templates}}. */
export function splitInlineCells (line) {
  if (!line.startsWith('|') || !line.includes('||')) return [line]
  const body = line.slice(1)
  const out = []; let depth = 0; let cur = ''
  for (let i = 0; i < body.length; i++) {
    const two = body.slice(i, i + 2)
    if (two === '[[' || two === '{{') { depth++; cur += two; i++ } else if (two === ']]' || two === '}}') { depth = Math.max(0, depth - 1); cur += two; i++ } else if (two === '||' && depth === 0) { out.push(cur); cur = ''; i++ } else cur += body[i]
  }
  out.push(cur)
  return out.map((c) => `|${c}`)
}

/** Parse the article. Returns { picks, findings, stated, sections }. */
export function parseDraftArticle (wikitext, { year }) {
  const findings = []
  const infobox = (name) => wikitext.match(new RegExp(`\\|\\s*${name}\\s*=\\s*(\\d+)`))?.[1]
  const stated = { overall: Number(infobox('overall')) || null, rounds: Number(infobox('rounds')) || null, first_round: Number(infobox('first_round')) || null }
  const start = wikitext.search(/^==\s*Draft selections\s*==/m)
  const end = wikitext.search(/^==\s*Summary\s*==/m)
  if (start < 0) throw new Error('no "Draft selections" section')
  const body = wikitext.slice(start, end > start ? end : undefined)
  const picks = []
  const sections = []
  const parts = body.split(/^===\s*(.+?)\s*===\s*$/m)
  let sawSecondRound = false
  for (let i = 1; i < parts.length; i += 2) {
    const title = parts[i]
    // "Other notable selections" (later rounds, only some picks): a table with the round in the first column. These rows are
    // real selections, but the table is a selection of the article's editors, not a list of the round: never a census.
    const notable = /^other notable selections$/i.test(title.trim())
    if (/^second round$/i.test(title.trim())) sawSecondRound = true
    // C-1 only if the second round has not come yet AND comes later in the article; otherwise the table follows the second round (C-2).
    const secondRoundAhead = parts.slice(i + 2).some((x, k) => k % 2 === 0 && /^second round$/i.test(x.trim()))
    const code = notable ? null : roundFor(title, { afterSecondRound: sawSecondRound || !secondRoundAhead })
    if (!code && !notable) { findings.push({ kind: 'UNKNOWN_SECTION', detail: title }); continue }
    const rows = parts[i + 1].split(/^\|-\s*$/m).slice(1)
    let n = 0
    for (const row of rows) {
      const lines = row.split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => /^[|!]/.test(l) && !/^\|[}-]/.test(l))
      // A cell may continue over several lines (footnote bodies); merge any line that does not start a new cell.
      const cells = []
      for (const l of row.split('\n')) {
        if (/^\|[}-]/.test(l) || /^\{\|/.test(l) || /^! scope="col"/.test(l)) continue
        if (/^[|!]/.test(l)) cells.push(l); else if (cells.length) cells[cells.length - 1] += ` ${l}`
      }
      void lines
      // Inline cell separators ("|3||81" holds two cells): split outside links and templates. Rows without "||" are untouched.
      cells.splice(0, cells.length, ...cells.flatMap(splitInlineCells))
      if (cells.length < (notable ? 6 : 5)) { if (cells.length) findings.push({ kind: 'SHORT_ROW', detail: `${title}: ${cells.length} cells` }); continue }
      const vals = cells.map((c) => plain(cellValue(c)))
      const [pickC, playerRaw, teamC, posC, schoolC] = notable ? vals.slice(1) : vals
      const playerC = playerRaw.replace(/\s*\*+\s*$/, '')   // "*" is the article's "player did not sign" marker; it is not part of the name
      const rowCode = notable ? roundCode(vals[0]) : code
      const nameCell = notable ? cells[2] : cells[1]
      if (notable && !rowCode) { findings.push({ kind: 'UNKNOWN_ROUND', detail: `${title}: ${vals[0]}` }); continue }
      const overall = Number(pickC.match(/^\d+/)?.[0])
      const team = teamC.replace(/\s*\(baseball\)$/, '').trim()
      const school = schoolC.replace(/\s*\(([A-Z]{2}|[A-Z][a-z]+)\)$/, (m, st) => `, ${st}`)
      n++
      picks.push({
        year, overall_pick: Number.isInteger(overall) ? overall : null, round_title: title, round_code: rowCode, selection_type: selectionType(rowCode), ...(notable ? { notable_only: true } : {}),
        name: playerC, link_title: linkTitle(nameCell), team_label: team, franchise: WIKI_TEAMS[team] ?? null, position: posC || null, school_label: school || null, school: schoolFromLabel(school),
        did_not_sign_marker: /\*\s*$/.test(playerRaw) || /\*/.test(nameCell)
      })
    }
    sections.push({ title, round_code: notable ? 'NOTABLE' : code, rows: n })
  }
  // Integrity findings: reported, never repaired.
  const seen = new Map()
  for (const p of picks) {
    if (!p.overall_pick) findings.push({ kind: 'NO_PICK_NUMBER', detail: `${p.round_title}: ${p.name}` })
    else if (seen.has(p.overall_pick)) findings.push({ kind: 'DUPLICATE_PICK_NUMBER', detail: `#${p.overall_pick}: ${seen.get(p.overall_pick)} / ${p.name}` })
    else seen.set(p.overall_pick, p.name)
    if (!p.franchise) findings.push({ kind: 'UNKNOWN_TEAM', detail: `#${p.overall_pick} ${p.team_label}` })
    if (!p.name) findings.push({ kind: 'NO_NAME', detail: `#${p.overall_pick}` })
  }
  const max = Math.max(0, ...picks.map((p) => p.overall_pick ?? 0))
  const gaps = []
  for (let k = 1; k <= max; k++) if (!seen.has(k)) gaps.push(k)
  if (gaps.length) findings.push({ kind: 'PICK_NUMBER_GAPS', detail: gaps.join(', ') })
  if (stated.overall && picks.length !== stated.overall) findings.push({ kind: 'COUNT_DIFFERS_FROM_STATED', detail: `${picks.length} rows, article states ${stated.overall}` })
  // Source-structure conflicts, found by deterministic checks on the article alone (no other source). Every row involved is marked so the
  // release build holds it: a person decides which row is wrong, and the article value is never replaced from elsewhere.
  const conflict = (p, reason) => { p.source_conflict = p.source_conflict ? `${p.source_conflict}; ${reason}` : reason }
  const byNumber = new Map()
  for (const p of picks) if (p.overall_pick) byNumber.set(p.overall_pick, [...(byNumber.get(p.overall_pick) ?? []), p])
  for (const [n, rows] of byNumber) if (rows.length > 1) for (const p of rows) conflict(p, `duplicate pick number in the source article: ${rows.length} rows claim pick ${n} (${rows.map((r) => r.name).join(' / ')})`)
  // A numbered round is a contiguous block of picks: a row labelled with a lower round cannot follow a higher-round row by pick number.
  const numbered = picks.filter((p) => p.overall_pick && /^\d+$/.test(p.round_code)).sort((a, b) => a.overall_pick - b.overall_pick)
  for (let i = 0; i < numbered.length; i++) {
    for (let j = i + 1; j < numbered.length; j++) {
      const a = numbered[i]; const b = numbered[j]
      if (Number(a.round_code) > Number(b.round_code) && a.overall_pick < b.overall_pick) {
        const why = `round label conflicts with pick order in the source article: #${a.overall_pick} ${a.name} is labelled round ${a.round_code} but #${b.overall_pick} ${b.name} (a later pick) is labelled round ${b.round_code}`
        conflict(a, why); conflict(b, why)
      }
    }
  }
  for (const p of picks) if (p.source_conflict) findings.push({ kind: 'SOURCE_CONFLICT', detail: `#${p.overall_pick} ${p.name}: ${p.source_conflict}` })
  picks.sort((a, b) => (a.overall_pick ?? 1e9) - (b.overall_pick ?? 1e9))
  return { picks, findings, stated, sections }
}
