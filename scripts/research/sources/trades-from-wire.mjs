// Builds a TRADES batch (both sides of every trade that sent one of a class's audited players away from the club) and an
// OUTCOMES batch auditing the received players who never reached MLB, from files a researcher downloaded. Works for any club.
//   --outcomes  the class outcome imports (the trades are their transactions from --org)
//   --tx-dir    transactions?teamId=<club>&startDate=<d>&endDate=<d> per trade date, saved as tx-<date>.json
//   --people    people?personIds=<every player in those trades> (names, birth dates, debuts)
//   --affiliates affiliates.json files from fetch-mlb-player-outcomes.mjs (minor-league team -> parent club, per season)
//   --pages / --register  Baseball-Reference captures and the Chadwick register, for the received players' WAR
// Rules, nothing inferred:
//   * The parties come from MLB's wire: TR entries from the club (or an affiliate) to the counterparty and back. Other
//     same-day trades with third clubs are excluded by organization.
//   * Non-player assets come from the wire's own wording: "cash" (CASH), "Future Considerations" and "player to be named
//     later" (PLAYER_TO_BE_NAMED / OTHER), "Draft Pick" (DRAFT_PICK); amounts are undisclosed (NULL).
//   * A received player's WAR is imported only from a complete-season capture (see bref-season-war-import.mjs); without
//     one it is not observed. A received player with no MLB debut on the wire's people record is audited AUDITED_NO_MLB.
//
//   node --env-file-if-exists=.env.local scripts/research/sources/trades-from-wire.mjs --org LAD --team-id 119 \
//     --outcomes research/imports/2016-draft-lad-outcomes.json,research/imports/2017-draft-lad-outcomes.json --tx-dir <dir> --people <file> \
//     --affiliates <a.json,b.json> --pages <dir> --register <dir> --register-commit <sha> --retrieved 2026-10-20 \
//     --out-trades research/imports/lad-trades-2016-2017-classes.json --out-audits research/imports/lad-trade-returns-no-mlb.json
import fs from 'node:fs'
import path from 'node:path'
import pg from 'pg'
import { ownerDatabaseUrl } from '../../db/lib/connection.mjs'
import { decode, parseSeasonWar, completeThrough } from './lib/bref-player.mjs'

const argv = process.argv.slice(2)
const arg = (k) => { const i = argv.indexOf(`--${k}`); const v = i >= 0 ? argv[i + 1] : null; if (!v) throw new Error(`--${k} is required`); return v }
const org = arg('org').toUpperCase()
const retrieved = arg('retrieved')
const people = new Map(JSON.parse(fs.readFileSync(arg('people'), 'utf8')).people.map((p) => [p.id, p]))
const affiliates = {}
for (const f of arg('affiliates').split(',')) for (const [y, m] of Object.entries(JSON.parse(fs.readFileSync(f, 'utf8')))) affiliates[y] = { ...(affiliates[y] ?? {}), ...m }
const manifest = JSON.parse(fs.readFileSync(path.join(arg('pages'), 'manifest.json'), 'utf8'))
const register = new Map()
for (const f of fs.readdirSync(arg('register')).filter((f) => /^people-[0-9a-f]\.csv$/.test(f))) {
  for (const line of fs.readFileSync(path.join(arg('register'), f), 'utf8').split('\n').slice(1)) { const c = line.split(','); if (c[2] && c[4]) register.set(c[2], c[4]) }
}

const db = new pg.Client({ connectionString: ownerDatabaseUrl() })
await db.connect()
const orgRows = (await db.query('select mlb_team_id, franchise_key, current_name from public.organizations where mlb_team_id is not null')).rows
const teamToOrg = new Map(orgRows.map((r) => [r.mlb_team_id, r.franchise_key]))
const clubName = orgRows.find((r) => r.franchise_key === org).current_name
await db.end()
const orgOf = (teamId, season) => teamToOrg.get(teamId) ?? teamToOrg.get(affiliates[season]?.[teamId]) ?? teamToOrg.get(Object.values(affiliates).map((s) => s[teamId]).find(Boolean)) ?? null

const WIRE = `${org.toLowerCase()}:mlb-transactions-trades`
const PEOPLE = `${org.toLowerCase()}:mlb-people-trades`
const BREF = `${org.toLowerCase()}:bref-player-pages-pre${manifest.before.slice(0, 4)}`
const REG = 'chadwick:register'
const isoTs = (ts) => `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`

const trades = new Map()
for (const f of arg('outcomes').split(',')) {
  for (const r of JSON.parse(fs.readFileSync(f, 'utf8')).records) for (const t of r.transactions ?? []) if (t.from_organization === org) trades.set(`${t.date}|${t.to_organization}`, { date: t.date, counterparty: t.to_organization })
}
const ident = (p) => ({ full_name: p.fullName, ...(p.birthDate ? { birth_date: p.birthDate } : {}), external_ids: { MLBAM: String(p.id), ...(register.get(String(p.id)) ? { BBREF: register.get(String(p.id)) } : {}) }, source_key: PEOPLE })
const assetsIn = (text) => [
  ...(/\bcash\b/i.test(text) ? [{ asset_type: 'CASH', amount_usd: null, description: 'cash (amount undisclosed)' }] : []),
  ...(/future considerations/i.test(text) ? [{ asset_type: 'OTHER', description: 'future considerations' }] : []),
  ...(/player to be named/i.test(text) ? [{ asset_type: 'PLAYER_TO_BE_NAMED', description: 'player to be named later' }] : []),
  ...(/draft pick/i.test(text) ? [{ asset_type: 'DRAFT_PICK', description: 'draft pick (per the wire)' }] : [])
]
const warOf = (p) => {
  const bbref = register.get(String(p.id))
  const cap = bbref ? manifest.captures[bbref] : null
  if (!cap?.timestamp) return { war: [], note: p.mlbDebutDate ? 'MLB debut but no complete-season B-Ref capture: WAR not observed' : null }
  const page = parseSeasonWar(decode(fs.readFileSync(path.join(arg('pages'), `${bbref}.html`))))
  const through = completeThrough(cap.timestamp, page.maxSeason)
  if (through == null || page.career == null) return { war: [], note: 'capture holds a partial season: WAR not observed' }
  const observed = isoTs(cap.timestamp)
  return {
    war: [...page.seasons.map((s) => ({ system: 'BREF', scope: 'SEASON', season: s.season, organization: s.franchise, through_season: through, value: s.war, observed_on: observed, source_key: BREF, locator: `${cap.archived_url} (${s.season} ${s.team})` })),
      { system: 'BREF', scope: 'CAREER', through_season: through, value: page.career, observed_on: observed, source_key: BREF, locator: `${cap.archived_url} (summary WAR)` }],
    note: null
  }
}

const records = []
const audits = []
const notes = []
for (const { date, counterparty } of [...trades.values()].sort((a, b) => a.date.localeCompare(b.date))) {
  const season = Number(date.slice(0, 4))
  const tx = (JSON.parse(fs.readFileSync(path.join(arg('tx-dir'), `tx-${date}.json`), 'utf8')).transactions ?? []).filter((x) => x.typeCode === 'TR')
  const leg = (from, to) => [...new Map(tx.filter((x) => x.person && orgOf(x.fromTeam?.id, season) === from && orgOf(x.toTeam?.id, season) === to).map((x) => [x.person.id, x])).values()]
  const sent = leg(org, counterparty)
  const received = leg(counterparty, org)
  const desc = (sent[0] ?? received[0])?.description ?? ''
  const m = desc.match(/^(.*?) traded (.*?) to (.*?)(?: for (.*?))?\.?$/)
  // The wire's sentence: "<A> traded <what A sends> to <B> for <what B sends>".
  const orgFirst = m ? m[1].includes(clubName) : false
  const orgSends = m ? (orgFirst ? m[2] : (m[4] ?? '')) : ''
  const cpSends = m ? (orgFirst ? (m[4] ?? '') : m[2]) : ''
  const packages = [{ from: org, to: counterparty, players: sent.map((x) => ({ player: ident(people.get(x.person.id) ?? { id: x.person.id, fullName: x.person.fullName }) })), other_assets: assetsIn(orgSends) }]
  const back = received.map((x) => {
    const p = people.get(x.person.id) ?? { id: x.person.id, fullName: x.person.fullName }
    const w = warOf(p)
    if (w.note) notes.push(`${date} ${p.fullName}: ${w.note}`)
    if (!p.mlbDebutDate) audits.push({ type: 'OUTCOME_AUDIT', source_key: PEOPLE, organization: org, player: { full_name: p.fullName, external_ids: { MLBAM: String(p.id) }, source_key: PEOPLE },
      audit_state: 'AUDITED_NO_MLB', observation_through_season: Number(retrieved.slice(0, 4)), audited_on: retrieved,
      details: { as_of_date: retrieved, reached_affiliated: null, current_status: 'UNKNOWN', disposition: 'UNKNOWN', notes: `acquired by ${org} in the ${date} trade; no MLB debut on MLB's people record` } })
    return { player: ident(p), war: w.war }
  })
  const backAssets = assetsIn(cpSends)
  if (back.length || backAssets.length) packages.push({ from: counterparty, to: org, players: back, other_assets: backAssets })
  else notes.push(`${date} ${org} -> ${counterparty}: the wire states no return`)
  records.push({ type: 'TRADE', source_key: WIRE, organization: org, ref: `tr-${date}-${org.toLowerCase()}-${counterparty.toLowerCase()}`, date, date_precision: 'DAY', description: desc,
    locator: `transactions?teamId=…&startDate=${date}&endDate=${date}`, packages: packages.map((k) => ({ ...k, other_assets: k.other_assets.length ? k.other_assets : undefined })) })
}
const sources = [
  { source_key: WIRE, source_type: 'OFFICIAL_LEAGUE', authority_level: 'OFFICIAL', title: `MLB transaction wire, ${org} trade dates`, publisher: 'MLB Advanced Media',
    reference: 'statsapi.mlb.com/api/v1/transactions?teamId=<club>&startDate=<date>&endDate=<date>', retrieved_date: retrieved, notes: 'TR entries between the two clubs (affiliates mapped to parent clubs per season).' },
  { source_key: PEOPLE, source_type: 'OFFICIAL_LEAGUE', authority_level: 'OFFICIAL', title: 'MLB Stats API people for traded players', publisher: 'MLB Advanced Media',
    reference: 'statsapi.mlb.com/api/v1/people?personIds=…', retrieved_date: retrieved, notes: 'Names, birth dates, MLB debut dates as of retrieval.' },
  { source_key: BREF, source_type: 'REFERENCE_DATABASE', authority_level: 'AGGREGATOR', title: `Baseball-Reference player pages, Wayback captures before ${manifest.before}`, publisher: 'Sports Reference',
    reference: 'https://www.baseball-reference.com/players/<x>/<id>.shtml via web.archive.org (per-entry locator = capture URL)', retrieved_date: retrieved,
    notes: 'Value tables per season and team; captures before opening day.' },
  { source_key: REG, source_type: 'REFERENCE_DATABASE', authority_level: 'REPUTABLE_SECONDARY', title: 'Chadwick Baseball Bureau register (people)', publisher: 'Chadwick Baseball Bureau',
    url: 'https://github.com/chadwickbureau/register', retrieved_date: retrieved, notes: `MLBAM -> Baseball-Reference id crosswalk, commit ${arg('register-commit')}.` }
]
fs.writeFileSync(arg('out-trades'), JSON.stringify({ format: 'bai-research-import/1', batch_key: `${org.toLowerCase()}-trades-${path.basename(arg('out-trades'), '.json').replace(/^[a-z]+-trades-/, '')}`, channel: 'TRADES',
  description: `${org}: ${records.length} trades that sent audited class players away, both sides, with received players' Baseball-Reference season WAR where observed.`, sources, records }, null, 1) + '\n')
fs.writeFileSync(arg('out-audits'), JSON.stringify({ format: 'bai-research-import/1', batch_key: path.basename(arg('out-audits'), '.json'), channel: 'OUTCOMES',
  description: `${org}: outcome audits of ${audits.length} players received in those trades who have no MLB debut (as of ${retrieved}).`, sources: sources.filter((s) => s.source_key === PEOPLE), records: audits }, null, 1) + '\n')
console.log(`wrote ${records.length} trades and ${audits.length} no-MLB audits`)
for (const n of notes) console.log(`  ${n}`)
