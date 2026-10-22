// Cached, rate-limited, budgeted downloads for the historical importer.
//   * Every download lands in .cache/history/<key> and is recorded in research/history/manifest.json (committed) with
//     its URL, byte count, SHA-256 and retrieval time. A cached file whose checksum no longer matches the manifest is an
//     error, never silently reused or replaced.
//   * Offline mode (replay) reads only the cache and verifies every checksum: the same manifest gives the same batches.
//   * Budget: at most `maxRequests` network requests per run, one request per host every `minIntervalMs`, and backoff on
//     429/5xx that honours Retry-After. Exhausting the budget stops the run with a resumable error (nothing half-written:
//     a file is renamed into place only after it is complete).
//   * Permission gates (lib/permissions.mjs), checked before any work: every call names its catalog source and its use.
//     A network request needs that use (fetch_targeted or fetch_bulk) granted for the scope, and the URL must belong to
//     that source (its hosts and URL prefixes): an allowlisted host alone is never enough. Reading a cached copy needs
//     process_local for the scope, so a restricted source's cache cannot be processed outside its grant either.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { requireUse, PermissionDenied } from './permissions.mjs'
import { assertSafeHeaders } from './outbound.mjs'

export class BudgetExhausted extends Error {}
export { PermissionDenied }

const FETCH_USES = ['fetch_targeted', 'fetch_bulk']

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function createFetcher ({ root, catalog, offline = false, maxRequests = 50, minIntervalMs = 1500, userAgent, now = () => new Date(), fetchImpl = fetch, log = () => {} }) {
  const cacheDir = path.join(root, '.cache/history')
  const manifestFile = path.join(root, 'research/history/manifest.json')
  const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : { format: 'bai-history-manifest/1', entries: {} }
  const lastHit = new Map()
  const perSource = new Map()
  let requests = 0

  const saveManifest = () => {
    const sorted = Object.fromEntries(Object.keys(manifest.entries).sort().map((k) => [k, manifest.entries[k]]))
    fs.mkdirSync(path.dirname(manifestFile), { recursive: true })
    fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, entries: sorted }, null, 1) + '\n')
  }

  /**
   * Returns { buf, entry, cached }. `key` is a stable relative path, e.g. mlb/draft/1985-js.json; `source` a catalog id;
   * `use` fetch_targeted or fetch_bulk (what a network request would be); `scope` { year } for scoped grants.
   */
  async function get (key, url, { source, use, scope = {} } = {}) {
    if (!/^[a-z0-9][a-z0-9._/-]*$/.test(key) || key.includes('..')) throw new Error(`bad cache key ${key}`)
    if (!FETCH_USES.includes(use)) throw new Error(`${key}: a fetch must declare its use (fetch_targeted or fetch_bulk)`)
    const s = catalog.sources.find((x) => x.id === source)
    if (!s) throw new PermissionDenied(`${key}: ${source} is not a catalogued source`, { source, use })
    const host = new URL(url).hostname
    if (!(s.hosts ?? []).includes(host) || !(s.url_prefixes ?? []).some((p) => url.startsWith(p))) throw new PermissionDenied(`${key}: ${url} does not belong to source ${s.id}`, { source, use })
    const file = path.join(cacheDir, key)
    const entry = manifest.entries[key]
    if (fs.existsSync(file)) {
      requireUse(catalog, s, 'process_local', { ...scope, now: now() }, { root })
      const buf = fs.readFileSync(file)
      if (!entry) throw new Error(`${key}: cached file has no manifest entry; delete it or restore the manifest`)
      if (sha256(buf) !== entry.sha256) throw new Error(`${key}: cached file does not match its manifest checksum (tampered or partial)`)
      if (entry.url !== url) throw new Error(`${key}: cached from ${entry.url}, requested ${url}`)
      return { buf, entry, cached: true }
    }
    if (offline) throw new Error(`${key}: not in the cache (offline replay)`)
    requireUse(catalog, s, use, { ...scope, requests: (perSource.get(s.id) ?? 0) + 1, now: now() }, { root })
    let attempt = 0
    for (;;) {
      if (requests >= maxRequests) throw new BudgetExhausted(`request budget of ${maxRequests} spent; re-run to resume (cached files are kept)`)
      const wait = (lastHit.get(host) ?? 0) + minIntervalMs - Date.now()
      if (wait > 0) await sleep(wait)
      lastHit.set(host, Date.now())
      requests++
      perSource.set(s.id, (perSource.get(s.id) ?? 0) + 1)
      const res = await fetchImpl(url, { headers: assertSafeHeaders({ 'User-Agent': userAgent, Accept: 'application/json, text/csv, text/html;q=0.8' }) })
      if (res.status === 429 || res.status >= 500) {
        attempt++
        const retryAfter = Number(res.headers.get('retry-after'))
        const backoff = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min(60000, 2000 * 2 ** attempt)
        log(`${key}: HTTP ${res.status}, retry ${attempt} in ${Math.round(backoff / 1000)}s`)
        if (attempt > 4) throw new Error(`${key}: HTTP ${res.status} after ${attempt} attempts`)
        await sleep(backoff)
        continue
      }
      if (!res.ok) throw new Error(`${key}: HTTP ${res.status} from ${url}`)
      const buf = Buffer.from(await res.arrayBuffer())
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(`${file}.part`, buf)
      fs.renameSync(`${file}.part`, file)
      manifest.entries[key] = { url, source_key: s.id, bytes: buf.length, sha256: sha256(buf), retrieved_at: now().toISOString(), content_type: res.headers.get('content-type') }
      saveManifest()
      log(`${key}: fetched ${buf.length} bytes`)
      return { buf, entry: manifest.entries[key], cached: false }
    }
  }

  return { get, stats: () => ({ requests, maxRequests }), manifest }
}
