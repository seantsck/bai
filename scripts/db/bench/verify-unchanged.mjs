// Proves migration 029 left everything except the three views alone: every table (historical drafts, release audits, international records and the
// rest) has identical contents before and after, and the public draft and international views return identical rows.
//   node scripts/db/bench/verify-unchanged.mjs <before database> <after database>
import { startCluster } from './cluster.mjs'

const [before, after] = process.argv.slice(2)
const c = await startCluster()
let failed = false
try {
  const a = await c.connect(before); const b = await c.connect(after)
  const q = async (db, s) => (await db.query(s)).rows
  const tables = (await q(a, `select table_schema s, table_name t from information_schema.tables where table_schema in ('public','ingest','research','bai_meta') and table_type = 'BASE TABLE' order by 1, 2`)).filter((r) => `${r.s}.${r.t}` !== 'bai_meta.schema_migrations')
  const fp = async (db, t) => (await q(db, `select count(*)::int n, coalesce(md5(string_agg(x::text, '|' order by x::text)), '') h from ${t} x`))[0]
  const changed = []
  for (const { s, t } of tables) { const [x, y] = [await fp(a, `${s}.${t}`), await fp(b, `${s}.${t}`)]; if (x.n !== y.n || x.h !== y.h) changed.push(`${s}.${t}`) }
  console.log(`${tables.length} tables compared: ${changed.length ? `CHANGED ${changed.join(', ')}` : 'identical'}`)
  if (changed.length) failed = true
  const views = (await q(a, `select schemaname s, viewname v from pg_views where schemaname = 'public' and (viewname like 'v\\_draft%' or viewname like 'v\\_international%' or viewname like 'rm\\_%' or viewname like 'v\\_selection%' or viewname like 'v\\_source%') order by 2`))
  const vch = []
  for (const { s, v } of views) { const [x, y] = [await fp(a, `${s}.${v}`), await fp(b, `${s}.${v}`)]; if (x.n !== y.n || x.h !== y.h) vch.push(v) }
  console.log(`${views.length} public draft / international / read-model views compared: ${vch.length ? `CHANGED ${vch.join(', ')}` : 'identical'}`)
  if (vch.length) failed = true
  const other = (await q(a, `select count(*)::int n from pg_views where schemaname = 'analytics'`))[0].n
  const defs = await q(b, `select viewname from pg_views where schemaname = 'analytics' and definition ~* 'materialized' order by 1`)
  console.log(`${other} analytics views; those using a MATERIALIZED CTE after 029: ${defs.map((d) => d.viewname).join(', ')}`)
  await a.end(); await b.end()
} finally { await c.stop() }
process.exit(failed ? 1 : 0)
