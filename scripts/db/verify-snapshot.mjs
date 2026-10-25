// Verifies a snapshot directory without a database: manifest, per-file SHA-256, row counts, columns, no unlisted file.
//   node scripts/db/verify-snapshot.mjs <snapshot dir>
import { verifySnapshot } from './lib/snapshot.mjs'
const dir = process.argv[2]
if (!dir) { console.error('usage: verify-snapshot.mjs <snapshot dir>'); process.exit(2) }
const problems = verifySnapshot(dir)
console.log(problems.length ? `SNAPSHOT INVALID\n  ${problems.join('\n  ')}` : 'SNAPSHOT OK')
process.exit(problems.length ? 1 : 0)
