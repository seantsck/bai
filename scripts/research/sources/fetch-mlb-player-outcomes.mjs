// Downloads the MLB Stats API evidence an outcome audit needs, for a small, explicit list of players (at most 60 per
// run, one request at a time with a pause between requests). Writes one JSON file per player plus a manifest that
// records every URL and the retrieval date. It writes nothing to a database; outcome-audits-import.mjs builds the batch.
//
//   node scripts/research/sources/fetch-mlb-player-outcomes.mjs --ids 666158,669257 --out <dir> [--seasons 2016-2026]
//
// Per player: people (debut date, active flag, current team, MLB career and season stats, hitting and pitching),
// affiliated minor-league seasons (leagueListId=milb_all), and transactions. Per season: the affiliates' parent clubs.
import { publicRequestHeaders } from '../../history/lib/outbound.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadCatalog, requireUse } from '../../history/lib/permissions.mjs'

const argv = process.argv.slice(2)
const arg = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : null }
const ids = (arg('ids') ?? '').split(',').map((s) => s.trim()).filter((s) => /^\d+$/.test(s))
const out = arg('out')
const [s0, s1] = (arg('seasons') ?? '2016-2026').split('-').map(Number)
if (!ids.length || !out) throw new Error('--ids <mlbam,...> and --out <dir> are required')
if (ids.length > 60) throw new Error('at most 60 players per run (rate policy)')
// Permission gate (research/history/sources.json): refused before any request unless mlb-statsapi-draft grants fetch_targeted.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
try { requireUse(loadCatalog(repoRoot), 'mlb-statsapi-draft', 'fetch_targeted', { requests: ids.length * 3 }, { root: repoRoot }) } catch (err) { console.error(`permission refused: ${err.message}`); process.exit(4) }
fs.mkdirSync(out, { recursive: true })

const BASE = 'https://statsapi.mlb.com/api/v1'
const PAUSE_MS = 600
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const manifest = { retrieved_date: new Date().toISOString().slice(0, 10), requests: [] }
async function get (url) {
  await sleep(PAUSE_MS)
  const res = await fetch(url, { headers: publicRequestHeaders('player outcomes research') })
  manifest.requests.push({ url, status: res.status })
  if (!res.ok) throw new Error(`${res.status} for ${url}`)
  return res.json()
}

for (const id of ids) {
  const people = await get(`${BASE}/people/${id}?hydrate=currentTeam,stats(group=[hitting,pitching],type=[career,yearByYear],sportId=1)`)
  const minors = await get(`${BASE}/people/${id}/stats?stats=yearByYear&group=hitting,pitching&leagueListId=milb_all`)
  const transactions = await get(`${BASE}/transactions?playerId=${id}`)
  fs.writeFileSync(path.join(out, `${id}.json`), JSON.stringify({ id, people, minors, transactions }))
  console.log(`fetched ${id} ${people.people?.[0]?.fullName ?? '?'}`)
}
const parents = {}
for (let s = s0; s <= s1; s++) {
  const t = await get(`${BASE}/teams?sportIds=11,12,13,14,15,16&season=${s}`)
  parents[s] = Object.fromEntries((t.teams ?? []).map((x) => [x.id, x.parentOrgId ?? null]))
}
fs.writeFileSync(path.join(out, 'affiliates.json'), JSON.stringify(parents))
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 1))
console.log(`${manifest.requests.length} requests; manifest written`)
