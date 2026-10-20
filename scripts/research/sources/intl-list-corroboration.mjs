// Builds an INTERNATIONAL batch from an independent list of a club's international signings (a club announcement, a
// published class list, a bonus report) that a researcher has transcribed into research/evidence/<file>.json, against the
// club's existing candidate batch for the period (e.g. one built by intl-signings-from-wire.mjs). Works for any club.
//
// The researcher matches each listed name to an MLBAM id by hand (names are spelled differently across sources, e.g.
// "George" / "Gorge" Heredia); nothing is matched by similarity here. For each identified entry that is a candidate:
//   * the listing corroborates the amateur pathway (a second, independent source for the signing);
//   * a listed bonus is imported as a claim of that source (a different figure already on record becomes a conflict).
// Entries without an id, or whose id is not a candidate, are reported, not imported: they are new questions (a player the
// wire missed, a signing in another period) for a researcher job, never a silently created player. The one exception is an
// entry the researcher classifies explicitly ("pathway", e.g. INTERNATIONAL_PROFESSIONAL for a pool-exempt veteran, with
// "classification_note"): with --tx (the club's transaction wire) and --people-dir (MLB people files) it becomes a signing
// dated by the wire's signing entry, flagged PATHWAY_CLASSIFIED_BY_RESEARCHER.
//
//   node scripts/research/sources/intl-list-corroboration.mjs --list research/evidence/lad-intl-2017-18-announcement.json \
//     --candidates research/imports/2017-18-international-lad.json --suffix announcement --out research/imports/2017-18-international-lad-announcement.json
import fs from 'node:fs'

const argv = process.argv.slice(2)
const arg = (k, req = true) => { const i = argv.indexOf(`--${k}`); const v = i >= 0 ? argv[i + 1] : null; if (req && !v) throw new Error(`--${k} is required`); return v }
const list = JSON.parse(fs.readFileSync(arg('list'), 'utf8'))
const cand = JSON.parse(fs.readFileSync(arg('candidates'), 'utf8'))
const byId = new Map(cand.records.map((r) => [r.player.external_ids.MLBAM, r]))
const S = list.source
const people = new Map()
if (arg('people-dir', false)) for (const f of fs.readdirSync(arg('people-dir')).filter((f) => /^people-\d+\.json$/.test(f))) for (const p of JSON.parse(fs.readFileSync(`${arg('people-dir')}/${f}`, 'utf8')).people) people.set(String(p.id), p)
const wire = arg('tx', false) ? (JSON.parse(fs.readFileSync(arg('tx'), 'utf8')).transactions ?? []) : []
const wireSource = cand.sources.find((x) => /transactions/.test(x.source_key))?.source_key
const peopleSource = cand.sources.find((x) => /people/.test(x.source_key))?.source_key

const records = []
const unmatched = []
for (const e of list.entries) {
  const c = e.mlbam ? byId.get(String(e.mlbam)) : null
  if (!c && e.mlbam && e.pathway) {
    const p = people.get(String(e.mlbam))
    const t = wire.filter((x) => ['SFA', 'SGN'].includes(x.typeCode) && String(x.person?.id) === String(e.mlbam)).sort((a, b) => a.date.localeCompare(b.date))[0]
    if (!p || !t) throw new Error(`${e.name}: classified entry needs --people-dir and --tx data for MLBAM ${e.mlbam}`)
    records.push({
      type: 'INTERNATIONAL_SIGNING', source_key: wireSource, organization: list.organization, signing_date: t.date, signing_date_precision: 'DAY', period_key: list.period_key,
      pathway: e.pathway, position: e.position,
      player: { full_name: p.fullName, birth_date: p.birthDate, birth_country: p.birthCountry, external_ids: { MLBAM: String(p.id) }, source_key: peopleSource },
      costs: e.bonus_usd != null ? { signing_bonus_usd: e.bonus_usd } : {}, ...(e.bonus_usd != null ? { cost_source_key: S.source_key } : {}),
      flags: [{ code: 'PATHWAY_CLASSIFIED_BY_RESEARCHER', severity: 'WARNING', notes: e.classification_note }],
      notes: `MLB transaction ${t.id}: ${t.description} Listed by ${S.publisher} (${S.published_date}).${e.bonus_note ? ` Bonus ${e.bonus_note}.` : ''}`
    })
    continue
  }
  if (!c) { unmatched.push(`${e.name} (${e.position}, ${e.country})${e.mlbam ? `: MLBAM ${e.mlbam} is not a ${list.period_key} candidate` : ': no MLBAM identity'}`); continue }
  if (c.organization !== list.organization || c.period_key !== list.period_key) throw new Error(`${e.name}: candidate is ${c.organization} ${c.period_key}, list is ${list.organization} ${list.period_key}`)
  records.push({
    type: 'INTERNATIONAL_SIGNING', source_key: S.source_key, organization: c.organization, period_key: c.period_key, pathway: c.pathway,
    player: { full_name: c.player.full_name, birth_date: c.player.birth_date, external_ids: { MLBAM: c.player.external_ids.MLBAM }, source_key: c.player.source_key },
    costs: e.bonus_usd != null ? { signing_bonus_usd: e.bonus_usd } : {},
    ...(e.bonus_usd != null ? { cost_source_key: S.source_key } : {}),
    notes: `Listed by ${S.publisher} (${S.published_date}) as "${e.name}", ${e.position}, ${e.country}${e.bonus_note ? `; bonus ${e.bonus_note}` : ''}.`
  })
}
const doc = {
  format: 'bai-research-import/1',
  batch_key: `${list.period_key}-international-${list.organization.toLowerCase()}-${arg('suffix')}`,
  channel: 'INTERNATIONAL',
  description: `${list.organization} ${list.period_key}: ${records.length} candidate signing(s) corroborated by "${S.title}" (${S.publisher}), ${records.filter((r) => r.costs.signing_bonus_usd != null).length} with a reported bonus; ${unmatched.length} listed name(s) not imported.`,
  sources: [S],
  records
}
fs.writeFileSync(arg('out'), JSON.stringify(doc, null, 1) + '\n')
console.log(`wrote ${arg('out')}: ${records.length} record(s); not imported: ${unmatched.length ? unmatched.join('; ') : 'none'}`)
