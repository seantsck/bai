// Deterministic backfill plan, 1965-2026: one row per draft year with its phases, the discovery requests it needs, the
// selections MLB's feed lists (when cached) or an era estimate (marked as such), and the order of execution. Reads only
// the committed manifest, the cache and (optionally) the local database's coverage.
//
// Permission gates: a cached feed is read only where its source grants process_local for that year; counts derived from
// a source are printed only where it grants publish_repository (otherwise "count kept locally"), because the table is
// published in docs/history/backfill-plan.md. The full plan, with every count, goes to .restricted/history/plan.json.
//
//   node --env-file-if-exists=.env.local scripts/history/plan.mjs [--no-db]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { ownerDatabaseUrl } from '../db/lib/connection.mjs'
import { PHASES, normalizePhase } from './lib/mlb.mjs'
import { loadCatalog, checkUse } from './lib/permissions.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'research/history/manifest.json'), 'utf8'))
const catalog = loadCatalog(root)
const OUT = path.resolve(root, process.env.BAI_HISTORY_OUT || '.restricted/history')

// Phase structure by era (MLB's phase list; discovery confirms each year and records phases with no selections).
const eraPhases = (y) => y === 1965 ? ['JR', 'AL'] : y <= 1986 ? ['NR', 'NS', 'JR', 'JS', 'JD', 'AL'] : ['JR']
// Era estimates for years not yet discovered (whole-league selections, all phases). Replaced by MLB's count on discovery.
const estimate = (y) => y <= 1986 ? 1250 : y <= 2011 ? 1500 : y <= 2019 ? 1215 : y === 2020 ? 160 : 615
// Execution order: the single-phase era where evidence is strongest first, newest to oldest, then the multi-phase era.
const wave = (y) => y >= 2015 ? 'H0 (calendar exists; LAD/Wave 2 research)' : y >= 2006 ? 'H1' : y >= 1987 ? 'H2' : y >= 1976 ? 'H3' : 'H4'
const order = (y) => y >= 2015 ? 0 : y >= 2006 ? 1 : y >= 1987 ? 2 : y >= 1976 ? 3 : 4

let coverage = new Map()
if (!process.argv.includes('--no-db')) {
  const db = new pg.Client({ connectionString: ownerDatabaseUrl() })
  await db.connect()
  try {
    for (const r of (await db.query('select draft_key, clubs, clubs_with_census, imported_selections from public.v_draft_year_coverage')).rows) coverage.set(r.draft_key, r)
  } finally { await db.end() }
}

const rows = []
for (let y = 1965; y <= 2026; y++) {
  const phases = eraPhases(y)
  let listed = 0
  let discovered = 0
  const found = []
  for (const code of phases) {
    const key = `mlb/draft/${y}-${code.toLowerCase()}.json`
    if (!manifest.entries[key] || !fs.existsSync(path.join(root, '.cache/history', key))) continue
    if (!checkUse(catalog, manifest.entries[key].source_key, 'process_local', { year: y }, { root }).ok) continue
    discovered++
    const n = normalizePhase(JSON.parse(fs.readFileSync(path.join(root, '.cache/history', key), 'utf8')), { year: y, code }).picks.length
    if (n) { listed += n; found.push(`${code} ${n}`) }
  }
  const imported = phases.reduce((a, c) => a + (coverage.get(`${y}-${PHASES[c].kind}`)?.imported_selections ?? 0), 0)
  const census = phases.map((c) => coverage.get(`${y}-${PHASES[c].kind}`)).filter(Boolean)
  const publishable = checkUse(catalog, 'mlb-statsapi-draft', 'publish_repository', { year: y }, { root }).ok
  rows.push({
    publishable,
    year: y, wave: wave(y), order: order(y), phases, discovery_requests: phases.length, discovered: discovered === phases.length,
    selections: discovered === phases.length ? listed : null, selections_estimate: discovered === phases.length ? null : estimate(y), phases_found: found,
    imported, clubs_with_census: census.reduce((a, c) => a + c.clubs_with_census, 0), club_phases: census.reduce((a, c) => a + c.clubs, 0)
  })
}
rows.sort((a, b) => a.order - b.order || b.year - a.year)
const totals = { years: rows.length, selections_known: rows.reduce((a, r) => a + (r.selections ?? 0), 0), selections_estimated: rows.reduce((a, r) => a + (r.selections_estimate ?? 0), 0),
  discovery_requests: rows.reduce((a, r) => a + (r.discovered ? 0 : r.discovery_requests), 0) }
fs.mkdirSync(OUT, { recursive: true })
fs.writeFileSync(path.join(OUT, 'plan.json'), JSON.stringify({ format: 'bai-history-plan/1', generated_from: 'manifest + cache + local coverage', totals, rows }, null, 1) + '\n')

console.log('| Order | Year | Wave | Phases to discover | MLB feed lists | Imported | Clubs with census |')
console.log('|---:|---:|---|---|---:|---:|---:|')
rows.forEach((r, i) => console.log(`| ${i + 1} | ${r.year} | ${r.wave} | ${r.phases.join(', ')}${r.discovered ? ' (done)' : ''} | ${r.selections == null ? `≈ ${r.selections_estimate} (estimate)` : r.publishable ? `${r.selections} (${r.phases_found.join(', ')})` : 'discovered; count kept locally'} | ${r.publishable ? (r.imported || '—') : (r.imported ? 'held locally' : '—')} | ${r.club_phases ? (r.publishable ? `${r.clubs_with_census} / ${r.club_phases}` : 'held locally') : '—'} |`))
const est = rows.reduce((a, r) => a + (r.selections_estimate ?? estimate(r.year)), 0)
console.log(`\nTotals: ≈ ${est} selections by era estimate (feed counts for discovered years are kept locally); ${totals.discovery_requests} MLB discovery requests left, each refused until fetch_bulk is authorized.`)
