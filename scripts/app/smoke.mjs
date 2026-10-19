// Route smoke test against a running BAI app (default http://127.0.0.1:3000). Every planned route must answer 200, the
// pilot's organization and player pages must render, and unknown routes must answer 404. Also asserts the research
// page never shows a hit rate and that no page leaks a database URL or secret-looking value.
//
//   node scripts/app/smoke.mjs [--base http://127.0.0.1:3000] [--no-pilot]
const argv = process.argv.slice(2)
const base = argv.includes('--base') ? argv[argv.indexOf('--base') + 1] : 'http://127.0.0.1:3000'
const pilot = !argv.includes('--no-pilot')

const ok = ['/', '/international', '/international/signings', '/international/classes', '/international/markets', '/international/trainers',
  '/draft', '/draft/picks', '/draft/years', '/draft/schools', '/organizations', '/players', '/compare', '/research',
  '/organizations/los-angeles-dodgers', '/organizations/cleveland-guardians',
  ...(pilot ? ['/players/kyle-funkhouser', '/players/yadier-alvarez'] : [])]
const missing = ['/nope', '/organizations/nope']
const LEAKS = [/postgres(ql)?:\/\//i, /sb_secret_/, /service_role/i, /eyJhbGci/]

let failed = 0
const results = []
for (const [route, expect] of [...ok.map((r) => [r, 200]), ...missing.map((r) => [r, 404])]) {
  const res = await fetch(base + route, { redirect: 'manual' })
  const body = await res.text()
  const leak = LEAKS.find((re) => re.test(body))
  const problems = []
  if (res.status !== expect) problems.push(`status ${res.status}, expected ${expect}`)
  if (leak) problems.push(`page contains ${leak}`)
  if (expect === 200 && /Database not configured|Data is temporarily unavailable/i.test(body)) problems.push('page reports the database as unavailable')
  if (route === '/research' && /hit rate\s*[:=]?\s*\d/i.test(body)) problems.push('research page shows a hit rate')
  if (pilot && route === '/players/yadier-alvarez' && !(/665751/.test(body) && /2015-07-02/.test(body))) problems.push('pilot identity/date not rendered')
  if (pilot && route === '/international/signings' && !/16,000,000/.test(body)) problems.push('pilot bonus not rendered')
  if (problems.length) failed++
  results.push({ route, status: res.status, expected: expect, result: problems.length ? problems.join('; ') : 'ok' })
}
console.table(results)
console.log(`${results.length - failed}/${results.length} routes as expected (${ok.length} x 200, ${missing.length} x 404)`)
process.exit(failed ? 1 : 0)
