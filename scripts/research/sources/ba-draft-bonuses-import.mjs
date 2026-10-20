// Builds a DRAFT batch of signing bonuses for one club's class from Baseball America's "<year> Draft Selections" table
// (https://www.baseballamerica.com/stories/<year>-draft-selections/), downloaded by a researcher (an archive capture is
// fine; the live site refuses automated requests). Works for any club; nothing is fetched here.
//
// The table lists every pick with a Bonus column. A dollar figure is a claim and is imported; "—" means BA published
// no figure and is skipped (unknown, never zero, and never "did not sign": BA prints "—" for signed late-rounders too).
// Identity comes from the club's existing draft import (--draft-import). Checks, all fatal: every BA row for the club
// sits at an overall pick MLB's official data gives the club, the BA surname matches MLB's, and BA lists exactly the
// club's official picks.
//
//   node scripts/research/sources/ba-draft-bonuses-import.mjs --org LAD --club-label Dodgers --draft-import research/imports/2016-draft-lad.json \
//     --page ba.html --url <live> --archived-url <capture> --published 2018-02-14 --retrieved 2026-10-20 --out <file>
import fs from 'node:fs'

const argv = process.argv.slice(2)
const arg = (k, req = true) => { const i = argv.indexOf(`--${k}`); const v = i >= 0 ? argv[i + 1] : null; if (req && !v) throw new Error(`--${k} is required`); return v }
const org = arg('org').toUpperCase()
const label = arg('club-label')
const draft = JSON.parse(fs.readFileSync(arg('draft-import'), 'utf8'))
const year = draft.records[0].draft_key.slice(0, 4)
const decode = (s) => s.replace(/&#8212;/g, '—').replace(/&#8217;/g, '’').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
const text = decode(fs.readFileSync(arg('page'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ')
const official = new Map(draft.records.map((r) => [r.overall_pick, r]))
const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '')

const rows = new Map()
for (const m of text.matchAll(new RegExp(`\\b(\\d+(?:\\.5)?) (\\d+) ${label} (.{3,140}?) (\\$[\\d,]+|—)(?= \\d| Rnd | *$)`, 'g'))) {
  rows.set(Number(m[2]), { round: m[1], rest: m[3], bonus: m[4] === '—' ? null : Number(m[4].replace(/[$,]/g, '')) })
}
const got = [...rows.keys()].sort((a, b) => a - b)
const want = [...official.keys()].sort((a, b) => a - b)
if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`BA lists ${label} at picks ${got.join(',')} but MLB lists ${want.join(',')}; refusing`)
for (const [pick, row] of rows) {
  const surname = fold(official.get(pick).player.full_name.split(' ').at(-1))
  if (!fold(row.rest).includes(surname)) throw new Error(`pick ${pick}: BA row "${row.rest}" does not name ${official.get(pick).player.full_name}; refusing`)
}

const SRC = `${org.toLowerCase()}${year}:ba-draft-selections-${year}`
const records = [...rows].filter(([, r]) => r.bonus != null).sort((a, b) => a[0] - b[0]).map(([pick, row]) => {
  const r = official.get(pick)
  return { type: r.type, source_key: r.source_key, draft_key: r.draft_key, round_code: r.round_code, overall_pick: r.overall_pick, round_pick: r.round_pick,
    organization: r.organization, selection_type: r.selection_type,
    player: { full_name: r.player.full_name, birth_date: r.player.birth_date, external_ids: { MLBAM: r.player.external_ids.MLBAM }, source_key: r.player.source_key },
    signing: { status: 'SIGNED', bonus_usd: row.bonus, source_key: SRC, locator: `row ${row.round} / ${pick}` } }
})
const doc = {
  format: 'bai-research-import/1',
  batch_key: `${year}-draft-${org.toLowerCase()}-ba`,
  channel: 'DRAFT',
  description: `${org} ${year} Rule 4 draft: bonuses for ${records.length} picks from Baseball America's draft selections table (${rows.size - records.length} rows show no figure and are not imported).`,
  sources: [{ source_key: SRC, source_type: 'REFERENCE_DATABASE', authority_level: 'REPUTABLE_SECONDARY', title: `${year} Draft Selections`, publisher: 'Baseball America',
    url: arg('url'), archived_url: arg('archived-url', false), published_date: arg('published', false), retrieved_date: arg('retrieved'),
    notes: 'Pick-by-pick table with a Bonus column. "—" means no figure was published (not zero, not unsigned) and is skipped. Where a club used the $2,500 per-pick accounting deduction (LAD from 2016), the figures match the net amounts MLB.com and Baseball-Reference report.' }],
  records
}
fs.writeFileSync(arg('out'), JSON.stringify(doc, null, 1) + '\n')
console.log(`wrote ${arg('out')}: ${records.length} bonus(es); ${rows.size - records.length} row(s) without a figure`)
