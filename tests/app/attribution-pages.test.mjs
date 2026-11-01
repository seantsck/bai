// G6A.1: the REAL pages, rendered to HTML against a real PostgreSQL 17 as the website role, must carry Retrosheet's statement (verbatim, with the notice link) whenever they display
// Retrosheet-derived content, however stale or unavailable the supporting read models or the attribution lookup are. FICTIONAL data (tests/db/promotion-fixture.mjs).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { register } from 'node:module'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as h from '../db/harness.mjs'
import { applyMigrations } from '../../scripts/db/lib/migrations.mjs'
import { buildBaseline, importSample } from '../db/promotion-fixture.mjs'
import { RETROSHEET_STATEMENT, RETROSHEET_NOTICE_URL } from '../../lib/attribution.ts'

register('../support/next-stubs.mjs', import.meta.url)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-g6a-'))
let admin, closePool, pages; let current = null
const decode = (html) => html.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&')
const has = (html) => decode(html).includes(`<strong>${RETROSHEET_STATEMENT}</strong>`) && html.includes(`href="${RETROSHEET_NOTICE_URL}"`)
const sql = async (name, text) => { const c = await h.connect(name); try { return (await c.query(text)).rows } finally { await c.end().catch(() => {}) } }

/** Point the website's connection at one database (the module-level pool is rebuilt) and render pages from there. */
async function use (name) {
  await closePool(); delete process.env.BAI_PUBLIC_DATABASE_URL; process.env.BAI_PUBLIC_ROLE = 'bai_site'
  const c = await h.connect(name); process.env.BAI_DATABASE_URL = `postgres://postgres:postgres@127.0.0.1:${c.port}/${name}`; current = name
}
const render = async (el) => renderToStaticMarkup(await el)
const P = {
  list: () => render(pages.transactions.default({ searchParams: Promise.resolve({}) })),
  detail: (id) => render(pages.detail.default({ params: Promise.resolve({ id: String(id) }) })),
  coverage: () => render(pages.coverage.default()),
  players: () => render(pages.players.default()),
  player: (slug) => render(pages.player.default({ params: Promise.resolve({ slug }) })),
  sources: () => render(pages.sources.default())
}

before(async () => {
  process.env.BAI_PUBLIC_ROLE = 'bai_site'; process.env.BAI_DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:1/none'
  ;({ closePool } = await import('../../lib/db.ts'))
  pages = { transactions: await import('../../app/transactions/page.tsx'), detail: await import('../../app/transactions/[id]/page.tsx'), coverage: await import('../../app/transactions/coverage/page.tsx'),
    players: await import('../../app/players/page.tsx'), player: await import('../../app/players/[slug]/page.tsx'), sources: await import('../../app/sources/page.tsx') }
  await h.startServer(); admin = await h.connect('postgres')
  // S0: the baseline (migrations through 032, MLB trades, the Retrosheet grant recorded, read models refreshed): no Retrosheet content is published
  await admin.query('create database g6a_base'); const base = await h.connect('g6a_base')
  await applyMigrations(base, { through: '030' }); await buildBaseline(base, dir); await applyMigrations(base); await base.end()
  // S1: the Retrosheet batches imported (the promotion's effect on the identity tables) and NOT yet refreshed: the overview and read models are the baseline's
  await admin.query('create database g6a_pre template g6a_base'); const pre = await h.connect('g6a_pre'); await importSample(pre, dir); await pre.end()
  // S2: refreshed
  await admin.query('create database g6a_ref template g6a_pre'); const ref = await h.connect('g6a_ref'); await ref.query('select public.refresh_read_models()'); await ref.query('select public.refresh_transaction_read_models()'); await ref.end()
}, { timeout: 180000 })
after(async () => { await closePool?.(); await h.stopServer(); fs.rmSync(dir, { recursive: true, force: true }) })

const retroPlayerSlug = async (name) => (await sql(name, "select p.slug from players p join player_external_ids e on e.player_id = p.id where e.id_system = 'RETROSHEET' limit 1"))[0]?.slug ?? (await sql(name, "select slug from players where slug not like 'g54-%' order by id desc limit 1"))[0].slug
const retroTxId = async (name) => (await sql(name, "select r.transaction_id from rm_transactions r join transactions t on t.id = r.transaction_id join sources s on s.id = t.source_id where s.attribution_category = 'RETROSHEET' order by 1 limit 1"))[0].transaction_id

test('control: the statement checker is exact (a paraphrase, a missing link or a missing <strong> does not pass)', () => {
  assert.ok(has(`<aside class="attribution"><p><strong>${RETROSHEET_STATEMENT.replace(/"/g, '&quot;')}</strong> <a href="${RETROSHEET_NOTICE_URL}">Retrosheet notice</a></p></aside>`))
  assert.ok(!has('<p><strong>The information used here was obtained free of charge from Retrosheet.</strong></p>'))
  assert.ok(!has(`<p>${RETROSHEET_STATEMENT}</p>`))
})

test('a Retrosheet player is publicly readable BEFORE any read-model refresh: the Players pages already carry the statement (no database lookup involved)', async () => {
  await use('g6a_pre')
  const n = (await sql('g6a_pre', "select count(*)::int n from players where slug not like 'g54-%'"))[0].n; assert.ok(n >= 4, 'the imported players are readable now')
  assert.equal((await sql('g6a_pre', 'select count(*)::int n from rm_transactions'))[0].n, 0, 'the transaction read model has not been refreshed')
  const list = await P.players(); assert.ok(list.includes('Fixture Signee') || list.includes('Trade Player') || list.includes('Existing Player') || n > 0)
  assert.ok(has(list), 'Players list'); const slug = await retroPlayerSlug('g6a_pre'); assert.ok(has(await P.player(slug)), 'Players detail ' + slug)
})

test('Players pages show the statement unconditionally: attribution lookup failing, overview unavailable, overview stale with no authorized categories', async () => {
  await use('g6a_ref'); const slug = await retroPlayerSlug('g6a_ref')
  await sql('g6a_ref', 'alter table source_attribution_statements rename to zz_statements'); try { assert.ok(has(await P.players()), 'attribution query failure'); assert.ok(has(await P.player(slug))) } finally { await sql('g6a_ref', 'alter table zz_statements rename to source_attribution_statements') }
  await sql('g6a_ref', 'alter table rm_transaction_overview rename to zz_overview'); try { assert.ok(has(await P.players()), 'overview unavailable'); assert.ok(has(await P.player(slug))) } finally { await sql('g6a_ref', 'alter table zz_overview rename to rm_transaction_overview') }
  await sql('g6a_ref', "update rm_transaction_overview set display_authorized_categories = '{}'"); try { assert.ok(has(await P.players()), 'stale overview'); assert.ok(has(await P.player(slug))) } finally { await sql('g6a_ref', 'select public.refresh_transaction_read_models()') }
})

test('after the refresh the transaction pages carry the statement', async () => {
  await use('g6a_ref'); const id = await retroTxId('g6a_ref')
  const list = await P.list(); assert.ok(list.includes(`/transactions/${id}`), 'the list displays the Retrosheet transaction'); assert.ok(has(list), 'list'); assert.ok(has(await P.detail(id)), 'detail'); assert.ok(has(await P.coverage()), 'coverage'); assert.ok(has(await P.sources()), 'sources')
})

test('attribution query failure: list, detail and coverage still carry the statement (it no longer depends on that query)', async () => {
  await use('g6a_ref'); const id = await retroTxId('g6a_ref')
  await sql('g6a_ref', 'alter table source_attribution_statements rename to zz_statements')
  try { const [l, d, c] = [await P.list(), await P.detail(id), await P.coverage()]; assert.ok(l.includes('/transactions/'), 'rows displayed'); assert.ok(has(l), 'list'); assert.ok(has(d), 'detail: attribution lookup failure'); assert.ok(has(c), 'coverage') }
  finally { await sql('g6a_ref', 'alter table zz_statements rename to source_attribution_statements') }
})

test('overview unavailable: list and coverage fail closed (statement shown); detail is unaffected', async () => {
  await use('g6a_ref'); const id = await retroTxId('g6a_ref')
  await sql('g6a_ref', 'alter table rm_transaction_overview rename to zz_overview')
  try { assert.ok(has(await P.list()), 'list'); assert.ok(has(await P.coverage()), 'coverage'); assert.ok(has(await P.detail(id)), 'detail') } finally { await sql('g6a_ref', 'alter table zz_overview rename to rm_transaction_overview') }
})

test('overview stale with no authorized categories while Retrosheet rows are displayed: list, detail and coverage still carry the statement', async () => {
  await use('g6a_ref'); const id = await retroTxId('g6a_ref')
  await sql('g6a_ref', "update rm_transaction_overview set display_authorized_categories = '{}'")
  try { const o = (await sql('g6a_ref', 'select display_authorized_categories d from rm_transaction_overview'))[0].d; assert.deepEqual(o, [])
    assert.ok(has(await P.list()), 'list'); assert.ok(has(await P.detail(id)), 'detail'); assert.ok(has(await P.coverage()), 'coverage') } finally { await sql('g6a_ref', 'select public.refresh_transaction_read_models()') }
})

test('transaction detail: the statement follows the record\'s own source groups even when the statements lookup AND the overview both fail', async () => {
  await use('g6a_ref'); const id = await retroTxId('g6a_ref')
  await sql('g6a_ref', 'alter table source_attribution_statements rename to zz_statements'); await sql('g6a_ref', 'alter table rm_transaction_overview rename to zz_overview')
  try { assert.ok(has(await P.detail(id))) } finally { await sql('g6a_ref', 'alter table zz_overview rename to rm_transaction_overview'); await sql('g6a_ref', 'alter table zz_statements rename to source_attribution_statements') }
})

test('baseline with no historical transaction publication: the transaction pages show no Retrosheet statement and no transactions; the Players pages (which can show Retrosheet-created identities) always do', async () => {
  await use('g6a_base')
  assert.equal((await sql('g6a_base', 'select count(*)::int n from rm_transactions'))[0].n, 0)
  const l = await P.list(); assert.ok(!/href="\/transactions\/\d/.test(l), 'no transaction row is displayed'); const c = await P.coverage(); assert.ok(!decode(l).includes('copyrighted by Retrosheet'), 'list'); assert.ok(!decode(c).includes('copyrighted by Retrosheet'), 'coverage')
  assert.ok(has(await P.players()), 'players'); assert.ok(has(await P.sources()), 'sources')
})
