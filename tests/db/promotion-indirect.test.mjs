// G5-5C Part E: INDIRECT references in an emergency withdrawal (migration 032). A promotion can be pointed at by rows that are not part of it: an alias of a promoted player, an academy that
// cites the promoted source, an observation that names a promoted player or transaction by subject, any table with a foreign key to a promoted row. Such a row is publicly readable and shows
// the withdrawn identity. Three classes are kept apart and tested separately:
//   1. EXISTING UNRELATED DATA (controls): never deleted, never changed, readable again afterwards; readable DURING the emergency in hide mode;
//   2. NEWLY IMPORTED DATA (the ledger): unreadable to anon, authenticated and the website role during the emergency; deleted only by finish;
//   3. INDIRECT REFERENCES: unreadable during the emergency (hidden by a row-level policy, or their table closed), never deleted, never cascaded; they block finish until removed.
// FICTIONAL data (tests/db/promotion-fixture.mjs).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as h from './harness.mjs'
import { applyMigrations } from '../../scripts/db/lib/migrations.mjs'
import { SESSION_SQL, buildPackage, dependents, emergencyWithdraw, finishWithdrawal, promote, revertEmergency, sha256 } from '../../scripts/db/lib/promotion.mjs'
import { buildBaseline, importSample } from './promotion-fixture.mjs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-g55c-'))
const MAIN = 'g55c_ind'
const ROLES = ['anon', 'authenticated', 'bai_site']
// The suite runs at three stages of the schema: 032, 033 and 034 (the last also closes player_aliases to the Data API roles). 032 (the Data API roles read the identity tables; the website role reads them through anon) and 033 (only the website role holds a grant on them).
// At 033 the Data API roles are refused on the four identity tables, so an assertion that a control row is "still readable" holds only for the website role there.
const STAGE = process.env.BAI_STAGE ?? '032'
const FOUR = /\b(from|join)\s+(players|player_external_ids|source_observations|coverage_assessments)\b/
const ALIASES = /\b(from|join)\s+player_aliases\b/
const ctl = (role, sql) => (role !== 'bai_site' && ((['033', '034'].includes(STAGE) && FOUR.test(sql)) || (STAGE === '034' && ALIASES.test(sql)))) ? 0 : 1
// a count the role is allowed to see (where the table is closed to the Data API roles it must be refused, which is what 'hidden' means there)
const seen = async (role, sql, want) => { if (ctl(role, sql) === 0) await denied(role, sql); else assert.equal(await n(role, sql), want, `${role}: ${sql}`) }
let admin, main, batches, GRANT_ROW
const open = async (name) => { const c = await h.connect(name); c.on('error', () => {}); await c.query(SESSION_SQL); return c }
const rows = (c, sql, p) => h.rows(c, sql, p)
const config = () => ({ category: 'RETROSHEET', authorization: { effective_from: '2026-10-30', expires_on: '2027-01-22' },
  attribution: { evidence_sha256: sha256('fixture evidence'), verified_at: new Date().toISOString(), max_age_hours: 72 }, archive: { name: 'fixture', sha256: sha256('a') }, expectBatches: batches })
const asRole = (role, sql, p) => h.asRole(main, role, () => rows(main, sql, p))
const n = async (role, sql, p) => (await asRole(role, sql, p))[0].n
const denied = (role, sql) => assert.rejects(h.asRole(main, role, () => main.query(sql)), /permission denied/, `${role}: ${sql}`)
const refreshAll = async () => { await main.query('select public.refresh_read_models()'); await main.query('select public.refresh_transaction_read_models()') }
const restoreGrant = () => main.query('insert into ingest.source_publication_grants select * from jsonb_populate_record(null::ingest.source_publication_grants, $1::jsonb) on conflict do nothing', [JSON.stringify(GRANT_ROW)])
// every public relation (table or view) a role can read, with its privileges: the comparison that proves a closed endpoint reopens exactly as it was
const privileges = async () => (await rows(main, `select c.relname r, has_table_privilege('anon', c.oid, 'SELECT') a, has_table_privilege('authenticated', c.oid, 'SELECT') u, has_table_privilege('bai_site', c.oid, 'SELECT') s
  from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'v', 'm', 'p') order by 1`)).map((x) => `${x.r}:${x.a ? 1 : 0}${x.u ? 1 : 0}${x.s ? 1 : 0}`).join(',')

let ids   // the promoted identities and the controls
const plant = async (tag) => {
  const P = Number((await rows(main, "select id from players where full_name like 'Stage Player%' order by id limit 1"))[0].id)
  const T = Number((await rows(main, "select t.id from transactions t join sources s on s.id = t.source_id where s.attribution_category = 'RETROSHEET' order by t.id limit 1"))[0].id)
  const S = Number((await rows(main, "select id from sources where attribution_category = 'RETROSHEET'"))[0].id)
  const B = Number((await rows(main, "select id from players where slug = 'g54-existing'"))[0].id)
  const MLB_T = Number((await rows(main, "select t.id from transactions t join sources s on s.id = t.source_id where s.attribution_category = 'MLB' order by t.id limit 1"))[0].id)
  const base = (await rows(main, "select id from sources where source_key = 'g54:base'"))[0].id
  const q = (sql, p) => main.query(sql, p)
  // 3. indirect references (each points at a promoted player, transaction or source)
  await q("insert into player_aliases (player_id, alias, alias_type, source_id) values ($1, 'Indirect Alias', 'NICKNAME', $2)", [P, base])
  await q("insert into source_observations (source_id, subject_table, subject_id, field_name, observed_value) values ($1, 'players', $2, 'nickname', to_jsonb('Indirect'::text))", [base, P])
  await q("insert into source_observations (source_id, subject_table, subject_id, field_name, observed_value) values ($1, 'transactions', $2, 'note', to_jsonb('Indirect'::text))", [base, T])
  await q("insert into academies (slug, name, academy_kind, source_id) values ('indirect-academy', 'Indirect Academy', 'OTHER', $1)", [S])
  await q('insert into zz_ref_rls (transaction_id, note) values ($1, $2)', [T, 'indirect']); await q('insert into zz_ref_norls (transaction_id, note) values ($1, $2)', [T, 'indirect'])
  // 1. controls (existing unrelated data of the same kinds)
  await q("insert into player_aliases (player_id, alias, alias_type, source_id) values ($1, 'Control Alias', 'NICKNAME', $2)", [B, base])
  await q("insert into source_observations (source_id, subject_table, subject_id, field_name, observed_value) values ($1, 'players', $2, 'nickname', to_jsonb('Control'::text))", [base, B])
  await q("insert into academies (slug, name, academy_kind, source_id) values ('control-academy', 'Control Academy', 'OTHER', $1)", [base])
  await q('insert into zz_ref_rls (transaction_id, note) values ($1, $2)', [MLB_T, 'control']); await q('insert into zz_ref_norls (transaction_id, note) values ($1, $2)', [MLB_T, 'control'])
  return { P, T, S, B, MLB_T, tag }
}
const unplant = async () => {
  await main.query("delete from player_aliases where alias in ('Indirect Alias', 'Control Alias')"); await main.query("delete from source_observations where field_name in ('nickname', 'note') and observed_value in (to_jsonb('Indirect'::text), to_jsonb('Control'::text))")
  await main.query("delete from academies where slug in ('indirect-academy', 'control-academy')"); await main.query('delete from zz_ref_rls'); await main.query('delete from zz_ref_norls')
}
// the generic scan: for the role, no readable row of any public relation carries a foreign key or subject reference to a promoted row, and no readable row of any relation (view or table) contains
// a promoted or indirect token. Relations the role cannot read are skipped (that is the point of closing them).
const leakScan = async (role, sha) => {
  const found = []
  const fks = await rows(main, `select (c.conrelid::regclass)::text child, a.attname col, (c.confrelid::regclass)::text parent from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'f' and cardinality(c.conkey) = 1 and (c.confrelid::regclass)::text in (select table_name from ingest.promotion_ledger where manifest_sha256 = $1) and (c.conrelid::regclass)::text !~ '^(public\\.rm_|ingest\\.|research\\.)'`, [sha])
  for (const f of fks) {
    const pk = (await rows(main, 'select pk_cols[1] k, (select string_agg(x ->> pk_cols[1], \',\') from jsonb_array_elements(pks) x) ids from ingest.promotion_ledger where manifest_sha256 = $1 and table_name = $2', [sha, f.parent]))[0]
    const cnt = await h.asRole(main, role, async () => { try { return (await rows(main, `select count(*)::int n from ${f.child} where ${f.col} = any ($1::bigint[])`, [`{${pk.ids}}`]))[0].n } catch (e) { if (/permission denied/.test(e.message)) return 0; throw e } })
    if (cnt > 0) found.push(`${f.child}.${f.col} -> ${f.parent}: ${cnt} readable row(s)`)
  }
  for (const [tbl, ids2] of [['players', ids.P], ['transactions', ids.T]]) {
    const cnt = await h.asRole(main, role, async () => { try { return (await rows(main, "select count(*)::int n from source_observations where subject_table = $1 and subject_id = $2", [tbl, ids2]))[0].n } catch (e) { if (/permission denied/.test(e.message)) return 0; throw e } })
    if (cnt > 0) found.push(`source_observations by subject ${tbl}: ${cnt}`)
  }
  const rels = await rows(main, "select c.relname r from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'v') and c.relname !~ '^rm_transaction' order by 1")
  for (const { r } of rels) {
    const cnt = await h.asRole(main, role, async () => { try { return (await rows(main, `select count(*)::int n from public.${r} t where to_jsonb(t)::text ~* 'Stage Player|g54p[0-9]|Indirect|hist:retrosheet-g54'`))[0].n } catch (e) { if (/permission denied/.test(e.message)) return 0; throw e } })
    if (cnt > 0) found.push(`${r}: ${cnt} row(s) containing a promoted or indirect token`)
  }
  return found
}

before(async () => {
  await h.startServer(); admin = await h.connect('postgres'); await admin.query(`create database ${MAIN}`)
  main = await open(MAIN)
  await applyMigrations(main, { through: '030' }); await buildBaseline(main, dir); await applyMigrations(main, { through: process.env.BAI_STAGE ?? '032' })   // the 032 stage (033: tests/db/rest-boundary.test.mjs, emergency-033.test.mjs)
  GRANT_ROW = (await rows(main, "select to_jsonb(g) j from ingest.source_publication_grants g where attribution_category = 'RETROSHEET'"))[0].j
  // a table with a foreign key to transactions, which the Data API can read (with row-level security) and one that it can read without (the fall-back: closed); the real public tables that
  // reference transactions need a draft or international signing first, which has nothing to do with this test
  await main.query(`create table public.zz_ref_rls (id bigint generated always as identity primary key, transaction_id bigint references public.transactions (id), note text);
    create table public.zz_ref_norls (id bigint generated always as identity primary key, transaction_id bigint references public.transactions (id), note text);
    alter table public.zz_ref_rls enable row level security; create policy public_read on public.zz_ref_rls for select to anon, authenticated using (true);
    grant select on public.zz_ref_rls, public.zz_ref_norls to anon, authenticated`)
  await main.end(); await admin.query(`create database g55c_ind_stage template ${MAIN}`)
  const s = await open('g55c_ind_stage'); batches = await importSample(s, dir); await s.end(); main = await open(MAIN)
}, { timeout: 180000 })
after(async () => { await h.stopServer(); fs.rmSync(dir, { recursive: true, force: true }) })

let pkg, PRIV0
test('the dependents report names the referencing columns (and the subject), so that an emergency can hide or close exactly the indirect references', async () => {
  pkg = await buildPackage({ connect: open, admin, baseName: MAIN, stageName: 'g55c_ind_stage', config: config() })
  assert.equal((await promote({ connect: open, name: MAIN, pkg })).result, 'PROMOTED'); await refreshAll()
  PRIV0 = await privileges(); ids = await plant('hide')
  const d = await dependents(main, pkg.sha)
  const by = (t, ref) => d.filter((x) => x.table === t && x.references === ref)
  assert.deepEqual(by('public.player_aliases', 'public.players').map((x) => x.columns), [['player_id']])
  assert.deepEqual(by('public.academies', 'public.sources').map((x) => x.columns), [['source_id']])
  assert.deepEqual(by('public.zz_ref_rls', 'public.transactions').map((x) => x.columns), [['transaction_id']])
  assert.deepEqual(d.filter((x) => x.kind === 'by subject').map((x) => x.subject_table).sort(), ['players', 'transactions'])
  assert.ok(d.every((x) => x.rows === 1), 'only the indirect rows are counted: the controls reference baseline rows')
})

test('BEFORE the emergency the indirect references are publicly readable, the scan finds them, so the later tests are not vacuous', async () => {
  for (const role of ROLES) {
    const found = await leakScan(role, pkg.sha); assert.ok(found.length >= (ctl(role, 'from player_aliases') === 0 ? 4 : 5), `${role}: ${found.join(' | ')}`)   // at 034 the Data API roles no longer see the alias, so one finding fewer
    await seen(role, "select count(*)::int n from player_aliases where alias = 'Indirect Alias'", 1)
  }
})

test('EMERGENCY (hide): promoted rows are unreadable; indirect references are hidden, not deleted; unrelated controls stay readable; nothing is cascaded', async () => {
  const e = await emergencyWithdraw(main, pkg.sha, 'drill: indirect references')
  const indirect = e.hidden.filter((x) => x.indirect).map((x) => x.table).sort()
  assert.deepEqual(indirect, ['public.academies', 'public.player_aliases', 'public.source_observations', 'public.source_observations', 'public.zz_ref_rls'], 'each indirect reference is hidden by its own policy')
  assert.deepEqual(e.closed.map((x) => x.table), ['public.zz_ref_norls'], 'a readable table without row-level security cannot hide a row: it is closed (and only it)')
  assert.ok(e.closed[0].indirect && e.closed[0].roles.includes('anon') && e.closed[0].roles.includes('authenticated'))
  for (const role of ROLES) {
    assert.deepEqual(await leakScan(role, pkg.sha), [], `${role}: no readable row reveals a promoted or indirect identity`)
    await seen(role, "select count(*)::int n from player_aliases where alias = 'Indirect Alias'", 0)
    await seen(role, "select count(*)::int n from player_aliases where alias = 'Control Alias'", 1)   // the unrelated alias is still readable by the roles that can read the table
    assert.equal(await n(role, "select count(*)::int n from academies where slug = 'indirect-academy'"), 0); assert.equal(await n(role, "select count(*)::int n from academies where slug = 'control-academy'"), 1)
    { const sql = "select count(*)::int n from source_observations where field_name in ('nickname', 'note') and observed_value = to_jsonb('Indirect'::text)"; if (ctl(role, sql) === 0) await denied(role, sql); else assert.equal(await n(role, sql), 0) }
    { const sql = "select count(*)::int n from source_observations where field_name = 'nickname' and observed_value = to_jsonb('Control'::text)"; if (ctl(role, sql) === 0) await denied(role, sql); else assert.equal(await n(role, sql), 1) }
    assert.deepEqual((await asRole(role, 'select note from zz_ref_rls order by id')).map((x) => x.note), ['control'])
    if (role !== 'bai_site' || true) await denied(role, 'select 1 from zz_ref_norls')
  }
  // owner: everything is still physically there
  assert.equal((await rows(main, "select count(*)::int n from player_aliases where alias in ('Indirect Alias', 'Control Alias')"))[0].n, 2)
  assert.equal((await rows(main, 'select count(*)::int n from zz_ref_rls'))[0].n, 2); assert.equal((await rows(main, 'select count(*)::int n from zz_ref_norls'))[0].n, 2)
  assert.equal((await rows(main, "select count(*)::int n from players where full_name like 'Stage Player%'"))[0].n, 4)
  // the way out is blocked until every indirect reference is gone, and says which
  await assert.rejects(finishWithdrawal(main, pkg.sha, 'too early'), /blockers remain.*zz_ref_norls/s)
  // removing the blockers one table at a time: still refused until the last
  await main.query("delete from player_aliases where alias = 'Indirect Alias'")
  await assert.rejects(finishWithdrawal(main, pkg.sha, 'too early'), /blockers remain/)
  await main.query("delete from source_observations where observed_value = to_jsonb('Indirect'::text)"); await main.query("delete from academies where slug = 'indirect-academy'")
  await main.query("delete from zz_ref_rls where note = 'indirect'")
  await assert.rejects(finishWithdrawal(main, pkg.sha, 'too early'), /blockers remain/)
  await main.query("delete from zz_ref_norls where note = 'indirect'")
  const f = await finishWithdrawal(main, pkg.sha, 'blockers removed'); assert.equal(f.rows_deleted, Object.values(pkg.manifest.delta).reduce((a, d) => a + d.n, 0))
  // class 1 preserved, policies gone, privileges as before
  assert.equal((await rows(main, "select count(*)::int n from pg_policy where polname like 'emergency_hide_%'"))[0].n, 0)
  for (const role of ROLES) {
    await seen(role, "select count(*)::int n from player_aliases where alias = 'Control Alias'", 1); assert.equal(await n(role, "select count(*)::int n from zz_ref_norls where note = 'control'"), 1)
  }
  assert.equal(await privileges(), PRIV0, 'every public relation has exactly the privileges it had before the emergency')
})

test('EMERGENCY (close the endpoints): every table that holds a promoted or indirect row is closed to anon, authenticated and the website role, including the views over them; unrelated tables still answer', async () => {
  await unplant(); await restoreGrant()
  const pkg2 = await buildPackage({ connect: open, admin, baseName: MAIN, stageName: 'g55c_ind_stage', config: config() })
  assert.equal((await promote({ connect: open, name: MAIN, pkg: pkg2 })).result, 'PROMOTED'); await refreshAll()
  ids = await plant('close'); const PRIV1 = await privileges()
  const e = await emergencyWithdraw(main, pkg2.sha, 'drill: close', { closeApi: true })
  assert.deepEqual(e.hidden, [], 'the stricter mode hides nothing: it closes')
  const closed = e.closed.map((x) => x.table)
  for (const t of ['public.players', 'public.player_external_ids', 'public.source_observations', 'public.coverage_assessments', 'public.sources', 'public.player_aliases', 'public.academies', 'public.zz_ref_rls', 'public.zz_ref_norls']) assert.ok(closed.includes(t), `${t} is closed: ${closed}`)
  assert.ok(e.closed.filter((x) => x.indirect).length >= 4)
  for (const role of ROLES) {
    for (const t of ['players', 'sources', 'player_aliases', 'academies', 'zz_ref_rls', 'zz_ref_norls', 'source_observations']) await denied(role, `select 1 from ${t} limit 1`)
    assert.deepEqual(await leakScan(role, pkg2.sha), [], `${role}: no relation, table or view, reveals a promoted or indirect identity`)
    assert.ok(await n(role, 'select count(*)::int n from organizations') > 0, 'an unrelated public table still answers')
  }
  // the views that sit on closed tables are closed too (security_invoker): none of them answers
  const views = (await rows(main, `select c.relname r from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'v' and c.relname !~ '^rm_' and has_table_privilege('anon', c.oid, 'SELECT') order by 1`)).map((x) => x.r)
  assert.ok(views.length >= 8, `views: ${views.length}`)
  const answering = []; for (const v of views) { try { await h.asRole(main, 'anon', () => main.query(`select 1 from public.${v} limit 1`)); answering.push(v) } catch (err) { if (!/permission denied/.test(err.message)) throw err } }
  const owner = (await rows(main, "select c.relname r from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'v' and not coalesce((select option_value = 'true' from pg_options_to_table(c.reloptions) where option_name = 'security_invoker'), false) and has_table_privilege('anon', c.oid, 'SELECT')")).map((x) => x.r)
  assert.deepEqual(owner, ['v_transaction_record_sources'], 'the only owner-rights view is the declared aggregate, so no view can read a closed table with its owner’s rights')
  assert.equal((await rows(main, 'select count(*)::int n from v_transaction_record_sources'))[0].n, 0, 'and it is empty (the read model is withdrawn)')
  await unplant()
  const f = await finishWithdrawal(main, pkg2.sha, 'blockers removed'); assert.ok(f.rows_deleted > 0)
  await restoreGrant()
  assert.equal(await privileges(), PRIV1, 'every closed table reopens for exactly the roles that had it'); assert.ok(answering.length < views.length, 'closing took views offline (the stated trade-off)')
})

test('EMERGENCY (revert): hidden indirect references are readable again; a closed table reopens for the roles it was closed to', async () => {
  const pkg3 = await buildPackage({ connect: open, admin, baseName: MAIN, stageName: 'g55c_ind_stage', config: config() })
  assert.equal((await promote({ connect: open, name: MAIN, pkg: pkg3 })).result, 'PROMOTED'); await refreshAll()
  ids = await plant('revert'); const PRIV2 = await privileges()
  await emergencyWithdraw(main, pkg3.sha, 'drill: possible licence change'); const reader = STAGE === '034' ? 'bai_site' : 'anon'; assert.equal(await n(reader, "select count(*)::int n from player_aliases where alias = 'Indirect Alias'"), 0)
  assert.equal((await revertEmergency(main, pkg3.sha, 'false alarm')).state, 'PROMOTED')
  assert.equal(await n(reader, "select count(*)::int n from player_aliases where alias = 'Indirect Alias'"), 1, 'visible again, as before the false alarm')
  assert.equal(await privileges(), PRIV2); assert.equal((await rows(main, "select count(*)::int n from pg_policy where polname like 'emergency_hide_%'"))[0].n, 0)
})
