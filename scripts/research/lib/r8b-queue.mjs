// R8B research queues: a READ-ONLY, ranked work list of published TRADE records that still lack what research.transaction_gaps (migration 030) requires for VERIFIED_COMPLETE.
// It selects, ranks and writes ids, dates, clubs, asset counts and gap codes. It never writes to the database, never copies source text, and refuses to write inside a git work
// tree (the lists are derived from licensed data and must not be committed). Nothing here verifies, certifies or changes a fact: that is a human reviewer's act (docs/transactions/r8b-research-queues.md).
import fs from 'node:fs'
import path from 'node:path'

export const TIERS = ['P1A', 'P1B', 'P2', 'P3']   // P1A: unresolved PTBNL, cash known. P1B: unresolved PTBNL and unknown cash. P2: clean. P3: unknown cash, no PTBNL.
export const QUEUES = { 'queue-1-ptbnl': (r) => r.ptbnl, 'queue-2-clean-trades': (r) => !r.ptbnl && !r.cash_unknown, 'queue-3-cash-unknown': (r) => !r.ptbnl && r.cash_unknown }
export const COLUMNS = ['rank', 'tier', 'transaction_id', 'season', 'date', 'club_keys', 'asset_count', 'player_count', 'conditional_assets', 'unresolved_ptbnl_assets', 'cash_unknown', 'external_ids', 'gaps']

export const tierOf = (r) => (r.ptbnl ? (r.cash_unknown ? 'P1B' : 'P1A') : r.cash_unknown ? 'P3' : 'P2')
/** A transparent difficulty score: more assets, conditional assets, unknown cash and a pending PTBNL all mean more evidence to find. */
export const difficulty = (r) => Number(r.asset_count) + (Number(r.conditional_assets) ? 2 : 0) + (r.cash_unknown ? 2 : 0) + (r.ptbnl ? 2 : 0)

/** Ranks one queue: tier, then difficulty, then newer season first, then id. Pure and deterministic. */
export function rank (rows, keep) {
  return rows.filter(keep).map((r) => ({ ...r, tier: tierOf(r) }))
    .sort((a, b) => TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier) || difficulty(a) - difficulty(b) || b.season - a.season || a.transaction_id - b.transaction_id)
    .map((r, i) => ({ ...r, rank: i + 1 }))
}

/** A cell that a spreadsheet would read as a formula (it starts with = + - @, a tab or a carriage return) is neutralised with a leading apostrophe (OWASP CSV-injection guidance), then quoted if needed. */
export const FORMULA_START = /^[=+\-@\t\r]/
export const cell = (v) => {
  let s = v == null ? '' : Array.isArray(v) ? v.join('|') : String(v)
  if (FORMULA_START.test(s)) s = `'${s}`
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
export const toCsv = (rows) => [COLUMNS.join(','), ...rows.map((r) => COLUMNS.map((k) => cell(r[k])).join(','))].join('\n') + '\n'

/** The output directory must be new and outside every git work tree. */
export function assertOutputAllowed (dir) {
  const abs = path.resolve(dir)
  if (fs.existsSync(abs)) throw new Error(`${abs} already exists: queues are never overwritten`)
  for (let d = path.dirname(abs); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) throw new Error(`${abs} is inside the git work tree ${d}: the queues come from licensed data and must not be committed`)
    if (d === path.dirname(d)) break
  }
  return abs
}

/** Published trades only (the read model), with the counts a researcher needs. Read-only SELECT; the session is forced read-only by the caller. */
export const TRADES_SQL = `select r.transaction_id, r.season, r.transaction_date::text as date, r.club_keys, r.gaps, r.cash_unknown, r.has_unresolved_ptbnl as ptbnl, r.asset_count, r.player_count,
  (select count(*) from public.rm_transaction_assets a where a.transaction_id = r.transaction_id and a.conditional)::int as conditional_assets,
  (select count(*) from public.rm_transaction_assets a where a.transaction_id = r.transaction_id and a.resolution_kind is null and a.asset_kind ilike '%named%')::int as unresolved_ptbnl_assets,
  (select string_agg(distinct x.external_id, '|') from public.transaction_external_ids x where x.transaction_id = r.transaction_id) as external_ids
  from public.rm_transactions r where r.transaction_type = 'TRADE' order by r.transaction_date, r.transaction_id`
export const fetchTrades = async (client) => (await client.query(TRADES_SQL)).rows

/** Writes the three queues (mode 600, directory 700) and returns the counts only. */
export function writeQueues (rows, outDir) {
  const abs = assertOutputAllowed(outDir); fs.mkdirSync(abs, { recursive: true, mode: 0o700 })
  const counts = {}
  for (const [name, keep] of Object.entries(QUEUES)) { const q = rank(rows, keep); fs.writeFileSync(path.join(abs, `${name}.csv`), toCsv(q), { mode: 0o600 }); counts[name] = q.length }
  return counts
}
