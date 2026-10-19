// International: date-bounded periods, distinct pathways, separate cost components (unknown != zero).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as h from './harness.mjs'

let db, src, lad
before(async () => {
  await h.startServer(); db = await h.freshDatabase({ fixtures: true })
  src = (await h.one(db, "select id from sources where source_key = 'fixture:foundation'")).id
  lad = (await h.one(db, "select id from organizations where franchise_key = 'LAD'")).id
}, { timeout: 120000 })
after(async () => { await h.stopServer() })

const newPlayer = (slug) => h.id(db, 'insert into players (slug, full_name, display_name) values ($1, $1, $1) returning id', [slug])
const period = async (key) => Number((await h.one(db, 'select id from international_signing_periods where period_key = $1', [key])).id)

test('periods are explicit date ranges that cannot overlap, including non-July calendars', async () => {
  await h.rejects(db, "insert into international_signing_periods (period_key, label, start_date, end_date, source_id) values ('2020-21', 'x', '2020-06-01', '2021-06-15', $1)", [src], /exclusion constraint/)
  await db.query("insert into international_signing_periods (period_key, label, start_date, end_date, source_id) values ('2021', 'Fixture shifted period', '2021-01-15', '2021-12-15', $1)", [src])
  assert.equal(Number((await h.one(db, "select international_period_for_date('2020-06-15') p")).p), await period('2019-20'), 'end date inclusive')
  assert.equal((await h.one(db, "select international_period_for_date('2020-06-16') p")).p, null, 'gap between periods has no period')
  assert.equal(Number((await h.one(db, "select international_period_for_date('2021-01-15') p")).p), await period('2021'))
  await h.rejects(db, "insert into international_signing_periods (period_key, label, start_date, end_date, source_id) values ('2030', 'bad', '2030-02-01', '2030-01-01', $1)", [src], /check|lower bound must be less than or equal/)
})

test('a signing dated outside its assigned period is rejected; boundary days are accepted', async () => {
  const p = await newPlayer('boundary-signee')
  const pid = await period('2019-20')
  const ins = `insert into international_signings (player_id, organization_id, signing_period_id, signing_date, signing_date_precision, pathway, source_id)
               values ($1, $2, $3, $4, 'DAY', 'INTERNATIONAL_AMATEUR', $5)`
  await h.rejects(db, ins, [p, lad, pid, '2020-06-16', src], /falls outside its signing period/)
  await h.rejects(db, ins, [p, lad, pid, '2019-07-01', src], /falls outside its signing period/)
  await db.query(ins, [p, lad, pid, '2020-06-15', src])
})

test('multiple pathways stay distinct and are not collapsed', async () => {
  const pid = await period('2019-20')
  for (const pathway of ['POSTING_SYSTEM', 'INTERNATIONAL_PROFESSIONAL', 'OTHER']) {
    const p = await newPlayer(`pathway-${pathway.toLowerCase().replace(/_/g, '-')}`)
    await db.query(`insert into international_signings (player_id, organization_id, signing_period_id, pathway, source_id) values ($1, $2, $3, $4, $5)`, [p, lad, pid, pathway, src])
  }
  const counts = await h.rows(db, 'select pathway::text, count(*)::int n from international_signings group by 1 order by 1')
  assert.deepEqual(counts.map((c) => c.pathway), ['INTERNATIONAL_AMATEUR', 'INTERNATIONAL_PROFESSIONAL', 'OTHER', 'POSTING_SYSTEM'])
  await h.rejects(db, "insert into international_signings (player_id, organization_id, signing_period_id, pathway, source_id) values (1, $1, $2, 'POSTED', $3)", [lad, pid, src], /invalid input value for enum/)
})

test('unknown cost is not zero: NULL components stay unknown and totals only sum what is known', async () => {
  const pid = await period('2019-20')
  const ins = async (slug, bonus, posting, transfer, other) => {
    const p = await newPlayer(slug)
    return h.one(db, `insert into international_signings (player_id, organization_id, signing_period_id, pathway, signing_bonus_usd, posting_fee_usd, transfer_fee_usd, other_cost_usd, source_id)
      values ($1, $2, $3, 'POSTING_SYSTEM', $4, $5, $6, $7, $8) returning known_total_cost_usd, cost_completeness`, [p, lad, pid, bonus, posting, transfer, other, src])
  }
  assert.deepEqual(await ins('cost-unknown', null, null, null, null), { known_total_cost_usd: null, cost_completeness: 'UNKNOWN' })
  assert.deepEqual(await ins('cost-partial', 5000000, null, null, null), { known_total_cost_usd: '5000000.00', cost_completeness: 'PARTIAL' })
  assert.deepEqual(await ins('cost-known-zero', 0, 0, 0, 0), { known_total_cost_usd: '0.00', cost_completeness: 'ALL_COMPONENTS_KNOWN' })
  assert.deepEqual(await ins('cost-full', 5000000, 1000000, 0, 0), { known_total_cost_usd: '6000000.00', cost_completeness: 'ALL_COMPONENTS_KNOWN' })
  const fixture = await h.one(db, "select cost_completeness from international_signings s join players p on p.id = s.player_id where p.slug = 'fixture-amateur-signee'")
  assert.equal(fixture.cost_completeness, 'PARTIAL', 'other_cost unknown keeps the fixture partial even with bonus known')
  await h.rejects(db, 'update international_signings set signing_bonus_usd = -1 where id = (select min(id) from international_signings)', [], /check/)
})

test('organization signing-period context is one row per club and period', async () => {
  const pid = await period('2019-20')
  await db.query("insert into organization_signing_period_context (organization_id, signing_period_id, base_pool_usd, source_id) values ($1, $2, 5000000, $3)", [lad, pid, src])
  await h.rejects(db, "insert into organization_signing_period_context (organization_id, signing_period_id, source_id) values ($1, $2, $3)", [lad, pid, src], /duplicate key/)
  await h.rejects(db, "update organization_signing_period_context set restriction_cap_usd = 300000 where organization_id = $1", [lad], /check/)
})

test('trainer and academy relationships require a source and a verification level', async () => {
  const t = await h.id(db, "insert into trainers (slug, name, source_id) values ('fixture-trainer', 'Fixture Trainer', $1) returning id", [src])
  const p = (await h.one(db, "select id from players where slug = 'fixture-amateur-signee'")).id
  await h.rejects(db, 'insert into player_trainer_relationships (player_id, trainer_id, verification) values ($1, $2, \'VERIFIED\')', [p, t], /source_id/)
  await db.query("insert into player_trainer_relationships (player_id, trainer_id, verification, at_signing, source_id) values ($1, $2, 'REPORTED', true, $3)", [p, t, src])
})
