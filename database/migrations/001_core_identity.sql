-- 001_core_identity
-- Extensions, platform roles, shared helpers, the sources registry and canonical player identity.
--
-- Rules encoded here:
--   * Every player has a stable internal id (bigint) and a stable public key (uuid). Names are never unique and never the
--     preferred join; external ids are unique per id system and resolve to exactly one player.
--   * Sources are public by construction (public data only).

create extension if not exists btree_gist;

-- Supabase provides these roles; local PostgreSQL 17 replays create NOLOGIN placeholders so grants and RLS behave the same.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;

-- Nothing in public is readable by default; 011_public_foundation grants the public read surface explicitly.
revoke all on schema public from public;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public revoke all on tables from public;
alter default privileges in schema public revoke execute on functions from public;

create schema if not exists analytics;
revoke all on schema analytics from public;

-- ---------------------------------------------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------------------------------------------

-- ASCII fold + lowercase + punctuation strip + whitespace collapse. Used for alias matching, never as an identity key.
create function public.normalize_name(value text) returns text
language sql immutable parallel safe
set search_path = pg_catalog
as $$
  select nullif(btrim(regexp_replace(regexp_replace(lower(translate(value,
    'ÁÀÂÄÃÅĀĂĄÉÈÊËĒĖĘĚÍÌÎÏĪĮÓÒÔÖÕØŌŐÚÙÛÜŪŮŰÑŃÇĆČÝŸŠŽŁĐáàâäãåāăąéèêëēėęěíìîïīįóòôöõøōőúùûüūůűñńçćčýÿšžłđ',
    'AAAAAAAAAEEEEEEEEIIIIIIOOOOOOOOUUUUUUUNNCCCYYSZLDaaaaaaaaaeeeeeeeeiiiiiioooooooouuuuuuunncccyyszld')),
    '[^a-z0-9 ]+', ' ', 'g'), '\s+', ' ', 'g')), '')
$$;

create function public.set_updated_at() returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- Precision of a recorded date. A season-precision date must never be read as an exact day.
create type public.date_precision as enum ('DAY', 'MONTH', 'SEASON', 'YEAR', 'UNKNOWN');

-- ---------------------------------------------------------------------------------------------------------------
-- Sources (the registry every researched fact cites; observations live in 003)
-- ---------------------------------------------------------------------------------------------------------------

create type public.source_type as enum (
  'OFFICIAL_LEAGUE',       -- MLB / MLBAM releases, official draft tracker, transaction wire
  'OFFICIAL_TEAM',         -- club press releases
  'REFERENCE_DATABASE',    -- Baseball-Reference, FanGraphs, etc.
  'NEWS_REPORT',
  'PUBLICATION_RANKING',   -- published prospect lists / boards
  'PUBLIC_RECORD',
  'SOCIAL_MEDIA',
  'BAI_REFERENCE',         -- BAI-maintained reference data (franchise identities, calendars) citing public facts
  'TEST_FIXTURE',          -- test-only; never present in a research database
  'OTHER'
);

create table public.sources (
  id bigint generated always as identity primary key,
  source_key text not null unique check (source_key ~ '^[a-z0-9][a-z0-9_.:-]*$'),
  source_type public.source_type not null,
  title text not null check (btrim(title) <> ''),
  publisher text,
  url text check (url is null or url ~ '^https?://'),
  published_date date,
  accessed_date date,
  -- Public data only: a non-public source cannot be registered.
  publicly_accessible boolean not null default true check (publicly_accessible),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger sources_updated_at before update on public.sources for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------------------------------------------
-- Players
-- ---------------------------------------------------------------------------------------------------------------

create table public.players (
  id bigint generated always as identity primary key,
  player_key uuid not null default gen_random_uuid() unique,
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  full_name text not null check (btrim(full_name) <> ''),
  display_name text not null check (btrim(display_name) <> ''),
  name_normalized text generated always as (public.normalize_name(full_name)) stored,
  birth_date date,
  birth_date_precision public.date_precision,
  birth_city text,
  birth_country text,
  bats text check (bats in ('L', 'R', 'S')),
  throws text check (throws in ('L', 'R', 'S')),
  primary_position text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((birth_date is null) = (birth_date_precision is null))
);
-- Deliberately NOT unique: two different players may share a name.
create index players_name_normalized_idx on public.players (name_normalized);
create trigger players_updated_at before update on public.players for each row execute function public.set_updated_at();

create type public.alias_type as enum ('LEGAL_NAME', 'BIRTH_NAME', 'ROMANIZATION', 'NICKNAME', 'NAME_ORDER_VARIANT', 'MISSPELLING', 'OTHER');

create table public.player_aliases (
  id bigint generated always as identity primary key,
  player_id bigint not null references public.players (id) on delete cascade,
  alias text not null check (btrim(alias) <> ''),
  alias_normalized text generated always as (public.normalize_name(alias)) stored,
  alias_type public.alias_type not null,
  source_id bigint references public.sources (id),
  created_at timestamptz not null default now(),
  unique (player_id, alias_normalized)
);
create index player_aliases_normalized_idx on public.player_aliases (alias_normalized);

create type public.id_system as enum ('MLBAM', 'BBREF', 'BBREF_MINORS', 'FANGRAPHS', 'BASEBALL_PROSPECTUS', 'RETROSHEET', 'NPB', 'KBO', 'CPBL', 'OTHER');

create table public.player_external_ids (
  id bigint generated always as identity primary key,
  player_id bigint not null references public.players (id) on delete cascade,
  id_system public.id_system not null,
  external_id text not null check (btrim(external_id) <> ''),
  source_id bigint references public.sources (id),
  created_at timestamptz not null default now(),
  -- An external id identifies exactly one player, and a player has at most one id per system.
  unique (id_system, external_id),
  unique (player_id, id_system)
);

-- Preferred join path for ingestion: external id -> player id. Returns null when unresolved (never guesses by name).
create function public.resolve_player(p_system public.id_system, p_external_id text) returns bigint
language sql stable
set search_path = pg_catalog, public
as $$
  select player_id from public.player_external_ids where id_system = p_system and external_id = p_external_id
$$;

-- Candidate lookup by name/alias for researchers. Returns every match; callers must disambiguate.
create function public.player_name_candidates(p_name text) returns table (player_id bigint, matched_on text)
language sql stable
set search_path = pg_catalog, public
as $$
  select p.id, 'full_name' from public.players p where p.name_normalized = public.normalize_name(p_name)
  union
  select a.player_id, 'alias:' || a.alias_type from public.player_aliases a where a.alias_normalized = public.normalize_name(p_name)
$$;
