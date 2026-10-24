// Years BAI publishes only in part. The documented size is the draft's published pick count; the note appears only while fewer
// selections than that are represented, so it never shows for a cohort whose pick list is complete (such as 2020).
export const DOCUMENTED_SELECTIONS: Record<number, number> = { 2021: 612, 2022: 616 }

// Years whose represented later-round rows are an editor-chosen set: the source lists the opening picks in full (through `listedThrough`), then
// notable players only. `excludedClubs` names clubs a release leaves out by scope, so their absence is not read as a source gap.
const EDITORIAL_YEARS: Record<number, { listedThrough: number, excludedClubs?: string[] }> = {
  2021: { listedThrough: 71 },
  2022: { listedThrough: 80, excludedClubs: ['Los Angeles Dodgers'] }
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

export const PARTIAL_YEAR_DETAIL = 'A missing selection is a gap in BAI’s sources: no signing outcome or failed outcome may be inferred from a missing row. No league-wide or club-efficiency rates are published from this incomplete sample.'

const editorialNoteFor = (year: number): string => `For the incomplete ${year} draft, picks 1 to ${EDITORIAL_YEARS[year].listedThrough} are listed in full, but later-round entries are editorially selected notable players, not a representative sample.`
export const EDITORIAL_NOTE_2021 = editorialNoteFor(2021)

/** The later-round note for every declared year that is shown (or searched for). One sentence per year. */
export function editorialNote (years: Array<number | string | null | undefined>): string | null {
  const shown = [...new Set(years.map(Number).filter((y) => Object.hasOwn(EDITORIAL_YEARS, y)))].sort()
  return shown.length ? shown.map(editorialNoteFor).join(' ') : null
}

/** Clubs a year's release leaves out by scope, as a sentence (null when none). */
export function scopeNote (year: number): string | null {
  const clubs = EDITORIAL_YEARS[year]?.excludedClubs
  return clubs?.length ? `${clubs.join(' and ')} selections are outside this release by scope and are not shown; that is not a gap in the sources.` : null
}

/** Declared years inside an explorer year range (open ends allowed), so the note shows when a search can include them. */
export function editorialYearsBetween (from: number | null, to: number | null): number[] {
  return Object.keys(EDITORIAL_YEARS).map(Number).filter((y) => y >= (from ?? 0) && y <= (to ?? 9999))
}
