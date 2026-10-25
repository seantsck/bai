// Deterministic staging of version-2 TRADE records (scripts/research/lib/transactions.mjs): no database. FICTIONAL data.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import * as T from '../../scripts/research/lib/transactions.mjs'
import { validateRecordShape } from '../../scripts/research/lib/import-format.mjs'

const pl = (n) => ({ full_name: `Fixture Player ${n}`, external_ids: { MLBAM: String(9880000 + n) } })
const GROUPS = [{ source_key: 'a', role: 'PRIMARY_ANNOUNCEMENT', independence_group: 'club-a' }, { source_key: 'b', role: 'CORROBORATION', independence_group: 'wire-b' }]
const K = ['a', 'b']
const base = () => ({ type: 'TRADE', schema: 2, ref: 'x1', organization: 'LAD', date: '2031-07-20', source_key: 'a', sources: GROUPS,
  packages: [
    { from: 'LAD', to: 'BAL', source_keys: K, players: [{ player: pl(2), source_keys: K }, { player: pl(1), source_keys: K }], other_assets: [{ asset_type: 'CASH', description: 'cash', amount_usd: 5, source_keys: K }, { asset_type: 'DRAFT_PICK', description: 'pick', source_keys: K }] },
    { from: 'BAL', to: 'LAD', source_keys: K, players: [{ player: pl(3), source_keys: K }] }] })
const shuffled = () => {
  const r = base()
  r.packages.reverse(); r.packages[1].players.reverse(); r.packages[1].other_assets.reverse(); r.sources.reverse()
  r.packages.forEach((k) => { k.source_keys = [...k.source_keys].reverse() })
  return r
}
const L = (r) => r.packages.find((k) => k.from === 'LAD')
const B = (r) => r.packages.find((k) => k.from === 'BAL')
const shape = (r) => { const e = []; const w = []; const declared = new Set(['a', 'b']); T.validateTradeV2(r, e, w, (k, l) => { if (!declared.has(k)) e.push(`${l}: undeclared ${k}`) }); return { e, w } }

test('preparing is deterministic: order of players, assets, packages and sources does not matter, and preparing twice changes nothing', () => {
  const doc = (r) => ({ format: 'bai-research-import/1', batch_key: 'k', channel: 'TRADES', sources: [{ source_key: 'b' }, { source_key: 'a' }], records: [r] })
  const one = T.prepareToText(doc(base()))
  assert.equal(T.prepareToText(doc(shuffled())), one)
  assert.equal(T.prepareToText(JSON.parse(one)), one, 'idempotent')
  assert.equal(JSON.parse(one).records[0].external_ids[0].scheme, 'BAI_TXN')
})

test('the derived identity follows the trade, not its wording or its sources, and never joins a source-supplied one', () => {
  const id = (r) => T.canonicalizeTrade(r).external_ids.map((x) => `${x.scheme}:${x.id}`)
  const a = base()
  const reworded = { ...base(), description: 'a different description', ref: 'other', sources: [GROUPS[0], { ...GROUPS[1], locator: 'p. 3' }] }
  assert.deepEqual(id(reworded), id(a))
  const moved = { ...base(), date: '2031-07-21' }
  assert.notDeepEqual(id(moved), id(a))
  const extra = base(); extra.packages[1].players.push({ player: pl(9), source_keys: K })
  assert.notDeepEqual(id(extra), id(a))
  assert.deepEqual(id({ ...base(), external_ids: [{ scheme: 'MLB_TXN', id: 'FIX-1' }] }), ['MLB_TXN:FIX-1'])
})

test('cash is canonicalized to an explicit disclosure; an amount is DISCLOSED, none is UNKNOWN, zero stays zero', () => {
  const r = T.canonicalizeTrade({ ...base(), packages: [{ from: 'LAD', to: 'BAL', source_keys: K, other_assets: [
    { asset_type: 'CASH', description: 'a', amount_usd: 0, source_keys: K }, { asset_type: 'CASH', description: 'b', source_keys: K }, { asset_type: 'CASH', description: 'c', amount_disclosure: 'UNDISCLOSED', source_keys: K }] }, base().packages[1]] })
  const by = Object.fromEntries(r.packages.find((k) => k.from === 'LAD').other_assets.map((a) => [a.description, a]))
  assert.deepEqual([by.a.amount_usd, by.a.amount_disclosure], [0, 'DISCLOSED'])
  assert.deepEqual([by.b.amount_usd, by.b.amount_disclosure], [null, 'UNKNOWN'])
  assert.deepEqual([by.c.amount_usd, by.c.amount_disclosure], [null, 'UNDISCLOSED'])
})

test('shape: a valid record passes; each missing piece of provenance or identity is named', () => {
  assert.deepEqual(shape(T.canonicalizeTrade(base())).e, [])
  const cases = [
    ['undeclared source', (r) => { L(r).source_keys = ['zzz'] }, /not one of this record's sources/],
    ['asset without sources', (r) => { L(r).players[0].source_keys = [] }, /source_keys required/],
    ['no group', (r) => { delete r.sources[0].independence_group }, /independence_group required/],
    ['bad role', (r) => { r.sources[0].role = 'MAYBE' }, /role must be/],
    ['no MLBAM id', (r) => { L(r).players[0].player = { full_name: 'X' } }, /identified by an MLBAM id/],
    ['same player twice', (r) => { L(r).players[1] = L(r).players[0] }, /listed twice/],
    ['player sent by two packages', (r) => { B(r).players[0] = { player: pl(1), source_keys: K } }, /sent by two packages/],
    ['no description', (r) => { delete L(r).other_assets.find((a) => a.asset_type === 'DRAFT_PICK').description }, /description required/],
    ['amount with undisclosed', (r) => { L(r).other_assets.find((a) => a.asset_type === 'CASH').amount_disclosure = 'UNDISCLOSED' }, /an amount is DISCLOSED/],
    ['disclosed without amount', (r) => { L(r).other_assets[L(r).other_assets.findIndex((a) => a.asset_type === 'CASH')] = { asset_type: 'CASH', description: 'cash', amount_disclosure: 'DISCLOSED', source_keys: K } }, /DISCLOSED needs amount_usd/],
    ['negative cash', (r) => { L(r).other_assets.find((a) => a.asset_type === 'CASH').amount_usd = -1 }, /non-negative/],
    ['amount on a draft pick', (r) => { L(r).other_assets.find((a) => a.asset_type === 'DRAFT_PICK').amount_usd = 1 }, /takes no amount/],
    ['conditional without condition', (r) => { L(r).other_assets.find((a) => a.asset_type === 'DRAFT_PICK').conditional = true }, /states its condition/],
    ['resolution on a non-PTBNL', (r) => { L(r).other_assets.find((a) => a.asset_type === 'DRAFT_PICK').resolution = { kind: 'NOTHING', resolved_on: '2031-08-01', source_key: 'a' } }, /only a player to be named/],
    ['organization not a party', (r) => { r.organization = 'NYY' }, /not a party to the trade/],
    ['one direction twice', (r) => { r.packages[1] = { ...r.packages[0], from: r.packages[0].from } }, /two packages in the direction/],
    ['bad date', (r) => { r.date = '2031-13-45' }, /date must be/],
    ['schema', (r) => { r.schema = 3 }, /schema must be 2/]
  ]
  for (const [name, mutate, re] of cases) {
    const r = T.canonicalizeTrade(base()); mutate(r)
    assert.ok(shape(r).e.some((m) => re.test(m)), `${name}: ${JSON.stringify(shape(r).e)}`)
  }
})

test('a PTBNL resolution must be dated after the trade and sourced; resolving to a player needs a strong id', () => {
  const withRes = (resolution) => { const r = T.canonicalizeTrade(base()); L(r).other_assets.push({ asset_type: 'PLAYER_TO_BE_NAMED', description: 'ptbnl', source_keys: K, conditional: true, resolution }); return shape(r).e }
  assert.deepEqual(withRes({ kind: 'PLAYER', player: pl(7), resolved_on: '2031-12-01', source_key: 'b' }), [])
  assert.ok(withRes({ kind: 'PLAYER', player: pl(7), resolved_on: '2031-07-01', source_key: 'b' }).some((m) => /before the trade/.test(m)))
  assert.ok(withRes({ kind: 'PLAYER', player: { full_name: 'No Id' }, resolved_on: '2031-12-01', source_key: 'b' }).some((m) => /MLBAM/.test(m)))
  assert.ok(withRes({ kind: 'PLAYER', resolved_on: '2031-12-01', source_key: 'zz' }).length >= 2)
  assert.ok(withRes({ kind: 'CASH', amount_usd: 10, amount_disclosure: 'UNDISCLOSED', resolved_on: '2031-12-01', source_key: 'b' }).some((m) => /an amount is DISCLOSED/.test(m)))
  assert.ok(withRes({ kind: 'NOTHING', player: pl(7), resolved_on: '2031-12-01', source_key: 'b' }).some((m) => /only a PLAYER resolution names a player/.test(m)))
  const r = T.canonicalizeTrade(base()); L(r).other_assets.push({ asset_type: 'PLAYER_TO_BE_NAMED', description: 'ptbnl', source_keys: K, resolution: { kind: 'PLAYER', player: pl(2), resolved_on: '2031-12-01', source_key: 'b' } })
  assert.ok(shape(r).e.some((m) => /already carries/.test(m)))
})

test('validateRecordShape routes version 2, and marks the old shape as legacy', () => {
  const declared = new Set(['a', 'b'])
  const v2 = validateRecordShape(T.canonicalizeTrade(base()), 'TRADES', declared)
  assert.deepEqual(v2.errors, [])
  const legacy = validateRecordShape({ type: 'TRADE', source_key: 'a', organization: 'LAD', ref: 'l1', date: '2031-01-01', packages: [{ from: 'LAD', to: 'BAL', players: [{ player: pl(1) }] }] }, 'TRADES', declared)
  assert.ok(legacy.warnings.some((m) => /LEGACY_TRADE_SHAPE/.test(m)))
  const oneSided = T.canonicalizeTrade({ ...base(), packages: [base().packages[0]] })
  assert.ok(validateRecordShape(oneSided, 'TRADES', declared).warnings.some((m) => /ONE_SIDED_TRADE/.test(m)))
})

test('batch rules: shared identity with different content, exact duplicates, and same-day same-club pairs naming each other', () => {
  const a = T.canonicalizeTrade({ ...base(), external_ids: [{ scheme: 'MLB_TXN', id: '1' }] })
  const b = T.canonicalizeTrade({ ...base(), ref: 'x2', external_ids: [{ scheme: 'MLB_TXN', id: '2' }], packages: [{ ...base().packages[0], players: [{ player: pl(20), source_keys: K }], other_assets: [] }, { ...base().packages[1], players: [{ player: pl(21), source_keys: K }] }] })
  assert.equal(T.batchProblemsV2([a, b]).size, 2, 'two trades, same day and clubs, no names')
  const named = [{ ...a, distinct_from: ['MLB_TXN:2'] }, { ...b, distinct_from: ['MLB_TXN:1'] }]
  assert.equal(T.batchProblemsV2(named).size, 0)
  assert.equal(T.batchProblemsV2([{ ...a, distinct_from: ['MLB_TXN:2'] }, b]).size, 2, 'naming must be mutual')
  assert.equal(T.batchProblemsV2([a, { ...b, external_ids: a.external_ids }]).size, 1, 'same identity, different content')
  assert.equal(T.batchProblemsV2([a, JSON.parse(JSON.stringify(a))]).size, 1, 'exact duplicate')
  assert.equal(T.batchProblemsV2([a, { ...b, date: '2031-07-21' }]).size, 0, 'different days are different trades')
})

test('the prepare command writes the same bytes as the library and refuses other channels', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-prep-'))
  try {
    const input = path.join(dir, 'in.json'); const out = path.join(dir, 'out.json')
    const doc = { format: 'bai-research-import/1', batch_key: 'k', channel: 'TRADES', sources: [{ source_key: 'a' }, { source_key: 'b' }], records: [shuffled()] }
    fs.writeFileSync(input, JSON.stringify(doc))
    execFileSync(process.execPath, ['scripts/research/transactions.mjs', 'prepare', '--in', input, '--out', out], { stdio: 'pipe' })
    assert.equal(fs.readFileSync(out, 'utf8'), T.prepareToText(doc))
    fs.writeFileSync(input, JSON.stringify({ ...doc, channel: 'DRAFT' }))
    assert.throws(() => execFileSync(process.execPath, ['scripts/research/transactions.mjs', 'prepare', '--in', input, '--out', out], { stdio: 'pipe' }), /only TRADES documents/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
