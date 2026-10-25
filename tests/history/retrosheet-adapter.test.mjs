// Retrosheet identity, adapter (version-2 trade candidates) and reconciliation, on FICTIONAL rows and a fictional register.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as R from '../../scripts/research/lib/retrosheet-transactions.mjs'
import { indexRegisterByRetro, resolveAll, resolveRetroId, idFitsName, repeatActivity } from '../../scripts/research/lib/retrosheet-identity.mjs'
import { holdReasons, buildCandidates, sourceDeclarations, sourceKeys, RETRO_GROUP } from '../../scripts/research/lib/retrosheet-adapter.mjs'
import { reconcileTrades } from '../../scripts/research/lib/retrosheet-reconcile.mjs'
import { validateRecordShape } from '../../scripts/research/lib/import-format.mjs'
import { renderReport } from '../../scripts/research/lib/retrosheet-report.mjs'

const line = (f) => f.map((v) => `"${v}"`).join(',')
const row = (o) => line([o.date ?? '20300101', o.time ?? '', o.approx ?? '', '', '', o.id ?? '1', o.player ?? '', o.type ?? 'T ', o.from ?? '', o.fromLg ?? '', o.to ?? '', o.toLg ?? '', '', '', '', o.info ?? ''])
const parse = (...rows) => R.parseTran(rows.join('\n') + '\n')
const lg = { LAN: 'NL', SEA: 'AL', NYA: 'AL', BOS: 'AL', SDN: 'NL' }
const t = (id, date, player, from, to, extra = {}) => row({ id, date, player, type: extra.type ?? 'T ', from, fromLg: lg[from], to, toLg: lg[to], info: extra.info })

// fictional register: key_person,key_uuid,key_mlbam,key_retro,key_bbref,...
const HEAD = 'key_person,key_uuid,key_mlbam,key_retro,key_bbref,key_bbref_minors,key_fangraphs,key_npb,key_sr_nfl,key_sr_nba,key_sr_nhl,key_wikidata,name_last,name_first,name_given,name_suffix,name_matrilineal,name_nick,birth_year,birth_month,birth_day,death_year,death_month,death_day,pro_played_first,pro_played_last,mlb_played_first,mlb_played_last'
const P = (key, mlbam, retro, last, first, bbref = '') => `${key},u-${key},${mlbam},${retro},${bbref},,,,,,,,${last},${first},,,,,1990,5,17,,,,2010,2020,2012,2020`
function register (rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-reg-'))
  for (const s of '0123456789abcdef') fs.writeFileSync(path.join(dir, `people-${s}.csv`), HEAD + '\n' + (s === '0' ? rows.join('\n') + '\n' : ''))
  made.push(dir)
  return dir
}
const made = []
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }) })
const REG = register([P('a1', '990001', 'smitj001', 'Smith', 'John'), P('a2', '990002', 'jonea001', 'Jones', 'Al'), P('a3', '990003', 'nix-j001', 'Nix', 'Jay'), P('a4', '', 'nomla001', 'Nomlb', 'Al'),
  P('a5', '990005', 'badnm001', 'Different', 'Person'), P('a6', '990006', 'dupea001', 'Dupe', 'Al'), P('a7', '990007', 'dupea001', 'Dupe', 'Al'), P('a8', '990008', 'bairj001', 'Baird', 'Jim')])
const NOBAI = { byMlbam: new Map(), byRetro: new Map() }

test('id and name: surname stem plus first initial, hyphen-padded; a pattern that does not fit is reported', () => {
  assert.equal(idFitsName('smitj001', 'Smith', 'John'), true)
  assert.equal(idFitsName('nix-j001', 'Nix', 'Jay'), true)
  assert.equal(idFitsName('smitj001', 'Jones', 'John'), false)
  assert.equal(idFitsName('de-lc001', 'De La Cruz', 'Carlos'), false, 'a stem is four letters of the surname')
})

test('identity: Retrosheet id -> register -> MLBAM only; missing, ambiguous, mismatched and conflicting ids are held, never guessed', () => {
  const wanted = new Set(['smitj001', 'jonea001', 'nix-j001', 'nomla001', 'badnm001', 'dupea001', 'zzzzz001', 'bairj001'])
  const reg = indexRegisterByRetro(REG, wanted)
  const bai = { byMlbam: new Map([['990008', { id: 8, retro: 'someone9' }]]), byRetro: new Map() }
  const s = (id) => resolveRetroId(id, reg, bai)
  assert.equal(s('smitj001').state, 'STRONG')
  assert.equal(s('smitj001').evidence.mlbam, '990001')
  assert.deepEqual(s('smitj001').evidence.witnesses.slice(0, 2), ['chadwick-register key_retro -> key_mlbam', 'retrosheet id pattern fits register name'])
  assert.equal(s('nix-j001').state, 'STRONG')
  assert.equal(s('nomla001').state, 'REGISTER_WITHOUT_MLBAM')
  assert.equal(s('badnm001').state, 'ID_NAME_PATTERN_MISMATCH')
  assert.equal(s('dupea001').state, 'REGISTER_AMBIGUOUS')
  assert.equal(s('zzzzz001').state, 'NOT_IN_REGISTER')
  assert.equal(s('bairj001').state, 'BAI_CONFLICT', 'BAI already holds that MLBAM id under a different Retrosheet id')
  assert.equal(s('smitj001').evidence.retrosheet_id, 'smitj001', 'the source id is kept on the evidence')
  const rows = parse(t('1', '20300601', 'Some Prospect', 'LAN', 'SEA'))
  assert.equal(resolveAll(rows, reg, bai).size, 0, 'a name is never resolved to a player')
})

test('repeat and multi-organization activity is counted from the groups', () => {
  const rows = parse(t('1', '20300601', 'smitj001', 'LAN', 'SEA'), t('2', '20300801', 'smitj001', 'SEA', 'NYA'), row({ id: '3', date: '20300101', player: 'jonea001', type: 'F ', to: 'LAN', toLg: 'NL' }))
  const a = repeatActivity(R.groupRows(rows), new Map([['smitj001', { state: 'STRONG' }]]))
  assert.deepEqual(a, { players_with_acquisitions: 2, repeat_acquisition_players: 1, multi_organization_players: 1, resolved_repeat: 1 })
})

const KEYS = sourceKeys('c'.repeat(64), '781c175')
const DECL = sourceDeclarations({ archiveSha256: 'c'.repeat(64), retrievedOn: '2026-10-22', registerCommit: '781c175', registerCommitFull: '781c175e748b89e5730fd3f5de0086b9355b2f92', registerRetrievedOn: '2026-10-21' })
const resolvedFor = (rows) => resolveAll(rows, indexRegisterByRetro(REG, new Set(rows.filter((r) => r.player.kind === 'RETROSHEET_ID').map((r) => r.player.retro_id))), NOBAI)
const stage = (rows) => { const g = R.groupRows(rows); return buildCandidates(g, resolvedFor(rows), { from: 2030, to: 2030, declarations: DECL, keys: KEYS, batchKey: 'rs-test' }) }

test('a clean two-club trade becomes a version-2 candidate with one source lineage, unknown cash and package/asset provenance', () => {
  const rows = parse(t('10', '20300601', 'smitj001', 'LAN', 'SEA'), t('10', '20300601', 'jonea001', 'SEA', 'LAN'), t('10', '20300601', '', 'LAN', 'SEA', { info: '$' }))
  const out = stage(rows)
  assert.equal(out.holds.length, 0)
  const rec = out.doc.records[0]
  const errs = []; const warns = []
  validateRecordShape(rec, 'TRADES', new Set(DECL.map((s) => s.source_key)))
  assert.deepEqual(validateRecordShape(rec, 'TRADES', new Set(DECL.map((s) => s.source_key))).errors, [])
  void errs; void warns
  assert.deepEqual(rec.external_ids, [{ scheme: 'RETROSHEET_TXN', id: '10@20300601', source_key: KEYS.retro }])
  assert.deepEqual(rec.sources.map((s) => [s.role, s.independence_group]), [['REFERENCE', RETRO_GROUP]], 'one lineage, never a primary announcement')
  const lad = rec.packages.find((p) => p.from === 'LAD')
  assert.deepEqual(lad.other_assets.map((a) => [a.asset_type, a.amount_disclosure, a.amount_usd]), [['CASH', 'UNKNOWN', null]], 'cash is unknown, never zero, never an amount')
  assert.equal(lad.players[0].player.external_ids.MLBAM, '990001')
  assert.equal(lad.players[0].player.external_id_sources.MLBAM, KEYS.chadwick)
  for (const p of rec.packages) { assert.deepEqual(p.source_keys, [KEYS.retro]); for (const a of [...p.players, ...p.other_assets]) assert.deepEqual(a.source_keys, [KEYS.retro]) }
  assert.deepEqual(out.doc.sources.map((s) => s.source_key), [KEYS.chadwick, KEYS.retro].sort())
})

test('holds: every group the source does not state completely is held with its reasons, nothing is guessed', () => {
  const hold = (...rs) => { const rows = parse(...rs); return stage(rows).holds[0]?.reasons ?? [] }
  assert.deepEqual(hold(t('1', '20300601', 'smitj001', 'LAN', 'SEA'), t('1', '20300601', 'Some Prospect', 'SEA', 'LAN')), ['NAME_ONLY_PLAYER'])
  assert.ok(hold(t('2', '20300601', 'smitj001', 'LAN', 'SEA')).includes('ONE_DIRECTION_ONLY'))
  assert.ok(hold(t('3', '20300601', 'smitj001', 'LAN', 'SEA'), t('3', '20300601', 'badnm001', 'SEA', 'LAN')).includes('IDENTITY_badnm001:ID_NAME_PATTERN_MISMATCH'))
  assert.ok(hold(t('4', '20300601', 'smitj001', 'LAN', 'SEA'), t('4', '20300601', 'zzzzz001', 'SEA', 'LAN')).includes('IDENTITY_zzzzz001:NOT_IN_REGISTER'))
  assert.ok(hold(t('5', '20300700', 'smitj001', 'LAN', 'SEA'), t('5', '20300700', 'jonea001', 'SEA', 'LAN')).includes('DATE_MONTH_ONLY'))
  assert.ok(hold(row({ id: '6', date: '20300601', approx: '@', player: 'smitj001', from: 'LAN', fromLg: 'NL', to: 'SEA', toLg: 'AL' }), t('6', '20300601', 'jonea001', 'SEA', 'LAN')).includes('DATE_APPROXIMATE'))
  assert.ok(hold(t('7', '20300601', 'smitj001', 'LAN', 'SEA'), t('7', '20300601', 'jonea001', 'SEA', 'LAN', { info: 'future considerations' })).includes('FREE_TEXT_ASSET'))
  assert.ok(hold(t('8', '20300601', 'smitj001', 'LAN', 'SEA', { type: 'C ' }), t('8', '20300601', 'jonea001', 'SEA', 'LAN', { type: 'C ' })).includes('CONDITIONAL_TRADE_CONDITION_NOT_STATED'))
  assert.ok(hold(t('9', '20300601', 'smitj001', 'LAN', 'SEA', { type: 'Tv' }), t('9', '20300601', 'jonea001', 'SEA', 'LAN', { type: 'Tv' })).includes('VOID_RETURN_OR_REFUSAL_MEMBER'))
  assert.ok(hold(t('11', '20300601', 'smitj001', 'LAN', 'SEA'), t('11', '20300601', 'smitj001', 'SEA', 'LAN')).includes('PLAYER_IN_TWO_DIRECTIONS'))
  assert.ok(hold(t('12', '20300601', 'smitj001', 'LAN', 'Long Island'), t('12', '20300601', 'jonea001', 'Long Island', 'LAN')).includes('NON_MLB_PARTY'))
  assert.ok(hold(t('13', '20300601', 'nomla001', 'LAN', 'SEA'), t('13', '20300601', 'jonea001', 'SEA', 'LAN')).includes('IDENTITY_nomla001:REGISTER_WITHOUT_MLBAM'))
})

test('PTBNL: a later-dated player becomes the resolution of exactly one placeholder; otherwise the group is held', () => {
  const ok = stage(parse(t('20', '20300601', 'smitj001', 'LAN', 'SEA'), t('20', '20300601', 'jonea001', 'SEA', 'LAN'), t('20', '20300601', '', 'SEA', 'LAN', { info: 'player to be named or cash' }), t('20', '20300915', 'nix-j001', 'SEA', 'LAN')))
  assert.equal(ok.holds.length, 0)
  const sea = ok.doc.records[0].packages.find((p) => p.from === 'SEA')
  assert.equal(sea.other_assets[0].asset_type, 'PLAYER_TO_BE_NAMED')
  assert.equal(sea.other_assets[0].condition_text, 'player to be named or cash')
  assert.deepEqual([sea.other_assets[0].resolution.kind, sea.other_assets[0].resolution.resolved_on, sea.other_assets[0].resolution.player.external_ids.MLBAM], ['PLAYER', '2030-09-15', '990003'])
  const dateRecord = ok.doc.records[0].date
  assert.equal(dateRecord, '2030-06-01', 'the trade keeps its own date')
  const none = stage(parse(t('21', '20300601', 'smitj001', 'LAN', 'SEA'), t('21', '20300601', 'jonea001', 'SEA', 'LAN'), t('21', '20300915', 'nix-j001', 'SEA', 'LAN')))
  assert.deepEqual(none.holds[0].reasons, ['LATER_DATED_MEMBER_WITHOUT_ONE_PTBNL_PLACEHOLDER'])
  const pending = stage(parse(t('22', '20300601', 'smitj001', 'LAN', 'SEA'), t('22', '20300601', 'jonea001', 'SEA', 'LAN'), t('22', '20300601', '', 'SEA', 'LAN', { info: 'player to be named' })))
  assert.equal(pending.holds.length, 0)
  assert.equal(pending.doc.records[0].packages.find((p) => p.from === 'SEA').other_assets[0].resolution, undefined, 'an unresolved PTBNL stays pending')
})

test('multi-team and same-day trades: packages by direction; same-day same-club trades with different source ids name each other', () => {
  const rows = parse(t('30', '20300601', 'smitj001', 'LAN', 'SEA'), t('30', '20300601', 'jonea001', 'SEA', 'NYA'), t('30', '20300601', 'nix-j001', 'NYA', 'LAN'),
    t('31', '20300710', 'smitj001', 'NYA', 'BOS'), t('31', '20300710', 'jonea001', 'BOS', 'NYA'), t('32', '20300710', 'nix-j001', 'NYA', 'BOS'), t('32', '20300710', 'bairj001', 'BOS', 'NYA'))
  const g = R.groupRows(rows)
  const reg = indexRegisterByRetro(REG, new Set(['smitj001', 'jonea001', 'nix-j001', 'bairj001']))
  const out = buildCandidates(g, resolveAll(rows, reg, NOBAI), { from: 2030, to: 2030, declarations: DECL, keys: KEYS, batchKey: 'rs-test' })
  assert.equal(out.doc.records.length, 3)
  const tri = out.doc.records.find((r) => r.external_ids[0].id === '30@20300601')
  assert.deepEqual(tri.packages.map((p) => `${p.from}>${p.to}`), ['LAD>SEA', 'NYY>LAD', 'SEA>NYY'])
  const a = out.doc.records.find((r) => r.external_ids[0].id === '31@20300710'); const b = out.doc.records.find((r) => r.external_ids[0].id === '32@20300710')
  assert.deepEqual(a.distinct_from, ['RETROSHEET_TXN:32@20300710'])
  assert.deepEqual(b.distinct_from, ['RETROSHEET_TXN:31@20300710'])
})

test('candidates are deterministic: the same rows in any order give the same document', () => {
  const rows = [t('10', '20300601', 'smitj001', 'LAN', 'SEA'), t('10', '20300601', 'jonea001', 'SEA', 'LAN'), t('11', '20300602', 'nix-j001', 'NYA', 'BOS'), t('11', '20300602', 'bairj001', 'BOS', 'NYA')]
  const a = stage(parse(...rows)); const b = stage(parse(...[...rows].reverse()))
  assert.deepEqual(a.candidates, b.candidates)
  assert.equal(JSON.stringify(a.doc.records.map((r) => r.external_ids)), JSON.stringify(b.doc.records.map((r) => r.external_ids)))
})

// ---- reconciliation with BAI's existing trades ----
const bai = (txs) => ({ transactions: txs.map((x, i) => ({ id: x.id ?? i + 1, date: x.date, date_precision: 'DAY', packages: x.packages })) })
const asset = (mlbam) => ({ asset_type: 'PLAYER', player_id: Number(mlbam), mlbam: String(mlbam), name: `p${mlbam}` })
const recon = (rows, snapshot, resolvedMap = null) => { const g = R.groupRows(rows); return reconcileTrades(g, resolvedMap ?? resolvedFor(rows), snapshot, { from: 2030, to: 2030 }) }

test('reconciliation: confirmed, possible, disagreement, identity conflict, incomplete and new are told apart; nothing of BAI is replaced', () => {
  const rows = parse(
    t('1', '20300601', 'smitj001', 'LAN', 'SEA'), t('1', '20300601', 'jonea001', 'SEA', 'LAN'),                               // confirmed (BAI #1 same date, shared players, same direction)
    t('2', '20300701', 'nix-j001', 'NYA', 'BOS'), t('2', '20300701', 'bairj001', 'BOS', 'NYA'),                              // possible: BAI #2 same clubs and day, no shared identified player
    t('3', '20300801', 'smitj001', 'SDN', 'SEA'), t('3', '20300801', 'jonea001', 'SEA', 'SDN'),                               // disagreement (date): BAI #3 has the same players ten days later
    t('4', '20300901', 'Some Prospect', 'LAN', 'BOS'), t('4', '20300901', 'jonea001', 'BOS', 'LAN'),                          // incomplete, no BAI counterpart
    t('5', '20301001', 'nix-j001', 'LAN', 'SDN'), t('5', '20301001', 'bairj001', 'SDN', 'LAN'))                               // new
  const snap = bai([
    { id: 101, date: '2030-06-01', packages: [{ from: 'LAD', to: 'SEA', assets: [asset(990001)] }, { from: 'SEA', to: 'LAD', assets: [asset(990002)] }] },
    { id: 102, date: '2030-07-01', packages: [{ from: 'NYY', to: 'BOS', assets: [asset(555555)] }, { from: 'BOS', to: 'NYY', assets: [] }] },
    { id: 103, date: '2030-08-11', packages: [{ from: 'SD', to: 'SEA', assets: [asset(990001)] }, { from: 'SEA', to: 'SD', assets: [asset(990002)] }] }
  ])
  const r = recon(rows, snap)
  const by = Object.fromEntries(r.entries.map((e) => [e.source_id, e]))
  assert.equal(by[1].classification, 'EXISTING_CONFIRMED_MATCH'); assert.equal(by[1].assets_equal, true); assert.deepEqual(by[1].bai_transaction_ids, [101])
  assert.equal(by[2].classification, 'EXISTING_POSSIBLE_MATCH')
  assert.equal(by[3].classification, 'SOURCE_DISAGREEMENT'); assert.equal(by[3].disagreement, 'date'); assert.equal(by[3].evidence.days_apart, 10)
  assert.equal(by[4].classification, 'INCOMPLETE_TRANSACTION'); assert.deepEqual(by[4].retro_hold_reasons, ['NAME_ONLY_PLAYER'])
  assert.equal(by[5].classification, 'NEW_TRANSACTION')
  assert.deepEqual(r.counts, { EXISTING_CONFIRMED_MATCH: 1, EXISTING_POSSIBLE_MATCH: 1, NEW_TRANSACTION: 1, SOURCE_DISAGREEMENT: 1, IDENTITY_CONFLICT: 0, INCOMPLETE_TRANSACTION: 1 })
  assert.deepEqual(snap.transactions.map((t) => t.id), [101, 102, 103], 'BAI ids are only read')
})

test('reconciliation: a player traded again years later is not a disagreement; a direction flip within a month is; identity conflicts are reported with both ids', () => {
  const rows = parse(t('1', '20300601', 'smitj001', 'LAN', 'SEA'), t('1', '20300601', 'jonea001', 'SEA', 'LAN'))
  const later = bai([{ id: 7, date: '2034-01-01', packages: [{ from: 'SEA', to: 'LAD', assets: [asset(990001)] }, { from: 'LAD', to: 'SEA', assets: [asset(990002)] }] }])
  assert.equal(recon(rows, later).entries[0].classification, 'NEW_TRANSACTION')
  const flipped = bai([{ id: 8, date: '2030-06-05', packages: [{ from: 'SEA', to: 'LAD', assets: [asset(990001)] }, { from: 'LAD', to: 'SEA', assets: [asset(990002)] }] }])
  const f = recon(rows, flipped).entries[0]
  assert.deepEqual([f.classification, f.disagreement], ['SOURCE_DISAGREEMENT', 'direction'])
  const rows2 = parse(t('2', '20300601', 'bairj001', 'LAN', 'SEA'), t('2', '20300601', 'jonea001', 'SEA', 'LAN'))
  const reg = indexRegisterByRetro(REG, new Set(['bairj001', 'jonea001']))
  const conflictBai = { byMlbam: new Map([['990008', { id: 8, retro: 'someone9' }]]), byRetro: new Map() }
  const e = reconcileTrades(R.groupRows(rows2), resolveAll(rows2, reg, conflictBai), bai([]), { from: 2030, to: 2030 }).entries[0]
  assert.equal(e.classification, 'IDENTITY_CONFLICT')
  assert.equal(e.identity_conflicts[0].retro_id, 'bairj001')
})

test('report: deterministic, carries the attribution statement, states what is not known and offers no score or ranking', () => {
  const rows = parse(t('1', '20300601', 'smitj001', 'LAN', 'SEA'), t('1', '20300601', 'jonea001', 'SEA', 'LAN'), row({ id: '2', date: '20300301', player: 'nix-j001', type: 'F ', to: 'NYA', toLg: 'AL' }))
  const g = R.groupRows(rows)
  const inv = R.inventory(rows, g, { from: 2030, to: 2030 })
  const resolved = resolvedFor(rows)
  const states = {}; for (const v of resolved.values()) states[v.state] = (states[v.state] ?? 0) + 1
  const rec = recon(rows, bai([]))
  const input = { archive: { url: R.RETROSHEET_ARCHIVE.url, sha256: 'c'.repeat(64), bytes: 10, retrieved_at: '2026-10-22', tran_sha256: 'd'.repeat(64), tran_rows: 3, tran_columns: 16, last_record_date: '20300601', zip_entry_modified: '2030-01-01T00:00', limits: ['a limit'] },
    inventory: inv, identity: { states, repeat: repeatActivity(g, resolved) }, reconciliation: rec, candidates: { candidates: 1, holds: 0, hold_reasons: {} }, bai: { war_players: 0, attributions: 0 }, from: 2030, to: 2030 }
  const a = renderReport(input); const b = renderReport(JSON.parse(JSON.stringify(input)))
  assert.equal(a, b)
  assert.ok(a.includes(R.RETROSHEET_ATTRIBUTION))
  assert.match(a, /no front-office score or ranking/)
  assert.match(a, /\*\*not\*\* a census/)
  assert.doesNotMatch(a, /\bgrade[sd]?\b|\bleaderboard\b/i)
  assert.match(a, /Contract, salary and cost data for these transactions: none/)
})
