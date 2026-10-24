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
  assert.deepEqual(between(2022, null), [2022])
  assert.deepEqual(between(null, 2021), [2021])
  assert.deepEqual(between(2019, 2023), [2021, 2022])
})
