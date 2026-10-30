// Runs every no-argument page query of the website (lib/queries.ts, through its own code and role handling) and prints one hash per query as a single JSON line.
// Used by tests/db/promotion.test.mjs to prove that the website role split changes no page result. Refresh bookkeeping is ignored. Local databases only.
import crypto from 'node:crypto'
import path from 'node:path'

const Q = await import(path.join(process.cwd(), 'lib/queries.ts'))
const out = {}
const norm = (r) => JSON.stringify(r, (k, v) => (k === 'generation_id' || k === 'refreshed_at' ? undefined : v))
for (const [k, f] of Object.entries(Q)) {
  if (typeof f !== 'function' || f.length !== 0 || !/^get/.test(k)) continue
  try { out[k] = crypto.createHash('md5').update(norm(await f())).digest('hex') } catch (e) { out[k] = `ERR ${e.code ?? e.message}` }
}
console.log(JSON.stringify(out))
process.exit(0)
