import test from 'node:test'
import assert from 'node:assert/strict'
import { partialYear, partialYearText, editorialNote, EDITORIAL_NOTE_2021, PARTIAL_YEAR_DETAIL } from '../../lib/partial-years.ts'

test('2021 with 205 represented shows 205 of 612, 407 absent, and no inference or rates', () => {
  const p = partialYear(2021, 205)
  assert.deepEqual(p, { year: 2021, documented: 612, represented: 205, absent: 407 })
  assert.equal(partialYearText(p), '2021: 205 of 612 documented selections are represented; 407 are absent.')
  assert.match(PARTIAL_YEAR_DETAIL, /not an unsigned player or a failed outcome/)
  assert.match(PARTIAL_YEAR_DETAIL, /no signing outcome may be inferred from a missing row/)
  assert.match(PARTIAL_YEAR_DETAIL, /No league-wide or club-efficiency rates/)
})

test('no partial notice for a complete 2020 pick list, an unimported year, an undeclared year, a full 2021 or bad counts', () => {
  assert.equal(partialYear(2020, 160), null)
  assert.equal(partialYear(2021, 0), null)
  assert.equal(partialYear(2021, 612), null)
  assert.equal(partialYear(2021, 613), null)
  assert.equal(partialYear(2019, 100), null)
  assert.equal(partialYear(2021, 205.5), null)
  assert.equal(partialYear(2021, Number.NaN), null)
})

test('the editorially-selected later-round note belongs to 2021 only', () => {
  assert.equal(editorialNote([2020, 2020, 2019]), null)
  assert.equal(editorialNote([]), null)
  assert.equal(editorialNote([2020, '2021']), EDITORIAL_NOTE_2021)
  assert.match(EDITORIAL_NOTE_2021, /^For the incomplete 2021 draft/)
  assert.doesNotMatch(EDITORIAL_NOTE_2021, /partial years/)
})

test('2022 is declared: 616 documented, opening picks 1 to 80, and nothing is shown until rows are published', async () => {
  const { partialYear: py, partialYearText: pt, editorialNote: en } = await import('../../lib/partial-years.ts')
  assert.equal(py(2022, 0), null, 'no notice before any 2022 selection is on the database')
  assert.equal(pt(py(2022, 173)), '2022: 173 of 616 documented selections are represented; 443 are absent.')
  assert.equal(en([2022]), 'For the incomplete 2022 draft, picks 1 to 80 are listed in full, but later-round entries are editorially selected notable players, not a representative sample.')
  assert.equal(en([2021, 2022]).split('. ').length, 2, 'one sentence per declared year')
  assert.equal(en([2020, 2019]), null)
  assert.equal(py(2022, 616), null)
})

test('the absent selections are told apart: not listed by the source, outside the release by scope, held for review', async () => {
  const { partialYear: py, absentBreakdown: ab, absentBreakdownText: at } = await import('../../lib/partial-years.ts')
  assert.deepEqual(ab(py(2022, 173)), { notListed: 430, scope: 5, held: 8 })
  assert.equal(at(py(2022, 173)), "Of the 443 absent: 430 are not listed by BAI's source (a source gap); 5 Los Angeles Dodgers selections are outside this release by scope (not a source gap); 8 listed selections are held for identity or collision review.")
  // Approving held cases moves them into the represented count; the other groups do not change.
  assert.deepEqual(ab(py(2022, 176)), { notListed: 430, scope: 5, held: 5 })
  assert.deepEqual(ab(py(2021, 205)), { notListed: 405, scope: 0, held: 2 })
  assert.doesNotMatch(at(py(2021, 205)), /by scope/)
  assert.match(at(py(2021, 205)), /2 listed selections are held/)
  assert.equal(ab(py(2020, 100)), null, 'an undeclared year has no accounting')
  assert.equal(ab({ year: 2022, documented: 616, represented: 190, absent: 426 }), null, 'impossible accounting is not shown')
})

test('an explorer year range includes the declared partial years it can contain', async () => {
  const { editorialYearsBetween: between } = await import('../../lib/partial-years.ts')
  assert.deepEqual(between(2020, 2020), [])
  assert.deepEqual(between(2022, null), [2022, 2023])
  assert.deepEqual(between(null, 2021), [2021])
  assert.deepEqual(between(2019, 2023), [2021, 2022, 2023])
})

test('the explorer shows a later-round note for a searched year only when that year has imported selections', async () => {
  const { editorialYearsToShow: show, editorialNote: note } = await import('../../lib/partial-years.ts')
  // A filter for 2022 before any 2022 selection exists announces nothing.
  assert.equal(note(show([], [2022], [2020, 2021])), null)
  assert.equal(note(show([], [2022], [])), null)
  // A filter for an already represented year still shows its note, even with no matching rows.
  assert.match(note(show([], [2021], [2020, 2021])), /^For the incomplete 2021 draft/)
  // Rows on screen always count, as before; a range shows only the represented declared years.
  assert.match(note(show([2022], [], [])), /^For the incomplete 2022 draft/)
  assert.equal(note(show([], [2021, 2022], [2021])).includes('2022'), false)
  assert.equal(note(show([2020], [], [2020])), null)
})

test('the general absence statement distinguishes unavailable sources, scope exclusions and held selections, and never reads absence as an outcome', async () => {
  const { ABSENCE_STATEMENT: s } = await import('../../lib/partial-years.ts')
  assert.match(s, /unavailable in BAI’s sources/)
  assert.match(s, /outside a release’s scope/)
  assert.match(s, /held for review/)
  assert.match(s, /Absence never means an unsigned player or a failed outcome/)
  assert.doesNotMatch(s, /is a gap in BAI/)
})

test('2023 is declared: 614 documented, picks 1 to 71 listed, the absent selections told apart', async () => {
  const { partialYear: py, absentBreakdown: ab, absentBreakdownText: at, editorialNote: en } = await import('../../lib/partial-years.ts')
  assert.equal(py(2023, 0), null, 'no 2023 notice before 2023 selections exist')
  assert.deepEqual(ab(py(2023, 160)), { notListed: 447, scope: 4, held: 3 })
  assert.match(at(py(2023, 160)), /^Of the 454 absent: 447 are not listed by BAI's source \(a source gap\); 4 Los Angeles Dodgers selections are outside this release by scope \(not a source gap\); 3 listed selections are held/)
  assert.match(en([2023]), /^For the incomplete 2023 draft, picks 1 to 71 are listed in full/)
}
)
