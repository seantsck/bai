-- 032_off_hosted_promotion
-- Off-hosted staging, atomic promotion and owner-controlled withdrawal of reviewed data, plus a dedicated read-only website role. (031 is reserved by docs/transactions/later-added/proposal.md.)
--
-- WHY. Imported rows are inserted into the same tables the Data API reads, and row-level hiding of rows that exist (a "hold") cannot be made leak-free: the planner estimates that PostgREST
-- returns for Prefer: count=planned|estimated are made from the whole table, and a repeated Prefer header reaches PostgREST past any pre-request guard. So nothing is held on the hosted
-- database. The six batches are imported and validated OFF-HOSTED, from a restored baseline backup; what is reviewed is an insert-only DELTA, described by an immutable MANIFEST; and the delta is
-- PROMOTED into the hosted database in one transaction, by the owner, after the baseline has been proven identical. Withdrawal deletes exactly the promoted rows (the LEDGER), in one transaction.
--
-- This migration changes no existing table, row, policy or function. It adds:
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
  select coalesce(array_agg(n.nspname || '.' || c.relname order by n.nspname, c.relname), '{}')
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p') and n.nspname in ('public', 'ingest', 'research')
    and not (n.nspname = 'ingest' and c.relname like 'promotion\_%')
    and not (n.nspname = 'public' and (c.relname like 'rm\_%' or c.relname = 'read_model_refreshes'))
$$;

-- Row-content fingerprint, independent of session settings, physical order and the server it runs on (a local restore and the hosted database give the same value for the same rows).
create function ingest.promotion_fingerprint(p_table text) returns jsonb
language plpgsql stable
set search_path = pg_catalog, public, ingest
set timezone = 'UTC' set datestyle = 'ISO, YMD' set extra_float_digits = 1 set bytea_output = 'hex' set intervalstyle = 'postgres'
as $$
declare r record;
begin
  execute format('select count(*)::bigint as n, md5(coalesce(string_agg(h, '''' order by h), '''')) as d from (select md5(t::text) as h from %s t) s', p_table::regclass) into r;
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
  if (select array_agg(x order by x) from jsonb_array_elements_text(m #> '{baseline,scope}') x) is distinct from v_scope then raise exception 'DRIFT: the set of tables differs from the manifest'; end if;
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
  select array_agg(b.file_sha256 order by b.file_sha256) into v_batches from ingest.import_batches b where b.id in (select (pk ->> 'id')::bigint from _promo_pk where table_name = 'ingest.import_batches');
  select array_agg(x ->> 'sha256' order by x ->> 'sha256') into v_want from jsonb_array_elements(m -> 'batches') x;
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
       (select string_agg('p.' || quote_ident(a.attname), ', ' order by k.ord) from unnest(c.confkey) with ordinality k(attnum, ord) join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.attnum) as pcols
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
    if v_cnt > 0 then v_bad := v_bad || jsonb_build_object('table', f.child, 'references', f.parent, 'rows', v_cnt); end if;
  end loop;
  for f in select x.t from unnest(array['public.source_observations', 'public.fact_resolutions']) x(t) where to_regclass(x.t) is not null loop
    for l in select table_name, pks from ingest.promotion_ledger where manifest_sha256 = p_sha and table_name in ('public.players', 'public.transactions') loop
      execute format('select count(*) from %s o where o.subject_table = %L and exists (select 1 from jsonb_populate_recordset(null::%s, $1) p where p.id = o.subject_id) and not exists (select 1 from jsonb_populate_recordset(null::public.source_observations, $2) po where po.id = o.id)',
        f.t, substr(l.table_name, 8), l.table_name::regclass) into v_cnt using l.pks,
        case when f.t = 'public.source_observations' then coalesce((select pks from ingest.promotion_ledger where manifest_sha256 = p_sha and table_name = 'public.source_observations'), '[]'::jsonb) else '[]'::jsonb end;
      if v_cnt > 0 then v_bad := v_bad || jsonb_build_object('table', f.t, 'references', l.table_name, 'rows', v_cnt, 'kind', 'by subject'); end if;
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

-- The normal withdrawal: one transaction; refuses while anything unrelated depends on a promoted row; leaves the grant alone unless asked.
create function ingest.withdraw_promotion(p_sha text, p_reason text, p_withdraw_grant boolean default false) returns jsonb
language plpgsql
set search_path = pg_catalog, public, ingest
as $$
declare v_state text; v_cat text; v_bad jsonb; v_total integer;
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
  perform public.rm_withdraw_category(v_cat, p_reason);                 -- the published read model first, so the row triggers below find nothing to withdraw
  v_total := ingest.promotion_delete_rows(p_sha);
  if p_withdraw_grant then delete from ingest.source_publication_grants where attribution_category = v_cat; end if;
  insert into ingest.promotion_events (manifest_sha256, event, detail) values (p_sha, 'WITHDRAWN', jsonb_build_object('reason', p_reason, 'rows', v_total, 'grant_withdrawn', p_withdraw_grant));
  perform public.refresh_read_models();                                 -- every cached summary recomputed from the withdrawn state, in this transaction
  perform public.refresh_transaction_read_models();
  return jsonb_build_object('manifest_sha256', p_sha, 'rows_deleted', v_total, 'grant_withdrawn', p_withdraw_grant);
end $$;

-- EMERGENCY. Public exposure must stop now, and physical deletion is blocked by rows that are not the promotion's. In ONE transaction this
--   * withdraws the transaction read model and deletes the category's grant (nothing can republish it);
--   * empties the cached summaries that count promoted rows, and makes every refresh fail until the emergency is resolved (a refresh would count them again);
--   * hides every promoted row from the Data API roles and the website (anon, authenticated, and bai_site through anon) with a RESTRICTIVE row-level policy per readable table;
--     with p_close_api the readable tables are instead closed to those roles altogether (the trade-off: those public endpoints stop answering until the emergency is resolved);
--   * deletes nothing, and records exactly what it did, and the blockers, in the event.
-- Known limit of hiding: the planner estimates of a hidden table still include the hidden rows (Prefer: count=planned|estimated); p_close_api removes even that.
-- Resolve with finish_withdrawal (delete the rows once the blockers are cleared) or revert_emergency (a false alarm; the owner records the grant again separately).
create function ingest.emergency_withdraw(p_sha text, p_reason text, p_close_api boolean default false) returns jsonb
language plpgsql
set search_path = pg_catalog, public, ingest
as $$
declare
  v_cat text; l record; v_pol text := 'emergency_hide_' || substr(p_sha, 1, 12); v_hidden jsonb := '[]'::jsonb; v_closed jsonb := '[]'::jsonb; v_ids text; v_pkt text;
  v_rls boolean; v_exposed boolean; v_bad jsonb; v_close boolean;
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
  for l in select * from ingest.promotion_ledger where manifest_sha256 = p_sha order by load_order loop
    v_exposed := has_table_privilege('anon', l.table_name::regclass, 'SELECT') or has_table_privilege('authenticated', l.table_name::regclass, 'SELECT') or has_table_privilege('bai_site', l.table_name::regclass, 'SELECT');
    continue when not v_exposed;
    select c.relrowsecurity into v_rls from pg_class c where c.oid = l.table_name::regclass;
    select format_type(a.atttypid, null) into v_pkt from pg_attribute a where a.attrelid = l.table_name::regclass and a.attname = l.pk_cols[1];
    v_close := p_close_api or not v_rls or cardinality(l.pk_cols) <> 1 or v_pkt not in ('bigint', 'integer');
    if v_close then
      execute format('revoke select on %s from anon, authenticated', l.table_name::regclass);
      v_closed := v_closed || jsonb_build_object('table', l.table_name);
    else
      select string_agg((x ->> l.pk_cols[1]), ',') into v_ids from jsonb_array_elements(l.pks) x;
      execute format('create policy %I on %s as restrictive for select to anon, authenticated using (not (%I = any (%L::bigint[])))', v_pol, l.table_name::regclass, l.pk_cols[1], '{' || v_ids || '}');
      v_hidden := v_hidden || jsonb_build_object('table', l.table_name, 'policy', v_pol, 'rows', l.n);
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
declare v_bad jsonb; v_total integer; d jsonb; x jsonb;
begin
  if coalesce(trim(p_reason), '') = '' then raise exception 'WITHDRAWAL_REFUSED: a reason is required'; end if;
  perform pg_advisory_xact_lock(hashtext('bai.promotion'));
  perform set_config('lock_timeout', '15s', true);
  if ingest.promotion_state(p_sha) is distinct from 'EMERGENCY' then raise exception 'WITHDRAWAL_REFUSED: % is not under emergency withdrawal', p_sha; end if;
  execute 'lock table ' || (select string_agg(y::regclass::text, ', ') from unnest(ingest.promotion_scope()) y) || ' in share row exclusive mode';
  v_bad := ingest.promotion_dependents(p_sha);
  if jsonb_array_length(v_bad) > 0 then raise exception 'WITHDRAWAL_REFUSED: the blockers remain: %', v_bad; end if;
  select e.detail into d from ingest.promotion_events e where e.manifest_sha256 = p_sha and e.event = 'EMERGENCY_WITHDRAWN' order by e.id desc limit 1;
  perform set_config('bai.promotion_withdrawal', p_sha, true);
  v_total := ingest.promotion_delete_rows(p_sha);
  for x in select * from jsonb_array_elements(d -> 'hidden') loop execute format('drop policy %I on %s', x ->> 'policy', (x ->> 'table')::regclass); end loop;
  for x in select * from jsonb_array_elements(d -> 'closed') loop execute format('grant select on %s to anon, authenticated', (x ->> 'table')::regclass); end loop;
  insert into ingest.promotion_events (manifest_sha256, event, detail) values (p_sha, 'WITHDRAWN', jsonb_build_object('reason', p_reason, 'rows', v_total, 'after_emergency', true, 'grant_withdrawn', true));
  perform public.refresh_read_models();
  perform public.refresh_transaction_read_models();
  return jsonb_build_object('manifest_sha256', p_sha, 'rows_deleted', v_total);
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
  for x in select * from jsonb_array_elements(d -> 'closed') loop execute format('grant select on %s to anon, authenticated', (x ->> 'table')::regclass); end loop;
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
  ingest.promotion_delete_rows(text), ingest.withdraw_promotion(text, text, boolean), ingest.emergency_withdraw(text, text, boolean), ingest.finish_withdrawal(text, text), ingest.revert_emergency(text, text),
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

select public.apply_public_boundary();
