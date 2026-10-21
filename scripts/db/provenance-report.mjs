// Read-only provenance report: which sources contributed to the records in a BAI database, by publisher/host, with how
// many rows each is the primary citation for (every table with a source_id column), how many field observations it
// made, and whether those rows are visible to the public site (anon SELECT). Used for the licensing review
// (docs/history/hosted-provenance.md). Runs in a READ ONLY transaction; changes nothing.
//
//   npm run db:provenance            local
//   npm run hosted:provenance        hosted (no --confirm-hosted needed: read-only)
//   [-- --json]
import pg from 'pg'
import { ownerDatabaseUrl } from './lib/connection.mjs'

// Licensing category per host or publisher (the review question each raises). Order matters: first match wins.
const CATEGORIES = [
  { re: /\bBAI_REFERENCE\b|TEST_FIXTURE/, cat: 'BAI_REFERENCE', question: 'BAI-maintained reference data citing public facts (franchise identities, calendars): none beyond keeping the citations.' },
  { re: /statsapi\.mlb\.com|gdx\.mlb\.com|MLB Stats API|transaction wire/, cat: 'MLB_STATS_API', question: 'MLBAM terms: individual, non-commercial, non-bulk use without written authorization. Is BAI\'s public display of these per-class records within that, or does it need authorization?' },
  { re: /(^|\.)mlb\.com|milb\.com/, cat: 'MLB_EDITORIAL', question: 'MLB.com articles and pages: facts cited with links. Facts are not copyrightable, but confirm no text or tables are reproduced.' },
  { re: /baseball-reference\.com|sports-reference\.com|Sports Reference|web\.archive\.org/, cat: 'SPORTS_REFERENCE', question: 'Sports Reference terms restrict automated collection and reuse of its data. Which records rely on it alone, and may BAI display them?' },
  { re: /fangraphs\.com/, cat: 'FANGRAPHS', question: 'FanGraphs terms: confirm per-player values (e.g. WAR) may be displayed with attribution.' },
  { re: /baseballamerica\.com/, cat: 'BASEBALL_AMERICA', question: 'Baseball America is subscription editorial content: confirm only facts (with links) are recorded, never rankings text.' },
  { re: /wikipedia\.org/, cat: 'WIKIPEDIA', question: 'CC BY-SA: facts with revision ids; attribution on the page if text is quoted.' },
  { re: /chadwick|github\.com\/chadwickbureau/, cat: 'CHADWICK', question: 'ODC-BY: attribution required on pages showing register ids.' },
  { re: /\bNEWS_REPORT\b/, cat: 'NEWS_MEDIA', question: 'News and blog reports: facts (signing dates, bonuses) cited with links; confirm no article text is reproduced.' }
]

const db = new pg.Client({ connectionString: ownerDatabaseUrl() })
await db.connect()
try {
  await db.query('begin read only')
  const tables = (await db.query(`select c.table_name, has_table_privilege('anon', format('public.%I', c.table_name), 'SELECT') as public
    from information_schema.columns c join information_schema.tables t using (table_schema, table_name)
    where c.table_schema = 'public' and c.column_name = 'source_id' and t.table_type = 'BASE TABLE' and c.table_name <> 'source_observations' order by 1`)).rows
  const sources = (await db.query(`select id, source_key, source_type::text, publisher, title, url, coalesce(substring(url from '^https?://([^/]+)'), '') as host from public.sources order by id`)).rows
  const counts = new Map(sources.map((s) => [s.id, { primary: {}, primary_public: 0, observations: 0 }]))
  for (const t of tables) {
    for (const r of (await db.query(`select source_id, count(*)::int as n from public.${t.table_name} where source_id is not null group by 1`)).rows) {
      const c = counts.get(Number(r.source_id)) ?? counts.get(r.source_id)
      if (!c) continue
      c.primary[t.table_name] = r.n
      if (t.public) c.primary_public += r.n
    }
  }
  for (const r of (await db.query(`select source_id, count(*)::int as n from public.source_observations group by 1`)).rows) {
    const c = counts.get(Number(r.source_id)) ?? counts.get(r.source_id)
    if (c) c.observations = r.n
  }
  const categorize = (s) => CATEGORIES.find((c) => c.re.test([s.source_type, s.host, s.source_key, s.publisher ?? '', s.title].join(' '))) ?? { cat: 'OTHER', question: 'Review individually.' }
  const byCat = {}
  for (const s of sources) {
    const c = counts.get(s.id) ?? counts.get(Number(s.id))
    const k = categorize(s)
    const row = (byCat[k.cat] ??= { category: k.cat, question: k.question, sources: 0, hosts: new Set(), types: new Set(), primary_rows: 0, primary_rows_public: 0, from_historical_importer: 0, observations: 0, tables: {} })
    row.sources++
    if (s.host) row.hosts.add(s.host)
    row.types.add(s.source_type)
    row.observations += c.observations
    row.primary_rows_public += c.primary_public
    for (const [t, n] of Object.entries(c.primary)) { row.primary_rows += n; row.tables[t] = (row.tables[t] ?? 0) + n; if (s.source_key.startsWith('hist:')) row.from_historical_importer += n }
  }
  const out = Object.values(byCat).map((r) => ({ ...r, hosts: [...r.hosts].sort(), types: [...r.types].sort() })).sort((a, b) => b.primary_rows - a.primary_rows)
  const hist = sources.filter((s) => s.source_key.startsWith('hist:')).length
  await db.query('rollback')
  if (process.argv.includes('--json')) { console.log(JSON.stringify({ sources: sources.length, historical_importer_sources: hist, categories: out }, null, 1)); process.exit(0) }
  console.log(`${sources.length} sources; ${hist} from the historical importer (hist:)\n`)
  console.log('| Category | Sources | Hosts | Rows citing it (primary) | Publicly readable | From the historical importer | Field observations | Main tables |')
  console.log('|---|---:|---|---:|---:|---:|---:|---|')
  for (const r of out) console.log(`| ${r.category} | ${r.sources} | ${r.hosts.slice(0, 4).join(', ')}${r.hosts.length > 4 ? ', …' : ''} | ${r.primary_rows} | ${r.primary_rows_public} | ${r.from_historical_importer} | ${r.observations} | ${Object.entries(r.tables).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t, n]) => `${t} ${n}`).join(', ')} |`)
  console.log('\nReview questions:')
  for (const r of out) console.log(`- **${r.category}**: ${r.question}`)
} finally { await db.end() }
