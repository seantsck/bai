// Independent per-club evidence: archived Baseball-Reference franchise-year draft pages (Internet Archive captures).
// Used only to corroborate how many selections a club made in a phase, and who, by overall pick. Never imported as facts.

// B-Ref team codes seen on draft pages -> BAI franchise keys (codes are era-specific; unknown codes are reported, not guessed).
export const BREF_TEAM_CODES = {
  ANA: 'LAA', CAL: 'LAA', LAA: 'LAA', ARI: 'ARI', ATL: 'ATL', MLN: 'ATL', BAL: 'BAL', BOS: 'BOS', CHC: 'CHC', CHW: 'CWS', CIN: 'CIN',
  CLE: 'CLE', COL: 'COL', DET: 'DET', FLA: 'MIA', MIA: 'MIA', HOU: 'HOU', KCR: 'KC', KCA: 'ATH', OAK: 'ATH', LAD: 'LAD', MIL: 'MIL', SEP: 'MIL',
  MIN: 'MIN', NYM: 'NYM', NYY: 'NYY', PHI: 'PHI', PIT: 'PIT', SDP: 'SD', SEA: 'SEA', SFG: 'SF', STL: 'STL', TBD: 'TB', TBR: 'TB',
  TEX: 'TEX', WSA: 'TEX', TOR: 'TOR', MON: 'WSH', WSN: 'WSH'
}

// B-Ref draft_type values -> MLB draftType codes.
export const BREF_DRAFT_TYPES = { junreg: 'JR', janreg: 'NR', jansec: 'NS', junsec: 'JS', jundel: 'JD', augleg: 'AL' }

/** CDX lines "timestamp original" -> latest capture per (team, draft_type) for one year. */
export function capturesFromCdx (text, year) {
  const out = new Map()
  for (const line of text.split('\n')) {
    const [ts, original] = line.trim().split(/\s+/)
    if (!/^\d{14}$/.test(ts ?? '') || !original) continue
    const u = new URL(original.replace(/^http:/, 'https:'))
    const q = Object.fromEntries([...u.searchParams].map(([k, v]) => [k.toLowerCase(), v]))
    if (q.query_type !== 'franch_year' || String(q.year_id) !== String(year) || !q.team_id || !BREF_DRAFT_TYPES[q.draft_type]) continue
    const k = `${q.team_id.toUpperCase()}|${q.draft_type}`
    if (!out.has(k) || out.get(k).ts < ts) out.set(k, { ts, original, team: q.team_id.toUpperCase(), code: BREF_DRAFT_TYPES[q.draft_type] })
  }
  return [...out.values()].sort((a, b) => `${a.team}${a.code}`.localeCompare(`${b.team}${b.code}`))
}

/** Rows of a B-Ref draft table: [{ overall, name }] (overall pick numbers only; anything else is skipped). */
export function parseBrefDraftRows (html) {
  const clean = (s) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').trim()
  const rows = []
  for (const [, row] of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const c = {}
    for (const [, k, v] of row.matchAll(/<t[hd][^>]*data-stat="([^"]+)"[^>]*>([\s\S]*?)<\/t[hd]>/g)) c[k] = clean(v)
    if (!c.overall_pick || !/^\d+$/.test(c.overall_pick)) continue
    // B-Ref prefixes some names with markers (e.g. "*" or "+"); they are not part of the name.
    rows.push({ overall: Number(c.overall_pick), round: c.draft_round ?? null, roundPick: Number(c.round_pick) || null, name: (c.player ?? '').replace(/\s*\(.*\)$/, '').replace(/^[*+#^]+\s*/, '') })
  }
  return rows
}

export const fold = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z]/g, '')

/** Decodes an archived page: UTF-8 when valid, otherwise Windows-1252 / Latin-1 (older captures). */
export function decodeHtml (buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf) } catch { return new TextDecoder('windows-1252').decode(buf) }
}

// Surname forms: the last word (suffixes dropped) and, for hyphenated surnames, each part ("Gutierrez-Portalatin").
const surnames = (n) => {
  const last = String(n ?? '').trim().split(/\s+/).filter((w) => !/^(jr|sr|ii|iii|iv)\.?$/i.test(w)).pop() ?? ''
  return new Set([fold(last), ...last.split('-').map(fold)].filter(Boolean))
}
const sameSurname = (a, b) => { const x = surnames(a); return [...surnames(b)].some((s) => x.has(s)) }
// Some captures already contain U+FFFD where an accented letter was lost; it then stands for exactly one letter.
const sameName = (mlb, other) => {
  if (!other.includes('\uFFFD')) return fold(mlb) === fold(other)
  const pattern = other.split('\uFFFD').map(fold).join('.')
  return new RegExp(`^${pattern}$`).test(fold(mlb))
}

/**
 * Matches an independent club list to MLB's picks for the same club and phase. Overall pick numbers are not compared
 * for identity (older drafts are numbered differently by different compilers); people are matched by full name, then by
 * surname within the same round. Returns counts and the specific differences, for review.
 */
export function compareClubLists (mlbPicks, rows) {
  const unused = new Set(mlbPicks)
  const pairs = []
  const unmatched = []
  for (const r of rows) {
    let m = [...unused].find((p) => sameName(p.person.full_name, r.name))
    let how = 'full name'
    if (!m) { m = [...unused].find((p) => sameSurname(p.person.full_name, r.name) && (p.overall_pick === r.overall || String(p.round_code) === String(r.round))); how = 'surname at the same pick or in the same round' }
    if (!m) { unmatched.push(r); continue }
    unused.delete(m)
    pairs.push({ r, p: m, how })
  }
  return {
    mlb: mlbPicks.length, other: rows.length, matched: pairs.length, unmatched,
    unlistedByOther: [...unused],
    nameVariants: pairs.filter((x) => x.how !== 'full name').map((x) => `#${x.p.overall_pick} MLB "${x.p.person.full_name}" / "${x.r.name}"`),
    numbering: pairs.filter((x) => x.p.overall_pick !== x.r.overall).length
  }
}
