import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatUsd, formatWar, formatDate, label, COVERAGE_STATE_LABELS, AUDIT_STATE_LABELS, SIGNING_STATUS_LABELS } from '../../lib/format.ts'

test('unknown money renders as Unknown, never $0; a known zero renders as $0', () => {
  assert.equal(formatUsd(null), 'Unknown')
  assert.equal(formatUsd(undefined), 'Unknown')
  assert.equal(formatUsd(''), 'Unknown')
  assert.equal(formatUsd('0.00'), '$0')
  assert.equal(formatUsd('2400000.00'), '$2,400,000')
})

test('missing WAR renders as Not observed, never 0.0', () => {
  assert.equal(formatWar(null), 'Not observed')
  assert.equal(formatWar('0.0'), '0.0')
  assert.equal(formatWar('-0.4'), '-0.4')
})

test('dates respect recorded precision', () => {
  assert.equal(formatDate('2019-07-02', 'DAY'), '2019-07-02')
  assert.equal(formatDate('2019-07-02', 'SEASON'), '2019')
  assert.equal(formatDate(null), 'Unknown')
})

test('only census-grade coverage states are labelled as supporting rates', () => {
  const supported = Object.entries(COVERAGE_STATE_LABELS).filter(([, v]) => v.supportsRates).map(([k]) => k)
  assert.deepEqual(supported, ['COMPLETE_CENSUS', 'SUBSTANTIALLY_COMPLETE'])
  assert.equal(Object.keys(COVERAGE_STATE_LABELS).length, 6)
})

test('labels keep unaudited and unresearched distinct from failure', () => {
  assert.equal(label(AUDIT_STATE_LABELS, 'NOT_AUDITED'), 'Not audited')
  assert.notEqual(label(SIGNING_STATUS_LABELS, 'UNKNOWN'), label(SIGNING_STATUS_LABELS, 'DID_NOT_SIGN'))
  assert.equal(label(AUDIT_STATE_LABELS, null), 'Unknown')
})
