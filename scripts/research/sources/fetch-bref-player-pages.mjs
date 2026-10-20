// Downloads archived Baseball-Reference player pages (the live site refuses automated requests): for each id, the latest
// Wayback capture taken at or before --before (e.g. 20260325, before a season starts, so every season on the page is
// complete). One request at a time with a pause, at most 60 ids per run, backoff on 429. Writes <id>.html and a manifest
// of capture URLs and timestamps; nothing is written to a database.
//   node scripts/research/sources/fetch-bref-player-pages.mjs --ids luxga01,smithwi05 --before 20260325 --out <dir>
import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const arg = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : null }
const ids = (arg('ids') ?? '').split(',').map((s) => s.trim()).filter((s) => /^[a-z.'-]+\d{2}$/.test(s))
const out = arg('out')
const before = arg('before')
if (!ids.length || !out || !/^\d{8,14}$/.test(before ?? '')) throw new Error('--ids, --before YYYYMMDD[hhmmss] and --out are required')
if (ids.length > 60) throw new Error('at most 60 ids per run (rate policy)')
fs.mkdirSync(out, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const manifestFile = path.join(out, 'manifest.json')
const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : { before, captures: {} }
async function get (url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    await sleep(4000 + i * 30000)
    let res
    try { res = await fetch(url, { headers: { 'User-Agent': 'BAI research (public data; rate-limited)' } }) } catch { continue }   // refused or reset: back off and retry
    if (res.status === 429 || res.status >= 500) continue
    return res
  }
  throw new Error(`gave up on ${url}`)
}
for (const id of ids) {
  if (manifest.captures[id] && fs.existsSync(path.join(out, `${id}.html`))) continue
  const page = `www.baseball-reference.com/players/${id[0]}/${id}.shtml`
  const cdx = await (await get(`http://web.archive.org/cdx/search/cdx?url=${page}&to=${before}&filter=statuscode:200&fl=timestamp&limit=-1`)).text()
  const ts = cdx.trim().split('\n').filter(Boolean).at(-1)
  if (!ts) { manifest.captures[id] = { status: 'NO_CAPTURE' }; console.log(`${id}: no capture before ${before}`); continue }
  const url = `http://web.archive.org/web/${ts}/https://${page}`
  const res = await get(`http://web.archive.org/web/${ts}id_/https://${page}`)
  fs.writeFileSync(path.join(out, `${id}.html`), Buffer.from(await res.arrayBuffer()))
  manifest.captures[id] = { status: res.status, timestamp: ts, archived_url: url, live_url: `https://${page}` }
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 1))
  console.log(`${id}: ${ts}`)
}
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 1))
