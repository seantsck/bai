// Builds a DRAFT batch of signing statuses and dates for one club's class from the MLB transaction wire, downloaded by a
// researcher (statsapi.mlb.com/api/v1/transactions?teamId=<club>&startDate=<draft>&endDate=<deadline + a few weeks>).
// Works for any club; nothing is fetched here.
//
// A "signed" entry to the club for one of its official picks inside the window is an OFFICIAL claim: SIGNED, dated to the
// day. MLB codes most as SGN; some draft signings appear as SFA ("signed free agent ... to a minor league contract"); for
// an official pick of the club inside the signing window both mean the draft signing, and the code is kept in the locator.
// A pick with no SGN entry gets no record: the absence of a wire entry is not evidence that a player did not sign.
// The wire never gives a bonus, so records carry none (the bonus stays whatever other sources say, or unknown).
//
//   node scripts/research/sources/draft-signings-from-wire.mjs --org LAD --team-id 119 --draft-import research/imports/2017-draft-lad.json \
//     --tx wire.json --window 2017-06-12..2017-08-31 --retrieved 2026-10-20 --out research/imports/2017-draft-lad-wire.json [--only 520,610 --suffix dates]
import fs from 'node:fs'

const argv = process.argv.slice(2)
const arg = (k, req = true) => { const i = argv.indexOf(`--${k}`); const v = i >= 0 ? argv[i + 1] : null; if (req && !v) throw new Error(`--${k} is required`); return v }
// --only <picks>: a follow-up batch for a few picks, e.g. dates for picks whose status was corrected by a resolution
// after the first wire batch (a status conflict leaves the date unrecorded). Its batch key gets --suffix.
const only = arg('only', false) ? new Set(arg('only').split(',').map(Number)) : null
const org = arg('org').toUpperCase()
const teamId = Number(arg('team-id'))
const draft = JSON.parse(fs.readFileSync(arg('draft-import'), 'utf8'))
const year = draft.records[0].draft_key.slice(0, 4)
const [from, to] = arg('window').split('..')
const byId = new Map(draft.records.map((r) => [r.player.external_ids.MLBAM, r]))
const SRC = `${org.toLowerCase()}${year}:mlb-transactions-draft-${year}`

const first = new Map()
for (const t of (JSON.parse(fs.readFileSync(arg('tx'), 'utf8')).transactions ?? []).sort((a, b) => (a.date + a.id).localeCompare(b.date + b.id))) {
  if (!['SGN', 'SFA'].includes(t.typeCode) || t.toTeam?.id !== teamId || t.date < from || t.date > to) continue
  const r = byId.get(String(t.person?.id))
  if (r && (!only || only.has(r.overall_pick)) && !first.has(r.overall_pick)) first.set(r.overall_pick, { r, t })
}
const records = [...first.values()].sort((a, b) => a.r.overall_pick - b.r.overall_pick).map(({ r, t }) => ({
  type: r.type, source_key: r.source_key, draft_key: r.draft_key, round_code: r.round_code, overall_pick: r.overall_pick, round_pick: r.round_pick,
  organization: r.organization, selection_type: r.selection_type,
  player: { full_name: r.player.full_name, birth_date: r.player.birth_date, external_ids: { MLBAM: r.player.external_ids.MLBAM }, source_key: r.player.source_key },
  signing: { status: 'SIGNED', bonus_usd: null, date: t.date, date_precision: 'DAY', source_key: SRC, locator: `transaction ${t.id} (${t.typeCode})` },
  notes: `MLB transaction ${t.id} (${t.date}): ${t.description}`
}))
const doc = {
  format: 'bai-research-import/1',
  batch_key: `${year}-draft-${org.toLowerCase()}-wire${only ? `-${arg('suffix')}` : ''}`,
  channel: 'DRAFT',
  description: only ? `${org} ${year} Rule 4 draft: signing dates for picks ${[...only].join(', ')} from the MLB transaction wire (follow-up batch).`
    : `${org} ${year} Rule 4 draft: ${records.length} of ${draft.records.length} picks signed per the MLB transaction wire, dated to the day (no bonuses).`,
  sources: [{ source_key: SRC, source_type: 'OFFICIAL_LEAGUE', authority_level: 'OFFICIAL', title: `MLB transaction wire, team ${teamId}, ${from} to ${to}`, publisher: 'MLB Advanced Media',
    url: `https://statsapi.mlb.com/api/v1/transactions?teamId=${teamId}&startDate=${from}&endDate=${to}`, retrieved_date: arg('retrieved'),
    notes: 'SGN (or SFA) entries for the club\'s official picks inside the window. A pick without an entry is not claimed either way.' }],
  records
}
fs.writeFileSync(arg('out'), JSON.stringify(doc, null, 1) + '\n')
console.log(`wrote ${arg('out')}: ${records.length} signed pick(s) of ${draft.records.length}`)
