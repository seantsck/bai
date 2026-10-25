// Smoke test of the running explorer (npm run build && npm start, pointed at a benchmark database with a refreshed read model):
//   node scripts/db/bench/smoke-explorer.mjs http://127.0.0.1:3180
// Checks the real rendered HTML: status, the verbatim attribution, honest status labels, pagination, filters, a withheld transaction's 404, no grade or winner.
import assert from 'node:assert/strict'
const base = process.argv[2] ?? 'http://127.0.0.1:3180'
const STATEMENT = 'The information used here was obtained free of charge from and is copyrighted by Retrosheet. Interested parties may contact Retrosheet at "www.retrosheet.org".'
const decode = (h) => h.replace(/<!-- -->/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
const get = async (p) => { const t0 = performance.now(); const r = await fetch(base + p); const html = await r.text(); return { status: r.status, html, text: decode(html), ms: Math.round(performance.now() - t0) } }
const out = []
const check = (name, ok, detail = '') => { out.push({ name, ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`) }

const ledger = await get('/transactions')
check('ledger renders', ledger.status === 200, `${ledger.ms} ms`)
check('the Retrosheet attribution statement appears verbatim on the ledger', ledger.text.includes(STATEMENT))
check('rows are PARTIAL or UNVERIFIED, none is shown as verified complete', /badge-partial/.test(ledger.html) && !/badge-complete/.test(ledger.html))
check('the ledger paginates', /Older →/.test(ledger.text) && /Page 1/.test(decode(ledger.html).replace(/<[^>]*>/g, '')))
check('no grade, score, rank or winner column', !/<th[^>]*>\s*(Grade|Score|Winner|Rank)/i.test(ledger.html))
const first = ledger.html.match(/href="\/transactions\/(\d+)"/)
check('rows link to a detail page', Boolean(first))
const filtered = await get('/transactions?type=WAIVER&club=SEA&season=2015')
const body = (h) => (h.match(/<tbody>[\s\S]*<\/tbody>/) ?? [''])[0]
check('filters work', filtered.status === 200 && /Waiver claim/.test(body(filtered.html)) && !/Free-agent signing|Trade</.test(body(filtered.html)), `${filtered.ms} ms`)
const search = await get('/transactions?q=smith')
check('player search works', search.status === 200)
const ver = await get('/transactions?status=VERIFIED_COMPLETE')
check('a verified-complete filter shows none when nobody has verified anything', ver.status === 200 && /No transactions match/.test(ver.text))
const page3 = await get('/transactions?page=3')
check('a deep page renders', page3.status === 200 && /Page 3/.test(page3.html.replace(/<!-- -->/g, '').replace(/<[^>]*>/g, '')), `${page3.ms} ms`)
if (first) {
  const d = await get(`/transactions/${first[1]}`)
  check('detail renders with status, assets, unknowns, sources and attribution', d.status === 200 && /Reconstruction status/.test(d.text) && /<h2>Assets<\/h2>/.test(d.html) && /Unknown or unresolved/.test(d.text) && /<h2>Sources<\/h2>/.test(d.html) && d.text.includes(STATEMENT), `${d.ms} ms`)
  check('detail never claims verification without one', !/badge-complete/.test(d.html) && /not been verified complete|cites no corroborating source/.test(d.text))
  check('detail names no winner or grade', !/>\s*(Winner|Grade|Score)\b/i.test(d.html) && /no score, grade or winner is derived/.test(d.text) === (/WAR provider/.test(d.text)))
}
const cov = await get('/transactions/coverage')
check('coverage renders the three separate statements and the attribution', cov.status === 200 && /A source may be displayed/.test(cov.text) && /A transaction is verified complete/.test(cov.text) && /A club-season is a complete census/.test(cov.text) && cov.text.includes(STATEMENT), `${cov.ms} ms`)
check('coverage says tracked is not complete', /Tracked is not the complete population/.test(cov.text))
check('bad ids are 404, not errors', (await get('/transactions/abc')).status === 404 && (await get('/transactions/999999999')).status === 404)
const legacy = await get('/transactions/1')   // an early BAI trade cited to a source that is not authorized for display on this database
check('a transaction whose source is not authorized is not shown', legacy.status === 404)
const src = await get('/sources')
check('the sources page credits Retrosheet', src.status === 200 && src.text.includes(STATEMENT))
const slow = out.filter((o) => /(\d+) ms/.test(o.detail) && Number(o.detail.match(/(\d+) ms/)[1]) > 2000)
check('no page took over 2 s', slow.length === 0)
process.exit(out.every((o) => o.ok) ? 0 : 1)
