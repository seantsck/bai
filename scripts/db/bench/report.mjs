// Fills the placeholders of docs/transactions/value-view-scale.md from the recorded benchmark and parity results (no hand-typed numbers).
//   node scripts/db/bench/report.mjs [--write]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { benchDir } from './cluster.mjs'
import { summarizePlan } from './lib.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const res = path.join(benchDir, 'results')
const read = (f) => (fs.existsSync(path.join(res, f)) ? JSON.parse(fs.readFileSync(path.join(res, f), 'utf8')) : null)
const sec = (q) => (q ? (q.status === 'COMPLETED' ? `${q.median_seconds} s` : q.status) : 'not run')

// ---- parity ----------------------------------------------------------------------------------------------------------
const PARITY = [
  ['scale-full-vs-reference', 'Full views, 401 trades, versus the reference'],
  ['scale-class-full-direct', 'Whole `class_value`, 401 trades, old view run per club vs new'],
  ['scale-sample-direct', 'OLD views run directly on the bounded sample (15 players; LAD), 401 trades'],
  ['base-full-direct', 'Full `trade_returns` and `acquisition_value`, 65 trades, old view run directly'],
  ['base-class-full-direct', 'Whole `class_value`, 65 trades, old view run per club vs new']
]
const rows = []
for (const [tag, label] of PARITY) {
  const p = read(`parity/${tag}/parity.json`)
  if (!p) { rows.push(`| ${label} | not run | | | |`); continue }
  for (const [view, v] of Object.entries(p.views)) {
    rows.push(`| ${label} | \`${view}\`${v.where !== 'all rows' ? ' (bounded)' : ''} | ${v.status}${v.columns_identical === false ? ' (COLUMNS DIFFER)' : ''} | ${v.old_rows != null ? `${v.old_rows} / ${v.new_rows}` : '-'} | ${v.old_seconds != null ? `${v.old_seconds} s -> ${v.new_seconds} s` : '-'} |`)
  }
}
const parityTable = ['| Comparison | View | Result | Rows old / new | Time old -> new |', '|---|---|---|---|---|', ...rows].join('\n')

// ---- benchmarks ----------------------------------------------------------------------------------------------------------
const files = ['before-quiet-base', 'before-quiet-scale', 'after-opt']
const merged = {}
let hardware = null; let settings = null
for (const f of files) { const b = read(`${f}.json`); if (!b) continue; hardware ??= b.hardware; for (const [db, d] of Object.entries(b.databases)) merged[db] = { counts: d.counts, queries: { ...(merged[db]?.queries ?? {}), ...d.queries } } }
const order = ['trade_returns_full', 'acquisition_value_sample15', 'acquisition_value_full', 'class_value_lad', 'class_value_full', 'draft_only_class_value_lad', 'draft_explorer']
const dbRows = [['bai_base_old', 'bai_base_opt', '65 trades'], ['bai_scale_old', 'bai_scale_opt', '401 trades'], [null, 'bai_all_opt', '667 trades']]
const lines = ['| Query | Dataset | Old (028) | New (029) | Speed-up |', '|---|---|---|---|---|']
for (const q of order) {
  for (const [o, n, label] of dbRows) {
    const a = o ? merged[o]?.queries?.[q] : null; const b = merged[n]?.queries?.[q]
    if (!a && !b) continue
    const sp = a?.status === 'COMPLETED' && b?.status === 'COMPLETED' && b.median_seconds > 0 ? `${(a.median_seconds / b.median_seconds).toFixed(0)}x` : (a && a.status !== 'COMPLETED' && b?.status === 'COMPLETED' ? `old NOT COMPLETED > ${a.status.replace(/\D/g, '')} s` : '-')
    lines.push(`| \`${q}\` | ${label} | ${a ? sec(a) : '-'} | ${sec(b)} | ${sp} |`)
  }
}
const benchTable = lines.join('\n')
const hw = hardware ? `${hardware.cpu}, ${hardware.logical_cpus} logical CPUs, ${hardware.memory_gb} GB RAM, ${hardware.platform}, ${hardware.node}; PostgreSQL 17 (embedded), shared_buffers 512MB, work_mem 64MB` : 'unknown'
const ds = read('datasets.json')
// ---- plans -------------------------------------------------------------------------------------------------------------
const planRows = []
for (const [tag, db, label] of [['before', 'bai_base', 'old, 65 trades'], ['before', 'bai_scale_old', 'old, 401 trades'], ['after', 'bai_base_opt', 'new, 65 trades'], ['after', 'bai_scale_opt', 'new, 401 trades']]) {
  for (const q of ['trade_returns_full', 'acquisition_value_sample15', 'class_value_lad']) {
    const f = path.join(res, 'plans', `${tag}-${db}-${q}.json`)
    if (!fs.existsSync(f)) continue
    const s = summarizePlan(JSON.parse(fs.readFileSync(f, 'utf8')))
    if (!s.ok) { planRows.push(`| \`${q}\` | ${label} | NOT COMPLETED: ${s.error} | | | |`); continue }
    const scans = Object.entries(s.scan_loops_by_relation).slice(0, 2).map(([r, n]) => `${r} x${n.toLocaleString('en-US')}`).join(', ')
    planRows.push(`| \`${q}\` | ${label} | ${(s.execution_ms / 1000).toFixed(2)} s | ${s.shared_hit_blocks.toLocaleString('en-US')} / ${s.shared_read_blocks} | ${s.temp_read_blocks ?? 0} / ${s.temp_written_blocks ?? 0} | ${scans} |`)
  }
}
const planTable = ['| Query | Dataset | Execution (EXPLAIN ANALYZE) | Buffers hit / read | Temp blocks read / written | Most-repeated scans (loops) |', '|---|---|---|---|---|---|', ...planRows].join('\n')
const out = { parityTable, benchTable, hw, snapshot: ds?.snapshot_sha256, batch: ds?.candidates_batch_sha256 }
if (process.argv.includes('--write')) {
  const f = path.join(root, 'docs/transactions/value-view-scale.md')
  let t = fs.readFileSync(f, 'utf8')
  t = t.replace('PARITY_TABLE', parityTable).replace('BENCH_TABLE', benchTable).replace('PLAN_TABLE', planTable).replace('HARDWARE', hw).replace('SNAPSHOT_SHA', out.snapshot).replace('BATCH_SHA', out.batch)
  fs.writeFileSync(f, t)
}
console.log(planTable); console.log(); console.log(parityTable); console.log(); console.log(benchTable); console.log(); console.log(hw)
