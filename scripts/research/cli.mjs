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
//   npm run research:check    -- --org LAD --channel draft --year 2016       records a deterministic certification check (certifies nothing)
//   npm run research:certify  -- --check <id>                                REVIEWER LOGIN ONLY; certifies a passing, unchanged check
//   npm run research:revoke   -- --org LAD --channel draft --year 2016 --reason "..."   human only; back to COVERAGE_REVIEW
//   npm run research:review   -- --batch <import batch> --reviewer <human> --note "..."   (required before applying an agent-staged batch)
//   npm run research:reviewer -- [--enroll "<Full Name>" (REVIEWER LOGIN) | --deactivate <name>]   reviewers, bound to their login roles
//   npm run research:reconsider -- --table t --id n --field f --observation <obs> --reason "..." --authorize [--evidence url,...] [--write]   REVIEWER LOGIN
//   npm run research:accept   -- --proposal <id> --reason "..." [--evidence url,...] [--write]          REVIEWER LOGIN: decide as proposed
//   npm run research:ratify   -- --resolution <id> --reason "..." [--write]                            REVIEWER LOGIN: confirm an operator decision
//   npm run research:gate     -- [--open --reason "..." (REVIEWER LOGIN) | --close --reason "..."]      the certification gate (closed by default)
//   npm run research:history  -- [--table t --id n | --org LAD --channel draft --year 2016]   append-only decision history
//   npm run research:propose  -- --table t --id n --field f --observation <obs> --rationale "..." [--evidence url,...]   decides nothing
//   npm run research:wave     -- --org ATL --wave 2 --rationale "..." --operator <human>   program wave (priority order; human decision)
//   npm run research:proposals -- [--all | --reject <id> --reason "..." (REVIEWER LOGIN) | --withdraw <id> --reason "..."]
// REVIEWER LOGIN: the command connects with BAI_REVIEWER_DATABASE_URL, the human's own PostgreSQL role (docs/decision-history.md).
// The reviewer is whoever that login is; no command takes a reviewer name.
//
// Against the hosted BAI database (.env.hosted.local, `npm run hosted:research -- <command> ...`), every command that writes
// anything, staging included, also needs --confirm-hosted <project ref>. Read-only commands (conflicts, queue, coverage,
// batches, resolve without --write) do not.
import pg from 'pg'
import { ownerDatabaseUrl, reviewerDatabaseUrl, requireHostedWriteConfirmation } from '../db/lib/connection.mjs'
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
const listArg = (k) => args[k] && args[k] !== true ? String(args[k]).split(',').map((e) => e.trim()).filter(Boolean) : []
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
        useRule: Boolean(args.rule), operator: args.rule ? null : operator(), rationale: args.rationale ?? null, proposalId: args.proposal ?? null, write: Boolean(args.write) })
      console.log(`${res.written ? 'RESOLVED' : 'DRY RUN (add --write)'}: ${res.conflict} -> obs ${res.chosen.observation_id} (${JSON.stringify(res.chosen.value)}, ${res.chosen.source_key}) by ${res.decided_by}`)
      if (res.canonical_update) console.log(`  canonical ${JSON.stringify(res.canonical_update.from)} -> ${JSON.stringify(res.canonical_update.to)}`)
      return 0
    }
    case 'reconsider': {
      if (!args.authorize) throw new P.PipelineError('reconsideration changes a recorded human judgment; pass --authorize to confirm it is your decision')
      const res = await P.reconsiderResolution(db, { subjectTable: need('table'), subjectId: need('id'), field: need('field'), observationId: need('observation'),
        reason: need('reason'), evidence: listArg('evidence'), proposalId: args.proposal ?? null, write: Boolean(args.write) })
      if (res.unchanged) { console.log(`unchanged: ${res.resolution} already chooses obs ${args.observation}`); return 0 }
      console.log(`${res.written ? 'RECONSIDERED' : 'DRY RUN (add --write)'}: ${res.resolution} -> obs ${args.observation} by ${res.reviewer} (authenticated session)`)
      if (res.canonical_update) console.log(`  canonical ${JSON.stringify(res.canonical_update.from)} -> ${JSON.stringify(res.canonical_update.to)}`)
      console.log(`  history #${res.history_id} ${res.kind}, certification impact ${res.certification_impact}${res.written ? '' : ' (rolled back)'}`)
      return 0
    }
    case 'accept': {
      const res = await P.acceptProposal(db, need('proposal'), { reason: need('reason'), evidence: listArg('evidence'), write: Boolean(args.write) })
      console.log(`${res.written ? 'ACCEPTED' : 'DRY RUN (add --write)'}: proposal ${res.proposal} by ${res.reviewer} (authenticated session): history #${res.history_id} ${res.kind}, certification impact ${res.certification_impact}`)
      if (res.canonical_update) console.log(`  canonical ${JSON.stringify(res.canonical_update.from)} -> ${JSON.stringify(res.canonical_update.to)}`)
      return 0
    }
    case 'ratify': {
      const res = await P.ratifyResolution(db, need('resolution'), { reason: need('reason'), evidence: listArg('evidence'), write: Boolean(args.write) })
      console.log(`${res.written ? 'RATIFIED' : 'DRY RUN (add --write)'}: resolution ${args.resolution} (${res.subject_table}#${res.subject_id}.${res.field_name} = ${JSON.stringify(res.new_value)}) by ${res.decided_by}`)
      return 0
    }
    case 'check': {
      const r = await B.recordCertificationCheck(db, scopeArgs(), { actor: operator() })
      console.log(`certification check ${r.check.id} for ${r.cls.class_key}: ${r.check.passed ? 'PASSED' : `NOT PASSED (${r.blockers.length} blocker(s))`}  fingerprint ${r.check.fingerprint.slice(0, 12)}`)
      for (const b of r.blockers) console.log(`  ${b.code}: ${b.detail}`)
      if (r.check.passed) console.log(`a reviewer may certify it: research:certify -- --check ${r.check.id} (their own login; certification gate must be open)`)
      return r.check.passed ? 0 : 3
    }
    case 'gate': {
      if (args.open || args.close) {
        const g = await B.setCertificationGate(db, { enabled: Boolean(args.open), reason: args.reason, actor: operator() })
        console.log(`certification gate ${g.enabled ? 'OPEN' : 'closed'} (changed by ${g.changed_by}, session ${g.changed_session_role})`)
        return 0
      }
      print('certification gate', (await db.query('select enabled, changed_by, changed_session_role, changed_at::text, reason from research.certification_gate')).rows)
      return 0
    }
    case 'history': {
      const cls = args.org ? await B.findClass(db, scopeArgs()) : null
      print('decision history (newest first)', (await P.decisionHistory(db, { subjectTable: args.table ?? null, subjectId: args.id ?? null, classId: cls?.id ?? null, limit: Number(args.limit ?? 50) }))
        .map((h) => ({ id: h.id, at: P.isoDate(h.recorded_at), kind: h.kind, record: h.subject_table ? `${h.subject_table}#${h.subject_id}.${h.field_name ?? ''}` : '', from: JSON.stringify(h.previous_value), to: JSON.stringify(h.new_value), by: h.decided_by, impact: h.certification_impact })))
      return 0
    }
    case 'propose': {
      const r = await P.proposeDecision(db, { subjectTable: need('table'), subjectId: need('id'), field: need('field'), observationId: need('observation'), proposedBy: operator(),
        rationale: need('rationale'), evidence: args.evidence ? String(args.evidence).split(',').map((e) => e.trim()).filter(Boolean) : [] })
      console.log(`${r.created ? 'proposal' : 'existing proposal'} ${r.proposal.id}: ${r.proposal.subject_table}#${r.proposal.subject_id}.${r.proposal.field_name} -> obs ${r.proposal.proposed_observation_id} (${JSON.stringify(r.proposal.proposed_value)}) by ${r.proposal.proposed_by}; PROPOSED, decides nothing until a reviewer, on their own login, runs research:accept --proposal ${r.proposal.id} (or rejects it)`)
      return 0
    }
    case 'proposals': {
      if (args.reject || args.withdraw) {
        const r = await P.closeProposal(db, args.reject ?? args.withdraw, { status: args.reject ? 'REJECTED' : 'WITHDRAWN', by: args.reject ? null : operator(), reason: need('reason') })
        console.log(`proposal ${r.id}: ${r.status} by ${r.decided_by}`)
        return 0
      }
      print('decision proposals', (await P.listProposals(db, { status: args.all ? null : (args.status ?? 'PROPOSED') })).map((p) => ({ id: p.id, record: `${p.subject_table}#${p.subject_id}.${p.field_name}`, obs: p.proposed_observation_id, value: JSON.stringify(p.proposed_value), source: p.source_key, by: p.proposed_by, status: p.status, decided_by: p.decided_by })))
      return 0
    }
    case 'wave': {
      const w = await B.setWave(db, { org: need('org'), wave: need('wave'), actor: operator(), rationale: need('rationale') })
      console.log(`${String(args.org).toUpperCase()}: wave ${w.wave} (set by ${w.set_by})`)
      return 0
    }
    case 'reviewer': {
      if (args.enroll) { const r = await B.enrollReviewer(db, { reviewer: String(args.enroll), note: args.note ?? null }); console.log(`enrolled ${r.reviewer}, bound to login role ${r.db_role}`); return 0 }
      if (args.deactivate) { const r = await B.deactivateReviewer(db, { reviewer: String(args.deactivate), actor: operator() }); console.log(r ? `deactivated ${r.reviewer}` : 'no active reviewer by that name'); return 0 }
      print('reviewers', (await db.query(`select reviewer, db_role, enrolled_at::date::text enrolled, active, coalesce(research.role_review_refusal(db_role), 'ok') as role_check
        from research.reviewers order by reviewer`)).rows)
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
      console.log(r.blockers.length ? `certification blockers (${r.blockers.length}):` : 'certification: no blockers (record a check with research:check; a reviewer certifies it)')
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
      const c = await B.certify(db, need('check'))
      console.log(`CERTIFIED: class ${c.class_id} by ${c.certified_by} (authenticated session; check ${c.certification_check_id}; coverage stays ${c.coverage_state})`)
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
      console.error('usage: research <import|validate|apply|conflicts|resolve|identity|queue|coverage|batches|orgs|class|plan|next|progress|start|pause|resume|complete|fail|supersede|job|block|unblock|lead|stage|check|certify|revoke|review|reconsider|accept|ratify|gate|history|reviewer|propose|proposals|wave> [--options]')
      return 1
  }
}

const WRITES = { import: true, validate: true, apply: true, identity: true, resolve: Boolean(args.write), class: Boolean(args.create), plan: true, start: true,
  pause: true, resume: true, complete: true, fail: true, supersede: true, job: true, block: true, unblock: true, lead: true, stage: true, certify: true, revoke: true, review: true, reconsider: Boolean(args.write), reviewer: Boolean(args.enroll || args.deactivate), propose: true, proposals: Boolean(args.reject || args.withdraw), wave: true,
  accept: Boolean(args.write), ratify: Boolean(args.write), check: true, gate: Boolean(args.open || args.close) }
// Human-only actions run on the reviewer's own login (BAI_REVIEWER_DATABASE_URL), so the database knows who acts (021).
const REVIEWER = { reconsider: true, accept: true, ratify: true, certify: true, reviewer: Boolean(args.enroll), proposals: Boolean(args.reject), gate: Boolean(args.open) }
let db = null
let code = 1
try {
  // Multi-team safety, checked before anything connects: single-organization commands never default to a club.
  if (command === 'import' && !args.org && !args.league) throw new P.PipelineError('research:import needs --org <franchise key> (records checked against it) or an explicit --league')
  if (command === 'next' && !args.org && !args.league) throw new P.PipelineError('research:next needs --org <franchise key> or an explicit --league')
  const url = REVIEWER[command] ? reviewerDatabaseUrl() : ownerDatabaseUrl()
  if (WRITES[command]) requireHostedWriteConfirmation(url)
  db = new pg.Client({ connectionString: url })
  await db.connect()
  code = await main(db)
} catch (err) {
  console.error(err instanceof P.PipelineError ? `error: ${err.message}` : `error: ${err.message.replace(/postgres(ql)?:\/\/\S+/g, '<redacted>')}`)
  code = 1
} finally { await db?.end().catch(() => {}) }
process.exit(code)
