-- 013_ingestion
-- Research ingestion: RAW SOURCE -> staged records -> validation -> identity resolution -> conflict detection -> canonical write.
--
-- Rules encoded here:
--   * Staging lives in its own schema (ingest), never granted to public roles. Raw imports never write canonical tables;
--     only the apply step (scripts/research) moves validated rows across, inside one transaction per batch.
--   * A batch is identified by the sha256 of its file, so importing the same file twice is a no-op.
--   * Identity: strong external ids dominate; name-only matching never links automatically. Only EXACT_EXTERNAL_ID and
--     EXACT_COMPOSITE may auto-link; NO_MATCH may create a new player; everything else waits for a researcher.

create schema if not exists ingest;
revoke all on schema ingest from public;

create type ingest.batch_channel as enum ('DRAFT', 'INTERNATIONAL');
create type ingest.batch_status as enum ('STAGED', 'VALIDATED', 'VALIDATION_FAILED', 'APPLIED', 'ABANDONED');
create type ingest.validation_status as enum ('PENDING', 'VALID', 'INVALID');
create type ingest.identity_match_state as enum ('EXACT_EXTERNAL_ID', 'EXACT_COMPOSITE', 'PROBABLE_MATCH', 'AMBIGUOUS', 'NO_MATCH', 'CONFLICT');
create type ingest.conflict_status as enum ('NOT_CHECKED', 'NONE', 'CONFLICT');
create type ingest.review_state as enum ('UNREVIEWED', 'AUTO_ACCEPTED', 'NEEDS_REVIEW', 'APPROVED', 'REJECTED');
create type ingest.apply_action as enum ('INSERT', 'UPDATE_UNKNOWN', 'CORROBORATE', 'NO_CHANGE', 'CONFLICT', 'HELD');

create table ingest.import_batches (
  id bigint generated always as identity primary key,
  batch_key text not null unique check (batch_key ~ '^[a-z0-9][a-z0-9_.:-]*$'),
  channel ingest.batch_channel not null,
  file_name text not null,
  file_sha256 text not null unique check (file_sha256 ~ '^[0-9a-f]{64}$'),
  description text,
  coverage_claim jsonb,                   -- what the batch claims about its scope; validated against coverage rules on apply
  record_count integer not null check (record_count >= 0),
  status ingest.batch_status not null default 'STAGED',
  imported_by text not null,
  imported_at timestamptz not null default now(),
  validated_at timestamptz,
  applied_at timestamptz,
  last_report jsonb,                      -- summary counts of the latest validate / dry-run / apply
  check ((status = 'APPLIED') = (applied_at is not null))
);

-- Sources declared by a batch. Registered in public.sources on apply; a key that already exists must match exactly.
create table ingest.staged_sources (
  batch_id bigint not null references ingest.import_batches (id) on delete cascade,
  source_key text not null,
  payload jsonb not null,
  primary key (batch_id, source_key)
);

create table ingest.staged_records (
  id bigint generated always as identity primary key,
  batch_id bigint not null references ingest.import_batches (id) on delete cascade,
  record_index integer not null check (record_index >= 0),
  record_type text not null check (record_type in ('DRAFT_SELECTION', 'INTERNATIONAL_SIGNING')),
  record_sha256 text not null,
  payload jsonb not null,
  source_key text not null,
  validation_status ingest.validation_status not null default 'PENDING',
  validation_errors text[] not null default '{}',
  validation_warnings text[] not null default '{}',
  identity_state ingest.identity_match_state,
  identity_candidates jsonb,
  matched_player_id bigint references public.players (id),
  conflict_status ingest.conflict_status not null default 'NOT_CHECKED',
  conflict_details jsonb,
  review_state ingest.review_state not null default 'UNREVIEWED',
  reviewed_by text,
  review_note text,
  proposed_action ingest.apply_action,
  canonical_table text,
  canonical_id bigint,
  applied_action ingest.apply_action,
  applied_at timestamptz,
  unique (batch_id, record_index),
  check ((validation_status = 'INVALID') = (cardinality(validation_errors) > 0)),
  check (review_state not in ('APPROVED', 'REJECTED') or (reviewed_by is not null and review_note is not null))
);
create index staged_records_identity_idx on ingest.staged_records (identity_state);

-- ---------------------------------------------------------------------------------------------------------------
-- Identity resolution
-- ---------------------------------------------------------------------------------------------------------------

-- p: { full_name, birth_date (YYYY-MM-DD, day precision only), birth_country, school, organization,
--      external_ids: { MLBAM: '...', BBREF: '...', BBREF_MINORS: '...', FANGRAPHS: '...' } }
-- Returns the state, the linked player (only for safe states) and every candidate with the reason it was considered.
create function ingest.resolve_identity(p jsonb, out state ingest.identity_match_state, out player_id bigint, out candidates jsonb)
language plpgsql stable
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  v_ids jsonb := coalesce(p -> 'external_ids', '{}'::jsonb);
  v_dob date := nullif(p ->> 'birth_date', '')::date;
  v_country text := nullif(p ->> 'birth_country', '');
  v_id_players bigint[];
  v_contradiction text;
  v_strong bigint[];
  v_weak bigint[];
begin
  -- 1. External ids. Any two ids pointing at different players, or a matched player holding a different id in a supplied
  --    system, is a CONFLICT.
  select coalesce(array_agg(distinct x.player_id), '{}') into v_id_players
  from jsonb_each_text(v_ids) e
  join public.player_external_ids x on x.id_system::text = e.key and x.external_id = e.value;

  if cardinality(v_id_players) > 1 then
    state := 'CONFLICT';
    select jsonb_agg(jsonb_build_object('player_id', u, 'reason', 'external ids resolve to different players')) into candidates from unnest(v_id_players) u;
    return;
  elsif cardinality(v_id_players) = 1 then
    select string_agg(format('%s %s <> %s', x.id_system, e.value, x.external_id), '; ') into v_contradiction
    from jsonb_each_text(v_ids) e
    join public.player_external_ids x on x.player_id = v_id_players[1] and x.id_system::text = e.key
    where x.external_id <> e.value;
    candidates := jsonb_build_array(jsonb_build_object('player_id', v_id_players[1], 'reason', coalesce('contradicting id: ' || v_contradiction, 'external id')));
    if v_contradiction is not null then state := 'CONFLICT'; return; end if;
    -- A birth-date disagreement here is a field conflict on the same player (recorded as observations), not an identity one.
    state := 'EXACT_EXTERNAL_ID'; player_id := v_id_players[1];
    return;
  end if;

  -- 2. No id match. Name / alias candidates, minus anyone who provably differs (holds a different id in a supplied system).
  with names as (
    select c.player_id, string_agg(c.matched_on, ',') as matched_on from public.player_name_candidates(p ->> 'full_name') c group by c.player_id
  ), scored as (
    select n.player_id, n.matched_on, pl.birth_date, pl.birth_date_precision, pl.birth_country,
           exists (select 1 from jsonb_each_text(v_ids) e join public.player_external_ids x
                   on x.player_id = n.player_id and x.id_system::text = e.key and x.external_id <> e.value) as id_differs
    from names n join public.players pl on pl.id = n.player_id
  )
  select
    coalesce(array_agg(player_id) filter (where not id_differs and v_dob is not null and birth_date = v_dob and birth_date_precision = 'DAY'
                                          and (v_country is null or birth_country is null or public.normalize_name(birth_country) = public.normalize_name(v_country))), '{}'),
    coalesce(array_agg(player_id) filter (where not id_differs and not (v_dob is not null and birth_date = v_dob and birth_date_precision = 'DAY')), '{}'),
    jsonb_agg(jsonb_build_object('player_id', player_id, 'matched_on', matched_on,
      'reason', case when id_differs then 'excluded: holds a different external id'
                     when v_dob is not null and birth_date = v_dob and birth_date_precision = 'DAY' then 'name + exact birth date'
                     when v_dob is not null and birth_date is not null then 'name only; birth date differs'
                     else 'name only' end) order by player_id)
  into v_strong, v_weak, candidates
  from scored;

  if cardinality(v_strong) = 1 and cardinality(v_weak) = 0 then
    state := 'EXACT_COMPOSITE'; player_id := v_strong[1];
  elsif cardinality(v_strong) + cardinality(v_weak) > 1 then
    state := 'AMBIGUOUS';
  elsif cardinality(v_weak) = 1 then
    state := 'PROBABLE_MATCH';                -- name only (or name with a contradicting birth date): a researcher decides
  else
    state := 'NO_MATCH';
  end if;
  candidates := coalesce(candidates, '[]'::jsonb);
end $$;

revoke all on all tables in schema ingest from public, anon, authenticated;
revoke all on all functions in schema ingest from public, anon, authenticated;
