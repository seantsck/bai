// Source attribution shared by the public pages. The Retrosheet statement is Retrosheet's own required wording (https://www.retrosheet.org/notice.txt), verbatim;
// the database holds the same text (public.source_attribution_statements, migration 030) and tests/app/attribution.test.mjs keeps the two identical.
export const RETROSHEET_STATEMENT = 'The information used here was obtained free of charge from and is copyrighted by Retrosheet. Interested parties may contact Retrosheet at "www.retrosheet.org".'

export const RETROSHEET_NOTICE_URL = 'https://www.retrosheet.org/notice.txt'

export type Statement = Record<string, any>

/** Retrosheet's entry, from the constants above only: it never depends on a database read, so it can always be shown. */
export const RETROSHEET_ENTRY: Statement = Object.freeze({ attribution_category: 'RETROSHEET', statement: RETROSHEET_STATEMENT, notice_url: RETROSHEET_NOTICE_URL })

export interface PageEvidence {
  /** Statements read from the database (source_attribution_statements); null when that read failed. Used only for groups other than Retrosheet. */
  statements: Statement[] | null
  /** Source groups the site currently publishes (rm_transaction_overview); null when the overview is unavailable. It can lag a promotion, so it never decides alone. */
  authorized: string[] | null
  /** Rows on the page that name a group as required (rm_transactions.attribution_required, set by the same refresh as the rows themselves). */
  rowsRequire?: boolean
  /** The displayed record's own source groups; undefined for a page that is not about one record; null when the record's groups are unknown. */
  recordCategories?: string[] | null
  /** The page shows aggregate figures built from the published rows (the coverage page): true when any of them is positive. */
  aggregatesPresent?: boolean
}

/**
 * Whether the Retrosheet statement is owed, failing closed. It is owed unless the page positively shows that no Retrosheet-derived content is displayed:
 * the overview must have answered, without Retrosheet among the published groups, and no row, record or aggregate on the page may point at it.
 */
export function retrosheetOwed (e: PageEvidence): boolean {
  if (e.recordCategories !== undefined) return e.recordCategories === null || e.recordCategories.includes('RETROSHEET') || e.rowsRequire === true
  return e.rowsRequire === true || e.aggregatesPresent === true || e.authorized === null || e.authorized.includes('RETROSHEET')
}

/**
 * The statements a page must show. Retrosheet's comes from the constant (never from the database, so a failed statement query cannot remove it); any other group's statement
 * comes from the database and is shown when that group is published, or when the evidence is unknown.
 */
export function pageStatements (e: PageEvidence): Statement[] {
  const others = (e.statements ?? []).filter((s) => s.attribution_category !== 'RETROSHEET').filter((s) => {
    if (e.recordCategories !== undefined) return e.recordCategories === null || e.recordCategories.includes(s.attribution_category)
    return e.authorized === null || e.rowsRequire === true || e.authorized.includes(s.attribution_category)
  })
  return [...(retrosheetOwed(e) ? [RETROSHEET_ENTRY] : []), ...others].sort((a, b) => String(a.attribution_category).localeCompare(String(b.attribution_category)))
}
