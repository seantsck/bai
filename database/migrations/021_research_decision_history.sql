-- 021_research_decision_history
-- An append-only history of research judgments, and a human certification boundary bound to authenticated database
-- identity rather than to a name someone types:
--   * research.decision_history records every fact resolution (first decision, re-decision on new evidence,
--     reconsideration, ratification), every certification and revocation, every change of the certification gate, and
--     every evidence change that touches a certified class: class(es), affected record, previous and new value and
--     source, who decided, the authenticated database role of the session (session_user), why, related evidence, and the
--     certification impact. Rows are never updated or deleted (trigger).
--   * A HUMAN REVIEWER is a PostgreSQL login role that a human holds: a member of the group role bai_reviewer, with no
--     administrative attribute, not an automation role (bai_automation), and unable to act as the owner of any BAI
--     object (so it cannot disable a trigger). The human enrolls it by logging in with it (research.enroll_reviewer):
--     research.reviewers binds the display name to that role. A name passed as an argument proves nothing; every
--     human-only action checks research.session_reviewer(), which is derived from session_user. PostgreSQL verifies the
--     credential server-side; SECURITY DEFINER functions keep session_user, so the identity survives them.
--   * Human-only actions are SECURITY DEFINER functions executable only by bai_reviewer: enroll_reviewer,
--     certify_class, reconsider_resolution, accept_proposal, reject_proposal, ratify_resolution,
--     set_certification_gate. The underlying tables refuse the same changes from any other session (triggers), so a
--     direct statement from the owner or an automation session does not get around them.
--   * CERTIFICATION IS DISABLED (research.certification_gate) until the automation no longer holds the database
--     owner's credential: whoever holds the owner/admin credential can create a login role, grant it bai_reviewer, or
--     drop a trigger, and no rule inside the database can tell that apart from a human. docs/decision-history.md lists
--     what has to be in place before a reviewer opens the gate.
--   * Certification certifies a checked state: anyone may record a deterministic certification check
--     (research.certification_checks, with a fingerprint of every record of the class); a reviewer certifies that check
--     only while the class's evidence still has the same fingerprint.
--   * Any change to a record of a certified class revokes the certification in the same transaction (trigger, actor
--     system:evidence-changed) and returns the class to COVERAGE_REVIEW, whoever makes it and however: inserting,
--     changing or deleting an acquisition record (pick, signing, slot, player, coverage claim); changing or deleting a
--     dated outcome record (a new audit, debut, WAR value or trade for a later date adds information and does not);
--     an observation that contradicts another claim about the same field; and any decision on such a field.
--   * Anyone, including an automated agent, may file a decision PROPOSAL. Only a reviewer session accepts or rejects it.
--     Decisions taken by an operator label (not a declared rule, not a reviewer session) stay valid research judgments
--     but block certification until a reviewer ratifies, reconsiders or re-decides them.

-- ---------------------------------------------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'bai_reviewer') then
    create role bai_reviewer nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'bai_automation') then
    create role bai_automation nologin;
  end if;
end $$;
comment on role bai_reviewer is 'BAI: group of human reviewer login roles (021). Membership alone grants nothing until the human enrolls.';
comment on role bai_automation is 'BAI: group of automation login roles (021). A member can never be a reviewer.';

-- Why a role cannot review (null = it can).
create function research.role_review_refusal(p_role name) returns text
language sql stable
set search_path = pg_catalog
as $$
  select case
    when r.oid is null then 'no such role'
    when not r.rolcanlogin then 'not a login role'
    when r.rolsuper or r.rolcreaterole or r.rolcreatedb or r.rolreplication or r.rolbypassrls then 'has an administrative attribute'
    when not pg_has_role(r.oid, 'bai_reviewer', 'MEMBER') then 'not a member of bai_reviewer'
    when pg_has_role(r.oid, 'bai_automation', 'MEMBER') then 'is an automation role (bai_automation)'
    when exists (select 1 from pg_namespace n where n.nspname in ('public', 'research', 'ingest', 'analytics') and pg_has_role(r.oid, n.nspowner, 'MEMBER'))
      then 'can act as the owner of a BAI schema'
    when exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname in ('public', 'research', 'ingest', 'analytics') and pg_has_role(r.oid, c.relowner, 'MEMBER'))
      then 'can act as the owner of a BAI table'
  end
  from (select 1) x left join pg_roles r on r.rolname = p_role
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Reviewers: a display name bound to the login role the human authenticates with
-- ---------------------------------------------------------------------------------------------------------------

create table research.reviewers (
  reviewer text primary key check (reviewer !~ '^(agent:|rule:|system:|bai-)' and length(reviewer) between 2 and 100),
  db_role name not null unique,
  enrolled_at timestamptz not null default now(),
  active boolean not null default true,
  deactivated_at timestamptz,
  deactivated_by name,
  note text,
  check (active = (deactivated_at is null))
);

create function research.reviewer_guard() returns trigger
language plpgsql
set search_path = pg_catalog, research
as $$
declare
  why text;
begin
  if tg_op = 'DELETE' then raise exception 'reviewers are deactivated, never deleted' using errcode = 'check_violation'; end if;
  if tg_op = 'INSERT' then
    -- Only the human, logged in with the role being enrolled, enrolls it.
    if new.db_role <> session_user then
      raise exception 'a reviewer enrolls their own login role (session is %, row names %)', session_user, new.db_role using errcode = 'insufficient_privilege';
    end if;
    why := research.role_review_refusal(session_user);
    if why is not null then
      raise exception 'role % cannot be a reviewer: %', session_user, why using errcode = 'insufficient_privilege';
    end if;
    if not new.active then raise exception 'a reviewer enrolls active' using errcode = 'check_violation'; end if;
    new.enrolled_at := now();
    return new;
  end if;
  if new.reviewer <> old.reviewer or new.db_role <> old.db_role or new.enrolled_at <> old.enrolled_at then
    raise exception 'a reviewer registration is immutable (deactivate it instead)' using errcode = 'check_violation';
  end if;
  if not old.active and new.active then raise exception 'a deactivated reviewer is not reactivated; enroll again under a new name' using errcode = 'check_violation'; end if;
  if old.active and not new.active then new.deactivated_by := session_user; end if;   -- deactivating removes power: anyone may
  return new;
end $$;
create trigger reviewers_guard before insert or update or delete on research.reviewers for each row execute function research.reviewer_guard();

-- The reviewer this session authenticated as, or null. The only source of human identity in BAI.
create function research.session_reviewer() returns text
language sql stable
set search_path = pg_catalog, research
as $$
  select r.reviewer from research.reviewers r
  where r.db_role = session_user and r.active and research.role_review_refusal(session_user) is null
$$;

-- Informational (listing, messages): whether a display name is an enrolled, active reviewer. Never an authorization.
create function research.is_active_reviewer(p_name text) returns boolean
language sql stable
set search_path = pg_catalog, research
as $$ select exists (select 1 from research.reviewers r where r.reviewer = p_name and r.active) $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Decision proposals: prepared by anyone, decided only by a reviewer session
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
  proposed_session_role name not null default session_user,
  rationale text not null check (length(rationale) > 0),
  evidence jsonb not null default '[]',
  status research.proposal_status not null default 'PROPOSED',
  decided_by text,
  decided_session_role name,
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
    new.proposed_session_role := session_user;
    return new;
  end if;
  if (new.subject_table, new.subject_id, new.field_name, new.proposed_observation_id, new.proposed_value, new.proposed_by, new.proposed_session_role, new.rationale, new.evidence, new.created_at)
     is distinct from (old.subject_table, old.subject_id, old.field_name, old.proposed_observation_id, old.proposed_value, old.proposed_by, old.proposed_session_role, old.rationale, old.evidence, old.created_at) then
    raise exception 'a proposal is immutable; file a new one' using errcode = 'check_violation';
  end if;
  if old.status <> 'PROPOSED' then raise exception 'proposal % is already %', old.id, old.status using errcode = 'check_violation'; end if;
  if new.status in ('ACCEPTED', 'REJECTED') and (research.session_reviewer() is null or new.decided_by is distinct from research.session_reviewer()) then
    raise exception 'only an enrolled human reviewer, in their own authenticated session, accepts or rejects a proposal (session %)', session_user using errcode = 'insufficient_privilege';
  end if;
  if new.status = 'WITHDRAWN' and new.decided_by <> old.proposed_by then
    raise exception 'only the proposer withdraws a proposal' using errcode = 'insufficient_privilege';
  end if;
  new.decided_session_role := session_user;
  return new;
end $$;
create trigger decision_proposals_guard before insert or update or delete on research.decision_proposals for each row execute function research.proposal_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- Certification gate and certification checks
-- ---------------------------------------------------------------------------------------------------------------

create table research.certification_gate (
  id boolean primary key default true check (id),
  enabled boolean not null,
  changed_at timestamptz not null default now(),
  changed_by text not null,
  changed_session_role name not null default session_user,
  reason text not null check (length(reason) > 0)
);
insert into research.certification_gate (enabled, changed_by, reason)
values (false, 'system:migration-021', 'Certification disabled: the research automation still holds the database owner credential, so reviewer identity is not yet robust (docs/decision-history.md#what-remains-before-certification).');

create function research.certification_enabled() returns boolean
language sql stable
set search_path = pg_catalog, research
as $$ select coalesce((select enabled from research.certification_gate), false) $$;

create table research.certification_checks (
  id bigint generated always as identity primary key,
  class_id bigint not null references research.classes (id),
  checked_at timestamptz not null default now(),
  checked_by text not null,
  checked_session_role name not null default session_user,
  passed boolean not null,
  coverage_state public.coverage_state,
  blockers jsonb not null default '[]',
  report jsonb not null,
  fingerprint text not null,
  check (not passed or (coverage_state is not null and blockers = '[]'::jsonb))
);

alter table research.certifications add column certification_check_id bigint references research.certification_checks (id);

-- ---------------------------------------------------------------------------------------------------------------
-- Decision history (append-only)
-- ---------------------------------------------------------------------------------------------------------------

create type research.decision_kind as enum (
  'RESOLVED',                    -- first resolution of a fact conflict
  'RESOLVED_WITH_NEW_EVIDENCE',  -- re-decided because new observations reopened the conflict
  'RECONSIDERED',                -- same evidence, different judgment, by a reviewer session
  'RATIFIED',                    -- a reviewer session confirmed a decision taken without one (unchanged)
  'EVIDENCE_CHANGED',            -- a change touched a record of a certified class
  'CERTIFIED',
  'CERTIFICATION_REVOKED',
  'CERTIFICATION_GATE_CHANGED'
);
create type research.certification_impact as enum (
  'NONE',                        -- the record belongs to no research class
  'CLASS_NOT_CERTIFIED',         -- it belongs to classes, none certified
  'CERTIFICATION_REVOKED',       -- certified classes lost their certification because of this entry
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
  session_role name not null default session_user,     -- the authenticated database role that made the change
  reviewer_session boolean not null default false,     -- decided_by was the reviewer this session authenticated as
  reason text,
  evidence jsonb not null default '[]',
  certification_impact research.certification_impact not null,
  revoked_class_ids bigint[] not null default '{}',
  fact_resolution_id bigint references public.fact_resolutions (id),
  certification_id bigint references research.certifications (id),
  import_batch_id bigint references ingest.import_batches (id),
  proposal_id bigint references research.decision_proposals (id),
  check (kind not in ('RESOLVED', 'RESOLVED_WITH_NEW_EVIDENCE', 'RECONSIDERED', 'RATIFIED') or (fact_resolution_id is not null and subject_table is not null and new_observation_id is not null)),
  check (kind not in ('RECONSIDERED', 'RATIFIED') or (reason is not null and reviewer_session)),
  check (kind <> 'RECONSIDERED' or previous_observation_id is not null),
  check (kind not in ('CERTIFIED', 'CERTIFICATION_REVOKED') or certification_id is not null),
  check (kind <> 'CERTIFIED' or reviewer_session),
  check (kind <> 'CERTIFICATION_GATE_CHANGED' or reason is not null),
  check ((certification_impact = 'CERTIFICATION_REVOKED') = (cardinality(revoked_class_ids) > 0))
);
create index decision_history_subject_idx on research.decision_history (subject_table, subject_id, field_name);
create index decision_history_classes_idx on research.decision_history using gin (class_ids);
create index decision_history_resolution_idx on research.decision_history (fact_resolution_id);

create function research.decision_history_append_only() returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  raise exception '% is append-only', tg_table_schema || '.' || tg_table_name using errcode = 'check_violation';
end $$;
create trigger decision_history_no_update before update or delete on research.decision_history for each row execute function research.decision_history_append_only();
create trigger decision_history_no_truncate before truncate on research.decision_history for each statement execute function research.decision_history_append_only();
create trigger certification_checks_no_update before update or delete on research.certification_checks for each row execute function research.decision_history_append_only();
create trigger certification_checks_no_truncate before truncate on research.certification_checks for each statement execute function research.decision_history_append_only();

-- The gate: opening it is a reviewer-session decision; closing it removes power, so anyone may. Never deleted; logged.
create function research.certification_gate_guard() returns trigger
language plpgsql
set search_path = pg_catalog, research
as $$
begin
  if tg_op in ('DELETE', 'INSERT') then raise exception 'the certification gate has exactly one row, changed only by update' using errcode = 'check_violation'; end if;
  if new.enabled and not old.enabled and (research.session_reviewer() is null or new.changed_by is distinct from research.session_reviewer()) then
    raise exception 'only an enrolled human reviewer, in their own authenticated session, enables certification (session %)', session_user using errcode = 'insufficient_privilege';
  end if;
  new.changed_at := now();
  new.changed_session_role := session_user;
  insert into research.decision_history (kind, decided_by, reviewer_session, reason, evidence, certification_impact)
  values ('CERTIFICATION_GATE_CHANGED', new.changed_by, new.changed_by is not distinct from research.session_reviewer(), new.reason,
          jsonb_build_array(jsonb_build_object('enabled', new.enabled, 'was', old.enabled)), 'NONE');
  return new;
end $$;
create trigger certification_gate_guard before insert or update or delete on research.certification_gate for each row execute function research.certification_gate_guard();
create trigger certification_gate_no_truncate before truncate on research.certification_gate for each statement execute function research.decision_history_append_only();

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
    union select a.player_id from public.trade_package_assets a where p_table = 'trade_packages' and a.trade_package_id = p_id and a.player_id is not null
    union select a.player_id from public.trade_package_assets a where p_table = 'trade_package_assets' and a.id = p_id and a.player_id is not null
  ), picks as (
    select draft_id, organization_id from public.draft_selections where p_table = 'draft_selections' and id = p_id
    union select s.draft_id, s.organization_id from public.draft_signings g join public.draft_selections s on s.id = g.draft_selection_id where p_table = 'draft_signings' and g.id = p_id
    union select s.draft_id, s.organization_id from public.slot_values v join public.draft_selections s on s.draft_id = v.draft_id and s.overall_pick = v.overall_pick where p_table = 'slot_values' and v.id = p_id
    union select s.draft_id, s.organization_id from public.draft_selections s join players p on p.player_id = s.player_id
  ), signings as (
    select signing_period_id, organization_id from public.international_signings where p_table = 'international_signings' and id = p_id
    union select i.signing_period_id, i.organization_id from public.international_signings i join players p on p.player_id = i.player_id
  ), assessed as (
    select domain::text as channel_key, scope_key, organization_id from public.coverage_assessments where p_table = 'coverage_assessments' and id = p_id
  )
  select coalesce(array_agg(c.id order by c.id), '{}') from research.classes c
  where exists (select 1 from picks k where k.draft_id = c.draft_id and k.organization_id = c.organization_id)
     or exists (select 1 from signings s where s.signing_period_id = c.signing_period_id and s.organization_id = c.organization_id)
     or exists (select 1 from assessed a where a.channel_key = c.channel_key and a.scope_key = c.scope_key and a.organization_id = c.organization_id)
$$;

-- A fingerprint of everything a certification vouches for: every record of the class, its players' outcome records,
-- every observation about them and every resolution. Any write to any of them changes it.
create function research.class_fingerprint(p_class_id bigint) returns text
language sql stable
set search_path = pg_catalog, public, research
as $$
  with c as (select * from research.classes where id = p_class_id),
  sel as (select s.* from public.draft_selections s join c on s.draft_id = c.draft_id and s.organization_id = c.organization_id),
  intl as (select i.* from public.international_signings i join c on i.signing_period_id = c.signing_period_id and i.organization_id = c.organization_id),
  pl as (select player_id from sel union select player_id from intl),
  parts as (
    select 'draft_selections' t, s.id, md5(s::text) h from sel s
    union all select 'draft_signings', g.id, md5(g::text) from public.draft_signings g join sel s on s.id = g.draft_selection_id
    union all select 'slot_values', v.id, md5(v::text) from public.slot_values v join sel s on s.draft_id = v.draft_id and s.overall_pick = v.overall_pick
    union all select 'international_signings', i.id, md5(i::text) from intl i
    union all select 'players', p.id, md5(p::text) from public.players p join pl on pl.player_id = p.id
    union all select 'outcome_audits', a.id, md5(a::text) from public.outcome_audits a join pl on pl.player_id = a.player_id
    union all select 'outcome_audit_details', d.id, md5(d::text) from public.outcome_audit_details d join public.outcome_audits a on a.id = d.outcome_audit_id join pl on pl.player_id = a.player_id
    union all select 'mlb_debuts', m.id, md5(m::text) from public.mlb_debuts m join pl on pl.player_id = m.player_id
    union all select 'war_observations', w.id, md5(w::text) from public.war_observations w join pl on pl.player_id = w.player_id
    union all select 'coverage_assessments', ca.id, md5(ca::text) from public.coverage_assessments ca join c on ca.organization_id = c.organization_id and ca.domain::text = c.channel_key and ca.scope_key = c.scope_key
  ),
  obs as (select 'source_observations' t, o.id, md5(o::text) h from public.source_observations o join parts p on p.t = o.subject_table and p.id = o.subject_id),
  res as (select 'fact_resolutions' t, f.id, md5(f::text) h from public.fact_resolutions f join parts p on p.t = f.subject_table and p.id = f.subject_id)
  select md5(coalesce(string_agg(t || ':' || id || ':' || h, ',' order by t, id), '')) from (select * from parts union all select * from obs union all select * from res) x
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

-- Any write to a record of a certified class, from any session and by any path, revokes it in the same transaction.
-- BEFORE UPDATE/DELETE sees the record's old classes, AFTER INSERT/UPDATE its new ones. Import batches set
-- bai.import_batch_id and bai.actor so the history names them.
create function research.on_evidence_change() returns trigger
language plpgsql
set search_path = pg_catalog, public, research
as $$
declare
  rec record;
  v_table text;
  v_id bigint;
  v_field text;
  classes bigint[];
  certified bigint[];
  revoked bigint[];
begin
  if not exists (select 1 from research.certifications where revoked_at is null) then
    return case when tg_when = 'BEFORE' then coalesce(new, old) end;
  end if;
  -- Dated outcome facts (audits, debuts, WAR, trades) accumulate season after season: a NEW row adds information as of
  -- a later date and changes nothing certified. Changing or deleting one does revoke.
  if tg_op = 'INSERT' and tg_table_name in ('outcome_audits', 'outcome_audit_details', 'mlb_debuts', 'war_observations', 'acquisition_dispositions',
                                            'transactions', 'trade_packages', 'trade_package_assets') then
    return null;
  end if;
  -- A new observation revokes only when it contradicts another active claim about the same field (corroboration does not).
  if tg_op = 'INSERT' and tg_table_name = 'source_observations' then
    rec := new;    -- (fields of NEW are read only on this table)
    if not exists (select 1 from public.source_observations o where o.subject_table = rec.subject_table and o.subject_id = rec.subject_id
                   and o.field_name = rec.field_name and o.id <> rec.id and o.status = 'ACTIVE' and o.observed_value is distinct from rec.observed_value) then
      return null;
    end if;
  end if;
  if tg_when = 'BEFORE' then rec := old; else rec := new; end if;
  if tg_table_name = 'source_observations' then
    v_table := rec.subject_table; v_id := rec.subject_id; v_field := rec.field_name;
  else
    v_table := tg_table_name; v_id := rec.id;
  end if;
  classes := research.classes_of_subject(v_table, v_id);
  select coalesce(array_agg(class_id order by class_id), '{}') into certified from research.certifications where class_id = any (classes) and revoked_at is null;
  if cardinality(certified) > 0 then
    revoked := research.revoke_for_evidence_change(certified, format('%s on %s#%s%s by %s', lower(tg_op), v_table, v_id,
      case when tg_table_name = 'source_observations' then ' (observation ' || rec.id || ')' else '' end, session_user));
    insert into research.decision_history (kind, class_ids, subject_table, subject_id, field_name, decided_by, reason, certification_impact, revoked_class_ids, import_batch_id)
    values ('EVIDENCE_CHANGED', classes, v_table, v_id, v_field,
            coalesce(nullif(current_setting('bai.actor', true), ''), 'system:evidence-changed'),
            format('%s on %s changed or contested a record of a certified class', lower(tg_op), tg_table_name), 'CERTIFICATION_REVOKED', revoked,
            nullif(current_setting('bai.import_batch_id', true), '')::bigint);
  end if;
  return case when tg_when = 'BEFORE' then coalesce(new, old) end;
end $$;

do $$
declare
  t text;
begin
  foreach t in array array['players', 'draft_selections', 'draft_signings', 'slot_values', 'international_signings', 'outcome_audits', 'outcome_audit_details',
                           'mlb_debuts', 'war_observations', 'transactions', 'trade_packages', 'trade_package_assets', 'coverage_assessments', 'source_observations'] loop
    execute format('create trigger %I before update or delete on public.%I for each row execute function research.on_evidence_change()', t || '_evidence_before', t);
    execute format('create trigger %I after insert or update on public.%I for each row execute function research.on_evidence_change()', t || '_evidence_after', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Fact resolutions: guarded changes, logged decisions
-- ---------------------------------------------------------------------------------------------------------------

-- Columns a decision may set directly (the rest are evidence-only: a decision may only confirm the row's own citation).
create table research.resolvable_columns (
  table_name text not null,
  column_name text not null,
  primary key (table_name, column_name)
);
insert into research.resolvable_columns values
  ('players', 'birth_date'), ('players', 'birth_country'), ('players', 'primary_position'),
  ('draft_selections', 'position'), ('draft_selections', 'round_pick'),
  ('draft_signings', 'signing_status'), ('draft_signings', 'signing_bonus_usd'), ('draft_signings', 'signing_date'),
  ('international_signings', 'signing_date'), ('international_signings', 'signing_bonus_usd'), ('international_signings', 'posting_fee_usd'),
  ('international_signings', 'transfer_fee_usd'), ('international_signings', 'other_cost_usd'), ('international_signings', 'pathway'),
  ('slot_values', 'slot_value_usd'), ('mlb_debuts', 'debut_date'), ('war_observations', 'war_value'),
  ('drafts', 'start_date'), ('drafts', 'end_date'), ('drafts', 'total_rounds');

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
  -- Same evidence, different judgment: a reconsideration, by the reviewer this session authenticated as, explicitly.
  if coalesce(current_setting('bai.reconsideration', true), '') <> 'authorized' then
    raise exception 'a recorded resolution of %#%.% can change only through research:reconsider (an authorized human reconsideration)', old.subject_table, old.subject_id, old.field_name
      using errcode = 'insufficient_privilege';
  end if;
  if research.session_reviewer() is null or new.decided_by is distinct from research.session_reviewer() then
    raise exception 'reconsideration needs an enrolled human reviewer in their own authenticated session (session %, decided_by %)', session_user, new.decided_by using errcode = 'insufficient_privilege';
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
      previous_source_key, new_source_key, rule, decided_by, reviewer_session, reason, evidence, certification_impact, revoked_class_ids, fact_resolution_id, proposal_id)
  values (k, classes, new.subject_table, new.subject_id, new.field_name, prev_v, cur_v,
      case when tg_op = 'UPDATE' then old.chosen_observation_id end, new.chosen_observation_id,
      prev_src, cur_src, new.rule, new.decided_by, new.decided_by is not distinct from research.session_reviewer(), new.rationale, ev,
      case when cardinality(revoked) > 0 then 'CERTIFICATION_REVOKED' when cardinality(classes) > 0 then 'CLASS_NOT_CERTIFIED' else 'NONE' end::research.certification_impact,
      revoked, new.id, nullif(current_setting('bai.proposal_id', true), '')::bigint);
  return null;
end $$;
create trigger fact_resolutions_log after insert or update on public.fact_resolutions for each row execute function research.log_fact_resolution();

-- Decisions on a class's records that no reviewer session took or confirmed: operator-label choices (rule
-- REQUIRE_OPERATOR) whose latest judgment in the history is not by a reviewer session. They block certification.
create function research.unratified_decisions(p_class_id bigint) returns table (fact_resolution_id bigint, subject_table text, subject_id bigint, field_name text, decided_by text)
language sql stable
set search_path = pg_catalog, public, research
as $$
  select f.id, f.subject_table, f.subject_id, f.field_name, f.decided_by
  from public.fact_resolutions f
  where f.rule = 'REQUIRE_OPERATOR'
    and p_class_id = any (research.classes_of_subject(f.subject_table, f.subject_id))
    and not coalesce((select h.reviewer_session from research.decision_history h
                      where h.fact_resolution_id = f.id and h.kind in ('RESOLVED', 'RESOLVED_WITH_NEW_EVIDENCE', 'RECONSIDERED', 'RATIFIED')
                      order by h.id desc limit 1), false)
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Certifications: only through research.certify_class in a reviewer session; immutable except one revocation; logged
-- ---------------------------------------------------------------------------------------------------------------

create function research.certification_guard() returns trigger
language plpgsql
set search_path = pg_catalog, research
as $$
begin
  if tg_op = 'DELETE' then raise exception 'a certification is revoked, never deleted' using errcode = 'check_violation'; end if;
  if tg_op = 'INSERT' then
    if not research.certification_enabled() then
      raise exception 'certification is disabled (research.certification_gate): reviewer identity is not yet robust against the credentials the automation holds' using errcode = 'insufficient_privilege';
    end if;
    if research.session_reviewer() is null or new.certified_by is distinct from research.session_reviewer() then
      raise exception 'certification needs an enrolled human reviewer in their own authenticated session (session %, certified_by %)', session_user, new.certified_by using errcode = 'insufficient_privilege';
    end if;
    if new.certification_check_id is null then
      raise exception 'a certification certifies a recorded check (research.certify_class)' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if new.class_id <> old.class_id or new.certified_by <> old.certified_by or new.certified_at <> old.certified_at
     or new.coverage_state <> old.coverage_state or new.report <> old.report or new.certification_check_id is distinct from old.certification_check_id then
    raise exception 'a certification is immutable' using errcode = 'check_violation';
  end if;
  if old.revoked_at is not null and (new.revoked_at, new.revoked_by, new.revoke_reason) is distinct from (old.revoked_at, old.revoked_by, old.revoke_reason) then
    raise exception 'a revocation is final' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger certifications_guard before insert or update or delete on research.certifications for each row execute function research.certification_guard();
create trigger certifications_no_truncate before truncate on research.certifications for each statement execute function research.decision_history_append_only();

create function research.log_certification() returns trigger
language plpgsql
set search_path = pg_catalog, research
as $$
begin
  if tg_op = 'INSERT' then
    insert into research.decision_history (kind, class_ids, decided_by, reviewer_session, reason, evidence, certification_impact, certification_id)
    values ('CERTIFIED', array[new.class_id], new.certified_by, true, 'research:certify (deterministic check ' || new.certification_check_id || ' passed; fingerprint unchanged)',
            jsonb_build_array(jsonb_build_object('coverage_state', new.coverage_state, 'certification_check_id', new.certification_check_id)), 'CERTIFIED', new.id);
  elsif old.revoked_at is null and new.revoked_at is not null then
    insert into research.decision_history (kind, class_ids, decided_by, reviewer_session, reason, certification_impact, revoked_class_ids, certification_id)
    values ('CERTIFICATION_REVOKED', array[new.class_id], new.revoked_by, new.revoked_by is not distinct from research.session_reviewer(), new.revoke_reason, 'CERTIFICATION_REVOKED', array[new.class_id], new.id);
  end if;
  return null;
end $$;
create trigger certifications_log after insert or update on research.certifications for each row execute function research.log_certification();

-- ---------------------------------------------------------------------------------------------------------------
-- Human-only actions (SECURITY DEFINER, executable only by bai_reviewer; identity = session_user)
-- ---------------------------------------------------------------------------------------------------------------

create function research.require_reviewer() returns text
language plpgsql stable
set search_path = pg_catalog, research
as $$
declare
  v text := research.session_reviewer();
begin
  if v is null then
    raise exception 'session % is not an enrolled, active human reviewer (%)', session_user,
      coalesce(research.role_review_refusal(session_user), 'not enrolled: research.enroll_reviewer') using errcode = 'insufficient_privilege';
  end if;
  return v;
end $$;

create function research.enroll_reviewer(p_reviewer text, p_note text default null) returns research.reviewers
language plpgsql security definer
set search_path = pg_catalog, research
as $$
declare
  r research.reviewers;
begin
  insert into research.reviewers (reviewer, db_role, note) values (p_reviewer, session_user, p_note) returning * into r;
  return r;
end $$;

create function research.set_certification_gate(p_enabled boolean, p_reason text) returns research.certification_gate
language plpgsql security definer
set search_path = pg_catalog, research
as $$
declare
  g research.certification_gate;
begin
  update research.certification_gate set enabled = p_enabled, changed_by = research.require_reviewer(), reason = p_reason returning * into g;
  return g;
end $$;

-- Sets a resolvable canonical column to an observation's value; returns {from, to} when it changed, else null.
create function research.apply_observation_to_column(p_table text, p_id bigint, p_field text, p_observation_id bigint) returns jsonb
language plpgsql
set search_path = pg_catalog, public, research
as $$
declare
  v_type text;
  v_value jsonb;
  v_before text;
  v_extra text := '';
  n integer;
begin
  if not exists (select 1 from research.resolvable_columns where table_name = p_table and column_name = p_field) then
    raise exception '%.% is not a directly resolvable column', p_table, p_field using errcode = 'check_violation';
  end if;
  select format_type(a.atttypid, a.atttypmod) into v_type from pg_attribute a
  where a.attrelid = format('public.%I', p_table)::regclass and a.attname = p_field and not a.attisdropped;
  select observed_value into v_value from public.source_observations where id = p_observation_id;
  if p_field like '%\_date' and exists (select 1 from pg_attribute a where a.attrelid = format('public.%I', p_table)::regclass and a.attname = p_field || '_precision' and not a.attisdropped) then
    v_extra := format(', %I = coalesce(%I, ''DAY'')', p_field || '_precision', p_field || '_precision');
  end if;
  execute format('select %I::text from public.%I where id = $1', p_field, p_table) into v_before using p_id;
  execute format('update public.%I set %I = ($2 #>> ''{}'')::%s%s where id = $1 and %I is distinct from ($2 #>> ''{}'')::%s', p_table, p_field, v_type, v_extra, p_field, v_type)
    using p_id, v_value;
  get diagnostics n = row_count;
  return case when n > 0 then jsonb_build_object('from', v_before, 'to', v_value) end;
end $$;

create function research.check_proposal(p_proposal_id bigint, p_table text, p_id bigint, p_field text, p_observation_id bigint) returns void
language plpgsql
set search_path = pg_catalog, research
as $$
declare
  pr research.decision_proposals;
begin
  select * into pr from research.decision_proposals where id = p_proposal_id;
  if not found then raise exception 'proposal % not found', p_proposal_id using errcode = 'no_data_found'; end if;
  if pr.status <> 'PROPOSED' then raise exception 'proposal % is %', p_proposal_id, pr.status using errcode = 'check_violation'; end if;
  if (pr.subject_table, pr.subject_id, pr.field_name, pr.proposed_observation_id) is distinct from (p_table, p_id, p_field, p_observation_id) then
    raise exception 'proposal % proposes observation % for %#%.%; the decision must match it', p_proposal_id, pr.proposed_observation_id, pr.subject_table, pr.subject_id, pr.field_name
      using errcode = 'check_violation';
  end if;
end $$;

-- Same evidence, a different judgment. The resolution changes first, so its history row carries the revocation.
create function research.reconsider_resolution(p_table text, p_id bigint, p_field text, p_observation_id bigint, p_reason text,
                                               p_evidence jsonb default '[]', p_proposal_id bigint default null) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, research
as $$
declare
  v_rev text := research.require_reviewer();
  res public.fact_resolutions;
  upd jsonb;
  hist research.decision_history;
begin
  if coalesce(btrim(p_reason), '') = '' then raise exception 'reconsideration needs a reason' using errcode = 'check_violation'; end if;
  select * into res from public.fact_resolutions where subject_table = p_table and subject_id = p_id and field_name = p_field for update;
  if not found then raise exception 'no recorded resolution on %#%.% (an open conflict is decided with research.accept_proposal or research:resolve)', p_table, p_id, p_field using errcode = 'no_data_found'; end if;
  if not exists (select 1 from public.source_observations o where o.id = p_observation_id and o.subject_table = p_table and o.subject_id = p_id and o.field_name = p_field and o.status = 'ACTIVE') then
    raise exception 'observation % is not an active claim on %#%.%', p_observation_id, p_table, p_id, p_field using errcode = 'check_violation';
  end if;
  if not (p_observation_id = any (res.considered_observation_ids)) then
    raise exception 'that observation was not part of the recorded decision; new evidence reopens the conflict instead' using errcode = 'check_violation';
  end if;
  if p_proposal_id is not null then perform research.check_proposal(p_proposal_id, p_table, p_id, p_field, p_observation_id); end if;
  if res.chosen_observation_id = p_observation_id then return jsonb_build_object('unchanged', true, 'reviewer', v_rev); end if;
  if not exists (select 1 from research.resolvable_columns where table_name = p_table and column_name = p_field) then
    raise exception '%.% is not a directly resolvable column', p_table, p_field using errcode = 'check_violation';
  end if;
  perform set_config('bai.reconsideration', 'authorized', true), set_config('bai.actor', v_rev, true),
          set_config('bai.decision_evidence', coalesce(p_evidence, '[]')::text, true), set_config('bai.proposal_id', coalesce(p_proposal_id::text, ''), true);
  update public.fact_resolutions set chosen_observation_id = p_observation_id, rule = 'REQUIRE_OPERATOR', decided_by = v_rev, rationale = p_reason, decided_at = now() where id = res.id;
  upd := research.apply_observation_to_column(p_table, p_id, p_field, p_observation_id);
  if p_proposal_id is not null then
    update research.decision_proposals set status = 'ACCEPTED', decided_by = v_rev, decided_at = now(), decision_reason = p_reason where id = p_proposal_id;
  end if;
  perform set_config('bai.reconsideration', '', true), set_config('bai.proposal_id', '', true), set_config('bai.decision_evidence', '', true);
  select * into hist from research.decision_history where fact_resolution_id = res.id order by id desc limit 1;
  return jsonb_build_object('reviewer', v_rev, 'canonical_update', upd, 'history_id', hist.id, 'kind', hist.kind, 'certification_impact', hist.certification_impact, 'revoked_class_ids', to_jsonb(hist.revoked_class_ids));
end $$;

-- Accepts a proposal: decides the open conflict it names (or re-decides one reopened by new evidence), or reconsiders a
-- recorded decision. The reviewer is the session's.
create function research.accept_proposal(p_proposal_id bigint, p_reason text, p_evidence jsonb default '[]') returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, research
as $$
declare
  v_rev text := research.require_reviewer();
  pr research.decision_proposals;
  conflict record;
  v_row_src bigint;
  upd jsonb;
  v_res bigint;
  hist research.decision_history;
begin
  if coalesce(btrim(p_reason), '') = '' then raise exception 'accepting a proposal needs a reason' using errcode = 'check_violation'; end if;
  select * into pr from research.decision_proposals where id = p_proposal_id for update;
  if not found then raise exception 'proposal % not found', p_proposal_id using errcode = 'no_data_found'; end if;
  perform research.check_proposal(p_proposal_id, pr.subject_table, pr.subject_id, pr.field_name, pr.proposed_observation_id);
  select * into conflict from public.v_open_fact_conflicts c where c.subject_table = pr.subject_table and c.subject_id = pr.subject_id and c.field_name = pr.field_name;
  if not found then
    return research.reconsider_resolution(pr.subject_table, pr.subject_id, pr.field_name, pr.proposed_observation_id, p_reason, p_evidence, p_proposal_id);
  end if;
  if not (pr.proposed_observation_id = any (conflict.observation_ids)) then
    raise exception 'proposal % names an observation outside the open conflict', p_proposal_id using errcode = 'check_violation';
  end if;
  perform set_config('bai.actor', v_rev, true), set_config('bai.decision_evidence', coalesce(p_evidence, '[]')::text, true), set_config('bai.proposal_id', p_proposal_id::text, true);
  insert into public.fact_resolutions (subject_table, subject_id, field_name, chosen_observation_id, considered_observation_ids, rule, decided_by, rationale)
  values (pr.subject_table, pr.subject_id, pr.field_name, pr.proposed_observation_id, conflict.observation_ids, 'REQUIRE_OPERATOR', v_rev, p_reason)
  on conflict (subject_table, subject_id, field_name) do update set chosen_observation_id = excluded.chosen_observation_id,
    considered_observation_ids = excluded.considered_observation_ids, rule = excluded.rule, decided_by = excluded.decided_by, rationale = excluded.rationale, decided_at = now()
  returning id into v_res;
  if exists (select 1 from research.resolvable_columns where table_name = pr.subject_table and column_name = pr.field_name) then
    upd := research.apply_observation_to_column(pr.subject_table, pr.subject_id, pr.field_name, pr.proposed_observation_id);
  else
    -- Evidence-only field: the decision may only confirm the value the row's own citation gives.
    execute format('select source_id from public.%I where id = $1', pr.subject_table) into v_row_src using pr.subject_id;
    if not exists (select 1 from public.source_observations o where o.id = any (conflict.observation_ids) and o.source_id = v_row_src and o.observed_value = pr.proposed_value) then
      raise exception '% is not a directly resolvable column; choosing a value other than the canonical one needs a corrective batch', pr.field_name using errcode = 'check_violation';
    end if;
  end if;
  update research.decision_proposals set status = 'ACCEPTED', decided_by = v_rev, decided_at = now(), decision_reason = p_reason where id = p_proposal_id;
  perform set_config('bai.proposal_id', '', true), set_config('bai.decision_evidence', '', true);
  select * into hist from research.decision_history where fact_resolution_id = v_res order by id desc limit 1;
  return jsonb_build_object('reviewer', v_rev, 'canonical_update', upd, 'history_id', hist.id, 'kind', hist.kind, 'certification_impact', hist.certification_impact, 'revoked_class_ids', to_jsonb(hist.revoked_class_ids));
end $$;

create function research.reject_proposal(p_proposal_id bigint, p_reason text) returns research.decision_proposals
language plpgsql security definer
set search_path = pg_catalog, research
as $$
declare
  v_rev text := research.require_reviewer();
  pr research.decision_proposals;
begin
  update research.decision_proposals set status = 'REJECTED', decided_by = v_rev, decided_at = now(), decision_reason = p_reason
  where id = p_proposal_id and status = 'PROPOSED' returning * into pr;
  if not found then raise exception 'proposal % not found or not open', p_proposal_id using errcode = 'no_data_found'; end if;
  return pr;
end $$;

-- Confirms, unchanged, a decision taken without a reviewer session (an operator label). Recorded; never changes a value.
create function research.ratify_resolution(p_resolution_id bigint, p_reason text, p_evidence jsonb default '[]') returns research.decision_history
language plpgsql security definer
set search_path = pg_catalog, public, research
as $$
declare
  v_rev text := research.require_reviewer();
  f public.fact_resolutions;
  h research.decision_history;
begin
  if coalesce(btrim(p_reason), '') = '' then raise exception 'ratification needs a reason' using errcode = 'check_violation'; end if;
  select * into f from public.fact_resolutions where id = p_resolution_id;
  if not found then raise exception 'resolution % not found', p_resolution_id using errcode = 'no_data_found'; end if;
  if exists (select 1 from public.v_open_fact_conflicts c where c.subject_table = f.subject_table and c.subject_id = f.subject_id and c.field_name = f.field_name) then
    raise exception 'new evidence has reopened %#%.%; decide it again instead of ratifying', f.subject_table, f.subject_id, f.field_name using errcode = 'check_violation';
  end if;
  insert into research.decision_history (kind, class_ids, subject_table, subject_id, field_name, new_value, new_observation_id, new_source_key, rule, decided_by, reviewer_session,
      reason, evidence, certification_impact, fact_resolution_id)
  select 'RATIFIED', research.classes_of_subject(f.subject_table, f.subject_id), f.subject_table, f.subject_id, f.field_name, o.observed_value, o.id, s.source_key, f.rule, v_rev, true,
         p_reason, coalesce(p_evidence, '[]') || jsonb_build_array(jsonb_build_object('ratified_decision_by', f.decided_by, 'ratified_rationale', f.rationale)),
         case when cardinality(research.classes_of_subject(f.subject_table, f.subject_id)) > 0 then 'CLASS_NOT_CERTIFIED' else 'NONE' end::research.certification_impact, f.id
  from public.source_observations o join public.sources s on s.id = o.source_id where o.id = f.chosen_observation_id
  returning * into h;
  return h;
end $$;

-- Certifies a recorded, passing check whose fingerprint still matches the class.
create function research.certify_class(p_check_id bigint) returns research.certifications
language plpgsql security definer
set search_path = pg_catalog, public, research
as $$
declare
  v_rev text := research.require_reviewer();
  chk research.certification_checks;
  cls research.classes;
  cert research.certifications;
begin
  if not research.certification_enabled() then
    raise exception 'certification is disabled (research.certification_gate)' using errcode = 'insufficient_privilege';
  end if;
  select * into chk from research.certification_checks where id = p_check_id;
  if not found then raise exception 'certification check % not found', p_check_id using errcode = 'no_data_found'; end if;
  if not chk.passed then raise exception 'check % did not pass', p_check_id using errcode = 'check_violation'; end if;
  if chk.checked_at < now() - interval '7 days' then raise exception 'check % is older than 7 days; run it again', p_check_id using errcode = 'check_violation'; end if;
  select * into cls from research.classes where id = chk.class_id for update;
  if cls.stage <> 'COVERAGE_REVIEW' then raise exception 'class % is at %, not COVERAGE_REVIEW', cls.class_key, cls.stage using errcode = 'check_violation'; end if;
  if research.class_fingerprint(cls.id) <> chk.fingerprint then
    raise exception 'the evidence of % changed after check %; run the check again', cls.class_key, p_check_id using errcode = 'check_violation';
  end if;
  if exists (select 1 from research.unratified_decisions(cls.id)) then
    raise exception '% has decisions no reviewer session took or ratified', cls.class_key using errcode = 'check_violation';
  end if;
  insert into research.certifications (class_id, certified_by, coverage_state, report, certification_check_id)
  values (cls.id, v_rev, chk.coverage_state, chk.report, chk.id) returning * into cert;
  update research.jobs set state = 'DONE', completed_at = now(), completion_rationale = 'certified by research:certify'
  where class_id = cls.id and category_key = 'COVERAGE_CERTIFICATION' and not research.job_state_terminal(state);
  update research.classes set stage = 'CERTIFIED' where id = cls.id;
  insert into research.stage_events (class_id, from_stage, to_stage, actor, rationale) values (cls.id, 'COVERAGE_REVIEW', 'CERTIFIED', v_rev, 'research:certify passed (check ' || chk.id || ')');
  return cert;
end $$;

-- Trigger functions run with the owner's rights (SECURITY DEFINER; a trigger function cannot be called directly), so a
-- write by any session, an automation login or a deferred check at a reviewer's commit, is guarded, logged and revokes
-- what it must, instead of failing on a privilege the writer lacks. Identity checks inside use session_user, which
-- SECURITY DEFINER does not change.
alter function research.reviewer_guard() security definer;
alter function research.proposal_guard() security definer;
alter function research.decision_history_append_only() security definer;
alter function research.certification_gate_guard() security definer;
alter function research.on_evidence_change() security definer;
alter function research.fact_resolution_guard() security definer;
alter function research.log_fact_resolution() security definer;
alter function research.certification_guard() security definer;
alter function research.log_certification() security definer;
alter function public.outcome_consistency_guard() security definer;     -- 008's deferred check fires at a reviewer's commit too

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

-- Certifications made before reviewer identity was bound to a login cannot be vouched for: none exist on any BAI
-- database (no class was ever certified); refuse to carry one forward silently.
do $$
begin
  if exists (select 1 from research.certifications where revoked_at is null) then
    raise exception '021: active certifications exist that were made without an authenticated reviewer; revoke them first';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Boundary: private like the rest of research; reviewers reach only the human-only functions
-- ---------------------------------------------------------------------------------------------------------------

alter table research.reviewers enable row level security;
alter table research.decision_history enable row level security;
alter table research.decision_proposals enable row level security;
alter table research.certification_gate enable row level security;
alter table research.certification_checks enable row level security;
alter table research.resolvable_columns enable row level security;
select public.apply_public_boundary();
revoke all on all tables in schema research from public, anon, authenticated, service_role;
revoke all on all sequences in schema research from public, anon, authenticated, service_role;
revoke all on all functions in schema research from public, anon, authenticated, service_role;

grant usage on schema research to bai_reviewer;
grant execute on function research.enroll_reviewer(text, text), research.set_certification_gate(boolean, text),
  research.reconsider_resolution(text, bigint, text, bigint, text, jsonb, bigint), research.accept_proposal(bigint, text, jsonb),
  research.reject_proposal(bigint, text), research.ratify_resolution(bigint, text, jsonb), research.certify_class(bigint) to bai_reviewer;
