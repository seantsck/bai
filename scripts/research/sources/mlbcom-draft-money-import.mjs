// Builds a DRAFT batch of slot values or signing bonuses for one club's class from MLB.com pages a researcher has
// downloaded (archive captures are fine). Works for any club; nothing is fetched here.
//   --kind slots    --values <"YYYY Draft bonus pools, pick values" page> [--tracker <signing tracker page>]
//   --kind bonuses  --tracker <"YYYY Draft: Signing and Bonus Tracker" page>
// Identity comes from the club's existing draft import (--draft-import): records re-state the pick as MLB lists it.
// Checks, all fatal: every value is tied to an overall pick that MLB's official data gives the club; positional lists
// (older articles without pick numbers) must place the club's entries exactly at its official picks; a stated club pool
// must equal the sum; tracker pick values, when given, must equal the article's. Tracker rows that say "Has not signed"
// are a timing snapshot, not a status claim, and are skipped.
//
//   node scripts/research/sources/mlbcom-draft-money-import.mjs --kind slots --org LAD --draft-import research/imports/2017-draft-lad.json \
//     --values values.html --tracker tracker.html --url <live> --archived-url <capture> --published 2017-05-24 --retrieved 2026-10-20 --out <file>
import fs from 'node:fs'

const argv = process.argv.slice(2)
const arg = (k, req = true) => { const i = argv.indexOf(`--${k}`); const v = i >= 0 ? argv[i + 1] : null; if (req && !v) throw new Error(`--${k} is required`); return v }
const kind = arg('kind')
const org = arg('org').toUpperCase()
const draft = JSON.parse(fs.readFileSync(arg('draft-import'), 'utf8'))
const year = draft.records[0].draft_key.slice(0, 4)
const label = arg('club-label', false) ?? draft.description.split(',')[0].split(' ').at(-1)   // "Los Angeles Dodgers" -> "Dodgers"
const text = (f) => fs.readFileSync(f, 'utf8').replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/\s+/g, ' ')
const money = (s) => Number(s.replace(/[$,]/g, ''))
const ROUNDS = ['First Round', 'Supplemental First Round', 'Competitive Balance Round A', 'Second Round', 'Competitive Balance Round B', 'Supplemental Second Round',
  'Third Round', 'Fourth Round', 'Fifth Round', 'Sixth Round', 'Seventh Round', 'Eighth Round', 'Ninth Round', 'Tenth Round']
const official = new Map(draft.records.map((r) => [r.overall_pick, r]))

/** Tracker rows: overall pick -> { bonus | null, pickValue } for the club (by its tracker abbreviation, e.g. "LAD"). */
function trackerRows (file) {
  const out = new Map()
  for (const m of text(file).matchAll(/(\d+)\. ([A-Z]{2,3}) - ([^,]+?) , [A-Z0-9]+, .+? (\$[\d,]+|Has not signed)[^(]{0,40}\(Pick value: (\$[\d,]+)\)/g)) {
    if (m[2] === org) out.set(Number(m[1]), { name: m[3].trim(), bonus: m[4].startsWith('$') ? money(m[4]) : null, pickValue: money(m[5]) })
  }
  return out
}

let values = new Map()
let source
if (kind === 'slots') {
  const t = text(arg('values'))
  const start = t.search(/First Round (1\. )?[A-Z][A-Za-z.' -]+: \$/)
  if (start < 0) throw new Error('pick value list not found')
  const list = t.slice(start)
  const numbered = /^First Round 1\. /.test(list)
  if (numbered) {
    for (const m of list.matchAll(/(\d+)\. ([A-Z][A-Za-z.' -]+?): \$([\d,]+)/g)) if (m[2].trim() === label) values.set(Number(m[1]), money(m[3]))
  } else {
    let overall = 0
    const re = new RegExp(`(${ROUNDS.join('|')})|([A-Z][A-Za-z.' -]+?): \\$([\\d,]+)`, 'g')
    let round = null
    for (const m of list.matchAll(re)) {
      if (m[1]) { round = m[1]; continue }
      if (!round) continue
      overall++
      if (m[2].trim() === label) values.set(overall, money(m[3]))
      if (round === 'Tenth Round' && overall > 400) break
    }
  }
  const expectedPicks = draft.records.filter((r) => /^\d+$/.test(r.round_code) ? Number(r.round_code) <= 10 : true).map((r) => r.overall_pick).sort((a, b) => a - b)
  const got = [...values.keys()].sort((a, b) => a - b)
  if (JSON.stringify(got) !== JSON.stringify(expectedPicks)) throw new Error(`${label} values sit at picks ${got.join(',')} but MLB lists rounds 1-10 picks ${expectedPicks.join(',')}; refusing`)
  const pool = (t.match(new RegExp(`${label}: \\$([\\d,]+)`)) ?? [])[1]
  const sum = [...values.values()].reduce((a, b) => a + b, 0)
  const stated = pool ? money(pool) : null
  console.log(stated == null ? `no club pool stated; values sum to ${sum}` : stated === sum ? `club pool $${stated.toLocaleString('en-US')} equals the sum of the values` : `WARNING: club pool $${stated.toLocaleString('en-US')} differs from the sum $${sum.toLocaleString('en-US')}; check the page`)
  if (arg('tracker', false)) for (const [pick, row] of trackerRows(arg('tracker'))) if (values.has(pick) && values.get(pick) !== row.pickValue) throw new Error(`pick ${pick}: article ${values.get(pick)} vs tracker ${row.pickValue}`)
  source = { source_key: `${org.toLowerCase()}${year}:mlb-pick-values-${year}`, title: `${year} Draft bonus pools, pick values`, sum, numbered }
} else if (kind === 'bonuses') {
  for (const [pick, row] of trackerRows(arg('tracker'))) {
    if (!official.has(pick)) throw new Error(`tracker pick ${pick} (${row.name}) is not one of ${org}'s picks`)
    if (row.bonus != null) values.set(pick, row.bonus)
  }
  source = { source_key: `${org.toLowerCase()}${year}:mlb-signing-tracker-${year}`, title: `${year} Draft: Signing and Bonus Tracker` }
} else throw new Error('--kind slots|bonuses')

const records = [...values].sort((a, b) => a[0] - b[0]).map(([pick, usd]) => {
  const r = official.get(pick)
  if (!r) throw new Error(`pick ${pick} is not one of ${org}'s picks`)
  const base = { type: r.type, source_key: r.source_key, draft_key: r.draft_key, round_code: r.round_code, overall_pick: r.overall_pick, round_pick: r.round_pick,
    organization: r.organization, selection_type: r.selection_type, player: { full_name: r.player.full_name, birth_date: r.player.birth_date, external_ids: { MLBAM: r.player.external_ids.MLBAM }, source_key: r.player.source_key } }
  return kind === 'slots'
    ? { ...base, signing: r.signing, slot_value: { usd, source_key: source.source_key, locator: source.numbered ? `pick ${pick} in the list` : `list position ${pick}` } }
    : { ...base, signing: { status: 'SIGNED', bonus_usd: usd, source_key: source.source_key } }
})
const doc = {
  format: 'bai-research-import/1',
  batch_key: `${year}-draft-${org.toLowerCase()}-${kind === 'slots' ? 'slots' : 'tracker'}`,
  channel: 'DRAFT',
  description: `${org} ${year} Rule 4 draft: ${kind === 'slots' ? `slot values for ${records.length} picks in rounds 1-10 (sum $${source.sum.toLocaleString('en-US')})` : `bonuses for ${records.length} picks from the signing tracker`} (MLB.com).`,
  sources: [{ source_key: source.source_key, source_type: 'OFFICIAL_LEAGUE', authority_level: 'OFFICIAL', title: source.title, publisher: 'MLB.com', url: arg('url'),
    archived_url: arg('archived-url', false), published_date: arg('published', false), retrieved_date: arg('retrieved'),
    notes: kind === 'slots' ? `Values tied to overall picks ${source.numbered ? 'by the numbers printed in the list' : 'by list position, which matches MLB official pick numbers'}.`
      : 'Read through an archive capture: a snapshot of the tracker at that date. Rows marked "Has not signed" are timing, not status, and were skipped.' }],
  records
}
fs.writeFileSync(arg('out'), JSON.stringify(doc, null, 1) + '\n')
console.log(`wrote ${arg('out')}: ${records.length} record(s)${kind === 'slots' ? `, sum $${source.sum.toLocaleString('en-US')}` : ''}`)
