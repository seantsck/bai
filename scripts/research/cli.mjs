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
import pg from 'pg'
import { ownerDatabaseUrl } from '../db/lib/connection.mjs'
import * as P from './lib/pipeline.mjs'

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
const operator = () => args.operator ?? process.env.BAI_OPERATOR ?? process.env.USER ?? 'cli'

function summarize (report) {
  const { coverage, actions, ...rest } = report
  console.log(Object.entries(rest).map(([k, v]) => `${k}=${v}`).join('  '))
  console.log('actions: ' + (Object.entries(actions ?? {}).map(([k, v]) => `${k}=${v}`).join('  ') || 'none'))
  if (coverage?.length) console.table(coverage)
}

async function main (db) {
  switch (command) {
    case 'import': {
      const { batch, already } = await P.stageFile(db, need('file'), { operator: operator() })
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
        audited: r.audited_outcomes, cost_known: `${r.cost_known_records}/${r.cost_basis_records}`, last: r.last_research_date ? P.isoDate(r.last_research_date) : null, rates: r.supports_population_rate ? 'allowed' : 'blocked'
      })))
      return 0
    }
    case 'batches': {
      print('batches', (await db.query('select id, batch_key, channel, status, record_count, imported_at::date as imported, applied_at::date as applied from ingest.import_batches order by id')).rows)
      return 0
    }
    default:
      console.error('usage: research <import|validate|apply|conflicts|resolve|identity|queue|coverage|batches> [--options]')
      return 1
  }
}

const db = new pg.Client({ connectionString: ownerDatabaseUrl() })
let code = 1
try {
  await db.connect()
  code = await main(db)
} catch (err) {
  console.error(err instanceof P.PipelineError ? `error: ${err.message}` : `error: ${err.message.replace(/postgres(ql)?:\/\/\S+/g, '<redacted>')}`)
  code = 1
} finally { await db.end().catch(() => {}) }
process.exit(code)
