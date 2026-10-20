// Builds an INTERNATIONAL batch of candidate amateur signings for one club and signing period from MLB Stats API files a
// researcher downloaded (transactions?teamId=<club>&startDate&endDate, people?personIds=..., per-player
// people/{id}/stats?stats=yearByYear&leagueListId=milb_all). Works for any club; fetches nothing.
//
// There is no official complete list of a club's international class, so this is discovery, never a census:
//   * a signing is the transaction wire's "signed free agent" / "signed" entry, dated to the day by MLB;
//   * a candidate amateur is: born outside the United States, Canada and Puerto Rico (the draft-eligible areas), never
//     drafted, 22 or younger on the signing date, and with no affiliated season before the signing year;
//   * every record carries a PATHWAY_BY_RULE flag (verify against a published class list), no market (where a player
//     was signed from is not on the wire), and unknown costs (the wire gives no bonus);
//   * the class is claimed PARTIAL_RECONSTRUCTION with an unknown expected size.
// Foreign-born signees outside the rule (older players, veterans, possible exempt professionals) are listed, not imported.
//
//   node scripts/research/sources/intl-signings-from-wire.mjs --org LAD --period 2016-17 --tx tx.json --people-dir <dir> \
//     --milb-dir <dir> --team-id 119 --retrieved 2026-10-20 --out research/imports/2016-17-international-lad.json
import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const arg = (k) => { const i = argv.indexOf(`--${k}`); const v = i >= 0 ? argv[i + 1] : null; if (!v) throw new Error(`--${k} is required`); return v }
const org = arg('org').toUpperCase()
const period = arg('period')
const teamId = Number(arg('team-id'))
const retrieved = arg('retrieved')
const DOMESTIC = new Set(['USA', 'Canada', 'Puerto Rico'])
const people = new Map()
for (const f of fs.readdirSync(arg('people-dir')).filter((f) => /^people-\d+\.json$/.test(f))) {
  for (const p of JSON.parse(fs.readFileSync(path.join(arg('people-dir'), f), 'utf8')).people) people.set(p.id, p)
}
const age = (b, d) => {
  const B = new Date(b + 'T00:00:00Z'); const T = new Date(d + 'T00:00:00Z')
  let a = T.getUTCFullYear() - B.getUTCFullYear()
  if (T.getUTCMonth() < B.getUTCMonth() || (T.getUTCMonth() === B.getUTCMonth() && T.getUTCDate() < B.getUTCDate())) a--
  return a
}
const txAll = JSON.parse(fs.readFileSync(arg('tx'), 'utf8')).transactions ?? []
const k = (s) => `${org.toLowerCase()}${period.replace(/[^0-9]/g, '')}:${s}`
const WIRE = k(`mlb-transactions-${period}`)
const PEOPLE = k(`mlb-people-${period}`)
const records = []
const listed = []
const seen = new Set()
for (const t of txAll.filter((x) => ['SFA', 'SGN'].includes(x.typeCode) && x.person?.id && x.toTeam?.id === teamId).sort((a, b) => (a.date + a.id).localeCompare(b.date + b.id))) {
  if (seen.has(t.person.id)) continue
  seen.add(t.person.id)
  const p = people.get(t.person.id)
  if (!p?.birthDate || DOMESTIC.has(p.birthCountry)) continue
  const a = age(p.birthDate, t.date)
  const milbFile = path.join(arg('milb-dir'), `${p.id}.json`)
  const prior = fs.existsSync(milbFile)
    ? (JSON.parse(fs.readFileSync(milbFile, 'utf8')).stats ?? []).flatMap((s) => s.splits).filter((x) => Number(x.season) < Number(t.date.slice(0, 4))).map((x) => `${x.season} ${x.team?.name ?? '?'}`)
    : null
  const why = []
  if (p.draftYear) why.push(`drafted ${p.draftYear}`)
  if (a > 22) why.push(`age ${a}`)
  if (prior === null) why.push('affiliated history not downloaded')
  else if (prior.length) why.push(`affiliated before signing (${[...new Set(prior)].slice(0, 2).join(', ')})`)
  if (why.length) { listed.push(`${t.date} ${p.fullName} (${p.birthCountry}): ${why.join('; ')}`); continue }
  const pos = (t.description.match(/signed (?:free agent )?([A-Z0-9]{1,3}) /) ?? [])[1] ?? null
  records.push({
    type: 'INTERNATIONAL_SIGNING', source_key: WIRE, organization: org, signing_date: t.date, signing_date_precision: 'DAY', period_key: period,
    pathway: 'INTERNATIONAL_AMATEUR', position: pos,
    player: { full_name: p.fullName, birth_date: p.birthDate, birth_country: p.birthCountry, external_ids: { MLBAM: String(p.id) }, source_key: PEOPLE },
    costs: {},
    flags: [{ code: 'PATHWAY_BY_RULE', severity: 'WARNING', notes: `Amateur by rule (born ${p.birthCountry}, age ${a} at signing, never drafted, no earlier affiliated season); verify against a published class list.` }],
    notes: `MLB transaction ${t.id}: ${t.description}`
  })
}
const doc = {
  format: 'bai-research-import/1',
  batch_key: `${period}-international-${org.toLowerCase()}`,
  channel: 'INTERNATIONAL',
  description: `${org} ${period} signing period: ${records.length} candidate international amateur signings discovered on the MLB transaction wire (bonuses unknown).`,
  coverage_claims: [{ domain: 'INTERNATIONAL', scope_key: period, organization: org, coverage_state: 'PARTIAL_RECONSTRUCTION',
    gap_notes: `Discovered from the MLB transaction wire by a documented rule; no complete published class list consulted yet; bonuses unknown; ${listed.length} foreign-born signees outside the rule not imported.` }],
  sources: [
    { source_key: WIRE, source_type: 'OFFICIAL_LEAGUE', authority_level: 'OFFICIAL', title: `MLB transaction wire, team ${teamId}, ${period} signing period`, publisher: 'MLB Advanced Media',
      reference: `statsapi.mlb.com/api/v1/transactions?teamId=${teamId}&startDate=…&endDate=… (period window)`, retrieved_date: retrieved,
      notes: `${txAll.length} transactions in the window; signing entries give the day but no bonus.` },
    { source_key: PEOPLE, source_type: 'OFFICIAL_LEAGUE', authority_level: 'OFFICIAL', title: `MLB Stats API people and milb_all seasons for ${period} signees`, publisher: 'MLB Advanced Media',
      reference: 'statsapi.mlb.com/api/v1/people?personIds=…; people/{id}/stats?stats=yearByYear&leagueListId=milb_all', retrieved_date: retrieved,
      notes: 'Birth date, birth country, draft year; affiliated seasons used only to exclude players with earlier professional history.' }
  ],
  records
}
fs.writeFileSync(arg('out'), JSON.stringify(doc, null, 1) + '\n')
console.log(`wrote ${arg('out')}: ${records.length} candidate amateur signings; ${listed.length} foreign-born signees outside the rule (not imported):`)
for (const l of listed) console.log(`  ${l}`)
