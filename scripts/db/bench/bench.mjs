// Repeatable before/after timings of the value views on the fixed benchmark databases (plain execution, no EXPLAIN overhead).
//   node scripts/db/bench/bench.mjs --dbs bai_base_old,bai_base_opt,bai_scale_old,bai_scale_opt --queries trade_returns_full,acquisition_value_sample15,... [--repeat 3] [--timeout 600] [--tag run1]
// A query that exceeds its timeout is recorded as "NOT COMPLETED > Ns": never as a pass. Hardware and settings are recorded with the results.
import fs from 'node:fs'
import path from 'node:path'
import { startCluster, benchDir, hardware } from './cluster.mjs'
import { SAMPLE_SQL } from './lib.mjs'

const argv = process.argv.slice(2)
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d }
const dbs = opt('dbs').split(',')
const only = opt('queries', null)?.split(',')
const repeat = Number(opt('repeat', 3)); const timeout = Number(opt('timeout', 600)); const tag = opt('tag', 'bench')
const cluster = await startCluster()
const results = { tag, run_at: new Date().toISOString(), hardware: hardware(), repeat, timeout_seconds: timeout, databases: {} }
try {
  for (const name of dbs) {
    const db = await cluster.connect(name)
    const sample = (await db.query(SAMPLE_SQL)).rows[0].ids.map(Number)
    const lad = (await db.query("select id from public.organizations where franchise_key = 'LAD'")).rows[0].id
    const counts = (await db.query('select (select count(*) from public.transactions)::int trades, (select count(*) from public.trade_package_assets)::int assets, (select count(*) from public.players)::int players, (select count(*) from public.war_observations)::int war')).rows[0]
    const queries = {
      trade_returns_full: 'select count(*), md5(string_agg(to_jsonb(x)::text, \'|\' order by to_jsonb(x)::text)) from analytics.trade_returns x',
      acquisition_value_sample15: `select count(*), md5(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text)) from analytics.acquisition_value x where player_id = any ('{${sample.join(',')}}'::bigint[])`,
      acquisition_value_full: "select count(*), md5(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text)) from analytics.acquisition_value x",
      class_value_lad: `select count(*), md5(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text)) from analytics.class_value x where organization_id = ${lad}`,
      class_value_full: "select count(*), md5(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text)) from analytics.class_value x",
      draft_only_class_value_lad: `select count(*), md5(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text)) from analytics.class_value x where organization_id = ${lad} and channel = 'DRAFT'`,
      draft_explorer: 'select count(*) from public.v_draft_explorer'
    }
    results.databases[name] = { counts, queries: {} }
    for (const [key, sql] of Object.entries(queries)) {
      if (only && !only.includes(key)) continue
      const times = []; let status = 'COMPLETED'; let digest = null
      for (let i = 0; i < repeat; i++) {
        await db.query(`set statement_timeout = '${timeout}s'`)
        const t0 = Date.now()
        try { const r = await db.query(sql); times.push((Date.now() - t0) / 1000); digest = `${r.rows[0].count} rows${r.rows[0].md5 ? ' ' + r.rows[0].md5.slice(0, 12) : ''}` } catch (e) { if (!/timeout/.test(e.message)) throw e; status = `NOT COMPLETED > ${timeout}s`; break } finally { await db.query('reset statement_timeout') }
      }
      results.databases[name].queries[key] = { status, seconds: times, median_seconds: times.length ? [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)] : null, result: digest }
      console.log(`${name} ${key}: ${status === 'COMPLETED' ? `${results.databases[name].queries[key].median_seconds}s (n=${times.length}) ${digest}` : status}`)
    }
    await db.end()
  }
} finally { await cluster.stop() }
fs.mkdirSync(path.join(benchDir, 'results'), { recursive: true })
fs.writeFileSync(path.join(benchDir, 'results', `${tag}.json`), JSON.stringify(results, null, 1) + '\n')
