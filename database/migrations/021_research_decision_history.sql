-- 021_research_decision_history
-- An append-only history of research judgments, and the rules that keep them honest:
--   * research.decision_history records every fact resolution (first decision, re-decision on new evidence, and
--     reconsideration), every certification and every revocation, and every evidence change that touches a certified
--     class: class(es), affected record, previous and new value and source, who decided, why, related evidence, and the
--     certification impact. Rows are never updated or deleted (trigger), so a judgment is never silently overwritten.
--   * A recorded resolution may change only (a) because new evidence reopened it (its considered observations grow), or
--     (b) through an explicitly authorized reconsideration: session flag bai.reconsideration = 'authorized' (set only by
--     research:reconsider), a registered, active human reviewer as decided_by, and a new reason. Resolutions are never
--     deleted.
--   * Human reviewers are registered in research.reviewers. agent:/rule:/system: names can never be registered, and a
--     certification (research:certify) must be made by a registered, active reviewer: automation cannot certify.
--   * Anyone, including an automated agent, may file a decision PROPOSAL (research.decision_proposals: the claim to
--     choose, the reasoning and the evidence). A proposal decides nothing: only a registered reviewer accepts it (by
--     resolving or reconsidering with --proposal) or rejects it, and the resulting history row names the proposal.
--   * Certifications are immutable except for a one-time revocation. Any decision or applied evidence that changes a
--     record of a certified class revokes that certification (actor system:evidence-changed) and returns the class to
--     COVERAGE_REVIEW; a human must certify again.

-- ---------------------------------------------------------------------------------------------------------------
-- Reviewers
-- ---------------------------------------------------------------------------------------------------------------

create table research.reviewers (
  reviewer text primary key check (reviewer !~ '^(agent:|rule:|system:|bai-)' and length(reviewer) between 2 and 100),
  added_by text not null check (added_by !~ '^(agent|rule|system):'),
  added_at timestamptz not null default now(),
  active boolean not null default true,
  deactivated_at timestamptz,
  note text,
  check (active = (deactivated_at is null))
);

create function research.reviewer_guard() returns trigger
language plpgsql
set search_path = pg_catalog, research
as $$
begin
  if tg_op = 'DELETE' then raise exception 'reviewers are deactivated, never deleted' using errcode = 'check_violation'; end if;
  if new.reviewer <> old.reviewer or new.added_by <> old.added_by or new.added_at <> old.added_at then
    raise exception 'a reviewer registration is immutable (deactivate it instead)' using errcode = 'check_violation';
  end if;
  if not old.active and new.active then raise exception 'a deactivated reviewer is not reactivated; register a new name' using errcode = 'check_violation'; end if;
  return new;
end $$;
create trigger reviewers_guard before update or delete on research.reviewers for each row execute function research.reviewer_guard();

create function research.is_active_reviewer(p_name text) returns boolean
language sql stable
set search_path = pg_catalog, research
as $$ select exists (select 1 from research.reviewers r where r.reviewer = p_name and r.active) $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Decision proposals: prepared by anyone, decided only by a registered human reviewer
-- ---------------------------------------------------------------------------------------------------------------

create type research.proposal_status as enum ('PROPOSED', 'ACCEPTED', 'REJECTED', 'WITHDRAWN');

create table research.decision_proposals (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  subject_table text not null,
  subject_id bigint not null,
  field_name text not null,
  proposed_observation_id bigint not null references public.source_observations (id),
  proposed_value jsonb,
  proposed_by text not null,
  rationale text not null check (length(rationale) > 0),
  evidence jsonb not null default '[]',
  status research.proposal_status not null default 'PROPOSED',
  decided_by text,
  decided_at timestamptz,
  decision_reason text,
  check ((status = 'PROPOSED') = (decided_by is null) and (decided_by is null) = (decided_at is null)),
  check (status not in ('REJECTED', 'WITHDRAWN') or decision_reason is not null)
);
create unique index decision_proposals_one_open on research.decision_proposals (subject_table, subject_id, field_name, proposed_observation_id) where status = 'PROPOSED';

create function research.proposal_guard() returns trigger
language plpgsql
set search_path = pg_catalog, research
as $$
begin
  if tg_op = 'DELETE' then raise exception 'a proposal is withdrawn or rejected, never deleted' using errcode = 'check_violation'; end if;
  if tg_op = 'INSERT' then
    if new.status <> 'PROPOSED' then raise exception 'a proposal starts as PROPOSED' using errcode = 'check_violation'; end if;
    return new;
  end if;
  if (new.subject_table, new.subject_id, new.field_name, new.proposed_observation_id, new.proposed_value, new.proposed_by, new.rationale, new.evidence, new.created_at)
     is distinct from (old.subject_table, old.subject_id, old.field_name, old.proposed_observation_id, old.proposed_value, old.proposed_by, old.rationale, old.evidence, old.created_at) then
    raise exception 'a proposal is immutable; file a new one' using errcode = 'check_violation';
  end if;
  if old.status <> 'PROPOSED' then raise exception 'proposal % is already %', old.id, old.status using errcode = 'check_violation'; end if;
  if new.status in ('ACCEPTED', 'REJECTED') and not research.is_active_reviewer(new.decided_by) then
    raise exception 'only a registered, active human reviewer accepts or rejects a proposal; % is not one', new.decided_by using errcode = 'insufficient_privilege';
  end if;
  if new.status = 'WITHDRAWN' and new.decided_by <> old.proposed_by then
    raise exception 'only the proposer withdraws a proposal' using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;
create trigger decision_proposals_guard before insert or update or delete on research.decision_proposals for each row execute function research.proposal_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- Decision history (append-only)
-- ---------------------------------------------------------------------------------------------------------------

create type research.decision_kind as enum (
  'RESOLVED',                    -- first resolution of a fact conflict
  'RESOLVED_WITH_NEW_EVIDENCE',  -- re-decided because new observations reopened the conflict
  'RECONSIDERED',                -- same evidence, different judgment, through research:reconsider
  'EVIDENCE_CHANGED',            -- an applied batch changed or contested a record of a certified class
  'CERTIFIED',
  'CERTIFICATION_REVOKED'
);
create type research.certification_impact as enum (
  'NONE',                        -- the record belongs to no research class
  'CLASS_NOT_CERTIFIED',         -- it belongs to classes, none certified
  'CERTIFICATION_REVOKED',       -- certified classes lost their certification because of this decision
  'CERTIFIED'                    -- this entry is a certification
);

create table research.decision_history (
  id bigint generated always as identity primary key,
  recorded_at timestamptz not null default now(),
  kind research.decision_kind not null,
  class_ids bigint[] not null default '{}',
  subject_table text,
  subject_id bigint,
  field_name text,
  previous_value jsonb,
  new_value jsonb,
  previous_observation_id bigint references public.source_observations (id),
  new_observation_id bigint references public.source_observations (id),
  previous_source_key text,
  new_source_key text,
  rule public.conflict_rule,
  decided_by text not null,
  reason text,
  evidence jsonb not null default '[]',
  certification_impact research.certification_impact not null,
  revoked_class_ids bigint[] not null default '{}',
  fact_resolution_id bigint references public.fact_resolutions (id),
  certification_id bigint references research.certifications (id),
  import_batch_id bigint references ingest.import_batches (id),
  proposal_id bigint references research.decision_proposals (id),
  check (kind not in ('RESOLVED', 'RESOLVED_WITH_NEW_EVIDENCE', 'RECONSIDERED') or (fact_resolution_id is not null and subject_table is not null and new_observation_id is not null)),
  check (kind <> 'RECONSIDERED' or (previous_observation_id is not null and reason is not null)),
  check (kind not in ('CERTIFIED', 'CERTIFICATION_REVOKED') or certification_id is not null),
  check ((certification_impact = 'CERTIFICATION_REVOKED') = (cardinality(revoked_class_ids) > 0))
);
create index decision_history_subject_idx on research.decision_history (subject_table, subject_id, field_name);
create index decision_history_classes_idx on research.decision_history using gin (class_ids);

create function research.decision_history_append_only() returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  raise exception 'research.decision_history is append-only' using errcode = 'check_violation';
end $$;
create trigger decision_history_no_update before update or delete on research.decision_history for each row execute function research.decision_history_append_only();
create trigger decision_history_no_truncate before truncate on research.decision_history for each statement execute function research.decision_history_append_only();

-- ---------------------------------------------------------------------------------------------------------------
-- Which research classes a canonical record belongs to
-- ---------------------------------------------------------------------------------------------------------------

create function research.classes_of_subject(p_table text, p_id bigint) returns bigint[]
language sql stable
set search_path = pg_catalog, public, research
as $$
  with players as (
    select p_id as player_id where p_table = 'players'
    union select player_id from public.mlb_debuts where p_table = 'mlb_debuts' and id = p_id
    union select player_id from public.war_observations where p_table = 'war_observations' and id = p_id
    union select player_id from public.outcome_audits where p_table = 'outcome_audits' and id = p_id
    union select a.player_id from public.outcome_audit_details d join public.outcome_audits a on a.id = d.outcome_audit_id where p_table = 'outcome_audit_details' and d.id = p_id
    union select a.player_id from public.trade_packages k join public.trade_package_assets a on a.trade_package_id = k.id where p_table = 'transactions' and k.transaction_id = p_id and a.player_id is not null
  ), picks as (
    select draft_id, organization_id from public.draft_selections where p_table = 'draft_selections' and id = p_id
    union select s.draft_id, s.organization_id from public.draft_signings g join public.draft_selections s on s.id = g.draft_selection_id where p_table = 'draft_signings' and g.id = p_id
    union select s.draft_id, s.organization_id from public.slot_values v join public.draft_selections s on s.draft_id = v.draft_id and s.overall_pick = v.overall_pick where p_table = 'slot_values' and v.id = p_id
    union select s.draft_id, s.organization_id from public.draft_selections s join players p on p.player_id = s.player_id
  ), signings as (
    select signing_period_id, organization_id from public.international_signings where p_table = 'international_signings' and id = p_id
    union select i.signing_period_id, i.organization_id from public.international_signings i join players p on p.player_id = i.player_id
  )
  select coalesce(array_agg(c.id order by c.id), '{}') from research.classes c
  where exists (select 1 from picks k where k.draft_id = c.draft_id and k.organization_id = c.organization_id)
     or exists (select 1 from signings s where s.signing_period_id = c.signing_period_id and s.organization_id = c.organization_id)
$$;

-- Revokes the active certifications of the given classes because their evidence changed; returns the revoked class ids.
create function research.revoke_for_evidence_change(p_class_ids bigint[], p_reason text) returns bigint[]
language plpgsql
set search_path = pg_catalog, public, research
as $$
declare
  revoked bigint[];
begin
  with r as (
    update research.certifications set revoked_at = now(), revoked_by = 'system:evidence-changed', revoke_reason = p_reason
    where class_id = any (p_class_ids) and revoked_at is null returning class_id
  ) select coalesce(array_agg(class_id order by class_id), '{}') into revoked from r;
  if cardinality(revoked) > 0 then
    update research.classes set stage = 'COVERAGE_REVIEW' where id = any (revoked) and stage = 'CERTIFIED';
    insert into research.stage_events (class_id, from_stage, to_stage, actor, rationale)
    select id, 'CERTIFIED', 'COVERAGE_REVIEW', 'system:evidence-changed', 'certification revoked: ' || p_reason from research.classes where id = any (revoked);
    update research.jobs set state = 'OPEN', completed_at = null, completion_rationale = null
    where class_id = any (revoked) and category_key = 'COVERAGE_CERTIFICATION' and state = 'DONE';
  end if;
  return revoked;
end $$;

-- Evidence applied by an import batch: for every touched record of a certified class, revoke and record it.
create function research.record_evidence_change(p_tables text[], p_ids bigint[], p_batch_id bigint, p_actor text) returns bigint[]
language plpgsql
set search_path = pg_catalog, public, research
as $$
declare
  i integer;
  classes bigint[];
  certified bigint[];
  revoked bigint[];
  all_revoked bigint[] := '{}';
begin
  for i in 1 .. coalesce(array_length(p_tables, 1), 0) loop
    classes := research.classes_of_subject(p_tables[i], p_ids[i]);
    select coalesce(array_agg(class_id order by class_id), '{}') into certified from research.certifications where class_id = any (classes) and revoked_at is null;
    continue when cardinality(certified) = 0;
    revoked := research.revoke_for_evidence_change(certified, format('import batch %s changed or contested %s#%s', p_batch_id, p_tables[i], p_ids[i]));
    insert into research.decision_history (kind, class_ids, subject_table, subject_id, decided_by, reason, certification_impact, revoked_class_ids, import_batch_id)
    values ('EVIDENCE_CHANGED', classes, p_tables[i], p_ids[i], p_actor, 'applied evidence changed or contested a record of a certified class', 'CERTIFICATION_REVOKED', revoked, p_batch_id);
    all_revoked := all_revoked || revoked;
  end loop;
  return all_revoked;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Fact resolutions: guarded changes, logged decisions
-- ---------------------------------------------------------------------------------------------------------------

create function research.fact_resolution_guard() returns trigger
language plpgsql
set search_path = pg_catalog, public, research
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'a recorded resolution is never deleted (see research.decision_history)' using errcode = 'check_violation';
  end if;
  if new.subject_table <> old.subject_table or new.subject_id <> old.subject_id or new.field_name <> old.field_name then
    raise exception 'the subject of a resolution is immutable' using errcode = 'check_violation';
  end if;
  -- New evidence reopened the conflict: an ordinary re-decision.
  if not (old.considered_observation_ids @> new.considered_observation_ids) then return new; end if;
  -- Same evidence and the same decision: nothing to guard.
  if new.chosen_observation_id = old.chosen_observation_id and new.rule = old.rule and new.decided_by = old.decided_by and new.rationale = old.rationale then return new; end if;
  -- Same evidence, different judgment: a reconsideration.
  if coalesce(current_setting('bai.reconsideration', true), '') <> 'authorized' then
    raise exception 'a recorded resolution of %#%.% can change only through research:reconsider (an authorized human reconsideration)', old.subject_table, old.subject_id, old.field_name
      using errcode = 'insufficient_privilege';
  end if;
  if not research.is_active_reviewer(new.decided_by) then
    raise exception 'reconsideration needs a registered, active human reviewer; % is not one', new.decided_by using errcode = 'insufficient_privilege';
  end if;
  if new.rationale = old.rationale then
    raise exception 'reconsideration needs its own reason' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger fact_resolutions_guard before update or delete on public.fact_resolutions for each row execute function research.fact_resolution_guard();

create function research.log_fact_resolution() returns trigger
language plpgsql
set search_path = pg_catalog, public, research
as $$
declare
  k research.decision_kind;
  prev_v jsonb;
  prev_src text;
  cur_v jsonb;
  cur_src text;
  classes bigint[];
  certified bigint[];
  revoked bigint[] := '{}';
  ev jsonb;
begin
  if tg_op = 'UPDATE' and new.chosen_observation_id = old.chosen_observation_id and new.considered_observation_ids = old.considered_observation_ids
     and new.rule = old.rule and new.decided_by = old.decided_by and new.rationale = old.rationale then
    return null;   -- idempotent re-write: no new judgment, no history row
  end if;
  k := case when tg_op = 'INSERT' then 'RESOLVED'
            when not (old.considered_observation_ids @> new.considered_observation_ids) then 'RESOLVED_WITH_NEW_EVIDENCE'
            else 'RECONSIDERED' end;
  select o.observed_value, s.source_key into cur_v, cur_src from public.source_observations o join public.sources s on s.id = o.source_id where o.id = new.chosen_observation_id;
  if tg_op = 'UPDATE' then
    select o.observed_value, s.source_key into prev_v, prev_src from public.source_observations o join public.sources s on s.id = o.source_id where o.id = old.chosen_observation_id;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('observation_id', o.id, 'source_key', s.source_key, 'authority', s.authority_level, 'value', o.observed_value) order by o.id), '[]')
    into ev from public.source_observations o join public.sources s on s.id = o.source_id where o.id = any (new.considered_observation_ids);
  ev := ev || coalesce(nullif(current_setting('bai.decision_evidence', true), '')::jsonb, '[]'::jsonb);
  classes := research.classes_of_subject(new.subject_table, new.subject_id);
  select coalesce(array_agg(class_id order by class_id), '{}') into certified from research.certifications where class_id = any (classes) and revoked_at is null;
  if cardinality(certified) > 0 then
    revoked := research.revoke_for_evidence_change(certified, format('%s of %s#%s.%s by %s', lower(k::text), new.subject_table, new.subject_id, new.field_name, new.decided_by));
  end if;
  insert into research.decision_history (kind, class_ids, subject_table, subject_id, field_name, previous_value, new_value, previous_observation_id, new_observation_id,
      previous_source_key, new_source_key, rule, decided_by, reason, evidence, certification_impact, revoked_class_ids, fact_resolution_id, proposal_id)
  values (k, classes, new.subject_table, new.subject_id, new.field_name, prev_v, cur_v,
      case when tg_op = 'UPDATE' then old.chosen_observation_id end, new.chosen_observation_id,
      prev_src, cur_src, new.rule, new.decided_by, new.rationale, ev,
      case when cardinality(revoked) > 0 then 'CERTIFICATION_REVOKED' when cardinality(classes) > 0 then 'CLASS_NOT_CERTIFIED' else 'NONE' end::research.certification_impact,
      revoked, new.id, nullif(current_setting('bai.proposal_id', true), '')::bigint);
  return null;
end $$;
create trigger fact_resolutions_log after insert or update on public.fact_resolutions for each row execute function research.log_fact_resolution();

-- ---------------------------------------------------------------------------------------------------------------
-- Certifications: registered human reviewers only; immutable except one revocation; logged
-- ---------------------------------------------------------------------------------------------------------------

create function research.certification_guard() returns trigger
language plpgsql
set search_path = pg_catalog, research
as $$
begin
  if tg_op = 'DELETE' then raise exception 'a certification is revoked, never deleted' using errcode = 'check_violation'; end if;
  if tg_op = 'INSERT' then
    if not research.is_active_reviewer(new.certified_by) then
      raise exception 'certification needs a registered, active human reviewer; % is not one (research:reviewer)', new.certified_by using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;
  if new.class_id <> old.class_id or new.certified_by <> old.certified_by or new.certified_at <> old.certified_at
     or new.coverage_state <> old.coverage_state or new.report <> old.report then
    raise exception 'a certification is immutable' using errcode = 'check_violation';
  end if;
  if old.revoked_at is not null and (new.revoked_at, new.revoked_by, new.revoke_reason) is distinct from (old.revoked_at, old.revoked_by, old.revoke_reason) then
    raise exception 'a revocation is final' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger certifications_guard before insert or update or delete on research.certifications for each row execute function research.certification_guard();

create function research.log_certification() returns trigger
language plpgsql
set search_path = pg_catalog, research
as $$
begin
  if tg_op = 'INSERT' then
    insert into research.decision_history (kind, class_ids, decided_by, reason, evidence, certification_impact, certification_id)
    values ('CERTIFIED', array[new.class_id], new.certified_by, 'research:certify (deterministic check passed)',
            jsonb_build_array(jsonb_build_object('coverage_state', new.coverage_state)), 'CERTIFIED', new.id);
  elsif old.revoked_at is null and new.revoked_at is not null then
    insert into research.decision_history (kind, class_ids, decided_by, reason, certification_impact, revoked_class_ids, certification_id)
    values ('CERTIFICATION_REVOKED', array[new.class_id], new.revoked_by, new.revoke_reason, 'CERTIFICATION_REVOKED', array[new.class_id], new.id);
  end if;
  return null;
end $$;
create trigger certifications_log after insert or update on research.certifications for each row execute function research.log_certification();

-- ---------------------------------------------------------------------------------------------------------------
-- Baseline: the judgments recorded before this migration enter the history once
-- ---------------------------------------------------------------------------------------------------------------

insert into research.decision_history (recorded_at, kind, class_ids, subject_table, subject_id, field_name, new_value, new_observation_id, new_source_key, rule,
    decided_by, reason, evidence, certification_impact, fact_resolution_id)
select f.decided_at, 'RESOLVED', research.classes_of_subject(f.subject_table, f.subject_id), f.subject_table, f.subject_id, f.field_name, o.observed_value, o.id, s.source_key,
       f.rule, f.decided_by, f.rationale || ' [baseline: recorded before migration 021]',
       (select coalesce(jsonb_agg(jsonb_build_object('observation_id', o2.id, 'source_key', s2.source_key, 'value', o2.observed_value) order by o2.id), '[]')
          from public.source_observations o2 join public.sources s2 on s2.id = o2.source_id where o2.id = any (f.considered_observation_ids)),
       case when cardinality(research.classes_of_subject(f.subject_table, f.subject_id)) > 0 then 'CLASS_NOT_CERTIFIED' else 'NONE' end::research.certification_impact, f.id
from public.fact_resolutions f
join public.source_observations o on o.id = f.chosen_observation_id
join public.sources s on s.id = o.source_id
order by f.id;

insert into research.decision_history (recorded_at, kind, class_ids, decided_by, reason, certification_impact, certification_id)
select c.certified_at, 'CERTIFIED', array[c.class_id], c.certified_by, 'research:certify [baseline: recorded before migration 021]', 'CERTIFIED', c.id
from research.certifications c order by c.id;

-- ---------------------------------------------------------------------------------------------------------------
-- Boundary: private like the rest of research
-- ---------------------------------------------------------------------------------------------------------------

alter table research.reviewers enable row level security;
alter table research.decision_history enable row level security;
alter table research.decision_proposals enable row level security;
select public.apply_public_boundary();
revoke all on all tables in schema research from public, anon, authenticated, service_role;
revoke all on all sequences in schema research from public, anon, authenticated, service_role;
revoke all on all functions in schema research from public, anon, authenticated, service_role;
