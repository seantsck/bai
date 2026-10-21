-- 024_historical_drafts
-- Historical MLB amateur drafts, 1965 onward: every phase, every franchise in the season it existed, names and leagues
-- by season, and indexes for the public historical explorer. Additive: no existing row changes meaning.
--
--   * Draft phases. MLB held up to six amateur phases a year: June regular (from 1965), January regular and secondary
--     (1966-1986), June secondary (1966-1986), a delayed June secondary phase and an August American Legion phase (late
--     1960s). Each phase is its own `drafts` row (draft_kind), so a player picked in two phases of one year has two
--     acquisitions, and pick numbering never collides across phases.
--   * Dates. Some phases are known only to the month. start_date_precision says so; the date is then the first of that
--     month and is never presented as a day.
--   * Franchises. All draft-era clubs are ancestors of today's 30 (no franchise has folded since 1965). first_season is
--     the franchise's first MLB season; a selection by a club before it existed is refused. Names and league/division by
--     season let a source's wording ("Montreal Expos", 1985) resolve to the franchise (WSH) and let pages show the name
--     in use that year.
--   * Coverage. A draft x organization cell exists only for clubs that existed in that draft's year, for every phase.
--
-- Reference data: league history from MLB's records (league and division alignment by season); names and first seasons
-- from MLB club histories. Corrections arrive as new migrations with their own source, never by editing this one.

-- ---------------------------------------------------------------------------------------------------------------
-- Draft phases and date precision
-- ---------------------------------------------------------------------------------------------------------------

alter type public.draft_kind add value if not exists 'JUNE_SECONDARY_DELAYED';
alter type public.draft_kind add value if not exists 'AUGUST_LEGION';

alter table public.drafts
  add column start_date_precision public.date_precision not null default 'DAY'
    check (start_date_precision in ('DAY', 'MONTH')),
  add column mlb_draft_type text check (mlb_draft_type ~ '^[A-Z]{2}$');      -- MLB Stats API draftType code (JR, NR, NS, JS, JD, AL)
comment on column public.drafts.start_date_precision is 'MONTH: only the month is established; start_date is the first of it and must not be shown as a day.';
alter table public.drafts add constraint drafts_month_precision_first_day check (start_date_precision <> 'MONTH' or extract(day from start_date) = 1);

-- ---------------------------------------------------------------------------------------------------------------
-- Franchises across seasons
-- ---------------------------------------------------------------------------------------------------------------

insert into public.sources (source_key, source_type, title, publisher, url, notes)
values ('bai-reference:mlb-franchise-history', 'BAI_REFERENCE', 'MLB franchise history: first seasons, names and league alignment since 1965', 'MLB',
        'https://www.mlb.com/history', 'Reference data for the draft era: each franchise''s first MLB season, the names it used since 1965 (and the name in force in 1965), and its league and division by season. Researched 2026-10-21.')
on conflict (source_key) do nothing;

alter table public.organizations add column first_season integer check (first_season between 1871 and 2100);
comment on column public.organizations.first_season is 'First MLB season of the franchise under any name; a draft selection before it is refused.';

update public.organizations o set first_season = v.first_season
from (values ('BAL', 1901), ('BOS', 1901), ('NYY', 1901), ('TB', 1998), ('TOR', 1977), ('CWS', 1901), ('CLE', 1901), ('DET', 1901),
             ('KC', 1969), ('MIN', 1901), ('ATH', 1901), ('HOU', 1962), ('LAA', 1961), ('SEA', 1977), ('TEX', 1961), ('ATL', 1876),
             ('MIA', 1993), ('NYM', 1962), ('PHI', 1883), ('WSH', 1969), ('CHC', 1876), ('CIN', 1882), ('MIL', 1969), ('PIT', 1882),
             ('STL', 1882), ('ARI', 1998), ('COL', 1993), ('LAD', 1884), ('SD', 1969), ('SF', 1883)) as v (franchise_key, first_season)
where o.franchise_key = v.franchise_key and o.first_season is null;

-- Name history. Existing open-ended rows get the season their name began; earlier names of the draft era are added.
update public.organization_names n set first_season = v.first_season
from public.organizations o, (values ('ATL', 'Atlanta Braves', 1966), ('ATH', 'Oakland Athletics', 1968), ('HOU', 'Houston Astros', 1965),
             ('LAA', 'Los Angeles Angels of Anaheim', 2005), ('TEX', 'Texas Rangers', 1972), ('MIN', 'Minnesota Twins', 1961),
             ('MIL', 'Milwaukee Brewers', 1970), ('WSH', 'Washington Nationals', 2005), ('MIA', 'Miami Marlins', 2012),
             ('TB', 'Tampa Bay Rays', 2008), ('CLE', 'Cleveland Indians', 1915), ('KC', 'Kansas City Royals', 1969),
             ('SD', 'San Diego Padres', 1969), ('SEA', 'Seattle Mariners', 1977), ('TOR', 'Toronto Blue Jays', 1977),
             ('NYM', 'New York Mets', 1962), ('COL', 'Colorado Rockies', 1993), ('ARI', 'Arizona Diamondbacks', 1998),
             ('BAL', 'Baltimore Orioles', 1954), ('LAD', 'Los Angeles Dodgers', 1958), ('SF', 'San Francisco Giants', 1958))
       as v (franchise_key, name, first_season)
where o.franchise_key = v.franchise_key and n.organization_id = o.id and n.name = v.name and n.first_season is null;

-- 019 recorded three former names with open first seasons (MLB team history); date them rather than add duplicates.
update public.organization_names n set first_season = v.first_season
from public.organizations o, (values ('MIA', 'Florida Marlins', 1993, 2011), ('TB', 'Tampa Bay Devil Rays', 1998, 2007), ('WSH', 'Montreal Expos', 1969, 2004))
       as v (franchise_key, name, first_season, last_season)
where o.franchise_key = v.franchise_key and n.organization_id = o.id and n.name = v.name and n.first_season is null and n.last_season = v.last_season;

with seed (franchise_key, name, first_season, last_season) as (values
  ('ATL', 'Milwaukee Braves', 1953, 1965),
  ('ATH', 'Kansas City Athletics', 1955, 1967),
  ('HOU', 'Houston Colt .45s', 1962, 1964),
  ('LAA', 'Los Angeles Angels', 1961, 1965),
  ('LAA', 'California Angels', 1966, 1996),
  ('LAA', 'Anaheim Angels', 1997, 2004),
  ('TEX', 'Washington Senators', 1961, 1971),
  ('MIN', 'Washington Senators', 1901, 1960),
  ('MIL', 'Seattle Pilots', 1969, 1969),
  ('WSH', 'Montreal Expos', 1969, 2004),
  ('MIA', 'Florida Marlins', 1993, 2011),
  ('TB', 'Tampa Bay Devil Rays', 1998, 2007)
)
insert into public.organization_names (organization_id, name, first_season, last_season, source_id)
select o.id, s.name, s.first_season, s.last_season, (select id from public.sources where source_key = 'bai-reference:mlb-franchise-history')
from seed s join public.organizations o using (franchise_key)
where not exists (select 1 from public.organization_names n where n.organization_id = o.id and n.name = s.name and n.seasons && int4range(s.first_season, s.last_season, '[]'));

insert into public.organization_aliases (organization_id, alias, alias_kind)
select o.id, a.alias, a.kind from public.organizations o
join (values ('ATL', 'Milwaukee Braves', 'HISTORICAL_NAME'), ('ATH', 'Kansas City Athletics', 'HISTORICAL_NAME'), ('ATH', 'KCA', 'ABBREVIATION'),
             ('HOU', 'Houston Colt .45s', 'HISTORICAL_NAME'), ('LAA', 'California Angels', 'HISTORICAL_NAME'), ('LAA', 'CAL', 'ABBREVIATION'),
             ('LAA', 'Anaheim Angels', 'HISTORICAL_NAME'), ('TEX', 'Washington Senators', 'HISTORICAL_NAME'), ('MIN', 'Washington Senators', 'HISTORICAL_NAME'),
             ('MIL', 'Seattle Pilots', 'HISTORICAL_NAME'), ('MIL', 'SEP', 'ABBREVIATION'), ('TB', 'TBD', 'ABBREVIATION')) as a (franchise_key, alias, kind)
  on a.franchise_key = o.franchise_key
on conflict (organization_id, alias_normalized) do nothing;

-- League and division by season, from 1965 (the draft era). division null = the league had no divisions (before 1969).
create table public.organization_league_seasons (
  id bigint generated always as identity primary key,
  organization_id bigint not null references public.organizations (id),
  league public.league_code not null,
  division text check (division in ('East', 'Central', 'West')),
  first_season integer not null check (first_season between 1871 and 2100),
  last_season integer check (last_season between 1871 and 2100),            -- null = current
  source_id bigint not null references public.sources (id),
  seasons int4range generated always as (int4range(first_season, last_season, '[]')) stored,
  check (last_season is null or first_season <= last_season),
  exclude using gist (organization_id with =, seasons with &&)
);

with seed (franchise_key, league, division, first_season, last_season) as (values
  ('BAL', 'AL', null, 1965, 1968), ('BAL', 'AL', 'East', 1969, null),
  ('BOS', 'AL', null, 1965, 1968), ('BOS', 'AL', 'East', 1969, null),
  ('NYY', 'AL', null, 1965, 1968), ('NYY', 'AL', 'East', 1969, null),
  ('TOR', 'AL', 'East', 1977, null),
  ('TB',  'AL', 'East', 1998, null),
  ('CWS', 'AL', null, 1965, 1968), ('CWS', 'AL', 'West', 1969, 1993), ('CWS', 'AL', 'Central', 1994, null),
  ('CLE', 'AL', null, 1965, 1968), ('CLE', 'AL', 'East', 1969, 1993), ('CLE', 'AL', 'Central', 1994, null),
  ('DET', 'AL', null, 1965, 1968), ('DET', 'AL', 'East', 1969, 1997), ('DET', 'AL', 'Central', 1998, null),
  ('KC',  'AL', 'West', 1969, 1993), ('KC', 'AL', 'Central', 1994, null),
  ('MIN', 'AL', null, 1965, 1968), ('MIN', 'AL', 'West', 1969, 1993), ('MIN', 'AL', 'Central', 1994, null),
  ('ATH', 'AL', null, 1965, 1968), ('ATH', 'AL', 'West', 1969, null),
  ('LAA', 'AL', null, 1965, 1968), ('LAA', 'AL', 'West', 1969, null),
  ('SEA', 'AL', 'West', 1977, null),
  ('TEX', 'AL', null, 1965, 1968), ('TEX', 'AL', 'East', 1969, 1971), ('TEX', 'AL', 'West', 1972, null),
  ('HOU', 'NL', null, 1965, 1968), ('HOU', 'NL', 'West', 1969, 1993), ('HOU', 'NL', 'Central', 1994, 2012), ('HOU', 'AL', 'West', 2013, null),
  ('MIL', 'AL', 'West', 1969, 1971), ('MIL', 'AL', 'East', 1972, 1993), ('MIL', 'AL', 'Central', 1994, 1997), ('MIL', 'NL', 'Central', 1998, null),
  ('ATL', 'NL', null, 1965, 1968), ('ATL', 'NL', 'West', 1969, 1993), ('ATL', 'NL', 'East', 1994, null),
  ('MIA', 'NL', 'East', 1993, null),
  ('NYM', 'NL', null, 1965, 1968), ('NYM', 'NL', 'East', 1969, null),
  ('PHI', 'NL', null, 1965, 1968), ('PHI', 'NL', 'East', 1969, null),
  ('WSH', 'NL', 'East', 1969, null),
  ('CHC', 'NL', null, 1965, 1968), ('CHC', 'NL', 'East', 1969, 1993), ('CHC', 'NL', 'Central', 1994, null),
  ('CIN', 'NL', null, 1965, 1968), ('CIN', 'NL', 'West', 1969, 1993), ('CIN', 'NL', 'Central', 1994, null),
  ('PIT', 'NL', null, 1965, 1968), ('PIT', 'NL', 'East', 1969, 1993), ('PIT', 'NL', 'Central', 1994, null),
  ('STL', 'NL', null, 1965, 1968), ('STL', 'NL', 'East', 1969, 1993), ('STL', 'NL', 'Central', 1994, null),
  ('ARI', 'NL', 'West', 1998, null),
  ('COL', 'NL', 'West', 1993, null),
  ('LAD', 'NL', null, 1965, 1968), ('LAD', 'NL', 'West', 1969, null),
  ('SD',  'NL', 'West', 1969, null),
  ('SF',  'NL', null, 1965, 1968), ('SF', 'NL', 'West', 1969, null)
)
insert into public.organization_league_seasons (organization_id, league, division, first_season, last_season, source_id)
select o.id, s.league::public.league_code, s.division, s.first_season, s.last_season, (select id from public.sources where source_key = 'bai-reference:mlb-franchise-history')
from seed s join public.organizations o using (franchise_key)
where not exists (select 1 from public.organization_league_seasons x where x.organization_id = o.id and x.first_season = s.first_season);

-- The current alignment must agree with organizations.league / division (a seed typo fails the migration).
do $$
begin
  if exists (select 1 from public.organizations o
             where o.active and not exists (select 1 from public.organization_league_seasons x
                                            where x.organization_id = o.id and x.last_season is null and x.league = o.league and x.division = o.division)) then
    raise exception '024: league history disagrees with the current alignment';
  end if;
  if exists (select 1 from public.organizations o join public.organization_league_seasons x on x.organization_id = o.id where x.first_season < greatest(o.first_season, 1965)) then
    raise exception '024: league history starts before a franchise existed';
  end if;
end $$;

create function public.organization_exists_in_season(p_organization_id bigint, p_season integer) returns boolean
language sql stable
set search_path = pg_catalog, public
as $$
  select coalesce(first_season, 0) <= p_season from public.organizations where id = p_organization_id
$$;

-- A selection belongs to a club that existed in the draft's year.
create function public.draft_selection_organization_guard() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_year integer;
begin
  select draft_year into v_year from public.drafts where id = new.draft_id;
  if not public.organization_exists_in_season(new.organization_id, v_year) then
    raise exception 'organization % did not exist in % (first season %)', new.organization_id, v_year,
      (select first_season from public.organizations where id = new.organization_id) using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger draft_selections_organization_guard before insert or update of organization_id, draft_id on public.draft_selections
  for each row execute function public.draft_selection_organization_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- Historical explorer: one row per selection with the club's name and league in that year
-- ---------------------------------------------------------------------------------------------------------------

create index players_name_prefix_idx on public.players (name_normalized text_pattern_ops);
create index schools_name_prefix_idx on public.schools (name_normalized text_pattern_ops);
create index draft_selections_school_idx on public.draft_selections (school_id);
create index draft_selections_draft_round_idx on public.draft_selections (draft_id, overall_pick);
create index drafts_year_idx on public.drafts (draft_year, draft_kind);

create view public.v_draft_explorer with (security_invoker = true) as
select s.id as selection_id, d.draft_key, d.draft_year, d.draft_kind, r.round_code, r.round_order, r.phase, s.overall_pick, s.round_pick,
       s.selection_type, o.franchise_key, o.slug as organization_slug,
       coalesce(n.name, o.current_name) as organization_name_then,
       ls.league as league_then, ls.division as division_then,
       p.slug as player_slug, p.display_name, p.name_normalized, s.position, sc.name as school_name, sc.name_normalized as school_normalized,
       coalesce(s.school_type_at_selection, sc.school_type) as school_type,
       coalesce(g.signing_status::text, 'UNKNOWN') as signing_status, g.signing_bonus_usd
from public.draft_selections s
join public.drafts d on d.id = s.draft_id
join public.draft_rounds r on r.id = s.round_id
join public.organizations o on o.id = s.organization_id
join public.players p on p.id = s.player_id
left join public.schools sc on sc.id = s.school_id
left join public.draft_signings g on g.draft_selection_id = s.id
left join public.organization_names n on n.organization_id = o.id and n.seasons @> d.draft_year
left join public.organization_league_seasons ls on ls.organization_id = o.id and ls.seasons @> d.draft_year;

-- Public views call no functions: anon has EXECUTE on none (apply_public_boundary), so the season rules are inlined.
-- Year-level coverage for the explorer: counts only (no rates). expected_selections is the sum of sourced census claims and
-- is null unless every club that existed that year has one, so a partial year never looks complete.
create view public.v_draft_year_coverage with (security_invoker = true) as
select d.draft_key, d.draft_year, d.draft_kind, d.start_date, d.start_date_precision,
       (select count(*) from public.organizations o where o.active and coalesce(o.first_season, 0) <= d.draft_year)::int as clubs,
       count(distinct a.organization_id) filter (where a.coverage_state = 'COMPLETE_CENSUS')::int as clubs_with_census,
       case when count(distinct a.organization_id) filter (where a.coverage_state = 'COMPLETE_CENSUS')
                 = (select count(*) from public.organizations o where o.active and coalesce(o.first_season, 0) <= d.draft_year)
            then sum(a.expected_count) filter (where a.coverage_state = 'COMPLETE_CENSUS') end::int as expected_selections,
       (select count(*) from public.draft_selections s where s.draft_id = d.id)::int as imported_selections,
       (select count(*) from public.draft_selections s where s.draft_id = d.id
          and exists (select 1 from public.player_external_ids x where x.player_id = s.player_id and x.id_system = 'MLBAM'))::int as identities_resolved,
       (select count(*) from public.draft_selections s join public.draft_signings g on g.draft_selection_id = s.id where s.draft_id = d.id)::int as signing_known,
       (select count(*) from public.draft_selections s join public.draft_signings g on g.draft_selection_id = s.id
          where s.draft_id = d.id and g.signing_bonus_usd is not null)::int as bonus_known,
       (select count(*) from public.draft_selections s join public.v_player_outcome_status ps on ps.player_id = s.player_id
          where s.draft_id = d.id and ps.audit_state <> 'NOT_AUDITED')::int as outcomes_audited
from public.drafts d
left join public.coverage_assessments a on a.domain = 'DRAFT' and a.scope_key = d.draft_key and a.organization_id is not null
group by d.id;

-- ---------------------------------------------------------------------------------------------------------------
-- Coverage cells: every draft phase, only clubs that existed that year
-- ---------------------------------------------------------------------------------------------------------------

create or replace view analytics.research_coverage_cells with (security_invoker = true) as
with draft_cells as (
  select 'DRAFT'::public.coverage_domain as domain, d.draft_key as scope_key, d.draft_year::text as scope_label, d.start_date as scope_start,
         o.id as organization_id,
         count(s.id)::int as tracked_records,
         count(distinct s.player_id) filter (where ps.audit_state <> 'NOT_AUDITED')::int as audited_outcomes,
         count(s.id) filter (where ds.signing_status = 'SIGNED')::int as cost_basis_records,
         count(s.id) filter (where ds.signing_status = 'SIGNED' and ds.signing_bonus_usd is not null)::int as cost_known_records,
         max(s.updated_at)::date as last_record_date
  from public.drafts d cross join public.organizations o
  left join public.draft_selections s on s.draft_id = d.id and s.organization_id = o.id
  left join public.draft_signings ds on ds.draft_selection_id = s.id
  left join public.v_player_outcome_status ps on ps.player_id = s.player_id
  where o.active and public.organization_exists_in_season(o.id, d.draft_year)
  group by d.id, o.id
), intl_cells as (
  select 'INTERNATIONAL'::public.coverage_domain, ip.period_key, ip.label, ip.start_date, o.id,
         count(s.id)::int,
         count(distinct s.player_id) filter (where ps.audit_state <> 'NOT_AUDITED')::int,
         count(s.id)::int,
         count(s.id) filter (where s.signing_bonus_usd is not null)::int,
         max(s.updated_at)::date
  from public.international_signing_periods ip cross join public.organizations o
  left join public.international_signings s on s.signing_period_id = ip.id and s.organization_id = o.id
  left join public.v_player_outcome_status ps on ps.player_id = s.player_id
  where o.active
  group by ip.id, o.id
), cells as (select * from draft_cells union all select * from intl_cells)
select c.*, a.coverage_state, a.expected_count, coalesce(public.coverage_supports_population_rate(a.coverage_state), false) as supports_population_rate,
       greatest(c.last_record_date, a.assessed_on) as last_research_date
from cells c
left join public.coverage_assessments a on a.domain = c.domain and a.scope_key = c.scope_key and a.organization_id = c.organization_id;

-- The public draft-years page reads a refreshed copy: the view aggregates per request (about 0.8 s at 85,000 selections)
-- and stays internal, so neither the site nor the Data API can run it on demand.
create table public.rm_draft_year_coverage (
  draft_key text primary key,
  draft_year integer not null,
  draft_kind public.draft_kind not null,
  start_date date not null,
  start_date_precision public.date_precision not null,
  clubs integer not null,
  clubs_with_census integer not null,
  expected_selections integer,
  imported_selections integer not null,
  identities_resolved integer not null,
  signing_known integer not null,
  bonus_known integer not null,
  outcomes_audited integer not null,
  generation_id bigint not null,
  refreshed_at timestamptz not null,
  check (expected_selections is null or clubs_with_census = clubs)
);
insert into public.internal_objects values ('v_draft_year_coverage', 'per-request aggregate; the public copy is rm_draft_year_coverage')
on conflict (object_name) do nothing;

-- refresh_read_models: the expected cell count follows the same rule (clubs that existed, every phase), and the draft
-- year coverage copy is rebuilt in the same generation.
do $$
declare
  v_def text := pg_get_functiondef('public.refresh_read_models()'::regprocedure);
  v_old text := $old$v_expected_cells := ((select count(*) from public.drafts where draft_kind = 'JUNE_AMATEUR') + (select count(*) from public.international_signing_periods))
                      * (select count(*) from public.organizations where active);$old$;
  v_new text := $new$v_expected_cells := (select count(*) from public.drafts d cross join public.organizations o
                                           where o.active and public.organization_exists_in_season(o.id, d.draft_year))
                      + (select count(*) from public.international_signing_periods) * (select count(*) from public.organizations where active);$new$;
  v_anchor text := 'delete from public.rm_research_queue_summary;';
  v_years text := $years$delete from public.rm_draft_year_coverage;
  insert into public.rm_draft_year_coverage
  select draft_key, draft_year, draft_kind, start_date, start_date_precision, clubs, clubs_with_census, expected_selections, imported_selections,
         identities_resolved, signing_known, bonus_known, outcomes_audited, v_generation, v_now
  from public.v_draft_year_coverage;

  $years$;
begin
  if position(v_old in v_def) = 0 or position(v_anchor in v_def) = 0 then raise exception '024: refresh_read_models() is not the 014 definition; refusing to patch it'; end if;
  execute replace(replace(v_def, v_old, v_new), v_anchor, v_years || v_anchor);
end $$;

insert into public.provenance_fact_tables (table_name, domain, description) values
  ('organization_league_seasons', 'ORGANIZATION', 'Franchise league and division by season')
on conflict (table_name) do nothing;

select public.apply_public_boundary();
