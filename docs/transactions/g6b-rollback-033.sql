-- Reverse of migration 033 (G6B): restores EXACTLY the 032-stage exposure of the seven relations. NOT a migration (it is not in database/migrations and is never applied by the runner);
-- it is the documented, tested recovery (tests/db/rest-boundary.test.mjs compares the result with a database that never had 033). It REOPENS the Data API to raw identities and
-- evidence: run it only for an unexpected website or REST failure, and only with the owner's authorization.
-- It does not change the migration ledger (033 stays recorded as applied). The correction that follows is a new migration (034), never an edit of 033.
begin;
set local lock_timeout = '5s';
do $$
declare t text;
begin
  foreach t in array array['players', 'player_external_ids', 'source_observations', 'coverage_assessments'] loop
    execute format('grant select on public.%I to anon, authenticated', t);
    execute format('drop policy if exists site_read on public.%I', t);
    execute format('drop policy if exists public_read on public.%I', t);
    execute format('create policy public_read on public.%I for select to anon, authenticated using (true)', t);
    execute format('revoke select on public.%I from bai_site', t);        -- bai_site read these through anon before 033
    delete from public.internal_objects where object_name = t and reason = 'raw identities and evidence: the website role only (no Data API access)';
  end loop;
  foreach t in array array['v_draft_explorer', 'v_player_outcome_status', 'v_source_attribution'] loop
    execute format('grant select on public.%I to anon, authenticated', t);
    execute format('revoke select on public.%I from bai_site', t);
    delete from public.internal_objects where object_name = t and reason = 'reads the raw identities and evidence: the website role only (no Data API access)';
  end loop;
end $$;
-- 033 section 3: the emergency procedure goes back to its 032 text (verbatim), and its helper goes.
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
    v_roles := array(select r from unnest(array['anon', 'authenticated']) r where has_table_privilege(r, l.table_name::regclass, 'SELECT'));
    continue when cardinality(v_roles) = 0 and not has_table_privilege('bai_site', l.table_name::regclass, 'SELECT');
    select c.relrowsecurity into v_rls from pg_class c where c.oid = l.table_name::regclass;
    select format_type(a.atttypid, null) into v_pkt from pg_attribute a where a.attrelid = l.table_name::regclass and a.attname = l.pk_cols[1];
    v_close := p_close_api or not v_rls or cardinality(l.pk_cols) <> 1 or v_pkt not in ('bigint', 'integer');
    if v_close then
      execute format('revoke select on %s from anon, authenticated', l.table_name::regclass);
      v_closed := v_closed || jsonb_build_object('table', l.table_name, 'roles', to_jsonb(v_roles));
    else
      select string_agg((x ->> l.pk_cols[1]), ',') into v_ids from jsonb_array_elements(l.pks) x;
      execute format('create policy %I on %s as restrictive for select to anon, authenticated using (not (%I = any (%L::bigint[])))', v_pol, l.table_name::regclass, l.pk_cols[1], '{' || v_ids || '}');
      v_hidden := v_hidden || jsonb_build_object('table', l.table_name, 'policy', v_pol, 'rows', l.n);
    end if;
  end loop;
  -- 2. the indirect references (rows that are not the promotion's but point at a promoted row)
  for b in select x from jsonb_array_elements(v_bad) x loop
    v_child := (b ->> 'table')::regclass; v_cname := b ->> 'table';
    v_roles := array(select r from unnest(array['anon', 'authenticated']) r where has_table_privilege(r, v_child, 'SELECT'));
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
      execute format('create policy %I on %s as restrictive for select to anon, authenticated using (%s)', v_name, v_child, v_expr);
      v_hidden := v_hidden || jsonb_build_object('table', v_cname, 'policy', v_name, 'rows', (b ->> 'rows')::integer, 'indirect', true, 'references', b ->> 'references');
    else
      execute format('revoke select on %s from anon, authenticated', v_child);
      v_closed := v_closed || jsonb_build_object('table', v_cname, 'roles', to_jsonb(v_roles), 'indirect', true, 'references', b ->> 'references');
    end if;
  end loop;
  insert into ingest.promotion_events (manifest_sha256, event, detail) values (p_sha, 'EMERGENCY_WITHDRAWN',
    jsonb_build_object('reason', p_reason, 'hidden', v_hidden, 'closed', v_closed, 'blockers', v_bad, 'close_api', p_close_api));
  return jsonb_build_object('manifest_sha256', p_sha, 'state', 'EMERGENCY', 'hidden', v_hidden, 'closed', v_closed, 'blockers', v_bad);
end $$;
drop function ingest.promotion_readers(regclass);
commit;
