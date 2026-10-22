// Migration 027: WIKIDATA attribution, recognised by URL, publisher, type and key together; the hosted publication guard;
// and the fixed category of an existing source. Every source, player and record here is FICTIONAL fixture data.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as h from './harness.mjs'

let db
before(async () => { await h.startServer(); db = await h.freshDatabase() }, { timeout: 120000 })
after(async () => { await h.stopServer() })

const WD = { url: 'https://www.wikidata.org/', publisher: 'Wikimedia Foundation (Wikidata contributors)', type: 'REFERENCE_DATABASE', key: 'hist:wikidata-fixture-1' }
const add = async (key, type, { url = null, publisher = null, title = `Fixture ${key}` } = {}) =>
  (await h.one(db, `insert into sources (source_key, source_type, authority_level, title, publisher, url, reference) values ($1, $2, 'OTHER', $3, $4, $5, $6) returning id, attribution_category`,
    [key, type, title, publisher, url, url ? null : 'fixture reference'])).attribution_category

test('a Wikidata source is recognised only when URL, publisher, type and key all identify it', async () => {
  assert.equal(await add(WD.key, WD.type, { url: WD.url, publisher: WD.publisher }), 'WIKIDATA')
  assert.equal(await add('hist:wikidata-fixture-2', WD.type, { url: 'https://query.wikidata.org/sparql?query=x', publisher: WD.publisher }), 'WIKIDATA')
  const lookalikes = [
    ['hist:wikidata-x1', { url: 'https://www.wikidata.org.evil.example/' }],
    ['hist:wikidata-x2', { url: 'https://www.wikidata.org@evil.example/' }],
    ['hist:wikidata-x3', { url: 'http://www.wikidata.org/' }],
    ['hist:wikidata-x4', { url: 'https://evil.example/www.wikidata.org/' }],
    ['hist:wikidata-x5', { url: 'https://sub.www.wikidata.org/' }],
    ['hist:wikidata-x6', { url: 'https://www.wikidata.org/ x' }],
    ['hist:wikidata-x7', { url: 'https://www.wikidata.orgx/' }],
    ['hist:wikidata-x8', { url: 'https://www.wikidata.org/', publisher: 'Someone Else' }],
    ['hist:wikidata-x9', { url: 'https://www.wikidata.org/', publisher: null }],
    ['hist:wikidata-x10', { url: null, publisher: WD.publisher, title: 'Wikidata www.wikidata.org' }],
    ['wikidata:x11', { url: 'https://www.wikidata.org/', publisher: WD.publisher }],
    ['hist:wikidata-', { url: 'https://www.wikidata.org/', publisher: WD.publisher }]
  ]
  for (const [key, o] of lookalikes) assert.equal(await add(key, WD.type, o), 'OTHER_PUBLICATION', key)
  assert.equal(await add('hist:wikidata-x13', 'NEWS_REPORT', { url: 'https://www.wikidata.org/', publisher: WD.publisher }), 'OTHER_PUBLICATION', 'wrong source type')
})

test('restricted hosts win over free labels, aliases and titles', async () => {
  assert.equal(await add('hist:wikidata-mlb', WD.type, { url: 'https://statsapi.mlb.com/api/v1/x', publisher: WD.publisher }), 'MLB')
  assert.equal(await add('hist:chadwick-fake', 'REFERENCE_DATABASE', { url: 'https://statsapi.mlb.com/api/v1/draft/2020', title: 'Chadwick Baseball Bureau Register' }), 'MLB')
  assert.equal(await add('hist:wikipedia-fake', 'REFERENCE_DATABASE', { url: 'https://www.mlb.com/news/x', publisher: 'Wikipedia contributors' }), 'MLB')
  assert.equal(await add('hist:wikidata-bref', WD.type, { url: 'https://www.baseball-reference.com/x', publisher: WD.publisher }), 'BASEBALL_REFERENCE')
  assert.equal(await add('hist:chadwick-bref', 'REFERENCE_DATABASE', { url: 'https://web.archive.org/web/2020/https://www.baseball-reference.com/x', title: 'Chadwick' }), 'BASEBALL_REFERENCE')
  // Unchanged groups (025): free groups, BAI's own references (even citing a league page), publications.
  assert.equal(await add('fx:chadwick', 'REFERENCE_DATABASE', { url: 'https://github.com/chadwickbureau/register/tree/abc' }), 'CHADWICK_REGISTER')
  assert.equal(await add('fx:wiki', 'REFERENCE_DATABASE', { url: 'https://en.wikipedia.org/w/index.php?oldid=1' }), 'WIKIPEDIA')
  assert.equal(await add('fx:bai', 'BAI_REFERENCE', { url: 'https://www.mlb.com/history' }), 'BAI_RESEARCH')
  assert.equal(await add('fx:news', 'NEWS_REPORT', { url: 'https://www.mlbtraderumors.com/x' }), 'OTHER_PUBLICATION')
  assert.equal(await add('fx:fixture', 'TEST_FIXTURE', {}), 'TEST_FIXTURE')
})

const newPick = async (pick, sourceKey) => {
  await db.query(`insert into draft_rounds (draft_id, round_code, round_order, phase) select id, '1', 10, 'REGULAR' from drafts where draft_key = '2019-JUNE_AMATEUR' on conflict do nothing`)
  await db.query(`insert into players (slug, full_name, display_name) values ($1, $2, $2) on conflict do nothing`, [`fixture-wd-${pick}`, `Fixture Wd ${pick}`])
  return db.query(`insert into draft_selections (draft_id, round_id, overall_pick, round_pick, organization_id, player_id, source_id)
    select d.id, r.id, $1, $1, (select id from organizations where franchise_key = 'KC'), (select id from players where slug = $3), (select id from sources where source_key = $2)
    from drafts d join draft_rounds r on r.draft_id = d.id and r.round_code = '1' where d.draft_key = '2019-JUNE_AMATEUR' returning id`, [pick, sourceKey, `fixture-wd-${pick}`])
}
const observe = (sourceKey, subject) => db.query(`insert into source_observations (source_id, subject_table, subject_id, field_name, observed_value) values ((select id from sources where source_key = $1), 'draft_selections', $2, 'wikidata_item', '"Q1"')`, [sourceKey, subject])

test('the hosted guard passes genuine Wikidata records and refuses disguised, restricted and uncited ones', async () => {
  const sel = (await newPick(201, 'fx:wiki')).rows[0].id
  await db.query('create role supabase_admin nologin')   // what makes a database a Supabase (hosted) one
  try {
    // A correctly identified Wikidata source corroborates a record without any recorded grant.
    assert.ok((await observe(WD.key, sel)).rowCount === 1)
    assert.ok((await newPick(202, WD.key)).rows[0].id)
    // Disguised sources are refused as what they really are.
    await assert.rejects(observe('hist:wikidata-x1', sel), /new OTHER_PUBLICATION record/)
    await assert.rejects(observe('hist:wikidata-x8', sel), /new OTHER_PUBLICATION record/)
    await assert.rejects(observe('hist:wikidata-mlb', sel), /new MLB record/)
    await assert.rejects(observe('hist:wikidata-bref', sel), /new BASEBALL_REFERENCE record/)
    await assert.rejects(newPick(203, 'hist:chadwick-fake'), /new MLB record/)
    // Restricted and publication sources stay refused without a recorded basis; the free groups still pass.
    await assert.rejects(newPick(204, 'fx:news'), /new OTHER_PUBLICATION record/)
    assert.ok((await newPick(205, 'fx:chadwick')).rows[0].id)
    assert.ok((await newPick(206, 'fx:bai')).rows[0].id)
    // A record without a citation is not accepted at all.
    await assert.rejects(db.query(`insert into source_observations (source_id, subject_table, subject_id, field_name, observed_value) values (null, 'draft_selections', $1, 'wikidata_item', '"Q2"')`, [sel]), /null value|violates not-null/)
    await assert.rejects(newPick(207, 'hist:wikidata-does-not-exist'), /null value|violates not-null/)
    // Repointing an existing record to a restricted or disguised source is refused.
    await assert.rejects(db.query(`update draft_selections set source_id = (select id from sources where source_key = 'hist:wikidata-mlb') where id = $1`, [sel]), /new MLB record/)
    // The grants table still cannot name WIKIDATA: it never needed a grant.
    await assert.rejects(db.query(`insert into ingest.source_publication_grants (attribution_category, basis_reference, scope_note) values ('WIKIDATA', 'x', 'y')`), /check/)
  } finally { await db.query('drop role supabase_admin') }
})

test('a source cannot be reclassified once it exists', async () => {
  // Making a restricted or look-alike source claim Wikidata (or any free group) after records cite it is refused.
  await assert.rejects(db.query(`update sources set url = 'https://www.wikidata.org/', publisher = $1, source_type = 'REFERENCE_DATABASE' where source_key = 'hist:wikidata-mlb'`, [WD.publisher]), /category of source hist:wikidata-mlb is fixed/)
  await assert.rejects(db.query(`update sources set publisher = $1 where source_key = 'hist:wikidata-x8'`, [WD.publisher]), /is fixed/, 'a look-alike cannot be repaired into Wikidata')
  await assert.rejects(db.query(`update sources set url = 'https://statsapi.mlb.com/x' where source_key = $1`, [WD.key]), /is fixed/, 'Wikidata cannot be repointed at MLB')
  await assert.rejects(db.query(`update sources set title = 'Chadwick', url = 'https://github.com/chadwickbureau/register' where source_key = 'fx:news'`), /is fixed/)
  await assert.rejects(db.query(`update sources set source_key = 'hist:wikidata-x14', url = 'https://www.wikidata.org/', publisher = $1 where source_key = 'hist:wikidata-x1'`, [WD.publisher]), /is fixed/, 'a look-alike URL, key and publisher cannot be rewritten into Wikidata either')
  // Edits that keep the category are fine.
  await db.query(`update sources set title = 'Fixture Wikidata (renamed title)', notes = 'n' where source_key = $1`, [WD.key])
  await db.query(`update sources set title = 'Fixture news retitled' where source_key = 'fx:news'`)
  assert.equal((await h.one(db, `select attribution_category from sources where source_key = $1`, [WD.key])).attribution_category, 'WIKIDATA')
})

test('the public summaries show WIKIDATA and existing groups keep their meaning', async () => {
  await h.asRole(db, 'anon', async () => {
    const rows = await h.rows(db, `select attribution_category, domain, records from v_source_attribution order by 1, 2`)
    assert.ok(rows.some((r) => r.attribution_category === 'WIKIDATA' && r.domain === 'FIELD_OBSERVATION'))
    assert.ok(rows.some((r) => r.attribution_category === 'WIKIDATA' && r.domain === 'DRAFT'))
    assert.equal(rows.some((r) => r.attribution_category === 'TEST_FIXTURE'), false)
  })
  const fn = await h.one(db, `select provolatile, prosecdef from pg_proc where proname = 'source_attribution_category'`)
  assert.deepEqual(fn, { provolatile: 'i', prosecdef: false })
})

test('release audits are private and append-only', async () => {
  const a = await h.one(db, `insert into ingest.release_audits (release_key, manifest_sha256, draft_year, operator, counts, entries) values ('fixture-2020', $1, 2020, 'fixture operator', '{"imported":1}', '[]') returning id, session_role`, ['a'.repeat(64)])
  assert.ok(a.id)
  await assert.rejects(db.query(`update ingest.release_audits set operator = 'x'`), /append-only/)
  await assert.rejects(db.query('delete from ingest.release_audits'), /append-only/)
  await assert.rejects(db.query('truncate ingest.release_audits'), /append-only/)
  await assert.rejects(db.query(`insert into ingest.release_audits (release_key, manifest_sha256, draft_year, operator, counts, entries) values ('fixture-2020', $1, 2020, 'again', '{}', '[]')`, ['a'.repeat(64)]), /duplicate key/)
  await assert.rejects(db.query(`insert into ingest.release_audits (release_key, manifest_sha256, draft_year, operator, counts, entries) values ('Bad Key', $1, 2020, 'x', '{}', '[]')`, ['b'.repeat(64)]), /check/)
  for (const role of ['anon', 'authenticated']) await h.asRole(db, role, () => assert.rejects(db.query('select * from ingest.release_audits'), /permission denied/))
})
