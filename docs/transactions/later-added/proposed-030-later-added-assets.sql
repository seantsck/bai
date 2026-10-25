-- PROPOSAL, NOT A MIGRATION: later-added trade assets and transaction amendments (docs/transactions/later-added/proposal.md).
-- It is a separately reviewable draft for a future migration 030 on top of 028 (transaction foundation) and 029 (value view scale). It is
-- NOT in database/migrations, is not applied anywhere, and tests/db/later-added-proposal.test.mjs applies it to a disposable database to prove
-- it behaves as described. Nothing here reinterprets an existing record: with both new tables empty, every existing view returns the same rows.
--
-- Four situations stay distinguishable:
--   ORIGINAL            an asset of the transaction on its own date (public.trade_package_assets, unchanged)
--   PTBNL resolution    a placeholder asset named later by a dated, sourced row (public.ptbnl_resolutions, unchanged, migration 028)
--   ADDED_TO_TRADE      a player the source says was added to the trade afterwards (Retrosheet type Tp)  -> trade_asset_additions
--   ADDED_LATER_UNSTATED a player recorded under the trade after its date with no placeholder and no stated reason -> trade_asset_additions
--   amendment           a dated change to the transaction itself: a condition met or not met, an asset substituted or removed, a void or return
--                       (public.transaction_amendments, append-only in spirit: rows are facts with a date and a source)

create table public.trade_asset_additions (
  id bigint generated always as identity primary key,
  trade_package_id bigint not null references public.trade_packages (id) on delete cascade,   -- the direction the player was added to
  player_id bigint not null references public.players (id),
  addition_kind text not null check (addition_kind in ('ADDED_TO_TRADE', 'ADDED_LATER_UNSTATED')),
  added_on date not null,
  added_on_precision public.date_precision not null default 'DAY',
  source_id bigint not null references public.sources (id),
  locator text,
  notes text,
  created_at timestamptz not null default now(),
  unique (trade_package_id, player_id)
);

create function public.trade_asset_addition_guard() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_date date;
begin
  select t.transaction_date into v_date from public.trade_packages k join public.transactions t on t.id = k.transaction_id where k.id = new.trade_package_id;
  if new.added_on < v_date then
    raise exception 'a player cannot be added to a trade (%) before the trade (%)', new.added_on, v_date using errcode = 'check_violation';
  end if;
  -- counted once: not an original asset and not the resolution of a PTBNL of the same package
  if exists (select 1 from public.trade_package_assets o where o.trade_package_id = new.trade_package_id and o.player_id = new.player_id)
     or exists (select 1 from public.ptbnl_resolutions r join public.trade_package_assets o on o.id = r.trade_package_asset_id
                where o.trade_package_id = new.trade_package_id and r.resolved_player_id = new.player_id) then
    raise exception 'player % is already part of this package; an added player is counted once', new.player_id using errcode = 'unique_violation';
  end if;
  return new;
end $$;
create trigger trade_asset_additions_guard before insert or update on public.trade_asset_additions for each row execute function public.trade_asset_addition_guard();

create table public.transaction_amendments (
  id bigint generated always as identity primary key,
  transaction_id bigint not null references public.transactions (id) on delete cascade,
  amendment_kind text not null check (amendment_kind in ('CONDITION_MET', 'CONDITION_NOT_MET', 'ASSET_SUBSTITUTED', 'PLAYER_REMOVED', 'TRADE_VOIDED', 'TRADE_RETURNED')),
  effective_on date not null,
  effective_on_precision public.date_precision not null default 'DAY',
  trade_package_asset_id bigint references public.trade_package_assets (id) on delete cascade,   -- the conditional asset, where the amendment is about one
  source_id bigint not null references public.sources (id),
  locator text,
  notes text,
  created_at timestamptz not null default now(),
  check (amendment_kind not in ('CONDITION_MET', 'CONDITION_NOT_MET') or trade_package_asset_id is not null)
);

create function public.transaction_amendment_guard() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_date date;
  a record;
begin
  select transaction_date into v_date from public.transactions where id = new.transaction_id;
  if new.effective_on < v_date then raise exception 'an amendment (%) cannot predate the transaction (%)', new.effective_on, v_date using errcode = 'check_violation'; end if;
  if new.trade_package_asset_id is not null then
    select x.conditional, k.transaction_id into a from public.trade_package_assets x join public.trade_packages k on k.id = x.trade_package_id where x.id = new.trade_package_asset_id;
    if a.transaction_id is distinct from new.transaction_id then raise exception 'the asset belongs to another transaction' using errcode = 'check_violation'; end if;
    if new.amendment_kind in ('CONDITION_MET', 'CONDITION_NOT_MET') and not a.conditional then
      raise exception 'only a conditional asset can have its condition met or not met' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;
create trigger transaction_amendments_guard before insert or update on public.transaction_amendments for each row execute function public.transaction_amendment_guard();

-- the helper the value views read gains the added players (effective from the day they were added); with no additions its rows are unchanged
create or replace view analytics.trade_asset_players with (security_invoker = true) as
select a.id, a.trade_package_id, a.asset_type,
       coalesce(a.player_id, r.resolved_player_id) as player_id,
       (a.player_id is null and r.resolved_player_id is not null) as via_ptbnl,
       case when a.player_id is null and r.resolved_player_id is not null then r.resolved_on end as effective_on,
       false as via_addition
from public.trade_package_assets a
left join public.ptbnl_resolutions r on r.trade_package_asset_id = a.id and r.resolution = 'PLAYER'
union all
select -d.id, d.trade_package_id, 'PLAYER', d.player_id, false, d.added_on, true
from public.trade_asset_additions d;

insert into public.provenance_fact_tables (table_name, domain, description) values
  ('trade_asset_additions', 'TRANSACTION', 'A player added to a trade after its date'),
  ('transaction_amendments', 'TRANSACTION', 'A dated change to a transaction (condition, substitution, void, return)')
on conflict (table_name) do nothing;
insert into public.internal_objects values
  ('trade_asset_additions', 'internal until the transaction detail view'), ('transaction_amendments', 'internal until the transaction detail view')
on conflict (object_name) do nothing;
select public.apply_public_boundary();

-- any change to an addition or amendment unverifies the transaction (028 rule), and the fingerprint covers both
create or replace function research.transaction_fingerprint(p_transaction_id bigint) returns text
language plpgsql stable
set search_path = pg_catalog, public, research
as $$
declare
  v text;
begin
  select concat_ws(E'\n',
    (select format('T|%s|%s|%s|%s|%s', t.transaction_type, t.transaction_date, t.date_precision, coalesce(t.description, ''), t.source_id) from public.transactions t where t.id = p_transaction_id),
    (select coalesce(string_agg(format('X|%s|%s|%s|%s', x.scheme, x.external_id, x.source_id, (select so.source_key || '|' || coalesce(so.url, '') from public.sources so where so.id = x.source_id)), E'\n' order by x.scheme, x.external_id), '') from public.transaction_external_ids x where x.transaction_id = p_transaction_id),
    (select coalesce(string_agg(format('S|%s|%s|%s|%s|%s|%s', s.source_id, s.role, s.independence_group, coalesce(s.locator, ''), coalesce(s.retrieved_on::text, ''), (select so.source_key || '|' || coalesce(so.url, '') from public.sources so where so.id = s.source_id)), E'\n' order by s.source_id), '') from public.transaction_sources s where s.transaction_id = p_transaction_id),
    (select coalesce(string_agg(format('K|%s|%s', k.from_organization_id, k.to_organization_id), E'\n' order by k.from_organization_id, k.to_organization_id), '') from public.trade_packages k where k.transaction_id = p_transaction_id),
    (select coalesce(string_agg(format('A|%s>%s|%s|%s|%s|%s|%s|%s|%s|%s', k.from_organization_id, k.to_organization_id, a.asset_type, coalesce(a.player_id::text, ''), coalesce(a.amount_usd::text, ''),
        coalesce(a.amount_disclosure, ''), a.conditional, coalesce(a.condition_text, ''), coalesce(a.description, ''),
        coalesce((select format('%s,%s,%s,%s,%s,%s,%s,%s', r.resolution, coalesce(r.resolved_player_id::text, ''), coalesce(r.amount_usd::text, ''), coalesce(r.amount_disclosure, ''), r.resolved_on, r.resolved_on_precision, r.source_id, coalesce(r.notes, '')) from public.ptbnl_resolutions r where r.trade_package_asset_id = a.id), '')),
        E'\n' order by k.from_organization_id, k.to_organization_id, a.asset_type, coalesce(a.player_id, 0), coalesce(a.description, ''), coalesce(a.condition_text, ''), a.id), '')
       from public.trade_package_assets a join public.trade_packages k on k.id = a.trade_package_id where k.transaction_id = p_transaction_id),
    (select coalesce(string_agg(format('L|%s|%s|%s', l.transaction_source_id, coalesce('P' || l.trade_package_id, 'A' || l.trade_package_asset_id), coalesce(l.locator, '')), E'\n' order by l.transaction_source_id, l.trade_package_id, l.trade_package_asset_id), '')
       from public.transaction_source_links l join public.transaction_sources s on s.id = l.transaction_source_id where s.transaction_id = p_transaction_id),
    (select coalesce(string_agg(format('D|%s>%s|%s|%s|%s|%s|%s|%s', fo.franchise_key, too.franchise_key, d.player_id, d.addition_kind, d.added_on, d.added_on_precision, d.source_id, coalesce(d.locator, '') || coalesce(d.notes, '')),
        E'\n' order by fo.franchise_key, too.franchise_key, d.player_id), '')
       from public.trade_asset_additions d join public.trade_packages k on k.id = d.trade_package_id join public.organizations fo on fo.id = k.from_organization_id join public.organizations too on too.id = k.to_organization_id
       where k.transaction_id = p_transaction_id),
    (select coalesce(string_agg(format('M|%s|%s|%s|%s|%s|%s', m.amendment_kind, m.effective_on, m.effective_on_precision, coalesce(m.trade_package_asset_id::text, ''), m.source_id, coalesce(m.locator, '') || coalesce(m.notes, '')),
        E'\n' order by m.effective_on, m.amendment_kind, m.id), '')
       from public.transaction_amendments m where m.transaction_id = p_transaction_id),
    (select coalesce(string_agg(format('C|%s|%s|%s|%s|%s|%s|%s|%s', c.field_path, c.incoming_sha256, c.status, coalesce(c.existing_value, ''), coalesce(c.incoming_value, ''), coalesce(c.resolved_by, ''), coalesce(c.resolved_at::text, ''), coalesce(c.resolution_note, '')), E'\n' order by c.field_path, c.incoming_sha256), '') from public.transaction_conflicts c where c.transaction_id = p_transaction_id)
  ) into v;
  return encode(sha256(convert_to(v, 'UTF8')), 'hex');
end $$;

create or replace function research.transaction_changed() returns trigger
language plpgsql security definer
set search_path = pg_catalog, public, research
as $$
declare
  v_tx bigint;
begin
  if tg_table_name = 'transactions' then v_tx := case when tg_op = 'DELETE' then old.id else new.id end;
  elsif tg_table_name in ('trade_packages', 'transaction_external_ids', 'transaction_sources', 'transaction_conflicts') then
    v_tx := case when tg_op = 'DELETE' then old.transaction_id else new.transaction_id end;
  elsif tg_table_name = 'trade_package_assets' then
    select transaction_id into v_tx from public.trade_packages where id = case when tg_op = 'DELETE' then old.trade_package_id else new.trade_package_id end;
  elsif tg_table_name = 'transaction_amendments' then
    v_tx := case when tg_op = 'DELETE' then old.transaction_id else new.transaction_id end;
  elsif tg_table_name = 'trade_asset_additions' then
    select transaction_id into v_tx from public.trade_packages where id = case when tg_op = 'DELETE' then old.trade_package_id else new.trade_package_id end;
  elsif tg_table_name = 'transaction_source_links' then
    select transaction_id into v_tx from public.transaction_sources where id = case when tg_op = 'DELETE' then old.transaction_source_id else new.transaction_source_id end;
  elsif tg_table_name = 'ptbnl_resolutions' then
    select k.transaction_id into v_tx from public.trade_package_assets a join public.trade_packages k on k.id = a.trade_package_id
    where a.id = case when tg_op = 'DELETE' then old.trade_package_asset_id else new.trade_package_asset_id end;
  end if;
  -- Resolving a conflict is a deliberate human act on a record that cannot be verified while the conflict is open.
  if tg_table_name = 'transaction_conflicts' and tg_op = 'UPDATE' then
    if old.status = 'OPEN' and new.status = 'RESOLVED' then v_tx := null; end if;
  end if;
  if v_tx is not null then
    update research.transaction_verifications
       set state = 'REVOKED', revoked_at = now(), revoked_by = 'system:evidence-changed', revoked_automatically = true,
           revoked_reason = format('%s on %s changed a verified transaction (session %s)', lower(tg_op), tg_table_name, session_user)
     where transaction_id = v_tx and state = 'ACTIVE';
  end if;
  return null;
end $$;

do $$
declare
  t text;
begin
  foreach t in array array['trade_asset_additions', 'transaction_amendments'] loop
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function research.transaction_changed()', t || '_unverify', t);
  end loop;
end $$;
