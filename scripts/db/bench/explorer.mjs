// Repeatable benchmark of the transaction explorer's page queries (the same parameterized SQL the app runs, as the anon role in a read-only transaction)
// on a benchmark database whose read model has been refreshed, with EXPLAIN (ANALYZE, BUFFERS) of the heaviest page queries and gates on the medians.
//   node --import ./tests/support/register-ts.mjs scripts/db/bench/explorer.mjs --db bai_p18_all [--runs 20] [--tag explorer]
// Gate: every page query median under 100 ms; the coverage page set under 250 ms in total. Failures exit non-zero and are never skipped.
import fs from 'node:fs'
import path from 'node:path'
import { startCluster, benchDir, hardware } from './cluster.mjs'
import { parseTransactionParams, buildTransactionQuery } from '../../../lib/transactions.ts'

const argv = process.argv.slice(2)
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d }
const name = opt('db', 'bai_p18_all'); const runs = Number(opt('runs', 20)); const tag = opt('tag', 'explorer')
const cluster = await startCluster()
const results = { tag, run_at: new Date().toISOString(), hardware: hardware(), database: name, runs, queries: {}, plans: {} }
let failed = false
try {
  const db = await cluster.connect(name)
  const counts = (await db.query('select (select count(*) from public.rm_transactions)::int tx, (select count(*) from public.rm_transaction_assets)::int assets, (select count(*) from public.rm_transaction_players)::int players, (select count(*) from public.rm_transaction_followups)::int followups, (select count(*) from public.transactions)::int canonical')).rows[0]
  results.counts = counts
  const asAnon = async (sql, params = [], explain = false) => {
    await db.query('begin read only'); await db.query('set local role anon'); await db.query("set local statement_timeout = '5s'")
    try { const r = await db.query(`${explain ? 'explain (analyze, buffers, format json) ' : ''}${sql}`, params); return explain ? r.rows[0]['QUERY PLAN'][0] : r.rows } finally { await db.query('rollback') }
  }
  const sample = (await db.query("select transaction_id from public.rm_transactions where category = 'TRADE' order by transaction_date desc limit 1")).rows[0]?.transaction_id
  const seasons = (await db.query('select min(season) a, max(season) b from public.rm_transactions')).rows[0]
  const pageQueries = {
    first_page: {}, deep_page_100: { page: '100' }, deepest_allowed_page: { page: '200' },
    season: { season: String(seasons.b - 3) }, club: { club: 'LAD' }, type_waiver: { type: 'WAIVER' }, type_trade: { type: 'TRADE' }, status_partial: { status: 'PARTIAL' }, status_verified: { status: 'VERIFIED_COMPLETE' },
    club_season_type: { club: 'NYY', season: String(seasons.b - 5), type: 'FREE_AGENT' }, name_prefix: { q: 'smith' }, name_two_tokens: { q: 'john sm' }, club_name: { q: 'lad' }
  }
  const detail = sample ? {
    transaction: ['select * from rm_transactions where transaction_id = $1', [sample]],
    assets: ['select position, from_key, to_key, asset_kind, player_name from rm_transaction_assets where transaction_id = $1 order by position limit 200', [sample]],
    sources: ['select position, title from rm_transaction_sources where transaction_id = $1 order by position limit 50', [sample]],
    followups: ['select f.player_id, f.step, f.later_transaction_id from rm_transaction_followups f where f.transaction_id = $1 order by f.player_id, f.step limit 100', [sample]],
    returns: ['select club_key, provider, evidence from rm_transaction_returns where transaction_id = $1 limit 20', [sample]]
  } : {}
  const coverage = {
    overview: ['select * from rm_transaction_overview limit 1'],
    season_totals: ["select season, count(*)::int as records, (count(*) filter (where status = 'PARTIAL'))::int as partial from rm_transactions group by season order by season desc limit 200"],
    club_seasons: ['select season, club_key, records, coverage_state from rm_transaction_club_seasons order by season desc, club_key limit 2000'],
    category_matrix: ['select season, club_key, category, records from rm_transaction_coverage order by season desc, club_key, category limit 6000'],
    attribution: ['select attribution_category, statement from source_attribution_statements limit 20']
  }
  const time = async (key, sql, params, group) => {
    const ms = []
    let rows = 0
    for (let i = 0; i < runs + 2; i++) { const t0 = performance.now(); const r = await asAnon(sql, params); if (i >= 2) ms.push(performance.now() - t0); rows = r.length }
    ms.sort((a, b) => a - b)
    results.queries[key] = { group, median_ms: Math.round(ms[Math.floor(ms.length / 2)] * 100) / 100, p95_ms: Math.round(ms[Math.floor(ms.length * 0.95)] * 100) / 100, rows }
    return results.queries[key]
  }
  for (const [k, p] of Object.entries(pageQueries)) { const { sql, params } = buildTransactionQuery(parseTransactionParams(p)); await time(k, sql, params, 'page') }
  for (const [k, [sql, params]] of Object.entries(detail)) await time(`detail_${k}`, sql, params ?? [], 'detail')
  for (const [k, [sql, params]] of Object.entries(coverage)) await time(`coverage_${k}`, sql, params ?? [], 'coverage')
  for (const k of ['first_page', 'deep_page_100', 'club_season_type', 'name_prefix']) {
    const { sql, params } = buildTransactionQuery(parseTransactionParams(pageQueries[k]))
    const plan = await asAnon(sql, params, true)
    const nodes = []; const walk = (n) => { nodes.push(`${n['Node Type']}${n['Index Name'] ? ' using ' + n['Index Name'] : n['Relation Name'] ? ' on ' + n['Relation Name'] : ''}`); (n.Plans ?? []).forEach(walk) }; walk(plan.Plan)
    results.plans[k] = { execution_ms: plan['Execution Time'], planning_ms: plan['Planning Time'], shared_hit: plan.Plan['Shared Hit Blocks'], shared_read: plan.Plan['Shared Read Blocks'], temp_written: plan.Plan['Temp Written Blocks'] ?? 0, nodes: [...new Set(nodes)].slice(0, 10) }
  }
  const t0 = Date.now(); await db.query('select public.refresh_transaction_read_models()'); results.refresh_seconds = (Date.now() - t0) / 1000
  for (const [k, v] of Object.entries(results.queries)) if (v.group !== 'coverage' && v.median_ms > 100) { failed = true; console.log(`GATE FAILED: ${k} median ${v.median_ms} ms`) }
  const covTotal = Object.values(results.queries).filter((v) => v.group === 'coverage').reduce((a, v) => a + v.median_ms, 0)
  results.coverage_total_ms = Math.round(covTotal * 100) / 100
  if (covTotal > 250) { failed = true; console.log(`GATE FAILED: coverage page queries total ${covTotal} ms`) }
  for (const [k, v] of Object.entries(results.queries)) console.log(`${k.padEnd(28)} median ${String(v.median_ms).padStart(8)} ms  p95 ${String(v.p95_ms).padStart(8)} ms  rows ${v.rows}`)
  console.log(`read model: ${counts.tx} transactions of ${counts.canonical}; refresh ${results.refresh_seconds}s; coverage page total ${results.coverage_total_ms} ms`)
  await db.end()
} finally { await cluster.stop() }
results.gate_passed = !failed
fs.mkdirSync(path.join(benchDir, 'results'), { recursive: true })
fs.writeFileSync(path.join(benchDir, 'results', `${tag}.json`), JSON.stringify(results, null, 1) + '\n')
process.exit(failed ? 1 : 0)
