// Source attribution shared by the public pages. The Retrosheet statement is Retrosheet's own required wording (https://www.retrosheet.org/notice.txt), verbatim;
// the database holds the same text (public.source_attribution_statements, migration 030) and tests/app/attribution.test.mjs keeps the two identical.
export const RETROSHEET_STATEMENT = 'The information used here was obtained free of charge from and is copyrighted by Retrosheet. Interested parties may contact Retrosheet at "www.retrosheet.org".'

export type Statement = Record<string, any>

/**
 * The statements a page must show. `authorized` is the list of source groups whose records the site currently publishes (rm_transaction_overview.display_authorized_categories);
 * when it is unknown (the totals are being refreshed or unavailable) every statement is required: crediting a source never hides data, omitting a credit would.
 * `shown` forces the statements when the page is displaying rows that name a group as required.
 */
export function requiredStatements (statements: Statement[], authorized: string[] | null | undefined, shown = false): Statement[] {
  if (!authorized || shown) return statements
  return statements.filter((s) => authorized.includes(s.attribution_category))
}
