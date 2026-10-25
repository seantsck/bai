-- 030_transaction_public_read_model
-- Phase 18: what a public historical-acquisition explorer needs, additive, over 028 (transaction foundation) and 029 (value-view scale).
--
-- THREE STATES THAT ARE NEVER MERGED
--   1. A source licensed for public display      ingest.source_publication_grants (025): a row for the source's attribution category.
--   2. A transaction VERIFIED_COMPLETE           analytics.transaction_completeness (028): an active, current human verification.
--   3. A club-season population COMPLETE_CENSUS  public.coverage_assessments (004): an expected population, sourced and matched.
-- A one-source transaction from an authorized source is shown as PARTIAL: authorization says nothing about completeness, and no
-- transaction is complete without a human verification. No grant is created here; hosted starts with none.
--
-- WHAT THIS ADDS
--   * the RETROSHEET attribution category (strict identity: type REFERENCE_DATABASE, www.retrosheet.org, publisher "Retrosheet", key
--     hist:retrosheet-...). It is NOT among the openly licensed groups the publication guard exempts, so on a hosted database a new record
--     citing it is refused until a person records a grant (the guard of 025/027 is unchanged). The grants table accepts the category.
--   * public.source_attribution_statements: the statement a source requires wherever its records are shown, verbatim. Retrosheet's is from
--     https://www.retrosheet.org/notice.txt (read 2026-10-25, sha256 2218abe6...): "free to make any desired use, including selling it, ...
--     provided the attribution statement appears prominently".
--   * non-trade acquisitions: transaction types FREE_AGENT_SIGNING and AMATEUR_FREE_AGENT_SIGNING, public.transaction_player_moves (the
--     player a club acquired, from whom, with the source's own event code), an ACQUISITIONS import channel. Departures, voids, draft
--     selections and roster-status rows are not acquisitions and are never imported here. Salaries, contract terms and service time are
--     not recorded. A non-trade transaction has no verification rule yet (gap NON_TRADE_VERIFICATION_NOT_DEFINED): it can be PARTIAL, never complete.
--   * the public read model (rm_transaction_*), refreshed only by public.refresh_transaction_read_models() (owner-run, never by a request).
--     A transaction enters it only if EVERY source it cites is authorized for display; WAR figures only if their provider's sources are.
--     It carries no research notes, no reviewer identity and no restricted-source text: the verifier appears as "verified on <date>" only.
--     Page queries are bounded, indexed and paginated; nothing public reads analytics.* or research.*.
-- Existing rows, views and privileges are untouched. Transaction types and the channel are enum additions only (no existing value changes).

-- ---------------------------------------------------------------------------------------------------------------
-- 1. Retrosheet attribution category and its grant slot
-- ---------------------------------------------------------------------------------------------------------------

create or replace function public.source_attribution_category(p_url text, p_source_key text, p_publisher text, p_title text, p_source_type public.source_type)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog
as $$
  select case
    when p_source_type = 'TEST_FIXTURE' then 'TEST_FIXTURE'
    when lower(coalesce(p_url, '') || ' ' || p_source_key || ' ' || coalesce(p_publisher, '') || ' ' || p_title) ~ '(baseball-reference\.com|sports-reference\.com|sports reference)' then 'BASEBALL_REFERENCE'
    when p_source_type = 'OFFICIAL_LEAGUE'
      or lower(coalesce(p_url, '') || ' ' || p_source_key || ' ' || coalesce(p_publisher, '') || ' ' || p_title) ~ '(statsapi\.mlb\.com|(^|[/.])mlb\.com|(^|[/.])milb\.com|mlb advanced media|mlb stats api|mlb-statsapi)' then 'MLB'
    when p_source_type = 'REFERENCE_DATABASE'
      and coalesce(p_url, '') ~ '^https://(www\.wikidata\.org|query\.wikidata\.org)(/|\?|$)'
      and coalesce(p_url, '') !~ '\s'
      and p_publisher = 'Wikimedia Foundation (Wikidata contributors)'
      and p_source_key ~ '^hist:wikidata-[a-z0-9._:-]+$' then 'WIKIDATA'
    when p_source_type = 'REFERENCE_DATABASE'
      and coalesce(p_url, '') ~ '^https://github\.com/chadwickbureau/register(/|$)'
      and coalesce(p_url, '') !~ '\s'
      and p_publisher in ('Chadwick Baseball Bureau', 'Chadwick Baseball Bureau (GitHub)') then 'CHADWICK_REGISTER'
    when p_source_type = 'REFERENCE_DATABASE'
      and coalesce(p_url, '') ~ '^https://en\.wikipedia\.org/'
      and coalesce(p_url, '') !~ '\s'
      and p_publisher in ('Wikipedia', 'Wikimedia Foundation (contributors)') then 'WIKIPEDIA'
    when p_source_type = 'REFERENCE_DATABASE'
      and coalesce(p_url, '') ~ '^https://www\.retrosheet\.org/(transactions/|notice\.txt)'
      and coalesce(p_url, '') !~ '\s'
      and p_publisher = 'Retrosheet'
      and p_source_key ~ '^hist:retrosheet-[a-z0-9._:-]+$' then 'RETROSHEET'
    when p_source_type = 'BAI_REFERENCE' and p_source_key ~ '^bai-reference:[a-z0-9._:-]+$' then 'BAI_RESEARCH'
    else 'OTHER_PUBLICATION'
  end
$$;


alter table ingest.source_publication_grants drop constraint source_publication_grants_attribution_category_check;
alter table ingest.source_publication_grants add constraint source_publication_grants_attribution_category_check
  check (attribution_category in ('MLB', 'BASEBALL_REFERENCE', 'OTHER_PUBLICATION', 'TEST_FIXTURE', 'RETROSHEET'));

create table public.source_attribution_statements (
  attribution_category text primary key,
  statement text not null check (btrim(statement) <> ''),
  notice_url text not null check (notice_url ~ '^https://'),
  condition_text text not null,
  verified_on date not null
);
comment on table public.source_attribution_statements is 'The attribution statement a source group requires wherever its records are shown, verbatim from its published notice (030). The pages render it prominently; it is not a grant.';
insert into public.source_attribution_statements (attribution_category, statement, notice_url, condition_text, verified_on) values
  ('RETROSHEET',
   'The information used here was obtained free of charge from and is copyrighted by Retrosheet. Interested parties may contact Retrosheet at "www.retrosheet.org".',
   'https://www.retrosheet.org/notice.txt',
   'Recipients may make any desired use of the information, including selling it, giving it away, or producing a commercial product, if this statement appears prominently. Retrosheet makes no guarantee of accuracy.',
   date '2026-10-25');

-- ---------------------------------------------------------------------------------------------------------------
-- 2. Non-trade acquisitions
-- ---------------------------------------------------------------------------------------------------------------

alter type public.transaction_type add value if not exists 'FREE_AGENT_SIGNING';
alter type public.transaction_type add value if not exists 'AMATEUR_FREE_AGENT_SIGNING';
alter type ingest.batch_channel add value if not exists 'ACQUISITIONS';

alter table ingest.staged_records drop constraint staged_records_record_type_check;
alter table ingest.staged_records add constraint staged_records_record_type_check
  check (record_type in ('DRAFT_SELECTION', 'INTERNATIONAL_SIGNING', 'OUTCOME_AUDIT', 'TRADE', 'ACQUISITION'));

-- The player a club acquired in a non-trade transaction. from_* is the club or team the player came from (none for a free agent);
-- from_club_text names an independent or minor-league club that is not one of BAI's organizations. The source's own event code is kept.
create table public.transaction_player_moves (
  id bigint generated always as identity primary key,
  transaction_id bigint not null references public.transactions (id) on delete cascade,
  player_id bigint not null references public.players (id),
  to_organization_id bigint not null references public.organizations (id),
  from_organization_id bigint references public.organizations (id),
  from_club_text text,
  source_event_code text not null check (btrim(source_event_code) <> ''),
  source_info text,                  -- the source's own note for the row, verbatim; never parsed into an amount, term or length
  created_at timestamptz not null default now(),
  check (from_organization_id is distinct from to_organization_id),
  check (num_nonnulls(from_organization_id, from_club_text) <= 1),
  unique (transaction_id, player_id)
);
create index transaction_player_moves_player_idx on public.transaction_player_moves (player_id);
create index transaction_player_moves_org_idx on public.transaction_player_moves (to_organization_id, transaction_id);

create function public.transaction_player_move_guard() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v text;
begin
  select transaction_type::text into v from public.transactions where id = new.transaction_id;
  if v not in ('FREE_AGENT_SIGNING', 'AMATEUR_FREE_AGENT_SIGNING', 'WAIVER_CLAIM', 'PURCHASE', 'RULE_5') then
    raise exception 'a player move records a non-trade acquisition (free agent, amateur free agent, waiver claim, purchase, Rule 5); transaction % is %', new.transaction_id, v using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger transaction_player_moves_guard before insert or update on public.transaction_player_moves
  for each row execute function public.transaction_player_move_guard();

-- A trade cannot also carry moves (and a non-trade carries no packages): the two shapes stay apart.
create function public.transaction_package_shape_guard() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if exists (select 1 from public.transaction_player_moves m where m.transaction_id = new.transaction_id) then
    raise exception 'transaction % records player moves; trade packages belong to trades only', new.transaction_id using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger trade_packages_shape_guard before insert on public.trade_packages
  for each row execute function public.transaction_package_shape_guard();

-- Verification for non-trade acquisitions is not defined: they can be PARTIAL, never VERIFIED_COMPLETE.
create or replace function research.transaction_gaps(p_transaction_id bigint) returns text[]
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
  -- only a trade has packages to corroborate; other acquisitions are recorded (029+) but have no verification rule yet
  if t.transaction_type::text <> 'TRADE' then return array['NON_TRADE_VERIFICATION_NOT_DEFINED']; end if;
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


-- ---------------------------------------------------------------------------------------------------------------
-- 3. The public read model
-- ---------------------------------------------------------------------------------------------------------------

create table public.rm_transaction_refreshes (
  generation_id bigint primary key,
  refreshed_at timestamptz not null default now(),
  transactions integer not null,
  withheld_unauthorized integer not null
);

create table public.rm_transactions (
  transaction_id bigint primary key,
  season integer not null,
  transaction_date date not null,
  date_precision public.date_precision not null,
  transaction_type text not null,
  category text not null check (category in ('TRADE', 'FREE_AGENT', 'AMATEUR_FREE_AGENT', 'WAIVER', 'PURCHASE', 'RULE_5', 'OTHER')),
  club_keys text[] not null,
  parties jsonb not null,
  -- reconstruction status (028): UNVERIFIED (no source recorded), PARTIAL (sourced, not verified or with gaps), VERIFIED_COMPLETE (active, current human verification)
  status text not null check (status in ('UNVERIFIED', 'PARTIAL', 'VERIFIED_COMPLETE')),
  gaps text[] not null,
  independent_source_groups integer not null,
  verified_on date,
  source_categories text[] not null,
  attribution_required boolean not null,
  asset_count integer not null,
  player_count integer not null,
  cash_unknown boolean not null,
  has_unresolved_ptbnl boolean not null,
  search_tsv tsvector not null,
  generation_id bigint not null,
  check ((status = 'VERIFIED_COMPLETE') = (verified_on is not null))
);
create index rm_transactions_season_idx on public.rm_transactions (season, transaction_date desc, transaction_id desc);
create index rm_transactions_date_idx on public.rm_transactions (transaction_date desc, transaction_id desc);
create index rm_transactions_category_idx on public.rm_transactions (category, transaction_date desc, transaction_id desc);
create index rm_transactions_status_idx on public.rm_transactions (status, transaction_date desc, transaction_id desc);
create index rm_transactions_clubs_idx on public.rm_transactions using gin (club_keys);
create index rm_transactions_search_idx on public.rm_transactions using gin (search_tsv);

create table public.rm_transaction_assets (
  transaction_id bigint not null,
  position integer not null,
  from_key text,
  from_club_text text,
  to_key text,
  asset_kind text not null,
  player_id bigint,
  player_slug text,
  player_name text,
  detail text,
  conditional boolean not null,
  condition_text text,
  amount_status text,                -- cash and slot money only: DISCLOSED, UNDISCLOSED or UNKNOWN (never zero by default)
  amount_usd numeric(14, 2),         -- only when DISCLOSED
  resolution_kind text,              -- a PTBNL's resolution: PLAYER, CASH or NOTHING (null = still pending)
  resolved_player_slug text,
  resolved_player_name text,
  resolved_on date,
  source_event_code text,
  primary key (transaction_id, position)
);

create table public.rm_transaction_players (
  transaction_id bigint not null,
  player_id bigint not null,
  player_slug text not null,
  player_name text not null,
  role text not null check (role in ('ASSET', 'NAMED_LATER')),
  primary key (transaction_id, player_id)
);
create index rm_transaction_players_player_idx on public.rm_transaction_players (player_id);

-- Subsequent movement of a player, as established by LATER transactions in this same published ledger (not a career history).
create table public.rm_transaction_followups (
  transaction_id bigint not null,
  player_id bigint not null,
  step integer not null,
  later_transaction_id bigint not null,
  later_date date not null,
  later_category text not null,
  later_club_keys text[] not null,
  primary key (transaction_id, player_id, step)
);

create table public.rm_transaction_returns (
  transaction_id bigint not null,
  club_key text not null,
  counterparty_key text not null,
  provider text not null,
  players_sent integer not null,
  players_received integer not null,
  return_war_known numeric,
  evidence text not null check (evidence in ('OBSERVED_COMPLETE', 'OBSERVED_PARTIAL', 'NOT_OBSERVED', 'WITHHELD_PERMISSION')),
  primary key (transaction_id, club_key, counterparty_key, provider)
);

create table public.rm_transaction_sources (
  transaction_id bigint not null,
  position integer not null,
  title text not null,
  publisher text,
  url text,
  attribution_category text not null,
  role text not null,
  independence_group text,
  locator text,
  primary key (transaction_id, position)
);

create table public.rm_transaction_coverage (
  season integer not null,
  club_key text not null,
  category text not null,
  records integer not null,
  unverified integer not null,
  partial integer not null,
  verified_complete integer not null,
  with_unresolved_assets integer not null,
  primary key (season, club_key, category)
);

-- Per club and season: the population state, separate from the licence and from any transaction's verification.
create table public.rm_transaction_club_seasons (
  season integer not null,
  club_key text not null,
  records integer not null,
  coverage_state text not null,      -- NOT_ASSESSED unless a coverage assessment exists (004); only COMPLETE_CENSUS means a complete population
  expected_count integer,
  primary key (season, club_key)
);

create table public.rm_transaction_overview (
  singleton boolean primary key default true check (singleton),
  generation_id bigint not null,
  refreshed_at timestamptz not null,
  transactions integer not null,
  by_status jsonb not null,
  by_category jsonb not null,
  first_season integer,
  last_season integer,
  display_authorized_categories text[] not null,
  withheld_unauthorized integer not null,
  verified_complete integer not null,
  complete_census_club_seasons integer not null
);

insert into public.internal_objects values
  ('transaction_player_moves', 'internal until published through rm_transaction_assets'),
  ('rm_transaction_refreshes', 'refresh bookkeeping')
on conflict (object_name) do nothing;

-- ---------------------------------------------------------------------------------------------------------------
-- Refresh: serialized, convergent, validated. Owner-run (not executable by the public roles).
-- ---------------------------------------------------------------------------------------------------------------

create function public.refresh_transaction_read_models() returns bigint
language plpgsql
set search_path = pg_catalog, public, analytics, ingest, research
as $$
declare
  v_generation bigint;
  v_displayable integer;
  v_withheld integer;
begin
  lock table public.rm_transaction_refreshes in exclusive mode;
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
           string_agg(distinct o.current_name, ' ') as club_names
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
  left join lateral (select string_agg(public.normalize_name(p.player_name), ' ') as names from public.rm_transaction_players p where p.transaction_id = t.id) pn on true;

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
  insert into public.rm_transaction_returns (transaction_id, club_key, counterparty_key, provider, players_sent, players_received, return_war_known, evidence)
  select r.transaction_id, o.franchise_key, cp.franchise_key, r.war_system::text, r.players_sent, cardinality(r.received_player_ids),
         case when coalesce(w.ok, true) then r.return_war_known end,
         case when not coalesce(w.ok, true) and r.return_war_known is not null then 'WITHHELD_PERMISSION'
              when r.return_war_known is null then 'NOT_OBSERVED'
              when r.return_coverage = 'COMPLETE' then 'OBSERVED_COMPLETE' else 'OBSERVED_PARTIAL' end
  from analytics.trade_returns r
  join public.rm_transactions t on t.transaction_id = r.transaction_id
  join public.organizations o on o.id = r.organization_id
  join public.organizations cp on cp.id = r.counterparty_id
  left join _war_ok w on w.provider = r.war_system::text;

  insert into public.rm_transaction_sources (transaction_id, position, title, publisher, url, attribution_category, role, independence_group, locator)
  select x.transaction_id, (row_number() over (partition by x.transaction_id order by x.ord, x.title))::integer, x.title, x.publisher, x.url, x.category, x.role, x.grp, x.locator
  from (
    select t.id as transaction_id, 0 as ord, s.title, s.publisher, s.url, _src.category, 'RECORD' as role, null::text as grp, null::text as locator
    from public.transactions t join _tx on _tx.id = t.id join public.sources s on s.id = t.source_id join _src on _src.id = s.id
    union all
    select ts.transaction_id, 1, s.title, s.publisher, s.url, _src.category, ts.role, ts.independence_group, ts.locator
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

-- ---------------------------------------------------------------------------------------------------------------
-- Boundary: rm_* are public facts; the refresh and the bookkeeping are not
-- ---------------------------------------------------------------------------------------------------------------

select public.apply_public_boundary();
revoke all on all tables in schema analytics from public, anon, authenticated, service_role;
revoke execute on all functions in schema public from public, anon, authenticated;
