// Years BAI publishes only in part. The documented size is the draft's published pick count; the note appears only while fewer
// selections than that are represented, so it never shows for a cohort whose pick list is complete (such as 2020).
export const DOCUMENTED_SELECTIONS: Record<number, number> = { 2021: 612, 2022: 616 }

// Years whose represented later-round rows are an editor-chosen set: the source lists the opening picks in full (through `listedThrough`), then
// notable players only. `excludedClubs` names clubs a release leaves out by scope, so their absence is not read as a source gap.
const EDITORIAL_YEARS: Record<number, { listedThrough: number, excludedClubs?: string[] }> = {
  2021: { listedThrough: 71 },
  2022: { listedThrough: 80 }
}

export type PartialYear = { year: number, documented: number, represented: number, absent: number }

/** The coverage summary for a year, or null when the year is not declared partial or its documented pick list is fully represented. */
export function partialYear (year: number, represented: number): PartialYear | null {
  const documented = DOCUMENTED_SELECTIONS[year]
  if (!Number.isInteger(documented) || !Number.isInteger(represented) || represented <= 0 || represented >= documented) return null
  return { year, documented, represented, absent: documented - represented }
}

export function partialYearText (p: PartialYear): string {
  return `${p.year}: ${p.represented} of ${p.documented} documented selections are represented; ${p.absent} are absent.`
}

export const PARTIAL_YEAR_DETAIL = 'An absent selection is not an unsigned player or a failed outcome, and no signing outcome may be inferred from a missing row. No league-wide or club-efficiency rates are published from this incomplete sample.'

// What each declared release listed and left out by scope, so the absent selections can be told apart: `listed` is the number of selections the
// source article lists; `scopeExcluded` is how many of those the release leaves out by scope. Everything else the source lists but BAI has not
// represented is held for identity or collision review; the rest of the documented draft is not listed by the source at all.
const RELEASE_ACCOUNTING: Record<number, { listed: number, scopeExcluded: number }> = {
  2021: { listed: 207, scopeExcluded: 0 },
  2022: { listed: 186, scopeExcluded: 0 }
}

export type AbsentBreakdown = { notListed: number, scope: number, held: number }

/** Splits a year's absent selections into: not listed by the source, left out by release scope, and held for review. Null when the year has no accounting. */
export function absentBreakdown (p: PartialYear | null): AbsentBreakdown | null {
  const a = p ? RELEASE_ACCOUNTING[p.year] : undefined
  if (!p) return null
  if (!a) return null
  const notListed = p.documented - a.listed
  const held = a.listed - a.scopeExcluded - p.represented
  if (notListed < 0 || held < 0) return null
  return { notListed, scope: a.scopeExcluded, held }
}

/** The sentence for a breakdown (`clubs` names the clubs a release leaves out by scope, when any). */
export function formatAbsent (absent: number, b: AbsentBreakdown, clubs?: string): string {
  const parts = [`${b.notListed} are not listed by BAI's source (a source gap)`]
  if (b.scope) parts.push(`${b.scope} ${clubs ? `${clubs} ` : ''}selection${b.scope === 1 ? ' is' : 's are'} outside this release by scope (not a source gap)`)
  parts.push(`${b.held} listed selection${b.held === 1 ? ' is' : 's are'} held for identity or collision review`)
  return `Of the ${absent} absent: ${parts.join('; ')}.`
}

export function absentBreakdownText (p: PartialYear | null): string | null {
  const b = absentBreakdown(p)
  return b && p ? formatAbsent(p.absent, b, EDITORIAL_YEARS[p.year]?.excludedClubs?.join(' and ')) : null
}

const editorialNoteFor = (year: number): string => `For the incomplete ${year} draft, picks 1 to ${EDITORIAL_YEARS[year].listedThrough} are listed in full, but later-round entries are editorially selected notable players, not a representative sample.`
export const EDITORIAL_NOTE_2021 = editorialNoteFor(2021)

/** The later-round note for every declared year that is shown (or searched for). One sentence per year. */
export function editorialNote (years: Array<number | string | null | undefined>): string | null {
  const shown = [...new Set(years.map(Number).filter((y) => Object.hasOwn(EDITORIAL_YEARS, y)))].sort()
  return shown.length ? shown.map(editorialNoteFor).join(' ') : null
}

/** Declared years inside an explorer year range (open ends allowed), so the note shows when a search can include them. */
export function editorialYearsBetween (from: number | null, to: number | null): number[] {
  return Object.keys(EDITORIAL_YEARS).map(Number).filter((y) => y >= (from ?? 0) && y <= (to ?? 9999))
}

/**
 * Years whose later-round note the explorer shows: every year with rows on screen, plus the declared years a search can include, but a searched
 * year only counts when BAI has imported selections for it (a filter alone must not announce a release that has not happened).
 */
export function editorialYearsToShow (rowYears: Array<number | string>, searchedYears: number[], importedYears: Iterable<number>): number[] {
  const imported = new Set(importedYears)
  return [...rowYears.map(Number), ...searchedYears.filter((y) => imported.has(y))]
}

/** What an absent pick can mean. It never means an unsigned player or a failed outcome. */
export const ABSENCE_STATEMENT = 'A pick that is absent may be unavailable in BAI’s sources, deliberately outside a release’s scope, or held for review. Absence never means an unsigned player or a failed outcome.'
