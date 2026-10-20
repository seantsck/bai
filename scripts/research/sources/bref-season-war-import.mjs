// Builds an OUTCOMES batch that adds Baseball-Reference season-by-team WAR (and the page's career WAR) to a class's
// existing outcome audits, from archived player pages downloaded by fetch-bref-player-pages.mjs. Works for any club.
// Nothing is fetched and nothing is estimated:
//   * Each audited player who reached MLB is matched to a B-Ref id through the Chadwick Bureau register (MLBAM -> bbref);
//     no id, no capture, or an unmapped team code -> listed, not imported.
//   * A page counts only if every season on it is complete at the capture (lib/bref-player.mjs completeThrough);
//     through_season = the last complete season, observed_on = the capture date, locator = the archived URL.
//   * Season-team values are per organization (split seasons stay split); the career value is the page summary's.
//   * The audit itself is re-stated unchanged (state, through season, debut); a different value from another capture of
//     the same seasons is a conflict, never an overwrite.
//
//   node scripts/research/sources/bref-season-war-import.mjs --org LAD --outcomes research/imports/2016-draft-lad-outcomes.json \
//     --pages <dir from fetch-bref-player-pages.mjs> --register <chadwick register data dir> --register-commit <sha> \
//     --retrieved 2026-10-20 --out research/imports/2016-draft-lad-war-seasons.json
import fs from 'node:fs'
import path from 'node:path'
import { decode, parseSeasonWar, completeThrough } from './lib/bref-player.mjs'

const argv = process.argv.slice(2)
const arg = (k) => { const i = argv.indexOf(`--${k}`); const v = i >= 0 ? argv[i + 1] : null; if (!v) throw new Error(`--${k} is required`); return v }
const org = arg('org').toUpperCase()
const outcomes = JSON.parse(fs.readFileSync(arg('outcomes'), 'utf8'))
const pages = arg('pages')
const manifest = JSON.parse(fs.readFileSync(path.join(pages, 'manifest.json'), 'utf8'))

export function loadRegister (dir) {
  const map = new Map()
  for (const f of fs.readdirSync(dir).filter((f) => /^people-[0-9a-f]\.csv$/.test(f))) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n').slice(1)) {
      const c = line.split(',')
      if (c[2] && c[4]) map.set(c[2], c[4])
    }
  }
  return map
}
const register = loadRegister(arg('register'))
const year = outcomes.batch_key.slice(0, 4)
const SRC = `${org.toLowerCase()}:bref-player-pages-pre${manifest.before.slice(0, 4)}`
const REG = 'chadwick:register'
const isoTs = (ts) => `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`

const records = []
const skipped = []
for (const r of outcomes.records.filter((x) => x.audit_state === 'AUDITED_REACHED_MLB')) {
  const mlbam = r.player.external_ids.MLBAM
  const bbref = register.get(mlbam)
  const cap = bbref ? manifest.captures[bbref] : null
  if (!bbref || !cap?.timestamp) { skipped.push(`${r.player.full_name}: ${bbref ? 'no capture before ' + manifest.before : 'no B-Ref id in the register'}`); continue }
  const page = parseSeasonWar(decode(fs.readFileSync(path.join(pages, `${bbref}.html`))))
  if (!page.seasons.length || page.career == null) { skipped.push(`${r.player.full_name}: no value table or career WAR on the page`); continue }
  const through = completeThrough(cap.timestamp, page.maxSeason)
  if (through == null) { skipped.push(`${r.player.full_name}: capture ${cap.timestamp} holds a partial ${page.maxSeason} season`); continue }
  const observed = isoTs(cap.timestamp)
  records.push({
    type: 'OUTCOME_AUDIT', source_key: r.source_key, organization: org,
    player: { full_name: r.player.full_name, external_ids: { MLBAM: mlbam, BBREF: bbref }, source_key: REG },
    audit_state: r.audit_state, observation_through_season: r.observation_through_season, audited_on: r.audited_on,
    ...(r.debut ? { debut: r.debut } : {}),
    war: [
      ...page.seasons.map((s) => ({ system: 'BREF', scope: 'SEASON', season: s.season, organization: s.franchise, through_season: through, value: s.war, observed_on: observed, source_key: SRC, locator: `${cap.archived_url} (${s.season} ${s.team})` })),
      { system: 'BREF', scope: 'CAREER', through_season: through, value: page.career, observed_on: observed, source_key: SRC, locator: `${cap.archived_url} (summary WAR)` }
    ],
    notes: `Season splits through ${through} from the ${observed} capture; ${page.seasons.length} season-team rows sum to ${page.seasons.reduce((a, s) => a + s.war, 0).toFixed(1)}, page career ${page.career}.`
  })
}
const doc = {
  format: 'bai-research-import/1',
  batch_key: `${year}-draft-${org.toLowerCase()}-war-seasons`,
  channel: 'OUTCOMES',
  description: `${org} ${year} class: Baseball-Reference season-by-team WAR for ${records.length} players who reached MLB (archived pages captured before ${manifest.before}).`,
  sources: [
    { source_key: SRC, source_type: 'REFERENCE_DATABASE', authority_level: 'AGGREGATOR', title: `Baseball-Reference player pages, Wayback captures before ${manifest.before}`, publisher: 'Sports Reference',
      reference: 'https://www.baseball-reference.com/players/<x>/<id>.shtml via web.archive.org (per-entry locator = capture URL)', retrieved_date: arg('retrieved'),
      notes: 'Value tables (players_value_batting b_war + players_value_pitching p_war) per season and team; split seasons stay split; multi-team total rows skipped. Captures before opening day, so the last season is complete.' },
    { source_key: REG, source_type: 'REFERENCE_DATABASE', authority_level: 'REPUTABLE_SECONDARY', title: 'Chadwick Baseball Bureau register (people)', publisher: 'Chadwick Baseball Bureau',
      url: 'https://github.com/chadwickbureau/register', retrieved_date: arg('retrieved'), notes: `MLBAM -> Baseball-Reference id crosswalk, commit ${arg('register-commit')}.` }
  ],
  records
}
fs.writeFileSync(arg('out'), JSON.stringify(doc, null, 1) + '\n')
console.log(`wrote ${arg('out')}: ${records.length} player(s); not imported: ${skipped.length ? skipped.join('; ') : 'none'}`)
