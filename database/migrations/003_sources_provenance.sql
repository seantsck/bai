-- 003_sources_provenance
-- Field-level source observations and the provenance contract for researched facts.
--
-- Two layers of provenance:
--   1. Every researched-fact table carries a NOT NULL source_id (its primary citation). Those tables are registered in
--      provenance_fact_tables; tests assert the registry and the NOT NULL constraint stay in sync.
--   2. source_observations records what a specific source said about a specific field of a specific row, so conflicting
--      sources can coexist without overwriting each other.

create table public.provenance_fact_tables (
  table_name text primary key,
  domain text not null check (domain in ('IDENTITY', 'ORGANIZATION', 'INTERNATIONAL', 'DRAFT', 'EXPECTATION', 'OUTCOME', 'DEVELOPMENT', 'TRANSACTION', 'VALUE', 'COVERAGE')),
  description text not null
);

insert into public.provenance_fact_tables (table_name, domain, description) values
  ('organization_names', 'ORGANIZATION', 'Franchise name by season')
on conflict (table_name) do nothing;

create type public.observation_status as enum ('ACTIVE', 'SUPERSEDED', 'RETRACTED');

create table public.source_observations (
  id bigint generated always as identity primary key,
  source_id bigint not null references public.sources (id),
  subject_table text not null references public.provenance_fact_tables (table_name),
  subject_id bigint not null,
  field_name text not null check (field_name ~ '^[a-z_][a-z0-9_]*$'),
  observed_value jsonb,                 -- null = the source was checked and gives no value (not the same as value 0)
  locator text,                         -- page / section / table row inside the source
  observed_on date,
  status public.observation_status not null default 'ACTIVE',
  superseded_by_id bigint references public.source_observations (id),
  notes text,
  created_at timestamptz not null default now(),
  check ((status = 'SUPERSEDED') = (superseded_by_id is not null))
);
create index source_observations_subject_idx on public.source_observations (subject_table, subject_id, field_name);
create unique index source_observations_one_active_per_source
  on public.source_observations (source_id, subject_table, subject_id, field_name) where status = 'ACTIVE';

-- Fields where active observations from different sources disagree.
create view public.v_source_conflicts with (security_invoker = true) as
select subject_table, subject_id, field_name, count(distinct observed_value) as distinct_values,
       array_agg(distinct source_id order by source_id) as source_ids
from public.source_observations
where status = 'ACTIVE' and observed_value is not null
group by subject_table, subject_id, field_name
having count(distinct observed_value) > 1;
