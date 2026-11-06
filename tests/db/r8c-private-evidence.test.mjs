// R8C proof of concept: private corroborating evidence (docs/transactions/r8c-private-evidence-poc.sql) on a DISPOSABLE local database. FICTIONAL clubs, sources and ids; nothing
// here is a migration and nothing touches a hosted database. It proves the design properties: invisible to website roles, append-only, accountable human review that the proposer cannot
// perform, permission withdrawal suspending evidence by derivation, and no effect on public sources, verifications, completeness or read models.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import * as h from './harness.mjs'
import * as B from '../../scripts/research/lib/backfill.mjs'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')
const POC = fs.readFileSync(path.join(root, 'docs/transactions/r8c-private-evidence-poc.sql'), 'utf8')
let db, rv, bot, tx, pkg, asset, srcOther, srcDerived
before(async () => {
  await h.startServer(); db = await h.freshDatabase()
  rv = await h.login(db, 'r8c_reviewer', { reviewer: true }); bot = await h.login(db, 'r8c_proposer', { automation: true })
  await db.query(POC)
  const s = (await db.query("insert into public.sources (source_key, source_type, authority_level, title) values ('r8c:fixture', 'TEST_FIXTURE', 'REPUTABLE_SECONDARY', 'R8C fixture') returning id")).rows[0].id
  tx = (await db.query("insert into public.transactions (transaction_type, transaction_date, source_id) values ('TRADE', '2099-06-01', $1) returning id", [s])).rows[0].id
  const o = (await db.query("select id from public.organizations where franchise_key in ('ARI', 'ATH') order by franchise_key")).rows
  pkg = (await db.query('insert into public.trade_packages (transaction_id, from_organization_id, to_organization_id) values ($1, $2, $3) returning id', [tx, o[0].id, o[1].id])).rows[0].id
  asset = (await db.query("insert into public.trade_package_assets (trade_package_id, asset_type, description) values ($1, 'OTHER', 'fictional asset') returning id", [pkg])).rows[0].id
  await db.query("insert into public.transaction_sources (transaction_id, source_id, role, independence_group) values ($1, $2, 'PRIMARY_ANNOUNCEMENT', 'retrosheet-archive')", [tx, s])
  srcOther = (await db.query("insert into evidence_private.source_identity (canonical_url, publisher, category, origin_group, lineage_note) values ('https://news.example.com/a', 'Example News', 'OTHER_PUBLICATION', 'example-news', 'first-hand report by the publisher; not derived from the origin') returning id")).rows[0].id
  srcDerived = (await db.query("insert into evidence_private.source_identity (canonical_url, publisher, category, origin_group, lineage_note) values ('https://stats.example.org/t', 'Example Stats', 'BASEBALL_REFERENCE', 'retrosheet-archive', 'a stats site that republishes the origin for older years') returning id")).rows[0].id
}, { timeout: 120000 })
after(async () => { await h.stopServer() })

const item = (c, o = {}) => c.query("insert into evidence_private.item (transaction_id, source_identity_id, role, locator, retrieved_on, trade_package_id, independence, our_note) values ($1, $2, 'CORROBORATION', 'section 2', current_date, $3, $4, 'our paraphrase') returning id", [tx, o.source ?? srcOther, pkg, o.independence ?? 'LIKELY_INDEPENDENT'])
const permit = (src, event = 'PRIVATE_USE_PERMITTED') => db.query("insert into evidence_private.permission_event (source_identity_id, event, basis_reference, scope_note) values ($1, $2, 'fixture: written permission reference', 'citation metadata and our own notes only') ", [src, event])

test('boundary: no website or Data API role can see the schema, its tables, its views or its functions', async () => {
  for (const role of ['anon', 'authenticated', 'service_role']) {
    assert.equal((await h.one(db, 'select has_schema_privilege($1, $2, $3) as ok', [role, 'evidence_private', 'USAGE'])).ok, false, `${role} has no schema usage`)
    const rels = await h.rows(db, "select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'evidence_private' and c.relkind in ('r', 'v')")
    assert.ok(rels.length >= 7)
    for (const r of rels) for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) assert.equal((await h.one(db, 'select has_table_privilege($1, $2, $3) as ok', [role, `evidence_private.${r.relname}`, p])).ok, false, `${role} ${p} ${r.relname}`)
    await h.asRole(db, role, async () => { await assert.rejects(db.query('select * from evidence_private.item'), /permission denied/) })
  }
  assert.deepEqual((await h.rows(db, "select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'evidence_private' and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE') or has_function_privilege('service_role', p.oid, 'EXECUTE'))")), [])
})

test('an item needs a permitted source, belongs to its own transaction, and an independent claim needs another origin group and a non-derived source', async () => {
  await assert.rejects(item(db), /private use of this source is not permitted/)
  await permit(srcOther); await permit(srcDerived)
  const ok = await item(db); assert.ok(ok.rows[0].id)
  await assert.rejects(item(db, { source: srcDerived }), /cannot be independent of the transaction's own cited source|partly derived/)
  assert.ok((await item(db, { source: srcDerived, independence: 'LIKELY_DERIVED' })).rows[0].id)
  const other = (await db.query("insert into public.transactions (transaction_type, transaction_date, source_id) select 'TRADE', '2099-06-02', source_id from public.transactions where id = $1 returning id", [tx])).rows[0].id
  await assert.rejects(db.query("insert into evidence_private.item (transaction_id, source_identity_id, role, locator, retrieved_on, trade_package_id, independence) values ($1, $2, 'CORROBORATION', 'x', current_date, $3, 'UNASSESSED')", [other, srcOther, pkg]), /does not belong to this transaction/)
  await assert.rejects(db.query("insert into evidence_private.item (transaction_id, source_identity_id, role, locator, retrieved_on, trade_package_id, trade_package_asset_id, independence) values ($1, $2, 'CORROBORATION', 'x', current_date, $3, $4, 'UNASSESSED')", [tx, srcOther, pkg, asset]), /num_nonnulls|check constraint/)
  await assert.rejects(db.query("insert into evidence_private.source_identity (canonical_url, publisher, category, origin_group, lineage_note) values ('http://insecure.example.com/', 'Bad', 'OTHER_PUBLICATION', 'bad-group', 'plain http is refused outright')"), /check constraint/)
})

test('history is append-only: nothing is updated, deleted or truncated; a change is a new item that supersedes the old one', async () => {
  for (const sql of ['update evidence_private.item set role = $$REFERENCE$$', 'delete from evidence_private.item', 'truncate evidence_private.item', 'update evidence_private.permission_event set event = $$PRIVATE_USE_WITHDRAWN$$', 'delete from evidence_private.source_identity', 'update evidence_private.source_identity set category = $$WIKIPEDIA$$']) await assert.rejects(db.query(sql), /append-only|cannot truncate/, sql)
  const first = (await item(db, { independence: 'UNASSESSED' })).rows[0].id
  const next = (await db.query("insert into evidence_private.item (transaction_id, source_identity_id, role, locator, retrieved_on, trade_package_id, independence, supersedes_id) values ($1, $2, 'CORROBORATION', 'section 3', current_date, $3, 'LIKELY_INDEPENDENT', $4) returning id", [tx, srcOther, pkg, first])).rows[0].id
  const st = Object.fromEntries((await h.rows(db, 'select item_id, standing from evidence_private.item_standing')).map((r) => [r.item_id, r.standing])); assert.equal(st[first], 'SUPERSEDED'); assert.equal(st[next], 'PROPOSED')
})

test('review: only an enrolled human in their own session, only while the gate is open, never the proposer, and an accepted independence cannot contradict a derived proposal', async () => {
  const mine = (await h.one(db, "select id from evidence_private.item where independence = 'LIKELY_INDEPENDENT' and not exists (select 1 from evidence_private.item n where n.supersedes_id = item.id) order by id desc limit 1")).id
  const review = (c, o = {}) => c.query("insert into evidence_private.item_review (item_id, decision, independence_confirmed, reviewer, note) values ($1, $2, $3, $4, 'reviewed against the cited page') returning id", [o.item ?? mine, o.decision ?? 'ACCEPTED_FOR_INTERNAL_USE', o.ind ?? 'CONFIRMED_INDEPENDENT', o.reviewer ?? 'Pat Reviewer'])
  await assert.rejects(review(db), /review is disabled/); await assert.rejects(review(bot), /permission denied|row-level security/)
  await B.enrollReviewer(rv, { reviewer: 'Pat Reviewer', note: 'fixture' })
  await assert.rejects(review(rv), /review is disabled/, 'the closed gate blocks even an enrolled reviewer')
  await rv.query("select * from research.set_certification_gate(true, 'fixture: open for the proof of concept')")
  await assert.rejects(review(rv, { reviewer: 'Someone Else' }), /enrolled human reviewer/)
  await assert.rejects(review(rv, { ind: 'NOT_ASSESSED' }), /check constraint|violates/)
  const proposed = (await item(rv)).rows[0].id; await assert.rejects(review(rv, { item: proposed }), /proposer cannot review/)
  const r = await review(rv); assert.ok(r.rows[0].id)
  assert.equal((await h.one(db, 'select standing from evidence_private.item_standing where item_id = $1', [mine])).standing, 'ACCEPTED_FOR_INTERNAL_USE')
  assert.equal(Number((await h.one(db, 'select accepted_origin_groups from evidence_private.internal_corroboration where transaction_id = $1', [tx])).accepted_origin_groups), 1)
})

test('permission withdrawal suspends the evidence by derivation, blocks new review and proposals, and keeps the history', async () => {
  const before_ = Number((await h.one(db, 'select accepted_origin_groups from evidence_private.internal_corroboration where transaction_id = $1', [tx])).accepted_origin_groups); assert.equal(before_, 1)
  await permit(srcOther, 'PRIVATE_USE_WITHDRAWN')
  assert.equal(Number((await h.one(db, 'select accepted_origin_groups from evidence_private.internal_corroboration where transaction_id = $1', [tx])).accepted_origin_groups), 0)
  assert.ok((await h.rows(db, "select 1 from evidence_private.item_standing where source_identity_id = $1 and standing = 'SUSPENDED'", [srcOther])).length >= 1)
  await assert.rejects(item(db), /not permitted/)
  assert.equal(Number((await h.one(db, 'select count(*) as n from evidence_private.item_review')).n), 1, 'the review row is kept')
  await permit(srcOther); assert.equal(Number((await h.one(db, 'select accepted_origin_groups from evidence_private.internal_corroboration where transaction_id = $1', [tx])).accepted_origin_groups), 1, 'renewed permission restores the standing; nothing was rewritten')
})

test('private corroboration never becomes public: no public source, verification, completeness or read-model row is created or changed', async () => {
  const snap = async () => JSON.stringify([await h.rows(db, 'select count(*) from public.transaction_sources'), await h.rows(db, 'select count(*) from research.transaction_verifications'), await h.rows(db, 'select research.transaction_gaps($1) as g', [tx]), await h.rows(db, 'select count(*) from public.rm_transactions')])
  const s0 = await snap(); await item(db, { independence: 'UNASSESSED' }); assert.equal(await snap(), s0)
  assert.ok((await h.one(db, 'select research.transaction_gaps($1) as g', [tx])).g.includes('FEWER_THAN_TWO_INDEPENDENT_SOURCES'), 'the public gap list still says what it said')
  await assert.rejects(rv.query('select * from research.verify_transaction($1, $$basis note here$$, $$independence note$$)', [tx]), /./, 'private evidence is not a verification path')
  const refs = await h.rows(db, "select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'research') and p.prokind = 'f' and pg_get_functiondef(p.oid) ilike '%evidence_private%'"); assert.deepEqual(refs, [], 'no public or research function reads the private schema')
  const views = await h.rows(db, "select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public', 'analytics') and c.relkind in ('v', 'm') and pg_get_viewdef(c.oid) ilike '%evidence_private%'"); assert.deepEqual(views, [], 'no public or analytics view reads the private schema')
})

test('the proof of concept is not a migration and the numbered migrations are untouched', () => {
  assert.ok(!fs.readdirSync(path.join(root, 'supabase/migrations')).some((f) => /private|evidence/i.test(f)))
  assert.match(POC, /NOT a migration/)
})
