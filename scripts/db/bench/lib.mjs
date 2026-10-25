// Shared benchmark helpers: the fixed query set, plan capture and plan summaries.
export const SAMPLE_SQL = `with traded as (select distinct player_id from public.acquisition_dispositions where disposition = 'TRADED' order by 1 limit 5),
  other as (select distinct a.player_id from public.trade_package_assets a where a.player_id is not null and a.player_id not in (select player_id from public.acquisition_dispositions where disposition = 'TRADED') order by 1 limit 10)
  select array_agg(player_id order by player_id) ids from (select * from traded union select * from other) x`

/** The bounded queries, identical for every dataset. sample = ids of the fixed 15-player sample (5 traded acquisitions, 10 other trade players). */
export function querySet (sample, lad) {
  return {
    trade_returns_full: 'select * from analytics.trade_returns',
    acquisition_value_sample15: `select * from analytics.acquisition_value where player_id = any ('{${sample.join(',')}}'::bigint[])`,
    class_value_lad: `select * from analytics.class_value where organization_id = ${lad}`
  }
}

export async function explain (db, sql, { timeoutSeconds = 900 } = {}) {
  await db.query(`set statement_timeout = '${timeoutSeconds}s'`)
  await db.query('set track_io_timing = on')
  const t0 = Date.now()
  try {
    const r = await db.query(`explain (analyze, buffers, verbose false, format json) ${sql}`)
    return { ok: true, seconds: (Date.now() - t0) / 1000, plan: r.rows[0]['QUERY PLAN'][0] }
  } catch (e) {
    return { ok: false, seconds: (Date.now() - t0) / 1000, error: e.message }
  } finally { await db.query('reset statement_timeout') }
}

/** Walk a plan: per-node exclusive time (ms x loops), loops, row estimate error, buffers and temp I/O. */
export function summarizePlan (res) {
  if (!res.ok) return { ok: false, seconds: res.seconds, error: res.error }
  const nodes = []
  const walk = (n, depth) => {
    const kids = n.Plans ?? []
    const incl = (n['Actual Total Time'] ?? 0) * (n['Actual Loops'] ?? 1)
    const kidsIncl = kids.filter((k) => k['Parent Relationship'] !== 'InitPlan' || true).reduce((a, k) => a + (k['Actual Total Time'] ?? 0) * (k['Actual Loops'] ?? 1), 0)
    nodes.push({ depth, type: n['Node Type'], relation: n['Relation Name'] ?? n['Alias'] ?? n['CTE Name'] ?? null, subplan: n['Subplan Name'] ?? null, parent: n['Parent Relationship'] ?? null, loops: n['Actual Loops'],
      exclusive_ms: Math.max(0, Math.round(incl - kidsIncl)), inclusive_ms: Math.round(incl), rows: n['Actual Rows'], plan_rows: n['Plan Rows'], shared_hit: n['Shared Hit Blocks'], shared_read: n['Shared Read Blocks'],
      temp_read: n['Temp Read Blocks'], temp_written: n['Temp Written Blocks'] })
    for (const k of kids) walk(k, depth + 1)
  }
  walk(res.plan.Plan, 0)
  const top = [...nodes].sort((a, b) => b.exclusive_ms - a.exclusive_ms).slice(0, 8)
  const scans = {}
  for (const n of nodes) if (n.relation && /Scan/.test(n.type)) scans[n.relation] = (scans[n.relation] ?? 0) + (n.loops ?? 1)
  const rootNode = res.plan.Plan
  const sum = (k) => nodes.reduce((a, n) => a + (n[k] ?? 0), 0)
  return { ok: true, seconds: res.seconds, execution_ms: res.plan['Execution Time'], planning_ms: res.plan['Planning Time'], rows: rootNode['Actual Rows'],
    shared_hit_blocks: rootNode['Shared Hit Blocks'], shared_read_blocks: rootNode['Shared Read Blocks'], temp_read_blocks: rootNode['Temp Read Blocks'], temp_written_blocks: rootNode['Temp Written Blocks'],
    node_count: nodes.length, top_exclusive_nodes: top, scan_loops_by_relation: Object.fromEntries(Object.entries(scans).sort((a, b) => b[1] - a[1]).slice(0, 12)),
    worst_row_estimates: [...nodes].filter((n) => n.rows != null && n.plan_rows != null).map((n) => ({ ...n, ratio: Math.max(n.rows * (n.loops ?? 1) + 1, 1) / Math.max(n.plan_rows * (n.loops ?? 1) + 1, 1) })).sort((a, b) => Math.max(b.ratio, 1 / b.ratio) - Math.max(a.ratio, 1 / a.ratio)).slice(0, 4).map(({ type, relation, rows, plan_rows, loops }) => ({ type, relation, rows, plan_rows, loops })) }
}
