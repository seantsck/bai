// Historical draft explorer: validated filters -> one parameterized query on v_draft_explorer. Pure functions (no I/O),
// so the rules are testable without a database:
//   * every filter is whitelisted or parsed; unknown values are dropped, never interpolated;
//   * name and school searches are prefix matches on the normalized name (indexed with text_pattern_ops), normalized
//     here exactly as public.normalize_name does it, because the public role may not execute database functions;
//   * pages are fixed-size; the query fetches one extra row to know whether a next page exists (no count(*));
//   * results carry facts only: no rates, no performance figures.

export const PAGE_SIZE = 50
export const MAX_PAGE = 200

export const DRAFT_KINDS = ['JUNE_AMATEUR', 'JANUARY_REGULAR', 'JANUARY_SECONDARY', 'JUNE_SECONDARY', 'JUNE_SECONDARY_DELAYED', 'AUGUST_LEGION'] as const
export const SIGNING_FILTERS = ['SIGNED', 'DID_NOT_SIGN', 'UNKNOWN'] as const
export const SCHOOL_TYPES = ['HIGH_SCHOOL', 'COLLEGE', 'JUNIOR_COLLEGE', 'OTHER'] as const

export interface ExplorerFilters {
  q: string | null
  org: string | null
  year: number | null
  from: number | null
  to: number | null
  kind: string | null
  round: string | null
  school: string | null
  schoolType: string | null
  signing: string | null
  page: number
}

const FROM = 'ÁÀÂÄÃÅĀĂĄÉÈÊËĒĖĘĚÍÌÎÏĪĮÓÒÔÖÕØŌŐÚÙÛÜŪŮŰÑŃÇĆČÝŸŠŽŁĐáàâäãåāăąéèêëēėęěíìîïīįóòôöõøōőúùûüūůűñńçćčýÿšžłđ'
const TO = 'AAAAAAAAAEEEEEEEEIIIIIIOOOOOOOOUUUUUUUNNCCCYYSZLDaaaaaaaaaeeeeeeeeiiiiiioooooooouuuuuuunncccyyszld'
const MAP = new Map([...FROM].map((c, i) => [c, TO[i]]))

/** JavaScript twin of public.normalize_name (001): fold accents, lowercase, keep [a-z0-9 ], collapse spaces. */
export function normalizeName (value: string): string | null {
  const folded = [...value].map((c) => MAP.get(c) ?? c).join('').toLowerCase()
  const out = folded.replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
  return out === '' ? null : out
}

type Params = Record<string, string | string[] | undefined>
const one = (p: Params, k: string): string | null => { const v = p[k]; const s = Array.isArray(v) ? v[0] : v; return s && s.trim() ? s.trim() : null }
const yearOf = (s: string | null): number | null => (s && /^\d{4}$/.test(s) && Number(s) >= 1965 && Number(s) <= 2100 ? Number(s) : null)
const pick = <T extends readonly string[]>(s: string | null, allowed: T): T[number] | null => (s && (allowed as readonly string[]).includes(s.toUpperCase()) ? s.toUpperCase() as T[number] : null)

export function parseExplorerParams (p: Params): ExplorerFilters {
  const q = one(p, 'q')
  const school = one(p, 'school')
  const org = one(p, 'org')
  const round = one(p, 'round')
  const page = Number(one(p, 'page') ?? 1)
  return {
    q: q ? normalizeName(q.slice(0, 80)) : null,
    org: org && /^[A-Za-z]{2,4}$/.test(org) ? org.toUpperCase() : null,
    year: yearOf(one(p, 'year')),
    from: yearOf(one(p, 'from')),
    to: yearOf(one(p, 'to')),
    kind: pick(one(p, 'kind'), DRAFT_KINDS),
    round: round && /^(\d{1,3}|C-\d{1,2}|S-\d{1,2}|CB-[AB])$/i.test(round) ? round.toUpperCase() : null,
    school: school ? normalizeName(school.slice(0, 80)) : null,
    schoolType: pick(one(p, 'schoolType'), SCHOOL_TYPES),
    signing: pick(one(p, 'signing'), SIGNING_FILTERS),
    page: Number.isInteger(page) && page >= 1 ? Math.min(page, MAX_PAGE) : 1
  }
}

/** A prefix for LIKE with the wildcard characters escaped (normalized names contain none, but stay defensive). */
const prefix = (s: string) => `${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`

export function buildExplorerQuery (f: ExplorerFilters): { sql: string, params: unknown[] } {
  const where: string[] = []
  const params: unknown[] = []
  const add = (clause: string, value: unknown) => { params.push(value); where.push(clause.replace('?', `$${params.length}`)) }
  if (f.q) add('name_normalized like ?', prefix(f.q))
  if (f.org) add('franchise_key = ?', f.org)
  if (f.year) add('draft_year = ?', f.year)
  if (!f.year && f.from) add('draft_year >= ?', f.from)
  if (!f.year && f.to) add('draft_year <= ?', f.to)
  if (f.kind) add('draft_kind = ?::draft_kind', f.kind)
  if (f.round) add('round_code = ?', f.round)
  if (f.school) add('school_normalized like ?', prefix(f.school))
  if (f.schoolType) add('school_type = ?::school_type', f.schoolType)
  if (f.signing) add('signing_status = ?', f.signing)
  params.push(PAGE_SIZE + 1, (f.page - 1) * PAGE_SIZE)
  const sql = `select selection_id, draft_key, draft_year, draft_kind, round_code, overall_pick, round_pick, franchise_key, organization_slug,
      organization_name_then, league_then, division_then, player_slug, display_name, school_name, school_type, signing_status, signing_bonus_usd
    from v_draft_explorer${where.length ? ` where ${where.join(' and ')}` : ''}
    order by draft_year desc, draft_kind, overall_pick, selection_id
    limit $${params.length - 1} offset $${params.length}`
  return { sql, params }
}

/** Query string for a page of the same search (filters kept, page replaced). */
export function explorerHref (f: ExplorerFilters, page: number, raw: { q?: string | null, school?: string | null } = {}): string {
  const s = new URLSearchParams()
  if (raw.q ?? f.q) s.set('q', String(raw.q ?? f.q))
  if (f.org) s.set('org', f.org)
  if (f.year) s.set('year', String(f.year))
  if (!f.year && f.from) s.set('from', String(f.from))
  if (!f.year && f.to) s.set('to', String(f.to))
  if (f.kind) s.set('kind', f.kind)
  if (f.round) s.set('round', f.round)
  if (raw.school ?? f.school) s.set('school', String(raw.school ?? f.school))
  if (f.schoolType) s.set('schoolType', f.schoolType)
  if (f.signing) s.set('signing', f.signing)
  if (page > 1) s.set('page', String(page))
  const qs = s.toString()
  return `/draft/explorer${qs ? `?${qs}` : ''}`
}
