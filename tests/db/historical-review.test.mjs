// Migration 025: public source attribution, the historical publication lock, and the private exception-review workflow.
// Every source, player, id and claim here is FICTIONAL fixture data.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as h from './harness.mjs'
import * as B from '../../scripts/research/lib/backfill.mjs'

let db // owner session (what automation holds)
let rv // a human reviewer's own login
let bot // an automation login
before(async () => {
  await h.startServer(); db = await h.freshDatabase()
  rv = await h.login(db, 'rev_login', { reviewer: true })
  await B.enrollReviewer(rv, { reviewer: 'Robin Reviewer' })
  bot = await h.login(db, 'review_bot', { automation: true, grants: ['grant usage on schema research to $ROLE', 'grant select, insert, update on all tables in schema research to $ROLE', 'alter role $ROLE bypassrls'] })
}, { timeout: 120000 })
after(async () => { await h.stopServer() })

const addSource = async (key, type, { url = null, publisher = null, title = `Fixture ${key}` } = {}) =>
  (await h.one(db, `insert into sources (source_key, source_type, authority_level, title, publisher, url, reference) values ($1, $2, 'OTHER', $3, $4, $5, $6) returning id, attribution_category`,
    [key, type, title, publisher, url, url ? null : 'fixture reference']))

test('attribution: each source is grouped by origin; the public summary and explorer show the groups', async () => {
  const cases = [
    ['fx:mlb-api', 'OFFICIAL_LEAGUE', { url: 'https://statsapi.mlb.com/api/v1/draft/2019' }, 'MLB'],
    ['fx:mlb-wire', 'OFFICIAL_LEAGUE', { publisher: 'MLB Advanced Media' }, 'MLB'],
    ['fx:mlbcom-archive', 'NEWS_REPORT', { url: 'https://web.archive.org/web/2019/https://www.mlb.com/news/x' }, 'MLB'],
    ['fx:bref', 'REFERENCE_DATABASE', { url: 'https://www.baseball-reference.com/draft/x' }, 'BASEBALL_REFERENCE'],
    ['fx:bref-archive', 'REFERENCE_DATABASE', { url: 'https://web.archive.org/web/2019id_/https://www.baseball-reference.com/x' }, 'BASEBALL_REFERENCE'],
    ['fx:chadwick', 'REFERENCE_DATABASE', { url: 'https://github.com/chadwickbureau/register/tree/abc', publisher: 'Chadwick Baseball Bureau' }, 'CHADWICK_REGISTER'],
    ['fx:wiki', 'REFERENCE_DATABASE', { url: 'https://en.wikipedia.org/w/index.php?oldid=1', title: '2019 Major League Baseball draft', publisher: 'Wikipedia' }, 'WIKIPEDIA'],
    ['bai-reference:fx', 'BAI_REFERENCE', { url: 'https://github.com/seantsck/bai' }, 'BAI_RESEARCH'],
    ['bai-reference:fx-mlb', 'BAI_REFERENCE', { url: 'https://www.mlb.com/history' }, 'MLB'],   // 027: a BAI compilation citing a league page is judged by that page
    ['fx:news', 'NEWS_REPORT', { url: 'https://www.mlbtraderumors.com/x' }, 'OTHER_PUBLICATION'],
    ['fx:ba', 'PUBLICATION_RANKING', { url: 'https://www.baseballamerica.com/x' }, 'OTHER_PUBLICATION']
  ]
  for (const [key, type, opts, want] of cases) assert.equal((await addSource(key, type, opts)).attribution_category, want, key)
  // A selection and signing cite sources; the public summary counts them; the explorer shows each record's group.
  // The 2019 draft comes from the reference calendar (015).
  await db.query(`insert into draft_rounds (draft_id, round_code, round_order, phase) select id, '1', 10, 'REGULAR' from drafts where draft_key = '2019-JUNE_AMATEUR' on conflict do nothing`)
  await db.query(`insert into players (slug, full_name, display_name) values ('fixture-attribution', 'Fixture Attribution', 'Fixture Attribution')`)
  const sel = await h.one(db, `insert into draft_selections (draft_id, round_id, overall_pick, round_pick, organization_id, player_id, source_id)
    select d.id, r.id, 1, 1, (select id from organizations where franchise_key = 'KC'), (select id from players where slug = 'fixture-attribution'), (select id from sources where source_key = 'fx:mlb-api')
    from drafts d join draft_rounds r on r.draft_id = d.id and r.round_code = '1' where d.draft_key = '2019-JUNE_AMATEUR' returning id`)
  await db.query(`insert into draft_signings (draft_selection_id, signing_status, signing_bonus_usd, source_id) values ($1, 'SIGNED', 100000, (select id from sources where source_key = 'fx:bref'))`, [sel.id])
  await h.asRole(db, 'anon', async () => {
    const rows = await h.rows(db, `select attribution_category, domain, records, sources from v_source_attribution order by 1, 2`)
    const draft = Object.fromEntries(rows.filter((r) => r.domain === 'DRAFT').map((r) => [r.attribution_category, r.records]))
    assert.equal(draft.BASEBALL_REFERENCE, 1)   // the signing
    assert.ok(draft.MLB >= 1)                    // the selection (plus the reference calendar's drafts and slot values)
    assert.equal(rows.some((r) => r.attribution_category === 'TEST_FIXTURE'), false)
    const ex = await h.one(db, `select a.selection_source_category, a.signing_source_category from v_selection_attribution a join v_draft_explorer x on x.selection_id = a.selection_id where x.draft_key = '2019-JUNE_AMATEUR'`)
    assert.deepEqual(ex, { selection_source_category: 'MLB', signing_source_category: 'BASEBALL_REFERENCE' })
  })
})

// Internal until the transaction detail view (docs/transactions/phase16-foundation.md): the public summary cannot read them, so it does not count them yet.
// 030 closed `transactions` to the public roles: the summary counts the transactions the read model publishes (rm_transaction_sources) instead.
const EXCLUDED = ['coverage_assessments', 'fact_resolutions', 'ptbnl_resolutions', 'season_calendar_events', 'transaction_external_ids', 'transaction_sources', 'transactions']
test('attribution summary covers every public table that cites a source', async () => {
  const def = (await h.one(db, `select pg_get_viewdef('public.v_source_attribution'::regclass) as d`)).d
  const tables = (await h.rows(db, `select c.table_name from information_schema.columns c join information_schema.tables t using (table_schema, table_name)
    where c.table_schema = 'public' and c.column_name = 'source_id' and t.table_type = 'BASE TABLE' order by 1`)).map((r) => r.table_name)
  const missing = tables.filter((t) => !new RegExp(`\\b${t}\\b`).test(def) && !EXCLUDED.includes(t))
  assert.deepEqual(missing, [], 'add the table to v_source_attribution (or list why it is excluded here)')
})

test('historical lock: a selection in a year before 2015 needs that year released on the database', async () => {
  await db.query(`insert into drafts (draft_key, draft_year, draft_kind, start_date, total_rounds, source_id) values ('1990-JUNE_AMATEUR', 1990, 'JUNE_AMATEUR', '1990-06-04', 60, (select id from sources where source_key = 'fx:wiki'))`)
  await db.query(`insert into draft_rounds (draft_id, round_code, round_order, phase) select id, '1', 10, 'REGULAR' from drafts where draft_key = '1990-JUNE_AMATEUR'`)
  await db.query(`insert into players (slug, full_name, display_name) values ('fixture-historical', 'Fixture Historical', 'Fixture Historical')`)
  const insert = () => db.query(`insert into draft_selections (draft_id, round_id, overall_pick, round_pick, organization_id, player_id, source_id)
    select d.id, r.id, 2, 2, (select id from organizations where franchise_key = 'KC'), (select id from players where slug = 'fixture-historical'), (select id from sources where source_key = 'fx:mlb-api')
    from drafts d join draft_rounds r on r.draft_id = d.id where d.draft_key = '1990-JUNE_AMATEUR' returning id`)
  await assert.rejects(insert(), /draft year 1990 is historical and has not been released/)
  // Moving an existing modern selection into a historical draft is refused too.
  await assert.rejects(db.query(`update draft_selections set draft_id = (select id from drafts where draft_key = '1990-JUNE_AMATEUR') where id = (select id from draft_selections where player_id = (select id from players where slug = 'fixture-attribution'))`), /has not been released/)
  await assert.rejects(db.query(`insert into ingest.historical_releases (draft_year, authorization_reference, scope_note) values (2016, 'x', 'y')`), /check/, 'only historical years are released')
  await db.query(`insert into ingest.historical_releases (draft_year, authorization_reference, scope_note) values (1990, 'FIXTURE-AUTH-1', 'fixture release')`)
  assert.ok((await insert()).rows[0].id)
  assert.equal((await h.one(db, `select released_by from ingest.historical_releases where draft_year = 1990`)).released_by, 'postgres')
  await h.asRole(db, 'anon', () => assert.rejects(db.query('select * from ingest.historical_releases'), /permission denied/))
})

test('publication guard (hosted only): existing records stay readable; new MLB and Baseball-Reference records are refused without a recorded basis', async () => {
  // Players carry no source_id; each pick gets its own fictional player.
  const newPick = async (pick, sourceKey) => {
    await db.query(`insert into players (slug, full_name, display_name) values ($1, $2, $2) on conflict do nothing`, [`fixture-guard-${pick}`, `Fixture Guard ${pick}`])
    return db.query(`insert into draft_selections (draft_id, round_id, overall_pick, round_pick, organization_id, player_id, source_id)
      select d.id, r.id, $1, $1, (select id from organizations where franchise_key = 'KC'), (select id from players where slug = $3), (select id from sources where source_key = $2)
      from drafts d join draft_rounds r on r.draft_id = d.id and r.round_code = '1' where d.draft_key = '2019-JUNE_AMATEUR' returning id`, [pick, sourceKey, `fixture-guard-${pick}`])
  }
  // A local research database is not guarded.
  const local = (await newPick(3, 'fx:mlb-api')).rows[0].id
  await db.query('create role supabase_admin nologin')   // what makes a database a Supabase (hosted) one
  try {
    // Existing MLB- and Baseball-Reference-sourced records: readable by the public site, and editable without changing their source.
    await h.asRole(db, 'anon', async () => {
      const r = await h.rows(db, `select a.selection_source_category, a.signing_source_category from v_selection_attribution a where a.selection_id in (select id from draft_selections where player_id in (select id from players where slug like 'fixture-%'))`)
      assert.ok(r.some((x) => x.selection_source_category === 'MLB' && x.signing_source_category === 'BASEBALL_REFERENCE'))
    })
    await db.query(`update draft_selections set position = 'RHP' where id = $1`, [local])
    // New records citing them are refused, by insert or by repointing a record's source.
    await assert.rejects(newPick(4, 'fx:mlb-api'), /a new MLB record cannot be published on this database without a recorded permission basis/)
    await assert.rejects(newPick(5, 'fx:mlbcom-archive'), /new MLB record/)
    await assert.rejects(db.query(`insert into draft_signings (draft_selection_id, signing_status, signing_bonus_usd, source_id) values ($1, 'SIGNED', 1000, (select id from sources where source_key = 'fx:bref'))`, [local]), /new BASEBALL_REFERENCE record/)
    await assert.rejects(db.query(`insert into source_observations (source_id, subject_table, subject_id, field_name, observed_value) values ((select id from sources where source_key = 'fx:bref'), 'draft_selections', $1, 'position', '"LHP"')`, [local]), /new BASEBALL_REFERENCE record/)
    await assert.rejects(newPick(6, 'fx:news'), /new OTHER_PUBLICATION record/)
    const wiki = (await newPick(7, 'fx:wiki')).rows[0].id
    await assert.rejects(db.query(`update draft_selections set source_id = (select id from sources where source_key = 'fx:mlb-api') where id = $1`, [wiki]), /new MLB record/)
    // Openly licensed and BAI's own sources need no grant; a recorded basis (a person's assertion, not verified) opens a group.
    assert.ok((await newPick(8, 'fx:chadwick')).rows[0].id)
    assert.ok((await newPick(9, 'bai-reference:fx')).rows[0].id)
    await db.query(`insert into ingest.source_publication_grants (attribution_category, basis_reference, scope_note) values ('MLB', 'FIXTURE-AUTH-MLB', 'fixture authorization')`)
    assert.ok((await newPick(10, 'fx:mlb-api')).rows[0].id)
    await h.asRole(db, 'anon', () => assert.rejects(db.query('select * from ingest.source_publication_grants'), /permission denied/))
    await db.query(`delete from ingest.source_publication_grants`)
    // 026: a no-op upsert of an existing restricted-source record (re-running a reference seed) is not a new publication,
    // and setting a record's source to the same value is not a change; a real insert through an upsert still is.
    const existing = await h.one(db, `select id, draft_id, round_id, overall_pick, round_pick, organization_id, player_id, source_id from draft_selections where id = $1`, [local])
    const upsert = (pick, player) => db.query(`insert into draft_selections (draft_id, round_id, overall_pick, round_pick, organization_id, player_id, source_id) values ($1, $2, $3, $3, $4, $5, $6)
      on conflict (draft_id, player_id) do update set source_id = excluded.source_id`, [existing.draft_id, existing.round_id, pick, existing.organization_id, player, existing.source_id])
    await upsert(existing.overall_pick, existing.player_id)
    await db.query(`update draft_selections set source_id = source_id where id = $1`, [local])
    await db.query(`insert into players (slug, full_name, display_name) values ('fixture-guard-upsert', 'Fixture Guard Upsert', 'Fixture Guard Upsert')`)
    await assert.rejects(upsert(11, (await h.one(db, `select id from players where slug = 'fixture-guard-upsert'`)).id), /new MLB record/)
  } finally {
    await db.query('drop role supabase_admin')
    await db.query(`delete from ingest.source_publication_grants`)
  }
})

async function loadFixtureException (key, kind) {
  const e = await h.one(db, `insert into research.history_exceptions (exception_key, draft_year, phase, franchise_key, kind, summary, effect, resolution_needs, register_sha256, loaded_by)
    values ($1, 1990, 'JR', 'KC', $2, 'Fixture: source A lists Fixture Able at #12, source B lists Fixture Baker', 'Class partial.', 'A third source.', $3, 'fixture-loader') returning id, status`, [key, kind, 'a'.repeat(64)])
  await db.query(`insert into research.history_exception_claims (exception_id, ordinal, source_catalog_id, claim, evidence) values ($1, 1, 'fixture-a', '"Fixture Able at #12"', '[{"cache_key":"fx/a.json","sha256":"00"}]'),
    ($1, 2, 'fixture-b', '"Fixture Baker at #12"', '[]')`, [e.id])
  return e
}

test('exception review: claims are immutable, anyone proposes, only a reviewer session decides, and history is kept', async () => {
  const e = await loadFixtureException('EX-1990-JR-KC-LIST', 'DIFFERENT_PLAYER_SAME_PICK')
  assert.equal(e.status, 'OPEN')
  await assert.rejects(db.query(`update research.history_exception_claims set claim = '"changed"' where exception_id = $1`, [e.id]), /append-only/)
  await assert.rejects(db.query(`update research.history_exceptions set summary = 'changed' where id = $1`, [e.id]), /immutable/)
  await assert.rejects(db.query(`update research.history_exceptions set status = 'DECIDED' where id = $1`, [e.id]), /only through a proposal or a reviewer decision/)
  await assert.rejects(db.query(`delete from research.history_exceptions where id = $1`, [e.id]), /never deleted/)
  // Proposals: a conclusion must belong to the kind; an agent may propose; one open proposal at a time.
  await assert.rejects(db.query(`insert into research.history_exception_proposals (exception_id, conclusion, rationale, proposed_by) values ($1, 'SAME_PERSON', 'x', 'agent:scout')`, [e.id]), /not one of the conclusions/)
  const p1 = await h.one(bot, `insert into research.history_exception_proposals (exception_id, conclusion, rationale, proposed_by) values ($1, 'SECOND_SOURCE_CORRECT', 'Fixture: source B matches the club release.', 'agent:scout') returning id, proposed_session_role`, [e.id])
  assert.equal(p1.proposed_session_role, 'review_bot')
  assert.equal((await h.one(db, `select status from research.history_exceptions where id = $1`, [e.id])).status, 'PROPOSED')
  await assert.rejects(db.query(`update research.history_exception_proposals set status = 'ACCEPTED' where id = $1`, [p1.id]), /only through withdrawal or a reviewer decision/)
  await assert.rejects(db.query(`update research.history_exception_proposals set rationale = 'edited' where id = $1`, [p1.id]), /immutable/)
  // Deciding: not the owner, not an agent, not a direct insert; only the reviewer's own session.
  await assert.rejects(db.query(`select research.decide_history_exception('EX-1990-JR-KC-LIST', 'ACCEPT_PROPOSAL', 'owner tries', null, $1)`, [p1.id]), /reviewer/)
  await assert.rejects(bot.query(`select research.decide_history_exception('EX-1990-JR-KC-LIST', 'ACCEPT_PROPOSAL', 'bot tries', null, $1)`, [p1.id]), /permission denied for function/)
  await assert.rejects(db.query(`insert into research.history_exception_decisions (exception_id, decision, conclusion, rationale, decided_by) values ($1, 'DECIDE', 'FIRST_SOURCE_CORRECT', 'direct', 'Robin Reviewer')`, [e.id]), /only an enrolled human reviewer/)
  await assert.rejects(rv.query(`select research.decide_history_exception('EX-1990-JR-KC-LIST', 'DECIDE', 'not a conclusion of this kind', 'SAME_PERSON')`), /not one of the conclusions/)
  const before = await h.one(db, 'select (select count(*) from draft_selections)::int sel, (select count(*) from players)::int pl, (select count(*) from source_observations)::int obs')
  const d = await h.one(rv, `select * from research.decide_history_exception('EX-1990-JR-KC-LIST', 'NEEDS_MORE_EVIDENCE', 'Want the club media guide first.')`)
  assert.equal(d.decided_by, 'Robin Reviewer'); assert.equal(d.decided_session_role, 'rev_login')
  assert.equal((await h.one(db, `select status from research.history_exceptions where id = $1`, [e.id])).status, 'NEEDS_EVIDENCE')
  const d2 = await h.one(rv, `select * from research.decide_history_exception('EX-1990-JR-KC-LIST', 'ACCEPT_PROPOSAL', 'Media guide agrees with source B.', null, $1, '[{"locator":"fixture media guide p. 12"}]')`, [p1.id])
  assert.equal(d2.conclusion, 'SECOND_SOURCE_CORRECT')
  assert.deepEqual(await h.one(db, `select e.status, p.status as proposal from research.history_exceptions e join research.history_exception_proposals p on p.exception_id = e.id where e.id = $1`, [e.id]), { status: 'DECIDED', proposal: 'ACCEPTED' })
  await assert.rejects(rv.query(`select research.decide_history_exception('EX-1990-JR-KC-LIST', 'DECIDE', 'again', 'UNDETERMINED')`), /reopen it first/)
  await assert.rejects(db.query(`update research.history_exception_decisions set rationale = 'x' where id = $1`, [d2.id]), /append-only/)
  // A decision is a judgment only: no canonical fact changed, and certification stays off.
  assert.deepEqual(await h.one(db, 'select (select count(*) from draft_selections)::int sel, (select count(*) from players)::int pl, (select count(*) from source_observations)::int obs'), before)
  assert.equal((await h.one(db, 'select research.certification_enabled() as on')).on, false)
  // Reopen, then the full history.
  await h.one(rv, `select * from research.decide_history_exception('EX-1990-JR-KC-LIST', 'REOPEN', 'New evidence surfaced.')`)
  const events = await h.rows(db, `select event, actor, detail->>'decision' as decision from research.history_exception_events where exception_id = $1 order by id`, [e.id])
  assert.deepEqual(events.map((x) => [x.event, x.actor, x.decision]), [['LOADED', 'fixture-loader', null], ['PROPOSED', 'agent:scout', null], ['DECIDED', 'Robin Reviewer', 'NEEDS_MORE_EVIDENCE'],
    ['DECIDED', 'Robin Reviewer', 'ACCEPT_PROPOSAL'], ['DECIDED', 'Robin Reviewer', 'REOPEN']])
  await assert.rejects(db.query(`delete from research.history_exception_events where exception_id = $1`, [e.id]), /append-only/)
})

test('exception review: every kind has conclusions; withdrawal is the proposer\'s; private and local-only', async () => {
  const kinds = (await h.rows(db, `select unnest(enum_range(null::research.history_exception_kind))::text k`)).map((r) => r.k)
  assert.deepEqual(kinds, ['CONFLICTING_IDENTITY', 'MISSING_SELECTION', 'DIFFERENT_PLAYER_SAME_PICK', 'SAME_PERSON_MULTIPLE_SELECTIONS', 'ALTERNATE_NAME', 'NUMBERING_DISAGREEMENT', 'CROSSWALK_UNMATCHED', 'CENSUS_TOTAL_DISAGREEMENT'])
  for (const k of kinds) assert.ok((await h.one(db, `select count(*)::int n from research.history_exception_conclusions where kind = $1`, [k])).n >= 3, k)
  const e = await loadFixtureException('EX-1990-JR-KC-IDENTITY', 'CONFLICTING_IDENTITY')
  const p = await h.one(db, `insert into research.history_exception_proposals (exception_id, conclusion, rationale, proposed_by) values ($1, 'DIFFERENT_PEOPLE', 'Different birth years.', 'agent:scout') returning id`, [e.id])
  await assert.rejects(db.query(`select research.withdraw_history_exception_proposal($1, 'agent:other', 'not mine')`, [p.id]), /only the proposer/)
  await db.query(`select research.withdraw_history_exception_proposal($1, 'agent:scout', 'superseded')`, [p.id])
  assert.equal((await h.one(db, `select status from research.history_exceptions where id = $1`, [e.id])).status, 'OPEN')
  for (const t of ['history_exceptions', 'history_exception_claims', 'history_exception_proposals', 'history_exception_decisions', 'history_exception_events']) {
    await h.asRole(db, 'anon', () => assert.rejects(db.query(`select * from research.${t}`), /permission denied/, t))
  }
  // On a Supabase (hosted) database the restricted evidence is refused outright.
  await db.query('create role supabase_admin nologin')
  try {
    await assert.rejects(loadFixtureException('EX-1990-JR-KC-HOSTED', 'MISSING_SELECTION'), /restricted and stays in local research databases/)
  } finally { await db.query('drop role supabase_admin') }
})
