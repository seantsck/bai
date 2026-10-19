-- Foundation test fixtures. FICTIONAL players, cited to a TEST_FIXTURE source. Not research data; never load into a research
-- or production database. The rows exist only to prove the schema handles each required shape:
--   * one international acquisition                         (Fixture Amateur Signee -> LAD, 2019-20 period)
--   * one draft pick that signed                            (Fixture College Arm -> LAD, 2019 round 1)
--   * one draft pick that did not sign                      (Fixture Two-Time Draftee -> NYY, 2018 round 3)
--   * one player drafted twice                              (Fixture Two-Time Draftee -> SEA, 2021 round 2, signed)
--   * one organization with both channels                   (LAD)
--   * one transaction / value chain                         (LAD trades Fixture College Arm to SEA for Fixture Trade Return)
-- Dollar amounts, dates and WAR values are arbitrary test values.

insert into sources (source_key, source_type, title, notes)
values ('fixture:foundation', 'TEST_FIXTURE', 'BAI foundation test fixture', 'Fictional rows for schema tests.');

insert into markets (market_key, name, region, slug) values ('DOM', 'Dominican Republic', 'Caribbean', 'dominican-republic');

-- Signing periods and drafts are the sourced reference calendars seeded by 015; fixtures only reference them.

insert into players (slug, full_name, display_name, birth_date, birth_date_precision, birth_country, primary_position) values
  ('fixture-amateur-signee', 'Fixture Amateur Signee', 'Fixture Amateur Signee', date '2003-03-01', 'DAY', 'Dominican Republic', 'SS'),
  ('fixture-college-arm', 'Fixture College Arm', 'Fixture College Arm', date '1998-05-10', 'DAY', 'USA', 'RHP'),
  ('fixture-two-time-draftee', 'Fixture Two-Time Draftee', 'Fixture Two-Time Draftee', date '2000-01-15', 'DAY', 'USA', 'OF'),
  ('fixture-trade-return', 'Fixture Trade Return', 'Fixture Trade Return', date '1997-09-09', 'DAY', 'USA', 'C');

insert into player_aliases (player_id, alias, alias_type, source_id)
select id, 'Fixture A. Signee', 'NAME_ORDER_VARIANT', (select id from sources where source_key = 'fixture:foundation')
from players where slug = 'fixture-amateur-signee';

insert into player_external_ids (player_id, id_system, external_id, source_id)
select p.id, 'MLBAM', x.ext, (select id from sources where source_key = 'fixture:foundation')
from players p join (values ('fixture-amateur-signee', '9900001'), ('fixture-college-arm', '9900002'),
                            ('fixture-two-time-draftee', '9900003'), ('fixture-trade-return', '9900004')) x (slug, ext) using (slug);

-- International acquisition (bonus known, fees known zero, other cost unknown -> PARTIAL)
insert into international_signings (player_id, organization_id, signing_period_id, signing_date, signing_date_precision, pathway, market_id,
                                    birth_country, position, age_at_signing, age_basis, signing_bonus_usd, posting_fee_usd, transfer_fee_usd, source_id)
values ((select id from players where slug = 'fixture-amateur-signee'), (select id from organizations where franchise_key = 'LAD'),
        (select id from international_signing_periods where period_key = '2019-20'), date '2019-07-02', 'DAY', 'INTERNATIONAL_AMATEUR',
        (select id from markets where market_key = 'DOM'), 'Dominican Republic', 'SS', 16.3, 'BIRTH_DATE_AND_SIGNING_DATE',
        1000000, 0, 0, (select id from sources where source_key = 'fixture:foundation'));

-- Schools
insert into schools (slug, name, school_type, city, region, country) values
  ('fixture-state-university', 'Fixture State University', 'COLLEGE', 'Fixture City', 'CA', 'USA'),
  ('fixture-high-school', 'Fixture High School', 'HIGH_SCHOOL', 'Fixture Town', 'TX', 'USA');
insert into school_aliases (school_id, alias) select id, 'Fixture State' from schools where slug = 'fixture-state-university';

-- Drafts and rounds (structure recorded per draft)
insert into draft_rounds (draft_id, round_code, round_order, phase)
select d.id, r.code, r.ord, 'REGULAR' from drafts d
join (values ('2018-JUNE_AMATEUR', '3', 5), ('2019-JUNE_AMATEUR', '1', 1), ('2021-JUNE_AMATEUR', '2', 3)) r (draft_key, code, ord) using (draft_key);

insert into draft_selections (draft_id, round_id, overall_pick, round_pick, organization_id, player_id, position, school_id, school_type_at_selection, selection_date, source_id)
select d.id, r.id, x.overall, x.rpick, o.id, p.id, x.pos, sc.id, sc.school_type, x.sel_date, (select id from sources where source_key = 'fixture:foundation')
from (values ('2019-JUNE_AMATEUR', '1', 25, 25, 'LAD', 'fixture-college-arm', 'RHP', 'fixture-state-university', date '2019-06-03'),
             ('2018-JUNE_AMATEUR', '3', 90, 10, 'NYY', 'fixture-two-time-draftee', 'OF', 'fixture-high-school', date '2018-06-05'),
             ('2021-JUNE_AMATEUR', '2', 50, 15, 'SEA', 'fixture-two-time-draftee', 'OF', 'fixture-state-university', date '2021-07-12'))
     x (draft_key, round_code, overall, rpick, org, slug, pos, school, sel_date)
join drafts d on d.draft_key = x.draft_key
join draft_rounds r on r.draft_id = d.id and r.round_code = x.round_code
join organizations o on o.franchise_key = x.org
join players p on p.slug = x.slug
join schools sc on sc.slug = x.school;

insert into slot_values (draft_id, overall_pick, slot_value_usd, source_id)
select id, 25, 2500000, (select id from sources where source_key = 'fixture:foundation') from drafts where draft_key = '2019-JUNE_AMATEUR';

insert into draft_signings (draft_selection_id, signing_status, signing_bonus_usd, signing_date, signing_date_precision, source_id)
select s.id, x.status::draft_signing_status, x.bonus, x.signed_on, x.prec::date_precision, (select id from sources where source_key = 'fixture:foundation')
from (values ('2019-JUNE_AMATEUR', 25, 'SIGNED', 2400000::numeric, date '2019-06-20', 'DAY'),
             ('2018-JUNE_AMATEUR', 90, 'DID_NOT_SIGN', null, null, null),
             ('2021-JUNE_AMATEUR', 50, 'SIGNED', 1100000, date '2021-07-25', 'DAY')) x (draft_key, overall, status, bonus, signed_on, prec)
join drafts d on d.draft_key = x.draft_key
join draft_selections s on s.draft_id = d.id and s.overall_pick = x.overall;

-- Acquisition-time expectations (published before each acquisition)
insert into ranking_lists (source_id, domain, list_kind, list_name, scope_key, published_date, list_size)
values ((select id from sources where source_key = 'fixture:foundation'), 'DRAFT', 'PUBLICATION_RANKING', 'Fixture Draft Top 100', '2019', date '2019-05-20', 100),
       ((select id from sources where source_key = 'fixture:foundation'), 'INTERNATIONAL', 'PUBLICATION_RANKING', 'Fixture International Top 50', '2019-20', date '2019-06-01', 50);
insert into ranking_entries (ranking_list_id, player_id, rank)
values ((select id from ranking_lists where list_name = 'Fixture Draft Top 100'), (select id from players where slug = 'fixture-college-arm'), 30),
       ((select id from ranking_lists where list_name = 'Fixture International Top 50'), (select id from players where slug = 'fixture-amateur-signee'), 10);
insert into evaluations (source_id, domain, player_id, published_date, future_value)
values ((select id from sources where source_key = 'fixture:foundation'), 'DRAFT', (select id from players where slug = 'fixture-college-arm'), date '2019-05-20', 45);
insert into evaluation_grades (evaluation_id, skill, present_grade, future_grade)
select id, 'FASTBALL', 55, 60 from evaluations where player_id = (select id from players where slug = 'fixture-college-arm');

insert into acquisition_expectation_links (draft_selection_id, ranking_entry_id)
select s.id, e.id from draft_selections s join ranking_entries e on e.player_id = s.player_id
where s.player_id = (select id from players where slug = 'fixture-college-arm');
insert into acquisition_expectation_links (international_signing_id, ranking_entry_id)
select i.id, e.id from international_signings i join ranking_entries e on e.player_id = i.player_id;

-- Development
insert into affiliates (slug, name, city) values ('fixture-aa-club', 'Fixture AA Club', 'Fixture City'), ('fixture-aaa-club', 'Fixture AAA Club', 'Fixture Bay');
insert into affiliate_seasons (affiliate_id, organization_id, season, level, source_id)
select a.id, o.id, x.season, x.lvl::development_level, (select id from sources where source_key = 'fixture:foundation')
from (values ('fixture-aa-club', 'LAD', 2022, 'AA'), ('fixture-aaa-club', 'SEA', 2023, 'AAA')) x (slug, org, season, lvl)
join affiliates a on a.slug = x.slug join organizations o on o.franchise_key = x.org;
insert into player_assignments (player_id, organization_id, affiliate_id, level, season, start_date, end_date, date_precision, games, source_id)
select (select id from players where slug = 'fixture-college-arm'), o.id, a.id, x.lvl::development_level, x.season, x.s, x.e, 'DAY', x.g,
       (select id from sources where source_key = 'fixture:foundation')
from (values ('LAD', 'fixture-aa-club', 'AA', 2022, date '2022-04-08', date '2022-07-20', 18),
             ('SEA', 'fixture-aaa-club', 'AAA', 2023, date '2023-03-31', date '2023-05-31', 10)) x (org, aff, lvl, season, s, e, g)
join organizations o on o.franchise_key = x.org join affiliates a on a.slug = x.aff;
insert into development_events (player_id, organization_id, event_type, event_date, from_level, to_level, source_id)
values ((select id from players where slug = 'fixture-college-arm'), (select id from organizations where franchise_key = 'SEA'),
        'PROMOTED', date '2023-06-01', 'AAA', 'MLB', (select id from sources where source_key = 'fixture:foundation'));

-- Transaction / value chain: LAD sends Fixture College Arm to SEA for Fixture Trade Return
insert into transactions (transaction_type, transaction_date, description, source_id)
values ('TRADE', date '2022-08-01', 'Fixture trade: LAD <-> SEA', (select id from sources where source_key = 'fixture:foundation'));
insert into trade_packages (transaction_id, from_organization_id, to_organization_id)
select t.id, f.id, o.id from transactions t, organizations f, organizations o
where t.description = 'Fixture trade: LAD <-> SEA' and ((f.franchise_key, o.franchise_key) in (('LAD', 'SEA'), ('SEA', 'LAD')));
insert into trade_package_assets (trade_package_id, asset_type, player_id)
select tp.id, 'PLAYER', p.id from trade_packages tp
join organizations f on f.id = tp.from_organization_id
join players p on p.slug = case f.franchise_key when 'LAD' then 'fixture-college-arm' else 'fixture-trade-return' end;

-- Outcomes
insert into mlb_debuts (player_id, debut_date, debut_organization_id, source_id)
values ((select id from players where slug = 'fixture-college-arm'), date '2023-06-01', (select id from organizations where franchise_key = 'SEA'), (select id from sources where source_key = 'fixture:foundation')),
       ((select id from players where slug = 'fixture-trade-return'), date '2022-09-01', (select id from organizations where franchise_key = 'LAD'), (select id from sources where source_key = 'fixture:foundation'));
insert into outcome_audits (player_id, audit_state, observation_through_season, audited_on, source_id)
select p.id, x.state::outcome_audit_state, 2025, date '2026-01-15', (select id from sources where source_key = 'fixture:foundation')
from (values ('fixture-college-arm', 'AUDITED_REACHED_MLB'), ('fixture-trade-return', 'AUDITED_REACHED_MLB'),
             ('fixture-two-time-draftee', 'ACTIVE_TOO_RECENT')) x (slug, state)
join players p on p.slug = x.slug;
-- Fixture Amateur Signee deliberately has no audit (NOT_AUDITED) and no WAR (unknown, not zero).

insert into war_observations (player_id, war_system, scope, organization_id, through_season, war_value, observed_on, source_id)
select p.id, 'BREF', x.scope::war_scope, o.id, 2025, x.war, date '2026-01-15', (select id from sources where source_key = 'fixture:foundation')
from (values ('fixture-college-arm', 'CAREER', null, 3.5), ('fixture-college-arm', 'ORGANIZATION_TENURE', 'SEA', 3.5),
             ('fixture-trade-return', 'CAREER', null, 2.0), ('fixture-trade-return', 'ORGANIZATION_TENURE', 'LAD', 1.5)) x (slug, scope, org, war)
join players p on p.slug = x.slug left join organizations o on o.franchise_key = x.org;

insert into organization_value_attributions (organization_id, value_class, acquired_player_id, trade_package_id, war_observation_id, basis_note, source_id)
select lad.id, 'TRADE_RETURN', arm.id, tp.id, w.id, 'Return for Fixture College Arm, LAD tenure', (select id from sources where source_key = 'fixture:foundation')
from organizations lad, players arm, players ret, trade_packages tp, war_observations w
where lad.franchise_key = 'LAD' and arm.slug = 'fixture-college-arm' and ret.slug = 'fixture-trade-return'
  and tp.from_organization_id = lad.id and w.player_id = ret.id and w.scope = 'ORGANIZATION_TENURE';
insert into organization_value_attributions (organization_id, value_class, acquired_player_id, war_observation_id, basis_note, source_id)
select lad.id, 'VALUE_LEFT_ORGANIZATION', arm.id, w.id, 'Fixture College Arm value produced with SEA', (select id from sources where source_key = 'fixture:foundation')
from organizations lad, players arm, war_observations w
where lad.franchise_key = 'LAD' and arm.slug = 'fixture-college-arm' and w.player_id = arm.id and w.scope = 'ORGANIZATION_TENURE';
insert into organization_value_attributions (organization_id, value_class, acquired_player_id, war_observation_id, basis_note, source_id)
select sea.id, 'DIRECT_ACQUIRING_ORGANIZATION', arm.id, w.id, 'Acquired by trade', (select id from sources where source_key = 'fixture:foundation')
from organizations sea, players arm, war_observations w
where sea.franchise_key = 'SEA' and arm.slug = 'fixture-college-arm' and w.player_id = arm.id and w.scope = 'ORGANIZATION_TENURE';

-- Coverage
insert into coverage_assessments (domain, scope_key, organization_id, coverage_state, tracked_count, expected_count, sample_basis, assessed_on, source_id)
values ('DRAFT', '2019-JUNE_AMATEUR', (select id from organizations where franchise_key = 'LAD'), 'INDIVIDUALLY_VERIFIED', 1, null, null, date '2026-10-01',
        (select id from sources where source_key = 'fixture:foundation')),
       ('INTERNATIONAL', '2019-20', (select id from organizations where franchise_key = 'LAD'), 'RANKED_SAMPLE', 1, null, 'Fixture International Top 50', date '2026-10-01',
        (select id from sources where source_key = 'fixture:foundation'));

insert into research_tasks (task_type, domain, title, player_id)
select 'AUDIT_OUTCOME', 'OUTCOMES', 'Audit outcome for fixture amateur signee', id from players where slug = 'fixture-amateur-signee';
