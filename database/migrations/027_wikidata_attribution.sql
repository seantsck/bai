-- 027_wikidata_attribution
-- Recognises Wikidata structured data (CC0 1.0) as its own attribution category, WIKIDATA, and makes the hosted publication
-- guard (025/026) decide by what a source REALLY is, not by what it calls itself. Additive: no rows, views, privileges,
-- grants or certification rules change, and every existing source keeps its category.
--
--   1. public.source_attribution_category(...): ONE strict, immutable rule, used for new sources, by the publication guard
--      and by the immutability trigger. Order: TEST_FIXTURE; the restricted groups first (Baseball-Reference, then MLB,
--      judged by URL, publisher, key and title and by the OFFICIAL_LEAGUE type, whatever the source calls itself); then the
--      groups that need their full identity (URL host and path, publisher, type and, where new, key):
--        WIKIDATA           https on www.wikidata.org / query.wikidata.org, publisher 'Wikimedia Foundation (Wikidata contributors)',
--                           type REFERENCE_DATABASE, key hist:wikidata-<...>
--        CHADWICK_REGISTER  https://github.com/chadwickbureau/register, publisher 'Chadwick Baseball Bureau' (or '... (GitHub)'),
--                           type REFERENCE_DATABASE
--        WIKIPEDIA          https://en.wikipedia.org/, publisher 'Wikipedia' or 'Wikimedia Foundation (contributors)',
--                           type REFERENCE_DATABASE
--        BAI_RESEARCH       type BAI_REFERENCE with a key bai-reference:<...> (and no restricted marker anywhere)
--      everything else is OTHER_PUBLICATION. A label, a title or a claimed type alone selects nothing.
--   2. public.sources.attribution_category becomes a plain column. Its existing values are KEPT exactly; new rows get the
--      strict category from a BEFORE INSERT trigger, whatever value an insert supplies.
--   3. The publication guard no longer trusts the stored category: it recomputes the strict category from the source's own
--      fields. So a legacy source whose stored category predates the strict rule (the two BAI reference compilations that
--      cite mlb.com pages) is NOT permission for new records: new records citing it are refused like any MLB record.
--      Existing records are untouched. Chadwick Register, Wikipedia, Wikidata and BAI research (as defined above) need no
--      basis; every other category still needs a recorded one.
--   4. A source's classification is fixed once it exists: updating its url, key, publisher, title or type so that the strict
--      category changes, or writing attribution_category directly, is refused.
--   5. ingest.release_audits: an append-only, private record of a manifest-bound research release.

create function public.source_attribution_category(p_url text, p_source_key text, p_publisher text, p_title text, p_source_type public.source_type)
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
    when p_source_type = 'BAI_REFERENCE' and p_source_key ~ '^bai-reference:[a-z0-9._:-]+$' then 'BAI_RESEARCH'
    else 'OTHER_PUBLICATION'
  end
$$;
comment on function public.source_attribution_category(text, text, text, text, public.source_type) is 'The strict attribution rule (027): restricted groups first; Wikidata, Chadwick, Wikipedia and BAI research only with their full identity; a label alone selects nothing. Used for new sources, by the publication guard and by the immutability trigger.';

-- Existing values are kept exactly. Compare before and after, and say how many legacy rows the strict rule would classify
-- differently (they stay as they are; the guard just does not treat them as permission for new records).
create temporary table _027_before on commit drop as select id, attribution_category from public.sources;
alter table public.sources alter column attribution_category drop expression;
do $$
declare
  changed integer;
  legacy integer;
begin
  select count(*) into changed from public.sources s join _027_before b using (id) where s.attribution_category is distinct from b.attribution_category;
  if changed > 0 or (select count(*) from public.sources) <> (select count(*) from _027_before) then
    raise exception '027: % existing source(s) changed category', changed;
  end if;
  select count(*) into legacy from public.sources s
  where s.attribution_category is distinct from public.source_attribution_category(s.url, s.source_key, s.publisher, s.title, s.source_type);
  raise notice '027: all % existing source categories kept; % legacy source(s) differ from the strict rule (not permission for new records)', (select count(*) from public.sources), legacy;
end $$;
comment on column public.sources.attribution_category is 'Public attribution group (025; strict rule in public.source_attribution_category, 027). Set once, at insert, by trigger; never changed. Says where a record came from; not a statement of redistribution rights.';

create function public.source_category_set() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  new.attribution_category := public.source_attribution_category(new.url, new.source_key, new.publisher, new.title, new.source_type);
  return new;
end $$;
create trigger sources_category_set before insert on public.sources
  for each row execute function public.source_category_set();

create function public.source_category_fixed() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.attribution_category is distinct from old.attribution_category then
    raise exception 'the attribution category of source % cannot be written (027)', old.source_key using errcode = 'insufficient_privilege';
  end if;
  if public.source_attribution_category(old.url, old.source_key, old.publisher, old.title, old.source_type)
     is distinct from public.source_attribution_category(new.url, new.source_key, new.publisher, new.title, new.source_type) then
    raise exception 'the attribution category of source % is fixed: changing its url, key, publisher, title or type so that it moves from % to % is refused (027)',
      old.source_key, public.source_attribution_category(old.url, old.source_key, old.publisher, old.title, old.source_type),
      public.source_attribution_category(new.url, new.source_key, new.publisher, new.title, new.source_type)
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;
create trigger sources_category_fixed before update of url, source_key, publisher, title, source_type, attribution_category on public.sources
  for each row execute function public.source_category_fixed();

-- The publication guard recomputes the strict category from the source itself; the stored (possibly legacy) value is not used.
create or replace function public.source_publication_guard() returns trigger
language plpgsql
set search_path = pg_catalog, public, ingest
as $$
declare
  cat text;
begin
  if not exists (select 1 from pg_roles where rolname = 'supabase_admin') then return new; end if;   -- hosted (Supabase) only
  if new.source_id is null then return new; end if;
  select public.source_attribution_category(s.url, s.source_key, s.publisher, s.title, s.source_type) into cat from public.sources s where s.id = new.source_id;
  if cat in ('CHADWICK_REGISTER', 'WIKIPEDIA', 'BAI_RESEARCH', 'WIKIDATA') then return new; end if;
  if not exists (select 1 from ingest.source_publication_grants g where g.attribution_category = cat) then
    raise exception 'a new % record cannot be published on this database without a recorded permission basis (ingest.source_publication_grants); existing records are unaffected', coalesce(cat, 'uncategorized')
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

create table ingest.release_audits (
  id bigint generated always as identity primary key,
  release_key text not null check (release_key ~ '^[a-z0-9][a-z0-9._-]*$'),
  manifest_sha256 text not null check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  draft_year integer not null check (draft_year between 1965 and 2100),
  operator text not null check (btrim(operator) <> ''),
  session_role name not null default session_user,
  applied_at timestamptz not null default now(),
  counts jsonb not null,
  entries jsonb not null,
  unique (release_key, manifest_sha256)
);
comment on table ingest.release_audits is 'Audit of one manifest-bound research release (027): per-record outcomes (imported, skipped, held) and counts. Append-only; private.';

create function ingest.release_audits_append_only() returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  raise exception 'ingest.release_audits is append-only' using errcode = 'insufficient_privilege';
end $$;
create trigger release_audits_append_only before update or delete on ingest.release_audits
  for each row execute function ingest.release_audits_append_only();
create trigger release_audits_no_truncate before truncate on ingest.release_audits
  for each statement execute function ingest.release_audits_append_only();

revoke all on ingest.release_audits from public;
revoke all on function ingest.release_audits_append_only() from public, anon, authenticated, service_role;

select public.apply_public_boundary();
