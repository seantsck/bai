// R8B research queues: ranking, the three queues, CSV escaping, the output guard (never inside a git work tree, never overwritten) and the SQL against the real schema. FICTIONAL rows only.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import * as h from './harness.mjs'
import { COLUMNS, QUEUES, cell, TRADES_SQL, assertOutputAllowed, difficulty, fetchTrades, rank, tierOf, toCsv, writeQueues } from '../../scripts/research/lib/r8b-queue.mjs'

const row = (id, o = {}) => ({ transaction_id: id, season: 2015, date: '2015-06-01', club_keys: ['AAA', 'BBB'], gaps: ['PACKAGE_NOT_CORROBORATED'], cash_unknown: false, ptbnl: false, asset_count: 2, player_count: 2, conditional_assets: 0, unresolved_ptbnl_assets: 0, external_ids: `x${id}`, ...o })
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-r8b-'))
let db
before(async () => { await h.startServer(); db = await h.freshDatabase() }, { timeout: 120000 })
after(async () => { await h.stopServer(); fs.rmSync(tmp, { recursive: true, force: true }) })

test('tiers: a pending PTBNL outranks everything, unknown cash lowers a record, and the three queues partition the trades', () => {
  const rows = [row(1, { ptbnl: true }), row(2, { ptbnl: true, cash_unknown: true }), row(3), row(4, { cash_unknown: true })]
  assert.deepEqual(rows.map(tierOf), ['P1A', 'P1B', 'P2', 'P3'])
  const sizes = Object.values(QUEUES).map((keep) => rank(rows, keep).length); assert.deepEqual(sizes, [2, 1, 1]); assert.equal(sizes.reduce((a, b) => a + b), rows.length)
  for (const r of rows) assert.equal(Object.values(QUEUES).filter((keep) => keep(r)).length, 1, 'every trade is in exactly one queue')
})

test('ranking is deterministic: tier, then fewer/simpler assets, then newer season, then id', () => {
  const rows = [row(10, { asset_count: 5 }), row(11, { asset_count: 2, season: 2012 }), row(12, { asset_count: 2, season: 2018 }), row(13, { asset_count: 2, season: 2018 }), row(14, { asset_count: 2, conditional_assets: 1 })]
  const q = rank(rows, QUEUES['queue-2-clean-trades'])
  assert.deepEqual(q.map((r) => r.transaction_id), [12, 13, 11, 14, 10]); assert.deepEqual(q.map((r) => r.rank), [1, 2, 3, 4, 5])
  assert.deepEqual(rank([...rows].reverse(), QUEUES['queue-2-clean-trades']).map((r) => r.transaction_id), [12, 13, 11, 14, 10], 'input order does not matter')
  assert.equal(difficulty(row(1, { ptbnl: true, cash_unknown: true, conditional_assets: 1, asset_count: 3 })), 3 + 2 + 2 + 2)
})

test('CSV: fixed columns, arrays joined, quotes and commas escaped, no source text', () => {
  const csv = toCsv(rank([row(1, { club_keys: ['A,B', 'C"D'], gaps: ['G1', 'G2'] })], QUEUES['queue-2-clean-trades']))
  const [head, line] = csv.trim().split('\n'); assert.equal(head, COLUMNS.join(','))
  assert.match(line, /"A,B\|C""D"/); assert.match(line, /G1\|G2$/); assert.equal(COLUMNS.some((c) => /title|url|text|note/.test(c)), false)
})

test('output guard: a new directory outside any git work tree; never overwritten; files are private', () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')
  assert.throws(() => assertOutputAllowed(path.join(root, 'queues-out')), /inside the git work tree/)
  const git = path.join(tmp, 'repo'); fs.mkdirSync(path.join(git, '.git'), { recursive: true }); assert.throws(() => assertOutputAllowed(path.join(git, 'sub', 'q')), /inside the git work tree/)
  const out = path.join(tmp, 'queues'); const counts = writeQueues([row(1, { ptbnl: true }), row(2), row(3, { cash_unknown: true })], out)
  assert.deepEqual(counts, { 'queue-1-ptbnl': 1, 'queue-2-clean-trades': 1, 'queue-3-cash-unknown': 1 })
  assert.equal(fs.statSync(out).mode & 0o777, 0o700); for (const f of fs.readdirSync(out)) assert.equal(fs.statSync(path.join(out, f)).mode & 0o777, 0o600)
  assert.throws(() => writeQueues([], out), /already exists/)
})

test('the SQL runs against the real schema read-only and returns the published trades (none before a refresh)', async () => {
  await db.query('begin read only'); try { assert.deepEqual(await fetchTrades(db), []); assert.match(TRADES_SQL, /from public\.rm_transactions/); assert.doesNotMatch(TRADES_SQL, /\b(insert|update|delete)\b/i) } finally { await db.query('rollback') }
  const r = spawnSync(process.execPath, ['scripts/research/r8b-queues.mjs', '--out', path.join(tmp, 'x'), '--extra'], { encoding: 'utf8', cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..') }); assert.equal(r.status, 2, 'unsupported arguments exit 2')
})

test('CSV formula injection: cells that start with = + - @ tab or CR are neutralised, in every column, and ordinary values are unchanged', () => {
  for (const evil of ['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\tx', '\rx', '=HYPERLINK("http://x","y")']) {
    const c = cell(evil); assert.ok(c.replace(/^"/, '').startsWith("'"), `${JSON.stringify(evil)} -> ${c}`)
  }
  assert.equal(cell('2015-06-01'), '2015-06-01'); assert.equal(cell('85987@20210204'), '85987@20210204'); assert.equal(cell(42), '42'); assert.equal(cell(null), ''); assert.equal(cell(['A', 'B']), 'A|B')
  assert.equal(cell(['=A', 'B']), "'=A|B", 'the joined cell is judged as a whole')
  const csv = toCsv(rank([row(1, { club_keys: ['=cmd|calc'], gaps: ['@x'], external_ids: '+1' })], QUEUES['queue-2-clean-trades']))
  const line = csv.trim().split('\n')[1]; for (const f of ["'=cmd|calc", "'@x", "'+1"]) assert.ok(line.includes(f), `${f} in ${line}`)
  assert.ok(!/(^|,)[=+@\-]/.test(line.replace(/^\d+,[A-Z0-9]+,\d+,/, '')), 'no cell starts with a formula character')
})

test('the generator is strictly read-only: the SQL is one SELECT, the session is forced read-only, and no write verb appears in either file', () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')
  const lib = fs.readFileSync(path.join(root, 'scripts/research/lib/r8b-queue.mjs'), 'utf8'); const cli = fs.readFileSync(path.join(root, 'scripts/research/r8b-queues.mjs'), 'utf8')
  assert.match(TRADES_SQL.trim(), /^select /i); assert.equal(TRADES_SQL.split(';').filter((x) => x.trim()).length, 1)
  assert.match(cli, /default_transaction_read_only=on/); assert.match(cli, /begin isolation level repeatable read read only/)
  const sqlLiterals = [...(lib + cli).matchAll(/`([^`]*)`|'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1] ?? m[2]).filter((x) => /\b(select|begin|rollback|commit)\b/i.test(x))
  for (const s of sqlLiterals) assert.doesNotMatch(s, /\b(insert|update|delete|truncate|drop|alter|create|grant|revoke|vacuum|copy|call|do)\b/i, s.slice(0, 60))
  assert.doesNotMatch(cli, /\.query\(\s*['"`](?!begin isolation level repeatable read read only|rollback)/, 'only the read-only begin and rollback are issued directly')
})

test('behaviourally read-only: against a database that refuses writes, fetching succeeds and a write attempt is refused', async () => {
  await db.query('begin read only'); try { await fetchTrades(db); await assert.rejects(db.query('create temp table r8b_probe (x int)'), /read-only transaction/) } finally { await db.query('rollback') }
})
