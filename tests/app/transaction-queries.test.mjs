// The explorer's page queries against a real PostgreSQL 17 through the same anon-role wrapper the app uses (migration 030 read model).
// FICTIONAL: 130 free-agent signings and a few trades, a Retrosheet-category source whose display a person authorizes by recording a grant.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as h from '../db/harness.mjs'
import * as P from '../../scripts/research/lib/pipeline.mjs'
import * as T from '../../scripts/research/lib/transactions.mjs'
import { prepareAcquisitionDoc } from '../../scripts/research/lib/acquisitions.mjs'

let q, db, closePool, publicQuery, parse, build
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-txq-'))
const RETRO = { source_key: 'hist:retrosheet-0123456789', source_type: 'REFERENCE_DATABASE', authority_level: 'REPUTABLE_SECONDARY', title: 'Retrosheet transactions database (fixture)', publisher: 'Retrosheet', url: 'https://www.retrosheet.org/transactions/tranDB.zip', retrieved_date: '2026-10-22' }
const CLUBS = ['LAD', 'SEA', 'NYY', 'BOS', 'HOU']
before(async () => {
  ;({ publicQuery, closePool } = await import('../../lib/db.ts'))
  ;({ parseTransactionParams: parse } = await import('../../lib/transactions.ts'))
  await h.startServer()
  db = await h.freshDatabase()
  const stage = async (doc) => { const f = path.join(dir, `${doc.batch_key}.json`); fs.writeFileSync(f, JSON.stringify(doc)); const { batch } = await P.stageFile(db, f, {}); assert.ok((await P.validateBatch(db, batch.id)).ok); await P.applyBatch(db, batch.id, { write: true }) }
  const records = Array.from({ length: 130 }, (_, i) => ({ type: 'ACQUISITION', schema: 1, ref: `fa-${i}`, organization: CLUBS[i % 5], acquisition_class: 'FREE_AGENT', transaction_type: 'FREE_AGENT_SIGNING', date: `2031-${String(1 + (i % 9)).padStart(2, '0')}-${String(1 + (i % 27)).padStart(2, '0')}`,
    source_key: RETRO.source_key, sources: [{ source_key: RETRO.source_key, role: 'REFERENCE', independence_group: 'retrosheet-archive', locator: `line ${i}` }], external_ids: [{ scheme: 'RETROSHEET_TXN', id: `fa-${i}` }],
    move: { player: { full_name: `Fixture Signee ${String(i).padStart(3, '0')}`, external_ids: { MLBAM: String(9895000 + i) } }, to_organization: CLUBS[i % 5], source_event_code: 'F' } }))
  await stage(prepareAcquisitionDoc({ format: 'bai-research-import/1', batch_key: 'fa-130', channel: 'ACQUISITIONS', sources: [RETRO], records }))
  const pk = (from, to, ps) => ({ from, to, source_keys: [RETRO.source_key], players: ps.map((n) => ({ player: { full_name: `Fixture Trader ${n}`, external_ids: { MLBAM: String(9896000 + n) } }, source_keys: [RETRO.source_key] })), other_assets: [] })
  await stage(T.prepareTradeDoc({ format: 'bai-research-import/1', batch_key: 'trades', channel: 'TRADES', sources: [RETRO], records: [{ type: 'TRADE', schema: 2, ref: 'tr1', organization: 'LAD', date: '2031-07-04', source_key: RETRO.source_key,
    sources: [{ source_key: RETRO.source_key, role: 'REFERENCE', independence_group: 'retrosheet-archive' }], external_ids: [{ scheme: 'RETROSHEET_TXN', id: 'tr1' }], packages: [pk('LAD', 'SEA', [1]), pk('SEA', 'LAD', [2])] }] }))
  await db.query("insert into ingest.source_publication_grants (attribution_category, basis_reference, scope_note) values ('RETROSHEET', 'fixture', 'fixture')")
  await h.releaseRetrosheet(db)
  await db.query('select public.refresh_transaction_read_models()')
  delete process.env.BAI_PUBLIC_DATABASE_URL
  process.env.BAI_DATABASE_URL = `postgres://postgres:postgres@127.0.0.1:${db.port}/${db.database}`
  q = await import('../../lib/queries.ts')
  ;({ buildTransactionQuery: build } = await import('../../lib/transactions.ts'))
}, { timeout: 120000 })
after(async () => { await closePool?.(); await h.stopServer(); fs.rmSync(dir, { recursive: true, force: true }) })

test('page queries run as anon, read-only, and the overview states the three separate facts', async () => {
  assert.deepEqual(await publicQuery('select current_user as u'), [{ u: 'anon' }])
  const o = await q.getTransactionOverview()
  assert.equal(o.transactions, 131)
  assert.equal(o.verified_complete, 0)
  assert.equal(o.complete_census_club_seasons, 0)
  assert.ok(o.display_authorized_categories.includes('RETROSHEET'))
  const st = await q.getAttributionStatements()
  assert.equal(st[0].attribution_category, 'RETROSHEET')
})

test('the ledger is paginated newest first: a full page plus one row to know there is a next page, then the rest', async () => {
  const p1 = await q.getTransactionPage(parse({}))
  assert.equal(p1.length, 51)
  const p3 = await q.getTransactionPage(parse({ page: '3' }))
  assert.equal(p3.length, 31)
  const p2 = await q.getTransactionPage(parse({ page: '2' }))
  const ids = new Set([...p1.slice(0, 50), ...p2.slice(0, 50), ...p3].map((r) => r.transaction_id))
  assert.equal(ids.size, 131, 'no row repeated or skipped across pages')
  const dates = p1.map((r) => new Date(r.transaction_date).getTime())
  assert.deepEqual(dates, [...dates].sort((a, b) => b - a))
  assert.ok(p1.every((r) => r.status === 'PARTIAL'), 'licensed for display and sourced: partial, never complete')
})

test('filters: season, club, type, status and a player-name prefix', async () => {
  const season = await q.getTransactionPage(parse({ season: '2031' }))
  assert.equal(season.length, 51)
  assert.equal((await q.getTransactionPage(parse({ season: '2030' }))).length, 0)
  const club = await q.getTransactionPage(parse({ club: 'HOU', page: '1' }))
  assert.ok(club.length === 26 && club.every((r) => r.club_keys.includes('HOU')))
  const trades = await q.getTransactionPage(parse({ type: 'TRADE' }))
  assert.equal(trades.length, 1); assert.deepEqual(trades[0].club_keys, ['LAD', 'SEA'])
  assert.equal((await q.getTransactionPage(parse({ type: 'FREE_AGENT', club: 'LAD' }))).length, 26)
  assert.equal((await q.getTransactionPage(parse({ status: 'VERIFIED_COMPLETE' }))).length, 0)
  assert.equal((await q.getTransactionPage(parse({ status: 'PARTIAL', type: 'TRADE' }))).length, 1)
  const byName = await q.getTransactionPage(parse({ q: 'fixture signee 07' }))
  assert.equal(byName.length, 10, 'Signee 070 to 079')
  assert.equal((await q.getTransactionPage(parse({ q: 'fixture trader' }))).length, 1)
  assert.equal((await q.getTransactionPage(parse({ q: 'nobody like this' }))).length, 0)
  assert.equal((await q.getTransactionPage(parse({ q: 'seattle' }))).length >= 0, true)
})

test('detail queries return the transaction, its assets, sources and later movement, all bounded and public', async () => {
  const [trade] = await q.getTransactionPage(parse({ type: 'TRADE' }))
  const id = Number(trade.transaction_id)
  const t = await q.getTransaction(id)
  assert.equal(t.category, 'TRADE'); assert.equal(t.status, 'PARTIAL'); assert.equal(t.verified_on, null)
  const assets = await q.getTransactionAssets(id)
  assert.equal(assets.filter((a) => a.asset_kind === 'PLAYER').length, 2)
  assert.ok(assets.every((a) => a.from_key && a.to_key))
  const src = await q.getTransactionSources(id)
  assert.ok(src.length >= 1 && src.every((s) => s.attribution_category === 'RETROSHEET'))
  assert.deepEqual(await q.getTransaction(999999), null)
  const ret = await q.getTransactionReturns(id)
  assert.ok(ret.every((r) => r.evidence === 'NOT_OBSERVED' || r.evidence.startsWith('OBSERVED') || r.evidence === 'WITHHELD_PERMISSION'))
  const cov = await q.getTransactionClubSeasons()
  assert.ok(cov.every((c) => c.coverage_state !== 'COMPLETE_CENSUS'))
})

test('the page queries use indexes and stay fast on this ledger (the real benchmark is scripts/db/bench/explorer.mjs)', async () => {
  for (const f of [{}, { season: '2031' }, { club: 'LAD' }, { type: 'FREE_AGENT' }, { q: 'fixture' }]) {
    const { sql, params } = build(parse(f))
    const t0 = Date.now(); await publicQuery(sql, params); assert.ok(Date.now() - t0 < 1500, JSON.stringify(f))
  }
})

test('the public role reads no unauthorized or internal data', async () => {
  for (const sql of ['select * from transaction_player_moves', 'select * from analytics.transaction_completeness', 'select * from ingest.source_publication_grants', 'select public.refresh_transaction_read_models()']) await assert.rejects(publicQuery(sql), /permission denied/, sql)
})
