// Applies one Retrosheet period's candidates batch to its OWN disposable clone, so a failure in one period cannot touch another:
//   node apply-period.mjs <template database> <new database> <batch file> <output json>
// Reports: validation, dry run, write, replay, collisions with existing BAI trades, integrity, completeness and view agreement.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startCluster } from './cluster.mjs'
import * as P from '../../research/lib/pipeline.mjs'
import { integrityViolations } from '../../research/lib/integrity.mjs'

const [template, name, batchFile, outFile] = process.argv.slice(2)
const c = await startCluster()
const report = { template, database: name, batch: path.basename(path.dirname(batchFile)) }
try {
  await c.clone(template, name)
  const db = await c.connect(name)
  const q = async (s, p) => (await db.query(s, p)).rows
  const before = (await q('select count(*)::int n, coalesce(max(id), 0)::int m from public.transactions'))[0]
  const doc = JSON.parse(fs.readFileSync(batchFile, 'utf8'))
  const stage = async (key) => { const f = path.join(os.tmpdir(), `${name}-${key}.json`); fs.writeFileSync(f, JSON.stringify({ ...doc, batch_key: key })); const r = await P.stageFile(db, f, { allowFixtures: true }); fs.rmSync(f); return r.batch }
  const b1 = await stage(`${name}-1`)
  const v = await P.validateBatch(db, b1.id)
  report.records = doc.records.length; report.validation = v.counts
  const dry = await P.applyBatch(db, b1.id, { write: false, allowPartial: true })
  report.dry_run = dry.report.actions
  report.dry_run_wrote_nothing = (await q('select count(*)::int n from public.transactions'))[0].n === before.n
  const done = await P.applyBatch(db, b1.id, { write: true, allowPartial: true })
  report.apply = done.report.actions
  report.held = done.results.filter((r) => r.action === 'HELD').map((r) => ({ record_index: r.record_index, reason: r.reason.replace(/transaction \d+/, 'an existing BAI transaction') }))
  report.collisions_with_existing_bai_trades = report.held.filter((h) => /^COLLISION/.test(h.reason)).length
  report.conflicts = report.held.filter((h) => /^CONFLICT/.test(h.reason)).length
  const b2 = await stage(`${name}-2`)
  await P.validateBatch(db, b2.id)
  const again = await P.applyBatch(db, b2.id, { write: true, allowPartial: true })
  report.replay = again.report.actions
  report.replay_inserted_nothing = !((again.report.actions.INSERT ?? 0) || (again.report.actions.UPDATE_UNKNOWN ?? 0))
  report.integrity_violations = (await integrityViolations(db)).map((x) => x.key)
  report.duplicate_player_in_transaction = (await q('select count(*)::int n from (select k.transaction_id, a.player_id from public.trade_package_assets a join public.trade_packages k on k.id = a.trade_package_id where a.player_id is not null group by 1, 2 having count(*) > 1) x'))[0].n
  report.preexisting_trades_unchanged = (await q('select count(*)::int n from public.transactions where id <= $1', [before.m]))[0].n === before.n
  report.completeness = Object.fromEntries((await q(`select c.completeness, count(*)::int n from analytics.transaction_completeness c join public.transaction_external_ids x on x.transaction_id = c.transaction_id and x.scheme = 'RETROSHEET_TXN' group by 1`)).map((r) => [r.completeness, r.n]))
  report.new_transactions = (await q('select count(*)::int n from public.transactions'))[0].n - before.n
  const t0 = Date.now()
  report.class_value_rows_after = (await q('select count(*)::int n from analytics.class_value'))[0].n
  report.class_value_seconds_after = (Date.now() - t0) / 1000
  await db.end()
} finally { await c.stop() }
fs.mkdirSync(path.dirname(outFile), { recursive: true })
fs.writeFileSync(outFile, JSON.stringify(report, null, 1) + '\n')
console.log(JSON.stringify(report))
