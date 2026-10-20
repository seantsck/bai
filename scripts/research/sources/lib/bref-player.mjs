// Parses a Baseball-Reference player page (live or archived; gzip or plain) into season-by-team WAR. Nothing is fetched.
// Value tables: players_value_batting (b_war) and players_value_pitching (p_war). A season-team value is the sum of the
// two tables' WAR for that row (B-Ref's player WAR counts a pitcher's batting value too); multi-team total rows ("2TM",
// "3TM", "TOT") are skipped because the per-team rows carry the split. The career figure is the page summary's WAR.
import zlib from 'node:zlib'

export function decode (raw) {
  if (raw[0] === 0x1f && raw[1] === 0x8b) return zlib.gunzipSync(raw).toString('utf8')
  const t = raw.toString('utf8')
  if (t.includes('<html') || t.includes('<!DOCTYPE')) return t
  try { return zlib.brotliDecompressSync(raw).toString('utf8') } catch { return t }
}

/** B-Ref team codes (all eras since 2010) -> BAI franchise keys. Unknown codes are an error, never a guess. */
export const BREF_TEAMS = {
  ARI: 'ARI', ATL: 'ATL', BAL: 'BAL', BOS: 'BOS', CHC: 'CHC', CHW: 'CWS', CIN: 'CIN', CLE: 'CLE', COL: 'COL', DET: 'DET', HOU: 'HOU', KCR: 'KC', LAA: 'LAA',
  LAD: 'LAD', MIA: 'MIA', FLA: 'MIA', MIL: 'MIL', MIN: 'MIN', NYM: 'NYM', NYY: 'NYY', OAK: 'ATH', ATH: 'ATH', PHI: 'PHI', PIT: 'PIT', SDP: 'SD', SEA: 'SEA',
  SFG: 'SF', STL: 'STL', TBR: 'TB', TBD: 'TB', TEX: 'TEX', TOR: 'TOR', WSN: 'WSH', ANA: 'LAA'
}

function rows (html, tableId, stat) {
  const i = html.indexOf(`id="${tableId}"`)
  if (i < 0) return []
  const body = html.slice(html.indexOf('<tbody', i), html.indexOf('</tbody>', i))
  const out = []
  for (const [, r] of body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cell = (k) => ((r.match(new RegExp(`data-stat="${k}"[^>]*>((?:<[^>]+>)*)([^<]*)`)) ?? [])[2] ?? '').trim()
    const season = Number(cell('year_id') || cell('year_ID'))
    const team = cell('team_name_abbr') || cell('team_ID')
    const war = cell(stat)
    if (!season || !team || war === '') continue
    out.push({ season, team, war: Number(war) })
  }
  return out
}

/** { seasons: [{ season, team, franchise, war }], career, maxSeason } ; throws on an unmapped team code. */
export function parseSeasonWar (html) {
  const split = new Map()
  for (const r of [...rows(html, 'players_value_batting', 'b_war'), ...rows(html, 'players_value_pitching', 'p_war')]) {
    if (/^(\dTM|TOT)$/.test(r.team)) continue
    const franchise = BREF_TEAMS[r.team]
    if (!franchise) throw new Error(`unmapped Baseball-Reference team code ${r.team}`)
    const k = `${r.season}|${franchise}`
    split.set(k, { season: r.season, team: r.team, franchise, war: Math.round(((split.get(k)?.war ?? 0) + r.war) * 10) / 10 })
  }
  // The summary shows "WAR <last season> <career>", or only "WAR <career>" when the player has no line for the latest
  // season. Tooltip attributes are removed first (they contain markup).
  const summary = ((html.match(/<div class="p1">([\s\S]{0,4000})/) ?? [])[1] ?? '').replace(/data-tip="[^"]*"/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
  const war = summary.match(/WAR (-?\d+\.\d)(?: (-?\d+\.\d))?/)
  const nums = war ? [null, null, war[2] ?? war[1]] : null
  const seasons = [...split.values()].sort((a, b) => a.season - b.season || a.franchise.localeCompare(b.franchise))
  return { seasons, career: nums ? Number(nums[2]) : null, maxSeason: seasons.length ? seasons.at(-1).season : null }
}

/**
 * The last complete season a capture covers, or null when it cannot be used. November-December: that year's season is
 * over. January to March 25: the previous year. April-October (in season): the previous year, and only if the page has
 * no row for the capture's year yet (otherwise it holds a partial season).
 */
export function completeThrough (timestamp, maxSeason) {
  const y = Number(timestamp.slice(0, 4))
  const md = timestamp.slice(4, 8)
  if (md >= '1101') return y
  if (md <= '0325') return maxSeason != null && maxSeason >= y ? null : y - 1
  return maxSeason != null && maxSeason >= y ? null : y - 1
}
