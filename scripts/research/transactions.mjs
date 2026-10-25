// Transaction forensics tools (migration 028, docs/transactions/06). Local databases only in Phase 16: nothing here
// reaches the hosted project until a later, separately authorized phase.
//
//   npm run transactions -- prepare  --in raw.json --out prepared.json        deterministic normalization, no database
//   npm run transactions -- preview  --file prepared.json                    read-only: NEW / EXISTING / COLLISION / CONFLICT per record
//   npm run transactions -- status   --transaction <id>                      derived completeness and the gaps a person would fix
//   npm run transactions -- verify   --transaction <id> --basis "..." --independence "..."   REVIEWER LOGIN: verify one transaction complete
//   npm run transactions -- revoke   --transaction <id> --reason "..."       REVIEWER LOGIN
//   npm run transactions -- resolve-conflict --conflict <id> --note "..."    REVIEWER LOGIN
//
// Import itself is the existing pipeline: research:import (stage, --league), research:validate, research:apply (dry run
// first; --write applies atomically). Completeness is never set by import; only `verify` can make a transaction
// VERIFIED_COMPLETE, on the reviewer's own authenticated login (BAI_REVIEWER_DATABASE_URL), while the certification gate is open.
import fs from 'node:fs'
import pg from 'pg'
import { ownerDatabaseUrl, reviewerDatabaseUrl, isLocalUrl } from '../db/lib/connection.mjs'
import * as T from './lib/transactions.mjs'

const [command, ...rest] = process.argv.slice(2)
const args = {}
for (let i = 0; i < rest.length; i++) if (rest[i].startsWith('--')) { args[rest[i].slice(2)] = rest[i + 1] === undefined || rest[i + 1].startsWith('--') ? true : rest[++i] }
const need = (k) => { if (!args[k] || args[k] === true) throw new Error(`--${k} is required`); return args[k] }
const identityInput = (p) => ({ full_name: p.full_name, birth_date: p.birth_date ?? null, birth_country: p.birth_country ?? null, external_ids: p.external_ids ?? {} })
const localOnly = (url) => { if (!isLocalUrl(url)) throw new Error('Phase 16 tools run on local databases only; hosted use needs a separate authorization') }

async function main () {
  switch (command) {
    case 'prepare': {
      const doc = JSON.parse(fs.readFileSync(need('in'), 'utf8'))
      if (doc.channel !== 'TRADES') throw new Error('only TRADES documents are prepared')
      fs.writeFileSync(need('out'), T.prepareToText(doc))
      console.log(`prepared ${doc.records.length} record(s) -> ${args.out}`)
      return 0
    }
    case 'preview': {
      const url = ownerDatabaseUrl({ localOnly: true }); localOnly(url)
      const doc = T.prepareTradeDoc(JSON.parse(fs.readFileSync(need('file'), 'utf8')))
      const db = new pg.Client({ connectionString: url }); await db.connect()
      try {
        await db.query('begin read only')
        const rows = await T.previewTrades(db, doc, { identityInput })
        console.table(rows.map((r) => ({ record: r.index, ref: r.ref, date: r.date, kind: r.kind, transaction: r.transaction_id ?? '', collisions: r.collisions.length, conflicts: r.conflicts.length, problems: r.in_batch_problems.length, new_players: r.new_players.length })))
        for (const r of rows) for (const c of r.conflicts) console.log(`  record ${r.index} conflict ${c.field_path}: ${c.existing} vs ${c.incoming}`)
        await db.query('rollback')
        return rows.some((r) => r.kind === 'COLLISION' || r.kind === 'CONFLICT' || r.in_batch_problems.length) ? 3 : 0
      } finally { await db.end() }
    }
    case 'status': {
      const url = ownerDatabaseUrl({ localOnly: true }); localOnly(url)
      const db = new pg.Client({ connectionString: url }); await db.connect()
      try {
        const r = (await db.query('select * from analytics.transaction_completeness where transaction_id = $1', [need('transaction')])).rows[0]
        if (!r) throw new Error('no such transaction')
        console.log(`${r.completeness}  independent source groups ${r.independent_source_groups}${r.verified_by ? `  verified by ${r.verified_by} on ${r.verified_at.toISOString()}` : ''}${r.verification_stale ? '  (verification is stale)' : ''}`)
        console.log(r.gaps.length ? `gaps: ${r.gaps.join(', ')}` : 'no gaps: a reviewer may verify it')
        return 0
      } finally { await db.end() }
    }
    case 'verify': case 'revoke': case 'resolve-conflict': {
      const url = reviewerDatabaseUrl(); localOnly(url)
      const db = new pg.Client({ connectionString: url }); await db.connect()
      try {
        if (command === 'verify') {
          const r = (await db.query('select * from research.verify_transaction($1, $2, $3)', [need('transaction'), need('basis'), need('independence')])).rows[0]
          console.log(`transaction ${r.transaction_id} VERIFIED_COMPLETE by ${r.verified_by} (authenticated session), fingerprint ${r.content_fingerprint.slice(0, 12)}…`)
        } else if (command === 'revoke') {
          const r = (await db.query('select * from research.revoke_transaction_verification($1, $2)', [need('transaction'), need('reason')])).rows[0]
          console.log(`verification ${r.id} of transaction ${r.transaction_id} revoked by ${r.revoked_by}`)
        } else {
          const r = (await db.query('select * from research.resolve_transaction_conflict($1, $2)', [need('conflict'), need('note')])).rows[0]
          console.log(`conflict ${r.id} resolved by ${r.resolved_by}`)
        }
        return 0
      } finally { await db.end() }
    }
    default:
      console.error('usage: transactions <prepare|preview|status|verify|revoke|resolve-conflict> (see the header of scripts/research/transactions.mjs)')
      return 1
  }
}
try { process.exit(await main()) } catch (err) { console.error(`error: ${String(err.message).replace(/postgres(ql)?:\/\/\S+/g, '<redacted>')}`); process.exit(1) }
