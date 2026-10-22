-- 027_wikidata_attribution
-- Recognises Wikidata structured data (CC0 1.0) as its own attribution category, WIKIDATA, and lets correctly identified
-- Wikidata sources through the hosted publication guard (025/026). Additive: no rows, views, privileges, grants or
-- certification rules change. Restricted sources stay refused.
--
--   1. public.source_attribution_category(...): the attribution rule as one immutable function, so the generated column,
--      the immutability trigger and the tests all use the same definition. The rule's order now puts the restricted groups
--      (Baseball-Reference, MLB) before every label-based group, so a source cannot reach a free group by putting a free
--      source's name in its title or key while pointing at a restricted host. Existing rows keep their categories
--      (the migration fails if any would change).
--   2. WIKIDATA is assigned only when URL, publisher, type and key ALL identify Wikidata: https on www.wikidata.org or
--      query.wikidata.org (no look-alike host, no userinfo), publisher 'Wikimedia Foundation (Wikidata contributors)',
--      type REFERENCE_DATABASE, key hist:wikidata-<...>. A label alone is not enough.
--   3. The publication guard passes WIKIDATA like Chadwick Register, Wikipedia and BAI research (CC0, no permission
--      needed); every other group still needs a recorded basis.
--   4. A source's attribution category is fixed once it exists: updating its url, key, publisher, title or type so that
--      the category changes is refused (it would silently relabel records already citing it).
--   5. ingest.release_audits: an append-only, private record of a manifest-bound research release (what was imported,
--      skipped and held, by whom), written in the same transaction as the release it describes.

create function public.source_attribution_category(p_url text, p_source_key text, p_publisher text, p_title text, p_source_type public.source_type)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog
as $$
  select case
    when p_source_type = 'TEST_FIXTURE' then 'TEST_FIXTURE'
    when p_source_type = 'BAI_REFERENCE' then 'BAI_RESEARCH'
    when lower(coalesce(p_url, '') || ' ' || p_source_key || ' ' || coalesce(p_publisher, '') || ' ' || p_title) ~ '(baseball-reference\.com|sports-reference\.com|sports reference)' then 'BASEBALL_REFERENCE'
    when p_source_type = 'OFFICIAL_LEAGUE'
      or lower(coalesce(p_url, '') || ' ' || coalesce(p_publisher, '')) ~ '(statsapi\.mlb\.com|(^|[/.])mlb\.com|(^|[/.])milb\.com|mlb advanced media)' then 'MLB'
    when p_source_type = 'REFERENCE_DATABASE'
      and coalesce(p_url, '') ~ '^https://(www\.wikidata\.org|query\.wikidata\.org)(/|\?|$)'
      and coalesce(p_url, '') !~ '\s'
      and p_publisher = 'Wikimedia Foundation (Wikidata contributors)'
      and p_source_key ~ '^hist:wikidata-[a-z0-9._:-]+$' then 'WIKIDATA'
    when lower(coalesce(p_url, '') || ' ' || p_source_key || ' ' || coalesce(p_publisher, '') || ' ' || p_title) ~ 'chadwick' then 'CHADWICK_REGISTER'
    when lower(coalesce(p_url, '') || ' ' || p_source_key || ' ' || coalesce(p_publisher, '')) ~ 'wikipedia' then 'WIKIPEDIA'
    else 'OTHER_PUBLICATION'
  end
$$;
comment on function public.source_attribution_category(text, text, text, text, public.source_type) is 'The attribution rule (025, restated in 027). WIKIDATA needs URL, publisher, type and key together; restricted groups are decided before label-based ones.';

-- Existing rows must keep their categories: compare the old stored value with the new rule before changing anything.
do $$
declare
  changed integer;
begin
  select count(*) into changed from public.sources s
  where s.attribution_category is distinct from public.source_attribution_category(s.url, s.source_key, s.publisher, s.title, s.source_type);
  if changed > 0 then
    raise exception '027: % existing source(s) would change attribution category; review them before applying', changed;
  end if;
end $$;

alter table public.sources alter column attribution_category set expression as
  (public.source_attribution_category(url, source_key, publisher, title, source_type));
comment on column public.sources.attribution_category is 'Public attribution group (025; rule in public.source_attribution_category, 027). Says where a record came from; not a statement of redistribution rights.';

create function public.source_category_fixed() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if public.source_attribution_category(old.url, old.source_key, old.publisher, old.title, old.source_type)
     is distinct from public.source_attribution_category(new.url, new.source_key, new.publisher, new.title, new.source_type) then
    raise exception 'the attribution category of source % is fixed: changing its url, key, publisher, title or type so that it moves from % to % is refused (027)',
      old.source_key, public.source_attribution_category(old.url, old.source_key, old.publisher, old.title, old.source_type),
      public.source_attribution_category(new.url, new.source_key, new.publisher, new.title, new.source_type)
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;
create trigger sources_category_fixed before update of url, source_key, publisher, title, source_type on public.sources
  for each row execute function public.source_category_fixed();

-- The publication guard: WIKIDATA joins the groups that need no recorded basis (CC0). Everything else is unchanged.
create or replace function public.source_publication_guard() returns trigger
language plpgsql
set search_path = pg_catalog, public, ingest
as $$
declare
  cat text;
begin
  if not exists (select 1 from pg_roles where rolname = 'supabase_admin') then return new; end if;   -- hosted (Supabase) only
  if new.source_id is null then return new; end if;
  select attribution_category into cat from public.sources where id = new.source_id;
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
