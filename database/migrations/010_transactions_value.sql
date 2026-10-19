-- 010_transactions_value
-- Transactions, trade packages and organizational value attribution.
--
-- Value classes are kept apart and one WAR observation can be credited to a given organization at most once, so the same
-- value cannot be counted as both player-attributable and package-attributable. VALUE_LEFT_ORGANIZATION records value an
-- organization gave up; it is never part of that organization's realized total.

create type public.transaction_type as enum ('TRADE', 'RELEASE', 'WAIVER_CLAIM', 'RULE_5', 'PURCHASE', 'FREE_AGENT_DEPARTURE', 'OTHER');

create table public.transactions (
  id bigint generated always as identity primary key,
  transaction_type public.transaction_type not null,
  transaction_date date not null,
  date_precision public.date_precision not null default 'DAY',
  description text,
  source_id bigint not null references public.sources (id),
  created_at timestamptz not null default now()
);
create index transactions_date_idx on public.transactions (transaction_date);

-- One package per direction of a transaction: what from_organization sent to to_organization.
create table public.trade_packages (
  id bigint generated always as identity primary key,
  transaction_id bigint not null references public.transactions (id) on delete cascade,
  from_organization_id bigint not null references public.organizations (id),
  to_organization_id bigint not null references public.organizations (id),
  check (from_organization_id <> to_organization_id),
  unique (transaction_id, from_organization_id, to_organization_id)
);

create type public.trade_asset_type as enum ('PLAYER', 'PLAYER_TO_BE_NAMED', 'CASH', 'DRAFT_PICK', 'INTERNATIONAL_POOL_SPACE', 'OTHER');

create table public.trade_package_assets (
  id bigint generated always as identity primary key,
  trade_package_id bigint not null references public.trade_packages (id) on delete cascade,
  asset_type public.trade_asset_type not null,
  player_id bigint references public.players (id),
  amount_usd numeric(14, 2) check (amount_usd >= 0),        -- cash / pool space; null = undisclosed
  description text,
  check (asset_type <> 'PLAYER' or player_id is not null),
  check (asset_type in ('PLAYER', 'PLAYER_TO_BE_NAMED') or player_id is null)
);
create unique index trade_package_assets_player_once on public.trade_package_assets (trade_package_id, player_id) where player_id is not null;

create type public.value_class as enum (
  'DIRECT_ACQUIRING_ORGANIZATION',     -- MLB value produced for the organization that acquired the player
  'TRADE_RETURN',                      -- value of a player received in exchange for an acquired player
  'PLAYER_ATTRIBUTABLE_DOWNSTREAM',    -- later value traceable to one specific outgoing player
  'PACKAGE_ATTRIBUTABLE',              -- value traceable to a package, not to one player within it
  'OBSERVABLE_NOT_ATTRIBUTABLE',       -- value observed in a chain but not attributable to a package or player
  'VALUE_LEFT_ORGANIZATION'            -- value produced elsewhere after the player left
);

create table public.organization_value_attributions (
  id bigint generated always as identity primary key,
  organization_id bigint not null references public.organizations (id),
  value_class public.value_class not null,
  acquired_player_id bigint references public.players (id),     -- the originally acquired asset the value traces back to
  trade_package_id bigint references public.trade_packages (id),
  war_observation_id bigint not null references public.war_observations (id),
  basis_note text,
  source_id bigint not null references public.sources (id),
  check (value_class not in ('DIRECT_ACQUIRING_ORGANIZATION', 'PLAYER_ATTRIBUTABLE_DOWNSTREAM', 'VALUE_LEFT_ORGANIZATION') or acquired_player_id is not null),
  check (value_class not in ('TRADE_RETURN', 'PACKAGE_ATTRIBUTABLE', 'PLAYER_ATTRIBUTABLE_DOWNSTREAM') or trade_package_id is not null),
  check (value_class <> 'PACKAGE_ATTRIBUTABLE' or acquired_player_id is null),
  -- No double counting: an observation is credited to an organization once, in exactly one class.
  constraint value_attribution_no_double_count unique (organization_id, war_observation_id)
);

insert into public.provenance_fact_tables (table_name, domain, description) values
  ('transactions', 'TRANSACTION', 'Transaction event'),
  ('organization_value_attributions', 'VALUE', 'Organization value attribution')
on conflict (table_name) do nothing;

-- Organization-realized value excludes value that left the organization; it is reported next to it, never summed with it.
create view analytics.organization_value_by_class with (security_invoker = true) as
select v.organization_id, v.value_class, w.war_system, count(*) as observations, sum(w.war_value) as war_total
from public.organization_value_attributions v
join public.war_observations w on w.id = v.war_observation_id
group by v.organization_id, v.value_class, w.war_system;

create view analytics.organization_realized_value with (security_invoker = true) as
select organization_id, war_system,
       sum(war_total) filter (where value_class <> 'VALUE_LEFT_ORGANIZATION') as realized_war,
       sum(war_total) filter (where value_class = 'VALUE_LEFT_ORGANIZATION') as departed_war
from analytics.organization_value_by_class
group by organization_id, war_system;
