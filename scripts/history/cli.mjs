// BAI historical draft importer (1965-present). Bulk discovery and import through the research pipeline: every record is
// staged, validated, identity-resolved and applied by the same code (and guards) as a researcher's batch. No AI calls.
//
//   node --env-file-if-exists=.env.local scripts/history/cli.mjs <command> [options]
//
//   fetch-draft     --years 1965,1985 [--phases JR,NR,NS,JS,JD,AL] [--max-requests 50]   MLB draft feed, one file per phase-year
//   fetch-crosswalk [--max-requests 20]                                                   Chadwick register shards (pinned commit)
//   fetch-evidence  --year 2005 [--teams LAD,NYY] [--max-requests 40]                     archived B-Ref franchise-year pages
//   calendar        --years 1965,1985                                                     add sourced drafts rows (research/history/calendar.json)
//   build           --year 1985 [--orgs LAD,WSH] [--phases JR]                            write batches + report (deterministic, offline)
//   import          --year 1985 [--orgs LAD,WSH] [--phases JR] [--write] [--no-plan]      stage, validate, dry-run / apply; resumable
//   status          [--from 1965 --to 2026]                                               per-phase coverage (counts only)
//   preflight       --years 2006-2010 [--target local|hosted]                            every permission a batch needs (no network, no writes)
//   (scripts/history/benchmark.mjs: synthetic 1965-2026 scale benchmark in a disposable database)
//
// Safety:
//   * Permission gates (research/history/sources.json, lib/permissions.mjs). Every download names its source and use
//     (fetch_bulk here: this is a bulk importer); every cached read needs process_local for the year; importing needs
//     process_local for each cited source, and a non-local target would also need publish_site. Refusals exit with code 4.
//   * Outputs (batches, build reports, timings, the plan) are written to .restricted/history/ (gitignored, never
//     deployed), not to tracked directories: whether source-derived output may enter the public repository is a separate
//     grant (publish_repository), enforced by `npm run history:publication-check` in `npm run check`.
//   * Local databases only. Hosted imports are refused here until the permissions decisions are made and a reviewed batch
//     plan exists (docs/history/backfill-plan.md).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { ownerDatabaseUrl, isLocalUrl } from '../db/lib/connection.mjs'
import * as P from '../research/lib/pipeline.mjs'
import * as B from '../research/lib/backfill.mjs'
import { createFetcher, BudgetExhausted } from './lib/fetch.mjs'
import { loadCatalog, checkUse, requireUse, requireBatchUse, requireHostedPublication, PermissionDenied } from './lib/permissions.mjs'
import { PHASES, normalizePhase, draftKey } from './lib/mlb.mjs'
import { SHARDS, indexShard } from './lib/chadwick.mjs'
import { buildPhaseBatches } from './lib/build.mjs'
import { BREF_TEAM_CODES, capturesFromCdx, parseBrefDraftRows, compareClubLists, decodeHtml } from './lib/evidence.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const argv = process.argv.slice(2)
const command = argv[0]
const opt = (k, d = null) => { const i = argv.indexOf(`--${k}`); return i > 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d }
const flag = (k) => argv.includes(`--${k}`)
const list = (k, d = []) => (opt(k) ? opt(k).split(',').map((s) => s.trim()).filter(Boolean) : d)
const years = () => list('years', opt('year') ? [opt('year')] : []).map(Number).filter((y) => y >= 1965 && y <= 2100)
const catalog = loadCatalog(root)
// Restricted outputs: gitignored and excluded from deployments (.gitignore, .vercelignore).
const OUT = path.resolve(root, process.env.BAI_HISTORY_OUT || '.restricted/history')
const chadwick = catalog.sources.find((s) => s.id === 'chadwick-register')
const OPERATOR = process.env.BAI_OPERATOR || 'history-importer'
const USER_AGENT = 'BAI-research/0.1 (historical draft importer; github.com/seantsck/bai)'
const log = (m) => console.log(m)

const fetcher = () => createFetcher({ root, catalog, offline: flag('offline'), maxRequests: Number(opt('max-requests', 50)), minIntervalMs: Number(opt('interval-ms', 1500)), userAgent: USER_AGENT, log })
const mlbKey = (year, code) => `mlb/draft/${year}-${code.toLowerCase()}.json`
const mlbUrl = (year, code) => `https://statsapi.mlb.com/api/v1/draft/${year}?draftType=${code}`
const readCached = (key, year = null) => {
  const f = fetcher()
  const entry = f.manifest.entries[key]
  if (!entry) return null
  return f.get(key, entry.url, { source: entry.source_key, use: 'fetch_bulk', scope: { year } })
}

async function withDb (fn, { write = false } = {}) {
  const url = ownerDatabaseUrl()
  if (write && !isLocalUrl(url)) throw new Error('the historical importer writes to local databases only (hosted imports wait for the permissions decision and a reviewed plan)')
  const db = new pg.Client({ connectionString: url })
  await db.connect()
  try { return await fn(db) } finally { await db.end() }
}

async function phaseData (year, code) {
  const c = await readCached(mlbKey(year, code), year)
  if (!c) return null
  return { ...normalizePhase(JSON.parse(c.buf.toString('utf8')), { year, code }), entry: c.entry }
}

async function crosswalkFor (mlbIds) {
  const wanted = new Set(mlbIds)
  const map = new Map()
  let retrieved = null
  for (const s of SHARDS) {
    const c = await readCached(`chadwick/${chadwick.pinned_commit.slice(0, 7)}/people-${s}.csv`)
    if (!c) throw new Error('Chadwick register not cached: run fetch-crosswalk first')
    retrieved = retrieved ?? c.entry.retrieved_at.slice(0, 10)
    indexShard(c.buf.toString('utf8'), wanted, map)
  }
  return { map, retrieved }
}

const COMMANDS = {
  async 'fetch-draft' () {
    const f = fetcher()
    const phases = list('phases', Object.keys(PHASES))
    // MLB's own phase names ("January Amateur Draft", ...) date a phase to its month when no day is published.
    await f.get('mlb/draft-types.json', 'https://statsapi.mlb.com/api/v1/draftTypes', { source: 'mlb-statsapi-draft', use: 'fetch_bulk', scope: { year: years()[0] } })
    for (const y of years()) {
      for (const code of phases) {
        if (!PHASES[code]) throw new Error(`unknown phase ${code}`)
        const { buf, cached } = await f.get(mlbKey(y, code), mlbUrl(y, code), { source: 'mlb-statsapi-draft', use: 'fetch_bulk', scope: { year: y } })
        const n = normalizePhase(JSON.parse(buf.toString('utf8')), { year: y, code })
        log(`${y} ${code} ${PHASES[code].label}: ${n.picks.length} selections${cached ? ' (cached)' : ''}${n.findings.length ? `, ${n.findings.length} finding(s)` : ''}`)
      }
    }
    log(`requests used: ${f.stats().requests}/${f.stats().maxRequests}`)
  },

  async 'fetch-crosswalk' () {
    const f = fetcher()
    for (const s of SHARDS) {
      const url = chadwick.url_template.replace('{commit}', chadwick.pinned_commit).replace('{shard}', s)
      const { buf, cached } = await f.get(`chadwick/${chadwick.pinned_commit.slice(0, 7)}/people-${s}.csv`, url, { source: 'chadwick-register', use: 'fetch_bulk' })
      log(`people-${s}.csv: ${buf.length} bytes${cached ? ' (cached)' : ''}`)
    }
  },

  async 'fetch-evidence' () {
    const f = fetcher()
    const year = years()[0]
    const cdxUrl = `https://web.archive.org/cdx/search/cdx?url=baseball-reference.com/draft/&matchType=prefix&filter=urlkey:.*franch_year.*&filter=urlkey:.*year_id=${year}.*&filter=statuscode:200&fl=timestamp,original&collapse=urlkey&limit=2000`
    const { buf } = await f.get(`archive/cdx/bref-draft-franch-year-${year}.txt`, cdxUrl, { source: 'bref-draft-archive', use: 'fetch_bulk', scope: { year } })
    const teams = new Set(list('teams'))
    const caps = capturesFromCdx(buf.toString('utf8'), year).filter((c) => !teams.size || teams.has(BREF_TEAM_CODES[c.team]))
    log(`${caps.length} archived franchise-year page(s) for ${year}`)
    for (const c of caps) {
      const key = `archive/bref/${year}/${c.code.toLowerCase()}-${c.team.toLowerCase()}-${c.ts}.html`
      try {
        const { buf: page, cached } = await f.get(key, `https://web.archive.org/web/${c.ts}id_/${c.original}`, { source: 'bref-draft-archive', use: 'fetch_bulk', scope: { year } })
        log(`  ${c.team} ${c.code}: ${parseBrefDraftRows(decodeHtml(page)).length} rows${cached ? ' (cached)' : ''}`)
      } catch (err) {
        if (err instanceof BudgetExhausted || err instanceof PermissionDenied) throw err
        log(`  ${c.team} ${c.code}: ${err.message}`)
      }
    }
  },

  async calendar () {
    const cal = JSON.parse(fs.readFileSync(path.join(root, 'research/history/calendar.json'), 'utf8'))
    // Rows sourced from a restricted source (MLB's phase names) live in the local restricted calendar.
    const localFile = path.join(OUT, 'calendar.local.json')
    if (fs.existsSync(localFile)) { const l = JSON.parse(fs.readFileSync(localFile, 'utf8')); Object.assign(cal.sources, l.sources); cal.drafts.push(...l.drafts) }
    await withDb(async (db) => {
      for (const y of years()) {
        for (const d of cal.drafts.filter((x) => x.draft_year === y)) {
          const data = await phaseData(y, d.mlb_draft_type)
          if (!data) throw new Error(`${d.draft_key}: MLB feed not cached (fetch-draft first)`)
          if (!data.picks.length) { log(`${d.draft_key}: no selections in MLB's feed; not added`); continue }
          const rounds = Math.max(...data.picks.map((p) => Number(p.round_code)).filter(Number.isFinite))
          const s = cal.sources[d.source_ref]
          if (!s) throw new Error(`${d.draft_key}: unknown source_ref ${d.source_ref}`)
          requireBatchUse(catalog, { sources: [s] }, 'process_local', { year: y }, { root })
          if (!isLocalUrl(ownerDatabaseUrl())) requireBatchUse(catalog, { sources: [s] }, 'publish_site', { year: y }, { root })
          await db.query('begin')
          try {
            await db.query(`insert into public.sources (source_key, source_type, authority_level, title, publisher, url, retrieved_date, notes)
              values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict (source_key) do nothing`, [s.source_key, s.source_type, s.authority_level, s.title, s.publisher, s.url, s.retrieved_date, s.notes])
            const r = await db.query(`insert into public.drafts (draft_key, draft_year, draft_kind, start_date, end_date, start_date_precision, total_rounds, structure_note, source_id, mlb_draft_type)
              values ($1, $2, $3, $4, $5, $6, $7, $8, (select id from public.sources where source_key = $9), $10) on conflict (draft_key) do nothing returning id`,
            [d.draft_key, d.draft_year, d.draft_kind, d.start_date, d.end_date ?? null, d.start_date_precision, rounds, `${d.structure_note} Rounds: ${rounds} (highest numbered round in MLB's feed).`, s.source_key, d.mlb_draft_type])
            await db.query('commit')
            log(`${d.draft_key}: ${r.rowCount ? 'added' : 'already on the calendar'} (${d.start_date}, ${d.start_date_precision}, ${rounds} rounds)`)
          } catch (err) { await db.query('rollback'); throw err }
        }
      }
    }, { write: true })
  },

  async build () {
    const year = years()[0]
    // Refuse up front rather than build an empty year: the feed must be processable for this year.
    requireUse(catalog, 'mlb-statsapi-draft', 'process_local', { year }, { root })
    const phases = list('phases', Object.keys(PHASES))
    const orgsWanted = new Set(list('orgs'))
    const outDir = path.join(OUT, 'batches', String(year))
    const report = { year, built_on: 'deterministic (from the cached files listed in research/history/manifest.json)', phases: [] }
    await withDb(async (db) => {
      const organizations = (await db.query('select franchise_key, mlb_team_id, first_season from public.organizations where active and coalesce(first_season, 0) <= $1', [year])).rows
      const allPicks = []
      const datas = {}
      for (const code of phases) { const d = await phaseData(year, code); if (d) { datas[code] = d; allPicks.push(...d.picks) } }
      const cw = await crosswalkFor([...new Set(allPicks.map((p) => p.person.id))])
      for (const [code, data] of Object.entries(datas)) {
        if (!data.picks.length) { report.phases.push({ code, draft_key: draftKey(year, code), selections: 0 }); continue }
        const evidence = await evidenceFor(year, code, data.picks, organizations)
        const { batches, unmatchedTeams, held } = buildPhaseBatches(data.picks, {
          year, code, phase: PHASES[code], organizations: organizations.filter((o) => !orgsWanted.size || orgsWanted.has(o.franchise_key)),
          crosswalk: cw.map, commit: chadwick.pinned_commit, mlbEntry: data.entry, chadwickRetrieved: cw.retrieved, evidence: evidence.byOrg
        })
        if (unmatchedTeams.length && !orgsWanted.size) throw new Error(`${year} ${code}: team id(s) ${unmatchedTeams.join(', ')} match no franchise that existed in ${year}`)
        fs.mkdirSync(outDir, { recursive: true })
        for (const b of batches) fs.writeFileSync(path.join(outDir, `${b.doc.batch_key}.json`), JSON.stringify(b.doc, null, 1) + '\n')
        const withIds = data.picks.filter((p) => cw.map.has(p.person.id))
        report.phases.push({
          code, draft_key: draftKey(year, code), label: PHASES[code].label, selections: data.picks.length, raw_rows: data.rawCount,
          clubs: new Set(data.picks.map((p) => p.team_id)).size, batches_written: batches.map((b) => b.doc.batch_key),
          held: held.map((p) => ({ pick: p.overall_pick, reason: p.hold })), findings: data.findings,
          crosswalk: { matched: withIds.length, bbref: withIds.filter((p) => cw.map.get(p.person.id).ids.BBREF).length,
            bbref_minors: withIds.filter((p) => cw.map.get(p.person.id).ids.BBREF_MINORS).length, fangraphs: withIds.filter((p) => cw.map.get(p.person.id).ids.FANGRAPHS).length },
          birth_date_known: data.picks.filter((p) => p.person.birth_date).length,
          school_typed: data.picks.filter((p) => p.school?.school_type).length, school_untyped: data.picks.filter((p) => p.school && !p.school.school_type).length,
          evidence: evidence.summary
        })
        log(`${year} ${code}: ${data.picks.length} selections, ${batches.length} batch(es) written, ${held.length} held, crosswalk ${withIds.length}/${data.picks.length}`)
      }
    })
    fs.mkdirSync(path.join(OUT, 'reports'), { recursive: true })
    fs.writeFileSync(path.join(OUT, 'reports', `${year}-build.json`), JSON.stringify(report, null, 1) + '\n')
  },

  async import () {
    const year = years()[0]
    const write = flag('write')
    const phases = list('phases', Object.keys(PHASES))
    const orgsWanted = new Set(list('orgs'))
    const dir = path.join(OUT, 'batches', String(year))
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
    const timings = []
    // Gates before anything connects: every governed source a batch cites must permit local processing for its year,
    // and a non-local target would also need publish_site (withDb refuses non-local writes regardless).
    const local = isLocalUrl(ownerDatabaseUrl())
    for (const file of files) {
      const doc = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
      requireBatchUse(catalog, doc, 'process_local', {}, { root })
      if (!local) requireHostedPublication(catalog, doc, {}, { root })
    }
    await withDb(async (db) => {
      for (const file of files) {
        const doc = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
        const org = doc.records[0]?.organization
        const kind = doc.coverage_claims[0].scope_key.slice(5)
        const code = Object.keys(PHASES).find((c) => PHASES[c].kind === kind)
        if ((orgsWanted.size && !orgsWanted.has(org)) || !phases.includes(code)) continue
        const t0 = Date.now()
        // Checkpoint: an APPLIED batch with the same file checksum is skipped (stageFile recognises it).
        const { batch, already } = await P.stageFile(db, path.join(dir, file), { operator: OPERATOR, organization: org })
        if (already && batch.status === 'APPLIED') { log(`${doc.batch_key}: already applied (checkpoint)`); continue }
        // Historical years are locked per database (025). withDb allows writes only to local databases, where the importer
        // records its local research use; a hosted release is a separate, deliberate decision (docs/history/README.md).
        if (write && year < 2015) await db.query(`insert into ingest.historical_releases (draft_year, authorization_reference, scope_note) values ($1, 'local-research', 'local research database: restricted, not for publication') on conflict (draft_year) do nothing`, [year])
        const { cls } = await B.createClass(db, { org, channel: 'draft', year, kind }, { actor: OPERATOR })
        await B.linkImport(db, cls.class_key, batch.id, { actor: OPERATOR })
        const v = await P.validateBatch(db, batch.id)
        if (!v.ok) throw new Error(`${doc.batch_key}: validation failed (${v.counts.invalid} invalid); see research:validate`)
        const dry = await P.applyBatch(db, batch.id, { write: false })
        const heldN = dry.results.filter((r) => r.action === 'HELD').length
        if (heldN || dry.conflicts.length) throw new Error(`${doc.batch_key}: dry run held ${heldN} record(s) and found ${dry.conflicts.length} conflict(s); resolve before writing`)
        let applied = null
        if (write) {
          applied = await P.applyBatch(db, batch.id, { write: true })
          // Planning creates research jobs (about 2.5 per pick). A bulk backfill skips it (--no-plan); a class gets its
          // jobs when it enters active research (research:plan).
          if (!flag('no-plan')) await B.planClass(db, cls.class_key, { actor: OPERATOR })
        }
        const ms = Date.now() - t0
        timings.push({ batch: doc.batch_key, records: doc.records.length, ms })
        log(`${doc.batch_key}: ${write ? 'APPLIED' : 'dry run ok'} ${doc.records.length} records in ${ms} ms${applied ? ` (new players ${applied.report.new_players ?? '?'})` : ''}`)
      }
    }, { write: true })
    const total = timings.reduce((a, t) => ({ records: a.records + t.records, ms: a.ms + t.ms }), { records: 0, ms: 0 })
    if (total.records) log(`throughput: ${total.records} records in ${(total.ms / 1000).toFixed(1)} s = ${(total.records / (total.ms / 1000)).toFixed(1)} records/s (stage + validate + dry run${write ? ' + apply + plan' : ''})`)
    if (write && timings.length) {
      fs.mkdirSync(path.join(OUT, 'reports'), { recursive: true })
      fs.writeFileSync(path.join(OUT, 'reports', `${year}-import-timings.json`), JSON.stringify({ year, batches: timings, total }, null, 1) + '\n')
    }
  },

  // Every grant a batch for these years needs, checked without any request or write. Exit 4 if anything is refused.
  async preflight () {
    const spec = opt('years', opt('year', ''))
    const [a, b] = spec.includes('-') ? spec.split('-').map(Number) : [Number(spec), Number(spec)]
    if (!(a >= 1965 && b >= a && b <= 2100)) throw new Error('--years 2006-2010 (or --year 2006) is required')
    const target = opt('target', 'hosted')
    const steps = [
      ['mlb-statsapi-draft', 'fetch_bulk', 'discover each phase (fetch-draft)'],
      ['mlb-statsapi-draft', 'process_local', 'build and import locally'],
      ['chadwick-register', 'process_local', 'identity crosswalk'],
      ['wikipedia-draft-articles', 'fetch_bulk', 'calendar dates and totals'],
      ['bref-draft-archive', 'fetch_targeted', 'independent per-club lists (census claims)'],
      ['bref-draft-archive', 'process_local', 'compare lists'],
      ...(target === 'hosted' ? [['mlb-statsapi-draft', 'publish_site', 'publish to hosted'], ['chadwick-register', 'publish_site', 'publish ids to hosted'], ['bref-draft-archive', 'publish_site', 'publish census corroboration to hosted']] : [])
    ]
    const rows = []
    for (let y = a; y <= b; y++) {
      for (const [src, use, why] of steps) {
        const r = checkUse(catalog, src, use, { year: y, requests: 1 }, { root })
        rows.push({ year: y, source: src, use, for: why, allowed: r.ok ? 'yes' : 'NO', state: r.state, reason: r.ok ? '' : r.reason.replace(/^[^:]+: [a-z_]+ refused: /, '').slice(0, 90) })
      }
    }
    const refused = rows.filter((r) => r.allowed === 'NO')
    console.table(rows.map(({ year, source, use, allowed, state, reason }) => ({ year, source, use, allowed, state, reason })))
    console.log(`${target === 'hosted' ? 'hosted also needs: ingest.historical_releases rows for each year (025), citing the authorization; a runner in ca-central-1.\n' : ''}${refused.length} of ${rows.length} grants refused for ${a}-${b} (${target}).`)
    if (refused.length) process.exitCode = 4
  },

  async status () {
    await withDb(async (db) => {
      const r = await db.query(`select draft_key, clubs, clubs_with_census, expected_selections, imported_selections, identities_resolved, signing_known, bonus_known, outcomes_audited
        from public.v_draft_year_coverage where draft_year between $1 and $2 order by draft_year, draft_kind`, [Number(opt('from', 1965)), Number(opt('to', 2026))])
      console.table(r.rows)
    })
  }
}

/** Per-club independent counts for one phase from cached archived B-Ref pages (none cached = no evidence). */
async function evidenceFor (year, code, picks, organizations) {
  const f = fetcher()
  const cdx = f.manifest.entries[`archive/cdx/bref-draft-franch-year-${year}.txt`]
  if (!cdx) return { byOrg: {}, summary: { source: 'none cached' } }
  const caps = capturesFromCdx((await f.get(`archive/cdx/bref-draft-franch-year-${year}.txt`, cdx.url, { source: cdx.source_key, use: 'fetch_bulk', scope: { year } })).buf.toString('utf8'), year).filter((c) => c.code === code)
  const byOrg = {}
  const summary = { source: 'archived Baseball-Reference franchise-year pages', clubs: 0, agree: 0, disagree: [], unknown_codes: [], name_variants: [], numbering_differences: 0 }
  for (const c of caps) {
    const key = `archive/bref/${year}/${c.code.toLowerCase()}-${c.team.toLowerCase()}-${c.ts}.html`
    const e = f.manifest.entries[key]
    if (!e) continue
    const fk = BREF_TEAM_CODES[c.team]
    const org = organizations.find((o) => o.franchise_key === fk)
    if (!org) { summary.unknown_codes.push(c.team); continue }
    const rows = parseBrefDraftRows(decodeHtml((await f.get(key, e.url, { source: e.source_key, use: 'fetch_bulk', scope: { year } })).buf))
    const cmp = compareClubLists(picks.filter((p) => p.team_id === org.mlb_team_id), rows)
    const agrees = cmp.mlb === cmp.other && !cmp.unmatched.length && !cmp.unlistedByOther.length
    summary.clubs++
    if (agrees) summary.agree++
    else summary.disagree.push({ club: fk, mlb: cmp.mlb, bref: cmp.other, unmatched: cmp.unmatched.map((r) => `${r.overall} ${r.name}`), not_on_bref: cmp.unlistedByOther.map((p) => `#${p.overall_pick} ${p.person.full_name}`) })
    summary.name_variants.push(...cmp.nameVariants.map((v) => `${fk} ${v}`))
    summary.numbering_differences += cmp.numbering
    byOrg[fk] = {
      agrees,
      source: { source_key: `hist:bref-archive-${year}-${code.toLowerCase()}-${fk.toLowerCase()}`, url: e.url, retrieved_date: e.retrieved_at.slice(0, 10), capture: c.ts },
      count: agrees ? cmp.mlb : cmp.other,
      note: `Baseball-Reference franchise-year page, Internet Archive capture ${c.ts}: ${cmp.other} listed, ${cmp.matched} matched to MLB's picks by name` +
        (cmp.nameVariants.length ? ` (${cmp.nameVariants.length} by surname in the same round: ${cmp.nameVariants.join('; ')})` : '') +
        (cmp.numbering ? `; ${cmp.numbering} numbered differently` : '') +
        (cmp.unmatched.length || cmp.unlistedByOther.length ? `; ${cmp.unmatched.length} unmatched there, ${cmp.unlistedByOther.length} of MLB's not listed there` : '')
    }
  }
  return { byOrg, summary }
}

if (!COMMANDS[command]) {
  console.error('usage: scripts/history/cli.mjs <fetch-draft|fetch-crosswalk|fetch-evidence|calendar|build|import|status|preflight> [options]')
  process.exit(1)
}
try {
  await COMMANDS[command]()
} catch (err) {
  console.error(`${err instanceof PermissionDenied ? 'permission refused' : 'error'}: ${err.message.replace(/postgres(ql)?:\/\/\S+/g, '<redacted>')}`)
  process.exit(err instanceof BudgetExhausted ? 3 : err instanceof PermissionDenied ? 4 : 1)
}
