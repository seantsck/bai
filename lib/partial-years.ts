// Years BAI publishes only in part. The documented size is the draft's published pick count; the note appears only while fewer
// selections than that are represented, so it never shows for a cohort whose pick list is complete (such as 2020).
export const DOCUMENTED_SELECTIONS: Record<number, number> = { 2021: 612 }

// Years whose represented later-round rows are an editor-chosen set (the 2021 source lists picks 1-71 in full, then notable players only).
const EDITORIAL_LATER_ROUNDS = new Set([2021])

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

export const PARTIAL_YEAR_DETAIL = 'A missing selection is a gap in BAI’s sources: no signing outcome or failed outcome may be inferred from a missing row. No league-wide or club-efficiency rates are published from this incomplete sample.'

export const EDITORIAL_NOTE_2021 = 'For the incomplete 2021 draft, picks 1 to 71 are listed in full, but later-round entries are editorially selected notable players, not a representative sample.'

/** The 2021-specific later-round note applies only when 2021 rows are shown (or 2021 was searched for). */
export function editorialNote (years: Array<number | string | null | undefined>): string | null {
  return years.some((y) => EDITORIAL_LATER_ROUNDS.has(Number(y))) ? EDITORIAL_NOTE_2021 : null
}
