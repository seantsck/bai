// Public page queries. Two kinds only:
//   * summaries read the bounded rm_* read models (refreshed by `npm run refresh:read-models`, never by a request);
//   * facts are simple indexed lookups with explicit LIMITs.
// Nothing here touches analytics.* (the public role cannot) or builds nested analytical graphs.
import { publicQuery } from './db.ts'
import { buildExplorerQuery, type ExplorerFilters } from './search.ts'

export const LIST_LIMIT = 200

type Row = Record<string, any>

export const getOverview = async (): Promise<Row | null> =>
  (await publicQuery('select * from rm_overview limit 1'))[0] ?? null

export const getOrganizationSummaries = () =>
  publicQuery('select * from rm_organization_summary order by league, division, name limit 30')

export const getOrganization = async (slug: string): Promise<Row | null> =>
  (await publicQuery(`select o.id, o.franchise_key, o.slug, o.current_name, o.league, o.division, o.mlb_team_id,
      (select json_agg(json_build_object('name', n.name, 'first_season', n.first_season, 'last_season', n.last_season)
                       order by n.first_season nulls first) from organization_names n where n.organization_id = o.id) as names
    from organizations o where o.slug = $1`, [slug]))[0] ?? null

export const getOrganizationSummary = async (organizationId: string | number): Promise<Row | null> =>
  (await publicQuery('select * from rm_organization_summary where organization_id = $1', [organizationId]))[0] ?? null

export const getOrganizationCoverage = (organizationId: string | number) =>
  publicQuery('select * from rm_coverage_summary where organization_id = $1 order by domain, scope_key limit 100', [organizationId])

export const getOrganizationAcquisitions = (organizationId: string | number) =>
  publicQuery(`select a.channel, a.acquisition_id, a.acquisition_date, a.acquisition_kind, a.signing_status, p.slug, p.display_name
    from v_acquisitions a join players p on p.id = a.player_id
    where a.organization_id = $1 order by a.acquisition_date desc nulls last, p.display_name collate "C", a.channel, a.acquisition_id limit ${LIST_LIMIT}`, [organizationId])

export const getPlayers = () =>
  publicQuery(`select slug, display_name, birth_country, primary_position from players order by display_name limit ${LIST_LIMIT}`)

export const getPlayer = async (slug: string): Promise<Row | null> =>
  (await publicQuery(`select p.*, o.audit_state, o.observation_through_season, o.debut_date, o.career_bwar, o.career_bwar_through_season,
      d.slug as debut_organization_slug, d.current_name as debut_organization_name
    from players p join v_player_outcome_status o on o.player_id = p.id
    left join organizations d on d.id = o.debut_organization_id
    where p.slug = $1`, [slug]))[0] ?? null

export const getPlayerAcquisitions = (playerId: string | number) =>
  publicQuery(`select a.channel, a.acquisition_id, a.acquisition_date, a.acquisition_kind, a.signing_status, o.slug as organization_slug, o.current_name as organization_name
    from v_acquisitions a join organizations o on o.id = a.organization_id where a.player_id = $1 order by a.acquisition_date, a.channel, a.acquisition_id limit 50`, [playerId])

export const getPlayerDevelopment = (playerId: string | number) =>
  publicQuery(`select c.season, c.sort_date, c.entry_kind, c.level, c.from_level, c.games, o.current_name as organization_name
    from v_player_development_chronology c join organizations o on o.id = c.organization_id where c.player_id = $1 order by c.sort_date limit 200`, [playerId])

export const getPlayerExternalIds = (playerId: string | number) =>
  publicQuery('select id_system, external_id from player_external_ids where player_id = $1 order by id_system', [playerId])

export const getInternationalSignings = () =>
  publicQuery(`select s.id, s.signing_date, s.signing_date_precision, s.pathway, s.position, s.birth_country, s.signing_bonus_usd, s.posting_fee_usd,
      s.transfer_fee_usd, s.other_cost_usd, s.known_total_cost_usd, s.cost_completeness, p.slug, p.display_name,
      o.slug as organization_slug, o.current_name as organization_name, ip.period_key
    from international_signings s join players p on p.id = s.player_id join organizations o on o.id = s.organization_id
    left join international_signing_periods ip on ip.id = s.signing_period_id
    order by s.signing_date desc nulls last, s.id desc limit ${LIST_LIMIT}`)

export const getSigningPeriods = () =>
  publicQuery(`select ip.period_key, ip.label, ip.start_date, ip.end_date,
      (select count(*) from international_signings s where s.signing_period_id = ip.id)::int as tracked_signings
    from international_signing_periods ip order by ip.start_date desc limit 100`)

export const getMarkets = () =>
  publicQuery(`select m.market_key, m.name, m.region, (select count(*) from international_signings s where s.market_id = m.id)::int as tracked_signings
    from markets m order by m.name limit 300`)

export const getTrainers = () =>
  publicQuery(`select t.slug, t.name, t.country, t.name_basis,
      (select count(*) from player_trainer_relationships r where r.trainer_id = t.id)::int as linked_players
    from trainers t order by t.name limit ${LIST_LIMIT}`)

export const getAcademies = () =>
  publicQuery(`select a.slug, a.name, a.academy_kind, a.country, a.city from academies a order by a.name limit ${LIST_LIMIT}`)

export const getDraftPicks = () =>
  publicQuery(`select p.draft_year, p.round_code, p.phase, p.overall_pick, p.round_pick, p.selection_type, p.position, p.school_type, p.slot_value_usd,
      p.signing_status, p.signing_bonus_usd, pl.slug, pl.display_name, o.slug as organization_slug, o.current_name as organization_name, s.name as school_name
    from v_draft_picks p join players pl on pl.id = p.player_id join organizations o on o.id = p.organization_id
    left join schools s on s.id = p.school_id
    order by p.draft_year desc, p.overall_pick nulls last limit ${LIST_LIMIT}`)

export const getDrafts = () =>
  publicQuery(`select d.draft_key, d.draft_year, d.draft_kind, d.start_date, d.end_date, d.total_rounds,
      (select count(*) from draft_selections s where s.draft_id = d.id)::int as tracked_selections,
      (select count(*) from draft_rounds r where r.draft_id = d.id)::int as recorded_rounds
    from drafts d order by d.draft_year desc, d.draft_kind limit 100`)

export const getSchools = () =>
  publicQuery(`select sc.slug, sc.name, sc.school_type, sc.city, sc.region, sc.country,
      (select count(*) from draft_selections s where s.school_id = sc.id)::int as tracked_selections
    from schools sc order by sc.name limit ${LIST_LIMIT}`)

export const getCoverageSummary = () =>
  publicQuery(`select c.*, o.current_name as organization_name from rm_coverage_summary c left join organizations o on o.id = c.organization_id
    order by c.domain, c.scope_key, o.current_name nulls first limit 500`)

export const getLastRefresh = async (): Promise<Row | null> =>
  (await publicQuery('select generation_id, refreshed_at from rm_overview limit 1'))[0] ?? null

// Coverage dashboard: one bounded row per (draft or signing period) x organization, from the refreshed read model.
export const getResearchCoverage = () =>
  publicQuery(`select c.domain, c.scope_key, c.scope_label, c.scope_start, c.organization_id, o.franchise_key, o.current_name as organization_name,
      c.tracked_records, c.audited_outcomes, c.cost_basis_records, c.cost_known_records, c.coverage_state, c.expected_count,
      c.supports_population_rate, c.last_research_date, coalesce(r.certified, false) as certified, r.certified_on
    from rm_research_coverage c join organizations o on o.id = c.organization_id
    left join rm_research_certification r on r.domain::text = c.domain::text and r.scope_key = c.scope_key and r.organization_id = c.organization_id
    order by c.domain, c.scope_start, o.current_name limit 1000`)

// Queue sizes only; the work items themselves are internal.
export const getResearchQueueSummary = () =>
  publicQuery('select queue_key, priority, description, open_items from rm_research_queue_summary order by priority, queue_key limit 50')

// Historical explorer (024): one bounded, parameterized page of v_draft_explorer (PAGE_SIZE + 1 rows, no count).
export const getDraftExplorer = (f: ExplorerFilters) => {
  const { sql, params } = buildExplorerQuery(f)
  return publicQuery(sql, params)
}

// Per-phase coverage counts from the refreshed read model (no rates). expected_selections is null unless every club that existed has a sourced census.
export const getDraftYearCoverage = () =>
  publicQuery(`select draft_key, draft_year, draft_kind, start_date, start_date_precision, clubs, clubs_with_census, expected_selections,
      imported_selections, identities_resolved, signing_known, bonus_known, outcomes_audited
    from rm_draft_year_coverage order by draft_year desc, draft_kind limit 400`)

export const getOrganizationKeys = () =>
  publicQuery('select franchise_key, current_name from organizations where active order by current_name limit 30')

// Public attribution (025): records and field observations per source group and domain. Counts only.
export const getSourceAttribution = () =>
  publicQuery('select attribution_category, domain, records, sources from v_source_attribution order by attribution_category, domain limit 200')

// Attribution groups of the selections on one explorer page (025). Bounded by the page size; ids are integers.
export const getSelectionAttribution = (ids: number[]) =>
  ids.length ? publicQuery('select selection_id, selection_source_category, signing_source_category from v_selection_attribution where selection_id = any ($1::bigint[]) limit 100', [ids.filter((n) => Number.isInteger(n)).slice(0, 100)]) : Promise.resolve([])
