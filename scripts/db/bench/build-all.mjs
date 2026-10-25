// Load test only (NOT a validated import set): a clone of the 029 template with the three period batches applied in turn, so the optimized views can be timed
// at the combined size (2010-2014, 2015-2020 and 2021 candidates, about 670 trades). Each period's own validation is apply-period.mjs.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startCluster } from './cluster.mjs'
import * as P from '../../research/lib/pipeline.mjs'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const c = await startCluster()
try {
  await c.clone('bai_tpl_029', 'bai_all_opt')
  const db = await c.connect('bai_all_opt')
  for (const p of ['out-2010-2014', 'out', 'out-2021']) {
    const doc = JSON.parse(fs.readFileSync(path.join(root, '.local/retrosheet', p, 'candidates-batch.json'), 'utf8'))
    const f = path.join(os.tmpdir(), `all-${p}.json`); fs.writeFileSync(f, JSON.stringify(doc))
    const { batch } = await P.stageFile(db, f, { allowFixtures: true }); fs.rmSync(f)
    await P.validateBatch(db, batch.id)
    const r = await P.applyBatch(db, batch.id, { write: true, allowPartial: true })
    console.log(p, JSON.stringify(r.report.actions))
  }
  await db.query('analyze')
  console.log((await db.query('select count(*)::int trades from public.transactions')).rows[0])
  await db.end()
} finally { await c.stop() }
