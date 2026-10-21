// Fails when a tracked (or staged) file publishes restricted source-derived content (lib/publication.mjs).
//   node scripts/history/publication-check.mjs [--notices]
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadCatalog } from './lib/permissions.mjs'
import { scanForRestricted } from './lib/publication.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const tracked = execFileSync('git', ['ls-files', '-z', '--cached'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean)
const files = tracked.filter((p) => fs.statSync(path.join(root, p), { throwIfNoEntry: false })?.isFile()).map((p) => ({ path: p, text: fs.readFileSync(path.join(root, p), 'utf8') }))
const { findings, notices } = scanForRestricted(files, loadCatalog(root), { root })
for (const f of findings) console.error(`${f.kind}: ${f.path}: ${f.detail}`)
if (process.argv.includes('--notices')) for (const n of notices) console.log(`notice (outside the history catalog; see docs/history/hosted-provenance.md): ${n.path}: ${n.detail}`)
console.log(`publication check: ${files.length} tracked files, ${findings.length} finding(s), ${notices.length} notice(s)`)
process.exit(findings.length ? 1 : 0)
