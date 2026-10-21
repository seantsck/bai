-- 025_attribution_and_historical_review
-- Public source attribution, a database-level lock on historical draft years, and the private review workflow for the
-- historical importer's exceptions. Additive.
--
--   1. sources.attribution_category (generated): which kind of source each citation is, for public attribution:
--        MLB                 MLB / MLB Advanced Media (Stats API, transaction wire, MLB.com, MiLB.com)
--        BASEBALL_REFERENCE  Baseball-Reference / Sports Reference pages, live or archived
--        CHADWICK_REGISTER   the Chadwick Baseball Bureau register (identity crosswalk)
--        WIKIPEDIA           Wikipedia articles (facts with revision ids)
--        BAI_RESEARCH        BAI's own reference compilations and researcher determinations
--        OTHER_PUBLICATION   news media, Baseball America, FanGraphs, clubs and other publications
--        TEST_FIXTURE        test data (never in a research database)
--      Attribution says where a record came from. It does not create, and is not evidence of, a right to redistribute it
--      (docs/history/hosted-provenance.md).
--   2. v_source_attribution (public): records and field observations citing each category, by domain. Counts only.
--   3. v_selection_attribution (public): the attribution group of each selection's and signing's primary source.
--   4. ingest.historical_releases + a trigger on draft_selections: a selection in a historical draft year (before 2015) is
--      refused unless that year has been released on this database with an authorization reference. Defense in depth
--      under the importer's permission gates (scripts/history/lib/permissions.mjs): no import path, script or ad hoc SQL
--      can put historical selections on a database where the year was not deliberately released.
--   5. research.history_exceptions and friends: the private exception-review workflow. Exceptions keep their source
--      claims and evidence; anyone may propose a conclusion; only an enrolled human reviewer, in their own authenticated
--      session (research.require_reviewer, 021), records a decision. Everything is append-only and logged. A decision
--      records a judgment; it never changes a canonical fact (corrections go through the research pipeline) and has no
--      bearing on certification, which stays behind its own gate. Restricted evidence: the loader refuses non-local
--      databases, and on a Supabase database (hosted) the tables refuse rows outright.

-- ---------------------------------------------------------------------------------------------------------------
-- 1. Attribution category
-- ---------------------------------------------------------------------------------------------------------------

alter table public.sources add column attribution_category text generated always as (
  case
    when source_type = 'TEST_FIXTURE' then 'TEST_FIXTURE'
    when source_type = 'BAI_REFERENCE' then 'BAI_RESEARCH'
    when lower(coalesce(url, '') || ' ' || source_key || ' ' || coalesce(publisher, '') || ' ' || title) ~ '(baseball-reference\.com|sports-reference\.com|sports reference)' then 'BASEBALL_REFERENCE'
    when lower(coalesce(url, '') || ' ' || source_key || ' ' || coalesce(publisher, '') || ' ' || title) ~ 'chadwick' then 'CHADWICK_REGISTER'
    when lower(coalesce(url, '') || ' ' || source_key || ' ' || coalesce(publisher, '')) ~ 'wikipedia' then 'WIKIPEDIA'
    when source_type = 'OFFICIAL_LEAGUE'
      or lower(coalesce(url, '') || ' ' || coalesce(publisher, '')) ~ '(statsapi\.mlb\.com|(^|[/.])mlb\.com|(^|[/.])milb\.com|mlb advanced media)' then 'MLB'
    else 'OTHER_PUBLICATION'
  end
) stored;
comment on column public.sources.attribution_category is 'Public attribution group (025). Says where a record came from; not a statement of redistribution rights.';

-- ---------------------------------------------------------------------------------------------------------------
-- 2. Public attribution summary (counts only; no function calls: anon executes none)
-- ---------------------------------------------------------------------------------------------------------------

create view public.v_source_attribution with (security_invoker = true) as
with cited (domain, source_id) as (
  select 'DRAFT', source_id from public.draft_selections
  union all select 'DRAFT', source_id from public.draft_signings
  union all select 'DRAFT', source_id from public.slot_values
  union all select 'DRAFT', source_id from public.drafts
  union all select 'DRAFT', source_id from public.organization_draft_pools
  union all select 'DRAFT', source_id from public.schools
  union all select 'INTERNATIONAL', source_id from public.international_signings
  union all select 'INTERNATIONAL', source_id from public.international_signing_periods
  union all select 'INTERNATIONAL', source_id from public.organization_signing_period_context
  union all select 'INTERNATIONAL', source_id from public.academies
  union all select 'INTERNATIONAL', source_id from public.trainers
  union all select 'INTERNATIONAL', source_id from public.player_academy_relationships
  union all select 'INTERNATIONAL', source_id from public.player_trainer_relationships
  union all select 'DEVELOPMENT', source_id from public.affiliate_seasons
  union all select 'DEVELOPMENT', source_id from public.development_events
  union all select 'DEVELOPMENT', source_id from public.player_assignments
  union all select 'EXPECTATION', source_id from public.evaluations
  union all select 'EXPECTATION', source_id from public.ranking_lists
  union all select 'VALUE', source_id from public.organization_value_attributions
  union all select 'IDENTITY', source_id from public.player_external_ids
  union all select 'IDENTITY', source_id from public.player_aliases
  union all select 'OUTCOME', source_id from public.outcome_audits
  union all select 'OUTCOME', source_id from public.outcome_audit_details
  union all select 'OUTCOME', source_id from public.war_observations
  union all select 'OUTCOME', source_id from public.mlb_debuts
  union all select 'OUTCOME', source_id from public.acquisition_dispositions
  union all select 'TRANSACTION', source_id from public.transactions
  union all select 'ORGANIZATION', source_id from public.organization_names
  union all select 'ORGANIZATION', source_id from public.organization_league_seasons
  union all select 'ORGANIZATION', source_id from public.rules_eras
  union all select 'FIELD_OBSERVATION', source_id from public.source_observations
)
select s.attribution_category, c.domain, count(*)::int as records, count(distinct s.id)::int as sources
from cited c join public.sources s on s.id = c.source_id
where s.attribution_category <> 'TEST_FIXTURE'
group by s.attribution_category, c.domain;
comment on view public.v_source_attribution is 'Records (primary citations) and field observations per attribution category and domain (025). Counts only.';

-- ---------------------------------------------------------------------------------------------------------------
-- 3. Per-selection attribution (a separate view, so v_draft_explorer and pages built on it are unchanged)
-- ---------------------------------------------------------------------------------------------------------------

create view public.v_selection_attribution with (security_invoker = true) as
select s.id as selection_id, ss.attribution_category as selection_source_category, gs.attribution_category as signing_source_category
from public.draft_selections s
join public.sources ss on ss.id = s.source_id
left join public.draft_signings g on g.draft_selection_id = s.id
left join public.sources gs on gs.id = g.source_id;
comment on view public.v_selection_attribution is 'Attribution group of each selection''s and signing''s primary source (025).';

-- ---------------------------------------------------------------------------------------------------------------
-- 4. Historical publication lock
-- ---------------------------------------------------------------------------------------------------------------

create table ingest.historical_releases (
  draft_year integer primary key check (draft_year between 1965 and 2014),
  authorization_reference text not null check (btrim(authorization_reference) <> ''),
  scope_note text not null check (btrim(scope_note) <> ''),
  released_by name not null default session_user,
  released_at timestamptz not null default now()
);
comment on table ingest.historical_releases is 'Draft years before 2015 released on THIS database (025). On hosted, a row is a deliberate, recorded decision citing the authorization that permits publishing that year (research/history/sources.json); locally, the importer records its local research use.';

create function public.draft_selection_historical_guard() returns trigger
language plpgsql
set search_path = pg_catalog, public, ingest
as $$
declare
  y integer;
begin
  select draft_year into y from public.drafts where id = new.draft_id;
  if y < 2015 and not exists (select 1 from ingest.historical_releases r where r.draft_year = y) then
    raise exception 'draft year % is historical and has not been released on this database (ingest.historical_releases; see docs/history/README.md)', y
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;
create trigger draft_selections_historical_guard before insert or update of draft_id on public.draft_selections
  for each row execute function public.draft_selection_historical_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- 5. Historical exception review (private)
-- ---------------------------------------------------------------------------------------------------------------

create type research.history_exception_kind as enum (
  'CONFLICTING_IDENTITY',            -- one id may stand for two people (or two records for one person)
  'MISSING_SELECTION',               -- a selection one source lists and another lacks
  'DIFFERENT_PLAYER_SAME_PICK',      -- sources name different players at the same pick
  'SAME_PERSON_MULTIPLE_SELECTIONS', -- one person at two picks of one phase
  'ALTERNATE_NAME',                  -- spellings, nicknames, legal names
  'NUMBERING_DISAGREEMENT',          -- overall pick numbers differ between compilers
  'CROSSWALK_UNMATCHED',             -- no match in the identity crosswalk
  'CENSUS_TOTAL_DISAGREEMENT'        -- a stated total differs from a source's count
);
create type research.history_exception_status as enum ('OPEN', 'PROPOSED', 'NEEDS_EVIDENCE', 'DECIDED');

-- Conclusions a reviewer can reach, per kind. A decision must name one of these.
create table research.history_exception_conclusions (
  kind research.history_exception_kind not null,
  conclusion text not null check (conclusion ~ '^[A-Z][A-Z_]*$'),
  description text not null,
  primary key (kind, conclusion)
);
insert into research.history_exception_conclusions (kind, conclusion, description) values
  ('CONFLICTING_IDENTITY', 'ONE_PERSON', 'The records describe one person.'),
  ('CONFLICTING_IDENTITY', 'DIFFERENT_PEOPLE', 'The records describe different people; identities must be split.'),
  ('CONFLICTING_IDENTITY', 'UNDETERMINED', 'The evidence cannot settle it; the class stays partial.'),
  ('MISSING_SELECTION', 'SELECTION_CONFIRMED', 'The selection happened; it must be added through the research pipeline with its evidence.'),
  ('MISSING_SELECTION', 'NOT_A_SELECTION', 'The other list is wrong; no selection is added.'),
  ('MISSING_SELECTION', 'UNDETERMINED', 'The evidence cannot settle it; the class stays partial.'),
  ('DIFFERENT_PLAYER_SAME_PICK', 'FIRST_SOURCE_CORRECT', 'The first source''s player is the selection.'),
  ('DIFFERENT_PLAYER_SAME_PICK', 'SECOND_SOURCE_CORRECT', 'The second source''s player is the selection; a correction goes through the pipeline.'),
  ('DIFFERENT_PLAYER_SAME_PICK', 'UNDETERMINED', 'The evidence cannot settle it; the class stays partial.'),
  ('SAME_PERSON_MULTIPLE_SELECTIONS', 'ONE_PERSON_PICKED_TWICE', 'One person really was selected twice (both picks stand).'),
  ('SAME_PERSON_MULTIPLE_SELECTIONS', 'FEED_ERROR', 'A feed error: one of the picks belongs to someone else, to be identified.'),
  ('SAME_PERSON_MULTIPLE_SELECTIONS', 'TWO_PEOPLE_MERGED', 'Two people share one id; identities must be split.'),
  ('SAME_PERSON_MULTIPLE_SELECTIONS', 'UNDETERMINED', 'The evidence cannot settle it; the held pick stays held.'),
  ('ALTERNATE_NAME', 'SAME_PERSON', 'The names are variants for one person; no change.'),
  ('ALTERNATE_NAME', 'DIFFERENT_PERSON', 'Different people; the census claim for that club must be withdrawn.'),
  ('ALTERNATE_NAME', 'PARTLY_DIFFERENT', 'A group with both: listed per pair in the decision''s evidence.'),
  ('ALTERNATE_NAME', 'UNDETERMINED', 'The evidence cannot settle it.'),
  ('NUMBERING_DISAGREEMENT', 'IDENTITY_UNAFFECTED', 'Numbering differs but identity does not depend on it; no change.'),
  ('NUMBERING_DISAGREEMENT', 'PRIMARY_ORDER_ESTABLISHED', 'A primary account establishes the order; recorded in evidence.'),
  ('NUMBERING_DISAGREEMENT', 'UNDETERMINED', 'No primary order found.'),
  ('CROSSWALK_UNMATCHED', 'NO_OTHER_IDS_EXPECTED', 'Never played professionally (or no other system has them); nothing to add.'),
  ('CROSSWALK_UNMATCHED', 'MATCH_FOUND', 'A match exists in a later crosswalk; to be added through the pipeline.'),
  ('CROSSWALK_UNMATCHED', 'UNDETERMINED', 'Not established.'),
  ('CENSUS_TOTAL_DISAGREEMENT', 'FIRST_SOURCE_CORRECT', 'The first source''s total is right.'),
  ('CENSUS_TOTAL_DISAGREEMENT', 'SECOND_SOURCE_CORRECT', 'The second source''s total is right.'),
  ('CENSUS_TOTAL_DISAGREEMENT', 'COUNTS_DIFFERENT_THINGS', 'The totals measure different things (picks, people, phases).'),
  ('CENSUS_TOTAL_DISAGREEMENT', 'UNDETERMINED', 'No expected count is claimed.');

create table research.history_exceptions (
  id bigint generated always as identity primary key,
  exception_key text not null unique check (exception_key ~ '^EX-[0-9]{4}-[A-Z0-9-]+$'),
  draft_year integer not null check (draft_year between 1965 and 2100),
  phase text,
  franchise_key text,
  kind research.history_exception_kind not null,
  summary text not null check (btrim(summary) <> ''),
  effect text not null,
  resolution_needs text not null,
  item_count integer not null default 1 check (item_count > 0),
  register_sha256 text not null check (register_sha256 ~ '^[0-9a-f]{64}$'),
  loaded_by text not null,
  loaded_session_role name not null default session_user,
  loaded_at timestamptz not null default now(),
  status research.history_exception_status not null default 'OPEN'
);

create table research.history_exception_claims (
  id bigint generated always as identity primary key,
  exception_id bigint not null references research.history_exceptions (id),
  ordinal integer not null check (ordinal > 0),
  source_catalog_id text not null,         -- research/history/sources.json id (or a description for combined claims)
  claim jsonb not null,                    -- what the source says (text or structured)
  evidence jsonb not null default '[]',    -- [{ cache_key, sha256, locator }]: where the claim can be re-read
  unique (exception_id, ordinal)
);

create table research.history_exception_proposals (
  id bigint generated always as identity primary key,
  exception_id bigint not null references research.history_exceptions (id),
  conclusion text not null,
  rationale text not null check (btrim(rationale) <> ''),
  evidence jsonb not null default '[]',
  proposed_by text not null check (btrim(proposed_by) <> ''),
  proposed_session_role name not null default session_user,
  created_at timestamptz not null default now(),
  status research.proposal_status not null default 'PROPOSED'
);
create unique index history_exception_one_open_proposal on research.history_exception_proposals (exception_id) where status = 'PROPOSED';

create type research.history_exception_decision as enum ('ACCEPT_PROPOSAL', 'REJECT_PROPOSAL', 'DECIDE', 'NEEDS_MORE_EVIDENCE', 'REOPEN');

create table research.history_exception_decisions (
  id bigint generated always as identity primary key,
  exception_id bigint not null references research.history_exceptions (id),
  proposal_id bigint references research.history_exception_proposals (id),
  decision research.history_exception_decision not null,
  conclusion text,
  rationale text not null check (btrim(rationale) <> ''),
  evidence jsonb not null default '[]',
  decided_by text not null,
  decided_session_role name not null default session_user,
  decided_at timestamptz not null default now(),
  check ((decision in ('ACCEPT_PROPOSAL', 'DECIDE')) = (conclusion is not null)),
  check ((decision in ('ACCEPT_PROPOSAL', 'REJECT_PROPOSAL')) = (proposal_id is not null))
);

create table research.history_exception_events (
  id bigint generated always as identity primary key,
  exception_id bigint not null references research.history_exceptions (id),
  event text not null check (event in ('LOADED', 'PROPOSED', 'PROPOSAL_WITHDRAWN', 'DECIDED')),
  actor text not null,
  session_role name not null default session_user,
  detail jsonb not null default '{}',
  at timestamptz not null default now()
);

-- Restricted evidence never lives on hosted: on a Supabase database the exception tables refuse rows.
create function research.history_exceptions_local_only() returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_admin') then
    raise exception 'historical exception evidence is restricted and stays in local research databases (docs/history/README.md)' using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;
create trigger history_exceptions_local_only before insert on research.history_exceptions for each row execute function research.history_exceptions_local_only();
create trigger history_exception_claims_local_only before insert on research.history_exception_claims for each row execute function research.history_exceptions_local_only();

-- Exceptions and claims: immutable once loaded (only status moves, and only through the guarded functions below).
create function research.history_exception_guard() returns trigger
language plpgsql
set search_path = pg_catalog, research
as $$
begin
  if tg_op = 'DELETE' then raise exception 'historical exceptions are never deleted' using errcode = 'check_violation'; end if;
  if tg_op = 'INSERT' then
    if new.status <> 'OPEN' then raise exception 'an exception is loaded OPEN' using errcode = 'check_violation'; end if;
    new.loaded_session_role := session_user;
    return new;
  end if;
  if (to_jsonb(new) - 'status') is distinct from (to_jsonb(old) - 'status') then
    raise exception 'an exception''s claims and context are immutable; load a corrected register under a new key' using errcode = 'check_violation';
  end if;
  if current_setting('bai.history_exception_transition', true) is distinct from 'on' then
    raise exception 'exception status changes only through a proposal or a reviewer decision' using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;
create trigger history_exceptions_guard before update or delete on research.history_exceptions for each row execute function research.history_exception_guard();
create trigger history_exceptions_insert_guard before insert on research.history_exceptions for each row execute function research.history_exception_guard();
create trigger history_exception_claims_append_only before update or delete on research.history_exception_claims for each row execute function research.decision_history_append_only();
create trigger history_exception_decisions_append_only before update or delete on research.history_exception_decisions for each row execute function research.decision_history_append_only();
create trigger history_exception_events_append_only before update or delete on research.history_exception_events for each row execute function research.decision_history_append_only();
create trigger history_exception_claims_no_truncate before truncate on research.history_exception_claims for each statement execute function research.decision_history_append_only();
create trigger history_exception_decisions_no_truncate before truncate on research.history_exception_decisions for each statement execute function research.decision_history_append_only();
create trigger history_exception_events_no_truncate before truncate on research.history_exception_events for each statement execute function research.decision_history_append_only();
create trigger history_exceptions_no_truncate before truncate on research.history_exceptions for each statement execute function research.decision_history_append_only();

-- Decisions are written only by research.decide_history_exception (a reviewer session); direct inserts are refused.
create function research.history_exception_decision_guard() returns trigger
language plpgsql
set search_path = pg_catalog, research
as $$
begin
  if current_setting('bai.history_exception_transition', true) is distinct from 'on' or research.session_reviewer() is null
     or new.decided_by is distinct from research.session_reviewer() then
    raise exception 'only an enrolled human reviewer, in their own authenticated session, decides a historical exception (session %)', session_user
      using errcode = 'insufficient_privilege';
  end if;
  new.decided_session_role := session_user;
  return new;
end $$;
create trigger history_exception_decisions_guard before insert on research.history_exception_decisions for each row execute function research.history_exception_decision_guard();

-- Proposals: anyone with access proposes (an agent included); immutable except for their status, which moves only by
-- withdrawal (the proposer) or a reviewer decision.
create function research.history_exception_proposal_guard() returns trigger
language plpgsql
set search_path = pg_catalog, research
as $$
begin
  if tg_op = 'DELETE' then raise exception 'a proposal is withdrawn or rejected, never deleted' using errcode = 'check_violation'; end if;
  if tg_op = 'INSERT' then
    if new.status <> 'PROPOSED' then raise exception 'a proposal starts as PROPOSED' using errcode = 'check_violation'; end if;
    if not exists (select 1 from research.history_exception_conclusions c join research.history_exceptions e on e.kind = c.kind
                   where e.id = new.exception_id and c.conclusion = new.conclusion) then
      raise exception 'conclusion % is not one of the conclusions for this exception''s kind', new.conclusion using errcode = 'check_violation';
    end if;
    new.proposed_session_role := session_user;
    return new;
  end if;
  if (to_jsonb(new) - 'status') is distinct from (to_jsonb(old) - 'status') then raise exception 'a proposal is immutable; file a new one' using errcode = 'check_violation'; end if;
  if old.status <> 'PROPOSED' then raise exception 'proposal % is already %', old.id, old.status using errcode = 'check_violation'; end if;
  if current_setting('bai.history_exception_transition', true) is distinct from 'on' then
    raise exception 'proposal status changes only through withdrawal or a reviewer decision' using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;
create trigger history_exception_proposals_guard before insert or update or delete on research.history_exception_proposals for each row execute function research.history_exception_proposal_guard();
create trigger history_exception_proposals_no_truncate before truncate on research.history_exception_proposals for each statement execute function research.decision_history_append_only();

create function research.history_exception_after_proposal() returns trigger
language plpgsql
set search_path = pg_catalog, research
as $$
begin
  perform set_config('bai.history_exception_transition', 'on', true);
  update research.history_exceptions set status = 'PROPOSED' where id = new.exception_id and status in ('OPEN', 'NEEDS_EVIDENCE');
  insert into research.history_exception_events (exception_id, event, actor, detail)
  values (new.exception_id, 'PROPOSED', new.proposed_by, jsonb_build_object('proposal_id', new.id, 'conclusion', new.conclusion));
  perform set_config('bai.history_exception_transition', 'off', true);
  return null;
end $$;
create trigger history_exception_proposals_after after insert on research.history_exception_proposals for each row execute function research.history_exception_after_proposal();

create function research.history_exception_after_load() returns trigger
language plpgsql
set search_path = pg_catalog, research
as $$
begin
  insert into research.history_exception_events (exception_id, event, actor, detail)
  values (new.id, 'LOADED', new.loaded_by, jsonb_build_object('register_sha256', new.register_sha256, 'kind', new.kind));
  return null;
end $$;
create trigger history_exceptions_after_load after insert on research.history_exceptions for each row execute function research.history_exception_after_load();

-- The proposer withdraws their own open proposal.
create function research.withdraw_history_exception_proposal(p_proposal_id bigint, p_proposer text, p_reason text) returns research.history_exception_proposals
language plpgsql
set search_path = pg_catalog, research
as $$
declare
  pr research.history_exception_proposals;
begin
  select * into pr from research.history_exception_proposals where id = p_proposal_id and status = 'PROPOSED';
  if not found then raise exception 'proposal % not found or not open', p_proposal_id using errcode = 'no_data_found'; end if;
  if pr.proposed_by <> p_proposer then raise exception 'only the proposer withdraws a proposal' using errcode = 'insufficient_privilege'; end if;
  perform set_config('bai.history_exception_transition', 'on', true);
  update research.history_exception_proposals set status = 'WITHDRAWN' where id = p_proposal_id returning * into pr;
  update research.history_exceptions e set status = 'OPEN' where e.id = pr.exception_id and e.status = 'PROPOSED';
  insert into research.history_exception_events (exception_id, event, actor, detail)
  values (pr.exception_id, 'PROPOSAL_WITHDRAWN', p_proposer, jsonb_build_object('proposal_id', pr.id, 'reason', p_reason));
  perform set_config('bai.history_exception_transition', 'off', true);
  return pr;
end $$;

-- A reviewer decision, in the reviewer's own session. Records a judgment; changes no canonical fact.
create function research.decide_history_exception(p_exception_key text, p_decision research.history_exception_decision, p_rationale text,
  p_conclusion text default null, p_proposal_id bigint default null, p_evidence jsonb default '[]') returns research.history_exception_decisions
language plpgsql security definer
set search_path = pg_catalog, research
as $$
declare
  v_rev text := research.require_reviewer();
  e research.history_exceptions;
  pr research.history_exception_proposals;
  d research.history_exception_decisions;
  v_conclusion text := p_conclusion;
begin
  select * into e from research.history_exceptions where exception_key = p_exception_key;
  if not found then raise exception 'exception % not found', p_exception_key using errcode = 'no_data_found'; end if;
  if p_decision in ('ACCEPT_PROPOSAL', 'REJECT_PROPOSAL') then
    select * into pr from research.history_exception_proposals where id = p_proposal_id and exception_id = e.id and status = 'PROPOSED';
    if not found then raise exception 'proposal % is not an open proposal for %', p_proposal_id, p_exception_key using errcode = 'no_data_found'; end if;
    if p_decision = 'ACCEPT_PROPOSAL' then v_conclusion := pr.conclusion; end if;
  elsif p_proposal_id is not null then
    raise exception '% does not take a proposal', p_decision using errcode = 'check_violation';
  end if;
  if p_decision = 'DECIDE' and not exists (select 1 from research.history_exception_conclusions where kind = e.kind and conclusion = v_conclusion) then
    raise exception 'conclusion % is not one of the conclusions for %', v_conclusion, e.kind using errcode = 'check_violation';
  end if;
  if p_decision = 'REOPEN' and e.status <> 'DECIDED' then raise exception 'only a decided exception is reopened' using errcode = 'check_violation'; end if;
  if p_decision <> 'REOPEN' and e.status = 'DECIDED' then raise exception 'exception % is decided; reopen it first', p_exception_key using errcode = 'check_violation'; end if;
  perform set_config('bai.history_exception_transition', 'on', true);
  insert into research.history_exception_decisions (exception_id, proposal_id, decision, conclusion, rationale, evidence, decided_by)
  values (e.id, case when p_decision in ('ACCEPT_PROPOSAL', 'REJECT_PROPOSAL') then pr.id end, p_decision,
          case when p_decision in ('ACCEPT_PROPOSAL', 'DECIDE') then v_conclusion end, p_rationale, coalesce(p_evidence, '[]'), v_rev)
  returning * into d;
  if pr.id is not null then
    update research.history_exception_proposals set status = case when p_decision = 'ACCEPT_PROPOSAL' then 'ACCEPTED' else 'REJECTED' end::research.proposal_status where id = pr.id;
  end if;
  update research.history_exceptions set status = case p_decision
      when 'ACCEPT_PROPOSAL' then 'DECIDED' when 'DECIDE' then 'DECIDED' when 'NEEDS_MORE_EVIDENCE' then 'NEEDS_EVIDENCE' when 'REOPEN' then 'OPEN'
      else (case when exists (select 1 from research.history_exception_proposals x where x.exception_id = e.id and x.status = 'PROPOSED') then 'PROPOSED' else 'OPEN' end) end::research.history_exception_status
  where id = e.id;
  insert into research.history_exception_events (exception_id, event, actor, detail)
  values (e.id, 'DECIDED', v_rev, jsonb_build_object('decision_id', d.id, 'decision', p_decision, 'conclusion', d.conclusion, 'proposal_id', d.proposal_id));
  perform set_config('bai.history_exception_transition', 'off', true);
  return d;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Boundary
-- ---------------------------------------------------------------------------------------------------------------

alter table research.history_exception_conclusions enable row level security;
alter table research.history_exceptions enable row level security;
alter table research.history_exception_claims enable row level security;
alter table research.history_exception_proposals enable row level security;
alter table research.history_exception_decisions enable row level security;
alter table research.history_exception_events enable row level security;
alter table ingest.historical_releases enable row level security;
select public.apply_public_boundary();
revoke all on all tables in schema research from public, anon, authenticated, service_role;
revoke all on all sequences in schema research from public, anon, authenticated, service_role;
revoke all on all functions in schema research from public, anon, authenticated, service_role;
revoke all on ingest.historical_releases from public, anon, authenticated, service_role;
grant execute on function research.decide_history_exception(text, research.history_exception_decision, text, text, bigint, jsonb) to bai_reviewer;
