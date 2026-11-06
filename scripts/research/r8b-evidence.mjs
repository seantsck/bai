// LOCAL-ONLY research workflow for the R8B pilot. Reads BAI's published record READ-ONLY; writes research PROPOSALS (never verification) into a private directory outside every git work tree.
//   init     --queue <queue csv> --count 10 --out <new dir>   one evidence package per ranked clean trade, every claim UNRESOLVED
//   validate --dir <dir>                                      every package well-formed; prints counts and the human work still open
//   triage   --queue <queue csv> --out <new dir>              the PTBNL triage view (JSON + CSV)
import fs from 'node:fs'
import path from 'node:path'
import pg from 'pg'
import { ownerDatabaseUrl } from '../db/lib/connection.mjs'
import { assertOutputAllowed } from './lib/r8b-queue.mjs'
import { fetchTransactions, newPackage, readiness, triageRows, validatePackage, writePackages } from './lib/r8b-evidence.mjs'

const [cmd, ...argv] = process.argv.slice(2)
const opt = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : null }
const die = (m, c = 2) => { console.error(m); process.exit(c) }
const queueIds = (file, n) => fs.readFileSync(file, 'utf8').trim().split('\n').slice(1, n ? n + 1 : undefined).map((l) => Number(l.split(',')[2]))
const connect = async () => { const c = new pg.Client({ connectionString: ownerDatabaseUrl(), application_name: 'bai-r8b-evidence-ro', options: '-c default_transaction_read_only=on' }); await c.connect(); await c.query('begin isolation level repeatable read read only'); return c }
const cell = (v) => { let s = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }

if (cmd === 'init') {
  const q = opt('queue'); const n = Number(opt('count') ?? 10); const out = opt('out'); if (!q || !out || !Number.isInteger(n) || n < 1 || n > 50) die('usage: init --queue <csv> --count <1-50> --out <new dir>')
  try { assertOutputAllowed(out) } catch (e) { die(e.message) }
  const c = await connect(); try { const txs = await fetchTransactions(c, queueIds(q, n)); await c.query('rollback'); writePackages(txs.map(newPackage), out); console.log(JSON.stringify({ packages: txs.length, status: 'every claim UNRESOLVED; nothing verified' })) } finally { await c.end() }
} else if (cmd === 'validate') {
  const dir = opt('dir'); if (!dir) die('usage: validate --dir <dir>')
  let bad = 0; const rows = []
  for (const f of fs.readdirSync(dir).filter((x) => /^p-\d+\.json$/.test(x)).sort()) {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); const p = validatePackage(pkg); bad += p.length; const need = readiness(pkg)
    rows.push({ id: pkg.transaction.id, candidates: pkg.candidates.length, open_items: need.length, problems: p.length }); for (const m of p) console.error(`${f}: ${m}`)
  }
  console.log(JSON.stringify({ packages: rows.length, problems: bad, packages_detail: rows })); process.exit(bad ? 1 : 0)
} else if (cmd === 'triage') {
  const q = opt('queue'); const out = opt('out'); if (!q || !out) die('usage: triage --queue <ptbnl queue csv> --out <new dir>')
  try { assertOutputAllowed(out) } catch (e) { die(e.message) }
  const c = await connect(); try {
    const txs = await fetchTransactions(c, queueIds(q)); await c.query('rollback'); const rows = triageRows(txs)
    fs.mkdirSync(out, { recursive: true, mode: 0o700 }); const cols = Object.keys(rows[0] ?? {})
    fs.writeFileSync(path.join(out, 'ptbnl-triage.json'), JSON.stringify(rows, null, 1) + '\n', { mode: 0o600 })
    fs.writeFileSync(path.join(out, 'ptbnl-triage.csv'), [cols.join(','), ...rows.map((r) => cols.map((k) => cell(r[k])).join(','))].join('\n') + '\n', { mode: 0o600 })
    const by = (k) => rows.reduce((m, r) => ((m[r[k]] = (m[r[k]] ?? 0) + 1), m), {})
    console.log(JSON.stringify({ transactions: txs.length, ptbnl_assets: rows.length, by_action: by('action'), by_priority: by('priority') }))
  } finally { await c.end() }
} else die('usage: r8b-evidence.mjs init|validate|triage (see the header)')
