// Security verifier for a BAI database (local or hosted). Checks the declared model, then proves it behaviourally:
//   * public roles (anon, authenticated) may only SELECT public tables/views that are not registered internal;
//   * nothing grants them INSERT/UPDATE/DELETE/TRUNCATE, sequence use, or EXECUTE on any BAI function;
//   * every table in an exposed schema has RLS on, and every policy is a read policy for anon/authenticated;
//   * every view is security_invoker; every function pins search_path; SECURITY DEFINER functions are listed for review;
//   * the private schemas (ingest, analytics, bai_meta) are unusable by public roles, proven by attempting every
//     operation as anon and as authenticated inside transactions that roll back.
// Exit 1 on any failure. Optional: BAI_SUPABASE_URL + BAI_SUPABASE_PUBLISHABLE_KEY also probe the live Data API.
//
//   npm run db:security        npm run hosted:security
import pg from 'pg'
import { ownerDatabaseUrl } from './lib/connection.mjs'
import { PLATFORM_FUNCTION_FILTER } from './lib/catalog.mjs'

const PUBLIC_ROLES = ['anon', 'authenticated']
const PRIVATE_SCHEMAS = ['ingest', 'analytics', 'research', 'bai_meta']
// Human-only actions of migration 021: SECURITY DEFINER so that a reviewer's login role needs no table privilege; the
// identity they act under is session_user, which a SECURITY DEFINER function does not change.
const REVIEWER_FUNCTIONS = ['research.enroll_reviewer(text, text)', 'research.set_certification_gate(boolean, text)',
  'research.reconsider_resolution(text, bigint, text, bigint, text, jsonb, bigint)', 'research.accept_proposal(bigint, text, jsonb)',
  'research.reject_proposal(bigint, text)', 'research.ratify_resolution(bigint, text, jsonb)', 'research.certify_class(bigint)']
// Migration 025: the reviewer's decision on a historical exception (same rules; checked once 025 is present).
const REVIEWER_FUNCTIONS_025 = ['research.decide_history_exception(text, research.history_exception_decision, text, text, bigint, jsonb)']
// Migration 028: the human verification of a transaction and the resolution of an importer conflict (same rules; checked once 028 is present).
const REVIEWER_FUNCTIONS_028 = ['research.verify_transaction(bigint, text, text)', 'research.revoke_transaction_verification(bigint, text)', 'research.resolve_transaction_conflict(bigint, text)']
const json = process.argv.includes('--json')
const failures = []
const notes = []
const fail = (m) => failures.push(m)
const q = async (db, sql, p) => (await db.query(sql, p)).rows

const db = new pg.Client({ connectionString: ownerDatabaseUrl() })
await db.connect()
try {
  // ---- Exposed schemas (Data API). Supabase's PostgREST reads pgrst.db_schemas from the authenticator role.
  // Hosted: ask the Management API (only db_schema is read from the response; it also carries the legacy JWT secret,
  // which is never stored or printed). Otherwise fall back to the authenticator role setting, then to `public`.
  const auth = (await q(db, "select rolconfig from pg_roles where rolname = 'authenticator'"))[0]
  const pgrst = auth?.rolconfig?.find((s) => s.startsWith('pgrst.db_schemas='))
  let exposed = pgrst ? pgrst.split('=')[1].split(',').map((s) => s.trim()) : ['public']
  let exposedSource = pgrst ? 'authenticator role setting' : auth ? 'platform default (not set on authenticator)' : 'plain PostgreSQL: assuming public'
  const ref = process.env.BAI_SUPABASE_PROJECT_REF
  if (ref && process.env.SUPABASE_ACCESS_TOKEN) {
    const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/postgrest`, { headers: { Authorization: `Bearer ${process.env.SUPABASE_ACCESS_TOKEN}` } })
    if (!res.ok) fail(`could not read Data API configuration (HTTP ${res.status})`)
    else { exposed = String((await res.json()).db_schema ?? '').split(',').map((x) => x.trim()).filter(Boolean); exposedSource = 'Management API' }
  }
  notes.push(`Data API exposed schemas: ${exposed.join(', ')} (${exposedSource})`)
  for (const s of PRIVATE_SCHEMAS) if (exposed.includes(s)) fail(`private schema ${s} is exposed through the Data API`)

  const internal = new Set((await q(db, 'select object_name from public.internal_objects')).map((r) => r.object_name))

  // ---- Grants on relations in BAI schemas
  for (const r of await q(db, `select n.nspname s, c.relname t, c.relkind k, c.relrowsecurity rls, c.reloptions opts, r.rolname role,
        has_table_privilege(r.oid, c.oid, 'SELECT') sel, has_table_privilege(r.oid, c.oid, 'INSERT') ins, has_table_privilege(r.oid, c.oid, 'UPDATE') upd,
        has_table_privilege(r.oid, c.oid, 'DELETE') del, has_table_privilege(r.oid, c.oid, 'TRUNCATE') trn, has_table_privilege(r.oid, c.oid, 'REFERENCES') ref,
        has_table_privilege(r.oid, c.oid, 'TRIGGER') trg
      from pg_class c join pg_namespace n on n.oid = c.relnamespace cross join pg_roles r
      where n.nspname = any($1) and c.relkind in ('r','p','v','m','f') and r.rolname = any($2)`, [['public', ...PRIVATE_SCHEMAS], PUBLIC_ROLES])) {
    const name = `${r.s}.${r.t}`
    if (r.ins || r.upd || r.del || r.trn || r.ref || r.trg) fail(`${r.role} has write/DDL privilege on ${name}`)
    const shouldRead = r.s === 'public' && !internal.has(r.t)
    if (r.sel && !shouldRead) fail(`${r.role} can SELECT ${name}, which is ${r.s === 'public' ? 'registered internal' : 'in a private schema'}`)
    if (!r.sel && shouldRead) fail(`${r.role} cannot SELECT public object ${name} (public read surface incomplete)`)
  }
  for (const r of await q(db, `select n.nspname s, c.relname t, c.relkind k, c.relrowsecurity rls, c.reloptions opts
      from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = any($1) and c.relkind in ('r','p','v','m')`, [['public', ...PRIVATE_SCHEMAS]])) {
    if ((r.k === 'r' || r.k === 'p') && exposed.includes(r.s) && !r.rls) fail(`table ${r.s}.${r.t} in exposed schema has RLS disabled`)
    if (r.k === 'v' && !(r.opts ?? []).includes('security_invoker=true')) fail(`view ${r.s}.${r.t} is not security_invoker (would bypass RLS)`)
    if (r.k === 'm' && exposed.includes(r.s)) fail(`materialized view ${r.s}.${r.t} in an exposed schema cannot enforce RLS`)
  }
  // Sequences: public roles never need them (they never insert).
  for (const r of await q(db, `select n.nspname s, c.relname t, r.rolname role from pg_class c join pg_namespace n on n.oid = c.relnamespace cross join pg_roles r
      where n.nspname = any($1) and c.relkind = 'S' and r.rolname = any($2)
        and (has_sequence_privilege(r.oid, c.oid, 'USAGE') or has_sequence_privilege(r.oid, c.oid, 'UPDATE') or has_sequence_privilege(r.oid, c.oid, 'SELECT'))`,
  [['public', ...PRIVATE_SCHEMAS], PUBLIC_ROLES])) fail(`${r.role} has privileges on sequence ${r.s}.${r.t}`)

  // ---- Schema usage
  for (const r of await q(db, `select n.nspname s, r.rolname role, has_schema_privilege(r.oid, n.oid, 'USAGE') u, has_schema_privilege(r.oid, n.oid, 'CREATE') c
      from pg_namespace n cross join pg_roles r where n.nspname = any($1) and r.rolname = any($2)`, [['public', ...PRIVATE_SCHEMAS], PUBLIC_ROLES])) {
    if (r.c) fail(`${r.role} can CREATE in schema ${r.s}`)
    if (r.u && r.s !== 'public') fail(`${r.role} has USAGE on private schema ${r.s}`)
  }

  // ---- RLS policies: read-only, for public roles only
  for (const r of await q(db, "select schemaname s, tablename t, policyname p, cmd, roles::text[] roles from pg_policies where schemaname = any($1)", [['public', ...PRIVATE_SCHEMAS]])) {
    if (r.cmd !== 'SELECT') fail(`policy ${r.s}.${r.t}.${r.p} allows ${r.cmd}`)
    if (internal.has(r.t)) fail(`internal table ${r.s}.${r.t} has a public policy ${r.p}`)
  }

  // ---- Functions
  const functions = await q(db, `select n.nspname s, p.proname f, pg_get_function_identity_arguments(p.oid) args, p.oid::regprocedure::text sig, p.prorettype = 'trigger'::regtype trg, p.prosecdef secdef, p.proconfig cfg,
        has_function_privilege('anon', p.oid, 'EXECUTE') anon_x, has_function_privilege('authenticated', p.oid, 'EXECUTE') auth_x,
        exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') public_x,
        has_function_privilege('service_role', p.oid, 'EXECUTE') service_x
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = any($1) and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
        and ${PLATFORM_FUNCTION_FILTER}
      order by 1, 2`, [['public', ...PRIVATE_SCHEMAS]])
  // Platform-owned functions that live in a BAI schema (Supabase event-trigger handlers): reported, never BAI's.
  for (const r of await q(db, `select n.nspname || '.' || p.proname || '()' f, p.prosecdef d, e.evtname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      join pg_event_trigger e on e.evtfoid = p.oid where n.nspname = any($1)`, [['public', ...PRIVATE_SCHEMAS]])) {
    notes.push(`platform function ${r.f} (event trigger ${r.evtname}${r.d ? ', SECURITY DEFINER, callable only by the event-trigger system' : ''}) is Supabase's, not BAI's`)
  }
  const fnAudit = functions.map((f) => ({ function: `${f.s}.${f.f}(${f.args})`, sig: f.sig, trigger: f.trg, security: f.secdef ? 'DEFINER' : 'INVOKER', search_path: (f.cfg ?? []).find((c) => c.startsWith('search_path=')) ?? 'NOT SET', public_execute: f.public_x, anon_execute: f.anon_x, authenticated_execute: f.auth_x, service_role_execute: f.service_x }))
  for (const f of fnAudit) {
    if (f.public_execute || f.anon_execute || f.authenticated_execute) fail(`${f.function} is executable by ${['PUBLIC', 'anon', 'authenticated'].filter((_, i) => [f.public_execute, f.anon_execute, f.authenticated_execute][i]).join(', ')}`)
    if (f.search_path === 'NOT SET') fail(`${f.function} does not pin search_path`)
    // A trigger function cannot be called directly; 021 runs the guards with the owner's rights so every writer is guarded.
    if (f.security === 'DEFINER' && !f.trigger && ![...REVIEWER_FUNCTIONS, ...REVIEWER_FUNCTIONS_025, ...REVIEWER_FUNCTIONS_028].map((x) => x.replace(/ /g, '')).includes(f.sig)) fail(`${f.function} is SECURITY DEFINER; BAI declares only the reviewer functions (021, 025, 028) and trigger guards (review before allowing)`)
  }

  // ---- Human certification boundary (021): the reviewer functions are the only SECURITY DEFINER functions, and only
  // bai_reviewer (and the owner) may execute them; the reviewer group itself holds nothing else.
  const grp = (await q(db, "select rolname, rolcanlogin, rolsuper, rolcreaterole, rolbypassrls from pg_roles where rolname in ('bai_reviewer', 'bai_automation') order by 1"))
  const research021 = (await q(db, "select to_regclass('research.reviewers') is not null ok"))[0].ok
  if (research021) {
    if (grp.length !== 2) fail('roles bai_reviewer and bai_automation (021) are missing')
    for (const g of grp) if (g.rolcanlogin || g.rolsuper || g.rolcreaterole || g.rolbypassrls) fail(`${g.rolname} must be a NOLOGIN group with no attributes`)
    const research025 = (await q(db, "select to_regclass('research.history_exceptions') is not null ok"))[0].ok
    const research028 = (await q(db, "select to_regclass('research.transaction_verifications') is not null ok"))[0].ok
    for (const f of [...REVIEWER_FUNCTIONS, ...(research025 ? REVIEWER_FUNCTIONS_025 : []), ...(research028 ? REVIEWER_FUNCTIONS_028 : [])]) {
      const r = (await q(db, `select p.prosecdef d, array(select coalesce(r.rolname::text, 'PUBLIC') from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
          left join pg_roles r on r.oid = a.grantee where a.privilege_type = 'EXECUTE' and a.grantee <> p.proowner order by 1) grantees
        from pg_proc p where p.oid = to_regprocedure($1)`, [f]))[0]
      if (!r) { fail(`reviewer function ${f} is missing`); continue }
      if (!r.d) fail(`${f} must be SECURITY DEFINER`)
      if (JSON.stringify(r.grantees) !== JSON.stringify(['bai_reviewer'])) fail(`${f} must be executable only by bai_reviewer, found ${r.grantees.join(', ') || 'none'}`)
    }
    for (const r of await q(db, `select n.nspname s, c.relname t from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = any($1) and c.relkind in ('r','p','v','m') and (has_table_privilege('bai_reviewer', c.oid, 'SELECT') or has_table_privilege('bai_reviewer', c.oid, 'INSERT')
          or has_table_privilege('bai_reviewer', c.oid, 'UPDATE') or has_table_privilege('bai_reviewer', c.oid, 'DELETE'))`, [['public', ...PRIVATE_SCHEMAS]])) fail(`bai_reviewer holds a privilege on ${r.s}.${r.t}`)
    const gate = (await q(db, 'select enabled, changed_by from research.certification_gate'))[0]
    const reviewers = await q(db, `select v.reviewer, v.db_role, v.active, research.role_review_refusal(v.db_role) refusal,
        (select string_agg(coalesce(g.rolname, '?'), ',') from pg_auth_members m join pg_roles r on r.oid = m.member left join pg_roles g on g.oid = m.grantor
          where m.roleid = 'bai_reviewer'::regrole and r.rolname = v.db_role) granted_by from research.reviewers v order by 1`)
    const members = await q(db, "select r.rolname from pg_auth_members m join pg_roles r on r.oid = m.member where m.roleid = 'bai_reviewer'::regrole order by 1")
    notes.push(`certification gate: ${gate.enabled ? 'ENABLED' : 'disabled'} (last changed by ${gate.changed_by}); bai_reviewer members: ${members.map((m) => m.rolname).join(', ') || 'none'}; enrolled reviewers: ${reviewers.map((r) => `${r.reviewer} (${r.db_role}, ${r.active ? 'active' : 'inactive'}, membership granted by ${r.granted_by ?? '-'}${r.refusal ? ', REFUSED: ' + r.refusal : ''})`).join('; ') || 'none'}`)
  }

  // ---- The web server's login role: no privileges of its own, only SET ROLE anon
  const web = (await q(db, `select r.rolcanlogin, r.rolinherit, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb,
      (select array_agg(g.rolname::text order by g.rolname) from pg_auth_members m join pg_roles g on g.oid = m.roleid where m.member = r.oid) member_of
    from pg_roles r where r.rolname = 'bai_web'`))[0]
  if (!web) fail('role bai_web (016) is missing')
  else {
    if (web.rolinherit || web.rolsuper || web.rolbypassrls || web.rolcreaterole || web.rolcreatedb) fail('bai_web must be NOINHERIT with no elevated attributes')
    if (JSON.stringify(web.member_of) !== JSON.stringify(['anon'])) fail(`bai_web must be a member of anon only, found ${web.member_of}`)
    for (const r of await q(db, `select n.nspname s, c.relname t from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = any($1) and c.relkind in ('r','p','v','m') and has_table_privilege('bai_web', c.oid, 'SELECT')`, [['public', ...PRIVATE_SCHEMAS]])) fail(`bai_web can read ${r.s}.${r.t} without SET ROLE`)
    notes.push(`bai_web: login ${web.rolcanlogin}, NOINHERIT, member of ${web.member_of}`)
  }

  // ---- Behavioural proof: every private operation as each public role, rolled back
  const attempts = [
    ['list staged imports (catalog)', "select count(*) n from information_schema.tables where table_schema = 'ingest'", (rows) => Number(rows[0].n) === 0],
    ['read import batches', 'select * from ingest.import_batches limit 1'],
    ['read staged records', 'select * from ingest.staged_records limit 1'],
    ['read staged sources', 'select * from ingest.staged_sources limit 1'],
    ['insert staged record', "insert into ingest.staged_records (batch_id, record_index, record_type, payload) values (1, 1, 'x', '{}')"],
    ['update staged records', "update ingest.staged_records set review_state = 'APPROVED'"],
    ['delete staged records', 'delete from ingest.staged_records'],
    ['insert import batch', "insert into ingest.import_batches (batch_key) values ('x')"],
    ['delete import batches', 'delete from ingest.import_batches'],
    ['invoke ingest.resolve_identity', "select * from ingest.resolve_identity('{}'::jsonb)"],
    ['invoke refresh_read_models', 'select public.refresh_read_models()'],
    ['invoke apply_public_boundary', 'select public.apply_public_boundary()'],
    ['read research queue (internal view)', 'select * from public.v_research_queue limit 1'],
    ['read conflict worklist', 'select * from public.v_open_fact_conflicts limit 1'],
    ['read fact resolutions (internal)', 'select * from public.fact_resolutions limit 1'],
    ['read analytics', 'select * from analytics.research_coverage_cells limit 1'],
    ['read migration history', 'select * from bai_meta.schema_migrations limit 1'],
    ['write a public table', "update public.organizations set slug = slug"],
    ['insert a source', "insert into public.sources (source_key, publisher, title, source_type) values ('x', 'x', 'x', 'OTHER')"],
    ['create a table in public', 'create table public.bai_security_probe (id int)'],
    ['list research workflow (catalog)', "select count(*) n from information_schema.tables where table_schema = 'research'", (rows) => Number(rows[0].n) === 0],
    ['read research classes', 'select * from research.classes limit 1'],
    ['read research jobs and notes', 'select notes, blocking_reason from research.jobs limit 1'],
    ['read source leads', 'select * from research.source_leads limit 1'],
    ['insert a research job', "insert into research.jobs (job_key, class_id, category_key, title, origin) values ('x', 1, 'SOURCE_CONFLICT', 'x', 'AGENT')"],
    ['certify a class', "insert into research.certifications (class_id, certified_by, coverage_state, report) values (1, 'x', 'UNKNOWN', '{}')"],
    ['record an import review', "insert into research.import_reviews (import_batch_id, reviewed_by, review_note) values (1, 'x', 'x')"],
    ['read class economics', 'select * from analytics.class_economics limit 1'],
    ['invoke refresh_research_certification', 'select public.refresh_research_certification()'],
    ['invoke resolve_organization', "select public.resolve_organization('LAD')"]
  ]
  const behaviour = []
  for (const role of PUBLIC_ROLES) {
    for (const [label, sql, okWhen] of attempts) {
      await db.query('begin')
      let outcome
      try {
        await db.query(`set local role ${role}`)
        const rows = (await db.query(sql)).rows
        outcome = okWhen && okWhen(rows) ? 'empty (no visibility)' : 'ALLOWED'
      } catch (err) {
        outcome = /permission denied|must be owner/.test(err.message) ? 'denied' : `error: ${err.message}`
      } finally { await db.query('rollback') }
      behaviour.push({ role, attempt: label, outcome })
      if (outcome === 'ALLOWED' || outcome.startsWith('error')) fail(`${role} could ${label}: ${outcome}`)
    }
    // Positive control: the public read surface works for this role.
    await db.query('begin')
    try {
      await db.query(`set local role ${role}`)
      const n = Number((await db.query('select count(*) n from public.organizations')).rows[0].n)
      behaviour.push({ role, attempt: 'read public organizations (positive control)', outcome: `allowed (${n} rows)` })
      if (n !== 30) fail(`${role} sees ${n} organizations, expected 30`)
    } catch (err) { fail(`${role} cannot read public.organizations: ${err.message}`) } finally { await db.query('rollback') }
  }

  // ---- Live Data API probe (optional; only the client-safe publishable key is used)
  const api = []
  const base = process.env.BAI_SUPABASE_URL
  const key = process.env.BAI_SUPABASE_PUBLISHABLE_KEY
  if (base && key) {
    const h = { apikey: key, Authorization: `Bearer ${key}` }
    const probe = async (label, path, init = {}, expectOk = false) => {
      const res = await fetch(`${base}/rest/v1/${path}`, { ...init, headers: { ...h, ...(init.headers ?? {}) } })
      const body = await res.text()
      const ok = expectOk ? res.ok : !res.ok
      api.push({ probe: label, status: res.status, result: ok ? 'as expected' : 'UNEXPECTED' })
      if (!ok) fail(`Data API: ${label} returned ${res.status}: ${body.slice(0, 120)}`)
    }
    await probe('read ingest.import_batches via profile', 'import_batches?select=*', { headers: { 'Accept-Profile': 'ingest' } })
    await probe('read ingest.staged_records via profile', 'staged_records?select=*', { headers: { 'Accept-Profile': 'ingest' } })
    await probe('insert ingest.staged_records via profile', 'staged_records', { method: 'POST', body: '{}', headers: { 'Content-Profile': 'ingest', 'Content-Type': 'application/json' } })
    await probe('read internal fact_resolutions', 'fact_resolutions?select=*')
    await probe('read internal research queue view', 'v_research_queue?select=*')
    await probe('call refresh_read_models', 'rpc/refresh_read_models', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } })
    await probe('insert a source', 'sources', { method: 'POST', body: JSON.stringify({ source_key: 'x' }), headers: { 'Content-Type': 'application/json' } })
    await probe('delete organizations', 'organizations?id=gt.0', { method: 'DELETE' })
    await probe('read research.jobs via profile', 'jobs?select=*', { headers: { 'Accept-Profile': 'research' } })
    await probe('read research.source_leads via profile', 'source_leads?select=*', { headers: { 'Accept-Profile': 'research' } })
    await probe('read public organizations (positive control)', 'organizations?select=franchise_key&limit=1', {}, true)
  } else notes.push('Data API probe skipped (BAI_SUPABASE_URL / BAI_SUPABASE_PUBLISHABLE_KEY not set)')

  const result = { ok: failures.length === 0, failures, notes, functions: fnAudit, behaviour, data_api: api }
  if (json) console.log(JSON.stringify(result, null, 2))
  else {
    for (const n of notes) console.log(n)
    console.log(`functions audited: ${fnAudit.length} (SECURITY DEFINER: ${fnAudit.filter((f) => f.security === 'DEFINER').length}; executable by PUBLIC/anon/authenticated: ${fnAudit.filter((f) => f.public_execute || f.anon_execute || f.authenticated_execute).length}; search_path unset: ${fnAudit.filter((f) => f.search_path === 'NOT SET').length})`)
    console.table(fnAudit.map(({ function: f, security, search_path: sp, service_role_execute: s }) => ({ function: f, security, search_path: sp, service_role_execute: s })))
    const denied = behaviour.filter((b) => b.outcome === 'denied' || b.outcome.startsWith('empty')).length
    console.log(`behavioural attempts as anon/authenticated: ${behaviour.length} (denied or invisible: ${denied})`)
    if (api.length) console.table(api)
    console.log(failures.length ? `SECURITY FAILED (${failures.length})\n  ${failures.join('\n  ')}` : 'SECURITY OK')
  }
} finally { await db.end() }
process.exit(failures.length ? 1 : 0)
