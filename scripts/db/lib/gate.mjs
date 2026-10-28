// A production GATE is one migration applied to the hosted BAI database under a written authorization. This module is the pure part of the guard that makes
// "exactly this migration, from exactly this reviewed commit, to exactly this project" checkable and refusable. The gate file (JSON) is part of the authorization:
// its own SHA-256 is quoted in the authorization statement, so editing it in the working directory cannot go unnoticed.
//
// gate file: { gate, commit, through, migration_file, from_level, project_ref, checksums: {NNN: sha256…}, migrations_hash }
import fs from 'node:fs'
import crypto from 'node:crypto'

export const SHA40 = /^[0-9a-f]{40}$/
export const migrationsHash = (checksums) => crypto.createHash('sha256').update(Object.keys(checksums).sort().map((v) => `${v}:${checksums[v]}`).join('\n')).digest('hex')
/** Release protocol v2 is enforced by a checkout only when ITS OWN source says so; the push guard that runs is always the checked-out one, never main's. */
export const PROTOCOL_V2_FILE = 'scripts/db/lib/final-parity.mjs'
export const protocolV2Enforced = (source) => typeof source === 'string' && /^export const PROTOCOL_V2_ENFORCED = true$/m.test(source)
export const fileSha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

/** Builds a gate from the migrations of a checkout at `commit`: the checksums of 001..through, the project and the level it starts from. */
export function buildGate ({ gate, commit, through, projectRef, migrations }) {
  if (!SHA40.test(commit)) throw new Error('commit must be a full 40-character SHA')
  if (!/^\d{3}$/.test(through)) throw new Error('through must be a three-digit migration version')
  if (!/^[a-z0-9]{20}$/.test(projectRef)) throw new Error('project ref must be 20 lowercase letters/digits')
  const upto = migrations.filter((m) => m.version <= through)
  const last = upto.at(-1)
  if (!last || last.version !== through) throw new Error(`migration ${through} does not exist`)
  const previous = upto.at(-2)
  const checksums = Object.fromEntries(upto.map((m) => [m.version, m.checksum]))
  return { gate, commit, through, migration_file: last.file, from_level: previous?.version ?? '000', project_ref: projectRef, checksums, migrations_hash: migrationsHash(checksums) }
}

export function validateGateShape (g) {
  const p = []
  if (!g || typeof g !== 'object') return ['the gate file is not an object']
  if (!SHA40.test(g.commit ?? '')) p.push('commit is not a full SHA')
  if (!/^\d{3}$/.test(g.through ?? '')) p.push('through is not a migration version')
  if (!/^\d{3}_[a-z0-9_]+\.sql$/.test(g.migration_file ?? '') || !String(g.migration_file).startsWith(`${g.through}_`)) p.push('migration_file does not match through')
  if (!/^[a-z0-9]{20}$/.test(g.project_ref ?? '')) p.push('project_ref is malformed')
  if (!g.checksums || typeof g.checksums !== 'object' || !g.checksums[g.through]) p.push('checksums do not cover the gate migration')
  else if (g.migrations_hash !== migrationsHash(g.checksums)) p.push('migrations_hash does not match the checksum list')
  const want = Array.from({ length: Number(g.through) }, (_, i) => String(i + 1).padStart(3, '0'))
  if (g.checksums && Object.keys(g.checksums).sort().join() !== want.join()) p.push('checksums must cover exactly 001..through')
  return p
}

const ALLOWED_DELETION = (through) => new RegExp(`^ D database/migrations/(\\d{3})_[a-z0-9_]+\\.sql$`)

/**
 * @param {object} f facts about the working directory and (optionally) hosted, all gathered read-only:
 *   head, status (git status --porcelain lines), protocolV2 (the checkout enforces release protocol v2), migrations ([{version,file,checksum}] as the runner sees them), env, linkedRef, urlRef,
 *   hosted ({level, recorded:[{version,file,checksum}], pushed:[versions]}), dryRun (migration file names the CLI would push)
 * @returns {string[]} problems; empty means every check passed
 */
export function evaluateGate (g, f) {
  const problems = validateGateShape(g)
  if (problems.length) return problems.map((x) => `gate file: ${x}`)
  const thr = g.through
  // 1. the exact reviewed commit, nothing modified except the removal of later migrations
  if (f.head !== g.commit) problems.push(`HEAD is ${String(f.head).slice(0, 12)}, the gate names ${g.commit.slice(0, 12)}`)
  for (const line of f.status ?? []) {
    const m = ALLOWED_DELETION(thr).exec(line)
    if (m && m[1] > thr) continue
    problems.push(`unexpected change in the working directory: ${line.trim()}`)
  }
  if (f.protocolV2 !== true) problems.push('this checkout does not enforce release protocol v2 (PROTOCOL_V2_ENFORCED is not true in scripts/db/lib/final-parity.mjs at the gate commit): its push guard would not demand the final parity record')
  // 2. migrations 001..through, and nothing later, unchanged
  const versions = f.migrations.map((m) => m.version)
  const later = versions.filter((v) => v > thr)
  if (later.length) problems.push(`migration(s) later than ${thr} are present: ${later.join(', ')}`)
  const want = Object.keys(g.checksums).sort()
  const have = versions.filter((v) => v <= thr)
  if (have.join() !== want.join()) problems.push(`the migrations present (${have.length}) are not exactly 001–${thr}`)
  for (const m of f.migrations) if (m.version <= thr && g.checksums[m.version] !== m.checksum) problems.push(`migration ${m.file} differs from the gate's checksum`)
  if (!f.migrations.some((m) => m.file === g.migration_file)) problems.push(`${g.migration_file} is not present`)
  if (migrationsHash(Object.fromEntries(f.migrations.filter((m) => m.version <= thr).map((m) => [m.version, m.checksum]))) !== g.migrations_hash) problems.push('the checksum list of the present migrations does not match the gate')
  // 3. the project
  const ref = f.env?.BAI_SUPABASE_PROJECT_REF
  if (ref !== g.project_ref) problems.push('BAI_SUPABASE_PROJECT_REF is not the gate\'s project')
  if (f.linkedRef !== g.project_ref) problems.push(`supabase/.temp/project-ref is ${f.linkedRef ?? 'missing'}, not the gate's project`)
  if (f.urlRef !== undefined && f.urlRef !== g.project_ref) problems.push('the database connection belongs to a different project')
  // 4. hosted state, if it was read
  if (f.hosted) {
    const h = f.hosted
    if (h.level !== g.from_level) problems.push(`hosted is at migration ${h.level}, the gate starts from ${g.from_level}`)
    const expected = f.migrations.filter((m) => m.version <= g.from_level)
    const rec = new Map(h.recorded.map((r) => [r.version, r]))
    if ([...rec.keys()].sort().join() !== expected.map((m) => m.version).join()) problems.push('hosted migration history (bai_meta) has unexpected versions')
    for (const m of expected) if (rec.get(m.version) && (rec.get(m.version).checksum !== m.checksum || rec.get(m.version).file !== m.file)) problems.push(`hosted records a different ${m.file}`)
    if ([...h.pushed].sort().join() !== expected.map((m) => m.version).join()) problems.push('the Supabase migration history has unexpected versions')
  }
  // 5. the dry run lists exactly the gate's migration
  if (f.dryRun !== undefined) {
    if (!Array.isArray(f.dryRun) || f.dryRun.length !== 1 || f.dryRun[0] !== g.migration_file) problems.push(`the dry run lists ${JSON.stringify(f.dryRun)}, not exactly [${g.migration_file}]`)
  }
  return problems
}

/** The CLI prints one JSON line (`{"upToDate":…,"dryRun":true,"migrations":[…]}`) at the end of a dry run. Returns the migration file names, or null if it cannot be read. */
export function parseDryRun (output) {
  const line = String(output).split('\n').map((l) => l.trim()).reverse().find((l) => l.startsWith('{') && l.includes('"migrations"'))
  if (!line) return null
  try { const j = JSON.parse(line); return j.dryRun === true && Array.isArray(j.migrations) ? j.migrations : null } catch { return null }
}
