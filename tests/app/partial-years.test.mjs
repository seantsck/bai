import test from 'node:test'
import assert from 'node:assert/strict'
import { partialYear, partialYearText, editorialNote, EDITORIAL_NOTE_2021, PARTIAL_YEAR_DETAIL } from '../../lib/partial-years.ts'

test('2021 with 205 represented shows 205 of 612, 407 absent, and no inference or rates', () => {
  const p = partialYear(2021, 205)
  assert.deepEqual(p, { year: 2021, documented: 612, represented: 205, absent: 407 })
  assert.equal(partialYearText(p), '2021: 205 of 612 documented selections are represented; 407 are absent.')
  assert.match(PARTIAL_YEAR_DETAIL, /no signing outcome or failed outcome may be inferred/)
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

test('2022 is declared: 616 documented, opening picks 1 to 80, Dodgers excluded by scope, and 2020 and undeclared years stay clean', async () => {
  const { partialYear: py, partialYearText: pt, editorialNote: en, scopeNote: sn } = await import('../../lib/partial-years.ts')
  assert.equal(pt(py(2022, 173)), '2022: 173 of 616 documented selections are represented; 443 are absent.')
  assert.equal(en([2022]), 'For the incomplete 2022 draft, picks 1 to 80 are listed in full, but later-round entries are editorially selected notable players, not a representative sample.')
  assert.equal(en([2021, 2022]).split('. ').length, 2, 'one sentence per declared year')
  assert.equal(en([2020, 2019]), null)
  assert.match(sn(2022), /Los Angeles Dodgers selections are outside this release by scope/)
  assert.equal(sn(2021), null)
  assert.equal(py(2022, 616), null)
})

test('an explorer year range includes the declared partial years it can contain', async () => {
  const { editorialYearsBetween: between } = await import('../../lib/partial-years.ts')
  assert.deepEqual(between(2020, 2020), [])
  assert.deepEqual(between(2022, null), [2022])
  assert.deepEqual(between(null, 2021), [2021])
  assert.deepEqual(between(2019, 2023), [2021, 2022])
})
