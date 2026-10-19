// One canonical player across acquisition, development, transaction and outcome domains; value attribution without double counting.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as h from './harness.mjs'

let db
before(async () => { await h.startServer(); db = await h.freshDatabase({ fixtures: true }) }, { timeout: 120000 })
after(async () => { await h.stopServer() })

test('the same player id joins acquisition, development, transaction, outcome and value domains', async () => {
  const r = await h.one(db, `select p.id,
      (select count(*) from draft_selections where player_id = p.id)::int selections,
      (select count(*) from player_assignments where player_id = p.id)::int assignments,
      (select count(*) from development_events where player_id = p.id)::int events,
      (select count(*) from trade_package_assets where player_id = p.id)::int trade_assets,
      (select count(*) from mlb_debuts where player_id = p.id)::int debuts,
      (select count(*) from war_observations where player_id = p.id)::int war,
      (select count(*) from organization_value_attributions where acquired_player_id = p.id)::int value_rows
    from players p where slug = 'fixture-college-arm'`)
  assert.deepEqual({ ...r, id: undefined }, { id: undefined, selections: 1, assignments: 2, events: 1, trade_assets: 1, debuts: 1, war: 2, value_rows: 3 })
})

test('one organization holds acquisitions from both channels', async () => {
  const r = await h.rows(db, "select channel::text, count(*)::int n from v_acquisitions a join organizations o on o.id = a.organization_id where o.franchise_key = 'LAD' group by 1 order by 1")
  assert.deepEqual(r, [{ channel: 'DRAFT', n: 1 }, { channel: 'INTERNATIONAL', n: 1 }])
})

test('development chronology: promotions must go up, reasons require their own source', async () => {
  const p = (await h.one(db, "select id from players where slug = 'fixture-college-arm'")).id
  await h.rejects(db, "insert into development_events (player_id, organization_id, event_type, event_date, from_level, to_level, source_id) values ($1, 1, 'PROMOTED', '2023-07-01', 'MLB', 'AAA', 1)", [p], /check/)
  await h.rejects(db, "insert into development_events (player_id, organization_id, event_type, event_date, from_level, to_level, reason, source_id) values ($1, 1, 'DEMOTED', '2023-07-01', 'MLB', 'AAA', 'struggled', 1)", [p], /development_events_check/)
  const chron = await h.rows(db, 'select entry_kind, level from v_player_development_chronology where player_id = $1 order by sort_date', [p])
  assert.deepEqual(chron.map((c) => `${c.entry_kind}:${c.level}`), ['ASSIGNMENT:AA', 'ASSIGNMENT:AAA', 'PROMOTED:MLB'])
})

test('value classes stay separate; an observation is credited to an organization only once', async () => {
  const dup = await h.one(db, "select * from organization_value_attributions where value_class = 'TRADE_RETURN'")
  await h.rejects(db, `insert into organization_value_attributions (organization_id, value_class, trade_package_id, war_observation_id, source_id)
    values ($1, 'PACKAGE_ATTRIBUTABLE', $2, $3, $4)`, [dup.organization_id, dup.trade_package_id, dup.war_observation_id, dup.source_id], /value_attribution_no_double_count/)
  await h.rejects(db, `insert into organization_value_attributions (organization_id, value_class, acquired_player_id, trade_package_id, war_observation_id, source_id)
    values ($1, 'PACKAGE_ATTRIBUTABLE', 1, $2, $3, $4)`, [dup.organization_id, dup.trade_package_id, dup.war_observation_id, dup.source_id], /check/)
})

test('organization-realized value excludes value that left the organization', async () => {
  const r = await h.one(db, "select realized_war, departed_war from analytics.organization_realized_value v join organizations o on o.id = v.organization_id where o.franchise_key = 'LAD'")
  assert.deepEqual(r, { realized_war: '1.5', departed_war: '3.5' })
  const sea = await h.one(db, "select realized_war, departed_war from analytics.organization_realized_value v join organizations o on o.id = v.organization_id where o.franchise_key = 'SEA'")
  assert.deepEqual(sea, { realized_war: '3.5', departed_war: null })
})
