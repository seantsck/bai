-- R8C PROOF OF CONCEPT (design only): private corroborating evidence. NOT a migration: it lives under docs/, is applied only to DISPOSABLE local databases by
-- tests/db/r8c-private-evidence.test.mjs, and nothing here may be applied to a hosted database without a separate, numbered, owner-authorized migration.
--
-- What it demonstrates, with FICTIONAL fixtures only:
--   * a schema no website role or Data API role can see (no grant, no exposed schema, row level security with no policy),
--   * the authentic identity, category, origin group and lineage of every source, and the permission basis for keeping it,
--   * append-only history (items, reviews and permission events are never updated or deleted; a change is a new row that supersedes),
--   * review only by an enrolled human in their own login session, never by the proposer, and only while the certification gate is open and the source's private use is permitted,
--   * permission withdrawal suspends the evidence automatically (derived from the latest event, not from a flag someone must remember to set),
--   * nothing here writes to public.transaction_sources, research.transaction_verifications or any read model: private corroboration can never become a public VERIFIED_COMPLETE.
create schema evidence_private;
revoke all on schema evidence_private from public;

-- 1. Who a source IS. Identity is immutable; the category is the same vocabulary as public.sources.attribution_category and is never relabelled.
create table evidence_private.source_identity (
  id bigint generated always as identity primary key,
  canonical_url text not null unique check (canonical_url ~ '^https://[^/@:?#]+(/[^?#]*)?$' and length(canonical_url) <= 500),
  publisher text not null check (length(btrim(publisher)) between 2 and 120),
  category text not null check (category in ('MLB', 'BASEBALL_REFERENCE', 'OTHER_PUBLICATION', 'RETROSHEET', 'WIKIPEDIA', 'WIKIDATA', 'CHADWICK_REGISTER', 'BAI_RESEARCH')),
  origin_group text not null check (origin_group ~ '^[a-z0-9][a-z0-9_.:-]{1,80}$'),                      -- the independence lineage: sources that repeat one act share a group
  lineage_note text not null check (length(btrim(lineage_note)) >= 10 and length(lineage_note) <= 500),
  registered_by name not null default session_user,
  registered_at timestamptz not null default now()
);

-- 2. What BAI may do with it privately. Terms are a human judgement recorded with their basis; the database does not verify them. The current state is the LATEST event.
create table evidence_private.permission_event (
  id bigint generated always as identity primary key,
  source_identity_id bigint not null references evidence_private.source_identity (id),
  event text not null check (event in ('PRIVATE_USE_PERMITTED', 'PRIVATE_USE_WITHDRAWN')),
  basis_reference text not null check (length(btrim(basis_reference)) >= 10),                               -- a pointer to the terms, licence or written permission, never its text
  scope_note text not null check (length(btrim(scope_note)) >= 10),                                          -- what is permitted: citation metadata only, notes in our words, no copied text
  recorded_by name not null default session_user,
  recorded_at timestamptz not null default now()
);
create view evidence_private.source_permission with (security_invoker = true) as
  select distinct on (source_identity_id) source_identity_id, event = 'PRIVATE_USE_PERMITTED' as permitted, basis_reference, recorded_at
  from evidence_private.permission_event order by source_identity_id, id desc;

-- 3. A proposed piece of evidence: citation metadata and OUR OWN words only. There is deliberately no column for source text, a screenshot or a dataset.
create table evidence_private.item (
  id bigint generated always as identity primary key,
  transaction_id bigint not null references public.transactions (id) on delete restrict,
  source_identity_id bigint not null references evidence_private.source_identity (id),
  role text not null check (role in ('PRIMARY_ANNOUNCEMENT', 'CORROBORATION', 'REFERENCE')),
  locator text not null check (length(btrim(locator)) between 1 and 200),
  retrieved_on date not null check (retrieved_on <= current_date),
  trade_package_id bigint references public.trade_packages (id) on delete restrict,
  trade_package_asset_id bigint references public.trade_package_assets (id) on delete restrict,
  our_note text check (length(our_note) <= 500),                                                              -- our paraphrase of what the source supports, never a quotation
  independence text not null check (independence in ('UNASSESSED', 'LIKELY_DERIVED', 'LIKELY_INDEPENDENT')),  -- a proposal can say no more; confirmation is a review
  proposed_by name not null default session_user,
  proposed_at timestamptz not null default now(),
  supersedes_id bigint references evidence_private.item (id),
  check (num_nonnulls(trade_package_id, trade_package_asset_id) = 1)
);

-- 4. A human decision about one item. The reviewer is the enrolled human of THIS login session.
create table evidence_private.item_review (
  id bigint generated always as identity primary key,
  item_id bigint not null references evidence_private.item (id),
  decision text not null check (decision in ('ACCEPTED_FOR_INTERNAL_USE', 'REJECTED')),
  independence_confirmed text not null check (independence_confirmed in ('CONFIRMED_INDEPENDENT', 'CONFIRMED_DERIVED', 'NOT_ASSESSED')),
  reviewer text not null,
  reviewer_session_role name not null default session_user,
  reviewed_at timestamptz not null default now(),
  note text not null check (length(btrim(note)) >= 10),
  check (decision <> 'ACCEPTED_FOR_INTERNAL_USE' or independence_confirmed <> 'NOT_ASSESSED')
);

create function evidence_private.append_only() returns trigger language plpgsql set search_path = pg_catalog as $$
begin raise exception '% is append-only: record a new row that supersedes this one', tg_table_schema || '.' || tg_table_name using errcode = 'check_violation'; end $$;
create trigger source_identity_append_only before update or delete on evidence_private.source_identity for each row execute function evidence_private.append_only();
create trigger permission_event_append_only before update or delete on evidence_private.permission_event for each row execute function evidence_private.append_only();
create trigger item_append_only before update or delete on evidence_private.item for each row execute function evidence_private.append_only();
create trigger item_review_append_only before update or delete on evidence_private.item_review for each row execute function evidence_private.append_only();
create trigger source_identity_no_truncate before truncate on evidence_private.source_identity for each statement execute function evidence_private.append_only();
create trigger permission_event_no_truncate before truncate on evidence_private.permission_event for each statement execute function evidence_private.append_only();
create trigger item_no_truncate before truncate on evidence_private.item for each statement execute function evidence_private.append_only();
create trigger item_review_no_truncate before truncate on evidence_private.item_review for each statement execute function evidence_private.append_only();

-- An item must be consistent with its transaction and may only be proposed while the source's private use is permitted; an independent claim needs another origin group than the transaction's cited sources.
create function evidence_private.item_guard() returns trigger language plpgsql security definer set search_path = pg_catalog, public, evidence_private as $$
declare s evidence_private.source_identity; own_group text[];
begin
  select * into s from evidence_private.source_identity where id = new.source_identity_id;
  if not coalesce((select permitted from evidence_private.source_permission where source_identity_id = new.source_identity_id), false) then
    raise exception 'private use of this source is not permitted (no permission event, or withdrawn)' using errcode = 'check_violation'; end if;
  if new.trade_package_id is not null and not exists (select 1 from public.trade_packages k where k.id = new.trade_package_id and k.transaction_id = new.transaction_id) then
    raise exception 'the package does not belong to this transaction' using errcode = 'check_violation'; end if;
  if new.trade_package_asset_id is not null and not exists (select 1 from public.trade_package_assets a join public.trade_packages k on k.id = a.trade_package_id where a.id = new.trade_package_asset_id and k.transaction_id = new.transaction_id) then
    raise exception 'the asset does not belong to this transaction' using errcode = 'check_violation'; end if;
  select array_agg(distinct t.independence_group) into own_group from public.transaction_sources t where t.transaction_id = new.transaction_id;
  if new.independence = 'LIKELY_INDEPENDENT' and s.origin_group = any (coalesce(own_group, '{}')) then
    raise exception 'an item from origin group % cannot be independent of the transaction''s own cited source in that group', s.origin_group using errcode = 'check_violation'; end if;
  if new.independence = 'LIKELY_INDEPENDENT' and s.category in ('RETROSHEET', 'BASEBALL_REFERENCE', 'CHADWICK_REGISTER') then
    raise exception '% records are partly derived from the origin and cannot be proposed as independent', s.category using errcode = 'check_violation'; end if;
  return new;
end $$;
create trigger item_guard before insert on evidence_private.item for each row execute function evidence_private.item_guard();

create function evidence_private.review_guard() returns trigger language plpgsql security definer set search_path = pg_catalog, public, research, evidence_private as $$
declare i evidence_private.item;
begin
  select * into i from evidence_private.item where id = new.item_id;
  if not research.certification_enabled() then raise exception 'review is disabled (research.certification_gate)' using errcode = 'insufficient_privilege'; end if;
  if research.session_reviewer() is null or new.reviewer is distinct from research.session_reviewer() then
    raise exception 'review needs an enrolled human reviewer in their own authenticated session (session %)', session_user using errcode = 'insufficient_privilege'; end if;
  if i.proposed_by = session_user then raise exception 'the proposer cannot review their own item' using errcode = 'insufficient_privilege'; end if;
  if not coalesce((select permitted from evidence_private.source_permission where source_identity_id = i.source_identity_id), false) then
    raise exception 'private use of this source is not permitted (withdrawn)' using errcode = 'check_violation'; end if;
  if exists (select 1 from evidence_private.item n where n.supersedes_id = i.id) then raise exception 'this item has been superseded; review the newer item' using errcode = 'check_violation'; end if;
  if new.decision = 'ACCEPTED_FOR_INTERNAL_USE' and new.independence_confirmed = 'CONFIRMED_INDEPENDENT' and i.independence = 'LIKELY_DERIVED' then
    raise exception 'a proposal marked LIKELY_DERIVED cannot be confirmed independent without a new item' using errcode = 'check_violation'; end if;
  new.reviewer_session_role := session_user;
  return new;
end $$;
create trigger item_review_guard before insert on evidence_private.item_review for each row execute function evidence_private.review_guard();

-- The CURRENT standing of an item, derived: SUSPENDED when the source's private use was withdrawn, SUPERSEDED by a newer item, else the latest review or PROPOSED. Never a stored flag.
create view evidence_private.item_standing with (security_invoker = true) as
  select i.id as item_id, i.transaction_id, i.source_identity_id,
    case when not coalesce(p.permitted, false) then 'SUSPENDED'
         when exists (select 1 from evidence_private.item n where n.supersedes_id = i.id) then 'SUPERSEDED'
         else coalesce((select r.decision from evidence_private.item_review r where r.item_id = i.id order by r.id desc limit 1), 'PROPOSED') end as standing
  from evidence_private.item i left join evidence_private.source_permission p on p.source_identity_id = i.source_identity_id;

-- INTERNAL status only. It never feeds the public read models and never calls research.verify_transaction: PRIVATELY_CORROBORATED is a research note for reviewers.
create view evidence_private.internal_corroboration with (security_invoker = true) as
  select t.id as transaction_id,
    (select count(distinct s.origin_group) from evidence_private.item_standing st join evidence_private.item i on i.id = st.item_id join evidence_private.source_identity s on s.id = i.source_identity_id
      where st.transaction_id = t.id and st.standing = 'ACCEPTED_FOR_INTERNAL_USE') as accepted_origin_groups,
    'INTERNAL_ONLY_NOT_PUBLIC_STATUS'::text as status_note
  from public.transactions t;

-- Boundary: no website or Data API role touches the schema (row level security with no policy is the second lock).
alter table evidence_private.source_identity enable row level security;
alter table evidence_private.permission_event enable row level security;
alter table evidence_private.item enable row level security;
alter table evidence_private.item_review enable row level security;
revoke all on all tables in schema evidence_private from public, anon, authenticated, service_role;
revoke all on all functions in schema evidence_private from public, anon, authenticated, service_role;

-- Who may do what (private, internal roles only; the website roles above stay locked out).
--   * the database owner registers sources and records permission events (a legal/permission judgement, never automation);
--   * a proposer (research automation, or a person) may only INSERT items; they cannot review them;
--   * an enrolled reviewer may read everything and INSERT reviews, subject to review_guard.
grant usage on schema evidence_private to bai_automation, bai_reviewer;
grant select on all tables in schema evidence_private to bai_automation, bai_reviewer;
grant insert on evidence_private.item to bai_automation, bai_reviewer;
grant insert on evidence_private.item_review to bai_reviewer;
create policy read_internal on evidence_private.source_identity for select to bai_automation, bai_reviewer using (true);
create policy read_internal on evidence_private.permission_event for select to bai_automation, bai_reviewer using (true);
create policy read_internal on evidence_private.item for select to bai_automation, bai_reviewer using (true);
create policy read_internal on evidence_private.item_review for select to bai_automation, bai_reviewer using (true);
create policy propose on evidence_private.item for insert to bai_automation, bai_reviewer with check (true);
create policy review on evidence_private.item_review for insert to bai_reviewer with check (true);
