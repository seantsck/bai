// Draft: player / draft / selection / signing separation, repeat selections and unsigned picks.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as h from './harness.mjs'

let db
before(async () => { await h.startServer(); db = await h.freshDatabase({ fixtures: true }) }, { timeout: 120000 })
after(async () => { await h.stopServer() })

test('a player drafted twice has two selections in different drafts, each with its own signing status', async () => {
  const picks = await h.rows(db, `select draft_year, organization_id, signing_status from v_draft_picks p join players pl on pl.id = p.player_id
    where pl.slug = 'fixture-two-time-draftee' order by draft_year`)
  assert.equal(picks.length, 2)
  assert.deepEqual(picks.map((p) => [p.draft_year, p.signing_status]), [[2018, 'DID_NOT_SIGN'], [2021, 'SIGNED']])
  assert.notEqual(picks[0].organization_id, picks[1].organization_id)
})

test('a player cannot be selected twice in the same draft, and a pick number is used once', async () => {
  const s = await h.one(db, "select * from draft_selections where overall_pick = 25")
  await h.rejects(db, `insert into draft_selections (draft_id, round_id, overall_pick, organization_id, player_id, source_id)
    values ($1, $2, 26, $3, $4, $5)`, [s.draft_id, s.round_id, s.organization_id, s.player_id, s.source_id], /draft_selections_draft_id_player_id_key/)
  const other = await h.one(db, "select id from players where slug = 'fixture-trade-return'")
  await h.rejects(db, `insert into draft_selections (draft_id, round_id, overall_pick, organization_id, player_id, source_id)
    values ($1, $2, 25, $3, $4, $5)`, [s.draft_id, s.round_id, s.organization_id, other.id, s.source_id], /draft_selections_draft_id_overall_pick_key/)
})

test('unsigned picks remain valid selections; DID_NOT_SIGN carries no bonus or date', async () => {
  const unsigned = await h.one(db, "select * from v_draft_picks where signing_status = 'DID_NOT_SIGN'")
  assert.ok(unsigned.draft_selection_id)
  assert.equal(unsigned.signing_bonus_usd, null)
  const sel = await h.one(db, "select id, source_id from draft_selections where overall_pick = 50")
  await h.rejects(db, "update draft_signings set signing_status = 'DID_NOT_SIGN' where draft_selection_id = $1", [sel.id], /draft_signings_check1/)
})

test('a selection with no signing research is UNKNOWN, not unsigned', async () => {
  const d = await h.one(db, "select id from drafts where draft_key = '2019-JUNE_AMATEUR'")
  const r = await h.id(db, "insert into draft_rounds (draft_id, round_code, round_order, phase) values ($1, 'CB-A', 2, 'COMPETITIVE_BALANCE_A') returning id", [d.id])
  const p = await h.id(db, "insert into players (slug, full_name, display_name) values ('cb-pick', 'CB Pick', 'CB Pick') returning id")
  await db.query(`insert into draft_selections (draft_id, round_id, overall_pick, round_pick, organization_id, selection_type, player_id, source_id)
    values ($1, $2, 35, 1, (select id from organizations where franchise_key = 'TB'), 'COMPETITIVE_BALANCE', $3, 1)`, [d.id, r, p])
  const pick = await h.one(db, 'select signing_status, phase from v_draft_picks where player_id = $1', [p])
  assert.deepEqual(pick, { signing_status: 'UNKNOWN', phase: 'COMPETITIVE_BALANCE_A' })
})

test('draft structure is per draft: a round must belong to the selection\'s draft', async () => {
  const d2018 = await h.one(db, "select id from drafts where draft_key = '2018-JUNE_AMATEUR'")
  const r2019 = await h.one(db, "select r.id from draft_rounds r join drafts d on d.id = r.draft_id where d.draft_key = '2019-JUNE_AMATEUR' and round_code = '1'")
  const p = await h.id(db, "insert into players (slug, full_name, display_name) values ('wrong-round', 'Wrong Round', 'Wrong Round') returning id")
  await h.rejects(db, `insert into draft_selections (draft_id, round_id, overall_pick, organization_id, player_id, source_id)
    values ($1, $2, 999, 1, $3, 1)`, [d2018.id, r2019.id, p], /draft_selections_round_id_draft_id_fkey/)
  // historical drafts with other kinds coexist with the June draft of the same year
  await db.query("insert into drafts (draft_key, draft_year, draft_kind, start_date, source_id) values ('2018-JANUARY_REGULAR', 2018, 'JANUARY_REGULAR', '2018-01-10', 1)")
})

test('pick view joins slot value and school type', async () => {
  const pick = await h.one(db, 'select slot_value_usd, school_type, signing_bonus_usd from v_draft_picks where overall_pick = 25')
  assert.deepEqual(pick, { slot_value_usd: '2500000.00', school_type: 'COLLEGE', signing_bonus_usd: '2400000.00' })
})
