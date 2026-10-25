// Display helpers. Unknown is never rendered as zero: null money is "Unknown", null WAR is "Not observed".

export function formatUsd (value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return 'Unknown'
  const n = Number(value)
  if (!Number.isFinite(n)) return 'Unknown'
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
}

export function formatWar (value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return 'Not observed'
  const n = Number(value)
  return Number.isFinite(n) ? n.toFixed(1) : 'Not observed'
}

export function formatDate (value: string | Date | null | undefined, precision?: string | null): string {
  if (!value) return 'Unknown'
  const iso = value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10)
  if (precision === 'SEASON' || precision === 'YEAR') return iso.slice(0, 4)
  if (precision === 'MONTH') return iso.slice(0, 7)
  return iso
}

export function formatCount (value: string | number | null | undefined): string {
  if (value === null || value === undefined) return 'Unknown'
  return Number(value).toLocaleString('en-US')
}

export const AUDIT_STATE_LABELS: Record<string, string> = {
  NOT_AUDITED: 'Not audited',
  AUDITED_REACHED_MLB: 'Audited: reached MLB',
  AUDITED_NO_MLB: 'Audited: no MLB',
  ACTIVE_TOO_RECENT: 'Active / too recent',
  OUT_OF_SCOPE: 'Out of scope',
  UNKNOWN: 'Unknown'
}

export const COVERAGE_STATE_LABELS: Record<string, { label: string, supportsRates: boolean, description: string }> = {
  COMPLETE_CENSUS: { label: 'Complete census', supportsRates: true, description: 'Every member of a defined, known-size population is tracked.' },
  SUBSTANTIALLY_COMPLETE: { label: 'Substantially complete', supportsRates: true, description: 'Known population size; nearly all tracked, gaps listed.' },
  PARTIAL_RECONSTRUCTION: { label: 'Partial reconstruction', supportsRates: false, description: 'A reconstructed subset; the population size may be unknown.' },
  RANKED_SAMPLE: { label: 'Ranked sample', supportsRates: false, description: 'Players who appeared on a published ranking — selected, not representative.' },
  INDIVIDUALLY_VERIFIED: { label: 'Individually verified', supportsRates: false, description: 'An ad hoc set of individually verified records.' },
  UNKNOWN: { label: 'Unknown', supportsRates: false, description: 'Coverage has not been assessed.' }
}

// Draft phases (024). Historical years held several; June regular is the modern Rule 4 draft.
export const KIND_LABELS: Record<string, string> = {
  JUNE_AMATEUR: 'June (regular)', JANUARY_REGULAR: 'January (regular)', JANUARY_SECONDARY: 'January (secondary)',
  JUNE_SECONDARY: 'June (secondary)', JUNE_SECONDARY_DELAYED: 'June (secondary, delayed)', AUGUST_LEGION: 'August (American Legion)'
}

// Public attribution groups (migration 025, sources.attribution_category). Attribution says where a record came from; it is
// not a statement that BAI holds redistribution rights.
export const SOURCE_GROUP_LABELS: Record<string, string> = {
  MLB: 'MLB (Stats API, transaction wire, MLB.com)',
  BASEBALL_REFERENCE: 'Baseball-Reference',
  CHADWICK_REGISTER: 'Chadwick Register',
  WIKIPEDIA: 'Wikipedia',
  WIKIDATA: 'Wikidata',
  RETROSHEET: 'Retrosheet',
  BAI_RESEARCH: 'BAI research',
  OTHER_PUBLICATION: 'Other publications'
}
export const SOURCE_GROUP_SHORT: Record<string, string> = {
  MLB: 'MLB', BASEBALL_REFERENCE: 'B-Ref', CHADWICK_REGISTER: 'Chadwick', WIKIPEDIA: 'Wikipedia', WIKIDATA: 'Wikidata', RETROSHEET: 'Retrosheet', BAI_RESEARCH: 'BAI research', OTHER_PUBLICATION: 'Publication'
}

export const SIGNING_STATUS_LABELS: Record<string, string> = {
  SIGNED: 'Signed',
  DID_NOT_SIGN: 'Did not sign',
  UNKNOWN: 'Not researched'
}

export const PATHWAY_LABELS: Record<string, string> = {
  INTERNATIONAL_AMATEUR: 'International amateur',
  POSTING_SYSTEM: 'Posting system',
  INTERNATIONAL_PROFESSIONAL: 'International professional',
  OTHER: 'Other'
}

export function label (map: Record<string, string>, key: string | null | undefined): string {
  if (!key) return 'Unknown'
  return map[key] ?? key
}

// Compact coverage-state codes for the dashboard matrix. Absence of an assessment is shown as "not assessed", never as a state.
export const COVERAGE_STATE_CODES: Record<string, string> = {
  COMPLETE_CENSUS: 'CC',
  SUBSTANTIALLY_COMPLETE: 'SC',
  PARTIAL_RECONSTRUCTION: 'PR',
  RANKED_SAMPLE: 'RS',
  INDIVIDUALLY_VERIFIED: 'IV',
  UNKNOWN: '?'
}

/** Share of a basis that is known; no basis means there is nothing to measure, which is not 0%. */
export function formatShare (known: string | number | null | undefined, basis: string | number | null | undefined): string {
  const b = Number(basis ?? 0)
  if (!b) return '—'
  return `${Math.round((Number(known ?? 0) / b) * 100)}% (${Number(known ?? 0)}/${b})`
}
