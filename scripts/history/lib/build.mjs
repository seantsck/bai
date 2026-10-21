// Normalized historical picks -> bai-research-import/1 DRAFT batches, one per (draft phase, organization). Pure: the same
// picks, crosswalk and evidence always give byte-identical batches (records in pick order, keys in a fixed order), so
// a replay from the cache reproduces the same file checksums and the pipeline recognises already-staged batches.
//
// What is claimed:
//   * Selections, rounds, picks, the drafting franchise, MLBAM identity, name, birth date/country and MLB's school label.
//   * Other systems' ids only from the Chadwick register, attributed to it (external_id_sources).
//   * Signing status: never. Historical signing is not in these sources, so every record is UNKNOWN (not unsigned).
//   * Coverage: COMPLETE_CENSUS only when an independent source gives the same per-club count and nothing was held;
//     otherwise PARTIAL_RECONSTRUCTION with the reason. One feed's row count is never treated as the population.

export function sourceKeys (year, code, commit) {
  return { mlb: `hist:mlb-statsapi-draft-${year}-${code.toLowerCase()}`, chadwick: `hist:chadwick-register-${commit.slice(0, 7)}` }
}

/**
 * @param picks       normalized picks of one phase (normalizePhase().picks)
 * @param ctx         { year, code, phase, organizations: [{ franchise_key, mlb_team_id, first_season }], crosswalk: Map, commit,
 *                      mlbEntry: manifest entry of the phase file, chadwickRetrieved, evidence: { [franchise_key]: { count, source, note } } }
 * @returns { batches: [{ org, doc }], unmatchedTeams: [team ids], held: [pick] }
 */
export function buildPhaseBatches (picks, ctx) {
  const keys = sourceKeys(ctx.year, ctx.code, ctx.commit)
  const byTeam = new Map(ctx.organizations.map((o) => [o.mlb_team_id, o]))
  const unmatchedTeams = [...new Set(picks.filter((p) => !byTeam.has(p.team_id)).map((p) => p.team_id))]
  const held = picks.filter((p) => p.hold)
  const batches = []
  for (const org of [...ctx.organizations].sort((a, b) => a.franchise_key.localeCompare(b.franchise_key))) {
    const mine = picks.filter((p) => p.team_id === org.mlb_team_id)
    if (!mine.length) continue
    const importable = mine.filter((p) => !p.hold)
    const heldHere = mine.filter((p) => p.hold)
    const records = importable.map((p) => record(p, org, keys, ctx))
    const ev = ctx.evidence?.[org.franchise_key]
    const corroborated = Boolean(ev?.agrees) && ev.count === mine.length && !heldHere.length
    const claim = {
      domain: 'DRAFT', scope_key: mine[0].draft_key, organization: org.franchise_key,
      coverage_state: corroborated ? 'COMPLETE_CENSUS' : 'PARTIAL_RECONSTRUCTION',
      ...(corroborated ? { expected_count: mine.length } : {}),
      source_key: keys.mlb,
      gap_notes: [
        `MLB's draft feed lists ${mine.length} selection(s) for the club in the ${ctx.phase.label}.`,
        ev ? `Independent count: ${ev.count} (${ev.note}).` : 'No independent per-club count yet: one feed\'s rows are not proof of the population.',
        heldHere.length ? `Held, not imported: ${heldHere.map((p) => `#${p.overall_pick} (${p.hold})`).join('; ')}.` : null,
        'Signing status, bonuses and outcomes not researched.'
      ].filter(Boolean).join(' ')
    }
    const sources = [{
      source_key: keys.mlb, source_type: 'OFFICIAL_LEAGUE', authority_level: 'OFFICIAL',
      title: `MLB Stats API draft endpoint, ${ctx.year} ${ctx.phase.label} (draftType ${ctx.code})`, publisher: 'MLB Advanced Media',
      url: ctx.mlbEntry.url, retrieved_date: ctx.mlbEntry.retrieved_at.slice(0, 10),
      notes: `League-wide JSON, ${picks.length} selections; sha256 ${ctx.mlbEntry.sha256}. Supplies pick, round, franchise-stable team id, MLBAM person, school label. No signing data. Terms: individual, non-commercial, non-bulk use (research/history/sources.json).`
    }]
    if (records.some((r) => r.player.external_id_sources)) {
      sources.push({
        source_key: keys.chadwick, source_type: 'REFERENCE_DATABASE', authority_level: 'AGGREGATOR',
        title: `Chadwick Baseball Bureau Register, commit ${ctx.commit.slice(0, 7)}`, publisher: 'Chadwick Baseball Bureau',
        url: `https://github.com/chadwickbureau/register/tree/${ctx.commit}`, retrieved_date: ctx.chadwickRetrieved,
        notes: 'MLBAM -> Baseball-Reference, Baseball-Reference minors, FanGraphs and Retrosheet ids. Open Data Commons Attribution License 1.0.'
      })
    }
    batches.push({
      org: org.franchise_key,
      doc: {
        format: 'bai-research-import/1',
        batch_key: `hist-${mine[0].draft_key.toLowerCase().replace(/_/g, '-')}-${org.franchise_key.toLowerCase()}`,
        channel: 'DRAFT',
        description: `${org.franchise_key}, ${ctx.year} ${ctx.phase.label}: ${records.length} of ${mine.length} selections from MLB's draft feed (historical importer).`,
        coverage_claims: [claim],
        sources,
        records
      }
    })
  }
  return { batches, unmatchedTeams, held }
}

function record (p, org, keys, ctx) {
  const cw = ctx.crosswalk?.get(p.person.id)
  const ids = { MLBAM: p.person.id }
  const idSources = {}
  for (const [sys, v] of Object.entries(cw?.ids ?? {})) { ids[sys] = v; idSources[sys] = keys.chadwick }
  const player = { full_name: p.person.full_name, birth_date: p.person.birth_date, birth_country: p.person.birth_country, external_ids: ids, source_key: keys.mlb }
  if (Object.keys(idSources).length) player.external_id_sources = idSources
  const rec = {
    type: 'DRAFT_SELECTION', source_key: keys.mlb, draft_key: p.draft_key, round_code: p.round_code, overall_pick: p.overall_pick, round_pick: p.round_pick,
    organization: org.franchise_key, selection_type: p.selection_type, player
  }
  if (p.school) rec.school = { name: p.school.name, school_type: p.school.school_type, city: p.school.city, region: p.school.region, source_key: keys.mlb }
  rec.signing = { status: 'UNKNOWN' }
  rec.notes = `Historical import from MLB's draft feed. Signing status not researched: unknown, not unsigned. School: ${p.school ? p.school.rule : 'no label'}.`
  return rec
}
