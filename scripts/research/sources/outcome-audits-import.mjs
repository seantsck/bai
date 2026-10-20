// Builds a bai-research-import/1 OUTCOMES batch for one organization's class from files already downloaded by
// fetch-mlb-player-outcomes.mjs (MLB Stats API, OFFICIAL) plus, optionally, a Baseball-Reference draft page for career
// bWAR. Works for any club and class. Rules (documented in docs/backfill-methodology.md#outcomes), nothing inferred:
//   audit state      debut on or before --as-of -> AUDITED_REACHED_MLB, else AUDITED_NO_MLB (through --through season)
//   reached affiliated  true when the API lists an affiliated (milb_all) or MLB season; otherwise null (not established)
//   games/PA/IP      MLB career totals (pitchers: pitching games; others: batting games); null without an MLB debut.
//                    IP is kept in baseball notation (748.2 = 748 2/3).
//   current status   from active flag and current team: the acquiring club, another MLB organization, INACTIVE when
//                    not active (RETIRED only with a retirement transaction), UNKNOWN when active outside affiliated ball
//   disposition      PER ACQUISITION (022: the record names its draft_key and overall_pick; a player drafted twice has two),
//                    with the exit date: UNSIGNED for picks that did not sign; else the first transaction, after this
//                    acquisition's own signing, that took the player out of the
//                    acquiring organization (trade, release, waiver claim, Rule 5, declared free agency, retirement);
//                    RETAINED when still with the club; UNKNOWN when the record shows no exit
//   trades           every trade between two MLB organizations in the player's record (shared when one trade moved several)
//   WAR              Baseball-Reference career WAR from the draft page (as of its capture), never FanGraphs unless observed
//                    (--bref-through: the last season the capture includes, e.g. 2025 for a January 2026 capture)
//   signed           the draft import's status, or an official SGN entry to the club in the draft year (a disagreement is noted;
//                    the signing itself is corrected through a DRAFT batch, never here)
//   Rule 5           MLB's wire codes some Rule 5 selections as waiver claims. --rule5 <json> takes researcher-verified Rule 5
//                    selections ([{ "mlbam", "date", "phase", "to", "source_key" }] plus "sources": [...]); a waiver claim on that
//                    date to that club becomes LOST_RULE_5, citing that source. Without the file, waiver claims stay LOST_WAIVERS.
//
//   --dispositions-only  restate the audits and give only the acquisition dispositions (batch <year>-draft-<org>-dispositions),
//                    for a class whose outcome batch was applied before 022.
//
//   node --env-file-if-exists=.env.local scripts/research/sources/outcome-audits-import.mjs --org LAD --draft-key 2016-JUNE_AMATEUR \
//     --dir <download dir> --draft-import research/imports/2016-draft-lad.json --bref page.html --bref-source lad2016:bref-lad-2016 \
//     --bref-captured 2026-08-03 --as-of 2026-10-20 --through 2026 --out research/imports/2016-draft-lad-outcomes.json
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import pg from 'pg'
import { ownerDatabaseUrl } from '../../db/lib/connection.mjs'

const argv = process.argv.slice(2)
const arg = (k, req = true) => { const i = argv.indexOf(`--${k}`); const v = i >= 0 ? argv[i + 1] : null; if (req && !v) throw new Error(`--${k} is required`); return v }
const org = arg('org').toUpperCase()
const dir = arg('dir')
const asOf = arg('as-of')
const through = Number(arg('through'))
const draft = JSON.parse(fs.readFileSync(arg('draft-import'), 'utf8'))
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
const affiliates = JSON.parse(fs.readFileSync(path.join(dir, 'affiliates.json'), 'utf8'))

const db = new pg.Client({ connectionString: ownerDatabaseUrl() })
await db.connect()
let teamToFranchise, acquiring
try {
  const orgs = (await db.query('select franchise_key, mlb_team_id from public.organizations')).rows
  teamToFranchise = new Map(orgs.map((o) => [o.mlb_team_id, o.franchise_key]))
  acquiring = orgs.find((o) => o.franchise_key === org)
  if (!acquiring) throw new Error(`unknown organization ${org}`)
} finally { await db.end() }
const franchiseOf = (teamId, season) => {
  if (teamToFranchise.has(teamId)) return teamToFranchise.get(teamId)
  const parent = affiliates[season]?.[teamId] ?? Object.values(affiliates).map((s) => s[teamId]).find(Boolean)
  return parent && teamToFranchise.has(parent) ? teamToFranchise.get(parent) : null
}

// Baseball-Reference career WAR per overall pick (optional).
const brefWar = new Map()
if (arg('bref', false)) {
  const raw = fs.readFileSync(arg('bref'))
  const html = raw[0] === 0x1f ? zlib.gunzipSync(raw).toString('utf8') : (raw.toString('utf8').includes('data-stat=') ? raw.toString('utf8') : zlib.brotliDecompressSync(raw).toString('utf8'))
  for (const [, row] of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const pick = (row.match(/data-stat="overall_pick"[^>]*>(?:<a [^>]*>)?(\d+)</) ?? [])[1]
    const war = (row.match(/data-stat="WAR"[^>]*>(-?\d+(?:\.\d+)?)</) ?? [])[1]
    if (pick && war != null) brefWar.set(Number(pick), Number(war))
  }
}

// Researcher-verified Rule 5 selections (optional).
const rule5 = arg('rule5', false) ? JSON.parse(fs.readFileSync(arg('rule5'), 'utf8')) : { selections: [], sources: [] }
const rule5By = new Map(rule5.selections.map((x) => [String(x.mlbam), x]))

const SRC = `${org.toLowerCase()}${draft.records[0].draft_key.slice(0, 4)}:mlb-statsapi-outcomes-${asOf}`
const dispositionsOnly = argv.includes('--dispositions-only')
const records = []
const summary = []
for (const d of draft.records) {
  const id = d.player.external_ids.MLBAM
  const j = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'))
  const p = j.people.people[0]
  const stats = p.stats ?? []
  const career = (g) => stats.find((s) => s.type.displayName === 'career' && s.group.displayName === g)?.splits?.[0]?.stat ?? null
  const mlbSeasons = stats.filter((s) => s.type.displayName === 'yearByYear').flatMap((s) => s.splits)
  const milbSeasons = (j.minors.stats ?? []).flatMap((s) => s.splits)
  const seasons = [...mlbSeasons, ...milbSeasons].map((x) => Number(x.season)).filter(Boolean)
  const reached = p.mlbDebutDate && p.mlbDebutDate <= asOf
  const tx = (j.transactions.transactions ?? []).slice().sort((a, b) => (a.date + a.id).localeCompare(b.date + b.id))
  const draftYear = d.draft_key.slice(0, 4)
  const wireSigned = tx.some((t) => t.typeCode === 'SGN' && t.date.startsWith(draftYear) && franchiseOf(t.toTeam?.id, Number(draftYear)) === org)
  const signed = d.signing.status === 'SIGNED' || wireSigned
  const signingNote = signed && d.signing.status !== 'SIGNED' ? `draft import says ${d.signing.status} but MLB's wire records an SGN entry to ${org} in ${draftYear}; audited as signed` : null

  // Debut organization: the MLB club of the debut season; if several, the club the player joined last before the debut.
  let debut = null
  if (reached) {
    const season = Number(p.mlbDebutDate.slice(0, 4))
    const clubs = [...new Set(mlbSeasons.filter((x) => Number(x.season) === season && x.team?.id).map((x) => franchiseOf(x.team.id, season)))].filter(Boolean)
    let club = clubs.length === 1 ? clubs[0] : null
    if (!club) {
      const join = tx.filter((t) => t.date <= p.mlbDebutDate && t.toTeam?.id).map((t) => franchiseOf(t.toTeam.id, Number(t.date.slice(0, 4)))).filter(Boolean)
      club = join.at(-1) ?? null
    }
    if (!club) throw new Error(`${p.fullName}: cannot establish the debut club; resolve by hand`)
    debut = { date: p.mlbDebutDate, organization: club, source_key: SRC, locator: `people/${id} mlbDebutDate; ${season} season splits` }
  }

  const trades = tx.filter((t) => t.typeCode === 'TR' && t.fromTeam?.id && t.toTeam?.id).map((t) => ({ t, from: franchiseOf(t.fromTeam.id, Number(t.date.slice(0, 4))), to: franchiseOf(t.toTeam.id, Number(t.date.slice(0, 4))) }))
    .filter((x) => x.from && x.to && x.from !== x.to)
    .map(({ t, from, to }) => ({ ref: `mlb-tx-${t.id}`, type: 'TRADE', date: t.date, from_organization: from, to_organization: to, description: t.description, source_key: SRC, locator: `transactions?playerId=${id} id ${t.id}` }))

  let disposition = 'UNKNOWN'
  let dispositionRef = null
  let dispositionDate = null
  let rule5Source = null
  if (!signed) disposition = 'UNSIGNED'
  else {
    // This acquisition's signing: the club's first SGN/SFA entry from the draft year on (an earlier one would be another acquisition).
    const signing = tx.find((t) => ['SGN', 'SFA'].includes(t.typeCode) && t.date >= `${draftYear}-01-01` && franchiseOf(t.toTeam?.id, Number(t.date.slice(0, 4))) === org)
    for (const t of tx.filter((x) => (x.date >= `${draftYear}-01-01`) && (!signing || (x.date + x.id) > (signing.date + signing.id)))) {
      dispositionDate = t.date
      const yr = Number(t.date.slice(0, 4))
      const fromOrg = franchiseOf(t.fromTeam?.id, yr)
      const toOrg = franchiseOf(t.toTeam?.id, yr)
      const teamOrg = franchiseOf(t.toTeam?.id ?? t.fromTeam?.id, yr)
      if (t.typeCode === 'TR' && fromOrg === org) { disposition = 'TRADED'; dispositionRef = `mlb-tx-${t.id}`; break }
      if (t.typeCode === 'REL' && teamOrg === org) { disposition = 'RELEASED'; break }
      const r5 = rule5By.get(id)
      if (t.typeCode === 'CLW' && toOrg && toOrg !== org && r5 && r5.date === t.date && r5.to === toOrg) { disposition = 'LOST_RULE_5'; rule5Source = r5.source_key; break }
      if (t.typeCode === 'CLW' && toOrg && toOrg !== org) { disposition = 'LOST_WAIVERS'; break }
      if (t.typeCode === 'R5' && toOrg && toOrg !== org) { disposition = 'LOST_RULE_5'; break }
      if (t.typeCode === 'DFA' && (teamOrg === org || teamOrg == null)) { disposition = 'LEFT_AS_FREE_AGENT'; break }
      if (t.typeCode === 'RET') { disposition = 'RETIRED'; break }
    }
  }
  const curOrg = p.currentTeam ? (teamToFranchise.get(p.currentTeam.id) ?? (p.currentTeam.parentOrgId ? teamToFranchise.get(p.currentTeam.parentOrgId) : null)) : null
  let status = 'UNKNOWN'
  if (!p.active) status = tx.some((t) => t.typeCode === 'RET') ? 'RETIRED' : 'INACTIVE'
  else if (curOrg === org) status = 'WITH_ACQUIRING_ORGANIZATION'
  else if (curOrg) status = 'WITH_OTHER_ORGANIZATION'
  if (['UNKNOWN', 'UNSIGNED'].includes(disposition)) dispositionDate = null
  if (signed && disposition === 'UNKNOWN' && status === 'WITH_ACQUIRING_ORGANIZATION') disposition = 'RETAINED'

  const isPitcher = p.primaryPosition?.abbreviation === 'P'
  const hit = career('hitting')
  const pit = career('pitching')
  const notes = []
  if (p.active && !curOrg) notes.push(`active outside affiliated baseball (current team per MLB: ${p.currentTeam?.name ?? 'none'})`)
  if (!seasons.length) notes.push('MLB Stats API lists no affiliated or MLB season; affiliated reach not established')
  if (signingNote) notes.push(signingNote)
  if (rule5Source) notes.push(`MLB's wire codes the exit as a waiver claim; it was a ${rule5By.get(id).phase} Rule 5 selection by ${rule5By.get(id).to} (${rule5Source})`)
  const war = brefWar.has(d.overall_pick) && reached
    ? [{ system: 'BREF', scope: 'CAREER', through_season: Number(arg('bref-through', false) ?? through), value: brefWar.get(d.overall_pick), observed_on: arg('bref-captured'), source_key: arg('bref-source'), locator: 'draft table WAR column (career, as of the capture)' }]
    : []
  const acquisition = { draft_key: d.draft_key, overall_pick: d.overall_pick }
  const exitTx = dispositionRef ? tx.find((t) => `mlb-tx-${t.id}` === dispositionRef) : null
  const acqDisposition = {
    value: disposition, ...(dispositionDate ? { date: dispositionDate, date_precision: 'DAY' } : {}), ...(dispositionRef ? { transaction_ref: dispositionRef } : {}),
    as_of_date: asOf, source_key: rule5Source ?? SRC,
    locator: exitTx || dispositionDate ? `transactions?playerId=${id} ${disposition} ${dispositionDate}` : `people/${id}; transactions?playerId=${id}`
  }
  if (dispositionsOnly) {
    // Restates the audit unchanged and gives the acquisition its own disposition (with the exit date), for a class whose
    // outcome batch predates per-acquisition dispositions (022).
    records.push({
      type: 'OUTCOME_AUDIT', source_key: SRC, organization: org,
      player: { full_name: d.player.full_name, external_ids: { MLBAM: id }, source_key: d.player.source_key },
      audit_state: reached ? 'AUDITED_REACHED_MLB' : 'AUDITED_NO_MLB', observation_through_season: through, audited_on: asOf,
      ...(debut ? { debut } : {}),
      transactions: trades.filter((t) => t.ref === dispositionRef), acquisition, disposition: acqDisposition,
      notes: `Pick ${d.overall_pick} (${d.draft_key}); acquisition disposition ${disposition}${dispositionDate ? ' on ' + dispositionDate : ''}.`
    })
    summary.push([d.overall_pick, d.player.full_name, disposition, dispositionDate ?? ''].join(' | '))
    continue
  }
  records.push({
    type: 'OUTCOME_AUDIT', source_key: SRC, organization: org,
    player: { full_name: d.player.full_name, external_ids: { MLBAM: id }, source_key: d.player.source_key },
    audit_state: reached ? 'AUDITED_REACHED_MLB' : 'AUDITED_NO_MLB', observation_through_season: through, audited_on: asOf,
    ...(debut ? { debut } : {}),
    transactions: trades,
    acquisition,
    disposition: acqDisposition,
    details: {
      as_of_date: asOf, reached_affiliated: seasons.length ? true : null, first_affiliated_season: seasons.length ? Math.min(...seasons) : null,
      mlb_games: reached ? Number((isPitcher ? pit : hit)?.gamesPlayed ?? (hit ?? pit)?.gamesPlayed ?? 0) : null,
      mlb_plate_appearances: reached && hit?.plateAppearances != null ? Number(hit.plateAppearances) : null,
      mlb_innings_pitched: reached && pit?.inningsPitched != null ? Number(pit.inningsPitched) : null,
      current_status: status, source_key: SRC,
      ...(notes.length ? { notes: notes.join('; ') } : {})
    },
    war,
    notes: `Pick ${d.overall_pick}; ${signed ? 'signed' : 'did not sign'} with ${org}. FanGraphs WAR not observed (site refuses automated requests; no archive).`
  })
  summary.push([d.overall_pick, d.player.full_name, reached ? `MLB ${p.mlbDebutDate} (${debut.organization})` : 'no MLB', disposition, status, war[0]?.value ?? ''].join(' | '))
}

const doc = {
  format: 'bai-research-import/1',
  batch_key: `${draft.records[0].draft_key.slice(0, 4)}-draft-${org.toLowerCase()}-${dispositionsOnly ? 'dispositions' : 'outcomes'}`,
  channel: 'OUTCOMES',
  description: dispositionsOnly
    ? `${org} ${draft.records[0].draft_key} class: per-acquisition dispositions (with exit dates) for ${records.length} selections as of ${asOf} (MLB Stats API transactions); audits restated unchanged.`
    : `${org} ${draft.records[0].draft_key} class: outcome audits for ${records.length} selections as of ${asOf} (MLB Stats API; Baseball-Reference career WAR).`,
  sources: [{ source_key: SRC, source_type: 'OFFICIAL_LEAGUE', authority_level: 'OFFICIAL', title: `MLB Stats API player outcomes (people, MLB and milb_all seasons, transactions), ${records.length} players`,
    publisher: 'MLB Advanced Media', reference: 'statsapi.mlb.com/api/v1: people/{id}?hydrate=currentTeam,stats(...); people/{id}/stats?stats=yearByYear&leagueListId=milb_all; transactions?playerId={id}; teams?sportIds=11..16&season=Y',
    retrieved_date: manifest.retrieved_date, notes: `${manifest.requests.length} requests, all HTTP 200 (manifest kept with the download). Current status and transactions as of the retrieval date.` },
  ...rule5.sources.filter((s) => rule5.selections.some((x) => x.source_key === s.source_key))],
  records
}
fs.writeFileSync(arg('out'), JSON.stringify(doc, null, 1) + '\n')
console.log(summary.join('\n'))
console.log(`wrote ${arg('out')}: ${records.length} audits`)
