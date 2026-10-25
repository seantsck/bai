// Exact old-versus-new parity of the value views. Each view is dumped as canonical JSON (one row per line, ordered by the row's own
// JSON text, so NULLs, coverage states, arrays, numerics and column order all take part), the dumps are hashed and compared line by line.
//   node scripts/db/bench/parity.mjs --old bai_base_old --new bai_base_opt [--views trade_returns,acquisition_value,class_value] [--sample] [--timeout 3000] [--tag base]
// --sample restricts acquisition_value / class_value dumps to the fixed 15-player sample / LAD (bounded evaluation of the OLD views).
// A timeout is reported as NOT COMPLETED and fails the comparison: it is never counted as verified.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { startCluster, benchDir } from './cluster.mjs'
import { SAMPLE_SQL } from './lib.mjs'

const argv = process.argv.slice(2)
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d }
const oldDb = opt('old'); const newDb = opt('new')
const oldSchema = opt('old-schema', 'analytics')   // 'ref' compares against the reference views (see make-reference.mjs)
const views = opt('views', 'trade_returns,acquisition_value,class_value').split(',')
const sampleOnly = argv.includes('--sample')
const perOrg = argv.includes('--per-org')   // dump class_value per club on the old side (the whole-view old definition cannot finish)
const timeout = Number(opt('timeout', 3000))
const tag = opt('tag', `${oldDb}-vs-${newDb}`)
const outDir = path.join(benchDir, 'results', 'parity', tag); fs.mkdirSync(outDir, { recursive: true })
const cluster = await startCluster()
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')
async function dump (db, view, where, schema = 'analytics', perOrg = false) {
  await db.query(`set statement_timeout = '${timeout}s'`)
  const t0 = Date.now()
  try {
    let rows
    if (perOrg && !where) {
      // class_value of the OLD definition re-evaluates acquisition_value per group; a filter by club is pushed down, so the full view is the union of the 30 per-club runs
      rows = []
      for (const o of (await db.query('select id from public.organizations order by id')).rows) rows.push(...(await db.query(`select to_jsonb(v)::text j from ${schema}.${view} v where v.organization_id = ${o.id}`)).rows.map((r) => r.j))
      rows.sort()
    } else rows = (await db.query(`select to_jsonb(v)::text j from ${schema}.${view} v ${where} order by to_jsonb(v)::text`)).rows.map((r) => r.j)
    return { ok: true, seconds: (Date.now() - t0) / 1000, rows }
  } catch (e) { return { ok: false, seconds: (Date.now() - t0) / 1000, error: e.message } } finally { await db.query('reset statement_timeout') }
}
const report = { old: oldDb, old_schema: oldSchema, new: newDb, sample_only: sampleOnly, views: {} }
let failed = false
try {
  const a = await cluster.connect(oldDb); const b = await cluster.connect(newDb)
  const sample = (await a.query(SAMPLE_SQL)).rows[0].ids.map(Number)
  const lad = (await a.query("select id from public.organizations where franchise_key = 'LAD'")).rows[0].id
  const columns = async (db, view) => (await db.query(`select attname, format_type(atttypid, atttypmod) t from pg_attribute where attrelid = 'analytics.${view}'::regclass and attnum > 0 and not attisdropped order by attnum`)).rows.map((r) => `${r.attname}:${r.t}`).join(',')
  for (const view of views) {
    const where = sampleOnly ? (view === 'acquisition_value' ? `where v.player_id = any ('{${sample.join(',')}}'::bigint[])` : view === 'class_value' ? `where v.organization_id = ${lad}` : '') : ''
    const colsOld = oldSchema === 'analytics' ? await columns(a, view) : (await a.query(`select attname, format_type(atttypid, atttypmod) t from pg_attribute where attrelid = '${oldSchema}.${view}'::regclass and attnum > 0 and not attisdropped order by attnum`)).rows.map((r) => `${r.attname}:${r.t}`).join(','); const colsNew = await columns(b, view)
    const [o, n] = [await dump(a, view, where, oldSchema, perOrg && view === 'class_value'), await dump(b, view, where)]
    const entry = { where: where || 'all rows', columns_identical: colsOld === colsNew, old_seconds: o.seconds, new_seconds: n.seconds }
    if (!o.ok || !n.ok) { entry.status = 'NOT COMPLETED'; entry.error = o.ok ? `new: ${n.error}` : `old: ${o.error}`; failed = true }
    else {
      entry.old_rows = o.rows.length; entry.new_rows = n.rows.length; entry.old_sha256 = sha(o.rows.join('\n')); entry.new_sha256 = sha(n.rows.join('\n'))
      const oldSet = new Map(); for (const r of o.rows) oldSet.set(r, (oldSet.get(r) ?? 0) + 1)
      const diff = []; for (const r of n.rows) { const c = oldSet.get(r); if (!c) diff.push({ only_in_new: r }); else if (c === 1) oldSet.delete(r); else oldSet.set(r, c - 1) }
      for (const [r] of oldSet) diff.push({ only_in_old: r })
      entry.identical = !diff.length && entry.columns_identical
      entry.status = entry.identical ? 'IDENTICAL' : 'DIFFERENT'
      entry.differences = diff.length; entry.first_differences = diff.slice(0, 5)
      if (!entry.identical) failed = true
    }
    report.views[view] = entry
    console.log(`${view} [${entry.where}]: ${entry.status}${entry.old_rows != null ? ` ${entry.old_rows}/${entry.new_rows} rows, old ${o.seconds}s new ${n.seconds}s` : ` ${entry.error}`}${entry.columns_identical ? '' : ' COLUMNS DIFFER'}`)
  }
  await a.end(); await b.end()
} finally { await cluster.stop() }
fs.writeFileSync(path.join(outDir, 'parity.json'), JSON.stringify(report, null, 1) + '\n')
process.exit(failed ? 1 : 0)
