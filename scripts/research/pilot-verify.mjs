// Pilot verifier. Two jobs, both read-only:
//   1. Expectations: asserts the validated 2015 Dodgers pilot facts (counts, statuses, bonuses, identities, conflicts,
//      provenance, coverage states, queues) against whatever database BAI_DATABASE_URL points at.
//   2. Reconciliation: builds an id-independent snapshot of every research table (surrogate ids replaced by natural
//      keys, timestamps dropped) so a hosted database can be diffed against the known-good local one.
//
//   npm run research:verify-pilot -- [--snapshot out.json] [--compare baseline.json] [--json]
import fs from 'node:fs'
import pg from 'pg'
import { ownerDatabaseUrl } from '../db/lib/connection.mjs'

const argv = process.argv.slice(2)
const arg = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : null }
const q = async (db, sql, p) => (await db.query(sql, p)).rows
const failures = []
const check = (cond, msg) => { if (!cond) failures.push(msg) }

// ---------------------------------------------------------------------------------------------------------------
// Natural keys
// ---------------------------------------------------------------------------------------------------------------
async function naturalKeys (db) {
  const nk = new Map()
  const set = (t, id, k) => nk.set(`${t}:${id}`, k)
  for (const r of await q(db, 'select id, franchise_key from organizations')) set('organizations', r.id, `org:${r.franchise_key}`)
  for (const r of await q(db, 'select id, source_key from sources')) set('sources', r.id, `src:${r.source_key}`)
  for (const r of await q(db, 'select id, draft_key from drafts')) set('drafts', r.id, `draft:${r.draft_key}`)
  for (const r of await q(db, 'select r.id, d.draft_key, r.round_code from draft_rounds r join drafts d on d.id = r.draft_id')) set('draft_rounds', r.id, `round:${r.draft_key}-${r.round_code}`)
  for (const r of await q(db, 'select id, period_key from international_signing_periods')) set('international_signing_periods', r.id, `period:${r.period_key}`)
  for (const r of await q(db, 'select id, market_key from markets')) set('markets', r.id, `market:${r.market_key}`)
  for (const r of await q(db, 'select id, slug from schools')) set('schools', r.id, `school:${r.slug}`)
  // Players: MLBAM id when known, else another external id, else slug (slugs are unique but presentation-only).
  for (const r of await q(db, `select p.id, p.slug, (select x.id_system || '=' || x.external_id from player_external_ids x where x.player_id = p.id
      order by (x.id_system = 'MLBAM') desc, x.id_system, x.external_id limit 1) xid from players p`)) set('players', r.id, `player:${r.xid ?? r.slug}`)
  for (const r of await q(db, 'select s.id, d.draft_key, s.overall_pick from draft_selections s join drafts d on d.id = s.draft_id')) set('draft_selections', r.id, `pick:${r.draft_key}-${r.overall_pick}`)
  for (const r of await q(db, 'select id, draft_selection_id from draft_signings')) set('draft_signings', r.id, `signing:${nk.get(`draft_selections:${r.draft_selection_id}`)}`)
  for (const r of await q(db, 'select id, player_id, signing_period_id, organization_id from international_signings')) {
    set('international_signings', r.id, `intl:${nk.get(`players:${r.player_id}`)}|${nk.get(`international_signing_periods:${r.signing_period_id}`)}|${nk.get(`organizations:${r.organization_id}`)}`)
  }
  for (const r of await q(db, 'select s.id, d.draft_key, s.overall_pick from slot_values s join drafts d on d.id = s.draft_id')) set('slot_values', r.id, `slot:${r.draft_key}-${r.overall_pick}`)
  for (const r of await q(db, 'select id, id_system, external_id from player_external_ids')) set('player_external_ids', r.id, `xid:${r.id_system}=${r.external_id}`)
  for (const r of await q(db, 'select id, domain, scope_key, organization_id from coverage_assessments')) set('coverage_assessments', r.id, `cov:${r.domain}|${r.scope_key}|${nk.get(`organizations:${r.organization_id}`) ?? 'league'}`)
  for (const r of await q(db, 'select id, rules_era_key from rules_eras')) set('rules_eras', r.id, `era:${r.rules_era_key}`)
  for (const r of await q(db, 'select id, source_id, subject_table, subject_id, field_name, observed_value from source_observations')) {
    set('source_observations', r.id, `obs:${nk.get(`sources:${r.source_id}`)}|${nk.get(`${r.subject_table}:${r.subject_id}`) ?? `${r.subject_table}#${r.subject_id}`}|${r.field_name}|${JSON.stringify(r.observed_value)}`)
  }
  return nk
}

// Columns that point at another table. subject_id is resolved through subject_table.
const FK = {
  player_id: 'players', organization_id: 'organizations', draft_id: 'drafts', round_id: 'draft_rounds', school_id: 'schools', source_id: 'sources',
  signing_period_id: 'international_signing_periods', market_id: 'markets', draft_selection_id: 'draft_selections', rules_era_id: 'rules_eras',
  chosen_observation_id: 'source_observations', superseded_by_id: 'source_observations'
}
const RESEARCH_TABLES = ['organizations', 'sources', 'rules_eras', 'drafts', 'draft_rounds', 'international_signing_periods', 'markets', 'schools', 'school_aliases',
  'players', 'player_external_ids', 'player_aliases', 'draft_selections', 'draft_signings', 'slot_values', 'international_signings',
  'organization_signing_period_context', 'organization_draft_pools', 'source_observations', 'fact_resolutions', 'quality_flags', 'coverage_assessments', 'research_tasks']
// Columns that record when something ran rather than what was found (the day a batch was applied, a flag raised, a
// cell assessed). They are reported, never compared.
const RUN_DATE_COLUMNS = new Set(['raised_on', 'assessed_on', 'observed_on'])
// Reference sources seeded by migrations (calendars, franchise identity). Parity checks them; the pilot does not own them.
const SEEDED_SOURCE = /^"_key":"src:(cal:|bai-reference:)/

/**
 * The pilot's own rows, so the verifier keeps working as a database grows past the pilot (later classes, other clubs):
 * the rows its two batches wrote, their players, signings, slots, schools, rounds and markets, the observations, flags
 * and resolutions on those subjects, and the coverage cells they touch. Seeded reference data (organizations,
 * calendars, rules eras) is compared whole.
 */
async function pilotScope (db) {
  const ids = async (sql, p) => new Set((await q(db, sql, p)).map((r) => String(r.id)))
  const batches = (await q(db, "select id from ingest.import_batches where batch_key like 'pilot-2015-%'")).map((r) => r.id)
  const sel = await ids("select canonical_id id from ingest.staged_records where batch_id = any($1) and canonical_table = 'draft_selections'", [batches])
  const intl = await ids("select canonical_id id from ingest.staged_records where batch_id = any($1) and canonical_table = 'international_signings'", [batches])
  const selA = [...sel]
  const intlA = [...intl]
  const scope = {
    batches, sel, intl,
    players: await ids('select player_id id from public.draft_selections where id = any($1::bigint[]) union select player_id from public.international_signings where id = any($2::bigint[])', [selA, intlA]),
    signings: await ids('select id from public.draft_signings where draft_selection_id = any($1::bigint[])', [selA]),
    slots: await ids('select v.id from public.slot_values v join public.draft_selections s on s.draft_id = v.draft_id and s.overall_pick = v.overall_pick where s.id = any($1::bigint[])', [selA]),
    schools: await ids('select school_id id from public.draft_selections where id = any($1::bigint[]) and school_id is not null', [selA]),
    rounds: await ids('select round_id id from public.draft_selections where id = any($1::bigint[])', [selA]),
    markets: await ids('select market_id id from public.international_signings where id = any($1::bigint[]) and market_id is not null', [intlA]),
    cells: new Set((await q(db, `select 'DRAFT|' || d.draft_key || '|' || s.organization_id k from public.draft_selections s join public.drafts d on d.id = s.draft_id where s.id = any($1::bigint[])
      union select 'INTERNATIONAL|' || p.period_key || '|' || i.organization_id from public.international_signings i join public.international_signing_periods p on p.id = i.signing_period_id where i.id = any($2::bigint[])`, [selA, intlA])).map((r) => r.k)),
    otherBatches: (await q(db, "select count(*)::int n from ingest.import_batches where batch_key not like 'pilot-2015-%'"))[0].n
  }
  const subject = { players: scope.players, draft_selections: scope.sel, draft_signings: scope.signings, international_signings: scope.intl, slot_values: scope.slots }
  scope.subjectIn = (t, id) => ['drafts', 'international_signing_periods'].includes(t) || (subject[t]?.has(String(id)) ?? false)
  return scope
}

const SCOPED = {
  players: (r, s) => s.players.has(String(r.id)),
  player_external_ids: (r, s) => s.players.has(String(r.player_id)),
  player_aliases: (r, s) => s.players.has(String(r.player_id)),
  draft_selections: (r, s) => s.sel.has(String(r.id)),
  draft_signings: (r, s) => s.signings.has(String(r.id)),
  slot_values: (r, s) => s.slots.has(String(r.id)),
  international_signings: (r, s) => s.intl.has(String(r.id)),
  schools: (r, s) => s.schools.has(String(r.id)),
  draft_rounds: (r, s) => s.rounds.has(String(r.id)),
  markets: (r, s) => s.markets.has(String(r.id)),
  source_observations: (r, s) => s.subjectIn(r.subject_table, r.subject_id),
  fact_resolutions: (r, s) => s.subjectIn(r.subject_table, r.subject_id),
  quality_flags: (r, s) => s.subjectIn(r.subject_table, r.subject_id),
  coverage_assessments: (r, s) => s.cells.has(`${r.domain}|${r.scope_key}|${r.organization_id}`),
  sources: (r) => /^(pilot2015:|cal:|bai-reference:)/.test(r.source_key),
  // The baseline's calendar is 015's (2015-2026); historical phases added later (024's importer) are outside the pilot.
  drafts: (r) => r.draft_year >= 2015 && r.draft_year <= 2026
}

async function snapshot (db, scope) {
  const nk = await naturalKeys(db)
  const out = { tables: {}, run_dates: {} }
  for (const t of RESEARCH_TABLES) {
    const cols = (await q(db, `select column_name c, data_type d from information_schema.columns where table_schema = 'public' and table_name = $1 order by ordinal_position`, [t]))
      .filter((c) => !c.d.startsWith('timestamp') && c.c !== 'id' && c.c !== 'player_key')
    const rows = []
    for (const r of await q(db, `select id, ${cols.map((c) => `"${c.c}"`).join(', ')}${cols.some((c) => c.d === 'date') ? '' : ''} from public.${t}`)) {
      if (SCOPED[t] && !SCOPED[t](r, scope)) continue
      const o = {}
      for (const { c, d } of cols) {
        let v = r[c]
        if (v instanceof Date) v = `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`
        if (FK[c] && v !== null) v = nk.get(`${FK[c]}:${v}`) ?? `${FK[c]}#${v}`
        if (c === 'subject_id') v = nk.get(`${r.subject_table}:${v}`) ?? `${r.subject_table}#${v}`
        if (c === 'considered_observation_ids') v = (v ?? []).map((x) => nk.get(`source_observations:${x}`) ?? `obs#${x}`).sort()
        if (d === 'numeric' && v !== null) v = Number(v)
        if (RUN_DATE_COLUMNS.has(c)) { (out.run_dates[`${t}.${c}`] ??= new Set()).add(v); continue }
        o[c] = v
      }
      const key = nk.get(`${t}:${r.id}`)
      rows.push(key ? { _key: key, ...o } : o)
    }
    out.tables[t] = rows.map((r) => JSON.stringify(r)).sort()
  }
  out.ingest = {
    batches: (await q(db, "select batch_key, channel, status, file_sha256, coverage_claim from ingest.import_batches where batch_key like 'pilot-2015-%' order by batch_key")),
    // proposed/applied_action describe the most recent apply run (INSERT the first time, NO_CHANGE on a re-run), so they
    // are workflow history, not results, and are not compared.
    records: (await q(db, `select b.batch_key, r.record_index, r.record_type, r.validation_status, r.identity_state, r.review_state,
        r.applied_at is not null applied from ingest.staged_records r join ingest.import_batches b on b.id = r.batch_id where b.batch_key like 'pilot-2015-%' order by 1, 2`)).map((r) => JSON.stringify(r))
  }
  const rm = async (t, drop) => (await q(db, `select * from public.${t}`)).map((r) => { for (const k of drop) delete r[k]; return JSON.stringify(r) }).sort()
  out.read_models = {
    rm_research_coverage: (await q(db, 'select * from public.rm_research_coverage')).filter((r) => scope.cells.has(`${r.domain}|${r.scope_key}|${r.organization_id}`))
      .map((r) => { for (const k of ['generation_id', 'refreshed_at', 'organization_id', 'last_research_date']) delete r[k]; return JSON.stringify(r) }).sort(),
    // Queue counts are database-wide; they belong to the pilot only while the database holds nothing else.
    ...(scope.otherBatches ? {} : { rm_research_queue_summary: await rm('rm_research_queue_summary', ['generation_id', 'refreshed_at']) })
  }
  for (const k of Object.keys(out.run_dates)) out.run_dates[k] = [...out.run_dates[k]].filter(Boolean).sort()
  return out
}

/** Comparable form of a snapshot row: run-date columns removed, migration-seeded reference sources skipped. */
function comparable (table, rowJson) {
  const o = JSON.parse(rowJson)
  if (table === 'sources' && SEEDED_SOURCE.test(rowJson.slice(1))) return null
  for (const k of RUN_DATE_COLUMNS) delete o[k]
  return JSON.stringify(o)
}

function compare (base, cur) {
  const diffs = []
  const norm = (t, list = []) => list.map((r) => comparable(t, r)).filter(Boolean)
  for (const t of Object.keys(base.tables)) base.tables[t] = norm(t, base.tables[t])
  for (const t of Object.keys(cur.tables)) cur.tables[t] = norm(t, cur.tables[t])
  // Columns added by later, additive migrations (e.g. 024's organizations.first_season) are not in the baseline; compare
  // the columns the baseline recorded. Every recorded value is still compared, and a dropped column still shows.
  for (const t of Object.keys(cur.tables)) {
    if (!base.tables[t]?.length) continue
    const known = new Set(base.tables[t].flatMap((r) => Object.keys(JSON.parse(r))))
    cur.tables[t] = cur.tables[t].map((r) => JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(r)).filter(([k]) => known.has(k)))))
  }
  const cmpList = (label, a = [], b = []) => {
    const A = new Set(a)
    const B = new Set(b)
    for (const x of a) if (!B.has(x)) diffs.push(`${label}: only in baseline: ${x.slice(0, 300)}`)
    for (const x of b) if (!A.has(x)) diffs.push(`${label}: only in target:   ${x.slice(0, 300)}`)
  }
  for (const t of new Set([...Object.keys(base.tables), ...Object.keys(cur.tables)])) cmpList(t, base.tables[t], cur.tables[t])
  cmpList('ingest.import_batches', base.ingest.batches.map((x) => JSON.stringify(x)), cur.ingest.batches.map((x) => JSON.stringify(x)))
  cmpList('ingest.staged_records', base.ingest.records, cur.ingest.records)
  for (const t of Object.keys(base.read_models)) if (t in cur.read_models) cmpList(t, base.read_models[t], cur.read_models[t])
  // Baseline coverage rows from a pilot-only database: keep the pilot's cells only (tracked cells it touched).
  return diffs
}

// ---------------------------------------------------------------------------------------------------------------
// Expectations (the validated pilot)
// ---------------------------------------------------------------------------------------------------------------
async function expectations (db, scope) {
  const pilotPlayers = [...scope.players]
  const inPilot = (rows) => rows.filter((r) => scope.subjectIn(r.subject_table, r.subject_id))
  const one = async (sql, p) => (await q(db, sql, p))[0]
  const facts = {}
  const lad = `(select id from organizations where franchise_key = 'LAD')`
  const d = await one(`select count(*)::int tracked,
      count(*) filter (where g.signing_status = 'SIGNED')::int signed,
      count(*) filter (where g.signing_status = 'DID_NOT_SIGN')::int unsigned,
      count(*) filter (where g.signing_status is null)::int unknown_status,
      count(*) filter (where g.signing_status = 'SIGNED' and g.signing_bonus_usd is not null)::int signed_bonus_known,
      count(*) filter (where g.signing_status = 'SIGNED' and g.signing_bonus_usd is null)::int signed_bonus_unknown,
      count(*) filter (where g.signing_bonus_usd = 0)::int zero_bonus,
      count(distinct s.school_id)::int schools,
      count(*) filter (where s.school_id is null)::int no_school
    from draft_selections s join drafts dr on dr.id = s.draft_id left join draft_signings g on g.draft_selection_id = s.id
    where dr.draft_year = 2015 and dr.draft_kind = 'JUNE_AMATEUR' and s.organization_id = ${lad}`)
  facts.draft_2015_lad = d
  check(d.tracked === 42, `2015 LAD tracked ${d.tracked}, expected 42`)
  check(d.signed === 36, `signed ${d.signed}, expected 36`)
  check(d.unsigned === 6, `unsigned ${d.unsigned}, expected 6`)
  check(d.unknown_status === 0, `unknown status ${d.unknown_status}, expected 0`)
  check(d.signed_bonus_known === 18 && d.signed_bonus_unknown === 18, `signed bonuses known/unknown ${d.signed_bonus_known}/${d.signed_bonus_unknown}, expected 18/18`)
  check(d.zero_bonus === 0, 'a bonus is stored as zero')
  // 40 schools across all 46 pilot selections (the 42 LAD picks span 39; re-drafts add one); none unmatched.
  const allSchools = await one('select count(distinct school_id)::int n, count(*) filter (where school_id is null)::int unmatched, count(*)::int selections from draft_selections where id = any($1::bigint[])', [[...scope.sel]])
  facts.schools = allSchools
  check(d.no_school === 0 && allSchools.n === 40 && allSchools.unmatched === 0 && allSchools.selections === 46, `schools ${JSON.stringify(allSchools)} (LAD ${d.schools}), expected 40 schools over 46 selections, none unmatched`)
  const slots = await one(`select count(*)::int n, sum(v.slot_value_usd)::bigint total, bool_and(r.round_order <= 100) top10
    from slot_values v join drafts dr on dr.id = v.draft_id
    join draft_selections s on s.draft_id = v.draft_id and s.overall_pick = v.overall_pick and s.organization_id = ${lad}
    join draft_rounds r on r.id = s.round_id where dr.draft_year = 2015`)
  const top10 = await one(`select count(*)::int n from draft_selections s join drafts dr on dr.id = s.draft_id join draft_rounds r on r.id = s.round_id
    where dr.draft_year = 2015 and s.organization_id = ${lad} and r.round_order <= 100`)
  facts.slots = { ...slots, picks_in_rounds_1_10: top10.n }
  check(slots.n === 12 && top10.n === 12 && slots.top10, `slot values ${slots.n} for ${top10.n} picks in rounds 1-10, expected 12/12`)
  check(Number(slots.total) === 7781700, `slot total ${slots.total}, expected 7781700 (published pool)`)

  const redrafts = await q(db, `select p.display_name, x.external_id mlbam, count(s.id)::int selections,
      string_agg(o.franchise_key || ' ' || dr.draft_year || ' #' || s.overall_pick || ' ' || coalesce(g.signing_status::text, '?'), '; ' order by dr.draft_year) picks
    from players p join player_external_ids x on x.player_id = p.id and x.id_system = 'MLBAM'
    join draft_selections s on s.player_id = p.id join drafts dr on dr.id = s.draft_id join organizations o on o.id = s.organization_id
    left join draft_signings g on g.draft_selection_id = s.id
    where p.id = any($1::bigint[])
    group by p.id, p.display_name, x.external_id having count(s.id) > 1 order by p.display_name`, [pilotPlayers])
  facts.redrafts = redrafts
  check(redrafts.length === 4, `${redrafts.length} players with two selections, expected 4`)
  for (const n of ['Funkhouser', 'Goldstein', 'Genord', 'Bilous']) check(redrafts.some((r) => r.display_name.includes(n) && r.selections === 2), `${n} is not one player with two selections`)

  const sborz = await q(db, `select f.field_name, f.rule, f.decided_by, o.observed_value chosen, s2.source_key chosen_source, cardinality(f.considered_observation_ids) considered
    from fact_resolutions f join source_observations o on o.id = f.chosen_observation_id join sources s2 on s2.id = o.source_id
    join draft_selections s on f.subject_table = 'draft_selections' and s.id = f.subject_id join drafts dr on dr.id = s.draft_id
    where dr.draft_year = 2015 and s.overall_pick = 74 order by 1`)
  facts.sborz_resolutions = sborz
  check(sborz.length === 2 && sborz.every((r) => r.rule === 'REQUIRE_OPERATOR' && r.decided_by === 'bai-pilot-review' && r.considered >= 2),
    'Sborz #74 round_code/round_pick resolutions missing or not operator decisions over both claims')
  const sborzCanon = await one(`select r.round_code, s.round_pick from draft_selections s join drafts dr on dr.id = s.draft_id join draft_rounds r on r.id = s.round_id where dr.draft_year = 2015 and s.overall_pick = 74`)
  check(sborzCanon?.round_code === 'CB-B' && sborzCanon?.round_pick === 4, `Sborz canonical ${JSON.stringify(sborzCanon)}, expected CB-B pick 4`)
  const sborzObs = await one(`select count(distinct o.observed_value)::int n from source_observations o join draft_selections s on o.subject_table = 'draft_selections' and o.subject_id = s.id
    join drafts dr on dr.id = s.draft_id where dr.draft_year = 2015 and s.overall_pick = 74 and o.field_name = 'round_code'`)
  check(sborzObs.n === 2, 'both Sborz round_code claims must stay on record')

  const intl = await q(db, `select p.display_name, i.signing_bonus_usd bonus, i.signing_date, i.signing_date_precision prec, i.pathway, sp.period_key period, i.notes
    from international_signings i join players p on p.id = i.player_id join international_signing_periods sp on sp.id = i.signing_period_id
    where i.organization_id = ${lad} order by sp.label, p.display_name`)
  facts.international = intl.filter((r) => ['2014-15', '2015-16'].includes(r.period)).map(({ notes, ...r }) => ({ ...r, signing_date: r.signing_date && `${r.signing_date.getFullYear()}-${String(r.signing_date.getMonth() + 1).padStart(2, '0')}-${String(r.signing_date.getDate()).padStart(2, '0')}`, bonus: r.bonus === null ? null : Number(r.bonus) }))
  const amateur = facts.international.filter((r) => r.period === '2015-16')
  // Names exactly as the validated import records them (MLB transaction wire).
  const expected = { 'Yadier Álvarez': 16000000, 'Yusniel Díaz': 15500000, 'Omar Estévez': 6000000, 'Starling Heredia': 2600000, 'Ronny Brito': 2000000, 'Oneil Cruz': 950000, 'Christopher Arias': 500000, 'Carlos Rincon': null }
  check(amateur.length === 8, `${amateur.length} 2015-16 signings, expected 8`)
  for (const [name, bonus] of Object.entries(expected)) {
    const r = amateur.find((x) => x.display_name.normalize('NFD').replace(/\p{M}/gu, '') === name.normalize('NFD').replace(/\p{M}/gu, ''))
    check(r, `${name} missing from 2015-16`)
    if (!r) continue
    check(r.bonus === bonus, `${name} bonus ${r.bonus}, expected ${bonus}`)
    check(r.signing_date && r.prec === 'DAY', `${name} lacks a day-precision transaction date`)
    check(r.pathway === 'INTERNATIONAL_AMATEUR', `${name} pathway ${r.pathway}`)
  }
  const pmf = facts.international.find((r) => r.display_name.includes('Fern'))
  check(pmf && pmf.period === '2014-15' && pmf.pathway === 'INTERNATIONAL_PROFESSIONAL' && pmf.bonus === null && pmf.signing_date === '2015-05-19',
    `Pablo Millán Fernández not recorded as 2014-15 exempt professional on 2015-05-19 with unknown cost: ${JSON.stringify(pmf)}`)
  check(facts.international.length === 9, `${facts.international.length} LAD international signings, expected 9`)
  const olivera = await one("select count(*)::int n from players where name_normalized like '%olivera%'")
  check(olivera.n === 0, 'Héctor Olivera must be excluded (major-league contract)')
  const diaz = await one(`select x.external_id, i.notes from players p join international_signings i on i.player_id = p.id
    left join player_external_ids x on x.player_id = p.id and x.id_system = 'BBREF_MINORS' where p.display_name = 'Yusniel Díaz'`)
  facts.diaz_bbref_minors = diaz && { id: diaz.external_id, flagged_in_notes: /irregular/i.test(diaz.notes ?? '') }
  check(diaz?.external_id === 'efrain000yun' && /irregular/i.test(diaz.notes ?? ''), 'Díaz minors id must stay as recorded and flagged for verification')

  facts.coverage = await q(db, `select c.domain, c.scope_key, o.franchise_key, c.coverage_state, c.tracked_count, c.expected_count
    from coverage_assessments c left join organizations o on o.id = c.organization_id order by 1, 2, 3`)
  const cov = (scope, org) => facts.coverage.find((c) => c.scope_key === scope && c.franchise_key === org)
  check(cov('2015-JUNE_AMATEUR', 'LAD')?.coverage_state === 'PARTIAL_RECONSTRUCTION' && cov('2015-JUNE_AMATEUR', 'LAD')?.expected_count === 42, '2015 draft × LAD must be PARTIAL_RECONSTRUCTION, expected 42')
  check(cov('2015-16', 'LAD')?.coverage_state === 'PARTIAL_RECONSTRUCTION' && cov('2015-16', 'LAD')?.expected_count === null, '2015-16 × LAD must be PARTIAL_RECONSTRUCTION with unknown class size')
  const pilotCells = await q(db, `select c.coverage_state from coverage_assessments c where c.domain::text || '|' || c.scope_key || '|' || c.organization_id = any($1)`, [[...scope.cells]])
  check(!pilotCells.some((c) => ['COMPLETE_CENSUS', 'SUBSTANTIALLY_COMPLETE'].includes(c.coverage_state)), 'no pilot cell may claim census coverage')
  const audits = await one('select count(*)::int n from outcome_audits where player_id = any($1::bigint[])', [pilotPlayers])
  check(audits.n === 0, 'no outcome audits are part of the pilot')
  const pilotRates = (await q(db, 'select domain, scope_key, organization_id, supports_population_rate from rm_research_coverage')).filter((r) => scope.cells.has(`${r.domain}|${r.scope_key}|${r.organization_id}`) && r.supports_population_rate)
  check(pilotRates.length === 0, 'no pilot cell supports population rates')
  const computed = await one('select count(*) filter (where mlb_reach_rate is not null or cost_per_mlb_player is not null)::int n from analytics.class_economics')
  check(computed.n === 0, 'no rate is computed anywhere until a class is census-level, certified and fully audited')

  facts.sources_by_authority = await q(db, `select authority_level, count(*)::int n from sources where source_key not like 'cal:%' and source_type <> 'TEST_FIXTURE'
    and source_key in (select s.source_key from sources s join source_observations o on o.source_id = s.id where o.subject_table <> all(array['drafts','international_signing_periods']))
    group by 1 order by 1`)
  const missingRetrieved = await one("select count(*)::int n from sources where source_type not in ('TEST_FIXTURE', 'BAI_REFERENCE') and retrieved_date is null")
  check(missingRetrieved.n === 0, `${missingRetrieved.n} sources lack a retrieved date`)
  facts.quality_flags = Object.entries(inPilot(await q(db, 'select flag_code, subject_table, subject_id from quality_flags'))
    .reduce((m, f) => ({ ...m, [f.flag_code]: (m[f.flag_code] ?? 0) + 1 }), {})).map(([flag_code, n]) => ({ flag_code, n })).sort((a, b) => a.flag_code.localeCompare(b.flag_code))
  const flag = (c) => facts.quality_flags.find((f) => f.flag_code === c)?.n ?? 0
  check(flag('EVIDENCE_EXCERPT_ONLY') === 3 && flag('SIGNING_STATUS_FROM_PRO_APPEARANCES') === 3, `quality flags ${JSON.stringify(facts.quality_flags)}`)
  facts.resolutions = inPilot(await q(db, 'select subject_table, subject_id from fact_resolutions')).length
  check(facts.resolutions === 4, `${facts.resolutions} fact resolutions, expected 4 (2 calendar, 2 Sborz)`)
  facts.open_conflicts = inPilot(await q(db, 'select subject_table, subject_id from v_open_fact_conflicts')).length
  check(facts.open_conflicts === 0, `${facts.open_conflicts} open conflicts`)
  facts.external_ids = (await one('select count(*)::int n from player_external_ids where player_id = any($1::bigint[])', [pilotPlayers])).n
  check(facts.external_ids === 112, `${facts.external_ids} external ids, expected 112`)
  facts.players = pilotPlayers.length
  facts.queues = await q(db, 'select queue_key, priority, open_items from rm_research_queue_summary order by priority, queue_key')
  const qn = (k) => facts.queues.find((x) => x.queue_key === k)?.open_items
  check(facts.queues.length === 10, `${facts.queues.length} queues, expected 10`)
  // Queue counts are database-wide: assert the pilot's own counts only while the database holds nothing else.
  if (!scope.otherBatches)
  check(qn('CLASS_INCOMPLETE') === 7 && qn('MISSING_COST') === 23 && qn('OUTCOME_NOT_AUDITED') === 51 && qn('MISSING_EXPECTATION') === 55 && qn('IDENTITY_AMBIGUOUS') === 0 && qn('SOURCE_CONFLICT') === 0,
    `queue counts ${JSON.stringify(facts.queues)}`)
  const batches = await q(db, "select batch_key, status from ingest.import_batches where batch_key like 'pilot-2015-%' order by 1")
  facts.batches = batches
  check(batches.length === 2 && batches.every((b) => b.status === 'APPLIED'), `pilot import batches ${JSON.stringify(batches)}`)
  facts.other_batches = scope.otherBatches
  return facts
}

const db = new pg.Client({ connectionString: ownerDatabaseUrl() })
await db.connect()
try {
  const scope = await pilotScope(db)
  const facts = await expectations(db, scope)
  const snap = await snapshot(db, scope)
  const toFile = (s) => JSON.stringify(s, null, 1) + '\n'
  if (arg('snapshot')) fs.writeFileSync(arg('snapshot'), toFile(snap))
  let diffs = null
  if (arg('compare')) diffs = compare(JSON.parse(fs.readFileSync(arg('compare'), 'utf8')), JSON.parse(toFile(snap)))
  if (diffs) failures.push(...diffs.map((d) => `reconciliation: ${d}`))
  if (argv.includes('--json')) console.log(JSON.stringify({ ok: failures.length === 0, failures, facts, run_dates: snap.run_dates }, null, 2))
  else {
    const d = facts.draft_2015_lad
    console.log(`draft 2015 LAD: tracked ${d.tracked}, signed ${d.signed}, did not sign ${d.unsigned}, unknown ${d.unknown_status}; signed bonuses known ${d.signed_bonus_known}, unknown ${d.signed_bonus_unknown}; zero-stored ${d.zero_bonus}; schools ${d.schools} for LAD picks, ${facts.schools.n} across all ${facts.schools.selections} selections; slots ${facts.slots.n} (total ${facts.slots.total})`)
    console.log(`re-drafted: ${facts.redrafts.map((r) => `${r.display_name} [${r.picks}]`).join(' | ')}`)
    console.log(`Sborz #74: ${facts.sborz_resolutions.map((r) => `${r.field_name}=${JSON.stringify(r.chosen)} from ${r.chosen_source} (${r.rule}, ${r.decided_by}, ${r.considered} claims)`).join('; ')}`)
    console.table(facts.international)
    console.log(`Díaz BBREF_MINORS: ${JSON.stringify(facts.diaz_bbref_minors)}`)
    console.table(facts.coverage)
    console.log(`players ${facts.players}, external ids ${facts.external_ids}, resolutions ${facts.resolutions}, open conflicts ${facts.open_conflicts}`)
    console.log(`flags ${facts.quality_flags.map((f) => `${f.flag_code}=${f.n}`).join(' ')}; pilot sources by authority ${facts.sources_by_authority.map((s) => `${s.authority_level}=${s.n}`).join(' ')}`)
    if (scope.otherBatches) console.log(`database also holds ${scope.otherBatches} non-pilot batch(es): pilot rows compared in scope; database-wide queue counts not asserted`)
    console.log(`queues ${facts.queues.map((x) => `${x.queue_key}(p${x.priority})=${x.open_items}`).join(' ')}`)
    console.log(`run dates (not compared): ${JSON.stringify(snap.run_dates)}`)
    if (diffs) console.log(`reconciliation against ${arg('compare')}: ${diffs.length} difference(s)`)
    console.log(failures.length ? `PILOT VERIFY FAILED (${failures.length})\n  ${failures.slice(0, 60).join('\n  ')}` : 'PILOT VERIFY OK')
  }
} finally { await db.end() }
process.exit(failures.length ? 1 : 0)
