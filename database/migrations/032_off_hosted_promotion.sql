-- 032_off_hosted_promotion
-- Off-hosted staging, atomic promotion and owner-controlled withdrawal of reviewed data, plus a dedicated read-only website role. (031 is reserved by docs/transactions/later-added/proposal.md.)
--
-- WHY. Imported rows are inserted into the same tables the Data API reads, and row-level hiding of rows that exist (a "hold") cannot be made leak-free: the planner estimates that PostgREST
-- returns for Prefer: count=planned|estimated are made from the whole table, and a repeated Prefer header reaches PostgREST past any pre-request guard. So nothing is held on the hosted
-- database. The six batches are imported and validated OFF-HOSTED, from a restored baseline backup; what is reviewed is an insert-only DELTA, described by an immutable MANIFEST; and the delta is
-- PROMOTED into the hosted database in one transaction, by the owner, after the baseline has been proven identical. Withdrawal deletes exactly the promoted rows (the LEDGER), in one transaction.
--
-- This migration changes no existing table or row. It adds (and, in section 6, replaces two 030 functions and adds three indexes; see there):
--   1. the promotion records (manifest, ledger, events, withheld evidence), all append-only, all private to the owner (the ingest schema is not exposed);
--   2. the promotion protocol: promote_begin / promote_load / promote_withhold / promote_commit, which is ONE client transaction and commits everything or nothing;
--   3. withdrawal: withdraw_promotion (atomic, refuses to touch anything another row depends on) and, for the case where physical deletion is blocked, an emergency procedure that
--      stops public exposure at once without deleting an unrelated row: emergency_withdraw / finish_withdrawal / revert_emergency;
--   4. the website role bai_site, so that the 12 rm_transaction* tables can be closed to the Data API roles (anon, authenticated) while the website keeps reading them;
--   5. v_transaction_record_sources, the one owner-rights view, so that v_source_attribution keeps working for Data API consumers without any access to the closed tables.
-- Nothing here publishes anything. The grant (025/030) still governs the transaction read model; a promotion is only the act of writing reviewed rows.

-- ---------------------------------------------------------------------------------------------------------------
-- 1. Records
-- ---------------------------------------------------------------------------------------------------------------

create table ingest.promotion_manifests (
  manifest_sha256 text primary key check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  manifest_text text not null,
  category text not null,
  created_at timestamptz not null default now(),
  created_by text not null default session_user,
  check (encode(sha256(convert_to(manifest_text, 'utf8')), 'hex') = manifest_sha256)
);
create table ingest.promotion_ledger (
  manifest_sha256 text not null references ingest.promotion_manifests (manifest_sha256),
  load_order integer not null,
  table_name text not null,
  pk_cols text[] not null,
  pks jsonb not null,
  n integer not null check (n > 0),
  primary key (manifest_sha256, table_name)
);
create table ingest.promotion_events (
  id bigint generated always as identity primary key,
  manifest_sha256 text not null references ingest.promotion_manifests (manifest_sha256),
  event text not null check (event in ('PROMOTED', 'WITHDRAWN', 'EMERGENCY_WITHDRAWN', 'EMERGENCY_REVERTED')),
  at timestamptz not null default now(),
  by text not null default session_user,
  detail jsonb not null default '{}'
);
-- Evidence deliberately NOT promoted (the manifest names the rule and the hash): kept here, privately, with the promotion it belongs to.
create table ingest.promotion_withheld_rows (
  manifest_sha256 text not null references ingest.promotion_manifests (manifest_sha256),
  table_name text not null,
  rule text not null,
  n integer not null check (n > 0),
  rows_sha256 text not null check (rows_sha256 ~ '^[0-9a-f]{64}$'),
  rows jsonb not null,
  primary key (manifest_sha256, table_name)
);

create function ingest.promotion_append_only() returns trigger language plpgsql set search_path = pg_catalog as $$
begin raise exception '% is append-only', tg_table_name using errcode = 'integrity_constraint_violation'; end $$;
create trigger promotion_manifests_append_only before update or delete on ingest.promotion_manifests for each row execute function ingest.promotion_append_only();
create trigger promotion_ledger_append_only before update or delete on ingest.promotion_ledger for each row execute function ingest.promotion_append_only();
create trigger promotion_events_append_only before update or delete on ingest.promotion_events for each row execute function ingest.promotion_append_only();
create trigger promotion_withheld_append_only before update or delete on ingest.promotion_withheld_rows for each row execute function ingest.promotion_append_only();
create trigger promotion_manifests_no_truncate before truncate on ingest.promotion_manifests for each statement execute function ingest.promotion_append_only();
create trigger promotion_ledger_no_truncate before truncate on ingest.promotion_ledger for each statement execute function ingest.promotion_append_only();
create trigger promotion_events_no_truncate before truncate on ingest.promotion_events for each statement execute function ingest.promotion_append_only();
create trigger promotion_withheld_no_truncate before truncate on ingest.promotion_withheld_rows for each statement execute function ingest.promotion_append_only();

-- The state of a manifest, from its events: PROMOTED, EMERGENCY (hidden but still physically present), WITHDRAWN, or null (never promoted).
create function ingest.promotion_state(p_sha text) returns text language sql stable set search_path = pg_catalog, ingest as $$
  select case e.event when 'PROMOTED' then 'PROMOTED' when 'EMERGENCY_REVERTED' then 'PROMOTED' when 'EMERGENCY_WITHDRAWN' then 'EMERGENCY' when 'WITHDRAWN' then 'WITHDRAWN' end
  from ingest.promotion_events e where e.manifest_sha256 = p_sha order by e.id desc limit 1
$$;
create function ingest.promotion_in_emergency() returns boolean language sql stable set search_path = pg_catalog, ingest as $$
  select exists (select 1 from ingest.promotion_manifests m where ingest.promotion_state(m.manifest_sha256) = 'EMERGENCY')
$$;

-- The tables whose content must be identical to the staged baseline: every base table of the three data schemas except the promotion records and the refresh caches.
create function ingest.promotion_scope() returns text[] language sql stable set search_path = pg_catalog as $$
  select coalesce(array_agg(n.nspname || '.' || c.relname order by n.nspname collate "C", c.relname collate "C"), '{}')
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p') and n.nspname in ('public', 'ingest', 'research')
    and not (n.nspname = 'ingest' and c.relname like 'promotion\_%')
    and not (n.nspname = 'public' and (c.relname like 'rm\_%' or c.relname = 'read_model_refreshes'))
$$;

-- Row-content fingerprint, independent of session settings, physical order, collation and the server it runs on (a local restore and the hosted database give the same value for the same rows).
create function ingest.promotion_fingerprint(p_table text) returns jsonb
language plpgsql stable
set search_path = pg_catalog, public, ingest
set timezone = 'UTC' set datestyle = 'ISO, YMD' set extra_float_digits = 1 set bytea_output = 'hex' set intervalstyle = 'postgres'
as $$
declare r record;
begin
  execute format('select count(*)::bigint as n, md5(coalesce(string_agg(h, '''' order by h collate "C"), '''')) as d from (select md5(t::text) as h from %s t) s', p_table::regclass) into r;
  return jsonb_build_object('n', r.n, 'md5', r.d);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 2. Promotion: ONE client transaction, owner connection
--      begin;
--      select ingest.promote_begin(<manifest text>);                 -- 'READY', or 'ALREADY_PROMOTED' (a no-op), or an exception
--      select ingest.promote_load('<table>', <rows jsonb>);          -- once per table, in the manifest's load order
--      select ingest.promote_withhold('<table>', <rows as text>);    -- once per excluded table (evidence kept privately, not promoted)
--      select ingest.promote_commit();
--      commit;
-- A failure at any point, or a lost connection, aborts the transaction: nothing of the promotion is visible. The caller never guesses after a lost
-- acknowledgement: it asks ingest.promotion_status(<sha>).
-- ---------------------------------------------------------------------------------------------------------------

create function ingest.promote_begin(p_manifest text) returns text
language plpgsql
set search_path = pg_catalog, public, ingest
as $$
declare
  m jsonb := p_manifest::jsonb;
  v_sha text := encode(sha256(convert_to(p_manifest, 'utf8')), 'hex');
  v_cat text := m ->> 'category';
  v_state text; g record; v_stmt text; v_mig jsonb; v_scope text[]; t text; fp jsonb;
begin
  perform pg_advisory_xact_lock(hashtext('bai.promotion'));
  if m ->> 'format' is distinct from 'bai-promotion/1' then raise exception 'PROMOTION_REFUSED: unknown manifest format'; end if;
  v_state := ingest.promotion_state(v_sha);
  if v_state = 'PROMOTED' then return 'ALREADY_PROMOTED'; end if;
  if v_state = 'EMERGENCY' then raise exception 'PROMOTION_REFUSED: this manifest is under emergency withdrawal'; end if;
  if v_state = 'WITHDRAWN' then raise exception 'PROMOTION_REFUSED: this manifest was withdrawn; stage a new one from a fresh baseline'; end if;
  if ingest.promotion_in_emergency() then raise exception 'PROMOTION_REFUSED: another promotion is under emergency withdrawal; finish or revert it first'; end if;

  -- permission: the recorded grant, bound to the exact text the owner recorded, inside its authorization window
  select * into g from ingest.source_publication_grants where attribution_category = v_cat;
  if not found then raise exception 'PROMOTION_REFUSED: no publication grant for %', v_cat; end if;
  if encode(sha256(convert_to(g.basis_reference || E'\n' || g.scope_note, 'utf8')), 'hex') is distinct from m #>> '{authorization,grant_binding_sha256}' then
    raise exception 'PROMOTION_REFUSED: the grant on this database is not the one the manifest was built against'; end if;
  if current_date < (m #>> '{authorization,effective_from}')::date or current_date > (m #>> '{authorization,expires_on}')::date then
    raise exception 'PROMOTION_REFUSED: outside the authorization window (% to %)', m #>> '{authorization,effective_from}', m #>> '{authorization,expires_on}'; end if;
  -- attribution: the statement the database carries is the one the live pages were verified against, and that check is recent
  select statement into v_stmt from public.source_attribution_statements where attribution_category = v_cat;
  if v_stmt is null or encode(sha256(convert_to(v_stmt, 'utf8')), 'hex') is distinct from m #>> '{attribution,statement_sha256}' then
    raise exception 'PROMOTION_REFUSED: the attribution statement differs from the verified one'; end if;
  if coalesce(m #>> '{attribution,evidence_sha256}', '') !~ '^[0-9a-f]{64}$' then raise exception 'PROMOTION_REFUSED: no attribution evidence in the manifest'; end if;
  if (m #>> '{attribution,verified_at}')::timestamptz < now() - make_interval(hours => (m #>> '{attribution,max_age_hours}')::int) or (m #>> '{attribution,verified_at}')::timestamptz > now() + interval '5 minutes' then
    raise exception 'PROMOTION_REFUSED: the attribution verification is stale (older than % hours)', m #>> '{attribution,max_age_hours}'; end if;
  -- schema level
  select jsonb_object_agg(version, checksum) into v_mig from bai_meta.schema_migrations;
  if v_mig is distinct from m -> 'migrations' then raise exception 'DRIFT: the migration level or a checksum differs from the manifest'; end if;

  -- no concurrent writer: every table in scope is locked against writes (readers are not blocked) before anything is compared
  v_scope := ingest.promotion_scope();
  if (select array_agg(x order by x collate "C") from jsonb_array_elements_text(m #> '{baseline,scope}') x) is distinct from (select array_agg(x order by x collate "C") from unnest(v_scope) x) then raise exception 'DRIFT: the set of tables differs from the manifest'; end if;
  perform set_config('lock_timeout', '15s', true);
  execute 'lock table ' || (select string_agg(x::regclass::text, ', ') from unnest(v_scope) x) || ' in share row exclusive mode';
  foreach t in array v_scope loop
    fp := ingest.promotion_fingerprint(t);
    if fp is distinct from m #> array['baseline', 'fingerprints', t] then raise exception 'DRIFT: % changed since the baseline was taken (now %, manifest %)', t, fp, m #> array['baseline', 'fingerprints', t]; end if;
  end loop;

  perform set_config('bai.promotion', v_sha, true);
  create temp table _promo_manifest (m jsonb not null, t text not null) on commit drop;
  insert into _promo_manifest values (m, p_manifest);
  create temp table _promo_pk (table_name text not null, pk jsonb not null) on commit drop;
  create temp table _promo_loaded (table_name text primary key, n integer not null) on commit drop;
  create temp table _promo_withheld (table_name text primary key, rule text not null, n integer not null, rows_sha256 text not null, rows jsonb not null) on commit drop;
  return 'READY';
end $$;

create function ingest.promote_load(p_table text, p_rows jsonb) returns integer
language plpgsql
set search_path = pg_catalog, public, ingest
as $$
declare
  v_sha text := nullif(current_setting('bai.promotion', true), '');
  m jsonb; v_cols text; v_pk text; n integer;
begin
  if v_sha is null then raise exception 'PROMOTION_REFUSED: no promotion is open in this transaction'; end if;
  select pm.m into m from _promo_manifest pm;
  if not (m -> 'load_order') ? p_table then raise exception 'PROMOTION_REFUSED: % is not in the manifest', p_table; end if;
  if exists (select 1 from _promo_loaded where table_name = p_table) then raise exception 'PROMOTION_REFUSED: % was already loaded', p_table; end if;
  select string_agg(quote_ident(a.attname), ', ' order by a.attnum) into v_cols from pg_attribute a where a.attrelid = p_table::regclass and a.attnum > 0 and not a.attisdropped and a.attgenerated = '';
  select string_agg(quote_ident(a.attname), ', ' order by k.ord) into v_pk from pg_index i cross join lateral unnest(i.indkey) with ordinality k(attnum, ord)
    join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum where i.indrelid = p_table::regclass and i.indisprimary;
  execute format('insert into %s (%s) overriding system value select %s from jsonb_populate_recordset(null::%s, $1)', p_table::regclass, v_cols, v_cols, p_table::regclass) using p_rows;
  get diagnostics n = row_count;
  if n <> (m #>> array['delta', p_table, 'n'])::integer then raise exception 'PROMOTION_REFUSED: % has % rows, the manifest says %', p_table, n, m #>> array['delta', p_table, 'n']; end if;
  execute format('insert into _promo_pk select %L, to_jsonb(r) from (select %s from jsonb_populate_recordset(null::%s, $1)) r', p_table, v_pk, p_table::regclass) using p_rows;
  insert into _promo_loaded values (p_table, n);
  return n;
end $$;

-- Evidence the manifest excludes from the public delta: checked against the manifest's hash, held in the transaction, written to the private table at commit.
create function ingest.promote_withhold(p_table text, p_rows_text text) returns integer
language plpgsql
set search_path = pg_catalog, public, ingest
as $$
declare
  v_sha text := nullif(current_setting('bai.promotion', true), '');
  m jsonb; ex jsonb; v_hash text := encode(sha256(convert_to(p_rows_text, 'utf8')), 'hex'); v_rows jsonb; n integer;
begin
  if v_sha is null then raise exception 'PROMOTION_REFUSED: no promotion is open in this transaction'; end if;
  select pm.m into m from _promo_manifest pm;
  select x into ex from jsonb_array_elements(m -> 'exclusions') x where x ->> 'table' = p_table;
  if ex is null then raise exception 'PROMOTION_REFUSED: % is not an excluded table in the manifest', p_table; end if;
  if v_hash is distinct from ex ->> 'rows_sha256' then raise exception 'PROMOTION_REFUSED: the withheld rows of % do not match the manifest hash', p_table; end if;
  v_rows := p_rows_text::jsonb; n := jsonb_array_length(v_rows);
  if n <> (ex ->> 'n')::integer then raise exception 'PROMOTION_REFUSED: % withheld rows, the manifest says %', n, ex ->> 'n'; end if;
  if exists (select 1 from _promo_withheld where table_name = p_table) then raise exception 'PROMOTION_REFUSED: % was already withheld', p_table; end if;
  insert into _promo_withheld values (p_table, ex ->> 'rule', n, v_hash, v_rows);
  return n;
end $$;

create function ingest.promote_commit() returns jsonb
language plpgsql
set search_path = pg_catalog, public, ingest
as $$
declare
  v_sha text := nullif(current_setting('bai.promotion', true), '');
  m jsonb; p_text text; t text; fp jsonb; want jsonb; v_total integer; sq record; v_seq text; v_cur bigint; v_batches text[]; v_want text[]; v_ord integer := 0; v_stmt text;
begin
  if v_sha is null then raise exception 'PROMOTION_REFUSED: no promotion is open in this transaction'; end if;
  select pm.m, pm.t into m, p_text from _promo_manifest pm;
  if exists (select 1 from jsonb_array_elements_text(m -> 'load_order') x where x not in (select table_name from _promo_loaded)) then raise exception 'PROMOTION_REFUSED: not every manifest table was loaded'; end if;
  if (select count(*) from jsonb_array_elements(coalesce(m -> 'exclusions', '[]')) x where x ->> 'table' in (select table_name from _promo_withheld)) <> jsonb_array_length(coalesce(m -> 'exclusions', '[]')) then
    raise exception 'PROMOTION_REFUSED: not every excluded table was withheld'; end if;
  -- the whole state, table by table, is exactly the staged release state: changed tables equal the manifest's "after", every other table still equals the baseline
  foreach t in array ingest.promotion_scope() loop
    fp := ingest.promotion_fingerprint(t);
    want := coalesce(m #> array['after', t], m #> array['baseline', 'fingerprints', t]);
    if fp is distinct from want then raise exception 'PROMOTION_REFUSED: % does not match the staged state after loading (now %, staged %)', t, fp, want; end if;
  end loop;
  select array_agg(b.file_sha256 order by b.file_sha256 collate "C") into v_batches from ingest.import_batches b where b.id in (select (pk ->> 'id')::bigint from _promo_pk where table_name = 'ingest.import_batches');
  select array_agg(x ->> 'sha256' order by (x ->> 'sha256') collate "C") into v_want from jsonb_array_elements(m -> 'batches') x;
  if v_batches is distinct from v_want then raise exception 'PROMOTION_REFUSED: the promoted batches are not exactly the manifest''s batches'; end if;
  -- the attribution statement, verbatim, is in the metadata of every source of the category that this promotion adds
  select statement into v_stmt from public.source_attribution_statements where attribution_category = m ->> 'category';
  if exists (select 1 from public.sources s where s.id in (select (pk ->> 'id')::bigint from _promo_pk where table_name = 'public.sources')
             and s.attribution_category = m ->> 'category' and (s.notes is null or position(v_stmt in s.notes) = 0)) then
    raise exception 'PROMOTION_REFUSED: a promoted % source does not carry the attribution statement verbatim in its notes', m ->> 'category'; end if;

  insert into ingest.promotion_manifests (manifest_sha256, manifest_text, category) values (v_sha, p_text, m ->> 'category');
  for t in select x from jsonb_array_elements_text(m -> 'load_order') x loop
    v_ord := v_ord + 1;
    insert into ingest.promotion_ledger (manifest_sha256, load_order, table_name, pk_cols, pks, n)
    select v_sha, v_ord, t, array(select jsonb_object_keys((select pk from _promo_pk where table_name = t limit 1)) order by 1), jsonb_agg(pk), count(*)::integer from _promo_pk where table_name = t;
  end loop;
  insert into ingest.promotion_withheld_rows (manifest_sha256, table_name, rule, n, rows_sha256, rows) select v_sha, table_name, rule, n, rows_sha256, rows from _promo_withheld;
  select count(*)::integer into v_total from _promo_pk;
  insert into ingest.promotion_events (manifest_sha256, event, detail) values (v_sha, 'PROMOTED', jsonb_build_object('rows', v_total, 'tables', v_ord, 'withheld_tables', (select count(*) from _promo_withheld)));
  -- last, because a sequence is not transactional: it only ever moves forward, so ids of withdrawn rows are never reused
  for sq in select key as tbl, value::bigint as val from jsonb_each_text(m -> 'sequences') loop
    v_seq := pg_get_serial_sequence(sq.tbl, 'id');
    if v_seq is not null then
      v_cur := coalesce(pg_sequence_last_value(v_seq::regclass), 0);
      perform setval(v_seq, greatest(sq.val, v_cur, 1), true);
    end if;
  end loop;
  return jsonb_build_object('manifest_sha256', v_sha, 'rows', v_total, 'tables', v_ord);
end $$;

-- Recovery after a lost connection or acknowledgement: the database is the only authority on whether a promotion happened.
create function ingest.promotion_status(p_sha text) returns jsonb language sql stable set search_path = pg_catalog, ingest as $$
  select jsonb_build_object('manifest_sha256', p_sha, 'state', coalesce(ingest.promotion_state(p_sha), 'NOT_PROMOTED'),
    'events', coalesce((select jsonb_agg(jsonb_build_object('event', e.event, 'at', e.at, 'by', e.by) order by e.id) from ingest.promotion_events e where e.manifest_sha256 = p_sha), '[]'::jsonb),
    'ledger_rows', coalesce((select sum(l.n) from ingest.promotion_ledger l where l.manifest_sha256 = p_sha), 0),
    'withheld_rows', coalesce((select sum(w.n) from ingest.promotion_withheld_rows w where w.manifest_sha256 = p_sha), 0))
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- 3. Withdrawal
-- ---------------------------------------------------------------------------------------------------------------

-- Rows that depend on a promoted row without being part of the promotion: a foreign key from any schema (the rm_* caches excepted: they cascade and are recomputed), and an
-- observation or decision that names a promoted player or transaction by subject, which no foreign key shows. Deleting the promoted rows would cascade-delete or orphan them.
create function ingest.promotion_dependents(p_sha text) returns jsonb
language plpgsql stable
set search_path = pg_catalog, public, ingest
as $$
declare
  f record; l record; v_tables text[]; v_bad jsonb := '[]'::jsonb; v_cnt bigint; v_child_pk text; v_child_ledger jsonb;
begin
  select array_agg(table_name) into v_tables from ingest.promotion_ledger where manifest_sha256 = p_sha;
  for f in select x.* from (select
       (select k.relnamespace::regnamespace::text || '.' || k.relname from pg_class k where k.oid = c.conrelid) as child,
       (select k.relnamespace::regnamespace::text || '.' || k.relname from pg_class k where k.oid = c.confrelid) as parent,
       (select string_agg('ch.' || quote_ident(a.attname), ', ' order by k.ord) from unnest(c.conkey) with ordinality k(attnum, ord) join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) as ccols,
       (select string_agg('p.' || quote_ident(a.attname), ', ' order by k.ord) from unnest(c.confkey) with ordinality k(attnum, ord) join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.attnum) as pcols,
       (select array_agg(a.attname::text order by k.ord) from unnest(c.conkey) with ordinality k(attnum, ord) join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) as cnames,
       (select array_agg(a.attname::text order by k.ord) from unnest(c.confkey) with ordinality k(attnum, ord) join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.attnum) as pnames
     from pg_constraint c where c.contype = 'f') x
     where x.parent = any (v_tables) and x.child !~ '^public\.rm_' loop
    select pks into l from ingest.promotion_ledger where manifest_sha256 = p_sha and table_name = f.parent;
    select lg.pks, (select string_agg('ch.' || quote_ident(x), ', ') from unnest(lg.pk_cols) x) into v_child_ledger, v_child_pk from ingest.promotion_ledger lg where lg.manifest_sha256 = p_sha and lg.table_name = f.child;
    if v_child_ledger is null then
      execute format('select count(*) from %s ch where exists (select 1 from jsonb_populate_recordset(null::%s, $1) p where (%s) = (%s))', f.child, f.parent, f.ccols, f.pcols) into v_cnt using l.pks;
    else
      execute format('select count(*) from %s ch where exists (select 1 from jsonb_populate_recordset(null::%s, $1) p where (%s) = (%s)) and not exists (select 1 from jsonb_populate_recordset(null::%s, $2) cp where (%s) = (%s))',
        f.child, f.parent, f.ccols, f.pcols, f.child, v_child_pk, replace(v_child_pk, 'ch.', 'cp.')) into v_cnt using l.pks, v_child_ledger;
    end if;
    if v_cnt > 0 then v_bad := v_bad || jsonb_build_object('table', f.child, 'references', f.parent, 'rows', v_cnt, 'columns', to_jsonb(f.cnames), 'parent_columns', to_jsonb(f.pnames)); end if;
  end loop;
  for f in select x.t from unnest(array['public.source_observations', 'public.fact_resolutions']) x(t) where to_regclass(x.t) is not null loop
    for l in select table_name, pks from ingest.promotion_ledger where manifest_sha256 = p_sha and table_name in ('public.players', 'public.transactions') loop
      execute format('select count(*) from %s o where o.subject_table = %L and exists (select 1 from jsonb_populate_recordset(null::%s, $1) p where p.id = o.subject_id) and not exists (select 1 from jsonb_populate_recordset(null::public.source_observations, $2) po where po.id = o.id)',
        f.t, substr(l.table_name, 8), l.table_name::regclass) into v_cnt using l.pks,
        case when f.t = 'public.source_observations' then coalesce((select pks from ingest.promotion_ledger where manifest_sha256 = p_sha and table_name = 'public.source_observations'), '[]'::jsonb) else '[]'::jsonb end;
      if v_cnt > 0 then v_bad := v_bad || jsonb_build_object('table', f.t, 'references', l.table_name, 'rows', v_cnt, 'kind', 'by subject', 'subject_table', substr(l.table_name, 8)); end if;
    end loop;
  end loop;
  return v_bad;
end $$;

-- The deletion itself, newest dependency first, each count checked against the ledger; used by withdrawal and by the end of an emergency withdrawal.
create function ingest.promotion_delete_rows(p_sha text) returns integer
language plpgsql
set search_path = pg_catalog, public, ingest
as $$
declare l record; v_deleted integer; v_total integer := 0;
begin
  for l in select * from ingest.promotion_ledger where manifest_sha256 = p_sha order by load_order desc loop
    execute format('delete from %s t using (select * from jsonb_populate_recordset(null::%s, $1)) l where %s', l.table_name::regclass, l.table_name::regclass,
      (select string_agg('t.' || quote_ident(x) || ' = l.' || quote_ident(x), ' and ') from unnest(l.pk_cols) x)) using l.pks;
    get diagnostics v_deleted = row_count;
    if v_deleted <> l.n then raise exception 'WITHDRAWAL_REFUSED: % deleted % of % rows; nothing was changed', l.table_name, v_deleted, l.n; end if;
    v_total := v_total + v_deleted;
  end loop;
  return v_total;
end $$;

-- Before a promotion's rows are deleted, the published read model must hold none of its transactions (withdraw_promotion and finish_withdrawal withdraw the category first). The row
-- triggers that the deletes fire (rm_facts_changed and the like) would otherwise look for rows to withdraw once per deleted row; with the read model proven clean they are told so
-- (bai.promotion_rm_clean), which skips that probe. Measured at full scale (G5-5C): the probe cost 0.01 ms per call on a freshly emptied table and 0.74 ms per call on one that had been
-- emptied, analyzed and left bloated, because the planner then has no row estimate left to tell the primary key from a full index scan; 50,000 calls took 37 s of a 54 s finish.
create function ingest.promotion_rm_assert_clean(p_sha text) returns void
language plpgsql stable
set search_path = pg_catalog, public, ingest
as $$
declare v_left bigint;
begin
  select count(*) into v_left from ingest.promotion_ledger l, jsonb_to_recordset(l.pks) as x(id bigint), public.rm_transactions r
   where l.manifest_sha256 = p_sha and l.table_name = 'public.transactions' and r.transaction_id = x.id;
  if v_left > 0 then raise exception 'WITHDRAWAL_REFUSED: % promoted transactions are still in the published read model; nothing was changed', v_left; end if;
end $$;

-- PLANNER STATISTICS. PostgREST answers Prefer: count=planned and count=estimated from the planner's estimate (pg_class.reltuples and the column statistics), and a DELETE leaves those
-- at the pre-withdrawal size until ANALYZE: right after a withdrawal a client could read how many rows were withdrawn. So the withdrawal analyzes every table it changed (and the cached
-- summaries that count them) IN ITS OWN TRANSACTION, last, and refuses (rolls back) if an estimate still overstates the live row count. Measured against a real PostgREST (G5-5C):
-- the column statistics become visible at COMMIT with the deletes; reltuples is updated in place, so count=planned shows the new, SMALLER size slightly before the commit and, after a
-- rolled-back withdrawal, keeps showing it until the next ANALYZE (an under-count, never an over-count: the tool repairs it with promotion_analyze). Hiding rows (emergency, no p_close_api)
-- cannot be helped this way: the hidden rows are still live rows.
create function ingest.promotion_analyze(p_sha text) returns jsonb
language plpgsql
set search_path = pg_catalog, public, ingest
as $$
declare v_tables text[]; t text; v_live bigint; v_est real; v_bad jsonb := '[]'::jsonb; v_n integer := 0;
begin
  select array_agg(x order by x) into v_tables from (
    select table_name as x from ingest.promotion_ledger where manifest_sha256 = p_sha
    union select unnest(array['public.rm_overview', 'public.rm_coverage_summary', 'public.rm_organization_summary', 'public.rm_research_queue_summary'])) y;
  execute 'analyze ' || (select string_agg(x::regclass::text, ', ') from unnest(v_tables) x);
  foreach t in array v_tables loop
    execute format('select count(*) from %s', t::regclass) into v_live;
    select c.reltuples into v_est from pg_class c where c.oid = t::regclass;
    if v_est > v_live * 1.25 + 100 then v_bad := v_bad || jsonb_build_object('table', t, 'live_rows', v_live, 'estimate', v_est); end if;
    v_n := v_n + 1;
  end loop;
  if jsonb_array_length(v_bad) > 0 then raise exception 'WITHDRAWAL_REFUSED: the planner statistics still overstate the table sizes (a count=planned request would show them): %', v_bad; end if;
  return jsonb_build_object('tables_analyzed', v_n);
end $$;

-- The normal withdrawal: one transaction; refuses while anything unrelated depends on a promoted row; leaves the grant alone unless asked.
create function ingest.withdraw_promotion(p_sha text, p_reason text, p_withdraw_grant boolean default false) returns jsonb
language plpgsql
set search_path = pg_catalog, public, ingest
as $$
declare v_state text; v_cat text; v_bad jsonb; v_total integer; v_stats jsonb;
begin
  if coalesce(trim(p_reason), '') = '' then raise exception 'WITHDRAWAL_REFUSED: a reason is required'; end if;
  perform pg_advisory_xact_lock(hashtext('bai.promotion'));
  perform set_config('lock_timeout', '15s', true);
  v_state := ingest.promotion_state(p_sha);
  if v_state is distinct from 'PROMOTED' then raise exception 'WITHDRAWAL_REFUSED: % is not currently promoted (%)', p_sha, coalesce(v_state, 'unknown'); end if;
  select category into v_cat from ingest.promotion_manifests where manifest_sha256 = p_sha;
  execute 'lock table ' || (select string_agg(x::regclass::text, ', ') from unnest(ingest.promotion_scope()) x) || ' in share row exclusive mode';
  v_bad := ingest.promotion_dependents(p_sha);
  if jsonb_array_length(v_bad) > 0 then
    raise exception 'WITHDRAWAL_REFUSED: unrelated rows reference the promoted data. Remove or re-point them, or use ingest.emergency_withdraw to stop public exposure now: %', v_bad;
  end if;
  perform set_config('bai.promotion_withdrawal', p_sha, true);
  perform public.rm_withdraw_category(v_cat, p_reason);                 -- the published read model first
  perform ingest.promotion_rm_assert_clean(p_sha);
  perform set_config('bai.promotion_rm_clean', p_sha, true);            -- ... so the row triggers below have nothing to withdraw
  v_total := ingest.promotion_delete_rows(p_sha);
  perform set_config('bai.promotion_rm_clean', '', true);
  if p_withdraw_grant then delete from ingest.source_publication_grants where attribution_category = v_cat; end if;
  insert into ingest.promotion_events (manifest_sha256, event, detail) values (p_sha, 'WITHDRAWN', jsonb_build_object('reason', p_reason, 'rows', v_total, 'grant_withdrawn', p_withdraw_grant));
  perform public.refresh_read_models();                                 -- every cached summary recomputed from the withdrawn state, in this transaction
  perform public.refresh_transaction_read_models();
  v_stats := ingest.promotion_analyze(p_sha);                           -- last: the planner estimates now describe the withdrawn state, and become visible with the commit
  return jsonb_build_object('manifest_sha256', p_sha, 'rows_deleted', v_total, 'grant_withdrawn', p_withdraw_grant, 'statistics', v_stats);
end $$;

-- EMERGENCY. Public exposure must stop now, and physical deletion is blocked by rows that are not the promotion's. In ONE transaction this
--   * withdraws the transaction read model and deletes the category's grant (nothing can republish it);
--   * empties the cached summaries that count promoted rows, and makes every refresh fail until the emergency is resolved (a refresh would count them again);
--   * hides every promoted row from the Data API roles and the website (anon, authenticated, and bai_site through anon) with a RESTRICTIVE row-level policy per readable table;
--     with p_close_api the readable tables are instead closed to those roles altogether (the trade-off: those public endpoints stop answering until the emergency is resolved);
--   * does the same for the INDIRECT references: a publicly readable row that is not part of the promotion but points at a promoted row (a foreign key, or an observation naming a
--     promoted player or transaction by subject) would reveal the withdrawn identity, so it is hidden too (or, when it cannot be hidden by a policy on one column, or with p_close_api,
--     its table is closed). The row is not deleted and not changed: it is simply not readable by the public roles until the emergency is resolved;
--   * deletes nothing, and records exactly what it did, and the blockers, in the event.
-- Known limit of hiding: the planner estimates of a hidden table still include the hidden rows (Prefer: count=planned|estimated); p_close_api removes even that.
-- Resolve with finish_withdrawal (delete the rows once the blockers are cleared) or revert_emergency (a false alarm; the owner records the grant again separately).
create function ingest.emergency_withdraw(p_sha text, p_reason text, p_close_api boolean default false) returns jsonb
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

-- Resolves an emergency by completing the withdrawal: refuses while any blocker remains; then deletes the ledger rows, lifts the hiding, and recomputes the summaries.
create function ingest.finish_withdrawal(p_sha text, p_reason text) returns jsonb
language plpgsql
set search_path = pg_catalog, public, ingest
as $$
declare v_bad jsonb; v_total integer; d jsonb; x jsonb; v_cat text; v_stats jsonb;
begin
  if coalesce(trim(p_reason), '') = '' then raise exception 'WITHDRAWAL_REFUSED: a reason is required'; end if;
  perform pg_advisory_xact_lock(hashtext('bai.promotion'));
  perform set_config('lock_timeout', '15s', true);
  if ingest.promotion_state(p_sha) is distinct from 'EMERGENCY' then raise exception 'WITHDRAWAL_REFUSED: % is not under emergency withdrawal', p_sha; end if;
  execute 'lock table ' || (select string_agg(y::regclass::text, ', ') from unnest(ingest.promotion_scope()) y) || ' in share row exclusive mode';
  v_bad := ingest.promotion_dependents(p_sha);
  if jsonb_array_length(v_bad) > 0 then raise exception 'WITHDRAWAL_REFUSED: the blockers remain: %', v_bad; end if;
  select e.detail into d from ingest.promotion_events e where e.manifest_sha256 = p_sha and e.event = 'EMERGENCY_WITHDRAWN' order by e.id desc limit 1;
  select category into v_cat from ingest.promotion_manifests where manifest_sha256 = p_sha;
  perform set_config('bai.promotion_withdrawal', p_sha, true);
  perform public.rm_withdraw_category(v_cat, p_reason);                 -- already done by the emergency; repeated so that this function does not depend on it
  perform ingest.promotion_rm_assert_clean(p_sha);
  perform set_config('bai.promotion_rm_clean', p_sha, true);
  v_total := ingest.promotion_delete_rows(p_sha);
  perform set_config('bai.promotion_rm_clean', '', true);
  for x in select * from jsonb_array_elements(d -> 'hidden') loop execute format('drop policy %I on %s', x ->> 'policy', (x ->> 'table')::regclass); end loop;
  perform ingest.promotion_reopen(d);
  insert into ingest.promotion_events (manifest_sha256, event, detail) values (p_sha, 'WITHDRAWN', jsonb_build_object('reason', p_reason, 'rows', v_total, 'after_emergency', true, 'grant_withdrawn', true));
  perform public.refresh_read_models();
  perform public.refresh_transaction_read_models();
  v_stats := ingest.promotion_analyze(p_sha);
  return jsonb_build_object('manifest_sha256', p_sha, 'rows_deleted', v_total, 'statistics', v_stats);
end $$;

-- Gives back exactly the privileges an emergency took away (the roles are recorded in the event; an event written before they were recorded means anon and authenticated).
create function ingest.promotion_reopen(d jsonb) returns void
language plpgsql
set search_path = pg_catalog, ingest
as $$
declare x jsonb; v_roles text;
begin
  for x in select * from jsonb_array_elements(d -> 'closed') loop
    select string_agg(quote_ident(r), ', ') into v_roles from jsonb_array_elements_text(coalesce(x -> 'roles', '["anon", "authenticated"]'::jsonb)) r;
    if v_roles is not null then execute format('grant select on %s to %s', (x ->> 'table')::regclass, v_roles); end if;
  end loop;
end $$;

-- A false alarm: lifts the hiding and the refresh block, publishes nothing by itself (the grant is gone; the owner records it again, deliberately, and refreshes).
create function ingest.revert_emergency(p_sha text, p_reason text) returns jsonb
language plpgsql
set search_path = pg_catalog, public, ingest
as $$
declare d jsonb; x jsonb;
begin
  if coalesce(trim(p_reason), '') = '' then raise exception 'EMERGENCY_REFUSED: a reason is required'; end if;
  perform pg_advisory_xact_lock(hashtext('bai.promotion'));
  if ingest.promotion_state(p_sha) is distinct from 'EMERGENCY' then raise exception 'EMERGENCY_REFUSED: % is not under emergency withdrawal', p_sha; end if;
  select e.detail into d from ingest.promotion_events e where e.manifest_sha256 = p_sha and e.event = 'EMERGENCY_WITHDRAWN' order by e.id desc limit 1;
  for x in select * from jsonb_array_elements(d -> 'hidden') loop execute format('drop policy %I on %s', x ->> 'policy', (x ->> 'table')::regclass); end loop;
  perform ingest.promotion_reopen(d);
  insert into ingest.promotion_events (manifest_sha256, event, detail) values (p_sha, 'EMERGENCY_REVERTED', jsonb_build_object('reason', p_reason));
  return jsonb_build_object('manifest_sha256', p_sha, 'state', 'PROMOTED', 'note', 'record the publication grant again and refresh deliberately; nothing was republished');
end $$;

-- A promoted category's grant cannot be deleted on its own: that would hide the transaction read model and leave the promoted rows public. Withdrawal and the emergency delete it themselves.
create function ingest.promotion_grant_guard() returns trigger language plpgsql set search_path = pg_catalog, ingest as $$
begin
  if coalesce(current_setting('bai.promotion_withdrawal', true), '') <> '' then return coalesce(old, new); end if;
  if exists (select 1 from ingest.promotion_manifests m where (tg_op = 'TRUNCATE' or m.category = old.attribution_category) and ingest.promotion_state(m.manifest_sha256) in ('PROMOTED', 'EMERGENCY')) then
    raise exception 'GRANT_PROTECTED: promoted data depends on this grant; use ingest.withdraw_promotion(..., p_withdraw_grant => true) or ingest.emergency_withdraw' using errcode = 'integrity_constraint_violation';
  end if;
  return coalesce(old, new);
end $$;
create trigger source_publication_grants_promotion_guard before delete on ingest.source_publication_grants for each row execute function ingest.promotion_grant_guard();
create trigger source_publication_grants_promotion_guard_truncate before truncate on ingest.source_publication_grants for each statement execute function ingest.promotion_grant_guard();

-- While a promotion is under emergency withdrawal nothing may refresh a summary or the transaction read model: a refresh would count or show the promoted rows again.
create function ingest.promotion_emergency_block() returns trigger language plpgsql set search_path = pg_catalog, ingest as $$
begin
  if ingest.promotion_in_emergency() then
    raise exception 'a promotion is under emergency withdrawal: run ingest.finish_withdrawal or ingest.revert_emergency before refreshing' using errcode = 'object_not_in_prerequisite_state';
  end if;
  return null;
end $$;
create trigger rm_overview_emergency_block before insert on public.rm_overview for each statement execute function ingest.promotion_emergency_block();
create trigger rm_coverage_summary_emergency_block before insert on public.rm_coverage_summary for each statement execute function ingest.promotion_emergency_block();
create trigger rm_organization_summary_emergency_block before insert on public.rm_organization_summary for each statement execute function ingest.promotion_emergency_block();
create trigger rm_research_queue_summary_emergency_block before insert on public.rm_research_queue_summary for each statement execute function ingest.promotion_emergency_block();
create trigger rm_transactions_emergency_block before insert on public.rm_transactions for each statement execute function ingest.promotion_emergency_block();
create trigger rm_transaction_overview_emergency_block before insert on public.rm_transaction_overview for each statement execute function ingest.promotion_emergency_block();

revoke all on ingest.promotion_manifests, ingest.promotion_ledger, ingest.promotion_events, ingest.promotion_withheld_rows from public, anon, authenticated;
revoke all on function ingest.promotion_append_only(), ingest.promotion_state(text), ingest.promotion_in_emergency(), ingest.promotion_scope(), ingest.promotion_fingerprint(text),
  ingest.promote_begin(text), ingest.promote_load(text, jsonb), ingest.promote_withhold(text, text), ingest.promote_commit(), ingest.promotion_status(text), ingest.promotion_dependents(text),
  ingest.promotion_delete_rows(text), ingest.promotion_rm_assert_clean(text), ingest.promotion_analyze(text), ingest.promotion_reopen(jsonb), ingest.withdraw_promotion(text, text, boolean), ingest.emergency_withdraw(text, text, boolean), ingest.finish_withdrawal(text, text), ingest.revert_emergency(text, text),
  ingest.promotion_grant_guard(), ingest.promotion_emergency_block() from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- 4. The website role, and the Data API closed to the transaction read models
--    The website connects as bai_web (NOINHERIT, member of anon) and runs each page query as `set local role <BAI_PUBLIC_ROLE>` (lib/db.ts; default anon). With
--    BAI_PUBLIC_ROLE=bai_site no application code changes. bai_site is anon plus SELECT on the transaction read models; it cannot write, bypass row-level security, log in or administer.
--    anon and authenticated (the Data API roles) lose SELECT on the same tables, and the boundary registry keeps them closed whenever apply_public_boundary() runs.
-- ---------------------------------------------------------------------------------------------------------------

do $$
declare t text;
begin
  if not exists (select 1 from pg_roles where rolname = 'bai_site') then
    create role bai_site nologin inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  end if;
  grant anon to bai_site;                       -- every public read the site has today (grants and row-level policies follow anon)
  if exists (select 1 from pg_roles where rolname = 'bai_web') then
    grant bai_site to bai_web with inherit false, set true;   -- bai_web can SET ROLE bai_site and is otherwise unchanged
  end if;
  for t in select c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and (c.relname = 'rm_transactions' or c.relname like 'rm\_transaction\_%')
             and has_table_privilege('anon', c.oid, 'SELECT') order by 1 loop
    execute format('grant select on public.%I to bai_site', t);
    execute format('revoke select on public.%I from anon, authenticated', t);
    execute format('drop policy if exists public_read on public.%I', t);
    execute format('create policy site_read on public.%I for select to bai_site using (true)', t);
    insert into public.internal_objects (object_name, reason) values (t, 'transaction read model: the website role only (no Data API access)') on conflict do nothing;
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 5. The one owner-rights view. v_source_attribution (030) counted displayed transactions straight from rm_transaction_sources, which the Data API roles can no longer read.
--    v_transaction_record_sources aggregates that one table (category, record count, source count: what the public attribution summary already shows) with its owner's rights;
--    it reads nothing else, so it bypasses no row-level policy of any other table, and it is empty the moment the read model is withdrawn. v_source_attribution is again
--    security_invoker and unchanged in content.
-- ---------------------------------------------------------------------------------------------------------------

create view public.v_transaction_record_sources with (security_invoker = false) as
select s.attribution_category, (count(*))::integer as records, (count(distinct s.id))::integer as sources
from public.rm_transaction_sources rts join public.sources s on s.id = rts.source_id
where rts.role = 'RECORD' and s.attribution_category <> 'TEST_FIXTURE'
group by s.attribution_category;
comment on view public.v_transaction_record_sources is 'Owner-rights aggregate over rm_transaction_sources only (032): the transaction part of the public attribution summary.';

create or replace view public.v_source_attribution with (security_invoker = true) as
WITH cited(domain, source_id) AS (
         SELECT 'DRAFT'::text,
            draft_selections.source_id
           FROM public.draft_selections
        UNION ALL
         SELECT 'DRAFT'::text,
            draft_signings.source_id
           FROM public.draft_signings
        UNION ALL
         SELECT 'DRAFT'::text,
            slot_values.source_id
           FROM public.slot_values
        UNION ALL
         SELECT 'DRAFT'::text,
            drafts.source_id
           FROM public.drafts
        UNION ALL
         SELECT 'DRAFT'::text,
            organization_draft_pools.source_id
           FROM public.organization_draft_pools
        UNION ALL
         SELECT 'DRAFT'::text,
            schools.source_id
           FROM public.schools
        UNION ALL
         SELECT 'INTERNATIONAL'::text,
            international_signings.source_id
           FROM public.international_signings
        UNION ALL
         SELECT 'INTERNATIONAL'::text,
            international_signing_periods.source_id
           FROM public.international_signing_periods
        UNION ALL
         SELECT 'INTERNATIONAL'::text,
            organization_signing_period_context.source_id
           FROM public.organization_signing_period_context
        UNION ALL
         SELECT 'INTERNATIONAL'::text,
            academies.source_id
           FROM public.academies
        UNION ALL
         SELECT 'INTERNATIONAL'::text,
            trainers.source_id
           FROM public.trainers
        UNION ALL
         SELECT 'INTERNATIONAL'::text,
            player_academy_relationships.source_id
           FROM public.player_academy_relationships
        UNION ALL
         SELECT 'INTERNATIONAL'::text,
            player_trainer_relationships.source_id
           FROM public.player_trainer_relationships
        UNION ALL
         SELECT 'DEVELOPMENT'::text,
            affiliate_seasons.source_id
           FROM public.affiliate_seasons
        UNION ALL
         SELECT 'DEVELOPMENT'::text,
            development_events.source_id
           FROM public.development_events
        UNION ALL
         SELECT 'DEVELOPMENT'::text,
            player_assignments.source_id
           FROM public.player_assignments
        UNION ALL
         SELECT 'EXPECTATION'::text,
            evaluations.source_id
           FROM public.evaluations
        UNION ALL
         SELECT 'EXPECTATION'::text,
            ranking_lists.source_id
           FROM public.ranking_lists
        UNION ALL
         SELECT 'VALUE'::text,
            organization_value_attributions.source_id
           FROM public.organization_value_attributions
        UNION ALL
         SELECT 'IDENTITY'::text,
            player_external_ids.source_id
           FROM public.player_external_ids
        UNION ALL
         SELECT 'IDENTITY'::text,
            player_aliases.source_id
           FROM public.player_aliases
        UNION ALL
         SELECT 'OUTCOME'::text,
            outcome_audits.source_id
           FROM public.outcome_audits
        UNION ALL
         SELECT 'OUTCOME'::text,
            outcome_audit_details.source_id
           FROM public.outcome_audit_details
        UNION ALL
         SELECT 'OUTCOME'::text,
            war_observations.source_id
           FROM public.war_observations
        UNION ALL
         SELECT 'OUTCOME'::text,
            mlb_debuts.source_id
           FROM public.mlb_debuts
        UNION ALL
         SELECT 'OUTCOME'::text,
            acquisition_dispositions.source_id
           FROM public.acquisition_dispositions
        UNION ALL
         SELECT 'ORGANIZATION'::text,
            organization_names.source_id
           FROM public.organization_names
        UNION ALL
         SELECT 'ORGANIZATION'::text,
            organization_league_seasons.source_id
           FROM public.organization_league_seasons
        UNION ALL
         SELECT 'ORGANIZATION'::text,
            rules_eras.source_id
           FROM public.rules_eras
        UNION ALL
         SELECT 'FIELD_OBSERVATION'::text,
            source_observations.source_id
           FROM public.source_observations
        )
 SELECT s.attribution_category,
    c.domain,
    (count(*))::integer AS records,
    (count(DISTINCT s.id))::integer AS sources
   FROM (cited c
     JOIN public.sources s ON ((s.id = c.source_id)))
  WHERE (s.attribution_category <> 'TEST_FIXTURE'::text)
  GROUP BY s.attribution_category, c.domain
UNION ALL
 SELECT t.attribution_category,
    'TRANSACTION'::text AS domain,
    t.records,
    t.sources
   FROM public.v_transaction_record_sources t;

-- ---------------------------------------------------------------------------------------------------------------
-- 6. Corrections to the 030 read model, found by the G5-5B/G5-5C full-scale measurements (030 itself is already applied on the hosted database; these replace its objects)
-- ---------------------------------------------------------------------------------------------------------------

-- 6a. Three indexes. research.transaction_gaps (028), called once per displayable transaction by analytics.transaction_completeness, looks trade_package_assets up by package and
--     transaction_source_links by asset and by package; none of those columns was indexed (the unique indexes lead with other columns), so each trade paid a full scan of both tables
--     for each of a dozen EXISTS tests: 20.4 s of the 21 s refresh at full scale (11,257 calls). With the indexes the same refresh takes 1.9 s. They also serve the foreign-key checks
--     of deletes in those tables (a withdrawal deletes trade_packages, trade_package_assets and links).
create index if not exists trade_package_assets_package_idx on public.trade_package_assets (trade_package_id);
create index if not exists transaction_source_links_asset_idx on public.transaction_source_links (trade_package_asset_id) where trade_package_asset_id is not null;
create index if not exists transaction_source_links_package_idx on public.transaction_source_links (trade_package_id) where trade_package_id is not null;

-- 6b. rm_withdraw_transactions: unchanged except for the first statement (the promotion withdrawal's clean-read-model flag; see ingest.promotion_rm_assert_clean).
create or replace function public.rm_withdraw_transactions(p_ids bigint[], p_reason text) returns integer
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  n integer;
begin
  -- Inside a promotion withdrawal that has already emptied the read model of the promotion's transactions (ingest.promotion_rm_assert_clean), the row triggers have nothing to withdraw.
  if coalesce(current_setting('bai.promotion_rm_clean', true), '') <> '' and current_setting('bai.promotion_rm_clean', true) = coalesce(current_setting('bai.promotion_withdrawal', true), '') then return 0; end if;
  if p_ids is null or cardinality(p_ids) = 0 or not exists (select 1 from public.rm_transactions where transaction_id = any (p_ids)) then return 0; end if;
  delete from public.rm_transaction_followups where transaction_id = any (p_ids) or later_transaction_id = any (p_ids);
  delete from public.rm_transaction_returns where transaction_id = any (p_ids);
  delete from public.rm_transaction_packages where transaction_id = any (p_ids);
  delete from public.rm_transaction_sources where transaction_id = any (p_ids);
  delete from public.rm_transaction_assets where transaction_id = any (p_ids);
  delete from public.rm_transaction_players where transaction_id = any (p_ids);
  with d as (delete from public.rm_transactions where transaction_id = any (p_ids) returning 1) select count(*) into n from d;
  delete from public.rm_transaction_coverage;
  delete from public.rm_transaction_club_seasons;
  delete from public.rm_transaction_overview;
  insert into public.rm_transaction_withdrawals (reason, withdrawn_transactions) values (p_reason, n);
  return n;
end $$;

-- 6c. refresh_transaction_read_models: unchanged except for two ORDER BYs. rm_transactions.search_tsv is built from string_agg(player names) over rm_transaction_players WITHOUT an order,
--     so the order of the names (and so the lexeme positions of the tsvector) followed the physical row order of that table, which differs from one refresh to the next (314 of 11,257 rows
--     when only the physical order changed; the token sets were always identical). The names are now aggregated in a fixed order (normalized name, then player id, bytewise "C" collation
--     so that two databases of different locales agree), and the club names in "C" order. Search results are unchanged (the same tokens); only the positions are now stable.
create or replace function public.refresh_transaction_read_models() returns bigint
language plpgsql
set search_path = pg_catalog, public, analytics, ingest, research
as $$
declare
  v_generation bigint;
  v_displayable integer;
  v_withheld integer;
begin
  lock table public.rm_transaction_refreshes in exclusive mode;
  -- Every statement below must see the latest committed state: a snapshot taken before a revocation committed would publish it.
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'refresh_transaction_read_models must run in a READ COMMITTED transaction (it is %)', current_setting('transaction_isolation') using errcode = 'invalid_transaction_state';
  end if;
  -- Nothing the refresh reads may change while it runs (a grant revoked or a verification withdrawn after the refresh read it would otherwise be
  -- published by the refresh's commit). The withdrawal triggers below fire in the writer's transaction; this lock orders them strictly before or after
  -- the refresh. NOWAIT: the refresh never waits for a lock while holding another, so it cannot take part in a deadlock; if a writer is mid-transaction it
  -- fails at once with SQLSTATE 55P03 (lock_not_available) and publishes nothing. scripts/db/refresh-transaction-read-models.mjs retries that and 40P01/40001.
  lock table ingest.source_publication_grants, research.transaction_verifications, public.sources, public.transactions, public.trade_packages, public.trade_package_assets,
             public.transaction_sources, public.transaction_source_links, public.transaction_external_ids, public.ptbnl_resolutions, public.transaction_conflicts,
             public.transaction_player_moves in share mode nowait;
  select coalesce(max(generation_id), 0) + 1 into v_generation from public.rm_transaction_refreshes;

  -- sources authorized for public display: the openly licensed groups, or a category with a recorded grant on this database
  create temporary table _src on commit drop as
  select s.id, public.source_attribution_category(s.url, s.source_key, s.publisher, s.title, s.source_type) as category
  from public.sources s;
  create temporary table _auth on commit drop as
  select s.id from _src s
  where s.category in ('CHADWICK_REGISTER', 'WIKIPEDIA', 'BAI_RESEARCH', 'WIKIDATA')
     or exists (select 1 from ingest.source_publication_grants g where g.attribution_category = s.category);

  -- a transaction is shown only if every source it cites is authorized
  create temporary table _tx on commit drop as
  select t.id
  from public.transactions t
  where t.source_id in (select id from _auth)
    and not exists (select 1 from public.transaction_sources ts where ts.transaction_id = t.id and ts.source_id not in (select id from _auth));
  select count(*) into v_displayable from _tx;
  select count(*) - v_displayable into v_withheld from public.transactions;

  delete from public.rm_transaction_followups;
  delete from public.rm_transaction_returns;
  delete from public.rm_transaction_packages;
  delete from public.rm_transaction_sources;
  delete from public.rm_transaction_assets;
  delete from public.rm_transaction_players;
  delete from public.rm_transaction_coverage;
  delete from public.rm_transaction_club_seasons;
  delete from public.rm_transaction_overview;
  delete from public.rm_transactions;

  -- assets: trades from packages (a resolved PTBNL with its resolution), other acquisitions from moves
  insert into public.rm_transaction_assets (transaction_id, position, from_key, from_club_text, to_key, asset_kind, player_id, player_slug, player_name, detail, conditional, condition_text,
                                            amount_status, amount_usd, resolution_kind, resolved_player_slug, resolved_player_name, resolved_on, source_event_code)
  select x.transaction_id, (row_number() over (partition by x.transaction_id order by x.from_key nulls first, x.to_key, x.asset_kind, x.player_name nulls last, x.detail nulls last, x.sort_id))::integer,
         x.from_key, x.from_club_text, x.to_key, x.asset_kind, x.player_id, x.player_slug, x.player_name, x.detail, x.conditional, x.condition_text, x.amount_status, x.amount_usd,
         x.resolution_kind, x.resolved_player_slug, x.resolved_player_name, x.resolved_on, x.source_event_code
  from (
    select k.transaction_id, fo.franchise_key as from_key, null::text as from_club_text, too.franchise_key as to_key, a.asset_type::text as asset_kind,
           a.player_id, p.slug as player_slug, p.display_name as player_name, a.description as detail, a.conditional, a.condition_text,
           case when a.asset_type in ('CASH', 'INTERNATIONAL_POOL_SPACE') then coalesce(a.amount_disclosure, case when a.amount_usd is not null then 'DISCLOSED' else 'UNKNOWN' end) end as amount_status,
           case when a.asset_type in ('CASH', 'INTERNATIONAL_POOL_SPACE') and coalesce(a.amount_disclosure, case when a.amount_usd is not null then 'DISCLOSED' else 'UNKNOWN' end) = 'DISCLOSED' then a.amount_usd end as amount_usd,
           r.resolution as resolution_kind, rp.slug as resolved_player_slug, rp.display_name as resolved_player_name, r.resolved_on, null::text as source_event_code, a.id as sort_id
    from public.trade_package_assets a
    join public.trade_packages k on k.id = a.trade_package_id and k.transaction_id in (select id from _tx)
    join public.organizations fo on fo.id = k.from_organization_id
    join public.organizations too on too.id = k.to_organization_id
    left join public.players p on p.id = a.player_id
    left join public.ptbnl_resolutions r on r.trade_package_asset_id = a.id
    left join public.players rp on rp.id = r.resolved_player_id
    union all
    select m.transaction_id, fo.franchise_key, m.from_club_text, too.franchise_key, 'PLAYER', m.player_id, p.slug, p.display_name, m.source_info, false, null, null, null, null, null, null, null, m.source_event_code, m.id
    from public.transaction_player_moves m
    join public.organizations too on too.id = m.to_organization_id
    left join public.organizations fo on fo.id = m.from_organization_id
    join public.players p on p.id = m.player_id
    where m.transaction_id in (select id from _tx)
  ) x;

  insert into public.rm_transaction_players (transaction_id, player_id, player_slug, player_name, role)
  select transaction_id, player_id, player_slug, player_name, 'ASSET' from public.rm_transaction_assets where player_id is not null
  group by transaction_id, player_id, player_slug, player_name;
  insert into public.rm_transaction_players (transaction_id, player_id, player_slug, player_name, role)
  select a.transaction_id, p.id, a.resolved_player_slug, a.resolved_player_name, 'NAMED_LATER'
  from public.rm_transaction_assets a join public.players p on p.slug = a.resolved_player_slug
  where a.resolved_player_slug is not null
  on conflict (transaction_id, player_id) do nothing;

  -- the transactions
  insert into public.rm_transactions (transaction_id, season, transaction_date, date_precision, transaction_type, category, club_keys, parties, status, gaps, independent_source_groups, verified_on,
                                      source_categories, attribution_required, asset_count, player_count, cash_unknown, has_unresolved_ptbnl, search_tsv, generation_id)
  select t.id, extract(year from t.transaction_date)::integer, t.transaction_date, t.date_precision, t.transaction_type::text,
         case t.transaction_type::text when 'TRADE' then 'TRADE' when 'FREE_AGENT_SIGNING' then 'FREE_AGENT' when 'AMATEUR_FREE_AGENT_SIGNING' then 'AMATEUR_FREE_AGENT'
              when 'WAIVER_CLAIM' then 'WAIVER' when 'PURCHASE' then 'PURCHASE' when 'RULE_5' then 'RULE_5' else 'OTHER' end,
         cl.keys, cl.parties, c.completeness, c.gaps, c.independent_source_groups,
         case when c.completeness = 'VERIFIED_COMPLETE' then c.verified_at::date end,
         src.categories, src.categories && array(select attribution_category from public.source_attribution_statements),
         coalesce(ac.n, 0), coalesce(pc.n, 0), coalesce(ac.cash_unknown, false), coalesce(ac.pending_ptbnl, false),
         to_tsvector('simple', coalesce(pn.names, '') || ' ' || array_to_string(cl.keys, ' ') || ' ' || coalesce(cl.club_names, '') || ' ' || t.transaction_type::text || ' ' || extract(year from t.transaction_date)::text),
         v_generation
  from public.transactions t
  join _tx on _tx.id = t.id
  join analytics.transaction_completeness c on c.transaction_id = t.id
  cross join lateral (
    select array_agg(distinct o.franchise_key order by o.franchise_key) as keys,
           jsonb_agg(distinct jsonb_build_object('key', o.franchise_key, 'name', o.current_name, 'slug', o.slug)) as parties,
           string_agg(distinct o.current_name collate "C", ' ' order by o.current_name collate "C") as club_names
    from (select k.from_organization_id as org from public.trade_packages k where k.transaction_id = t.id
          union select k.to_organization_id from public.trade_packages k where k.transaction_id = t.id
          union select m.to_organization_id from public.transaction_player_moves m where m.transaction_id = t.id
          union select m.from_organization_id from public.transaction_player_moves m where m.transaction_id = t.id and m.from_organization_id is not null) x
    join public.organizations o on o.id = x.org
  ) cl
  cross join lateral (
    select array_agg(distinct _src.category order by _src.category) as categories
    from _src where _src.id = t.source_id or _src.id in (select ts.source_id from public.transaction_sources ts where ts.transaction_id = t.id)
  ) src
  left join lateral (
    select count(*)::integer as n, bool_or(a.asset_kind in ('CASH', 'INTERNATIONAL_POOL_SPACE') and a.amount_status = 'UNKNOWN') as cash_unknown,
           bool_or(a.asset_kind = 'PLAYER_TO_BE_NAMED' and a.resolution_kind is null) as pending_ptbnl
    from public.rm_transaction_assets a where a.transaction_id = t.id
  ) ac on true
  left join lateral (select count(*)::integer as n from public.rm_transaction_players p where p.transaction_id = t.id) pc on true
  left join lateral (select string_agg(public.normalize_name(p.player_name), ' ' order by public.normalize_name(p.player_name) collate "C", p.player_id) as names from public.rm_transaction_players p where p.transaction_id = t.id) pn on true;

  -- later movement of the same player, as established by later transactions in this ledger
  insert into public.rm_transaction_followups (transaction_id, player_id, step, later_transaction_id, later_date, later_category, later_club_keys)
  with ev as (
    select p.player_id, t.transaction_id, t.transaction_date, t.category, t.club_keys,
           row_number() over (partition by p.player_id order by t.transaction_date, t.transaction_id) as rn
    from public.rm_transaction_players p join public.rm_transactions t on t.transaction_id = p.transaction_id
  )
  select a.transaction_id, a.player_id, (b.rn - a.rn)::integer, b.transaction_id, b.transaction_date, b.category, b.club_keys
  from ev a join ev b on b.player_id = a.player_id and b.rn > a.rn and b.rn <= a.rn + 3;

  -- what each club received (WAR only where its provider's sources are authorized; never a score)
  create temporary table _war_ok on commit drop as
  select w.war_system::text as provider, bool_and(w.source_id in (select id from _auth)) as ok
  from public.war_observations w group by w.war_system;
  -- The club-level figure is identical on every package row of a club (same transaction, club, provider). Anything else is a defect, not a choice.
  -- NULL-safe: count(distinct x) ignores NULL, so a NULL beside a number would pass; a column must be all NULL or all non-NULL, and single-valued.
  if exists (select 1 from analytics.trade_returns r join public.rm_transactions t on t.transaction_id = r.transaction_id
             group by r.transaction_id, r.organization_id, r.war_system
             having (count(*) filter (where r.return_war_known is null) not in (0, count(*)) or count(distinct r.return_war_known) > 1)
                 or (count(*) filter (where r.return_coverage is null) not in (0, count(*)) or count(distinct r.return_coverage) > 1)
                 or (count(*) filter (where r.received_player_ids is null) not in (0, count(*)) or count(distinct cardinality(r.received_player_ids)) > 1)) then
    raise exception 'analytics.trade_returns gives one club different club-level figures within a transaction';
  end if;
  insert into public.rm_transaction_returns (transaction_id, club_key, provider, packages_sent, players_sent, players_received, return_war_known, evidence)
  select r.transaction_id, o.franchise_key, r.war_system::text, count(*)::integer, sum(r.players_sent)::integer, max(cardinality(r.received_player_ids)),
         case when coalesce(bool_and(w.ok), true) then max(r.return_war_known) end,
         case when not coalesce(bool_and(w.ok), true) and max(r.return_war_known) is not null then 'WITHHELD_PERMISSION'
              when max(r.return_war_known) is null then 'NOT_OBSERVED'
              when max(r.return_coverage) = 'COMPLETE' then 'OBSERVED_COMPLETE' else 'OBSERVED_PARTIAL' end
  from analytics.trade_returns r
  join public.rm_transactions t on t.transaction_id = r.transaction_id
  join public.organizations o on o.id = r.organization_id
  left join _war_ok w on w.provider = r.war_system::text
  group by r.transaction_id, o.franchise_key, r.war_system;

  insert into public.rm_transaction_packages (transaction_id, from_key, to_key, players_sent, other_assets_sent)
  select k.transaction_id, fo.franchise_key, too.franchise_key, coalesce(sum(r.players_sent), 0)::integer, coalesce(sum(r.other_assets_sent), 0)::integer
  from public.trade_packages k
  join public.rm_transactions t on t.transaction_id = k.transaction_id
  join public.organizations fo on fo.id = k.from_organization_id
  join public.organizations too on too.id = k.to_organization_id
  left join (select distinct package_id, players_sent, other_assets_sent from analytics.trade_returns) r on r.package_id = k.id
  group by k.transaction_id, fo.franchise_key, too.franchise_key;

  insert into public.rm_transaction_sources (transaction_id, position, source_id, title, publisher, url, attribution_category, role, independence_group, locator)
  select x.transaction_id, (row_number() over (partition by x.transaction_id order by x.ord, x.title))::integer, x.source_id, x.title, x.publisher, x.url, x.category, x.role, x.grp, x.locator
  from (
    select t.id as transaction_id, 0 as ord, s.id as source_id, s.title, s.publisher, s.url, _src.category, 'RECORD' as role, null::text as grp, null::text as locator
    from public.transactions t join _tx on _tx.id = t.id join public.sources s on s.id = t.source_id join _src on _src.id = s.id
    union all
    select ts.transaction_id, 1, s.id, s.title, s.publisher, s.url, _src.category, ts.role, ts.independence_group, ts.locator
    from public.transaction_sources ts join _tx on _tx.id = ts.transaction_id join public.sources s on s.id = ts.source_id join _src on _src.id = s.id
  ) x;

  insert into public.rm_transaction_coverage (season, club_key, category, records, unverified, partial, verified_complete, with_unresolved_assets)
  select t.season, k.key, t.category, count(*)::integer, (count(*) filter (where t.status = 'UNVERIFIED'))::integer, (count(*) filter (where t.status = 'PARTIAL'))::integer,
         (count(*) filter (where t.status = 'VERIFIED_COMPLETE'))::integer, (count(*) filter (where t.cash_unknown or t.has_unresolved_ptbnl))::integer
  from public.rm_transactions t cross join lateral unnest(t.club_keys) k(key)
  group by t.season, k.key, t.category;

  insert into public.rm_transaction_club_seasons (season, club_key, records, coverage_state, expected_count)
  select c.season, c.club_key, c.records, coalesce(a.coverage_state::text, 'NOT_ASSESSED'), a.expected_count
  from (select t.season, k.key as club_key, count(*)::integer as records from public.rm_transactions t cross join lateral unnest(t.club_keys) k(key) group by 1, 2) c
  left join public.organizations o on o.franchise_key = c.club_key
  left join public.coverage_assessments a on a.domain::text = 'TRANSACTIONS' and a.organization_id = o.id and a.scope_key = c.season::text;

  insert into public.rm_transaction_overview (generation_id, refreshed_at, transactions, by_status, by_category, first_season, last_season, display_authorized_categories, withheld_unauthorized, verified_complete, complete_census_club_seasons)
  select v_generation, now(), (select count(*) from public.rm_transactions)::integer,
         coalesce((select jsonb_object_agg(status, n) from (select status, count(*) n from public.rm_transactions group by status) s), '{}'),
         coalesce((select jsonb_object_agg(category, n) from (select category, count(*) n from public.rm_transactions group by category) s), '{}'),
         (select min(season) from public.rm_transactions), (select max(season) from public.rm_transactions),
         coalesce((select array_agg(distinct c.category order by c.category) from _src c where c.id in (select id from _auth) and c.category not in ('TEST_FIXTURE')), '{}'),
         v_withheld, (select count(*) from public.rm_transactions where status = 'VERIFIED_COMPLETE')::integer,
         (select count(*) from public.rm_transaction_club_seasons where coverage_state = 'COMPLETE_CENSUS')::integer;

  -- validation: nothing unauthorized, nothing complete without a verification, every row has a party
  if exists (select 1 from public.rm_transactions t where t.transaction_id not in (select id from _tx)) then raise exception 'read model holds a transaction that is not authorized for display'; end if;
  if exists (select 1 from public.rm_transactions where status = 'VERIFIED_COMPLETE' and (verified_on is null or cardinality(gaps) > 0)) then raise exception 'read model marks a transaction complete without a verification and no gaps'; end if;
  if exists (select 1 from public.rm_transactions where cardinality(club_keys) = 0) then raise exception 'read model holds a transaction with no club'; end if;
  if (select count(*) from public.rm_transactions) <> v_displayable then raise exception 'read model transaction count differs from the authorized set'; end if;

  insert into public.rm_transaction_refreshes (generation_id, transactions, withheld_unauthorized) values (v_generation, v_displayable, v_withheld);
  return v_generation;
end $$;

select public.apply_public_boundary();
