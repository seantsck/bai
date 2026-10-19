// Provenance requirements and acquisition-time expectation discipline (no hindsight).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as h from './harness.mjs'

let db, src
before(async () => {
  await h.startServer(); db = await h.freshDatabase({ fixtures: true })
  src = (await h.one(db, "select id from sources where source_key = 'fixture:foundation'")).id
}, { timeout: 120000 })
after(async () => { await h.stopServer() })

test('every registered researched-fact table has a NOT NULL source_id referencing sources', async () => {
  const r = await h.rows(db, `select f.table_name, c.is_nullable,
      exists (select 1 from information_schema.referential_constraints rc
              join information_schema.key_column_usage k on k.constraint_name = rc.constraint_name and k.table_name = f.table_name and k.column_name = 'source_id'
              join information_schema.constraint_column_usage u on u.constraint_name = rc.unique_constraint_name and u.table_name = 'sources') as fk
    from provenance_fact_tables f left join information_schema.columns c on c.table_schema = 'public' and c.table_name = f.table_name and c.column_name = 'source_id'
    where f.primary_source_required`)
  assert.ok(r.length >= 20, `registry lists ${r.length} tables`)
  for (const t of r) {
    assert.equal(t.is_nullable, 'NO', `${t.table_name}.source_id must be NOT NULL`)
    assert.ok(t.fk, `${t.table_name}.source_id must reference sources`)
  }
})

test('a researched fact without a source is rejected; sources must be public', async () => {
  await h.rejects(db, "insert into mlb_debuts (player_id, debut_date, debut_organization_id) values (1, '2024-04-01', 1)", [], /source_id/)
  await h.rejects(db, "insert into sources (source_key, source_type, title, url, publicly_accessible) values ('private:x', 'OTHER', 'Private', 'https://example.org/private', false)", [], /sources_publicly_accessible_check/)
})

test('source observations keep conflicting values side by side and expose conflicts', async () => {
  const sel = (await h.one(db, 'select id from draft_selections where overall_pick = 25')).id
  const other = await h.id(db, "insert into sources (source_key, source_type, title) values ('fixture:second', 'TEST_FIXTURE', 'Second fixture source') returning id")
  await db.query("insert into source_observations (source_id, subject_table, subject_id, field_name, observed_value) values ($1, 'draft_selections', $2, 'position', '\"RHP\"'), ($3, 'draft_selections', $2, 'position', '\"OF\"')", [src, sel, other])
  const c = await h.one(db, "select distinct_values from v_source_conflicts where subject_table = 'draft_selections' and subject_id = $1", [sel])
  assert.equal(Number(c.distinct_values), 2)
  await h.rejects(db, "insert into source_observations (source_id, subject_table, subject_id, field_name) values ($1, 'not_a_fact_table', 1, 'x')", [src], /foreign key/)
})

test('expectation links must precede the acquisition (strictly), match the player and the channel', async () => {
  const arm = (await h.one(db, "select id from players where slug = 'fixture-college-arm'")).id
  const sel = (await h.one(db, 'select id from draft_selections where player_id = $1', [arm])).id
  const mk = async (name, date, domain = 'DRAFT') => {
    const l = await h.id(db, "insert into ranking_lists (source_id, domain, list_kind, list_name, published_date) values ($1, $2, 'PUBLICATION_RANKING', $3, $4) returning id", [src, domain, name, date])
    return h.id(db, 'insert into ranking_entries (ranking_list_id, player_id, rank) values ($1, $2, 5) returning id', [l, arm])
  }
  const postDraft = await mk('Post-draft list', '2019-07-01')
  await h.rejects(db, 'insert into acquisition_expectation_links (draft_selection_id, ranking_entry_id) values ($1, $2)', [sel, postDraft], /hindsight/)
  const sameDay = await mk('Draft-day list', '2019-06-03')
  await h.rejects(db, 'insert into acquisition_expectation_links (draft_selection_id, ranking_entry_id) values ($1, $2)', [sel, sameDay], /hindsight/)
  const wrongChannel = await mk('International list', '2019-01-01', 'INTERNATIONAL')
  await h.rejects(db, 'insert into acquisition_expectation_links (draft_selection_id, ranking_entry_id) values ($1, $2)', [sel, wrongChannel], /does not match acquisition channel/)
  const otherPlayerEntry = (await h.one(db, "select e.id from ranking_entries e join players p on p.id = e.player_id where p.slug = 'fixture-amateur-signee'")).id
  await h.rejects(db, 'insert into acquisition_expectation_links (draft_selection_id, ranking_entry_id) values ($1, $2)', [sel, otherPlayerEntry], /concerns player/)
})

test('the acquisition-time expectation view never includes post-acquisition evidence', async () => {
  const leaks = await h.one(db, 'select count(*)::int n from v_acquisition_time_expectations where published_date >= acquisition_cutoff_date')
  assert.equal(leaks.n, 0)
  const arm = await h.rows(db, `select evidence_kind, published_date::text from v_acquisition_time_expectations x join players p on p.id = x.player_id
    where p.slug = 'fixture-college-arm' order by 1, 2`)
  assert.ok(arm.every((r) => r.published_date < '2019-06-03'))
  assert.ok(arm.some((r) => r.evidence_kind === 'EVALUATION') && arm.some((r) => r.evidence_kind === 'RANKING'))
})

test('international expectation cutoff falls back to the period start when the signing date is not exact', async () => {
  const p = await h.id(db, "insert into players (slug, full_name, display_name) values ('undated-signee', 'Undated', 'Undated') returning id")
  const period = (await h.one(db, "select id from international_signing_periods where period_key = '2019-20'")).id
  const s = await h.id(db, "insert into international_signings (player_id, organization_id, signing_period_id, pathway, source_id) values ($1, 1, $2, 'INTERNATIONAL_AMATEUR', $3) returning id", [p, period, src])
  const a = await h.one(db, "select acquisition_cutoff_date::text d from v_acquisitions where channel = 'INTERNATIONAL' and acquisition_id = $1", [s])
  assert.equal(a.d, '2019-07-02')
})

test('evaluations store structured grades only within the 20-80 scale and short paraphrases', async () => {
  const e = (await h.one(db, 'select id from evaluations limit 1')).id
  await h.rejects(db, "insert into evaluation_grades (evaluation_id, skill, future_grade) values ($1, 'HIT', 85)", [e], /check/)
  await h.rejects(db, 'update evaluations set summary_note = $1 where id = $2', ['x'.repeat(401), e], /summary_note/)
})
