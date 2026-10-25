// REFERENCE for the old semantics at a size where the old views cannot finish. In a database that still has the 023/028 views, schema
// `ref` gets: trade_returns as a TABLE (the old view evaluated once, 12 s at 401 trades), and acquisition_value / class_value as
// views whose text is the old definition verbatim except that analytics.trade_returns / analytics.acquisition_value are read from ref.
// So ref.* differs from the old views only in evaluating trade_returns once; its trade_returns input is the old view's own output.
// parity.mjs also compares the OLD views directly on bounded samples to confirm the reference matches them.
//   node make-reference.mjs <database>
import { startCluster } from './cluster.mjs'
const name = process.argv[2]
const c = await startCluster()
try {
  const db = await c.connect(name)
  await db.query('drop schema if exists ref cascade'); await db.query('create schema ref')
  await db.query('create table ref.trade_returns as select * from analytics.trade_returns')
  let av = (await db.query("select pg_get_viewdef('analytics.acquisition_value'::regclass) d")).rows[0].d
  let cv = (await db.query("select pg_get_viewdef('analytics.class_value'::regclass) d")).rows[0].d
  const swap = (t) => t.replaceAll('analytics.trade_returns', 'ref.trade_returns').replaceAll('analytics.acquisition_value', 'ref.acquisition_value')
  if (/materialized/i.test(av)) throw new Error('this database already has the optimized views')
  await db.query(`create view ref.acquisition_value as ${swap(av)}`)
  await db.query(`create view ref.class_value as ${swap(cv)}`)
  console.log(`${name}: reference ready (ref.trade_returns ${(await db.query('select count(*)::int n from ref.trade_returns')).rows[0].n} rows)`)
  await db.end()
} finally { await c.stop() }
