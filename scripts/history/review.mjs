// Private review workflow for the historical importer's exceptions (migration 025, research.history_exceptions).
//
//   npm run history:review -- load [--register .restricted/history/exceptions.json] [--propose-rules]
//   npm run history:review -- list [--status OPEN|PROPOSED|NEEDS_EVIDENCE|DECIDED] [--kind ALTERNATE_NAME]
//   npm run history:review -- show --key EX-2005-JR-PHI-LIST
//   npm run history:review -- conclusions [--kind MISSING_SELECTION]
//   npm run history:review -- propose --key <EX-...> --conclusion <C> --rationale "<why>" (--by <name> | --agent <name>) [--evidence '<json>']
//   npm run history:review -- withdraw --proposal <id> (--by <name> | --agent <name>) --reason "<why>"
//   npm run history:review -- decide --key <EX-...> --decision ACCEPT_PROPOSAL|REJECT_PROPOSAL|DECIDE|NEEDS_MORE_EVIDENCE|REOPEN
//                                    --rationale "<why>" [--proposal <id>] [--conclusion <C>] [--evidence '<json>']
//
// Rules (enforced by the database, 025):
//   * Exceptions and their source claims are loaded from the restricted register (scripts/history/exceptions.mjs) into a
//     LOCAL research database only; this command refuses any other, and on hosted the tables refuse rows outright.
//   * Anyone may propose a conclusion, including an agent (--agent records "agent:<name>"). Proposals never decide.
//   * Only an enrolled human reviewer decides, on their own login (BAI_REVIEWER_DATABASE_URL, docs/decision-history.md).
//     An agent never runs `decide` and never holds a reviewer credential.
//   * A decision records a judgment and its rationale. It changes no canonical fact (a correction it calls for goes through
//     the research pipeline as a sourced batch) and has nothing to do with certification, which stays behind its gate.
//   * Everything is append-only, with an event history per exception.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { ownerDatabaseUrl, reviewerDatabaseUrl, isLocalUrl } from '../db/lib/connection.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const OUT = path.resolve(root, process.env.BAI_HISTORY_OUT || '.restricted/history')
const [command, ...rest] = process.argv.slice(2)
const args = {}
for (let i = 0; i < rest.length; i++) {
  if (!rest[i].startsWith('--')) continue
  const k = rest[i].slice(2)
  if (rest[i + 1] === undefined || rest[i + 1].startsWith('--')) args[k] = true
  else args[k] = rest[++i]
}
const need = (k) => { if (!args[k] || args[k] === true) throw new Error(`--${k} is required`); return String(args[k]) }
const actor = () => args.agent ? `agent:${args.agent}` : args.by ? String(args.by) : (() => { throw new Error('--by <your name> or --agent <name> is required') })()
const json = (k) => { if (!args[k]) return []; try { return JSON.parse(args[k]) } catch { throw new Error(`--${k} must be JSON`) } }

// Rule-based starting proposals (attributed to an agent; never a decision). Deliberately cautious: where the evidence
// in hand cannot settle a case, the proposal is UNDETERMINED with what would settle it.
function ruleProposal (e) {
  switch (e.review_kind) {
    case 'NUMBERING_DISAGREEMENT': return ['IDENTITY_UNAFFECTED', 'Identity never relies on pre-modern overall pick numbers; matching used names within the round. No record depends on the disputed numbers.']
    case 'CROSSWALK_UNMATCHED': return ['NO_OTHER_IDS_EXPECTED', 'The unmatched ids are mostly picks who never played professionally, which the register does not cover. Re-check against a later register commit before deciding.']
    case 'ALTERNATE_NAME': return (e.count ?? 1) > 1
      ? ['PARTLY_DIFFERENT', 'Most pairs are nicknames or legal names (James/Jim), but some pairs have unrelated first names on the same surname and pick; each such pair needs a biographical check before the club\'s census can stand.']
      : ['SAME_PERSON', 'The surnames differ by at most two letters at the same club, round and draft; a spelling variant is the likeliest reading. Confirm with a third listing before closing.']
    case 'SAME_PERSON_MULTIPLE_SELECTIONS': return ['UNDETERMINED', 'One MLBAM id at two picks of one phase can be one person picked twice, a feed error or two people merged. The feed alone cannot tell; needs a second list of the phase naming both picks, or biographical records. The later pick stays held.']
    case 'MISSING_SELECTION': return ['UNDETERMINED', 'One independent list names selections the official feed lacks. A third source (club media guide, contemporary transaction report) is needed before adding or rejecting them.']
    case 'DIFFERENT_PLAYER_SAME_PICK': return ['UNDETERMINED', 'The sources name different players at the same pick. A third source is needed; the class stays partial.']
    case 'CENSUS_TOTAL_DISAGREEMENT': return ['UNDETERMINED', 'The stated total may count players rather than picks, or exclude a phase. A primary account of the draft is needed; no expected count is claimed meanwhile.']
    default: return null
  }
}

async function connect (url) { const c = new pg.Client({ connectionString: url }); await c.connect(); return c }

const COMMANDS = {
  async load (db) {
    if (!isLocalUrl(ownerDatabaseUrl())) throw new Error('historical exception evidence is restricted: load it into a local research database only')
    const file = path.resolve(root, args.register && args.register !== true ? args.register : path.join(OUT, 'exceptions.json'))
    const raw = fs.readFileSync(file)
    const sha = crypto.createHash('sha256').update(raw).digest('hex')
    const register = JSON.parse(raw.toString('utf8'))
    if (register.format !== 'bai-history-exceptions/1') throw new Error(`${file}: not a bai-history-exceptions/1 register`)
    let loaded = 0; let kept = 0; let proposed = 0
    await db.query('begin')
    try {
      for (const e of register.entries) {
        const existing = (await db.query('select id from research.history_exceptions where exception_key = $1', [e.id])).rows[0]
        if (existing) {
          kept++
          // Rule proposals for exceptions that have never had one.
          if (args['propose-rules'] && ruleProposal(e) && !(await db.query('select 1 from research.history_exception_proposals where exception_id = $1', [existing.id])).rowCount) {
            const [conclusion, rationale] = ruleProposal(e)
            await db.query('insert into research.history_exception_proposals (exception_id, conclusion, rationale, evidence, proposed_by) values ($1, $2, $3, $4, $5)',
              [existing.id, conclusion, rationale, JSON.stringify(e.evidence ?? []), 'agent:history-review-rules'])
            proposed++
          }
          continue
        }
        const summary = e.claims.map((c) => `${c.source}: ${Array.isArray(c.says) ? `${c.says.length} pairs` : c.says}`).join(' | ')
        const x = (await db.query(`insert into research.history_exceptions (exception_key, draft_year, phase, franchise_key, kind, summary, effect, resolution_needs, item_count, register_sha256, loaded_by)
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
        [e.id, e.year, e.phase, e.club, e.review_kind, summary.slice(0, 2000), e.effect, e.resolution_needs, e.count ?? 1, sha, args.agent ? `agent:${args.agent}` : (args.by ?? 'history-review-loader')])).rows[0]
        let i = 0
        for (const c of e.claims) {
          await db.query('insert into research.history_exception_claims (exception_id, ordinal, source_catalog_id, claim, evidence) values ($1, $2, $3, $4, $5)',
            [x.id, ++i, c.source, JSON.stringify(c.says), JSON.stringify((e.evidence ?? []).filter((v) => c.source.includes(v.source)))])
        }
        loaded++
        if (args['propose-rules'] && ruleProposal(e)) {
          const [conclusion, rationale] = ruleProposal(e)
          await db.query('insert into research.history_exception_proposals (exception_id, conclusion, rationale, evidence, proposed_by) values ($1, $2, $3, $4, $5)',
            [x.id, conclusion, rationale, JSON.stringify(e.evidence ?? []), 'agent:history-review-rules'])
          proposed++
        }
      }
      await db.query('commit')
    } catch (err) { await db.query('rollback'); throw err }
    console.log(`register ${path.relative(root, file)} (sha256 ${sha.slice(0, 12)}…): ${loaded} loaded, ${kept} already present, ${proposed} rule proposal(s)`)
  },

  async list (db) {
    const r = await db.query(`select e.exception_key, e.kind::text, e.status::text, e.item_count, e.franchise_key,
        (select p.conclusion from research.history_exception_proposals p where p.exception_id = e.id and p.status = 'PROPOSED') as open_proposal,
        (select d.conclusion from research.history_exception_decisions d where d.exception_id = e.id order by d.id desc limit 1) as last_conclusion
      from research.history_exceptions e where ($1::text is null or e.status::text = $1) and ($2::text is null or e.kind::text = $2) order by e.draft_year, e.exception_key`,
    [args.status ?? null, args.kind ?? null])
    console.table(r.rows)
  },

  async show (db) {
    const e = (await db.query('select * from research.history_exceptions where exception_key = $1', [need('key')])).rows[0]
    if (!e) throw new Error(`no exception ${args.key}`)
    console.log(`${e.exception_key}  ${e.kind}  ${e.status}  (${e.draft_year} ${e.phase ?? ''} ${e.franchise_key ?? ''}, ${e.item_count} item(s))`)
    console.log(`effect: ${e.effect}\nresolution needs: ${e.resolution_needs}`)
    for (const c of (await db.query('select * from research.history_exception_claims where exception_id = $1 order by ordinal', [e.id])).rows) {
      console.log(`claim ${c.ordinal} [${c.source_catalog_id}]: ${JSON.stringify(c.claim).slice(0, 600)}`)
      for (const v of c.evidence) console.log(`  evidence: ${v.cache_key} sha256 ${String(v.sha256).slice(0, 12)}…`)
    }
    console.log('conclusions:', (await db.query('select conclusion from research.history_exception_conclusions where kind = $1 order by 1', [e.kind])).rows.map((r) => r.conclusion).join(', '))
    console.table((await db.query('select id, status::text, conclusion, proposed_by, created_at, rationale from research.history_exception_proposals where exception_id = $1 order by id', [e.id])).rows)
    console.table((await db.query('select id, decision::text, conclusion, decided_by, decided_session_role, decided_at, rationale from research.history_exception_decisions where exception_id = $1 order by id', [e.id])).rows)
    console.table((await db.query('select at, event, actor, session_role, detail from research.history_exception_events where exception_id = $1 order by id', [e.id])).rows)
  },

  async conclusions (db) {
    console.table((await db.query('select kind::text, conclusion, description from research.history_exception_conclusions where ($1::text is null or kind::text = $1) order by 1, 2', [args.kind ?? null])).rows)
  },

  async propose (db) {
    const e = (await db.query('select id from research.history_exceptions where exception_key = $1', [need('key')])).rows[0]
    if (!e) throw new Error(`no exception ${args.key}`)
    const p = (await db.query('insert into research.history_exception_proposals (exception_id, conclusion, rationale, evidence, proposed_by) values ($1, $2, $3, $4, $5) returning id',
      [e.id, need('conclusion'), need('rationale'), JSON.stringify(json('evidence')), actor()])).rows[0]
    console.log(`proposal ${p.id} filed for ${args.key}; a reviewer decides it (history:review -- decide)`)
  },

  async withdraw (db) {
    await db.query('begin')
    try {
      const p = (await db.query('select * from research.withdraw_history_exception_proposal($1, $2, $3)', [Number(need('proposal')), actor(), need('reason')])).rows[0]
      await db.query('commit')
      console.log(`proposal ${p.id} withdrawn`)
    } catch (err) { await db.query('rollback'); throw err }
  },

  async decide (db) {
    const d = (await db.query('select * from research.decide_history_exception($1, $2, $3, $4, $5, $6)',
      [need('key'), need('decision'), need('rationale'), args.conclusion ?? null, args.proposal ? Number(args.proposal) : null, JSON.stringify(json('evidence'))])).rows[0]
    console.log(`decision ${d.id}: ${d.decision}${d.conclusion ? ` ${d.conclusion}` : ''} by ${d.decided_by} (session ${d.decided_session_role})`)
  }
}

if (!COMMANDS[command]) {
  console.error('usage: history:review -- <load|list|show|conclusions|propose|withdraw|decide> [options]')
  process.exit(1)
}
let db
try {
  // Human-only: the decision runs on the reviewer's own login; everything else on the owner connection (local).
  const url = command === 'decide' ? reviewerDatabaseUrl() : ownerDatabaseUrl()
  if (!isLocalUrl(url)) throw new Error('the historical exception workflow runs on local research databases only (restricted evidence)')
  db = await connect(url)
  await COMMANDS[command](db)
} catch (err) {
  console.error(`error: ${err.message.replace(/postgres(ql)?:\/\/\S+/g, '<redacted>')}`)
  process.exitCode = 1
} finally { await db?.end().catch(() => {}) }
