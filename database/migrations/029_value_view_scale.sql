-- 029_value_view_scale
-- The organizational-value views of 023 (and trade_returns as 028 redefined it) scale badly with the number of trades: a rehearsal
-- with 336 more trades made acquisition_value 22 times slower and the full view did not finish. This migration reimplements three
-- views with the SAME columns, types and meaning; nothing is stored, no data changes, no table changes.
--
-- Root cause (docs/transactions/value-view-scale.md, execution plans captured on a disposable copy of hosted data):
--   1. analytics.trade_returns computed return_war_known and return_coverage with correlated subqueries that joined
--      analytics.player_war_coverage. That view is built per player with a lateral lookup and cannot be pushed a filter, so every
--      trade_returns row evaluated it for ALL players (about 3.5 million inner index lookups for 1,518 rows).
--   2. analytics.acquisition_value joins trade_returns as the inner side of a nested loop. The planner re-evaluated the whole
--      trade_returns view (select-list subplans included) for every acquisition row.
--   3. analytics.class_value referenced acquisition_value and trade_returns again inside correlated subqueries, once per group, and its
--      shared-package test re-evaluated analytics.acquisition_economics for every sent player of every package of every group.
--
-- Changes (set-based aggregation, each expensive input evaluated once):
--   * trade_returns: the coverage of every received player is joined ONCE and aggregated per (transaction, organization, provider)
--     with the received players, the known WAR and the departure season; no correlated subquery remains in the select list.
--   * acquisition_value: trade_returns is evaluated once (a MATERIALIZED common table expression).
--   * class_value: acquisition_value, the trade-return columns and acquisition_economics are evaluated once; the two per-group subqueries become
--     grouped joins over the distinct packages of each class.
-- Accounting is unchanged: provider separation, COMPLETE / PARTIAL / NOT_OBSERVED coverage, one credit per package, acquisition
-- tenure boundaries, the next-departure season, PTBNL effective dates, and no other club's WAR credited to the acquiring club.
-- tests/db/value-view-parity.test.mjs and scripts/db/bench/parity.mjs compare old and new outputs value for value.

create or replace view analytics.trade_returns with (security_invoker = true) as
with sys as (select unnest(array['BREF', 'FANGRAPHS']::public.war_system[]) as war_system),
sent as (
  select k.id as package_id, k.transaction_id, t.transaction_date, k.from_organization_id as organization_id, k.to_organization_id as counterparty_id,
         coalesce(array_agg(a.player_id order by a.player_id) filter (where a.player_id is not null), '{}') as sent_player_ids,
         (count(a.id) filter (where a.asset_type <> 'PLAYER'))::integer as other_assets_sent
  from public.trade_packages k
  join public.transactions t on t.id = k.transaction_id
  left join analytics.trade_asset_players a on a.trade_package_id = k.id
  group by k.id, k.transaction_id, t.transaction_date, k.from_organization_id, k.to_organization_id
),
-- every player a club received in a transaction (a resolved PTBNL from its naming date), one row per asset
received_base as (
  select k.id as package_id, a.id as asset_id, k.transaction_id, t.transaction_date, coalesce(a.effective_on, t.transaction_date) as effective_date,
         k.to_organization_id as organization_id, a.player_id
  from public.trade_packages k join public.transactions t on t.id = k.transaction_id join analytics.trade_asset_players a on a.trade_package_id = k.id
  where a.player_id is not null
),
-- every time a club sent a player away, for the next-departure season
departures as (
  select k2.from_organization_id as organization_id, a2.player_id, t2.transaction_date as depart_date
  from public.trade_packages k2 join public.transactions t2 on t2.id = k2.transaction_id join analytics.trade_asset_players a2 on a2.trade_package_id = k2.id
  where a2.player_id is not null
),
-- the season the club next traded this player away, if it did (later stints are not this trade's return)
received as (
  select rb.package_id, rb.asset_id, rb.transaction_id, rb.transaction_date, rb.effective_date, rb.organization_id, rb.player_id,
         min(extract(year from d.depart_date))::integer as left_season
  from received_base rb
  left join departures d on d.organization_id = rb.organization_id and d.player_id = rb.player_id and d.depart_date > rb.transaction_date
  group by rb.package_id, rb.asset_id, rb.transaction_id, rb.transaction_date, rb.effective_date, rb.organization_id, rb.player_id
),
-- player_war_coverage cannot take a pushed filter: evaluate it once
cov as materialized (select player_id, war_system, coverage from analytics.player_war_coverage),
recv as (
  select transaction_id, organization_id, array_agg(player_id order by player_id) as player_ids, count(*) as n from received group by transaction_id, organization_id
),
status as (
  select r.transaction_id, r.organization_id, s.war_system,
         coalesce(bool_or(c.coverage in ('COMPLETE', 'PARTIAL', 'NO_MLB')), false) as any_known,
         coalesce(bool_or(c.coverage not in ('COMPLETE', 'NO_MLB')), false) as any_partial
  from received r cross join sys s join cov c on c.player_id = r.player_id and c.war_system = s.war_system
  group by r.transaction_id, r.organization_id, s.war_system
),
war as (
  select r.transaction_id, r.organization_id, s.war_system, sum(w.war_value) as war_known
  from received r cross join sys s
  join analytics.player_season_war w on w.player_id = r.player_id and w.organization_id = r.organization_id and w.war_system = s.war_system
   and w.season >= extract(year from r.effective_date) and (r.left_season is null or w.season <= r.left_season)
  group by r.transaction_id, r.organization_id, s.war_system
)
select o.package_id, o.transaction_id, o.transaction_date, o.organization_id, o.counterparty_id, o.sent_player_ids,
       cardinality(o.sent_player_ids) as players_sent, o.other_assets_sent, s.war_system,
       coalesce(rv.player_ids, '{}') as received_player_ids,
       -- known WAR the received players produced for the club; 0 when every received player is accounted for and produced none
       case when coalesce(st.any_known, false) then coalesce(wr.war_known, 0) end as return_war_known,
       case
         when rv.n is null then 'NO_PLAYERS_RECEIVED'
         when not coalesce(st.any_partial, false) then 'COMPLETE'
         else 'PARTIAL'
       end as return_coverage
from sent o cross join sys s
left join recv rv on rv.transaction_id = o.transaction_id and rv.organization_id = o.organization_id
left join status st on st.transaction_id = o.transaction_id and st.organization_id = o.organization_id and st.war_system = s.war_system
left join war wr on wr.transaction_id = o.transaction_id and wr.organization_id = o.organization_id and wr.war_system = s.war_system;

-- acquisition_value: the 023 definition, with trade_returns evaluated once
create or replace view analytics.acquisition_value with (security_invoker = true) as
with tr_all as materialized (select * from analytics.trade_returns),
sys as (select unnest(array['BREF', 'FANGRAPHS']::public.war_system[]) as war_system),
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
left join tr_all tr on e.credited and e.disposition = 'TRADED' and tr.transaction_id = e.disposition_transaction_id
  and tr.organization_id = e.organization_id and e.player_id = any (tr.sent_player_ids) and tr.war_system = s.war_system;;

-- class_value: the 023 aggregation, with its inputs evaluated once and its two per-group subqueries computed as grouped joins
-- (the old per-group subquery over acquisition_economics ran 29,000 times on a database of BAI's current size)
create or replace view analytics.class_value with (security_invoker = true) as
with av as materialized (select * from analytics.acquisition_value),
trm as materialized (select package_id, war_system, return_war_known, sent_player_ids from analytics.trade_returns),
ae as materialized (select channel, organization_id, scope_key, player_id from analytics.acquisition_economics),
-- the distinct trade packages that ended each class's acquisitions
pk as materialized (
  select distinct v2.channel, v2.organization_id, v2.scope_key, v2.war_system, v2.trade_package_id from av v2 where v2.trade_package_id is not null
),
-- return WAR of those packages, once per package (a package counts once per class)
rw as (
  select p.channel, p.organization_id, p.scope_key, p.war_system, sum(t.return_war_known) as return_war_known
  from pk p join trm t on t.package_id = p.trade_package_id and t.war_system = p.war_system
  group by p.channel, p.organization_id, p.scope_key, p.war_system
),
-- packages that also sent a player who is not an acquisition of this class (shared with another class)
sh as (
  select p.channel, p.organization_id, p.scope_key, p.war_system, count(*)::integer as shared
  from pk p join trm t on t.package_id = p.trade_package_id and t.war_system = p.war_system
  where exists (select 1 from unnest(t.sent_player_ids) sp(pid) where not exists (select 1 from ae e2
          where e2.player_id = sp.pid and e2.channel = p.channel and e2.organization_id = p.organization_id and e2.scope_key = p.scope_key))
  group by p.channel, p.organization_id, p.scope_key, p.war_system
),
g as (
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
         (count(distinct v.trade_package_id))::integer as trade_packages,
         sum(v.acquisition_cost_usd) filter (where v.credited) as known_cost_usd,
         (count(*) filter (where v.credited and v.acquisition_cost_usd is not null))::integer as cost_known
  from av v
  group by v.channel, v.organization_id, v.scope_key, v.war_system
)
select g.channel, g.organization_id, g.scope_key, g.war_system, g.acquisitions, g.credited_acquisitions, g.war_covered, g.war_not_observed, g.tenure_end_unknown,
       g.original_org_war_known, g.other_org_war_known, g.returning_stint_war_known, g.original_org_war_total, g.other_org_war_total,
       rw.return_war_known as trade_return_war_known,
       g.trade_packages,
       coalesce(sh.shared, 0) as trade_packages_shared,
       g.known_cost_usd, g.cost_known
from g
left join rw on rw.channel = g.channel and rw.organization_id = g.organization_id and rw.scope_key = g.scope_key and rw.war_system = g.war_system
left join sh on sh.channel = g.channel and sh.organization_id = g.organization_id and sh.scope_key = g.scope_key and sh.war_system = g.war_system;

revoke all on all tables in schema analytics from public, anon, authenticated, service_role;
