// Coverage and rate integrity invariants, shared by the hosted verification suite (npm run hosted:verify) and the local
// tests that prove each one detects a real violation. Every check is a read-only query returning the offending rows; an
// empty result means the invariant holds. The database already enforces some of these with CHECK constraints; these
// queries are the second line, covering derived views and read models that constraints cannot reach.

export const INTEGRITY_CHECKS = [
  {
    key: 'CENSUS_WITHOUT_SOURCED_UNIVERSE',
    description: 'a census-level coverage claim must name its expected size and cite a source',
    sql: `select domain::text, scope_key, organization_id from public.coverage_assessments
      where coverage_state in ('COMPLETE_CENSUS', 'SUBSTANTIALLY_COMPLETE') and (expected_count is null or source_id is null)`
  },
  {
    key: 'COMPLETE_CENSUS_COUNT_MISMATCH',
    description: 'a complete census tracks exactly its expected universe',
    sql: `select domain::text, scope_key, organization_id from public.coverage_assessments
      where coverage_state = 'COMPLETE_CENSUS' and tracked_count is distinct from expected_count`
  },
  {
    key: 'RATE_WITHOUT_CERTIFICATION',
    description: 'an uncertified class publishes no outcome or cost rate',
    sql: `select channel::text, organization_id, scope_key from analytics.class_economics
      where not certified and (rates_allowed or mlb_reach_rate is not null or cost_per_mlb_player is not null)`
  },
  {
    key: 'RATE_WITHOUT_CENSUS',
    description: 'a rate needs census-level coverage, whatever the certification',
    sql: `select channel::text, organization_id, scope_key from analytics.class_economics
      where not coalesce(public.coverage_supports_population_rate(coverage_state), false)
        and (rates_allowed or mlb_reach_rate is not null or cost_per_mlb_player is not null)`
  },
  {
    key: 'PARTIAL_PRESENTED_AS_COMPLETE',
    description: 'the public coverage read model never shows a partial cell as rate-capable or with a different state than assessed',
    sql: `select r.domain::text, r.scope_key, r.organization_id from public.rm_research_coverage r
      left join public.coverage_assessments ca on ca.domain::text = r.domain::text and ca.scope_key = r.scope_key
        and ca.organization_id is not distinct from r.organization_id
      where (r.supports_population_rate and not coalesce(public.coverage_supports_population_rate(r.coverage_state), false))
         or (ca.id is not null and r.coverage_state is distinct from ca.coverage_state)
         or (r.supports_population_rate and ca.id is null)`
  }
]

/** Runs every check; returns [{ key, description, rows }] for the checks that found violations. */
export async function integrityViolations (db) {
  const out = []
  for (const c of INTEGRITY_CHECKS) {
    const rows = (await db.query(c.sql)).rows
    if (rows.length) out.push({ key: c.key, description: c.description, rows })
  }
  return out
}
