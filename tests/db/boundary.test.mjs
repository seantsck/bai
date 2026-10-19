// RLS / public boundary: public roles read public facts and read models only, never write, never reach analytics or internals.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as h from './harness.mjs'

let db
before(async () => {
  await h.startServer(); db = await h.freshDatabase({ fixtures: true })
  await db.query('select refresh_read_models()')
}, { timeout: 120000 })
after(async () => { await h.stopServer() })

test('every table in public has row level security enabled', async () => {
  const r = await h.rows(db, "select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity")
  assert.deepEqual(r, [])
})

test('every public view is security_invoker', async () => {
  const r = await h.rows(db, `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'analytics') and c.relkind = 'v' and not coalesce('security_invoker=true' = any(c.reloptions), false)`)
  assert.deepEqual(r, [])
})

test('public roles hold only SELECT, and no table grants write privileges to them', async () => {
  const r = await h.rows(db, `select table_name, privilege_type, grantee from information_schema.role_table_grants
    where table_schema = 'public' and grantee in ('anon', 'authenticated', 'PUBLIC') and privilege_type <> 'SELECT'`)
  assert.deepEqual(r, [])
})

for (const role of ['anon', 'authenticated']) {
  test(`${role} reads public facts and read models`, async () => {
    await h.asRole(db, role, async () => {
      assert.equal((await h.one(db, 'select count(*)::int n from organizations')).n, 30)
      assert.ok((await h.one(db, 'select count(*)::int n from players')).n >= 4)
      assert.ok((await h.one(db, 'select count(*)::int n from v_draft_picks')).n >= 3)
      assert.equal((await h.one(db, 'select count(*)::int n from rm_organization_summary')).n, 30)
    })
  })

  test(`${role} cannot write, reach internals, analytics, or run the refresh`, async () => {
    for (const sql of [
      "insert into players (slug, full_name, display_name) values ('x', 'x', 'x')",
      "update organizations set current_name = 'x'",
      'delete from sources',
      'select * from research_tasks',
      'select * from quality_flags',
      'select * from read_model_refreshes',
      'select * from v_source_conflicts',
      'select * from analytics.organization_summary',
      'select refresh_read_models()'
    ]) {
      await assert.rejects(h.asRole(db, role, () => db.query(sql)), /permission denied/, `${role}: ${sql}`)
    }
  })
}

test('defense in depth: even with a Supabase-style blanket grant, RLS hides internal rows and blocks writes', async () => {
  await db.query('begin')
  try {
    await db.query('grant all on research_tasks, sources to anon')
    await db.query('set local role anon')
    assert.equal((await h.one(db, 'select count(*)::int n from research_tasks')).n, 0, 'no policy => no rows')
    await assert.rejects(db.query("insert into research_tasks (task_type, title) values ('X', 'x')"), /row-level security/)
  } finally { await db.query('rollback') }
})
