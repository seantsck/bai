// Reconciles the Phase 18 load-test population: what is in the canonical tables, what the public read model publishes, and why they differ.
//   node scripts/db/bench/reconcile.mjs --db bai_p18_all
// Counts come from the database; held and excluded counts from the local (gitignored) staging summaries. Nothing is changed.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startCluster } from './cluster.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const argv = process.argv.slice(2)
const name = argv.includes('--db') ? argv[argv.indexOf('--db') + 1] : 'bai_p18_all'
const cluster = await startCluster()
const out = { database: name }
try {
  const db = await cluster.connect(name)
  const q = async (sql) => (await db.query(sql)).rows
  const cat = "public.source_attribution_category(s.url, s.source_key, s.publisher, s.title, s.source_type)"
  out.canonical = {
    total: Number((await q('select count(*) n from public.transactions'))[0].n),
    by_type: Object.fromEntries((await q('select transaction_type::text t, count(*) n from public.transactions group by 1 order by 1')).map((r) => [r.t, Number(r.n)])),
    by_record_source: Object.fromEntries((await q(`select ${cat} c, count(*) n from public.transactions t join public.sources s on s.id = t.source_id group by 1 order by 1`)).map((r) => [r.c, Number(r.n)]))
  }
  const trades = await q(`select ${cat} c, (case when t.transaction_date < '2015-01-01' then '2010-2014' when t.transaction_date < '2021-01-01' then '2015-2020' else '2021' end) period, count(*) n
    from public.transactions t join public.sources s on s.id = t.source_id where t.transaction_type = 'TRADE' group by 1, 2 order by 1, 2`)
  out.trades = { existing_bai: trades.filter((r) => r.c !== 'RETROSHEET').reduce((a, r) => a + Number(r.n), 0), imported_retrosheet_by_period: Object.fromEntries(trades.filter((r) => r.c === 'RETROSHEET').map((r) => [r.period, Number(r.n)])) }
  out.trades.imported_total = Object.values(out.trades.imported_retrosheet_by_period).reduce((a, b) => a + b, 0)
  out.trades.total = out.trades.existing_bai + out.trades.imported_total
  out.non_trade_acquisitions = Number((await q("select count(*) n from public.transactions where transaction_type <> 'TRADE'"))[0].n)
  out.read_model = {
    published: Number((await q('select count(*) n from public.rm_transactions'))[0].n),
    by_category: Object.fromEntries((await q('select category c, count(*) n from public.rm_transactions group by 1 order by 1')).map((r) => [r.c, Number(r.n)])),
    withheld_by_record_source: Object.fromEntries((await q(`select ${cat} c, count(*) n from public.transactions t join public.sources s on s.id = t.source_id where t.id not in (select transaction_id from public.rm_transactions) group by 1 order by 1`)).map((r) => [r.c, Number(r.n)])),
    withheld_total: Number((await q('select count(*) n from public.transactions where id not in (select transaction_id from public.rm_transactions)'))[0].n)
  }
  out.reconciles = out.canonical.total === out.read_model.published + out.read_model.withheld_total && out.trades.total === out.canonical.by_type.TRADE && out.canonical.total === out.trades.total + out.non_trade_acquisitions
  await db.end()
} finally { await cluster.stop() }

// held and excluded, from the local staging summaries
const read = (d, f) => { const p = path.join(root, '.local/retrosheet', d, f); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null }
const staging = {}
for (const [label, td, ad] of [['2010-2014', 'out-2010-2014', 'out-acq-2010-2014'], ['2015-2020', 'out', 'out-acq-2015-2020'], ['2021', 'out-2021', 'out-acq-2021']]) {
  const t = read(td, 'run-summary.json'); const a = read(ad, 'acquisitions-summary.json')
  staging[label] = {
    trade_groups: t?.inventory?.trade_groups ?? null, trade_candidates: t?.candidates ?? null, trade_holds: t?.holds ?? null, matched_existing_bai_trades: t ? (t.reconciliation.EXISTING_CONFIRMED_MATCH + t.reconciliation.EXISTING_POSSIBLE_MATCH) : null,
    acquisitions_staged: a?.candidates ?? null, acquisition_holds: a?.holds ?? null,
    excluded_not_acquisitions: a ? Object.fromEntries(Object.entries(a.record_kinds).filter(([k]) => k.startsWith('NOT_AN_ACQUISITION')).map(([k, v]) => [k.replace('NOT_AN_ACQUISITION:', ''), v])) : null
  }
}
out.staging = staging
console.log(JSON.stringify(out, null, 1))
process.exit(out.reconciles ? 0 : 1)
