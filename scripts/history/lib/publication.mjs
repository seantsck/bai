// Publication check for the public repository: source-derived content may be committed only when every catalog source it
// cites grants publish_repository (research/history/sources.json). Run on the tracked files by
// scripts/history/publication-check.mjs (part of `npm run check`).
//
// Findings:
//   RESTRICTED_PATH     a tracked file under a path that only ever holds restricted output (.restricted/, .cache/,
//                       research/history/batches/)
//   RESTRICTED_SOURCE   a data file citing a governed source (by its source key) whose publish_repository grant is not
//                       satisfied
//   UNKNOWN_HIST_KEY    a data file citing a hist: source key that no catalog source governs (a gate cannot be bypassed by
//                       inventing a key)
//   UNREVIEWED_HISTORY_FILE  a tracked file under research/history/ that is not on the reviewed list below: new historical
//                       research files fail closed until they are reviewed and listed
// Notices (reported, not failures): data files citing MLB or Baseball-Reference by URL outside the catalog's governance.
// Those predate the gate (targeted per-class research) and are listed for the licensing review.
import { checkUse, sourceForKey } from './permissions.mjs'

// The only files that may be committed under research/history/ (each reviewed: catalog, metadata, openly sourced rows,
// synthetic benchmark). Anything else there fails the check until it is reviewed and added here.
export const REVIEWED_HISTORY_FILES = new Set(['research/history/sources.json', 'research/history/manifest.json', 'research/history/calendar.json', 'research/history/reports/benchmark.json'])
export const RESTRICTED_PATHS = [/^\.restricted\//, /^\.cache\//, /^research\/history\/batches\//]
const DATA_FILE = /\.(json|csv|tsv|txt|html?)$/i
// The catalog itself and the download manifest (URL, size, SHA-256, time per file: metadata, no content) are exempt.
const EXEMPT = new Set(['research/history/sources.json', 'research/history/manifest.json'])
const HIST_KEY = /"(hist:[a-z0-9][a-z0-9_.:-]*)"/g
const NOTICE_HOSTS = [/statsapi\.mlb\.com/, /baseball-reference\.com/]

/** files: [{ path, text }] (repository-relative paths). Returns { findings, notices }. */
export function scanForRestricted (files, catalog, { root, now } = {}) {
  const findings = []
  const notices = []
  for (const f of files) {
    if (RESTRICTED_PATHS.some((re) => re.test(f.path))) { findings.push({ kind: 'RESTRICTED_PATH', path: f.path, detail: 'restricted output directory' }); continue }
    if (f.path.startsWith('research/history/') && !REVIEWED_HISTORY_FILES.has(f.path)) findings.push({ kind: 'UNREVIEWED_HISTORY_FILE', path: f.path, detail: 'not on the reviewed list (lib/publication.mjs)' })
    if (!DATA_FILE.test(f.path) || EXEMPT.has(f.path)) continue
    const keys = new Set([...f.text.matchAll(HIST_KEY)].map((m) => m[1]))
    for (const key of keys) {
      const s = sourceForKey(catalog, key)
      if (!s) { findings.push({ kind: 'UNKNOWN_HIST_KEY', path: f.path, detail: key }); continue }
      const year = Number((key.match(/-((?:19|20)\d{2})(?:-|$)/) ?? [])[1]) || null
      const r = checkUse(catalog, s, 'publish_repository', { year, now }, { root })
      if (!r.ok) findings.push({ kind: 'RESTRICTED_SOURCE', path: f.path, detail: `${key}: ${r.reason}` })
    }
    if (!keys.size && NOTICE_HOSTS.some((re) => re.test(f.text))) notices.push({ path: f.path, detail: NOTICE_HOSTS.filter((re) => re.test(f.text)).map((re) => re.source.replace(/\\/g, '')).join(', ') })
  }
  return { findings, notices }
}
