// The Phase 18 load-test database: the 030 template with every local Retrosheet batch applied (three trade batches and three acquisition batches
// for 2010-2014, 2015-2020 and 2021, BAI's own 65 trades, about 11,000 transactions in all). The RETROSHEET display grant is recorded in THIS
// DISPOSABLE database only, to exercise the read model; nothing is granted on hosted. Then the read model is refreshed and timed.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startCluster } from './cluster.mjs'
import * as P from '../../research/lib/pipeline.mjs'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const c = await startCluster()
try {
  await c.clone('bai_tpl_030', 'bai_p18_all')
  const db = await c.connect('bai_p18_all')
  const batches = [['out-2010-2014', 'candidates-batch.json'], ['out', 'candidates-batch.json'], ['out-2021', 'candidates-batch.json'], ['out-acq-2010-2014', 'acquisitions-batch.json'], ['out-acq-2015-2020', 'acquisitions-batch.json'], ['out-acq-2021', 'acquisitions-batch.json']]
  for (const [d, f] of batches) {
    const doc = JSON.parse(fs.readFileSync(path.join(root, '.local/retrosheet', d, f), 'utf8'))
    const tmp = path.join(os.tmpdir(), `p18-${d}.json`); fs.writeFileSync(tmp, JSON.stringify(doc))
    const { batch } = await P.stageFile(db, tmp, { allowFixtures: true }); fs.rmSync(tmp)
    await P.validateBatch(db, batch.id)
    const t0 = Date.now()
    const r = await P.applyBatch(db, batch.id, { write: true, allowPartial: true })
    console.log(d, f, JSON.stringify(r.report.actions), `${((Date.now() - t0) / 1000).toFixed(0)}s`)
  }
  await db.query("insert into ingest.source_publication_grants (attribution_category, basis_reference, scope_note) values ('RETROSHEET', 'load test in a disposable database only', 'never on hosted')")
  await db.query('analyze')
  const t0 = Date.now()
  await db.query('select public.refresh_transaction_read_models()')
  console.log('refresh_transaction_read_models', `${((Date.now() - t0) / 1000).toFixed(1)}s`, JSON.stringify((await db.query('select transactions, by_status, by_category, withheld_unauthorized from rm_transaction_overview')).rows[0]))
  await db.query('analyze')
  await db.end()
} finally { await c.stop() }
