// Migration 027: the strict source classifier, the hosted publication guard, direct SQL bypass attempts, the fixed
// classification of an existing source, legacy preservation and the release audit table.
// Every source, player and record here is FICTIONAL fixture data.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as h from './harness.mjs'
import { applyMigrations } from '../../scripts/db/lib/migrations.mjs'

let db
before(async () => { await h.startServer(); db = await h.freshDatabase() }, { timeout: 120000 })
after(async () => { await h.stopServer() })

const WD = { url: 'https://www.wikidata.org/', publisher: 'Wikimedia Foundation (Wikidata contributors)', type: 'REFERENCE_DATABASE', key: 'hist:wikidata-fixture-1' }
const CW = { url: 'https://github.com/chadwickbureau/register/tree/abc1234', publisher: 'Chadwick Baseball Bureau' }
const WP = { url: 'https://en.wikipedia.org/w/index.php?title=X&oldid=1', publisher: 'Wikimedia Foundation (contributors)' }
const add = async (key, type, { url = null, publisher = null, title = `Fixture ${key}` } = {}) =>
  (await h.one(db, `insert into sources (source_key, source_type, authority_level, title, publisher, url, reference) values ($1, $2, 'OTHER', $3, $4, $5, $6) returning id, attribution_category`,
    [key, type, title, publisher, url, url ? null : 'fixture reference'])).attribution_category
const cat = async (key) => (await h.one(db, 'select attribution_category c from sources where source_key = $1', [key])).c

test('a Wikidata source is recognised only when URL, publisher, type and key all identify it', async () => {
  assert.equal(await add(WD.key, WD.type, { url: WD.url, publisher: WD.publisher }), 'WIKIDATA')
  assert.equal(await add('hist:wikidata-fixture-2', WD.type, { url: 'https://query.wikidata.org/sparql?query=x', publisher: WD.publisher }), 'WIKIDATA')
  const lookalikes = [
    ['hist:wikidata-x1', { url: 'https://www.wikidata.org.evil.example/' }],
    ['hist:wikidata-x2', { url: `https://www.wikidata.org${'@'}evil.example/` }],
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

test('restricted hosts win over every label, alias, title and claimed type', async () => {
  assert.equal(await add('hist:wikidata-mlb', WD.type, { url: 'https://statsapi.mlb.com/api/v1/x', publisher: WD.publisher }), 'MLB')
  assert.equal(await add('hist:chadwick-fake', 'REFERENCE_DATABASE', { url: 'https://statsapi.mlb.com/api/v1/draft/2020', title: 'Chadwick Baseball Bureau Register', publisher: 'Chadwick Baseball Bureau' }), 'MLB')
  assert.equal(await add('hist:wikipedia-fake', 'REFERENCE_DATABASE', { url: 'https://www.mlb.com/news/x', publisher: 'Wikipedia' }), 'MLB')
  assert.equal(await add('bai-reference:fake-mlb', 'BAI_REFERENCE', { url: 'https://www.mlb.com/history', publisher: 'MLB' }), 'MLB', 'a BAI-typed source is judged by the page it cites')
  assert.equal(await add('bai-reference:fake-mlb-key', 'BAI_REFERENCE', { url: 'https://example.test/x', title: 'MLB Stats API copy' }), 'MLB')
  assert.equal(await add('hist:wikidata-bref', WD.type, { url: 'https://www.baseball-reference.com/x', publisher: WD.publisher }), 'BASEBALL_REFERENCE')
  assert.equal(await add('hist:chadwick-bref', 'REFERENCE_DATABASE', { url: 'https://web.archive.org/web/2020/https://www.baseball-reference.com/x', title: 'Chadwick' }), 'BASEBALL_REFERENCE')
  assert.equal(await add('bai-reference:fake-bref', 'BAI_REFERENCE', { url: 'https://www.baseball-reference.com/x' }), 'BASEBALL_REFERENCE')
  assert.equal(await add('fx:league', 'OFFICIAL_LEAGUE', { url: 'https://example.test/league' }), 'MLB', 'the OFFICIAL_LEAGUE type alone is MLB')
})

test('Chadwick, Wikipedia and BAI research need their full identity; a label selects nothing', async () => {
  assert.equal(await add('fx:chadwick', 'REFERENCE_DATABASE', CW), 'CHADWICK_REGISTER')
  assert.equal(await add('fx:wiki', 'REFERENCE_DATABASE', WP), 'WIKIPEDIA')
  assert.equal(await add('bai-reference:fixture', 'BAI_REFERENCE', { url: 'https://github.com/seantsck/bai' }), 'BAI_RESEARCH')
  const other = [
    ['fx:cw-title', 'REFERENCE_DATABASE', { url: 'https://example.test/x', title: 'Chadwick Baseball Bureau Register', publisher: 'Chadwick Baseball Bureau' }],
    ['fx:cw-host', 'REFERENCE_DATABASE', { url: 'https://github.com.evil.example/chadwickbureau/register', publisher: 'Chadwick Baseball Bureau' }],
    ['fx:cw-path', 'REFERENCE_DATABASE', { url: 'https://github.com/someone-else/register', publisher: 'Chadwick Baseball Bureau' }],
    ['fx:cw-prefix', 'REFERENCE_DATABASE', { url: 'https://github.com/chadwickbureau/register-evil', publisher: 'Chadwick Baseball Bureau' }],
    ['fx:cw-publisher', 'REFERENCE_DATABASE', { url: CW.url, publisher: 'Someone Else' }],
    ['fx:cw-type', 'NEWS_REPORT', CW],
    ['fx:wp-label', 'REFERENCE_DATABASE', { url: 'https://example.test/x', publisher: 'Wikipedia', title: 'Wikipedia draft article' }],
    ['fx:wp-host', 'REFERENCE_DATABASE', { url: 'https://en.wikipedia.org.evil.example/x', publisher: 'Wikipedia' }],
    ['fx:wp-lang', 'REFERENCE_DATABASE', { url: 'https://de.wikipedia.org/wiki/X', publisher: 'Wikipedia' }],
    ['fx:wp-type', 'NEWS_REPORT', WP],
    ['fx:wp-publisher', 'REFERENCE_DATABASE', { url: WP.url, publisher: 'Someone Else' }],
    ['fx:bai-key', 'BAI_REFERENCE', { url: 'https://github.com/seantsck/bai' }],
    ['bai-reference:wrong-type', 'NEWS_REPORT', { url: 'https://github.com/seantsck/bai' }],
    ['fx:bai-unrelated', 'BAI_REFERENCE', { url: 'https://example.test/anything', title: 'BAI reference' }]
  ]
  for (const [key, type, o] of other) assert.equal(await add(key, type, o), 'OTHER_PUBLICATION', key)
  assert.equal(await add('fx:news', 'NEWS_REPORT', { url: 'https://www.mlbtraderumors.com/x' }), 'OTHER_PUBLICATION', 'a trade-rumors page is not MLB')
})

const newPick = async (pick, sourceKey) => {
  await db.query(`insert into draft_rounds (draft_id, round_code, round_order, phase) select id, '1', 10, 'REGULAR' from drafts where draft_key = '2019-JUNE_AMATEUR' on conflict do nothing`)
  await db.query(`insert into players (slug, full_name, display_name) values ($1, $2, $2) on conflict do nothing`, [`fixture-wd-${pick}`, `Fixture Wd ${pick}`])
  return db.query(`insert into draft_selections (draft_id, round_id, overall_pick, round_pick, organization_id, player_id, source_id)
    select d.id, r.id, $1, $1, (select id from organizations where franchise_key = 'KC'), (select id from players where slug = $3), (select id from sources where source_key = $2)
    from drafts d join draft_rounds r on r.draft_id = d.id and r.round_code = '1' where d.draft_key = '2019-JUNE_AMATEUR' returning id`, [pick, sourceKey, `fixture-wd-${pick}`])
}
const observe = (sourceKey, subject) => db.query(`insert into source_observations (source_id, subject_table, subject_id, field_name, observed_value) values ((select id from sources where source_key = $1), 'draft_selections', $2, 'wikidata_item', '"Q1"')`, [sourceKey, subject])
const refused = (p, group) => assert.rejects(p, new RegExp(`new ${group} record cannot be published|new ${group} record`))

test('hosted guard, direct SQL: forged identities are refused as what they are; genuine CC0, Chadwick, Wikipedia and BAI records pass', async () => {
  const sel = (await newPick(201, 'fx:wiki')).rows[0].id
  await db.query('create role supabase_admin nologin')   // what makes a database a Supabase (hosted) one
  try {
    // Genuine sources pass without any recorded grant (Wikipedia and Chadwick as before; Wikidata is new; BAI's own).
    assert.equal((await observe(WD.key, sel)).rowCount, 1)
    assert.ok((await newPick(202, WD.key)).rows[0].id)
    assert.ok((await newPick(205, 'fx:chadwick')).rows[0].id)
    assert.ok((await newPick(206, 'bai-reference:fixture')).rows[0].id)
    // Each forged identity is refused for the group it really belongs to, by plain INSERT, by UPDATE of source_id and by upsert.
    const forged = [
      ['hist:wikidata-x1', 'OTHER_PUBLICATION'], ['hist:wikidata-x8', 'OTHER_PUBLICATION'], ['hist:wikidata-x13', 'OTHER_PUBLICATION'],
      ['hist:wikidata-mlb', 'MLB'], ['hist:wikidata-bref', 'BASEBALL_REFERENCE'],
      ['hist:chadwick-fake', 'MLB'], ['hist:wikipedia-fake', 'MLB'], ['hist:chadwick-bref', 'BASEBALL_REFERENCE'],
      ['bai-reference:fake-mlb', 'MLB'], ['bai-reference:fake-mlb-key', 'MLB'], ['bai-reference:fake-bref', 'BASEBALL_REFERENCE'], ['fx:league', 'MLB'],
      ['fx:cw-title', 'OTHER_PUBLICATION'], ['fx:cw-host', 'OTHER_PUBLICATION'], ['fx:cw-publisher', 'OTHER_PUBLICATION'], ['fx:cw-type', 'OTHER_PUBLICATION'],
      ['fx:wp-label', 'OTHER_PUBLICATION'], ['fx:wp-host', 'OTHER_PUBLICATION'], ['fx:wp-lang', 'OTHER_PUBLICATION'], ['fx:wp-type', 'OTHER_PUBLICATION'],
      ['fx:bai-key', 'OTHER_PUBLICATION'], ['fx:bai-unrelated', 'OTHER_PUBLICATION']
    ]
    let pick = 300
    for (const [key, group] of forged) {
      pick++
      await refused(observe(key, sel), group)
      await refused(newPick(pick, key), group)
      await refused(db.query(`update draft_selections set source_id = (select id from sources where source_key = $1) where id = $2`, [key, sel]), group)
      await refused(db.query(`insert into draft_selections (draft_id, round_id, overall_pick, round_pick, organization_id, player_id, source_id)
        select draft_id, round_id, overall_pick, round_pick, organization_id, player_id, (select id from sources where source_key = $1) from draft_selections where id = $2
        on conflict (draft_id, overall_pick) do update set source_id = excluded.source_id`, [key, sel]), group)
    }
    // Signings, dispositions and other source-citing tables are guarded by the same trigger.
    await refused(db.query(`insert into draft_signings (draft_selection_id, signing_status, signing_bonus_usd, source_id) values ($1, 'SIGNED', 1000, (select id from sources where source_key = 'hist:chadwick-fake'))`, [sel]), 'MLB')
    // LEGACY: a BAI reference compilation that cites an MLB page keeps its stored category but is no permission for new records.
    const legacy = await h.one(db, `select attribution_category c from sources where source_key = 'bai-reference:mlb-franchises'`)
    assert.equal(legacy.c, 'BAI_RESEARCH')
    await refused(newPick(399, 'bai-reference:mlb-franchises'), 'MLB')
    // A recorded basis opens a restricted group (a person's assertion) but never a disguised one into a free group.
    await db.query(`insert into ingest.source_publication_grants (attribution_category, basis_reference, scope_note) values ('MLB', 'FIXTURE-AUTH-MLB', 'fixture authorization')`)
    assert.ok((await newPick(398, 'fx:league')).rows[0].id)
    await refused(newPick(397, 'hist:wikidata-x1'), 'OTHER_PUBLICATION')
    await db.query('delete from ingest.source_publication_grants')
    // Missing citations are not accepted; the grants table cannot name WIKIDATA (it never needed a grant).
    await assert.rejects(db.query(`insert into source_observations (source_id, subject_table, subject_id, field_name, observed_value) values (null, 'draft_selections', $1, 'wikidata_item', '"Q2"')`, [sel]), /null value|violates not-null/)
    await assert.rejects(newPick(396, 'hist:wikidata-does-not-exist'), /null value|violates not-null/)
    await assert.rejects(db.query(`insert into ingest.source_publication_grants (attribution_category, basis_reference, scope_note) values ('WIKIDATA', 'x', 'y')`), /check/)
  } finally { await db.query('drop role supabase_admin'); await db.query('delete from ingest.source_publication_grants') }
})

test('a source cannot be reclassified or forged: updates, direct writes of the category, and insert-time claims', async () => {
  // Rewriting a source into an allowed group is refused, however it is done.
  await assert.rejects(db.query(`update sources set url = 'https://www.wikidata.org/', publisher = $1, source_type = 'REFERENCE_DATABASE' where source_key = 'hist:wikidata-mlb'`, [WD.publisher]), /category of source hist:wikidata-mlb is fixed/)
  await assert.rejects(db.query(`update sources set publisher = $1 where source_key = 'hist:wikidata-x8'`, [WD.publisher]), /is fixed/, 'a look-alike cannot be repaired into Wikidata')
  await assert.rejects(db.query(`update sources set source_key = 'hist:wikidata-x14', url = 'https://www.wikidata.org/', publisher = $1 where source_key = 'hist:wikidata-x1'`, [WD.publisher]), /is fixed/)
  await assert.rejects(db.query(`update sources set url = 'https://statsapi.mlb.com/x' where source_key = $1`, [WD.key]), /is fixed/, 'Wikidata cannot be repointed at MLB')
  await assert.rejects(db.query(`update sources set title = 'Chadwick', url = $1, publisher = 'Chadwick Baseball Bureau', source_type = 'REFERENCE_DATABASE' where source_key = 'fx:news'`, [CW.url]), /is fixed/)
  await assert.rejects(db.query(`update sources set source_type = 'BAI_REFERENCE', source_key = 'bai-reference:renamed' where source_key = 'fx:bai-unrelated'`), /is fixed/)
  await assert.rejects(db.query(`update sources set url = 'https://example.test/relabelled' where source_key = 'bai-reference:mlb-franchises'`), /is fixed|cannot be written/, 'a legacy BAI compilation cannot be relabelled either')
  // Writing the category itself is refused; an insert that supplies one gets the computed value.
  await assert.rejects(db.query(`update sources set attribution_category = 'WIKIPEDIA' where source_key = 'hist:wikidata-mlb'`), /cannot be written/)
  await assert.rejects(db.query(`update sources set attribution_category = 'MLB' where source_key = $1`, [WD.key]), /cannot be written/)
  const forged = await h.one(db, `insert into sources (source_key, source_type, authority_level, title, publisher, url, attribution_category) values ('hist:forged-insert', 'NEWS_REPORT', 'OTHER', 'Forged', 'Someone', 'https://example.test/x', 'WIKIPEDIA') returning attribution_category c`)
  assert.equal(forged.c, 'OTHER_PUBLICATION')
  const forged2 = await h.one(db, `insert into sources (source_key, source_type, authority_level, title, publisher, url, attribution_category) values ('hist:forged-insert-2', 'OFFICIAL_LEAGUE', 'OTHER', 'Forged 2', 'MLB', 'https://statsapi.mlb.com/x', 'CHADWICK_REGISTER') returning attribution_category c`)
  assert.equal(forged2.c, 'MLB')
  // A type or URL change that does not move the classification is not a reclassification.
  await db.query(`update sources set title = 'Fixture news, relabelled but still a publication' where source_key = 'fx:news'`)
  // Edits that keep the classification are fine.
  await db.query(`update sources set title = 'Fixture Wikidata (renamed title)', notes = 'n' where source_key = $1`, [WD.key])
  await db.query(`update sources set title = 'Fixture news retitled' where source_key = 'fx:news'`)
  assert.equal(await cat(WD.key), 'WIKIDATA')
})

test('the public summaries show WIKIDATA; the rule is one immutable function', async () => {
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

test('existing sources keep their categories and their records through 027 (applied to a database at 026)', async () => {
  const old = await h.freshDatabase({ migrate: false })
  await applyMigrations(old, { through: '026' })
  // Legacy sources of every group, inserted under the 025 rule (generated column), some of which the strict rule would classify differently.
  const legacy = [
    ['legacy:cw', 'REFERENCE_DATABASE', 'Chadwick label only', null, 'Chadwick Baseball Bureau (GitHub)'],        // 025: CHADWICK by label
    ['legacy:wp', 'REFERENCE_DATABASE', 'Wikipedia label only', 'https://example.test/wiki', 'Wikipedia'],           // 025: WIKIPEDIA by label
    ['legacy:bai-mlb', 'BAI_REFERENCE', 'BAI compilation', 'https://www.mlb.com/team', 'MLB'],                      // 025: BAI_RESEARCH before the MLB host
    ['legacy:mlb', 'OFFICIAL_LEAGUE', 'MLB feed', 'https://statsapi.mlb.com/x', 'MLB Advanced Media'],
    ['legacy:news', 'NEWS_REPORT', 'A report', 'https://example.test/n', null]
  ]
  for (const [key, type, title, url, publisher] of legacy) await old.query(`insert into sources (source_key, source_type, authority_level, title, publisher, url, reference) values ($1, $2, 'OTHER', $3, $4, $5, 'ref')`, [key, type, title, publisher, url])
  const before = (await h.rows(old, 'select source_key, attribution_category from sources order by source_key'))
  const recordsBefore = Number((await h.one(old, 'select count(*) n from organizations')).n)
  const notices = []
  old.on('notice', (n) => notices.push(n.message))
  await applyMigrations(old)
  const after = await h.rows(old, 'select source_key, attribution_category from sources order by source_key')
  assert.deepEqual(after, before, 'every existing category is kept exactly')
  assert.ok(after.length > legacy.length, 'the seeded reference sources are included')
  assert.equal(Number((await h.one(old, 'select count(*) n from organizations')).n), recordsBefore)
  assert.ok(notices.some((m) => /existing source categories kept; \d+ legacy source\(s\) differ/.test(m)), notices.join(' | '))
  assert.equal((await h.one(old, `select attribution_category c from sources where source_key = 'legacy:bai-mlb'`)).c, 'BAI_RESEARCH')
  // New sources on the upgraded database are strict.
  const fresh = await h.one(old, `insert into sources (source_key, source_type, authority_level, title, publisher, url, reference) values ('legacy:new-bai-mlb', 'BAI_REFERENCE', 'OTHER', 'BAI compilation', 'MLB', 'https://www.mlb.com/team', 'ref') returning attribution_category c`)
  assert.equal(fresh.c, 'MLB')
  // The legacy BAI source is not permission for a new record on a hosted database.
  await old.query('create role supabase_admin nologin')
  try {
    await old.query(`insert into draft_rounds (draft_id, round_code, round_order, phase) select id, '1', 10, 'REGULAR' from drafts where draft_key = '2019-JUNE_AMATEUR' on conflict do nothing`)
    await old.query(`insert into players (slug, full_name, display_name) values ('fixture-legacy', 'Fixture Legacy', 'Fixture Legacy')`)
    await assert.rejects(old.query(`insert into draft_selections (draft_id, round_id, overall_pick, round_pick, organization_id, player_id, source_id)
      select d.id, r.id, 9, 9, (select id from organizations where franchise_key = 'KC'), (select id from players where slug = 'fixture-legacy'), (select id from sources where source_key = 'legacy:bai-mlb')
      from drafts d join draft_rounds r on r.draft_id = d.id and r.round_code = '1' where d.draft_key = '2019-JUNE_AMATEUR'`), /new MLB record cannot be published/)
  } finally { await old.query('drop role supabase_admin') }
})
