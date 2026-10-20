// Runbook helper: runs research CLI commands exactly as a researcher would (same validation, same guards) and stops on
// the first failure. Used by the replayable runbooks in this directory.
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { ownerDatabaseUrl } from '../../scripts/db/lib/connection.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const extra = process.argv.includes('--confirm-hosted') ? ['--confirm-hosted', process.argv[process.argv.indexOf('--confirm-hosted') + 1]] : []

export function cli (command, args = [], { operator, allowFail = false } = {}) {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts/research/cli.mjs'), command, ...args, ...extra], {
    cwd: root, encoding: 'utf8', env: { ...process.env, BAI_OPERATOR: operator ?? process.env.BAI_OPERATOR ?? 'runbook' }
  })
  process.stdout.write(`$ research:${command} ${args.join(' ')}\n${r.stdout}${r.stderr}`)
  if (r.status !== 0 && !allowFail) throw new Error(`research:${command} exited ${r.status}`)
  return r
}

/** One-row lookup (ids differ between databases, so runbooks find subjects by natural keys). */
export async function lookup (sql, params) {
  const db = new pg.Client({ connectionString: ownerDatabaseUrl() })
  await db.connect()
  try { return (await db.query(sql, params)).rows[0] } finally { await db.end() }
}

/** Observation id of what a source said about a field of a draft pick (natural keys only). */
export const pickObservation = (draftKey, overallPick, table, field, sourceKey) => lookup(`select o.id as observation_id, o.subject_id from public.source_observations o
  join public.sources s on s.id = o.source_id
  join public.draft_selections sel on (o.subject_table = 'draft_selections' and sel.id = o.subject_id)
    or (o.subject_table = 'draft_signings' and sel.id = (select draft_selection_id from public.draft_signings g where g.id = o.subject_id))
  join public.drafts d on d.id = sel.draft_id
  where d.draft_key = $1 and sel.overall_pick = $2 and o.subject_table = $3 and o.field_name = $4 and s.source_key = $5 and o.status = 'ACTIVE'`, [draftKey, overallPick, table, field, sourceKey])

export function refresh () {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts/db/refresh-read-models.mjs'), ...extra], { cwd: root, encoding: 'utf8', env: process.env })
  process.stdout.write(`$ refresh:read-models\n${r.stdout}${r.stderr}`)
  if (r.status !== 0) throw new Error('refresh failed')
}
