-- 005_expectations
-- Shared acquisition-time expectation model for International and Draft.
--
-- Rankings and evaluations are stored as structured facts (rank, board position, FV and tool grades only when the source
-- published them explicitly). Scouting prose is not stored; summary_note is a short BAI paraphrase at most.
-- Every list/evaluation carries its publication date; 007 enforces that only evidence published BEFORE an acquisition can be
-- linked as that acquisition's expectation.

create type public.ranking_list_kind as enum ('PUBLICATION_RANKING', 'DRAFT_BOARD', 'MOCK_DRAFT', 'ORGANIZATION_LIST', 'OTHER');

create table public.ranking_lists (
  id bigint generated always as identity primary key,
  source_id bigint not null references public.sources (id),
  domain public.acquisition_domain not null,
  list_kind public.ranking_list_kind not null,
  list_name text not null,
  scope_key text,                       -- e.g. '2019-20' (signing period) or '2019' (draft year)
  published_date date not null,
  list_size integer check (list_size > 0),
  unique (source_id, list_name, published_date)
);

create table public.ranking_entries (
  id bigint generated always as identity primary key,
  ranking_list_id bigint not null references public.ranking_lists (id) on delete cascade,
  player_id bigint not null references public.players (id),
  rank integer not null check (rank > 0),
  listed_position text,
  unique (ranking_list_id, player_id)
);
create index ranking_entries_player_idx on public.ranking_entries (player_id);

create table public.evaluations (
  id bigint generated always as identity primary key,
  source_id bigint not null references public.sources (id),
  domain public.acquisition_domain not null,
  player_id bigint not null references public.players (id),
  published_date date not null,
  future_value numeric(3, 1) check (future_value between 20 and 80),   -- only when the source published an FV explicitly
  risk_label text,
  summary_note text check (char_length(summary_note) <= 400),          -- BAI paraphrase; never copied prose
  unique (source_id, player_id, published_date)
);
create index evaluations_player_idx on public.evaluations (player_id);

create table public.evaluation_grades (
  id bigint generated always as identity primary key,
  evaluation_id bigint not null references public.evaluations (id) on delete cascade,
  skill text not null check (skill in ('HIT', 'POWER', 'RAW_POWER', 'GAME_POWER', 'RUN', 'ARM', 'FIELD', 'FASTBALL', 'CURVEBALL',
                                       'SLIDER', 'CHANGEUP', 'CUTTER', 'SPLITTER', 'OTHER_PITCH', 'CONTROL', 'COMMAND', 'OVERALL')),
  present_grade smallint check (present_grade between 20 and 80),
  future_grade smallint check (future_grade between 20 and 80),
  check (present_grade is not null or future_grade is not null),
  unique (evaluation_id, skill)
);

insert into public.provenance_fact_tables (table_name, domain, description) values
  ('ranking_lists', 'EXPECTATION', 'Published ranking / board / mock list'),
  ('evaluations', 'EXPECTATION', 'Published structured evaluation')
on conflict (table_name) do nothing;

create view public.international_rankings with (security_invoker = true) as
select l.id as ranking_list_id, l.list_name, l.list_kind, l.scope_key, l.published_date, l.source_id, e.player_id, e.rank, e.listed_position
from public.ranking_lists l join public.ranking_entries e on e.ranking_list_id = l.id
where l.domain = 'INTERNATIONAL';

create view public.draft_rankings with (security_invoker = true) as
select l.id as ranking_list_id, l.list_name, l.list_kind, l.scope_key, l.published_date, l.source_id, e.player_id, e.rank, e.listed_position
from public.ranking_lists l join public.ranking_entries e on e.ranking_list_id = l.id
where l.domain = 'DRAFT';

create view public.international_evaluations with (security_invoker = true) as
select * from public.evaluations where domain = 'INTERNATIONAL';

create view public.draft_evaluations with (security_invoker = true) as
select * from public.evaluations where domain = 'DRAFT';
