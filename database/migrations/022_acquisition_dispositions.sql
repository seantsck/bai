-- 022_acquisition_dispositions
-- How each ACQUISITION ended, separate from the player's career outcome.
--   * A player may be acquired several times (drafted unsigned in 2017 and drafted again, and signed, in 2018; drafted by
--     one club and signed by another the next year). Each acquisition is a draft selection or an international signing,
--     with its own organization, year, channel, pick or signing, signing status and bonus (007/006). Until now its
--     disposition (RETAINED, TRADED, UNSIGNED, ...) lived on the player's outcome audit (019 outcome_audit_details), so
--     the second acquisition inherited the first one's: the 2018 signing of a player showed his 2017 "UNSIGNED".
--   * public.acquisition_dispositions holds one disposition per acquisition, with the exit date and the transaction
--     that ended it, as of a date and cited. Player-level facts (audit state, debut, games, current status, WAR) stay
--     on the player.
--   * The database refuses contradictions: UNSIGNED on a signed pick or on an international signing; an exit
--     (TRADED, RELEASED, ...) on a pick that did not sign; a TRADED exit whose trade did not send this player from this
--     organization; an exit dated before the acquisition.
--   * Backfill: a legacy disposition moves to the player's acquisition only when the player has exactly one; otherwise it
--     stays where it was (outcome_audit_details.disposition, now legacy and ignored by the value views) and the
--     acquisition is filled by an explicit, cited OUTCOMES batch. Nothing is guessed.

create table public.acquisition_dispositions (
  id bigint generated always as identity primary key,
  draft_selection_id bigint unique references public.draft_selections (id),
  international_signing_id bigint unique references public.international_signings (id),
  organization_id bigint not null references public.organizations (id),      -- the acquiring organization (checked)
  player_id bigint not null references public.players (id),                  -- the acquired player (checked)
  disposition public.acquisition_disposition not null,
  disposition_date date,                                                     -- when the acquisition ended; null = not established
  disposition_date_precision public.date_precision,
  disposition_transaction_id bigint references public.transactions (id),
  as_of_date date not null,
  source_id bigint not null references public.sources (id),
  notes text,
  created_at timestamptz not null default now(),
  check (num_nonnulls(draft_selection_id, international_signing_id) = 1),
  check ((disposition_date is null) = (disposition_date_precision is null)),
  check (disposition <> 'TRADED' or disposition_transaction_id is not null),
  check (disposition_transaction_id is null or disposition = 'TRADED'),
  check (disposition not in ('RETAINED', 'UNKNOWN', 'UNSIGNED') or disposition_date is null)
);
create index acquisition_dispositions_player_idx on public.acquisition_dispositions (player_id);
alter table public.acquisition_dispositions enable row level security;

comment on column public.outcome_audit_details.disposition is
  'LEGACY (before 022): a disposition recorded on the player. Acquisition dispositions live in public.acquisition_dispositions; the value views ignore this column.';

insert into public.provenance_fact_tables (table_name, domain, description) values
  ('acquisition_dispositions', 'OUTCOME', 'How one acquisition (draft selection or international signing) ended, as of a date')
on conflict (table_name) do nothing;

insert into research.resolvable_columns values ('acquisition_dispositions', 'disposition'), ('acquisition_dispositions', 'disposition_date');

-- Every acquisition, one row each, with what is known about whether it signed.
create view analytics.player_acquisitions with (security_invoker = true) as
select 'DRAFT'::public.acquisition_domain as channel, s.id as draft_selection_id, null::bigint as international_signing_id, s.player_id, s.organization_id,
       d.draft_key as scope_key, d.start_date as acquired_on, s.overall_pick, r.round_code,
       case g.signing_status when 'SIGNED' then 'SIGNED' when 'DID_NOT_SIGN' then 'DID_NOT_SIGN' else 'UNKNOWN' end as signing_status,
       g.signing_bonus_usd
from public.draft_selections s
join public.drafts d on d.id = s.draft_id
join public.draft_rounds r on r.id = s.round_id
left join public.draft_signings g on g.draft_selection_id = s.id
union all
select 'INTERNATIONAL', null, i.id, i.player_id, i.organization_id, p.period_key, coalesce(i.signing_date, p.start_date), null, null, 'SIGNED', i.signing_bonus_usd
from public.international_signings i
join public.international_signing_periods p on p.id = i.signing_period_id;

create function public.acquisition_disposition_guard() returns trigger
language plpgsql
set search_path = pg_catalog, public, analytics
as $$
declare
  a record;
  v_bad text;
begin
  -- Re-check every disposition attached to the changed row (a signing status change can contradict one).
  for a in
    select x.*, v.player_id as acq_player, v.organization_id as acq_org, v.signing_status, v.acquired_on, v.scope_key, v.channel
    from public.acquisition_dispositions x
    join analytics.player_acquisitions v on (v.draft_selection_id = x.draft_selection_id or v.international_signing_id = x.international_signing_id)
    where (tg_table_name = 'acquisition_dispositions' and x.id = new.id)
       or (tg_table_name = 'draft_signings' and x.draft_selection_id = coalesce(new.draft_selection_id, old.draft_selection_id))
  loop
    v_bad := case
      when a.player_id <> a.acq_player or a.organization_id <> a.acq_org then 'its player or organization differs from the acquisition'
      when a.disposition = 'UNSIGNED' and a.channel = 'INTERNATIONAL' then 'UNSIGNED on an international signing'
      when a.disposition = 'UNSIGNED' and a.signing_status = 'SIGNED' then format('UNSIGNED, but the %s acquisition signed', a.scope_key)
      when a.disposition not in ('UNSIGNED', 'UNKNOWN') and a.signing_status = 'DID_NOT_SIGN' then format('%s, but the %s pick did not sign', a.disposition, a.scope_key)
      when a.disposition_date is not null and a.disposition_date < a.acquired_on then format('the exit (%s) predates the acquisition (%s)', a.disposition_date, a.acquired_on)
      when a.disposition = 'TRADED' and not exists (
        select 1 from public.trade_packages k join public.trade_package_assets t on t.trade_package_id = k.id
        where k.transaction_id = a.disposition_transaction_id and k.from_organization_id = a.organization_id and t.player_id = a.player_id)
        then 'TRADED, but its transaction did not send this player from this organization'
      when a.disposition = 'TRADED' and a.disposition_date is not null
           and a.disposition_date <> (select transaction_date from public.transactions where id = a.disposition_transaction_id)
        then 'the exit date differs from the trade date'
    end;
    if v_bad is not null then
      raise exception 'acquisition disposition % is inconsistent: %', a.id, v_bad using errcode = 'check_violation';
    end if;
  end loop;
  return null;
end $$;
alter function public.acquisition_disposition_guard() security definer;   -- deferred: fires at commit, in any session (021)
create constraint trigger acquisition_dispositions_consistency after insert or update on public.acquisition_dispositions
  deferrable initially deferred for each row execute function public.acquisition_disposition_guard();
create constraint trigger draft_signings_disposition_consistency after insert or update on public.draft_signings
  deferrable initially deferred for each row execute function public.acquisition_disposition_guard();

-- Classes: an acquisition disposition belongs to its acquisition's class (and, through the player, to the others).
create or replace function research.classes_of_subject(p_table text, p_id bigint) returns bigint[]
language sql stable
set search_path = pg_catalog, public, research
as $$
  with players as (
    select p_id as player_id where p_table = 'players'
    union select player_id from public.mlb_debuts where p_table = 'mlb_debuts' and id = p_id
    union select player_id from public.war_observations where p_table = 'war_observations' and id = p_id
    union select player_id from public.outcome_audits where p_table = 'outcome_audits' and id = p_id
    union select a.player_id from public.outcome_audit_details d join public.outcome_audits a on a.id = d.outcome_audit_id where p_table = 'outcome_audit_details' and d.id = p_id
    union select player_id from public.acquisition_dispositions where p_table = 'acquisition_dispositions' and id = p_id
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

-- The certification fingerprint includes the class's acquisition dispositions.
create or replace function research.class_fingerprint(p_class_id bigint) returns text
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
    union all select 'acquisition_dispositions', x.id, md5(x::text) from public.acquisition_dispositions x join pl on pl.player_id = x.player_id
    union all select 'coverage_assessments', ca.id, md5(ca::text) from public.coverage_assessments ca join c on ca.organization_id = c.organization_id and ca.domain::text = c.channel_key and ca.scope_key = c.scope_key
  ),
  obs as (select 'source_observations' t, o.id, md5(o::text) h from public.source_observations o join parts p on p.t = o.subject_table and p.id = o.subject_id),
  res as (select 'fact_resolutions' t, f.id, md5(f::text) h from public.fact_resolutions f join parts p on p.t = f.subject_table and p.id = f.subject_id)
  select md5(coalesce(string_agg(t || ':' || id || ':' || h, ',' order by t, id), '')) from (select * from parts union all select * from obs union all select * from res) x
$$;

create trigger acquisition_dispositions_evidence_before before update or delete on public.acquisition_dispositions for each row execute function research.on_evidence_change();
create trigger acquisition_dispositions_evidence_after after insert or update on public.acquisition_dispositions for each row execute function research.on_evidence_change();

-- ---------------------------------------------------------------------------------------------------------------
-- Backfill: legacy dispositions of players with exactly one acquisition (deterministic; ambiguous ones stay legacy)
-- ---------------------------------------------------------------------------------------------------------------

insert into public.acquisition_dispositions (draft_selection_id, international_signing_id, organization_id, player_id, disposition, disposition_date, disposition_date_precision,
    disposition_transaction_id, as_of_date, source_id, notes)
select v.draft_selection_id, v.international_signing_id, v.organization_id, v.player_id, x.disposition,
       t.transaction_date, case when t.id is not null then t.date_precision end, x.disposition_transaction_id, x.as_of_date, x.source_id,
       format('moved from outcome_audit_details #%s by migration 022 (the player''s only acquisition)', x.id)
from public.outcome_audit_details x
join public.outcome_audits oa on oa.id = x.outcome_audit_id
join analytics.player_acquisitions v on v.player_id = oa.player_id
left join public.transactions t on t.id = x.disposition_transaction_id
where x.disposition <> 'UNKNOWN'
  and (select count(*) from analytics.player_acquisitions v2 where v2.player_id = oa.player_id) = 1
  -- the latest audit of the player carries his disposition
  and oa.id = (select a2.id from public.outcome_audits a2 where a2.player_id = oa.player_id order by a2.observation_through_season desc nulls last, a2.audited_on desc limit 1);

-- Check every moved disposition now (the consistency guard is deferred), so the migration fails on a contradiction
-- instead of leaving it for a later commit, and no trigger event is pending when tables are altered below.
set constraints all immediate;

do $$
declare
  n integer;
begin
  select count(*) into n from public.outcome_audit_details x join public.outcome_audits oa on oa.id = x.outcome_audit_id
  where x.disposition <> 'UNKNOWN' and (select count(*) from analytics.player_acquisitions v where v.player_id = oa.player_id) <> 1;
  if n > 0 then raise notice '022: % legacy disposition(s) belong to players with several (or no) acquisitions; left in place for an explicit batch', n; end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Integrity: two signed acquisitions of one player whose tenures overlap would double-count value
-- ---------------------------------------------------------------------------------------------------------------

create view analytics.acquisition_tenures with (security_invoker = true) as
select v.channel, v.draft_selection_id, v.international_signing_id, v.player_id, v.organization_id, v.scope_key, v.signing_status, v.acquired_on,
       x.disposition, x.disposition_date, x.disposition_transaction_id,
       -- the tenure's end is known when the acquisition is still held (RETAINED) or ended on a known date
       case when x.disposition = 'RETAINED' then true when x.disposition_date is not null then true else false end as tenure_end_known
from analytics.player_acquisitions v
left join public.acquisition_dispositions x on x.draft_selection_id = v.draft_selection_id or x.international_signing_id = v.international_signing_id;

revoke all on all tables in schema analytics from public, anon, authenticated, service_role;
select public.apply_public_boundary();
