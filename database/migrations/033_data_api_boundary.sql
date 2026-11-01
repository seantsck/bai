-- 033_data_api_boundary
-- The Data API (Supabase REST) loses direct read access to the raw player identities and the observation evidence; the website keeps every read through its own role.
-- Requires 032 (the website role bai_site). Does not touch 001-032, raw data, the import batches or the promotion records. (031 is reserved.)
--
-- WHY. BAI's public product is the website. Rows of players, player_external_ids, source_observations and coverage_assessments include identities and evidence that derive from sources
-- whose terms require an attribution statement wherever the data is used (Retrosheet: its notice, verbatim and prominent). A REST response cannot carry that statement, and row-level
-- security alone cannot hide rows from the planner-based counts (Prefer: count=planned|estimated, G5). Privilege denial can: a role without SELECT is refused before any plan is run.
--
-- WHAT (exactly, and nothing else):
--   1. For the four tables: GRANT SELECT to bai_site (explicit; bai_site is also a member of anon and today reads these only through anon's grant), REVOKE ALL from PUBLIC, anon and
--      authenticated, replace the policy public_read (anon, authenticated) by site_read (bai_site), and register the table in public.internal_objects so that every later
--      apply_public_boundary() keeps it closed (that function re-grants SELECT to anon/authenticated on every relation that is not registered).
--   2. For the three views that read those tables and were granted to anon/authenticated (v_draft_explorer, v_player_outcome_status, v_source_attribution): the same, so that they
--      are closed to the Data API roles by an explicit revoke and not by a failure inside the view, and stay readable by bai_site. They are security_invoker views: they read
--      the tables with the CALLER's rights, so no view can open what the tables close.
--   3. The emergency procedure of 032 (ingest.emergency_withdraw) found the readers of a table with has_table_privilege('anon'/'authenticated') and relied on the website role reading
--      "through anon". After 1 and 2 the website role holds its own grant on seven relations, so an emergency would have skipped them (hide mode: observations naming a promoted player
--      stayed readable by the website; close-api: the website's grant was not revoked). ingest.promotion_readers() adds bai_site as a reader when it holds the grant DIRECTLY, and
--      ingest.emergency_withdraw is replaced (CREATE OR REPLACE, same signature, same owner and ACL) to use it: it hides with a policy for anon, authenticated and bai_site, closes by
--      revoking from exactly the roles that held the privilege, and records those roles (ingest.promotion_reopen, unchanged, gives back exactly them). For every table whose readers are
--      anon and authenticated (all of them before 033) the behaviour is byte-for-byte that of 032. finish_withdrawal and revert_emergency are unchanged.
-- Kept readable: sources and source_attribution_statements (they carry the credit and the notice link; no identity or evidence rows).
-- Not touched: service_role (bypasses row-level security by design), the owner, bai_web, bai_site's other privileges, every function (none is executable by the Data API roles).
--
-- LOCKS. Each GRANT/REVOKE/policy statement takes a short ACCESS EXCLUSIVE lock on its table (4 tables, 3 views): milliseconds, no table rewrite. Run with lock_timeout (docs).
-- RECOVERY. A single transaction: any failure rolls back to the 032 state. After commit, docs/transactions/g6b-rest-boundary.md gives the exact reverse statements.

do $$
declare
  t text;
begin
  if not exists (select 1 from pg_roles where rolname = 'bai_site') then
    raise exception '033 requires 032: the role bai_site does not exist';
  end if;
  foreach t in array array['players', 'player_external_ids', 'source_observations', 'coverage_assessments'] loop
    if to_regclass('public.' || t) is null then raise exception '033: public.% does not exist', t; end if;
    execute format('grant select on public.%I to bai_site', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('drop policy if exists public_read on public.%I', t);
    execute format('drop policy if exists site_read on public.%I', t);
    execute format('create policy site_read on public.%I for select to bai_site using (true)', t);
    insert into public.internal_objects (object_name, reason) values (t, 'raw identities and evidence: the website role only (no Data API access)') on conflict do nothing;
  end loop;
  foreach t in array array['v_draft_explorer', 'v_player_outcome_status', 'v_source_attribution'] loop
    if to_regclass('public.' || t) is null then raise exception '033: public.% does not exist', t; end if;
    execute format('grant select on public.%I to bai_site', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    insert into public.internal_objects (object_name, reason) values (t, 'reads the raw identities and evidence: the website role only (no Data API access)') on conflict do nothing;
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 3. The emergency procedure knows the website role's own grants
-- ---------------------------------------------------------------------------------------------------------------

create function ingest.promotion_readers(p_rel regclass) returns text[]
language sql stable
set search_path = pg_catalog
as $$
  select coalesce(array_agg(r order by r), '{}'::text[])
  from unnest(array['anon', 'authenticated', 'bai_site']) r
  where case when r = 'bai_site'
             then exists (select 1 from pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
                          where c.oid = p_rel and a.privilege_type = 'SELECT' and a.grantee = 'bai_site'::regrole)   -- a DIRECT grant only: reads through anon are anon's
             else has_table_privilege(r, p_rel, 'SELECT') end
$$;
revoke all on function ingest.promotion_readers(regclass) from public, anon, authenticated;

create or replace function ingest.emergency_withdraw(p_sha text, p_reason text, p_close_api boolean default false) returns jsonb
language plpgsql
set search_path = pg_catalog, public, ingest
as $$
declare
  v_cat text; l record; b jsonb; v_pol text := 'emergency_hide_' || substr(p_sha, 1, 12); v_hidden jsonb := '[]'::jsonb; v_closed jsonb := '[]'::jsonb; v_ids text; v_pkt text; v_ckt text; v_cname text;
  v_rls boolean; v_bad jsonb; v_close boolean; v_roles text[]; v_n integer := 0; v_child regclass; v_cols text[]; v_pcols text[]; v_pl record; v_expr text; v_name text; v_by_subject boolean;
begin
  if coalesce(trim(p_reason), '') = '' then raise exception 'EMERGENCY_REFUSED: a reason is required'; end if;
  perform pg_advisory_xact_lock(hashtext('bai.promotion'));
  perform set_config('lock_timeout', '15s', true);
  if ingest.promotion_state(p_sha) is distinct from 'PROMOTED' then raise exception 'EMERGENCY_REFUSED: % is not currently promoted (%)', p_sha, coalesce(ingest.promotion_state(p_sha), 'unknown'); end if;
  select category into v_cat from ingest.promotion_manifests where manifest_sha256 = p_sha;
  v_bad := ingest.promotion_dependents(p_sha);
  perform set_config('bai.promotion_withdrawal', p_sha, true);
  perform public.rm_withdraw_category(v_cat, p_reason);
  delete from ingest.source_publication_grants where attribution_category = v_cat;
  delete from public.rm_overview; delete from public.rm_coverage_summary; delete from public.rm_organization_summary; delete from public.rm_research_queue_summary;
  -- 1. the promoted rows
  for l in select * from ingest.promotion_ledger where manifest_sha256 = p_sha order by load_order loop
    v_roles := ingest.promotion_readers(l.table_name::regclass);
    continue when cardinality(v_roles) = 0 and not has_table_privilege('bai_site', l.table_name::regclass, 'SELECT');
    select c.relrowsecurity into v_rls from pg_class c where c.oid = l.table_name::regclass;
    select format_type(a.atttypid, null) into v_pkt from pg_attribute a where a.attrelid = l.table_name::regclass and a.attname = l.pk_cols[1];
    v_close := p_close_api or not v_rls or cardinality(l.pk_cols) <> 1 or v_pkt not in ('bigint', 'integer');
    if v_close then
      if cardinality(v_roles) > 0 then execute format('revoke select on %s from %s', l.table_name::regclass, (select string_agg(quote_ident(r), ', ') from unnest(v_roles) r)); end if;
      v_closed := v_closed || jsonb_build_object('table', l.table_name, 'roles', to_jsonb(v_roles));
    else
      select string_agg((x ->> l.pk_cols[1]), ',') into v_ids from jsonb_array_elements(l.pks) x;
      execute format('create policy %I on %s as restrictive for select to anon, authenticated, bai_site using (not (%I = any (%L::bigint[])))', v_pol, l.table_name::regclass, l.pk_cols[1], '{' || v_ids || '}');
      v_hidden := v_hidden || jsonb_build_object('table', l.table_name, 'policy', v_pol, 'rows', l.n);
    end if;
  end loop;
  -- 2. the indirect references (rows that are not the promotion's but point at a promoted row)
  for b in select x from jsonb_array_elements(v_bad) x loop
    v_child := (b ->> 'table')::regclass; v_cname := b ->> 'table';
    v_roles := ingest.promotion_readers(v_child);
    continue when cardinality(v_roles) = 0;                                  -- not readable by the public roles: nothing to protect
    select * into v_pl from ingest.promotion_ledger where manifest_sha256 = p_sha and table_name = b ->> 'references';
    select c.relrowsecurity into v_rls from pg_class c where c.oid = v_child;
    v_by_subject := b ->> 'kind' = 'by subject';
    v_cols := array(select jsonb_array_elements_text(coalesce(b -> 'columns', '[]'::jsonb))); v_pcols := array(select jsonb_array_elements_text(coalesce(b -> 'parent_columns', '[]'::jsonb)));
    v_expr := null;
    if not p_close_api and v_rls and cardinality(v_pl.pk_cols) = 1 then
      select string_agg((x ->> v_pl.pk_cols[1]), ',') into v_ids from jsonb_array_elements(v_pl.pks) x;
      if v_by_subject then
        v_expr := format('not (subject_table = %L and subject_id = any (%L::bigint[]))', b ->> 'subject_table', '{' || v_ids || '}');
      elsif cardinality(v_cols) = 1 and cardinality(v_pcols) = 1 and v_pcols[1] = v_pl.pk_cols[1] then
        select format_type(a.atttypid, null) into v_ckt from pg_attribute a where a.attrelid = v_child and a.attname = v_cols[1];
        if v_ckt in ('bigint', 'integer') then v_expr := format('coalesce(not (%I = any (%L::bigint[])), true)', v_cols[1], '{' || v_ids || '}'); end if;
      end if;
    end if;
    if v_expr is not null then
      v_n := v_n + 1; v_name := v_pol || '_ref' || v_n;
      execute format('create policy %I on %s as restrictive for select to anon, authenticated, bai_site using (%s)', v_name, v_child, v_expr);
      v_hidden := v_hidden || jsonb_build_object('table', v_cname, 'policy', v_name, 'rows', (b ->> 'rows')::integer, 'indirect', true, 'references', b ->> 'references');
    else
      execute format('revoke select on %s from %s', v_child, (select string_agg(quote_ident(r), ', ') from unnest(v_roles) r));
      v_closed := v_closed || jsonb_build_object('table', v_cname, 'roles', to_jsonb(v_roles), 'indirect', true, 'references', b ->> 'references');
    end if;
  end loop;
  insert into ingest.promotion_events (manifest_sha256, event, detail) values (p_sha, 'EMERGENCY_WITHDRAWN',
    jsonb_build_object('reason', p_reason, 'hidden', v_hidden, 'closed', v_closed, 'blockers', v_bad, 'close_api', p_close_api));
  return jsonb_build_object('manifest_sha256', p_sha, 'state', 'EMERGENCY', 'hidden', v_hidden, 'closed', v_closed, 'blockers', v_bad);
end $$;
