// The later-dated-member classifier against the reviewable fictional fixtures (docs/transactions/later-added/fixtures.json).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as R from '../../scripts/research/lib/retrosheet-transactions.mjs'
import { classifyLaterMembers, laterMemberStudy, ADDITION_KINDS } from '../../scripts/research/lib/retrosheet-later-members.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const fixtures = JSON.parse(fs.readFileSync(path.join(root, 'docs/transactions/later-added/fixtures.json'), 'utf8'))

test('every fixture case is classified as documented, deterministically', () => {
  for (const c of fixtures.cases) {
    const groups = R.groupRows(R.parseTran(c.rows.join('\n') + '\n'))
    const later = groups.flatMap((g) => classifyLaterMembers(g))
    assert.deepEqual(later.map((m) => ({ line: m.line, kind: m.kind })), c.expected_later.map((e) => ({ line: e.line, kind: e.kind })), c.name)
    assert.deepEqual(groups.flatMap((g) => classifyLaterMembers(g)), later, `${c.name}: repeatable`)
  }
})

test('the labels are distinguishable and never merge unrelated rows', () => {
  assert.deepEqual(Object.keys(ADDITION_KINDS).sort(), ['ADDED_LATER_UNSTATED', 'ADDED_TO_TRADE', 'LATER_NON_PLAYER_ROW', 'LATER_VOID_OR_RETURN', 'PTBNL_AMBIGUOUS', 'PTBNL_NAMED'])
  const reuse = fixtures.cases.find((c) => c.name === 'ids_reused_across_unrelated_rows')
  const groups = R.groupRows(R.parseTran(reuse.rows.join('\n') + '\n'))
  assert.equal(groups.length, 2, 'two separate groups for a reused non-trade id')
  const ptbnl = fixtures.cases.find((c) => c.name === 'ptbnl_formally_named')
  const g = R.groupRows(R.parseTran(ptbnl.rows.join('\n') + '\n'))[0]
  assert.equal(g.date.text, '20300601', 'the trade keeps its own date; the later row does not move it')
  assert.equal(classifyLaterMembers(g)[0].days_after, 106)
})

test('the study counts members by kind, player kind, direction and delay', () => {
  const rows = fixtures.cases.flatMap((c) => c.rows)
  // each case has its own id, so grouping all fixture rows together keeps the cases apart
  const groups = R.groupRows(R.parseTran(rows.join('\n') + '\n'))
  const s = laterMemberStudy(groups)
  assert.equal(s.groups_with_later_members, 6)
  assert.equal(s.members, 6)
  assert.deepEqual(s.by_kind, { ADDED_LATER_UNSTATED: 1, ADDED_TO_TRADE: 1, LATER_NON_PLAYER_ROW: 1, LATER_VOID_OR_RETURN: 1, PTBNL_AMBIGUOUS: 1, PTBNL_NAMED: 1 })
  assert.equal(s.groups_with_ptbnl_placeholder, 2)
})
