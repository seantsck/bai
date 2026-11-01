// The numbering rule is one shared definition (scripts/db/lib/migration-numbers.mjs): only the reserved number may be absent, and nothing else may be missing, doubled, out of order or extra.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RESERVED_MIGRATIONS, expectedMigrationVersions, numberingProblems } from '../../scripts/db/lib/migration-numbers.mjs'
import { validateGateShape } from '../../scripts/db/lib/gate.mjs'
import { listMigrations } from '../../scripts/db/lib/migrations.mjs'

const range = (n, skip = []) => Array.from({ length: n }, (_, i) => String(i + 1).padStart(3, '0')).filter((v) => !skip.includes(v))

test('031 is the only reserved number, and the committed migrations follow the rule', () => {
  assert.deepEqual([...RESERVED_MIGRATIONS], ['031'])
  assert.deepEqual(numberingProblems(listMigrations().map((m) => m.version)), [])
  assert.ok(!expectedMigrationVersions('032').includes('031') && expectedMigrationVersions('032').includes('030') && expectedMigrationVersions('032').includes('032'))
  assert.deepEqual(expectedMigrationVersions('030'), range(30), 'below the reserved number nothing is skipped')
})

test('an unexpected gap, a duplicate, a taken reservation, an extra or an unordered version still fails', () => {
  assert.deepEqual(numberingProblems(range(32, ['031'])), [])
  assert.match(numberingProblems(range(32, ['031', '015'])).join(), /migration 015 is missing/)
  assert.match(numberingProblems(range(32, ['031', '030'])).join(), /migration 030 is missing/)
  assert.match(numberingProblems(range(32, ['031', '001'])).join(), /migration 001 is missing/)
  assert.match(numberingProblems(range(32)).join(), /031 is reserved and must have no file/)
  assert.match(numberingProblems([...range(32, ['031']), '032']).join(), /used twice/)
  assert.match(numberingProblems(['001', '003', '002']).join(), /not in order/)
  assert.match(numberingProblems(range(34, ['031', '033'])).join(), /migration 033 is missing/)
  assert.deepEqual(numberingProblems([]), ['there are no migrations'])
})

test('the gate checksum list obeys the same rule', () => {
  const shape = (versions) => validateGateShape({ commit: 'a'.repeat(40), through: '032', migration_file: '032_x.sql', project_ref: 'a'.repeat(20), checksums: Object.fromEntries(versions.map((v) => [v, 'c'.repeat(64)])), migrations_hash: 'x' })
    .filter((x) => /checksums must cover/.test(x))
  assert.deepEqual(shape(range(32, ['031'])), [])
  assert.equal(shape(range(32)).length, 1, 'a checksum for the reserved 031 is refused')
  assert.equal(shape(range(32, ['031', '020'])).length, 1, 'an unexpected gap is refused')
  assert.equal(shape([...range(32, ['031']), '033']).length, 1, 'an extra version is refused')
})
