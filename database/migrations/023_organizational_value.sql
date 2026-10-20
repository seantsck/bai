-- 023_organizational_value
-- Organizational value, the smallest safe extension (docs/proposals/organizational-war-attribution.md, phase 1):
--   * Season-by-team WAR is already a war_observations row (scope SEASON, with the organization the value was produced
--     for). A TRADES channel carries whole trades: every package, the players by strong id, and their observed WAR, so
--     the value a club received for a player it traded away can be traced.
--   * Read-only views derive, per provider and never mixed: career WAR, WAR produced for the acquiring organization
--     during the acquisition's own tenure, WAR from a later return to that club (reported, never credited), WAR produced
--     for other organizations, value returned through the trade that ended the acquisition (per package, never split
--     among the players sent, counted once per class), cost and the development timeline. No value is estimated:
--       - a provider not observed is NOT_OBSERVED (NULL), never zero;
--       - a player audited without MLB time has zero MLB WAR (a fact from the audit);
--       - season splits that do not add up to the career value are PARTIAL and say so;
--       - another organization's production is reported as other-organization value, never as value delivered to the
--         acquiring club;
--       - an acquisition that did not sign (or whose signing is unknown) earns nothing: a player drafted twice is
--         credited once, to the acquisition that signed.
--   * Nothing here is a rate. Rollups are sums of known values with their coverage counts; a class total is given only
--     when every signed member's coverage is complete.

alter type ingest.batch_channel add value if not exists 'TRADES';

alter table ingest.staged_records drop constraint staged_records_record_type_check;
alter table ingest.staged_records add constraint staged_records_record_type_check
  check (record_type in ('DRAFT_SELECTION', 'INTERNATIONAL_SIGNING', 'OUTCOME_AUDIT', 'TRADE'));

-- Latest observation per player, provider, season and organization (a later capture supersedes an earlier one).
create view analytics.player_season_war with (security_invoker = true) as
select distinct on (w.player_id, w.war_system, w.season, w.organization_id)
       w.player_id, w.war_system, w.season, w.organization_id, w.war_value, w.through_season, w.observed_on, w.source_id
from public.war_observations w
where w.scope = 'SEASON'
order by w.player_id, w.war_system, w.season, w.organization_id, w.through_season desc, w.observed_on desc, w.id desc;

create view analytics.player_career_war with (security_invoker = true) as
select distinct on (w.player_id, w.war_system)
       w.player_id, w.war_system, w.war_value, w.through_season, w.observed_on, w.source_id
from public.war_observations w
where w.scope = 'CAREER'
order by w.player_id, w.war_system, w.through_season desc, w.observed_on desc, w.id desc;

-- Per player and provider: how much of the value is observed, season by season.
create view analytics.player_war_coverage with (security_invoker = true) as
with sys as (select unnest(array['BREF', 'FANGRAPHS']::public.war_system[]) as war_system),
splits as (
  select player_id, war_system, sum(war_value) as split_total, count(*)::integer as split_rows, max(through_season) as through_season, max(observed_on) as observed_on
  from analytics.player_season_war group by player_id, war_system
)
select p.id as player_id, s.war_system, c.war_value as career_war, c.through_season as career_through_season, sp.split_total, sp.split_rows,
       cs.war_value as career_at_splits_through,
       coalesce(sp.through_season, c.through_season) as through_season, greatest(sp.observed_on, c.observed_on) as observed_on,
       case
         when o.audit_state = 'AUDITED_NO_MLB' and sp.split_rows is null and c.war_value is null then 'NO_MLB'
         when sp.split_rows is null and c.war_value is null then 'NOT_OBSERVED'
         when sp.split_rows is null then 'CAREER_ONLY'
         -- complete when the splits add up (within rounding) to a career value covering the same seasons
         when cs.war_value is not null and abs(sp.split_total - cs.war_value) <= 0.05 * sp.split_rows + 0.05 then 'COMPLETE'
         else 'PARTIAL'
       end as coverage
from public.players p
cross join sys s
left join splits sp on sp.player_id = p.id and sp.war_system = s.war_system
left join analytics.player_career_war c on c.player_id = p.id and c.war_system = s.war_system
left join lateral (
  select w.war_value from public.war_observations w
  where w.player_id = p.id and w.war_system = s.war_system and w.scope = 'CAREER' and w.through_season = sp.through_season
  order by w.observed_on desc, w.id desc limit 1
) cs on true
left join public.v_player_outcome_status o on o.player_id = p.id;

-- What a club received for each package it sent, per provider: WAR the received players produced FOR THAT CLUB from
-- the trade season until the club next traded them away (that season included; later stints are not this trade's
-- return). Credited to the package, never split among the players sent.
create view analytics.trade_returns with (security_invoker = true) as
with sys as (select unnest(array['BREF', 'FANGRAPHS']::public.war_system[]) as war_system),
sent as (
  select k.id as package_id, k.transaction_id, t.transaction_date, k.from_organization_id as organization_id, k.to_organization_id as counterparty_id,
         coalesce(array_agg(a.player_id order by a.player_id) filter (where a.player_id is not null), '{}') as sent_player_ids,
         (count(a.id) filter (where a.asset_type <> 'PLAYER'))::integer as other_assets_sent
  from public.trade_packages k
  join public.transactions t on t.id = k.transaction_id
  left join public.trade_package_assets a on a.trade_package_id = k.id
  group by k.id, k.transaction_id, t.transaction_date, k.from_organization_id, k.to_organization_id
),
received as (
  select k.transaction_id, t.transaction_date, k.to_organization_id as organization_id, a.player_id,
         -- the season the club next traded this player away, if it did
         (select min(extract(year from t2.transaction_date))::integer from public.trade_packages k2
            join public.transactions t2 on t2.id = k2.transaction_id
            join public.trade_package_assets a2 on a2.trade_package_id = k2.id
          where k2.from_organization_id = k.to_organization_id and a2.player_id = a.player_id and t2.transaction_date > t.transaction_date) as left_season
  from public.trade_packages k join public.transactions t on t.id = k.transaction_id join public.trade_package_assets a on a.trade_package_id = k.id
  where a.player_id is not null
)
select o.package_id, o.transaction_id, o.transaction_date, o.organization_id, o.counterparty_id, o.sent_player_ids,
       cardinality(o.sent_player_ids) as players_sent, o.other_assets_sent, s.war_system,
       coalesce((select array_agg(r.player_id order by r.player_id) from received r where r.transaction_id = o.transaction_id and r.organization_id = o.organization_id), '{}') as received_player_ids,
       -- known WAR the received players produced for the club; 0 when every received player is accounted for and produced none
       case when exists (select 1 from received r join analytics.player_war_coverage c on c.player_id = r.player_id and c.war_system = s.war_system
                         where r.transaction_id = o.transaction_id and r.organization_id = o.organization_id and c.coverage in ('COMPLETE', 'PARTIAL', 'NO_MLB'))
            then coalesce((select sum(w.war_value) from received r
              join analytics.player_season_war w on w.player_id = r.player_id and w.organization_id = o.organization_id and w.war_system = s.war_system
               and w.season >= extract(year from o.transaction_date) and (r.left_season is null or w.season <= r.left_season)
            where r.transaction_id = o.transaction_id and r.organization_id = o.organization_id), 0) end as return_war_known,
       case
         when not exists (select 1 from received r where r.transaction_id = o.transaction_id and r.organization_id = o.organization_id) then 'NO_PLAYERS_RECEIVED'
         when not exists (select 1 from received r join analytics.player_war_coverage c on c.player_id = r.player_id and c.war_system = s.war_system
                          where r.transaction_id = o.transaction_id and r.organization_id = o.organization_id and c.coverage not in ('COMPLETE', 'NO_MLB')) then 'COMPLETE'
         else 'PARTIAL'
       end as return_coverage
from sent o cross join sys s;

-- Per acquisition and provider: the value it produced, where, and what it returned. Only an acquisition that signed
-- earns anything (a pick that did not sign, or whose signing is unknown, gets NULLs and says why). Value for the
-- acquiring club counts only the acquisition's own tenure: from the acquisition season to the season it ended
-- (acquisition_dispositions, 022); a later return to the club is reported separately and never credited to it.
create view analytics.acquisition_value with (security_invoker = true) as
with sys as (select unnest(array['BREF', 'FANGRAPHS']::public.war_system[]) as war_system),
acq as (
  select e.*, t.disposition, t.disposition_date, t.disposition_transaction_id, t.tenure_end_known, t.acquired_on,
         (t.channel = 'INTERNATIONAL' or t.signing_status = 'SIGNED') as credited,
         extract(year from t.acquired_on)::integer as first_season,
         case when t.disposition not in ('RETAINED', 'UNKNOWN') then extract(year from t.disposition_date)::integer end as exit_season,
         t.signing_status as acquisition_signing_status
  from analytics.acquisition_economics e
  join analytics.acquisition_tenures t on t.channel = e.channel and t.organization_id = e.organization_id and t.scope_key = e.scope_key and t.player_id = e.player_id
)
select e.channel, e.organization_id, e.scope_key, e.player_id, e.signing_status, e.acquisition_cost_usd, e.slot_value_usd, e.credited,
       s.war_system,
       case when e.credited then c.coverage
            when e.acquisition_signing_status = 'DID_NOT_SIGN' then 'NOT_SIGNED' else 'SIGNING_UNKNOWN' end as war_coverage,
       case when e.credited then c.through_season end as through_season, case when e.credited then c.observed_on end as observed_on,
       case when e.credited then c.career_war end as career_war, case when e.credited then c.career_through_season end as career_through_season,
       e.disposition, e.disposition_date, e.tenure_end_known,
       case when not e.credited then null when c.coverage = 'NO_MLB' then 0
            when c.coverage in ('COMPLETE', 'PARTIAL') then coalesce((select sum(w.war_value) from analytics.player_season_war w
              where w.player_id = e.player_id and w.war_system = s.war_system and w.organization_id = e.organization_id
                and w.season >= e.first_season and (e.exit_season is null or w.season <= e.exit_season)), 0) end as original_org_war,
       case when not e.credited then null when c.coverage = 'NO_MLB' then 0
            when c.coverage in ('COMPLETE', 'PARTIAL') then coalesce((select sum(w.war_value) from analytics.player_season_war w
              where w.player_id = e.player_id and w.war_system = s.war_system and w.organization_id = e.organization_id
                and e.exit_season is not null and w.season > e.exit_season), 0) end as returning_stint_war,
       case when not e.credited then null when c.coverage = 'NO_MLB' then 0
            when c.coverage in ('COMPLETE', 'PARTIAL') then coalesce((select sum(w.war_value) from analytics.player_season_war w
              where w.player_id = e.player_id and w.war_system = s.war_system and w.organization_id <> e.organization_id), 0) end as other_org_war,
       tr.package_id as trade_package_id, tr.transaction_date as traded_on, tr.players_sent as trade_package_players,
       tr.return_war_known as trade_package_return_war, tr.return_coverage as trade_return_coverage,
       e.audit_state, prof.debut_date, prof.debut_age, prof.debut_organization_id, prof.first_affiliated_season,
       left(e.scope_key, 4)::integer as acquisition_season,
       case when e.credited then extract(year from prof.debut_date)::integer - left(e.scope_key, 4)::integer end as seasons_to_debut
from acq e
cross join sys s
join analytics.player_war_coverage c on c.player_id = e.player_id and c.war_system = s.war_system
left join analytics.player_outcome_profile prof on prof.player_id = e.player_id
-- the trade that ended THIS acquisition (not a later trade after the player returned)
left join analytics.trade_returns tr on e.credited and e.disposition = 'TRADED' and tr.transaction_id = e.disposition_transaction_id
  and tr.organization_id = e.organization_id and e.player_id = any (tr.sent_player_ids) and tr.war_system = s.war_system;

-- Per class and provider: sums of known values with coverage counts over the acquisitions that signed; totals only
-- when every one of them is covered. A trade package counts once per class, and a package shared with another class is
-- flagged: class rollups must never be added together.
create view analytics.class_value with (security_invoker = true) as
select v.channel, v.organization_id, v.scope_key, v.war_system,
       count(*)::integer as acquisitions,
       (count(*) filter (where v.credited))::integer as credited_acquisitions,
       (count(*) filter (where v.credited and v.war_coverage in ('COMPLETE', 'NO_MLB')))::integer as war_covered,
       (count(*) filter (where v.credited and v.war_coverage = 'NOT_OBSERVED'))::integer as war_not_observed,
       (count(*) filter (where v.credited and not v.tenure_end_known))::integer as tenure_end_unknown,
       -- known sums only when something was observed for this provider (members audited without MLB time alone give no sum)
       case when count(*) filter (where v.credited and v.war_coverage in ('COMPLETE', 'PARTIAL')) > 0 then sum(v.original_org_war) end as original_org_war_known,
       case when count(*) filter (where v.credited and v.war_coverage in ('COMPLETE', 'PARTIAL')) > 0 then sum(v.other_org_war) end as other_org_war_known,
       case when count(*) filter (where v.credited and v.war_coverage in ('COMPLETE', 'PARTIAL')) > 0 then sum(v.returning_stint_war) end as returning_stint_war_known,
       case when bool_and(v.war_coverage in ('COMPLETE', 'NO_MLB')) filter (where v.credited) and bool_or(v.war_coverage = 'COMPLETE') filter (where v.credited)
            then sum(v.original_org_war) end as original_org_war_total,
       case when bool_and(v.war_coverage in ('COMPLETE', 'NO_MLB')) filter (where v.credited) and bool_or(v.war_coverage = 'COMPLETE') filter (where v.credited)
            then sum(v.other_org_war) end as other_org_war_total,
       (select sum(t.return_war_known) from analytics.trade_returns t
         where t.war_system = v.war_system and t.package_id in (select distinct v2.trade_package_id from analytics.acquisition_value v2
           where v2.channel = v.channel and v2.organization_id = v.organization_id and v2.scope_key = v.scope_key and v2.war_system = v.war_system and v2.trade_package_id is not null)) as trade_return_war_known,
       (count(distinct v.trade_package_id))::integer as trade_packages,
       (select count(*)::integer from analytics.trade_returns t
         where t.war_system = v.war_system and t.package_id in (select distinct v2.trade_package_id from analytics.acquisition_value v2
           where v2.channel = v.channel and v2.organization_id = v.organization_id and v2.scope_key = v.scope_key and v2.war_system = v.war_system and v2.trade_package_id is not null)
           and exists (select 1 from unnest(t.sent_player_ids) sp(pid) where not exists (select 1 from analytics.acquisition_economics e2
             where e2.player_id = sp.pid and e2.channel = v.channel and e2.organization_id = v.organization_id and e2.scope_key = v.scope_key))) as trade_packages_shared,
       sum(v.acquisition_cost_usd) filter (where v.credited) as known_cost_usd,
       (count(*) filter (where v.credited and v.acquisition_cost_usd is not null))::integer as cost_known
from analytics.acquisition_value v
group by v.channel, v.organization_id, v.scope_key, v.war_system;

revoke all on all tables in schema analytics from public, anon, authenticated, service_role;
select public.apply_public_boundary();
