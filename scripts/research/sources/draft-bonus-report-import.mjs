// Builds a DRAFT batch of signing bonuses from a report a researcher transcribed into research/evidence/<file>.json
// ({ source, import: [{ pick, bonus_usd, note }] }), against the club's draft import for identity. Works for any club.
// Only the entries listed under "import" become claims (e.g. a bonus no other source gives); the transcription keeps
// the rest as evidence. Each imported pick must be one of the club's official picks.
//   node scripts/research/sources/draft-bonus-report-import.mjs --draft-import research/imports/2019-draft-lad.json \
//     --report research/evidence/lad-2019-draft-bonus-reports.json --suffix dd --out research/imports/2019-draft-lad-dd.json
import fs from 'node:fs'

const argv = process.argv.slice(2)
const arg = (k) => { const i = argv.indexOf(`--${k}`); const v = i >= 0 ? argv[i + 1] : null; if (!v) throw new Error(`--${k} is required`); return v }
const draft = JSON.parse(fs.readFileSync(arg('draft-import'), 'utf8'))
const report = JSON.parse(fs.readFileSync(arg('report'), 'utf8'))
const official = new Map(draft.records.map((r) => [r.overall_pick, r]))
const S = report.source
const records = report.import.map((e) => {
  const r = official.get(e.pick)
  if (!r) throw new Error(`pick ${e.pick} is not one of the club's official picks`)
  if (!(typeof e.bonus_usd === 'number' && e.bonus_usd >= 0)) throw new Error(`pick ${e.pick}: bonus_usd must be a number`)
  return { type: r.type, source_key: r.source_key, draft_key: r.draft_key, round_code: r.round_code, overall_pick: r.overall_pick, round_pick: r.round_pick,
    organization: r.organization, selection_type: r.selection_type,
    player: { full_name: r.player.full_name, birth_date: r.player.birth_date, external_ids: { MLBAM: r.player.external_ids.MLBAM }, source_key: r.player.source_key },
    signing: { status: 'SIGNED', bonus_usd: e.bonus_usd, source_key: S.source_key, locator: `pick ${e.pick} in the table` }, notes: e.note ?? null }
})
const year = draft.records[0].draft_key.slice(0, 4)
const org = draft.records[0].organization
fs.writeFileSync(arg('out'), JSON.stringify({ format: 'bai-research-import/1', batch_key: `${year}-draft-${org.toLowerCase()}-${arg('suffix')}`, channel: 'DRAFT',
  description: `${org} ${year} Rule 4 draft: ${records.length} bonus(es) from "${S.title}" (${S.publisher}).`, sources: [S], records }, null, 1) + '\n')
console.log(`wrote ${arg('out')}: ${records.length} record(s)`)
