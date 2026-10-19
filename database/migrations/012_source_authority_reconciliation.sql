-- 012_source_authority_reconciliation
-- Source authority, richer source metadata, rules eras for the calendars, and the reconciliation layer.
--
-- Rules encoded here:
--   * Authority is metadata for reconciliation, never a truth value: a lower-authority source is not "false".
--   * Competing observations are all kept. A canonical value that was chosen between disagreeing sources records the
--     observation it came from, the rule (or operator) that chose it, and why. There is no last-write-wins path.
--   * New public tables get the same RLS / grant treatment as 011 through public.apply_public_boundary().

-- ---------------------------------------------------------------------------------------------------------------
-- Source registry
-- ---------------------------------------------------------------------------------------------------------------

create type public.source_authority as enum (
  'OFFICIAL',             -- MLB / MLBAM / club releases, the official draft tracker and transaction wire
  'PRIMARY_PUBLIC',       -- primary documents made public (CBA text, official rules documents)
  'REPUTABLE_SECONDARY',  -- established news / research outlets reporting the fact
  'AGGREGATOR',           -- compilations (Baseball-Reference, Wikipedia)
  'ARCHIVE',              -- an archived copy (web.archive.org) of a page no longer served
  'OTHER'
);

-- Ordering hint used by the explicit PREFER_HIGHER_AUTHORITY rule only. Lower number = stronger.
create function public.source_authority_rank(p public.source_authority) returns integer
language sql immutable parallel safe
set search_path = pg_catalog, public
as $$
  select case p when 'OFFICIAL' then 1 when 'PRIMARY_PUBLIC' then 2 when 'REPUTABLE_SECONDARY' then 3
                when 'AGGREGATOR' then 4 when 'ARCHIVE' then 5 else 6 end
$$;

alter table public.sources rename column accessed_date to retrieved_date;
alter table public.sources
  add column authority_level public.source_authority not null default 'OTHER',
  add column reference text,                                           -- non-URL citation (document, section)
  add column effective_from date,                                      -- period the source speaks to, when it is bounded
  add column effective_to date,
  add column archived_url text check (archived_url is null or archived_url ~ '^https?://'),
  add constraint sources_effective_range_check check (effective_from is null or effective_to is null or effective_from <= effective_to),
  -- Every research source must be locatable; only test fixtures may lack a URL or reference.
  add constraint sources_locatable_check check (source_type = 'TEST_FIXTURE' or url is not null or reference is not null);

update public.sources set authority_level = 'OFFICIAL' where source_key = 'bai-reference:mlb-franchises';

-- ---------------------------------------------------------------------------------------------------------------
-- Rules eras (calendar metadata for drafts and international periods)
-- ---------------------------------------------------------------------------------------------------------------

create table public.rules_eras (
  id bigint generated always as identity primary key,
  rules_era_key text not null unique check (rules_era_key ~ '^[A-Z0-9_]+$'),
  label text not null,
  effective_from date,                    -- null = not established from an acceptable source
  effective_to date,
  summary text not null check (length(summary) <= 600),
  source_id bigint not null references public.sources (id),
  check (effective_from is null or effective_to is null or effective_from <= effective_to)
);

alter table public.drafts add column rules_era_id bigint references public.rules_eras (id);
alter table public.international_signing_periods add column rules_era_id bigint references public.rules_eras (id);
alter table public.international_signing_periods add column timing_note text;

-- ---------------------------------------------------------------------------------------------------------------
-- Observations on identity fields
-- ---------------------------------------------------------------------------------------------------------------

-- players carry no single primary citation (identity is evidenced field by field), but their fields are observable.
alter table public.provenance_fact_tables add column primary_source_required boolean not null default true;
insert into public.provenance_fact_tables (table_name, domain, description, primary_source_required) values
  ('players', 'IDENTITY', 'Player identity fields (evidenced by source_observations)', false),
  ('rules_eras', 'ORGANIZATION', 'Rules era / CBA metadata', true)
on conflict (table_name) do nothing;

-- ---------------------------------------------------------------------------------------------------------------
-- Reconciliation
-- ---------------------------------------------------------------------------------------------------------------

create type public.conflict_rule as enum (
  'REQUIRE_OPERATOR',                 -- a researcher must choose and record a rationale
  'PREFER_HIGHER_AUTHORITY',          -- choose the strictly stronger source; equal authority falls back to the operator
  'PREFER_MORE_PRECISE_DATE',         -- choose the strictly more precise date; equal precision falls back to the operator
  'KEEP_ALL'                          -- multi-valued by nature (e.g. several rankings); never a conflict
);

-- Declared rule per field. A field with no row is REQUIRE_OPERATOR.
create table public.conflict_rules (
  subject_table text not null references public.provenance_fact_tables (table_name),
  field_name text not null,
  rule public.conflict_rule not null,
  rationale text not null,
  primary key (subject_table, field_name)
);

insert into public.conflict_rules (subject_table, field_name, rule, rationale) values
  ('players', 'birth_date', 'REQUIRE_OPERATOR', 'Identity-critical; differing birth dates can mean different people or a falsified age.'),
  ('players', 'primary_position', 'REQUIRE_OPERATOR', 'Positions change over time; sources describe different moments.'),
  ('players', 'birth_country', 'REQUIRE_OPERATOR', 'Identity-relevant.'),
  ('international_signings', 'signing_bonus_usd', 'PREFER_HIGHER_AUTHORITY', 'Official figures dominate reported ones; equal authority needs a researcher.'),
  ('international_signings', 'signing_date', 'PREFER_MORE_PRECISE_DATE', 'An exact day beats a month or season; two different exact days need a researcher.'),
  ('draft_signings', 'signing_status', 'REQUIRE_OPERATOR', 'Signed vs did-not-sign changes cohort membership.'),
  ('draft_signings', 'signing_bonus_usd', 'PREFER_HIGHER_AUTHORITY', 'Official figures dominate reported ones; equal authority needs a researcher.'),
  ('draft_selections', 'position', 'REQUIRE_OPERATOR', 'Listed position at selection differs between sources.')
on conflict do nothing;

-- The decision behind a canonical value where active observations disagree.
create table public.fact_resolutions (
  id bigint generated always as identity primary key,
  subject_table text not null references public.provenance_fact_tables (table_name),
  subject_id bigint not null,
  field_name text not null,
  chosen_observation_id bigint not null references public.source_observations (id),
  considered_observation_ids bigint[] not null,
  rule public.conflict_rule not null,
  decided_by text not null check (btrim(decided_by) <> ''),         -- 'rule:PREFER_HIGHER_AUTHORITY' or an operator handle
  rationale text not null check (btrim(rationale) <> ''),
  decided_at timestamptz not null default now(),
  check (chosen_observation_id = any (considered_observation_ids)),
  check (rule <> 'KEEP_ALL')
);
create unique index fact_resolutions_one_per_field on public.fact_resolutions (subject_table, subject_id, field_name);

-- Open conflicts: disagreeing active observations on a field with no resolution covering every one of them.
create view public.v_open_fact_conflicts with (security_invoker = true) as
with c as (
  select o.subject_table, o.subject_id, o.field_name,
         array_agg(o.id order by o.id) as observation_ids,
         count(distinct o.observed_value) as distinct_values
  from public.source_observations o
  where o.status = 'ACTIVE' and o.observed_value is not null
  group by o.subject_table, o.subject_id, o.field_name
  having count(distinct o.observed_value) > 1
)
select c.*, coalesce(r.rule, 'REQUIRE_OPERATOR'::public.conflict_rule) as declared_rule
from c
left join public.conflict_rules r on r.subject_table = c.subject_table and r.field_name = c.field_name
where coalesce(r.rule, 'REQUIRE_OPERATOR') <> 'KEEP_ALL'
  and not exists (select 1 from public.fact_resolutions f
                  where f.subject_table = c.subject_table and f.subject_id = c.subject_id and f.field_name = c.field_name
                    and f.considered_observation_ids @> c.observation_ids);

-- ---------------------------------------------------------------------------------------------------------------
-- Public boundary for objects created after 011 (re-runnable; same policy as 011)
-- ---------------------------------------------------------------------------------------------------------------

insert into public.internal_objects values
  ('fact_resolutions', 'research operations'),
  ('conflict_rules', 'research operations'),
  ('v_open_fact_conflicts', 'research worklist')
on conflict (object_name) do nothing;

create function public.apply_public_boundary() returns void
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  t record;
begin
  for t in select c.relname, c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind in ('r', 'p', 'v') loop
    if t.relkind <> 'v' then execute format('alter table public.%I enable row level security', t.relname); end if;
    execute format('revoke all on public.%I from public, anon, authenticated', t.relname);
    if not exists (select 1 from public.internal_objects where object_name = t.relname) then
      execute format('grant select on public.%I to anon, authenticated', t.relname);
      if t.relkind <> 'v' then
        execute format('drop policy if exists public_read on public.%I', t.relname);
        execute format('create policy public_read on public.%I for select to anon, authenticated using (true)', t.relname);
      end if;
    end if;
  end loop;
  revoke execute on all functions in schema public from public, anon, authenticated;
  revoke all on all tables in schema analytics from public, anon, authenticated;
end $$;

select public.apply_public_boundary();
