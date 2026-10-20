// Builds a bai-research-import/1 DRAFT batch for one organization's Rule 4 class from two files a researcher has
// already downloaded (this script never fetches anything, so retrieval stays deliberate and rate-limited):
//   --mlb   MLB Stats API draft JSON   (https://statsapi.mlb.com/api/v1/draft/<year>?teamId=<mlb team id>)  OFFICIAL
//   --bref  Baseball-Reference draft page for the club and year (live or an archive capture; gzip/brotli accepted)  AGGREGATOR
// Works for any of the 30 organizations: the club comes from --org and is checked against the MLB team id in the JSON.
//
// What each source supplies (and nothing is inferred):
//   MLB:   the class universe (pick list), round code, overall and round pick, MLBAM id, name, birth date and country.
//   B-Ref: signing status (Signed Y/N), bonus (blank = unknown, never zero), draft-listed position, school and type,
//          Baseball-Reference ids. Where B-Ref numbers a pick differently, its claim is kept as evidence (a conflict).
//   Slot values: not in either source; left for SLOT_VALUE_MISSING jobs.
//
//   node --env-file-if-exists=.env.local scripts/research/sources/draft-class-import.mjs --org LAD --year 2016 \
//     --mlb draft.json --bref page.html --bref-url <live url> --archived-url <capture url> --retrieved 2026-10-19 --out research/imports/2016-draft-lad.json
import fs from 'node:fs'
import zlib from 'node:zlib'
import pg from 'pg'
import { ownerDatabaseUrl } from '../../db/lib/connection.mjs'

const argv = process.argv.slice(2)
const arg = (k, required = true) => { const i = argv.indexOf(`--${k}`); const v = i >= 0 ? argv[i + 1] : null; if (required && !v) throw new Error(`--${k} is required`); return v }
const org = arg('org').toUpperCase()
const year = Number(arg('year'))
const retrieved = arg('retrieved')
if (!/^\d{4}-\d{2}-\d{2}$/.test(retrieved)) throw new Error('--retrieved must be YYYY-MM-DD (the day the files were downloaded)')

function readHtml (file) {
  const raw = fs.readFileSync(file)
  if (raw[0] === 0x1f && raw[1] === 0x8b) return zlib.gunzipSync(raw).toString('utf8')
  const text = raw.toString('utf8')
  if (text.includes('data-stat=')) return text
  return zlib.brotliDecompressSync(raw).toString('utf8')
}

/** Rows of the B-Ref draft table keyed by overall pick. */
function parseBref (html) {
  const clean = (s) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').trim()
  const out = new Map()
  for (const [, row] of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const c = {}
    for (const [, k, v] of row.matchAll(/<t[hd][^>]*data-stat="([^"]+)"[^>]*>([\s\S]*?)<\/t[hd]>/g)) c[k] = { html: v, text: clean(v) }
    if (!c.overall_pick || !/^\d+$/.test(c.overall_pick.text)) continue
    const minors = (c.player.html.match(/register\/player\.fcgi\?id=([a-z0-9-]+)/) ?? [])[1]
    const majors = (c.player.html.match(/\/players\/[a-z]\/([a-z0-9]+)\.shtml/) ?? [])[1]
    const from = c.came_from.text.match(/^(.*?)\s*\(([^,]+),\s*([^)]+)\)$/)
    out.set(Number(c.overall_pick.text), {
      round: c.draft_round.text, roundPick: Number(c.round_pick.text), signed: c.signed.text, bonus: c.bonus.text,
      name: c.player.text.replace(/\s*\(.*\)$/, ''), pos: c.pos.text, fromType: c.from_type.text,
      school: from ? { name: from[1], city: from[2], region: from[3] } : (c.came_from.text ? { name: c.came_from.text } : null),
      // Only well-formed ids: majors like "luxga01", minors like "sheffi000jor"; anything else is dropped, not guessed.
      bbref: majors && /^[a-z]+\d{2}$/.test(majors) ? majors : null,
      bbrefMinors: minors && /^[a-z-]+\d{3}[a-z-]{3}$/.test(minors) ? minors : null
    })
  }
  return out
}

const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z]/g, '')
const SCHOOL_TYPE = { HS: 'HIGH_SCHOOL', '4Yr': 'COLLEGE', JC: 'JUNIOR_COLLEGE' }
const money = (s) => s ? Number(s.replace(/[$,]/g, '')) : null

const db = new pg.Client({ connectionString: ownerDatabaseUrl() })
await db.connect()
let organization
try {
  organization = (await db.query('select franchise_key, current_name, mlb_team_id from public.organizations where franchise_key = $1', [org])).rows[0]
  if (!organization) throw new Error(`unknown organization ${org}`)
  if (!(await db.query("select 1 from public.drafts where draft_key = $1", [`${year}-JUNE_AMATEUR`])).rowCount) throw new Error(`no ${year} draft on the calendar`)
} finally { await db.end() }

const mlb = JSON.parse(fs.readFileSync(arg('mlb'), 'utf8'))
const picks = mlb.drafts.rounds.flatMap((r) => r.picks).filter((p) => p.team?.id === organization.mlb_team_id && String(p.year) === String(year))
const otherTeams = mlb.drafts.rounds.flatMap((r) => r.picks).filter((p) => p.team?.id !== organization.mlb_team_id)
if (!picks.length || otherTeams.length) throw new Error(`the MLB file is not ${org}'s ${year} class (team ${organization.mlb_team_id}); refusing`)
const bref = parseBref(readHtml(arg('bref')))
if (bref.size !== picks.length) throw new Error(`MLB lists ${picks.length} picks, Baseball-Reference ${bref.size}; reconcile the universe before importing`)

const k = (s) => `${org.toLowerCase()}${year}:${s}`
const MLB = k(`mlb-statsapi-draft-${year}-${org.toLowerCase()}`)
const BREF = k(`bref-${org.toLowerCase()}-${year}`)
const records = []
const disagreements = []
let samePersonCount = 0
for (const p of picks.sort((a, b) => a.pickNumber - b.pickNumber)) {
  const b = bref.get(p.pickNumber)
  // --same-person 971,1001: a researcher confirmed by hand that the two spellings at these overall picks are one player
  // (e.g. "Danny" / "Dan"); the pick number already ties them. The B-Ref spelling is kept in the record's notes.
  const samePerson = new Set((arg('same-person', false) ?? '').split(',').filter(Boolean).map(Number))
  if (!b || (fold(b.name) !== fold(p.person.fullName) && !samePerson.has(p.pickNumber))) throw new Error(`pick ${p.pickNumber}: MLB ${p.person.fullName} vs B-Ref ${b?.name ?? 'missing'}; resolve identity by hand (--same-person ${p.pickNumber} once confirmed)`)
  if (fold(b.name) !== fold(p.person.fullName)) samePersonCount++
  const aka = fold(b.name) !== fold(p.person.fullName) ? `Baseball-Reference lists the pick as "${b.name}" (same overall pick; matched by hand). ` : ''
  // MLB labels compensation rounds "1C", "2C" (after round n); BAI's code is "C-n". CB-A / CB-B and plain rounds pass through.
  const code = /^(\d+)C$/.test(String(p.pickRound)) ? `C-${String(p.pickRound).slice(0, -1)}` : String(p.pickRound)
  const evidence = []
  if (b.round !== code) evidence.push({ subject: 'selection', field: 'round_code', value: b.round, source_key: BREF, locator: 'draft table round column' })
  if (b.roundPick !== p.roundPickNumber) evidence.push({ subject: 'selection', field: 'round_pick', value: b.roundPick, source_key: BREF, locator: 'draft table pick-in-round column' })
  if (evidence.length) disagreements.push(`#${p.pickNumber} ${p.person.fullName}: MLB ${code}/${p.roundPickNumber}, B-Ref ${b.round}/${b.roundPick}`)
  const status = b.signed === 'Y' ? 'SIGNED' : b.signed === 'N' ? 'DID_NOT_SIGN' : 'UNKNOWN'
  const ids = { MLBAM: String(p.person.id) }
  if (b.bbref) ids.BBREF = b.bbref
  if (b.bbrefMinors) ids.BBREF_MINORS = b.bbrefMinors
  const rec = {
    type: 'DRAFT_SELECTION', source_key: MLB, draft_key: `${year}-JUNE_AMATEUR`, round_code: code, overall_pick: p.pickNumber, round_pick: p.roundPickNumber,
    organization: org, selection_type: /^CB-/.test(code) ? 'COMPETITIVE_BALANCE' : /^C-/.test(code) ? 'COMPENSATION' : 'STANDARD',
    position: b.pos || null, field_sources: { position: BREF, school: BREF },
    player: { full_name: p.person.fullName, birth_date: p.person.birthDate ?? null, birth_country: p.person.birthCountry ?? null, external_ids: ids, source_key: MLB },
    signing: status === 'UNKNOWN' ? { status } : { status, ...(status === 'SIGNED' ? { bonus_usd: money(b.bonus) } : {}), source_key: BREF },
    notes: `${aka}MLB school label: ${p.school?.name ?? 'none'}.${status === 'SIGNED' && money(b.bonus) == null ? ' Signed with no published bonus: unknown, not zero.' : ''}`
  }
  if (b.school) rec.school = { name: b.school.name, school_type: SCHOOL_TYPE[b.fromType] ?? 'OTHER', city: b.school.city ?? null, region: b.school.region ?? null, country: b.school.region === 'Puerto Rico' ? 'Puerto Rico' : 'USA', source_key: BREF }
  if (evidence.length) rec.evidence = evidence
  records.push(rec)
}

const signed = records.filter((r) => r.signing.status === 'SIGNED')
const doc = {
  format: 'bai-research-import/1',
  batch_key: `${year}-draft-${org.toLowerCase()}`,
  channel: 'DRAFT',
  description: `${organization.current_name}, ${year} Rule 4 draft: ${records.length} selections (MLB Stats API universe; Baseball-Reference signing status, bonus, school).`,
  coverage_claims: [{
    domain: 'DRAFT', scope_key: `${year}-JUNE_AMATEUR`, organization: org, coverage_state: 'COMPLETE_CENSUS', expected_count: records.length, source_key: MLB,
    gap_notes: `Population: the ${records.length} selections MLB's official draft data lists for the club; Baseball-Reference lists the same ${bref.size} by overall pick and name${samePersonCount ? ` (${samePersonCount} spelling difference(s) matched by hand at the same pick)` : ""}. ` +
      `Census of selections only: bonuses published for ${signed.filter((r) => r.signing.bonus_usd != null).length} of ${signed.length} signed picks, no slot values, no outcomes audited.`
  }],
  sources: [
    { source_key: MLB, source_type: 'OFFICIAL_LEAGUE', authority_level: 'OFFICIAL', title: `MLB Stats API draft endpoint, ${year}, teamId=${organization.mlb_team_id}`, publisher: 'MLB Advanced Media',
      url: `https://statsapi.mlb.com/api/v1/draft/${year}?teamId=${organization.mlb_team_id}`, retrieved_date: retrieved,
      notes: `JSON; ${picks.length} picks: pickRound, pickNumber, roundPickNumber, person (MLBAM id, name, birth date, country), school label. No signing status, bonus or slot value.` },
    { source_key: BREF, source_type: 'REFERENCE_DATABASE', authority_level: 'AGGREGATOR', title: `Baseball-Reference: ${year} June amateur draft, ${organization.current_name}`,
      publisher: 'Baseball-Reference (Sports Reference)', url: arg('bref-url'), archived_url: arg('archived-url', false), retrieved_date: retrieved,
      notes: `Columns used: Rnd, OvPck, RdPck, Signed, Bonus, Name (ids), Pos, Type, Drafted Out of.${arg('archived-url', false) ? ' Read through the archive capture (the live site refuses automated requests).' : ''}` }
  ],
  records
}
fs.writeFileSync(arg('out'), JSON.stringify(doc, null, 1) + '\n')
console.log(`wrote ${arg('out')}: ${records.length} records, ${signed.length} signed (${signed.filter((r) => r.signing.bonus_usd != null).length} with a bonus), ${records.filter((r) => r.signing.status === 'DID_NOT_SIGN').length} did not sign`)
for (const d of disagreements) console.log(`  numbering disagreement kept as evidence: ${d}`)
