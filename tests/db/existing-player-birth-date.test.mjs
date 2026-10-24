// Issue #25: linking an EXISTING player whose birth date is unknown writes birth_date and birth_date_precision together
// (players_check requires both or neither). FICTIONAL players and sources only.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as h from './harness.mjs'
import * as P from '../../scripts/research/lib/pipeline.mjs'

let db
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-birthdate-'))
before(async () => { await h.startServer(); db = await h.freshDatabase() }, { timeout: 120000 })
after(async () => { await h.stopServer(); fs.rmSync(dir, { recursive: true, force: true }) })

const SRC = { source_key: 'test:birthdate', source_type: 'TEST_FIXTURE', authority_level: 'OFFICIAL', title: 'Test source birth date' }
let n = 0
const run = async (records, { write = true } = {}) => {
  const f = path.join(dir, `b${++n}.json`)
  fs.writeFileSync(f, JSON.stringify({ format: 'bai-research-import/1', batch_key: `test-birthdate-${n}`, channel: 'DRAFT', sources: [SRC], records }))
  const { batch } = await P.stageFile(db, f)
  assert.equal((await P.validateBatch(db, batch.id)).ok, true)
  return P.applyBatch(db, batch.id, { write })
}
const pick = (overall, name, mlbam, birth) => ({ type: 'DRAFT_SELECTION', source_key: SRC.source_key, draft_key: '2017-JUNE_AMATEUR', round_code: '3', overall_pick: overall, round_pick: overall - 70, organization: 'SEA',
  player: { full_name: name, ...(birth ? { birth_date: birth } : {}), external_ids: { MLBAM: mlbam } }, signing: { status: 'UNKNOWN' } })
const existing = async (slug, mlbam, birth) => {
  const { rows: [p] } = await db.query(`insert into players (slug, full_name, display_name, birth_date, birth_date_precision) values ($1, $2, $2, $3, $4) returning id`, [slug, slug, birth, birth ? 'DAY' : null])
  await db.query(`insert into player_external_ids (player_id, id_system, external_id) values ($1, 'MLBAM', $2)`, [p.id, mlbam])
  return p.id
}
const row = (id) => h.one(db, 'select birth_date::text d, birth_date_precision p, updated_at::text u from players where id = $1', [id])
const obs = (id, field = 'birth_date') => h.rows(db, `select o.observed_value v, s.source_key from source_observations o join sources s on s.id = o.source_id where o.subject_table = 'players' and o.subject_id = $1 and o.field_name = $2 order by o.id`, [id, field])
const total = async (sql) => Number((await h.one(db, sql)).n)

test('an existing player with an unknown birth date receives the date and DAY precision together', async () => {
  const id = await existing('fixture-null-birth', '9910001', null)
  const players = await total('select count(*) n from players')
  const out = await run([pick(171, 'Fixture Null Birth', '9910001', '1998-02-03')])
  assert.equal(out.results[0].action, 'INSERT')
  assert.deepEqual(await row(id), { d: '1998-02-03', p: 'DAY', u: (await row(id)).u })
  assert.equal(await total('select count(*) n from players'), players, 'no duplicate player')
  assert.deepEqual((await obs(id)).map((o) => [o.v, o.source_key]), [['1998-02-03', SRC.source_key]], 'provenance: the value is cited to its source')
  assert.equal(await total(`select count(*) n from draft_selections s where s.overall_pick = 171 and s.player_id = ${id}`), 1)
  assert.equal(await total(`select count(*) n from players where birth_date is not null and birth_date_precision is null`), 0)
})

test('an identical birth date leaves the canonical row alone and only corroborates', async () => {
  const id = await existing('fixture-same-birth', '9910002', '1997-05-06')
  const before = await row(id)
  const out = await run([pick(172, 'Fixture Same Birth', '9910002', '1997-05-06')])
  assert.equal(out.conflicts.length, 0)
  assert.deepEqual(await row(id), before)
  assert.equal((await obs(id)).length, 1, 'one corroborating observation from the new source')
})

test('conflicting birth dates keep the canonical value and use the existing conflict workflow', async () => {
  const id = await existing('fixture-conflict-birth', '9910003', '1996-01-01')
  const out = await run([pick(173, 'Fixture Conflict Birth', '9910003', '1996-01-02')])
  assert.equal(out.conflicts.length, 1)
  assert.equal(out.conflicts[0].field, 'birth_date')
  const r = await row(id)
  assert.deepEqual([r.d, r.p], ['1996-01-01', 'DAY'])
  assert.equal((await obs(id)).length, 1, 'the disagreeing statement is kept as an observation, never as the canonical value')
  // A second source disagreeing with an UNKNOWN canonical value is still a conflict, and still writes nothing to the player.
  const id2 = await existing('fixture-rival-birth', '9910004', null)
  await db.query(`insert into sources (source_key, source_type, authority_level, title) values ('test:rival', 'TEST_FIXTURE', 'OTHER', 'Rival')`)
  await db.query(`insert into source_observations (source_id, subject_table, subject_id, field_name, observed_value, observed_on) values ((select id from sources where source_key = 'test:rival'), 'players', $1, 'birth_date', '"1995-09-09"'::jsonb, current_date)`, [id2])
  const out2 = await run([pick(174, 'Fixture Rival Birth', '9910004', '1995-09-10')])
  assert.equal(out2.conflicts.length, 1)
  assert.deepEqual(await row(id2), { d: null, p: null, u: (await row(id2)).u })
})

test('a missing incoming birth date changes nothing on the player', async () => {
  const id = await existing('fixture-no-incoming', '9910005', null)
  await run([pick(175, 'Fixture No Incoming', '9910005', null)])
  const r = await row(id)
  assert.deepEqual([r.d, r.p], [null, null])
  assert.equal((await obs(id)).length, 0)
  assert.equal(await total(`select count(*) n from draft_selections where overall_pick = 175 and player_id = ${id}`), 1)
})

test('other reconciled fields are unaffected: a selection field and birth country still update through the generic path', async () => {
  const id = await existing('fixture-country', '9910006', null)
  await db.query('update players set birth_country = null where id = $1', [id])
  await run([{ ...pick(176, 'Fixture Country', '9910006', '1999-12-12'), player: { full_name: 'Fixture Country', birth_date: '1999-12-12', birth_country: 'USA', external_ids: { MLBAM: '9910006' } } }])
  const r = await h.one(db, 'select birth_date::text d, birth_date_precision p, birth_country c from players where id = $1', [id])
  assert.deepEqual(r, { d: '1999-12-12', p: 'DAY', c: 'USA' })
})
