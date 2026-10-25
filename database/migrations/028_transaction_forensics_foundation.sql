-- 028_transaction_forensics_foundation
-- Phase 16: the smallest additive foundation for transaction forensics (docs/transactions/03, 06). Migrations 010, 022 and
-- 023 keep their semantics: no existing row is rewritten, no existing column changes meaning, and the value views return
-- the same results on every existing record (a resolved player-to-be-named is the only new input, and none exists yet).
--
--   * Stable external identities: public.transaction_external_ids (scheme + id), unique across the database.
--   * Multiple sources per transaction (public.transaction_sources) with an INDEPENDENCE GROUP: sources that repeat one
--     original announcement share a group and count once. Package-level and asset-level provenance
--     (public.transaction_source_links) says which source supports which package or asset.
--   * Completeness is DERIVED, never stored or settable: analytics.transaction_completeness. VERIFIED_COMPLETE exists only
--     while an active human verification (research.transaction_verifications) carries the transaction's CURRENT content
--     fingerprint. Verification is a human-only action bound to the authenticated login (021): research.verify_transaction,
--     refused while research.certification_gate is closed, and refused while any gap remains (research.transaction_gaps).
--   * Automatic invalidation: any change to a transaction, its packages, assets, sources, links, external ids, PTBNL
--     resolutions or conflicts revokes the active verification in the same database transaction (system actor).
--   * Cash is explicit: DISCLOSED (an amount, zero allowed), UNDISCLOSED (a source says so) or UNKNOWN (not established).
--     NULL never means zero. Conditional assets and player-to-be-named assets carry their condition; a PTBNL is resolved by
--     a dated, sourced row (public.ptbnl_resolutions) to a player, cash or nothing.
--   * Trade-deadline calendar events (public.season_calendar_events) and a context view that reports unknown, not false,
--     when the calendar is missing.
--   * Conflicts found by the importer are kept (public.transaction_conflicts); only a human resolves one.
--   * ingest.transaction_apply_ledger: replay protection for the transaction importer.
--
-- Not here: contracts, executives, evaluation tables, scores or ranks. All new tables are internal (RLS on, no public
-- grant) until the transaction detail view is built; the existing public tables keep their grants.

-- ---------------------------------------------------------------------------------------------------------------
-- Assets: explicit cash disclosure and conditions (existing rows are untouched: NULL = recorded before 028)
-- ---------------------------------------------------------------------------------------------------------------

alter table public.trade_package_assets
  add column amount_disclosure text check (amount_disclosure in ('DISCLOSED', 'UNDISCLOSED', 'UNKNOWN')),
  add column conditional boolean not null default false,
  add column condition_text text,
  add constraint trade_asset_disclosure_kind check (amount_disclosure is null or asset_type in ('CASH', 'INTERNATIONAL_POOL_SPACE')),
  add constraint trade_asset_disclosed_has_amount check (amount_disclosure is distinct from 'DISCLOSED' or amount_usd is not null),
  add constraint trade_asset_undisclosed_no_amount check (amount_disclosure is null or amount_disclosure = 'DISCLOSED' or amount_usd is null),
  add constraint trade_asset_condition_stated check (not conditional or asset_type = 'PLAYER_TO_BE_NAMED' or condition_text is not null);

comment on column public.trade_package_assets.amount_disclosure is
  'DISCLOSED (amount_usd given; zero is a stated zero), UNDISCLOSED (a source says the amount was not disclosed), UNKNOWN (not established). NULL on a row recorded before 028. amount_usd NULL never means zero.';

create function public.trade_asset_defaults() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.asset_type in ('CASH', 'INTERNATIONAL_POOL_SPACE') then
    -- An amount with no stated disclosure is DISCLOSED; no amount and no statement is UNKNOWN. A contradiction is left for the table checks.
    if new.amount_disclosure is null then new.amount_disclosure := case when new.amount_usd is not null then 'DISCLOSED' else 'UNKNOWN' end; end if;
  end if;
  if new.asset_type = 'PLAYER_TO_BE_NAMED' then new.conditional := true; end if;
  return new;
end $$;
create trigger trade_package_assets_defaults before insert or update on public.trade_package_assets
  for each row execute function public.trade_asset_defaults();

-- ---------------------------------------------------------------------------------------------------------------
-- Identity and provenance
-- ---------------------------------------------------------------------------------------------------------------

create table public.transaction_external_ids (
  id bigint generated always as identity primary key,
  transaction_id bigint not null references public.transactions (id) on delete cascade,
  scheme text not null check (scheme ~ '^[A-Z][A-Z0-9_]{1,30}$'),
  external_id text not null check (length(external_id) between 1 and 200),
  source_id bigint not null references public.sources (id),
  created_at timestamptz not null default now(),
  unique (scheme, external_id),
  unique (transaction_id, scheme)
);

create table public.transaction_sources (
  id bigint generated always as identity primary key,
  transaction_id bigint not null references public.transactions (id) on delete cascade,
  source_id bigint not null references public.sources (id),
  role text not null check (role in ('PRIMARY_ANNOUNCEMENT', 'CORROBORATION', 'REFERENCE')),
  -- Sources that repeat or derive from one original act share a group; a group is counted once.
  independence_group text not null check (independence_group ~ '^[a-z0-9][a-z0-9_.:-]{1,80}$'),
  locator text,
  retrieved_on date,
  created_at timestamptz not null default now(),
  unique (transaction_id, source_id)
);

create table public.transaction_source_links (
  id bigint generated always as identity primary key,
  transaction_source_id bigint not null references public.transaction_sources (id) on delete cascade,
  trade_package_id bigint references public.trade_packages (id) on delete cascade,
  trade_package_asset_id bigint references public.trade_package_assets (id) on delete cascade,
  locator text,
  check (num_nonnulls(trade_package_id, trade_package_asset_id) = 1)
);
create unique index transaction_source_links_package_once on public.transaction_source_links (transaction_source_id, trade_package_id) where trade_package_id is not null;
create unique index transaction_source_links_asset_once on public.transaction_source_links (transaction_source_id, trade_package_asset_id) where trade_package_asset_id is not null;

-- A link supports a package or asset of the SAME transaction its source row belongs to.
create function public.transaction_source_link_guard() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_tx bigint;
  v_target bigint;
begin
  select transaction_id into v_tx from public.transaction_sources where id = new.transaction_source_id;
  select case when new.trade_package_id is not null then (select transaction_id from public.trade_packages where id = new.trade_package_id)
              else (select k.transaction_id from public.trade_package_assets a join public.trade_packages k on k.id = a.trade_package_id where a.id = new.trade_package_asset_id) end
    into v_target;
  if v_tx is distinct from v_target then
    raise exception 'a source link must support a package or asset of the same transaction as its source (source row in transaction %, target in %)', v_tx, v_target using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger transaction_source_links_guard before insert or update on public.transaction_source_links
  for each row execute function public.transaction_source_link_guard();

create table public.transaction_conflicts (
  id bigint generated always as identity primary key,
  transaction_id bigint not null references public.transactions (id) on delete cascade,
  field_path text not null,
  existing_value text,
  incoming_value text,
  incoming_sha256 text not null,
  import_batch_id bigint references ingest.import_batches (id),
  status text not null default 'OPEN' check (status in ('OPEN', 'RESOLVED')),
  detected_at timestamptz not null default now(),
  resolved_by text,
  resolved_at timestamptz,
  resolution_note text,
  check ((status = 'RESOLVED') = (resolved_at is not null and resolved_by is not null and resolution_note is not null)),
  unique (transaction_id, incoming_sha256, field_path)
);

-- ---------------------------------------------------------------------------------------------------------------
-- Player to be named, resolved by a dated, sourced row
-- ---------------------------------------------------------------------------------------------------------------

create table public.ptbnl_resolutions (
  id bigint generated always as identity primary key,
  trade_package_asset_id bigint not null unique references public.trade_package_assets (id) on delete cascade,
  resolution text not null check (resolution in ('PLAYER', 'CASH', 'NOTHING')),
  resolved_player_id bigint references public.players (id),
  amount_usd numeric(14, 2) check (amount_usd >= 0),
  amount_disclosure text check (amount_disclosure in ('DISCLOSED', 'UNDISCLOSED', 'UNKNOWN')),
  resolved_on date not null,
  resolved_on_precision public.date_precision not null default 'DAY',
  source_id bigint not null references public.sources (id),
  notes text,
  created_at timestamptz not null default now(),
  check ((resolution = 'PLAYER') = (resolved_player_id is not null)),
  check (resolution = 'CASH' or (amount_usd is null and amount_disclosure is null)),
  check (resolution <> 'CASH' or amount_disclosure is not null),
  check (amount_disclosure is distinct from 'DISCLOSED' or amount_usd is not null),
  check (amount_disclosure is null or amount_disclosure = 'DISCLOSED' or amount_usd is null)
);

create function public.ptbnl_resolution_guard() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  a record;
begin
  select x.id, x.asset_type, x.trade_package_id, t.transaction_date into a
  from public.trade_package_assets x join public.trade_packages k on k.id = x.trade_package_id join public.transactions t on t.id = k.transaction_id
  where x.id = new.trade_package_asset_id;
  if a.asset_type is distinct from 'PLAYER_TO_BE_NAMED' then
    raise exception 'only a player-to-be-named asset is resolved this way (asset % is %)', new.trade_package_asset_id, a.asset_type using errcode = 'check_violation';
  end if;
  if new.resolved_on < a.transaction_date then
    raise exception 'a player to be named cannot be named (%) before the trade (%)', new.resolved_on, a.transaction_date using errcode = 'check_violation';
  end if;
  -- No double counting: the named player is not already an asset of this package, nor named for another asset of it.
  if new.resolved_player_id is not null and (
       exists (select 1 from public.trade_package_assets o where o.trade_package_id = a.trade_package_id and o.player_id = new.resolved_player_id)
    or exists (select 1 from public.ptbnl_resolutions r join public.trade_package_assets o on o.id = r.trade_package_asset_id
               where o.trade_package_id = a.trade_package_id and r.resolved_player_id = new.resolved_player_id and r.trade_package_asset_id <> new.trade_package_asset_id)) then
    raise exception 'player % is already part of this package; a named player is counted once', new.resolved_player_id using errcode = 'unique_violation';
  end if;
  return new;
end $$;
create trigger ptbnl_resolutions_guard before insert or update on public.ptbnl_resolutions
  for each row execute function public.ptbnl_resolution_guard();

-- And the other way round: a player a PTBNL of this package was resolved to is not added as a direct asset of it.
create function public.trade_asset_player_guard() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.player_id is not null and exists (
       select 1 from public.ptbnl_resolutions r join public.trade_package_assets o on o.id = r.trade_package_asset_id
       where o.trade_package_id = new.trade_package_id and r.resolved_player_id = new.player_id) then
    raise exception 'player % is already part of this package through a resolved PTBNL; a named player is counted once', new.player_id using errcode = 'unique_violation';
  end if;
  return new;
end $$;
create trigger trade_package_assets_player_guard before insert or update of player_id, trade_package_id on public.trade_package_assets
  for each row execute function public.trade_asset_player_guard();

-- The players a package carries: those named directly and those a PTBNL resolved to. One row per asset. The 023 return
-- views and the 022 guard read this instead of the raw asset table, so a resolved PTBNL is counted exactly where a
-- directly named player would be. effective_on is when the club could first hold him (the naming date for a PTBNL).
create view analytics.trade_asset_players with (security_invoker = true) as
select a.id, a.trade_package_id, a.asset_type,
       coalesce(a.player_id, r.resolved_player_id) as player_id,
       (a.player_id is null and r.resolved_player_id is not null) as via_ptbnl,
       case when a.player_id is null and r.resolved_player_id is not null then r.resolved_on end as effective_on
from public.trade_package_assets a
left join public.ptbnl_resolutions r on r.trade_package_asset_id = a.id and r.resolution = 'PLAYER';

-- ---------------------------------------------------------------------------------------------------------------
-- Trade-deadline calendar
-- ---------------------------------------------------------------------------------------------------------------

create table public.season_calendar_events (
  id bigint generated always as identity primary key,
  season integer not null check (season between 1871 and 2100),
  event_type text not null check (event_type in ('OPENING_DAY', 'ALL_STAR_GAME', 'TRADE_DEADLINE', 'REGULAR_SEASON_END')),
  event_date date not null,
  source_id bigint not null references public.sources (id),
  notes text,
  created_at timestamptz not null default now(),
  unique (season, event_type),
  check (extract(year from event_date) = season)
);

-- Where each transaction falls against its season's deadline. Unknown (NULL), never false, without the calendar or a day-precise date.
create view analytics.transaction_deadline_context with (security_invoker = true) as
select t.id as transaction_id, t.transaction_date, extract(year from t.transaction_date)::integer as season,
       d.event_date as trade_deadline, a.event_date as all_star_game,
       case when d.event_date is null or t.date_precision <> 'DAY' then null else d.event_date - t.transaction_date end as days_before_deadline,
       case when d.event_date is null or a.event_date is null or t.date_precision <> 'DAY' then null
            else (t.transaction_date > a.event_date and t.transaction_date <= d.event_date) end as in_deadline_window
from public.transactions t
left join public.season_calendar_events d on d.season = extract(year from t.transaction_date) and d.event_type = 'TRADE_DEADLINE'
left join public.season_calendar_events a on a.season = extract(year from t.transaction_date) and a.event_type = 'ALL_STAR_GAME';

-- ---------------------------------------------------------------------------------------------------------------
-- Human verification (research schema: private, human-only, append-only)
-- ---------------------------------------------------------------------------------------------------------------

-- What a person is verifying, as one value: any change to any of it changes the fingerprint.
create function research.transaction_fingerprint(p_transaction_id bigint) returns text
language plpgsql stable
set search_path = pg_catalog, public, research
as $$
declare
  v text;
begin
  select concat_ws(E'\n',
    (select format('T|%s|%s|%s|%s|%s', t.transaction_type, t.transaction_date, t.date_precision, coalesce(t.description, ''), t.source_id) from public.transactions t where t.id = p_transaction_id),
    (select coalesce(string_agg(format('X|%s|%s|%s', x.scheme, x.external_id, x.source_id), E'\n' order by x.scheme, x.external_id), '') from public.transaction_external_ids x where x.transaction_id = p_transaction_id),
    (select coalesce(string_agg(format('S|%s|%s|%s|%s|%s', s.source_id, s.role, s.independence_group, coalesce(s.locator, ''), coalesce(s.retrieved_on::text, '')), E'\n' order by s.source_id), '') from public.transaction_sources s where s.transaction_id = p_transaction_id),
    (select coalesce(string_agg(format('K|%s|%s', k.from_organization_id, k.to_organization_id), E'\n' order by k.from_organization_id, k.to_organization_id), '') from public.trade_packages k where k.transaction_id = p_transaction_id),
    (select coalesce(string_agg(format('A|%s>%s|%s|%s|%s|%s|%s|%s|%s|%s', k.from_organization_id, k.to_organization_id, a.asset_type, coalesce(a.player_id::text, ''), coalesce(a.amount_usd::text, ''),
        coalesce(a.amount_disclosure, ''), a.conditional, coalesce(a.condition_text, ''), coalesce(a.description, ''),
        coalesce((select format('%s,%s,%s,%s,%s', r.resolution, coalesce(r.resolved_player_id::text, ''), coalesce(r.amount_usd::text, ''), coalesce(r.amount_disclosure, ''), r.resolved_on) from public.ptbnl_resolutions r where r.trade_package_asset_id = a.id), '')),
        E'\n' order by k.from_organization_id, k.to_organization_id, a.asset_type, coalesce(a.player_id, 0), coalesce(a.description, ''), coalesce(a.condition_text, ''), a.id), '')
       from public.trade_package_assets a join public.trade_packages k on k.id = a.trade_package_id where k.transaction_id = p_transaction_id),
    (select coalesce(string_agg(format('L|%s|%s', l.transaction_source_id, coalesce('P' || l.trade_package_id, 'A' || l.trade_package_asset_id)), E'\n' order by l.transaction_source_id, l.trade_package_id, l.trade_package_asset_id), '')
       from public.transaction_source_links l join public.transaction_sources s on s.id = l.transaction_source_id where s.transaction_id = p_transaction_id),
    (select coalesce(string_agg(format('C|%s|%s|%s', c.field_path, c.incoming_sha256, c.status), E'\n' order by c.field_path, c.incoming_sha256), '') from public.transaction_conflicts c where c.transaction_id = p_transaction_id)
  ) into v;
  return encode(sha256(convert_to(v, 'UTF8')), 'hex');
end $$;

-- Everything that stands between a record and VERIFIED_COMPLETE. Empty = a person may verify it.
create function research.transaction_gaps(p_transaction_id bigint) returns text[]
language plpgsql stable
set search_path = pg_catalog, public, research
as $$
declare
  t record;
  g text[] := '{}';
  n integer;
  groups integer;
begin
  select * into t from public.transactions where id = p_transaction_id;
  if not found then return array['NO_SUCH_TRANSACTION']; end if;
  if not exists (select 1 from public.transaction_external_ids where transaction_id = p_transaction_id) then g := array_append(g, 'NO_EXTERNAL_ID'); end if;
  select count(*) into n from public.trade_packages where transaction_id = p_transaction_id;
  if n = 0 then g := array_append(g, 'NO_PACKAGES');
  elsif t.transaction_type = 'TRADE' and n < 2 then g := array_append(g, 'ONE_SIDED_TRADE');
  end if;
  if exists (select 1 from public.trade_packages k where k.transaction_id = p_transaction_id and not exists (select 1 from public.trade_package_assets a where a.trade_package_id = k.id)) then g := array_append(g, 'EMPTY_PACKAGE'); end if;
  select count(distinct independence_group) into groups from public.transaction_sources where transaction_id = p_transaction_id;
  if groups = 0 then g := array_append(g, 'NO_SOURCES');
  elsif groups < 2 then g := array_append(g, 'FEWER_THAN_TWO_INDEPENDENT_SOURCES');
  end if;
  if not exists (select 1 from public.transaction_sources where transaction_id = p_transaction_id and role = 'PRIMARY_ANNOUNCEMENT') then g := array_append(g, 'NO_PRIMARY_ANNOUNCEMENT'); end if;
  if exists (select 1 from public.trade_packages k where k.transaction_id = p_transaction_id
             and (select count(distinct s.independence_group) from public.transaction_source_links l join public.transaction_sources s on s.id = l.transaction_source_id where l.trade_package_id = k.id) < 2)
    then g := array_append(g, 'PACKAGE_NOT_CORROBORATED'); end if;
  if exists (select 1 from public.trade_package_assets a join public.trade_packages k on k.id = a.trade_package_id where k.transaction_id = p_transaction_id
             and (select count(distinct s.independence_group) from public.transaction_source_links l join public.transaction_sources s on s.id = l.transaction_source_id where l.trade_package_asset_id = a.id) < 2)
    then g := array_append(g, 'ASSET_NOT_CORROBORATED'); end if;
  if exists (select 1 from public.trade_package_assets a join public.trade_packages k on k.id = a.trade_package_id
             where k.transaction_id = p_transaction_id and a.asset_type = 'PLAYER_TO_BE_NAMED'
               and not exists (select 1 from public.ptbnl_resolutions r where r.trade_package_asset_id = a.id))
    then g := array_append(g, 'PENDING_PTBNL'); end if;
  if exists (select 1 from public.trade_package_assets a join public.trade_packages k on k.id = a.trade_package_id
             where k.transaction_id = p_transaction_id and a.asset_type in ('CASH', 'INTERNATIONAL_POOL_SPACE') and coalesce(a.amount_disclosure, 'UNKNOWN') = 'UNKNOWN')
    then g := array_append(g, 'CASH_AMOUNT_UNKNOWN'); end if;
  if exists (select 1 from public.trade_package_assets a join public.trade_packages k on k.id = a.trade_package_id join public.ptbnl_resolutions r on r.trade_package_asset_id = a.id
             where k.transaction_id = p_transaction_id and r.resolution = 'CASH' and r.amount_disclosure = 'UNKNOWN')
    then g := array_append(g, 'CASH_AMOUNT_UNKNOWN'); end if;
  if exists (select 1 from public.transaction_conflicts where transaction_id = p_transaction_id and status = 'OPEN') then g := array_append(g, 'OPEN_CONFLICT'); end if;
  return (select coalesce(array_agg(distinct x order by x), '{}') from unnest(g) x);
end $$;

create table research.transaction_verifications (
  id bigint generated always as identity primary key,
  transaction_id bigint not null references public.transactions (id) on delete restrict,
  verified_by text not null,
  verified_session_role name not null default session_user,
  verified_at timestamptz not null default now(),
  content_fingerprint text not null,
  basis_note text not null check (length(basis_note) >= 10),
  independence_note text not null check (length(independence_note) >= 10),
  state text not null default 'ACTIVE' check (state in ('ACTIVE', 'REVOKED')),
  revoked_at timestamptz,
  revoked_by text,
  revoked_reason text,
  revoked_automatically boolean not null default false,
  check ((state = 'REVOKED') = (revoked_at is not null and revoked_by is not null and revoked_reason is not null))
);
create unique index transaction_verifications_one_active on research.transaction_verifications (transaction_id) where state = 'ACTIVE';

create function research.transaction_verification_guard() returns trigger
language plpgsql security definer
set search_path = pg_catalog, public, research
as $$
declare
  v_gaps text[];
begin
  if tg_op = 'DELETE' then raise exception 'a verification is revoked, never deleted' using errcode = 'check_violation'; end if;
  if tg_op = 'INSERT' then
    if not research.certification_enabled() then
      raise exception 'verification is disabled (research.certification_gate): reviewer identity is not yet robust against the credentials the automation holds' using errcode = 'insufficient_privilege';
    end if;
    if research.session_reviewer() is null or new.verified_by is distinct from research.session_reviewer() then
      raise exception 'verification needs an enrolled human reviewer in their own authenticated session (session %, verified_by %)', session_user, new.verified_by using errcode = 'insufficient_privilege';
    end if;
    if new.state <> 'ACTIVE' then raise exception 'a verification is created active' using errcode = 'check_violation'; end if;
    v_gaps := research.transaction_gaps(new.transaction_id);
    if cardinality(v_gaps) > 0 then
      raise exception 'transaction % cannot be verified complete: %', new.transaction_id, array_to_string(v_gaps, ', ') using errcode = 'check_violation';
    end if;
    if new.content_fingerprint is distinct from research.transaction_fingerprint(new.transaction_id) then
      raise exception 'the verification does not describe the transaction as it is now' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if (new.transaction_id, new.verified_by, new.verified_session_role, new.verified_at, new.content_fingerprint, new.basis_note, new.independence_note)
     is distinct from (old.transaction_id, old.verified_by, old.verified_session_role, old.verified_at, old.content_fingerprint, old.basis_note, old.independence_note) then
    raise exception 'a verification is immutable except for its revocation' using errcode = 'check_violation';
  end if;
  if old.state = 'REVOKED' and (new.state, new.revoked_at, new.revoked_by, new.revoked_reason) is distinct from (old.state, old.revoked_at, old.revoked_by, old.revoked_reason) then
    raise exception 'a revocation is final' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger transaction_verifications_guard before insert or update or delete on research.transaction_verifications
  for each row execute function research.transaction_verification_guard();
create trigger transaction_verifications_no_truncate before truncate on research.transaction_verifications
  for each statement execute function research.decision_history_append_only();

-- Any change to what was verified revokes the verification in the same transaction, whoever makes it and however.
create function research.transaction_changed() returns trigger
language plpgsql security definer
set search_path = pg_catalog, public, research
as $$
declare
  v_tx bigint;
begin
  if tg_table_name = 'transactions' then v_tx := case when tg_op = 'DELETE' then old.id else new.id end;
  elsif tg_table_name in ('trade_packages', 'transaction_external_ids', 'transaction_sources', 'transaction_conflicts') then
    v_tx := case when tg_op = 'DELETE' then old.transaction_id else new.transaction_id end;
  elsif tg_table_name = 'trade_package_assets' then
    select transaction_id into v_tx from public.trade_packages where id = case when tg_op = 'DELETE' then old.trade_package_id else new.trade_package_id end;
  elsif tg_table_name = 'transaction_source_links' then
    select transaction_id into v_tx from public.transaction_sources where id = case when tg_op = 'DELETE' then old.transaction_source_id else new.transaction_source_id end;
  elsif tg_table_name = 'ptbnl_resolutions' then
    select k.transaction_id into v_tx from public.trade_package_assets a join public.trade_packages k on k.id = a.trade_package_id
    where a.id = case when tg_op = 'DELETE' then old.trade_package_asset_id else new.trade_package_asset_id end;
  end if;
  -- Resolving a conflict is a deliberate human act on a record that cannot be verified while the conflict is open.
  if tg_table_name = 'transaction_conflicts' and tg_op = 'UPDATE' then
    if old.status = 'OPEN' and new.status = 'RESOLVED' then v_tx := null; end if;
  end if;
  if v_tx is not null then
    update research.transaction_verifications
       set state = 'REVOKED', revoked_at = now(), revoked_by = 'system:evidence-changed', revoked_automatically = true,
           revoked_reason = format('%s on %s changed a verified transaction (session %s)', lower(tg_op), tg_table_name, session_user)
     where transaction_id = v_tx and state = 'ACTIVE';
  end if;
  return null;
end $$;

do $$
declare
  t text;
begin
  foreach t in array array['transactions', 'trade_packages', 'trade_package_assets', 'transaction_external_ids', 'transaction_sources', 'transaction_source_links', 'ptbnl_resolutions', 'transaction_conflicts'] loop
    execute format('create trigger %I after update or delete on public.%I for each row execute function research.transaction_changed()', t || '_unverify_ud', t);
    if t <> 'transactions' then
      execute format('create trigger %I after insert on public.%I for each row execute function research.transaction_changed()', t || '_unverify_i', t);
    end if;
  end loop;
end $$;

-- Derived state. VERIFIED_COMPLETE only while an active verification carries the current fingerprint; PARTIAL once any
-- source is recorded; UNVERIFIED otherwise (every record from before 028). gaps lists what a person would have to fix.
create view analytics.transaction_completeness with (security_invoker = true) as
select t.id as transaction_id,
       case when v.id is not null and v.content_fingerprint = research.transaction_fingerprint(t.id) then 'VERIFIED_COMPLETE'
            when exists (select 1 from public.transaction_sources s where s.transaction_id = t.id) then 'PARTIAL'
            else 'UNVERIFIED' end as completeness,
       research.transaction_gaps(t.id) as gaps,
       (select count(distinct s.independence_group)::integer from public.transaction_sources s where s.transaction_id = t.id) as independent_source_groups,
       v.verified_by, v.verified_at,
       (v.id is not null and v.content_fingerprint <> research.transaction_fingerprint(t.id)) as verification_stale
from public.transactions t
left join research.transaction_verifications v on v.transaction_id = t.id and v.state = 'ACTIVE';

create function research.verify_transaction(p_transaction_id bigint, p_basis text, p_independence text) returns research.transaction_verifications
language plpgsql security definer
set search_path = pg_catalog, public, research
as $$
declare
  r research.transaction_verifications;
begin
  insert into research.transaction_verifications (transaction_id, verified_by, content_fingerprint, basis_note, independence_note)
  values (p_transaction_id, research.require_reviewer(), research.transaction_fingerprint(p_transaction_id), p_basis, p_independence)
  returning * into r;
  return r;
end $$;

create function research.revoke_transaction_verification(p_transaction_id bigint, p_reason text) returns research.transaction_verifications
language plpgsql security definer
set search_path = pg_catalog, public, research
as $$
declare
  r research.transaction_verifications;
  v_by text := research.require_reviewer();
begin
  update research.transaction_verifications
     set state = 'REVOKED', revoked_at = now(), revoked_by = v_by, revoked_reason = p_reason
   where transaction_id = p_transaction_id and state = 'ACTIVE' returning * into r;
  if r.id is null then raise exception 'transaction % has no active verification', p_transaction_id using errcode = 'no_data_found'; end if;
  return r;
end $$;

-- Only a human resolves an importer-detected conflict (the decision itself is recorded on the row).
create function research.transaction_conflict_guard() returns trigger
language plpgsql security definer
set search_path = pg_catalog, public, research
as $$
begin
  if tg_op = 'DELETE' then raise exception 'a conflict is resolved, never deleted' using errcode = 'check_violation'; end if;
  if tg_op = 'UPDATE' then
    if (new.transaction_id, new.field_path, new.existing_value, new.incoming_value, new.incoming_sha256) is distinct from (old.transaction_id, old.field_path, old.existing_value, old.incoming_value, old.incoming_sha256) then
      raise exception 'a conflict record is immutable except for its resolution' using errcode = 'check_violation';
    end if;
    if old.status = 'RESOLVED' then raise exception 'a resolved conflict is final' using errcode = 'check_violation'; end if;
    if new.status = 'RESOLVED' and (research.session_reviewer() is null or new.resolved_by is distinct from research.session_reviewer()) then
      raise exception 'a conflict is resolved by an enrolled human reviewer in their own session (session %)', session_user using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end $$;
create trigger transaction_conflicts_guard before update or delete on public.transaction_conflicts
  for each row execute function research.transaction_conflict_guard();

create function research.resolve_transaction_conflict(p_conflict_id bigint, p_note text) returns public.transaction_conflicts
language plpgsql security definer
set search_path = pg_catalog, public, research
as $$
declare
  c public.transaction_conflicts;
  v_by text := research.require_reviewer();
begin
  update public.transaction_conflicts set status = 'RESOLVED', resolved_by = v_by, resolved_at = now(), resolution_note = p_note
   where id = p_conflict_id returning * into c;
  if c.id is null then raise exception 'conflict % not found', p_conflict_id using errcode = 'no_data_found'; end if;
  return c;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Importer replay protection (ingest)
-- ---------------------------------------------------------------------------------------------------------------

create table ingest.transaction_apply_ledger (
  id bigint generated always as identity primary key,
  import_batch_id bigint not null references ingest.import_batches (id),
  record_index integer not null,
  record_sha256 text not null,
  transaction_id bigint references public.transactions (id) on delete set null,
  action text not null,
  applied_at timestamptz not null default now(),
  unique (import_batch_id, record_index)
);

-- ---------------------------------------------------------------------------------------------------------------
-- Existing views and guard read players through trade_asset_players (identical results until a PTBNL is resolved)
-- ---------------------------------------------------------------------------------------------------------------

-- trade_returns (023): same columns and rules; the received and sent players now include a PTBNL once resolved to a player.
create or replace view analytics.trade_returns with (security_invoker = true) as
with sys as (select unnest(array['BREF', 'FANGRAPHS']::public.war_system[]) as war_system),
sent as (
  select k.id as package_id, k.transaction_id, t.transaction_date, k.from_organization_id as organization_id, k.to_organization_id as counterparty_id,
         coalesce(array_agg(a.player_id order by a.player_id) filter (where a.player_id is not null), '{}') as sent_player_ids,
         (count(a.id) filter (where a.asset_type <> 'PLAYER'))::integer as other_assets_sent
  from public.trade_packages k
  join public.transactions t on t.id = k.transaction_id
  left join analytics.trade_asset_players a on a.trade_package_id = k.id
  group by k.id, k.transaction_id, t.transaction_date, k.from_organization_id, k.to_organization_id
),
received as (
  select k.transaction_id, t.transaction_date, coalesce(a.effective_on, t.transaction_date) as effective_date, k.to_organization_id as organization_id, a.player_id,
         -- the season the club next traded this player away, if it did
         (select min(extract(year from t2.transaction_date))::integer from public.trade_packages k2
            join public.transactions t2 on t2.id = k2.transaction_id
            join analytics.trade_asset_players a2 on a2.trade_package_id = k2.id
          where k2.from_organization_id = k.to_organization_id and a2.player_id = a.player_id and t2.transaction_date > t.transaction_date) as left_season
  from public.trade_packages k join public.transactions t on t.id = k.transaction_id join analytics.trade_asset_players a on a.trade_package_id = k.id
  where a.player_id is not null
)
select o.package_id, o.transaction_id, o.transaction_date, o.organization_id, o.counterparty_id, o.sent_player_ids,
       cardinality(o.sent_player_ids) as players_sent, o.other_assets_sent, s.war_system,
       coalesce((select array_agg(r.player_id order by r.player_id) from received r where r.transaction_id = o.transaction_id and r.organization_id = o.organization_id), '{}') as received_player_ids,
       -- known WAR the received players produced for the club; 0 when every received player is accounted for and produced none
       case when exists (select 1 from received r join analytics.player_war_coverage c on c.player_id = r.player_id and c.war_system = s.war_system
                         where r.transaction_id = o.transaction_id and r.organization_id = o.organization_id and c.coverage in ('COMPLETE', 'PARTIAL', 'NO_MLB'))
            then coalesce((select sum(w.war_value) from received r
              join analytics.player_season_war w on w.player_id = r.player_id and w.organization_id = o.organization_id and w.war_system = s.war_system
               and w.season >= extract(year from r.effective_date) and (r.left_season is null or w.season <= r.left_season)
            where r.transaction_id = o.transaction_id and r.organization_id = o.organization_id), 0) end as return_war_known,
       case
         when not exists (select 1 from received r where r.transaction_id = o.transaction_id and r.organization_id = o.organization_id) then 'NO_PLAYERS_RECEIVED'
         when not exists (select 1 from received r join analytics.player_war_coverage c on c.player_id = r.player_id and c.war_system = s.war_system
                          where r.transaction_id = o.transaction_id and r.organization_id = o.organization_id and c.coverage not in ('COMPLETE', 'NO_MLB')) then 'COMPLETE'
         else 'PARTIAL'
       end as return_coverage
from sent o cross join sys s;

-- acquisition_disposition_guard (022): same checks; a TRADED exit may name a player who was a resolved PTBNL of that package.
create or replace function public.acquisition_disposition_guard() returns trigger
language plpgsql
set search_path = pg_catalog, public, analytics
as $$
declare
  a record;
  v_bad text;
begin
  -- Re-check every disposition attached to the changed row (a signing status change can contradict one).
  for a in
    select x.*, v.player_id as acq_player, v.organization_id as acq_org, v.signing_status, v.acquired_on, v.scope_key, v.channel
    from public.acquisition_dispositions x
    join analytics.player_acquisitions v on (v.draft_selection_id = x.draft_selection_id or v.international_signing_id = x.international_signing_id)
    where (tg_table_name = 'acquisition_dispositions' and x.id = new.id)
       or (tg_table_name = 'draft_signings' and x.draft_selection_id = coalesce(new.draft_selection_id, old.draft_selection_id))
  loop
    v_bad := case
      when a.player_id <> a.acq_player or a.organization_id <> a.acq_org then 'its player or organization differs from the acquisition'
      when a.disposition = 'UNSIGNED' and a.channel = 'INTERNATIONAL' then 'UNSIGNED on an international signing'
      when a.disposition = 'UNSIGNED' and a.signing_status = 'SIGNED' then format('UNSIGNED, but the %s acquisition signed', a.scope_key)
      when a.disposition not in ('UNSIGNED', 'UNKNOWN') and a.signing_status = 'DID_NOT_SIGN' then format('%s, but the %s pick did not sign', a.disposition, a.scope_key)
      when a.disposition_date is not null and a.disposition_date < a.acquired_on then format('the exit (%s) predates the acquisition (%s)', a.disposition_date, a.acquired_on)
      when a.disposition = 'TRADED' and not exists (
        select 1 from public.trade_packages k join analytics.trade_asset_players t on t.trade_package_id = k.id
        where k.transaction_id = a.disposition_transaction_id and k.from_organization_id = a.organization_id and t.player_id = a.player_id)
        then 'TRADED, but its transaction did not send this player from this organization'
      when a.disposition = 'TRADED' and a.disposition_date is not null
           and a.disposition_date <> (select transaction_date from public.transactions where id = a.disposition_transaction_id)
        then 'the exit date differs from the trade date'
    end;
    if v_bad is not null then
      raise exception 'acquisition disposition % is inconsistent: %', a.id, v_bad using errcode = 'check_violation';
    end if;
  end loop;
  return null;
end $$;
alter function public.acquisition_disposition_guard() security definer;   -- as in 022: fires at commit, in any session

-- ---------------------------------------------------------------------------------------------------------------
-- Boundary: internal until the transaction detail view exists; two tables join the provenance registry
-- ---------------------------------------------------------------------------------------------------------------

insert into public.provenance_fact_tables (table_name, domain, description) values
  ('ptbnl_resolutions', 'TRANSACTION', 'A player to be named resolved to a player, cash or nothing'),
  ('season_calendar_events', 'TRANSACTION', 'Season calendar event (opening day, All-Star Game, trade deadline, season end)')
on conflict (table_name) do nothing;

insert into public.internal_objects values
  ('transaction_external_ids', 'phase 16: internal until the transaction detail view'),
  ('transaction_sources', 'phase 16: internal until the transaction detail view'),
  ('transaction_source_links', 'phase 16: internal until the transaction detail view'),
  ('transaction_conflicts', 'research worklist'),
  ('ptbnl_resolutions', 'phase 16: internal until the transaction detail view'),
  ('season_calendar_events', 'phase 16: internal until the transaction detail view')
on conflict (object_name) do nothing;

alter table research.transaction_verifications enable row level security;
select public.apply_public_boundary();
revoke all on all tables in schema research from public, anon, authenticated, service_role;
revoke all on all sequences in schema research from public, anon, authenticated, service_role;
revoke all on all functions in schema research from public, anon, authenticated, service_role;
revoke all on ingest.transaction_apply_ledger from public, anon, authenticated, service_role;
revoke all on all tables in schema analytics from public, anon, authenticated, service_role;
revoke execute on all functions in schema public from public, anon, authenticated;

grant execute on function research.verify_transaction(bigint, text, text), research.revoke_transaction_verification(bigint, text),
  research.resolve_transaction_conflict(bigint, text) to bai_reviewer;
