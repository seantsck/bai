// Historical exception register: every unresolved disagreement the importer found, with what each source claims, its
// effect on the import and what would resolve it. Built from the build reports (and the census disagreements recorded on
// calendar sources) in the restricted output directory; written there too (.restricted/history/exceptions.json), because
// it quotes source-derived names. Nothing here is ever resolved automatically: an entry stays UNRESOLVED until a person
// records a decision through the research pipeline (a resolution batch or research:resolve), citing evidence.
//
//   node scripts/history/exceptions.mjs [--years 1965,1985,2005]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadCatalog, requireUse } from './lib/permissions.mjs'
import { BREF_TEAM_CODES } from './lib/evidence.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const OUT = path.resolve(root, process.env.BAI_HISTORY_OUT || '.restricted/history')
const catalog = loadCatalog(root)
const i = process.argv.indexOf('--years')
const years = (i > 0 ? process.argv[i + 1].split(',') : fs.readdirSync(path.join(OUT, 'reports')).map((f) => f.match(/^(\d{4})-build\.json$/)?.[1]).filter(Boolean)).map(Number).sort()

// Census disagreements found while sourcing the calendar (a stated total that differs from the feed's count).
const MANUAL = [
  { id: 'EX-1965-CENSUS-TOTAL', year: 1965, phase: 'JR', club: null, kind: 'CENSUS_TOTAL_DISAGREES',
    claims: [{ source: 'wikipedia-draft-articles', says: '"A total of 813 players were selected" (revision 1358425090)' }, { source: 'mlb-statsapi-draft', says: '824 picks of 821 distinct people (June regular phase)' }],
    effect: 'No expected count is claimed for 1965; recorded on the calendar source.', resolution_needs: 'A third, primary account of the 1965 draft (e.g. contemporary newspaper or Official Baseball Guide listing).' }
]

const register = []
for (const year of years) {
  requireUse(catalog, 'mlb-statsapi-draft', 'process_local', { year }, { root })
  requireUse(catalog, 'bref-draft-archive', 'process_local', { year }, { root })
  const report = JSON.parse(fs.readFileSync(path.join(OUT, 'reports', `${year}-build.json`), 'utf8'))
  for (const p of report.phases.filter((x) => x.selections)) {
    for (const f of p.findings ?? []) {
      if (f.kind === 'SAME_PERSON_TWICE') {
        register.push({ id: `EX-${year}-${p.code}-SAME-PERSON-${f.pick}`, year, phase: p.code, club: null, kind: 'SAME_PERSON_TWICE',
          claims: [{ source: 'mlb-statsapi-draft', says: f.detail }],
          effect: `Pick #${f.pick} held out of its batch (listed in that club's coverage gap notes); the class is a partial reconstruction.`,
          resolution_needs: 'Decide whether this is one person picked twice (a feed error) or two people merged under one id; a second list of that phase naming both picks, or biographical records.' })
      } else if (f.kind !== 'NOT_A_SELECTION') {
        register.push({ id: `EX-${year}-${p.code}-${f.kind}`, year, phase: p.code, club: null, kind: f.kind, claims: [{ source: 'mlb-statsapi-draft', says: f.detail ?? JSON.stringify(f) }],
          effect: 'Recorded in the build report.', resolution_needs: 'Review against an independent list of the phase.' })
      }
    }
    for (const d of p.evidence?.disagree ?? []) {
      register.push({ id: `EX-${year}-${p.code}-${d.club}-LIST`, year, phase: p.code, club: d.club, kind: d.mlb === d.bref ? 'LISTS_DIFFER_SAME_COUNT' : 'LISTS_DIFFER_COUNT',
        claims: [{ source: 'mlb-statsapi-draft', says: `${d.mlb} selections; not on the other list: ${d.not_on_bref.join('; ') || 'none'}` }, { source: 'bref-draft-archive', says: `${d.bref} selections; not matched to the feed: ${d.unmatched.join('; ') || 'none'}` }],
        effect: 'The club-phase is a partial reconstruction (no census claimed); the feed\'s picks were imported, the other list\'s extra names were not.',
        resolution_needs: 'A third source for the disputed picks (club media guide, contemporary transaction report, Baseball America) or confirmation that the names are one person.' })
    }
    if (p.evidence?.name_variants?.length) {
      register.push({ id: `EX-${year}-${p.code}-NAMES`, year, phase: p.code, club: null, kind: 'NAME_VARIANTS', count: p.evidence.name_variants.length,
        claims: [{ source: 'mlb-statsapi-draft / bref-draft-archive', says: p.evidence.name_variants }],
        effect: 'Matched by surname in the same round or at the same pick for the census check only; the feed\'s name was imported. Different first names may be different people.',
        resolution_needs: 'Per pair: nickname or legal name (no action), or a different person (the census claim for that club must be withdrawn).' })
    }
    if (p.evidence?.numbering_differences) {
      register.push({ id: `EX-${year}-${p.code}-NUMBERING`, year, phase: p.code, club: null, kind: 'PICK_NUMBERING_DIFFERS', count: p.evidence.numbering_differences,
        claims: [{ source: 'mlb-statsapi-draft / bref-draft-archive', says: `${p.evidence.numbering_differences} matched picks carry different overall numbers` }],
        effect: 'Identity never relies on overall pick numbers; the feed\'s numbering was imported.', resolution_needs: 'The draft order of that year from a primary account, if pick order matters for analysis.' })
    }
    if (p.crosswalk && p.crosswalk.matched < p.selections) {
      register.push({ id: `EX-${year}-${p.code}-CROSSWALK`, year, phase: p.code, club: null, kind: 'CROSSWALK_UNMATCHED', count: p.selections - p.crosswalk.matched,
        claims: [{ source: 'chadwick-register', says: `${p.crosswalk.matched} of ${p.selections} MLBAM ids found in the register` }],
        effect: 'Only MLBAM identity recorded for the rest; no other system\'s id was guessed.', resolution_needs: 'Usually none (picks who never played professionally have no other ids); a later register commit may add some.' })
    }
  }
}
for (const m of MANUAL) if (years.includes(m.year)) register.push(m)
// Review kind (research.history_exception_kind, 025) and evidence locators (cached files with their checksums, so a
// reviewer can re-read exactly what each source said).
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'research/history/manifest.json'), 'utf8')).entries
const surname = (s) => String(s).replace(/^\d+\s+|^#\d+\s+/, '').trim().split(/\s+/).at(-1).toLowerCase().normalize('NFD').replace(/[^a-z]/g, '')
const editDistance = (a, b) => { const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]); for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length][b.length] }
function reviewKind (e) {
  switch (e.kind) {
    case 'SAME_PERSON_TWICE': return 'SAME_PERSON_MULTIPLE_SELECTIONS'
    case 'LISTS_DIFFER_COUNT': return 'MISSING_SELECTION'
    case 'LISTS_DIFFER_SAME_COUNT': {
      // Same count, one unmatched name each side: a spelling if the surnames are within two edits, otherwise a different player.
      const a = (e.claims[0].says.match(/not on the other list: (.*)$/) ?? [])[1] ?? ''
      const b = (e.claims[1]?.says.match(/not matched to the feed: (.*)$/) ?? [])[1] ?? ''
      return editDistance(surname(a), surname(b)) <= 2 ? 'ALTERNATE_NAME' : 'DIFFERENT_PLAYER_SAME_PICK'
    }
    case 'NAME_VARIANTS': return 'ALTERNATE_NAME'
    case 'PICK_NUMBERING_DIFFERS': return 'NUMBERING_DISAGREEMENT'
    case 'CROSSWALK_UNMATCHED': return 'CROSSWALK_UNMATCHED'
    case 'CENSUS_TOTAL_DISAGREES': return 'CENSUS_TOTAL_DISAGREEMENT'
    default: return 'CONFLICTING_IDENTITY'
  }
}
const teamCodes = (fk) => Object.entries(BREF_TEAM_CODES).filter(([, v]) => v === fk).map(([k]) => k.toLowerCase())
function evidenceFor (e) {
  const out = []
  const add = (prefix, source) => { for (const [k, v] of Object.entries(manifest)) if (k.startsWith(prefix)) out.push({ source, cache_key: k, sha256: v.sha256, url: v.url }) }
  if (e.phase) add(`mlb/draft/${e.year}-${e.phase.toLowerCase()}.json`, 'mlb-statsapi-draft')
  if (/LIST|NAMES|NUMBERING/.test(e.id)) for (const t of e.club ? teamCodes(e.club) : ['']) add(`archive/bref/${e.year}/${(e.phase ?? '').toLowerCase()}-${t}`, 'bref-draft-archive')
  if (/CROSSWALK/.test(e.id)) add('chadwick/', 'chadwick-register')
  return out
}
const entries = register.map((e) => ({ ...e, review_kind: reviewKind(e), evidence: evidenceFor(e), status: 'UNRESOLVED', decided_by: null, decided_on: null, decision: null }))
fs.writeFileSync(path.join(OUT, 'exceptions.json'), JSON.stringify({ format: 'bai-history-exceptions/1', note: 'Restricted: quotes source-derived names. Never resolved automatically.', years, entries }, null, 1) + '\n')
const byKind = entries.reduce((a, e) => ({ ...a, [e.kind]: (a[e.kind] ?? 0) + 1 }), {})
console.log(`${entries.length} unresolved exception(s) for ${years.join(', ')}:`, byKind)
for (const e of entries) console.log(`  ${e.id}  ${e.review_kind}${e.count ? ` (${e.count})` : ''}, ${e.evidence.length} evidence file(s)`)
