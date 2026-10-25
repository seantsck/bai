// Plan capture for the diagnosis: EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) of bounded queries against analytics.trade_returns,
// analytics.acquisition_value (a fixed 15-player sample) and analytics.class_value (one club), on bai_base (65 trades) and bai_scale (401).
//   node scripts/db/bench/explain.mjs [--db bai_base,bai_scale] [--only trade_returns_full,...] [--timeout 900] [--tag before]
import fs from 'node:fs'
import path from 'node:path'
import { startCluster, benchDir, hardware } from './cluster.mjs'
import { SAMPLE_SQL, querySet, explain, summarizePlan } from './lib.mjs'

const argv = process.argv.slice(2)
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d }
const dbs = opt('db', 'bai_base,bai_scale').split(',')
const only = opt('only', null)?.split(',')
const timeout = Number(opt('timeout', 900))
const tag = opt('tag', 'before')
const out = path.join(benchDir, 'results', 'plans'); fs.mkdirSync(out, { recursive: true })
const cluster = await startCluster()
try {
  const summary = { tag, hardware: hardware(), results: {} }
  for (const name of dbs) {
    const db = await cluster.connect(name)
    const pgv = (await db.query('show server_version')).rows[0].server_version
    const settings = Object.fromEntries((await db.query("select name, setting, unit from pg_settings where name in ('shared_buffers','work_mem','effective_cache_size','max_parallel_workers_per_gather','jit')")).rows.map((r) => [r.name, r.setting + (r.unit ?? '')]))
    const sample = (await db.query(SAMPLE_SQL)).rows[0].ids.map(Number)
    const lad = (await db.query("select id from public.organizations where franchise_key = 'LAD'")).rows[0].id
    summary.results[name] = { postgres: pgv, settings, sample_size: sample.length }
    for (const [key, sql] of Object.entries(querySet(sample, lad))) {
      if (only && !only.includes(key)) continue
      const res = await explain(db, sql, { timeoutSeconds: timeout })
      fs.writeFileSync(path.join(out, `${tag}-${name}-${key}.json`), JSON.stringify(res, null, 1))
      const s = summarizePlan(res)
      summary.results[name][key] = s
      console.log(`${name} ${key}: ${s.ok ? `${(s.execution_ms / 1000).toFixed(1)}s, ${s.rows} rows, hit ${s.shared_hit_blocks} read ${s.shared_read_blocks} temp r/w ${s.temp_read_blocks ?? 0}/${s.temp_written_blocks ?? 0}` : `FAILED after ${s.seconds}s: ${s.error}`}`)
    }
    await db.end()
  }
  fs.writeFileSync(path.join(benchDir, 'results', `explain-${tag}.json`), JSON.stringify(summary, null, 1) + '\n')
} finally { await cluster.stop() }
