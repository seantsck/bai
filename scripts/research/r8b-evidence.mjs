// LOCAL-ONLY research workflow for the R8B pilot. Reads BAI's published record READ-ONLY; writes research PROPOSALS (never verification) into a private directory outside every git work tree.
//   init     --queue <queue csv> --count 10 --out <new dir>   one evidence package per ranked clean trade, every claim UNRESOLVED
//   validate --dir <dir>                                      every package well-formed; prints counts and the human work still open
//   triage   --queue <queue csv> --out <new dir>              the PTBNL triage view (JSON + CSV)
import fs from 'node:fs'
import path from 'node:path'
import pg from 'pg'
import { ownerDatabaseUrl } from '../db/lib/connection.mjs'
import { assertOutputAllowed } from './lib/r8b-queue.mjs'
import { isDate, assertComplete, fetchAuthorization, fetchTransactions, newPackage, parseQueueIds, readiness, triageRows, validatePackage, writePackages } from './lib/r8b-evidence.mjs'

const [cmd, ...argv] = process.argv.slice(2)
const opt = (k) => { const at = argv.map((x, i) => (x === `--${k}` ? i : -1)).filter((i) => i >= 0); if (at.length > 1) die(`--${k} given more than once`); if (!at.length) return null; const v = argv[at[0] + 1]; if (v == null || v.startsWith('--')) die(`--${k} needs a value`); return v }
const die = (m, c = 2) => { console.error(m); process.exit(c) }
const queueIds = (file, n) => { try { return parseQueueIds(fs.readFileSync(file, 'utf8'), n) } catch (e) { die(`${file}: ${e.message}`, 1) } }
const fail = (e) => die(e.message, 1)
const connect = async () => { const c = new pg.Client({ connectionString: ownerDatabaseUrl(), application_name: 'bai-r8b-evidence-ro', options: '-c default_transaction_read_only=on' }); await c.connect(); await c.query('begin isolation level repeatable read read only'); return c }
const cell = (v) => { let s = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }

if (cmd === 'init') {
  const q = opt('queue'); const n = opt('count') == null ? 10 : Number(opt('count')); const out = opt('out'); if (!q || !out || !Number.isInteger(n) || n < 1 || n > 50) die('usage: init --queue <csv> --count <1-50> --out <new dir>')
  try { assertOutputAllowed(out) } catch (e) { die(e.message) }
  const ids = queueIds(q, n); const c = await connect(); try { const txs = await fetchTransactions(c, ids); await c.query('rollback'); assertComplete(ids, txs); writePackages(txs.map(newPackage), out); console.log(JSON.stringify({ requested: ids.length, written: txs.length, status: 'every claim UNRESOLVED; nothing verified' })) } catch (e) { fail(e) } finally { await c.end() }
} else if (cmd === 'validate') {
  const dir = opt('dir'); if (!dir) die('usage: validate --dir <dir> [--offline] [--grant-expiry CATEGORY=YYYY-MM-DD|NONE ...]')
  const expiries = {}; argv.forEach((x, i) => { if (x === '--grant-expiry') { const m = /^([A-Z_]+)=(\d{4}-\d{2}-\d{2}|NONE)$/.exec(argv[i + 1] ?? ''); if (!m) die('--grant-expiry needs CATEGORY=YYYY-MM-DD (or CATEGORY=NONE for a grant that does not lapse)'); if (expiries[m[1]]) die(`--grant-expiry ${m[1]} given twice`); if (m[2] !== 'NONE' && !isDate(m[2])) die(`${m[2]} is not a real date`); expiries[m[1]] = m[2] } })
  if (argv.includes('--offline') && Object.keys(expiries).length) die('--grant-expiry has no effect with --offline (no grant is assumed); drop one of them')
  // the CURRENT grants come from the database (read-only); --offline assumes NONE, so every restricted candidate is checked as needing permission
  let authorization = null; if (!argv.includes('--offline')) { const c = await connect(); try { authorization = await fetchAuthorization(c, expiries); await c.query('rollback') } catch (e) { fail(e) } finally { await c.end() } }
  let files; try { files = fs.readdirSync(dir).sort() } catch (e) { die(`cannot read ${dir}: ${e.code}`, 2) } const problems = []; const rows = []; const seen = new Set()
  for (const f of files) {
    const m = /^p-(\d+)\.json$/.exec(f); if (!m) { problems.push(`${f}: not an evidence package file (expected p-<id>.json); nothing in the directory is ignored`); continue }
    let pkg; try { pkg = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) } catch (e) { problems.push(`${f}: not valid JSON`); rows.push({ id: Number(m[1]), candidates: 0, open_items: null, problems: 1 }); continue }
    const p = validatePackage(pkg, { authorization }); if (String(pkg?.transaction?.id) !== m[1]) p.push(`file name says ${m[1]} but the package is for ${pkg?.transaction?.id}`); if (seen.has(pkg?.transaction?.id)) p.push('duplicate package for this transaction'); seen.add(pkg?.transaction?.id)
    for (const x of p) problems.push(`${f}: ${x}`); rows.push({ id: pkg?.transaction?.id, candidates: pkg?.candidates?.length ?? 0, open_items: p.length ? null : readiness(pkg).length, problems: p.length })
  }
  if (!files.length) problems.push('the directory is empty: there is nothing to validate')
  for (const m of problems) console.error(m)
  console.log(JSON.stringify({ files_found: files.length, packages_valid: rows.filter((r) => !r.problems).length, packages_with_problems: rows.filter((r) => r.problems).length, other_files: files.filter((x) => !/^p-\d+\.json$/.test(x)).length, problems: problems.length, authorization: authorization ? { grants_now: authorization.grants.map((g) => g.category + (g.expires_on ? `<=${g.expires_on}` : ' (expiry NOT stated: clears nothing)')), read_on: authorization.read_on } : 'NONE (offline): no publication grant is assumed', packages_detail: rows })); process.exit(problems.length ? 1 : 0)
} else if (cmd === 'triage') {
  const q = opt('queue'); const out = opt('out'); if (!q || !out) die('usage: triage --queue <ptbnl queue csv> --out <new dir>')
  try { assertOutputAllowed(out) } catch (e) { die(e.message) }
  const ids = queueIds(q); const c = await connect(); try {
    const txs = await fetchTransactions(c, ids); await c.query('rollback'); assertComplete(ids, txs); const rows = triageRows(txs)
    const without = txs.filter((t) => !rows.some((r) => r.transaction_id === t.id)).map((t) => t.id); if (without.length) throw new Error(`the queue is stale: ${without.length} listed trades no longer have an unresolved player-to-be-named asset [${without.slice(0, 20).join(', ')}]; regenerate the queue`)
    fs.mkdirSync(out, { recursive: true, mode: 0o700 }); const cols = Object.keys(rows[0] ?? {})
    fs.writeFileSync(path.join(out, 'ptbnl-triage.json'), JSON.stringify(rows, null, 1) + '\n', { mode: 0o600 })
    fs.writeFileSync(path.join(out, 'ptbnl-triage.csv'), [cols.join(','), ...rows.map((r) => cols.map((k) => cell(r[k])).join(','))].join('\n') + '\n', { mode: 0o600 })
    const by = (k) => rows.reduce((m, r) => ((m[r[k]] = (m[r[k]] ?? 0) + 1), m), {})
    console.log(JSON.stringify({ requested: ids.length, transactions: txs.length, ptbnl_assets: rows.length, by_action: by('action'), by_priority: by('priority') }))
  } catch (e) { fail(e) } finally { await c.end() }
} else die('usage: r8b-evidence.mjs init|validate|triage (see the header)')
