// The migration numbering rule, in one place: versions run 001..N with no gap, except the numbers deliberately held back. A reserved number has no file; a file that
// takes it, or any other missing number, is a numbering problem for the replay test and for the gate's checksum list alike.
export const RESERVED_MIGRATIONS = Object.freeze(['031']) // 031: docs/transactions/later-added/proposal.md (proposed-031-later-added-assets.sql)

/** The versions that must exist for a database level of `through` (001..through, less the reserved numbers). */
export const expectedMigrationVersions = (through) => Array.from({ length: Number(through) }, (_, i) => String(i + 1).padStart(3, '0')).filter((v) => !RESERVED_MIGRATIONS.includes(v))

/** Problems with a list of migration versions, in file order; empty when the list is exactly the expected one. */
export function numberingProblems (versions) {
  if (!versions.length) return ['there are no migrations']
  const want = expectedMigrationVersions(versions.at(-1))
  const have = new Set(versions)
  const p = []
  for (const v of versions) if (RESERVED_MIGRATIONS.includes(v)) p.push(`${v} is reserved and must have no file`)
  for (const v of want) if (!have.has(v)) p.push(`migration ${v} is missing (a gap other than a reserved number)`)
  if (have.size !== versions.length) p.push('a version is used twice')
  for (const v of versions) if (!want.includes(v) && !RESERVED_MIGRATIONS.includes(v)) p.push(`unexpected version ${v}`)
  if (versions.join() !== [...versions].sort().join()) p.push('versions are not in order')
  return p
}
