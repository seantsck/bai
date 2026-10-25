// Historical transaction explorer: validated filters -> one parameterized query on rm_transactions, plus the plain-language status rules.
// Pure functions (no I/O), so the rules are testable without a database:
//   * every filter is whitelisted or parsed; unknown values are dropped, never interpolated;
//   * the player and club search is a prefix tsquery built here from normalized tokens (the public role may not execute BAI functions);
//   * pages are fixed-size and fetch one extra row to know whether a next page exists (no count(*));
//   * the status shown is exactly what the database derived. Three different things are never merged: a source licensed for display, a transaction
//     VERIFIED_COMPLETE (an active human verification), and a club-season COMPLETE_CENSUS. No winner, grade or score exists here.
import { normalizeName } from './search.ts'

export const TX_PAGE_SIZE = 50
export const TX_MAX_PAGE = 200

export const TX_CATEGORIES = ['TRADE', 'FREE_AGENT', 'AMATEUR_FREE_AGENT', 'WAIVER', 'PURCHASE', 'RULE_5'] as const
export const TX_STATUSES = ['UNVERIFIED', 'PARTIAL', 'VERIFIED_COMPLETE'] as const

export const CATEGORY_LABELS: Record<string, string> = {
  TRADE: 'Trade', FREE_AGENT: 'Free-agent signing', AMATEUR_FREE_AGENT: 'Amateur free-agent signing', WAIVER: 'Waiver claim', PURCHASE: 'Purchase', RULE_5: 'Rule 5 selection', OTHER: 'Other'
}
export const STATUS_LABELS: Record<string, string> = { UNVERIFIED: 'Unverified', PARTIAL: 'Partial', VERIFIED_COMPLETE: 'Verified complete' }

/** What a gap code means, in words a reader can act on. Unknown codes are shown as they are, never hidden. */
export const GAP_LABELS: Record<string, string> = {
  NO_EXTERNAL_ID: 'No stable identifier from a source',
  NO_PACKAGES: 'No trade packages recorded',
  ONE_SIDED_TRADE: 'Only one direction of the trade is recorded',
  EMPTY_PACKAGE: 'A package with nothing in it',
  NO_SOURCES: 'No source recorded',
  FEWER_THAN_TWO_INDEPENDENT_SOURCES: 'Fewer than two independent sources',
  NO_PRIMARY_ANNOUNCEMENT: 'No primary announcement cited',
  PACKAGE_NOT_CORROBORATED: 'A package is supported by fewer than two independent sources',
  ASSET_NOT_CORROBORATED: 'An asset is supported by fewer than two independent sources',
  PENDING_PTBNL: 'A player to be named has not been named in the record',
  CASH_AMOUNT_UNKNOWN: 'A cash amount is not established',
  OPEN_CONFLICT: 'Sources disagree and no person has resolved it',
  NON_TRADE_VERIFICATION_NOT_DEFINED: 'No verification rule exists yet for this kind of transaction'
}

export interface TransactionFilters { q: string | null, season: number | null, club: string | null, category: string | null, status: string | null, page: number }
type Params = Record<string, string | string[] | undefined>
const one = (p: Params, k: string): string | null => { const v = p[k]; const s = Array.isArray(v) ? v[0] : v; return s && s.trim() ? s.trim() : null }

export function parseTransactionParams (p: Params): TransactionFilters {
  const season = one(p, 'season')
  const club = one(p, 'club')
  const category = one(p, 'type')?.toUpperCase() ?? null
  const status = one(p, 'status')?.toUpperCase() ?? null
  const page = Number(one(p, 'page') ?? 1)
  return {
    q: one(p, 'q') ? normalizeName(one(p, 'q') as string) : null,
    season: season && /^\d{4}$/.test(season) && Number(season) >= 1871 && Number(season) <= 2100 ? Number(season) : null,
    club: club && /^[A-Za-z]{2,4}$/.test(club) ? club.toUpperCase() : null,
    category: category && (TX_CATEGORIES as readonly string[]).includes(category) ? category : null,
    status: status && (TX_STATUSES as readonly string[]).includes(status) ? status : null,
    page: Number.isInteger(page) && page >= 1 ? Math.min(page, TX_MAX_PAGE) : 1
  }
}

/** Prefix tsquery text from a normalized search string: each token a prefix, all required. */
export function searchQueryText (q: string | null): string | null {
  if (!q) return null
  const tokens = q.split(' ').filter((t) => /^[a-z0-9]+$/.test(t)).slice(0, 6).map((t) => `${t.slice(0, 30)}:*`)
  return tokens.length ? tokens.join(' & ') : null
}

export function buildTransactionQuery (f: TransactionFilters): { sql: string, params: Array<string | number> } {
  const where: string[] = []
  const params: Array<string | number> = []
  const add = (clause: string, v: string | number) => { params.push(v); where.push(clause.replace('$$', `$${params.length}`)) }
  const tsq = searchQueryText(f.q)
  if (tsq) add("t.search_tsv @@ to_tsquery('simple', $$)", tsq)
  if (f.season !== null) add('t.season = $$', f.season)
  if (f.club) add('t.club_keys @> array[$$]::text[]', f.club)
  if (f.category) add('t.category = $$', f.category)
  if (f.status) add('t.status = $$', f.status)
  params.push(TX_PAGE_SIZE + 1, (f.page - 1) * TX_PAGE_SIZE)
  const sql = `select t.transaction_id, t.season, t.transaction_date, t.date_precision, t.category, t.club_keys, t.parties, t.status, t.verified_on, t.asset_count, t.player_count,
      t.cash_unknown, t.has_unresolved_ptbnl, t.attribution_required,
      (select string_agg(p.player_name, ', ' order by p.player_name) from (select player_name from rm_transaction_players where transaction_id = t.transaction_id order by player_name limit 4) p) as players
    from rm_transactions t${where.length ? ` where ${where.join(' and ')}` : ''}
    order by t.transaction_date desc, t.transaction_id desc limit $${params.length - 1} offset $${params.length}`
  return { sql, params }
}

export function transactionHref (f: TransactionFilters, page: number, override: Partial<Record<'q' | 'season' | 'club' | 'type' | 'status', string>> = {}): string {
  const q = new URLSearchParams()
  const set = (k: string, v: string | number | null | undefined) => { if (v !== null && v !== undefined && v !== '') q.set(k, String(v)) }
  set('q', override.q ?? f.q)
  set('season', override.season ?? f.season)
  set('club', override.club ?? f.club)
  set('type', override.type ?? f.category)
  set('status', override.status ?? f.status)
  if (page > 1) q.set('page', String(page))
  const s = q.toString()
  return s ? `/transactions?${s}` : '/transactions'
}

export interface StatusView { label: string, tone: 'complete' | 'partial' | 'unverified', headline: string, detail: string }

/**
 * The status of a transaction in words. VERIFIED_COMPLETE is claimed only when the database says so AND carries the date of the active human
 * verification and lists no gap; anything else is shown as what it is. A licence to display the source says nothing about completeness.
 */
export function statusView (status: string, verifiedOn: string | Date | null, gaps: string[]): StatusView {
  if (status === 'VERIFIED_COMPLETE' && verifiedOn && gaps.length === 0) {
    return { label: STATUS_LABELS.VERIFIED_COMPLETE, tone: 'complete', headline: 'Verified complete',
      detail: 'A reviewer checked every party and asset against two independent sources and that verification is still current. Any later change to the record withdraws it.' }
  }
  if (status === 'UNVERIFIED') {
    return { label: STATUS_LABELS.UNVERIFIED, tone: 'unverified', headline: 'Unverified',
      detail: 'This record cites no corroborating source and has not been checked by a person. Treat it as a lead, not a fact.' }
  }
  return { label: STATUS_LABELS.PARTIAL, tone: 'partial', headline: 'Partial',
    detail: 'The record has at least one source and is shown as reconstructed. It has not been verified complete: what is known and what is not is listed below. Being shown here means its source may be displayed, not that the record is complete.' }
}

export const gapLabel = (code: string): string => GAP_LABELS[code] ?? code

export function formatTransactionDate (date: string | Date, precision: string): string {
  const d = date instanceof Date ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` : String(date).slice(0, 10)
  if (precision === 'MONTH') return d.slice(0, 7)
  if (precision === 'YEAR' || precision === 'SEASON') return d.slice(0, 4)
  return d
}

export const EVIDENCE_LABELS: Record<string, string> = {
  OBSERVED_COMPLETE: 'Observed (every received player accounted for)',
  OBSERVED_PARTIAL: 'Observed in part (known values only)',
  NOT_OBSERVED: 'Not observed',
  WITHHELD_PERMISSION: 'Not shown: source permission pending'
}

export const AMOUNT_LABELS: Record<string, string> = { DISCLOSED: 'Disclosed', UNDISCLOSED: 'Undisclosed (the source says so)', UNKNOWN: 'Amount not established' }
