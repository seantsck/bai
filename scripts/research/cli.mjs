// BAI research CLI. Safe by default: apply and resolve are dry runs unless --write is given. Never prints connection
// strings or credentials. Exit codes: 0 ok, 1 usage / operational error, 2 validation failure.
//
//   npm run research:import    -- --file research/imports/x.json [--operator name]
//   npm run research:validate  -- --batch <id|key>
//   npm run research:apply     -- --batch <id|key> [--write] [--allow-partial]
//   npm run research:conflicts [-- --json]
//   npm run research:resolve   -- --table t --id n --field f (--observation id --operator name --rationale "..." | --rule) [--write]
//   npm run research:identity  -- --record n (--player slug | --new-player | --reject) --operator name --note "..."
//   npm run research:queue     [-- --queue IDENTITY_AMBIGUOUS --limit 25]
//   npm run research:coverage  [-- --domain DRAFT|INTERNATIONAL]
//   npm run research:batches
//
// League-wide backfill (docs/backfill-methodology.md). Single-organization commands always need --org; nothing assumes a club.
//   npm run research:orgs                                                   the 30 organizations, historical names, program waves
//   npm run research:class    -- --org LAD --channel draft --year 2016 [--create]   (international: --period 2016-17)
//   npm run research:plan     -- --org LAD --channel draft --year 2016       create/close jobs from the data (idempotent)
//   npm run research:next     -- --org LAD [--channel draft --year 2016 --period 2016-17 --stage financials --limit 10] | --league
//   npm run research:progress [-- --org LAD]                                league-wide unless --org is given
//   npm run research:start    -- --org LAD --channel draft --year 2016 --batch lad-2016-draft-a [--take 10 --goal "..."]
//   npm run research:pause | research:resume | research:complete [--release] | research:fail --reason "..." -- --batch <key>
//   npm run research:supersede -- --batch <key> --new <key>
//   npm run research:job      -- --job <key> --state DONE|UNRESOLVED|CANCELLED|OPEN|IN_PROGRESS --rationale "..." [--assign name]
//   npm run research:block    -- --job <key> --reason "source unavailable: ..."     research:unblock -- --job <key>
//   npm run research:lead     -- --job <key> --url ... --source-type ... --authority ... --access ACCESSIBLE --retrieved 2026-10-20 --fields a,b --note "..."
//   npm run research:stage    -- --org LAD --channel draft --year 2016 [--to STAGE --rationale "..."]
//   npm run research:certify  -- --org LAD --channel draft --year 2016       deterministic; fails with blockers; no force option
//   npm run research:revoke   -- --org LAD --channel draft --year 2016 --reason "..."   human only; back to COVERAGE_REVIEW
//   npm run research:review   -- --batch <import batch> --reviewer <human> --note "..."   (required before applying an agent-staged batch)
//
// Against the hosted BAI database (.env.hosted.local, `npm run hosted:research -- <command> ...`), every command that writes
// anything, staging included, also needs --confirm-hosted <project ref>. Read-only commands (conflicts, queue, coverage,
// batches, resolve without --write) do not.
import pg from 'pg'
import { ownerDatabaseUrl, requireHostedWriteConfirmation } from '../db/lib/connection.mjs'
import * as P from './lib/pipeline.mjs'
import * as B from './lib/backfill.mjs'

const [command, ...rest] = process.argv.slice(2)
const args = {}
for (let i = 0; i < rest.length; i++) {
  const a = rest[i]
  if (!a.startsWith('--')) continue
  const key = a.slice(2)
  if (rest[i + 1] === undefined || rest[i + 1].startsWith('--')) args[key] = true
  else args[key] = rest[++i]
}
const json = Boolean(args.json)
const print = (title, obj) => { if (json) console.log(JSON.stringify(obj, null, 2)); else { if (title) console.log(title); if (obj !== undefined) console.table(obj) } }
const need = (k) => { if (!args[k] || args[k] === true) throw new P.PipelineError(`--${k} is required`); return args[k] }
const operator = () => args.agent ? `agent:${args.agent}` : (args.operator ?? process.env.BAI_OPERATOR ?? process.env.USER ?? 'cli')
const scopeArgs = () => ({ org: args.org, channel: args.channel, year: args.year, period: args.period })

function summarize (report) {
  const { coverage, actions, ...rest } = report
  console.log(Object.entries(rest).map(([k, v]) => `${k}=${v}`).join('  '))
  console.log('actions: ' + (Object.entries(actions ?? {}).map(([k, v]) => `${k}=${v}`).join('  ') || 'none'))
  if (coverage?.length) console.table(coverage)
}

async function main (db) {
  switch (command) {
    case 'import': {
      // Multi-team safety: say which organization the file belongs to, or that it is deliberately league-wide.
      if (!args.org && !args.league) throw new P.PipelineError('research:import needs --org <franchise key> (records checked against it) or an explicit --league')
      const org = args.org ? (await B.resolveOrganization(db, args.org)).franchise_key : null
      const { batch, already } = await P.stageFile(db, need('file'), { operator: operator(), organization: org })
      if (args.class) {
        const cls = await B.linkImport(db, args.class, batch.id, { actor: operator() })
        console.log(`linked to research class ${cls.class_key}`)
      }
      console.log(already ? `already staged: batch ${batch.id} (${batch.batch_key}, ${batch.status}); nothing written`
        : `staged batch ${batch.id} (${batch.batch_key}). Next: npm run research:validate -- --batch ${batch.id}`)
      return 0
    }
    case 'validate': {
      const { batch, counts, ok } = await P.validateBatch(db, need('batch'))
      console.log(`batch ${batch.batch_key}: ${batch.status}  records=${counts.records} valid=${counts.valid} invalid=${counts.invalid} warnings=${counts.warnings}`)
      console.log('identity: ' + Object.entries(counts.identity).map(([k, v]) => `${k}=${v}`).join('  '))
      if (!ok) {
        const bad = (await db.query("select record_index, validation_errors from ingest.staged_records r join ingest.import_batches b on b.id = r.batch_id where b.batch_key = $1 and validation_status = 'INVALID' order by record_index limit 20", [batch.batch_key])).rows
        for (const b of bad) console.log(`  record ${b.record_index}: ${b.validation_errors.join('; ')}`)
        return 2
      }
      return 0
    }
    case 'apply': {
      const write = Boolean(args.write)
      const { batch, report, results, conflicts } = await P.applyBatch(db, need('batch'), { write, allowPartial: Boolean(args['allow-partial']) })
      console.log(`${write ? 'APPLIED' : 'DRY RUN (nothing canonical written; add --write to apply)'}: ${batch.batch_key}`)
      if (json) print(null, { report, results, conflicts }); else summarize(report)
      const held = results.filter((r) => r.action === 'HELD')
      if (held.length && !json) { console.log('held for review:'); for (const h of held) console.log(`  record ${h.record_index}: ${h.reason}`) }
      if (conflicts.length && !json) { console.log('conflicts preserved (see research:conflicts):'); for (const c of conflicts) console.log(`  record ${c.record_index}: ${c.table}#${c.id}.${c.field} incoming=${JSON.stringify(c.incoming)}`) }
      return 0
    }
    case 'conflicts': {
      const rows = await P.openConflicts(db)
      if (json) { print(null, rows); return 0 }
      console.log(`${rows.length} open conflict(s)`)
      for (const c of rows) {
        console.log(`\n${c.subject_table}#${c.subject_id}.${c.field_name}  rule=${c.declared_rule}  rule decides: ${c.rule_outcome ?? 'no (operator required)'}`)
        for (const o of c.observations) console.log(`  obs ${o.observation_id}  ${JSON.stringify(o.value).padEnd(14)} ${o.authority.padEnd(20)} ${o.source_key}${o.locator ? '  @ ' + o.locator : ''}`)
      }
      return 0
    }
    case 'resolve': {
      const res = await P.resolveConflict(db, { subjectTable: need('table'), subjectId: need('id'), field: need('field'), observationId: args.observation ?? null,
        useRule: Boolean(args.rule), operator: args.rule ? null : operator(), rationale: args.rationale ?? null, write: Boolean(args.write) })
      console.log(`${res.written ? 'RESOLVED' : 'DRY RUN (add --write)'}: ${res.conflict} -> obs ${res.chosen.observation_id} (${JSON.stringify(res.chosen.value)}, ${res.chosen.source_key}) by ${res.decided_by}`)
      if (res.canonical_update) console.log(`  canonical ${JSON.stringify(res.canonical_update.from)} -> ${JSON.stringify(res.canonical_update.to)}`)
      return 0
    }
    case 'identity': {
      const res = await P.decideIdentity(db, need('record'), { playerSlug: args.player ?? null, newPlayer: Boolean(args['new-player']), reject: Boolean(args.reject), operator: operator(), note: need('note') })
      console.log(`record ${res.recordId}: ${res.decision} (applies on the next research:apply --write)`)
      return 0
    }
    case 'queue': {
      if (args.queue) print(`${args.queue}`, await P.queueItems(db, args.queue, Number(args.limit ?? 25)))
      else print('research queues (priority 1 = blocking)', await P.queueSummary(db))
      return 0
    }
    case 'coverage': {
      const rows = await P.coverageCells(db, { domain: args.domain ?? null })
      print(`${rows.length} cell(s) with records or an assessment (no hit rates are computed here)`, rows.map((r) => ({
        domain: r.domain, scope: r.scope_key, org: r.organization, state: r.coverage_state ?? 'NOT_ASSESSED', tracked: r.tracked_records, expected: r.expected_count ?? 'unknown',
        audited: r.audited_outcomes, cost_known: `${r.cost_known_records}/${r.cost_basis_records}`, last: r.last_research_date ? P.isoDate(r.last_research_date) : null, coverage_supports_rates: r.supports_population_rate ? 'yes (rates still need certification)' : 'no'
      })))
      return 0
    }
    case 'batches': {
      print('batches', (await db.query('select id, batch_key, channel, status, record_count, imported_at::date as imported, applied_at::date as applied from ingest.import_batches order by id')).rows)
      return 0
    }
    case 'orgs': {
      const rows = (await db.query(`select o.franchise_key, o.current_name, o.mlb_team_id, coalesce(w.wave, 3) as wave,
          (select string_agg(n.name || ' (' || coalesce(n.first_season::text, '…') || '-' || coalesce(n.last_season::text, '') || ')', '; ' order by n.first_season nulls first)
             from public.organization_names n where n.organization_id = o.id and n.name <> o.current_name) as former_names
        from public.organizations o left join research.program_waves w on w.organization_id = o.id where o.active order by 4, 1`)).rows
      print(`${rows.length} organizations (wave: research program order; 3 = not yet scheduled)`, rows)
      return 0
    }
    case 'class': {
      const scope = scopeArgs()
      if (args.create) {
        const { cls, created } = await B.createClass(db, scope, { actor: operator() })
        console.log(created ? `created research class ${cls.class_key}` : `research class ${cls.class_key} already exists`)
        const plan = await B.planClass(db, cls.class_key, { actor: operator() })
        console.log(`planned: ${plan.created} job(s) created, ${plan.closed} closed, ${plan.reopened} reopened`)
      }
      const r = await B.classReport(db, scope)
      if (json) { print(null, r); return 0 }
      const m = r.metrics
      console.log(`${r.cls.class_key}  stage ${r.cls.stage}  workflow ${r.status.workflow_status}  coverage ${m.coverage_state ?? 'NOT_ASSESSED'}`)
      if (r.cls.channel_key === 'DRAFT') {
        console.log(`expected ${m.expected_count ?? 'unknown'}  tracked ${m.tracked}  signed ${m.signed}  did not sign ${m.unsigned}  status unknown ${m.status_unknown}`)
        console.log(`identity complete ${m.identity_complete}/${m.tracked}  bonus known ${m.bonus_known}/${m.signed} (missing ${m.bonus_missing})  slot ${m.slot_known}/${m.slot_applicable}  school ${m.school_known}/${m.tracked}`)
      } else {
        console.log(`expected ${m.expected_count ?? 'unknown (not established)'}  discovered ${m.tracked}  amateur ${m.amateur}  professional ${m.professional}  day-dated ${m.day_dated}/${m.tracked}`)
        console.log(`identity complete ${m.identity_complete}/${m.tracked}  cost known ${m.cost_known}/${m.tracked} (unknown ${m.cost_unknown})`)
      }
      console.log(`provenance ${m.provenanced}/${m.tracked}  open conflicts ${m.open_conflicts}  excerpt-only flags ${m.excerpt_only_flags}  outcomes audited ${m.outcomes_audited}/${m.players}`)
      console.log(`sources: ${r.sources.map((x) => `${x.authority_level}=${x.n}`).join(' ') || 'none'}   imports: ${r.imports.map((x) => `${x.batch_key} (${x.status})`).join(', ') || 'none'}`)
      console.log(`jobs: open ${r.status.open_jobs}  actionable ${r.status.actionable_jobs}  blocked ${r.status.blocked_jobs}  unresolved ${r.status.unresolved_jobs}`)
      if (r.byStage.length) console.table(r.byStage)
      for (const b of r.blocked) console.log(`  BLOCKED ${b.job_key}: ${b.blocking_reason}`)
      if (r.batches.length) console.table(r.batches)
      console.log(r.blockers.length ? `certification blockers (${r.blockers.length}):` : 'certification: no blockers (run research:certify)')
      for (const b of r.blockers) console.log(`  ${b.code}: ${b.detail}`)
      return 0
    }
    case 'plan': {
      const r = await B.planClass(db, scopeArgs(), { actor: operator() })
      console.log(`${r.cls.class_key}: ${r.created} job(s) created, ${r.closed} closed as resolved in data, ${r.reopened} reopened`)
      return 0
    }
    case 'next': {
      const jobs = await B.nextJobs(db, { org: args.org, league: Boolean(args.league), channel: args.channel, year: args.year, period: args.period, stage: args.stage, limit: args.limit })
      print(`${jobs.length} next job(s), in queue order (wave, priority rank, class chronology, franchise, job key)`, jobs.map((j) => ({
        '#': Number(j.queue_position), job: j.job_key, rank: j.priority_rank, stage: j.job_stage, state: j.state, title: j.title })))
      return 0
    }
    case 'progress': {
      const r = await B.progress(db, { org: args.org ?? null })
      if (json) { print(null, r); return 0 }
      console.log(args.org ? `progress for ${String(args.org).toUpperCase()}` : `league-wide progress: ${r.perOrg.length} organizations (no hit rates: no class is census-level and certified)`)
      console.table(r.perOrg.map((o) => ({ org: o.franchise_key, wave: o.wave, classes: o.classes, certified: o.certified, blocked: o.blocked_classes, open_jobs: o.open_jobs,
        draft_tracked: o.draft_tracked, intl_tracked: o.intl_tracked, assessed_cells: `${o.assessed_cells}/${o.cells}` })))
      if (r.classes.length) console.table(r.classes)
      return 0
    }
    case 'start': {
      const r = await B.startBatch(db, scopeArgs(), { key: need('batch'), actor: operator(), goal: args.goal ?? null, take: args.take ?? 10 })
      console.log(`started research batch ${r.batch.batch_key} with ${r.jobs} job(s). Resume later with: npm run research:resume -- --batch ${r.batch.batch_key}`)
      return 0
    }
    case 'resume': {
      const r = await B.resumeBatch(db, need('batch'), { actor: operator() })
      console.log(`research batch ${r.batch.batch_key}: ${r.done}/${r.total} done, ${r.remaining.length} remaining`)
      if (r.remaining.length) print(null, r.remaining)
      return 0
    }
    case 'pause': { const b = await B.pauseBatch(db, need('batch'), { actor: operator(), note: args.note ?? null }); console.log(`paused ${b.batch_key}`); return 0 }
    case 'complete': {
      const r = await B.completeBatch(db, need('batch'), { actor: operator(), release: Boolean(args.release) })
      console.log(`completed ${r.batch.batch_key}${r.released ? `; ${r.released} unfinished job(s) returned to the queue` : ''}`)
      return 0
    }
    case 'fail': { const b = await B.failBatch(db, need('batch'), { actor: operator(), reason: args.reason }); console.log(`failed ${b.batch_key}; its unfinished jobs are back in the queue`); return 0 }
    case 'supersede': {
      const r = await B.supersedeBatch(db, need('batch'), { actor: operator(), newKey: args.new, goal: args.goal ?? null })
      console.log(`${r.old.batch_key} superseded by ${r.batch.batch_key} (${r.moved} unfinished job(s) carried over)`)
      return 0
    }
    case 'job': {
      if (args.add) {
        const j = await B.addJob(db, scopeArgs(), { category: need('category'), label: need('label'), title: need('title'), actor: operator(), origin: args.agent ? 'AGENT' : 'RESEARCHER', dependsOn: args['depends-on'] ?? null, notes: args.note ?? null })
        console.log(`added ${j.job_key}`)
        return 0
      }
      const j = await B.setJobState(db, need('job'), String(need('state')).toUpperCase(), { actor: operator(), rationale: args.rationale ?? null, assign: args.assign })
      console.log(`${j.job_key}: ${j.state}`)
      return 0
    }
    case 'block': { const j = await B.setJobState(db, need('job'), 'BLOCKED', { actor: operator(), reason: args.reason }); console.log(`${j.job_key}: BLOCKED (${j.blocking_reason}); it stays visible in research:class`); return 0 }
    case 'unblock': { const j = await B.setJobState(db, need('job'), 'OPEN', { actor: operator() }); console.log(`${j.job_key}: OPEN`); return 0 }
    case 'lead': {
      const l = await B.addLead(db, need('job'), { url: args.url ?? null, reference: args.reference ?? null, source_type: need('source-type'), authority_level: need('authority'), access: need('access'),
        retrieved_date: args.retrieved ?? null, archived_url: args.archived ?? null, evidence_note: need('note'), excerpt_only: Boolean(args['excerpt-only']),
        fields_supported: args.fields ? String(args.fields).split(',').map((f) => f.trim()).filter(Boolean) : [] }, { actor: operator(), origin: args.agent ? 'AGENT' : 'RESEARCHER' })
      console.log(`lead ${l.id} recorded (${l.access}); leads are not provenance: cite the source in an import batch`)
      return 0
    }
    case 'stage': {
      const r = await B.advanceStage(db, scopeArgs(), { actor: operator(), to: args.to ?? null, rationale: args.rationale ?? null })
      console.log(`stage ${r.from} -> ${r.to}${r.openJobsBefore ? ` (${r.openJobsBefore} job(s) from earlier stages still open; recorded)` : ''}`)
      return 0
    }
    case 'certify': {
      const r = await B.certify(db, scopeArgs(), { actor: operator() })
      if (!r.certified) {
        console.log(`NOT CERTIFIED: ${r.cls.class_key} (${r.blockers.length} blocker(s))`)
        for (const b of r.blockers) console.log(`  ${b.code}: ${b.detail}`)
        return 3
      }
      console.log(`CERTIFIED: ${r.cls.class_key} (coverage stays ${r.coverage_state})`)
      return 0
    }
    case 'revoke': {
      const r = await B.revokeCertification(db, scopeArgs(), { actor: operator(), reason: args.reason })
      console.log(`certification of ${r.cls.class_key} revoked; class back at COVERAGE_REVIEW`)
      return 0
    }
    case 'review': {
      const b = await B.reviewImport(db, need('batch'), { reviewer: args.reviewer, note: args.note })
      console.log(`review recorded for ${b.batch_key} (staged by ${b.imported_by})`)
      return 0
    }
    default:
      console.error('usage: research <import|validate|apply|conflicts|resolve|identity|queue|coverage|batches|orgs|class|plan|next|progress|start|pause|resume|complete|fail|supersede|job|block|unblock|lead|stage|certify|revoke|review> [--options]')
      return 1
  }
}

const WRITES = { import: true, validate: true, apply: true, identity: true, resolve: Boolean(args.write), class: Boolean(args.create), plan: true, start: true,
  pause: true, resume: true, complete: true, fail: true, supersede: true, job: true, block: true, unblock: true, lead: true, stage: true, certify: true, revoke: true, review: true }
let db = null
let code = 1
try {
  // Multi-team safety, checked before anything connects: single-organization commands never default to a club.
  if (command === 'import' && !args.org && !args.league) throw new P.PipelineError('research:import needs --org <franchise key> (records checked against it) or an explicit --league')
  if (command === 'next' && !args.org && !args.league) throw new P.PipelineError('research:next needs --org <franchise key> or an explicit --league')
  const url = ownerDatabaseUrl()
  if (WRITES[command]) requireHostedWriteConfirmation(url)
  db = new pg.Client({ connectionString: url })
  await db.connect()
  code = await main(db)
} catch (err) {
  console.error(err instanceof P.PipelineError ? `error: ${err.message}` : `error: ${err.message.replace(/postgres(ql)?:\/\/\S+/g, '<redacted>')}`)
  code = 1
} finally { await db?.end().catch(() => {}) }
process.exit(code)
