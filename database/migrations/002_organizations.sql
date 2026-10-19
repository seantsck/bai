-- 002_organizations
-- Stable franchise identities for the 30 current MLB organizations, with name history and aliases.
--
-- franchise_key is BAI's frozen internal code. It never changes when a club renames or relocates; display names live in
-- organization_names with season ranges. slug is the current URL slug and may change; joins use id / franchise_key.

create type public.league_code as enum ('AL', 'NL');

create table public.organizations (
  id bigint generated always as identity primary key,
  franchise_key text not null unique check (franchise_key ~ '^[A-Z]{2,4}$'),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  current_name text not null,
  current_abbreviation text not null,
  league public.league_code not null,
  division text not null check (division in ('East', 'Central', 'West')),
  mlb_team_id integer unique,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger organizations_updated_at before update on public.organizations for each row execute function public.set_updated_at();

-- Name history by season. first_season null = "in use before BAI's recorded history"; last_season null = current.
create table public.organization_names (
  id bigint generated always as identity primary key,
  organization_id bigint not null references public.organizations (id) on delete cascade,
  name text not null,
  first_season integer check (first_season between 1871 and 2100),
  last_season integer check (last_season between 1871 and 2100),
  effective_date date,
  source_id bigint not null references public.sources (id),
  seasons int4range generated always as (int4range(first_season, last_season, '[]')) stored,
  check (first_season is null or last_season is null or first_season <= last_season),
  -- One name per franchise per season.
  exclude using gist (organization_id with =, seasons with &&)
);

create table public.organization_aliases (
  id bigint generated always as identity primary key,
  organization_id bigint not null references public.organizations (id) on delete cascade,
  alias text not null,
  alias_normalized text generated always as (public.normalize_name(alias)) stored,
  alias_kind text not null check (alias_kind in ('ABBREVIATION', 'HISTORICAL_NAME', 'SHORT_NAME', 'OTHER')),
  unique (organization_id, alias_normalized)
);
create index organization_aliases_normalized_idx on public.organization_aliases (alias_normalized);

-- The franchise's name during a given season (null when that season predates recorded history).
create function public.organization_name_in_season(p_organization_id bigint, p_season integer) returns text
language sql stable
set search_path = pg_catalog, public
as $$
  select name from public.organization_names where organization_id = p_organization_id and seasons @> p_season
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Seed: 30 current franchises (reference data, converges on re-run)
-- ---------------------------------------------------------------------------------------------------------------

insert into public.sources (source_key, source_type, title, publisher, url, notes)
values ('bai-reference:mlb-franchises', 'BAI_REFERENCE', 'MLB franchise identities and club name history', 'MLB',
        'https://www.mlb.com/team', 'Public club identities (MLBAM team ids, league, division) and renames that touch the 2015-2026 window.')
on conflict (source_key) do nothing;

insert into public.organizations (franchise_key, slug, current_name, current_abbreviation, league, division, mlb_team_id)
values
  ('BAL', 'baltimore-orioles',     'Baltimore Orioles',     'BAL', 'AL', 'East',    110),
  ('BOS', 'boston-red-sox',        'Boston Red Sox',        'BOS', 'AL', 'East',    111),
  ('NYY', 'new-york-yankees',      'New York Yankees',      'NYY', 'AL', 'East',    147),
  ('TB',  'tampa-bay-rays',        'Tampa Bay Rays',        'TB',  'AL', 'East',    139),
  ('TOR', 'toronto-blue-jays',     'Toronto Blue Jays',     'TOR', 'AL', 'East',    141),
  ('CWS', 'chicago-white-sox',     'Chicago White Sox',     'CWS', 'AL', 'Central', 145),
  ('CLE', 'cleveland-guardians',   'Cleveland Guardians',   'CLE', 'AL', 'Central', 114),
  ('DET', 'detroit-tigers',        'Detroit Tigers',        'DET', 'AL', 'Central', 116),
  ('KC',  'kansas-city-royals',    'Kansas City Royals',    'KC',  'AL', 'Central', 118),
  ('MIN', 'minnesota-twins',       'Minnesota Twins',       'MIN', 'AL', 'Central', 142),
  ('ATH', 'athletics',             'Athletics',             'ATH', 'AL', 'West',    133),
  ('HOU', 'houston-astros',        'Houston Astros',        'HOU', 'AL', 'West',    117),
  ('LAA', 'los-angeles-angels',    'Los Angeles Angels',    'LAA', 'AL', 'West',    108),
  ('SEA', 'seattle-mariners',      'Seattle Mariners',      'SEA', 'AL', 'West',    136),
  ('TEX', 'texas-rangers',         'Texas Rangers',         'TEX', 'AL', 'West',    140),
  ('ATL', 'atlanta-braves',        'Atlanta Braves',        'ATL', 'NL', 'East',    144),
  ('MIA', 'miami-marlins',         'Miami Marlins',         'MIA', 'NL', 'East',    146),
  ('NYM', 'new-york-mets',         'New York Mets',         'NYM', 'NL', 'East',    121),
  ('PHI', 'philadelphia-phillies', 'Philadelphia Phillies', 'PHI', 'NL', 'East',    143),
  ('WSH', 'washington-nationals',  'Washington Nationals',  'WSH', 'NL', 'East',    120),
  ('CHC', 'chicago-cubs',          'Chicago Cubs',          'CHC', 'NL', 'Central', 112),
  ('CIN', 'cincinnati-reds',       'Cincinnati Reds',       'CIN', 'NL', 'Central', 113),
  ('MIL', 'milwaukee-brewers',     'Milwaukee Brewers',     'MIL', 'NL', 'Central', 158),
  ('PIT', 'pittsburgh-pirates',    'Pittsburgh Pirates',    'PIT', 'NL', 'Central', 134),
  ('STL', 'st-louis-cardinals',    'St. Louis Cardinals',   'STL', 'NL', 'Central', 138),
  ('ARI', 'arizona-diamondbacks',  'Arizona Diamondbacks',  'ARI', 'NL', 'West',    109),
  ('COL', 'colorado-rockies',      'Colorado Rockies',      'COL', 'NL', 'West',    115),
  ('LAD', 'los-angeles-dodgers',   'Los Angeles Dodgers',   'LAD', 'NL', 'West',    119),
  ('SD',  'san-diego-padres',      'San Diego Padres',      'SD',  'NL', 'West',    135),
  ('SF',  'san-francisco-giants',  'San Francisco Giants',  'SF',  'NL', 'West',    137)
on conflict (franchise_key) do nothing;

-- Name history. Only renames touching the research window are recorded; earlier history is added with its own sources later.
with seed (franchise_key, name, first_season, last_season) as (values
  ('CLE', 'Cleveland Indians', null::int, 2021),
  ('CLE', 'Cleveland Guardians', 2022, null::int),
  ('ATH', 'Oakland Athletics', null, 2024),
  ('ATH', 'Athletics', 2025, null),
  ('LAA', 'Los Angeles Angels of Anaheim', null, 2015),
  ('LAA', 'Los Angeles Angels', 2016, null)
)
insert into public.organization_names (organization_id, name, first_season, last_season, source_id)
select o.id, s.name, s.first_season, s.last_season, (select id from public.sources where source_key = 'bai-reference:mlb-franchises')
from seed s join public.organizations o using (franchise_key)
where not exists (select 1 from public.organization_names n where n.organization_id = o.id and n.name = s.name);

-- Franchises without a recorded rename carry their current name across the whole recorded history.
insert into public.organization_names (organization_id, name, first_season, last_season, source_id)
select o.id, o.current_name, null, null, (select id from public.sources where source_key = 'bai-reference:mlb-franchises')
from public.organizations o
where not exists (select 1 from public.organization_names n where n.organization_id = o.id);

insert into public.organization_aliases (organization_id, alias, alias_kind)
select id, current_abbreviation, 'ABBREVIATION' from public.organizations
union all
select o.id, a.alias, a.kind from public.organizations o
join (values ('ATH', 'OAK', 'ABBREVIATION'), ('ATH', 'A''s', 'SHORT_NAME'), ('LAA', 'ANA', 'ABBREVIATION'),
             ('CWS', 'CHW', 'ABBREVIATION'), ('KC', 'KCR', 'ABBREVIATION'), ('TB', 'TBR', 'ABBREVIATION'),
             ('SD', 'SDP', 'ABBREVIATION'), ('SF', 'SFG', 'ABBREVIATION'), ('WSH', 'WSN', 'ABBREVIATION')) as a (franchise_key, alias, kind)
  on a.franchise_key = o.franchise_key
union all
select n.organization_id, n.name, 'HISTORICAL_NAME' from public.organization_names n
join public.organizations o on o.id = n.organization_id where n.name <> o.current_name
on conflict (organization_id, alias_normalized) do nothing;
