// Non-trade acquisition records and the Retrosheet adapter (scripts/research/lib/acquisitions.mjs, retrosheet-acquisitions.mjs). FICTIONAL rows.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as R from '../../scripts/research/lib/retrosheet-transactions.mjs'
import { indexRegisterByRetro, resolveAll } from '../../scripts/research/lib/retrosheet-identity.mjs'
import { sourceDeclarations, sourceKeys } from '../../scripts/research/lib/retrosheet-adapter.mjs'
import { buildAcquisitionCandidates, recordKind, acquisitionHoldReasons, voidIndex } from '../../scripts/research/lib/retrosheet-acquisitions.mjs'
import { validateAcquisition, batchProblemsAcquisitions, prepareAcquisitionText, ACQUISITION_CLASSES } from '../../scripts/research/lib/acquisitions.mjs'
import { validateRecordShape } from '../../scripts/research/lib/import-format.mjs'

const q = (f) => f.map((v) => `"${v}"`).join(',')
const row = (o) => q([o.date, '', o.approx ?? '', '', '', o.id, o.player ?? '', o.type, o.from ?? '', o.fromLg ?? '', o.to ?? '', o.toLg ?? '', '', '', '', o.info ?? ''])
const lg = { LAN: 'NL', SEA: 'AL', NYA: 'AL', BOS: 'AL' }
const r = (id, date, player, type, from, to, extra = {}) => row({ id, date, player, type, from: from ?? '', fromLg: from ? (lg[from] ?? '(Atlantic)') : '', to: to ?? '', toLg: to ? lg[to] : '', ...extra })
const parse = (...rows) => R.parseTran(rows.join('\n') + '\n')
const HEAD = 'key_person,key_uuid,key_mlbam,key_retro,key_bbref,key_bbref_minors,key_fangraphs,key_npb,key_sr_nfl,key_sr_nba,key_sr_nhl,key_wikidata,name_last,name_first,name_given,name_suffix,name_matrilineal,name_nick,birth_year,birth_month,birth_day,death_year,death_month,death_day,pro_played_first,pro_played_last,mlb_played_first,mlb_played_last'
const people = [[1, 'smitj001', 'Smith', 'John'], [2, 'jonea001', 'Jones', 'Al'], [3, 'nix-j001', 'Nix', 'Jay'], [4, 'bairj001', 'Baird', 'Jim'], [5, 'cruzc001', 'Cruz', 'Carl'], [6, 'dunnd001', 'Dunn', 'Dan'], [7, 'badnm001', 'Different', 'Person']]
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-acq-'))
after(() => fs.rmSync(dir, { recursive: true, force: true }))
for (const s of '0123456789abcdef') fs.writeFileSync(path.join(dir, `people-${s}.csv`), HEAD + '\n' + (s === '0' ? people.map(([n, id, l, f]) => `k${n},u${n},${990000 + n},${id},,,,,,,,,${l},${f},,,,,1990,5,17,,,,2010,2020,2012,2020`).join('\n') + '\n' : ''))
const KEYS = sourceKeys('c'.repeat(64), '781c175')
const DECL = sourceDeclarations({ archiveSha256: 'c'.repeat(64), retrievedOn: '2026-10-22', registerCommit: '781c175', registerCommitFull: '781c175e748b89e5730fd3f5de0086b9355b2f92', registerRetrievedOn: '2026-10-21' })
const build = (rows) => {
  const groups = R.groupRows(rows)
  const resolved = resolveAll(rows, indexRegisterByRetro(dir, new Set(rows.filter((x) => x.player.kind === 'RETROSHEET_ID').map((x) => x.player.retro_id))), { byMlbam: new Map(), byRetro: new Map() })
  return { groups, resolved, out: buildAcquisitionCandidates(groups, resolved, { from: 2030, to: 2030, declarations: DECL, keys: KEYS, batchKey: 'acq-test' }) }
}

test('genuine acquisitions are staged; departures, voids, returns, roster status and draft selections are classified and never staged', () => {
  const rows = parse(
    r('1', '20300110', 'smitj001', 'F ', null, 'LAN'), r('2', '20300111', 'jonea001', 'Fa', null, 'SEA'), r('3', '20300112', 'nix-j001', 'W ', 'LAN', 'SEA'),
    r('4', '20300113', 'bairj001', 'P ', 'Long Island', 'NYA'), r('5', '20300114', 'cruzc001', 'D ', 'BOS', 'LAN'),
    r('6', '20300115', 'dunnd001', 'Fg', 'LAN', null), r('7', '20300116', 'smitj001', 'R ', 'LAN', null), r('8', '20300117', 'jonea001', 'Da', null, 'BOS'),
    r('9', '20300118', 'nix-j001', 'Hi', 'LAN', null), r('10', '20300119', 'bairj001', 'Wr', 'SEA', 'LAN'), r('11', '20300120', 'cruzc001', 'Fc', null, 'BOS'))
  const { groups, out } = build(rows)
  assert.equal(out.candidates, 5)
  assert.deepEqual(out.doc.records.map((x) => x.transaction_type).sort(), ['AMATEUR_FREE_AGENT_SIGNING', 'FREE_AGENT_SIGNING', 'PURCHASE', 'RULE_5', 'WAIVER_CLAIM'])
  const kinds = groups.map(recordKind)
  assert.deepEqual(kinds.filter((k) => k.startsWith('NOT_AN_ACQUISITION')).sort(), ['NOT_AN_ACQUISITION:departure', 'NOT_AN_ACQUISITION:departure', 'NOT_AN_ACQUISITION:draft_selection', 'NOT_AN_ACQUISITION:return', 'NOT_AN_ACQUISITION:roster_status'])
  assert.ok(kinds.some((k) => k.startsWith('OTHER:FREE_AGENT_COMPENSATION_PICK')), 'a compensation pick is not a signing')
  assert.equal(R.ACQUISITION_CLASS.FREE_AGENT_COMPENSATION_PICK, undefined)
  assert.ok(!out.doc.records.some((x) => x.move.source_event_code === 'Da'), 'a draft selection is never reinterpreted as a signing')
  const purchase = out.doc.records.find((x) => x.acquisition_class === 'PURCHASE')
  assert.deepEqual([purchase.move.from_organization, purchase.move.from_club_text], [null, 'Long Island (Atlantic)'])
  const waiver = out.doc.records.find((x) => x.acquisition_class === 'WAIVER')
  assert.deepEqual([waiver.move.from_organization, waiver.move.to_organization, waiver.move.source_event_code], ['LAD', 'SEA', 'W'])
  for (const rec of out.doc.records) {
    const v = validateRecordShape(rec, 'ACQUISITIONS', new Set(DECL.map((s) => s.source_key)))
    assert.deepEqual(v.errors, [], rec.ref)
    assert.deepEqual(rec.sources.map((s) => [s.role, s.independence_group]), [['REFERENCE', 'retrosheet-archive']], 'one lineage')
  }
})

test('holds: name only, approximate or partial date, mismatched id, wrong club shape, a signing the source itself voids', () => {
  const hold = (...rows) => build(parse(...rows)).out.holds.map((h) => h.reasons).flat()
  assert.deepEqual(hold(r('1', '20300110', 'Some Prospect', 'F ', null, 'LAN')), ['NAME_ONLY_PLAYER'])
  assert.deepEqual(hold(r('2', '20300110', 'smitj001', 'F ', null, 'LAN', { approx: '@' })), ['DATE_APPROXIMATE'])
  assert.deepEqual(hold(r('3', '20300100', 'smitj001', 'F ', null, 'LAN')), ['DATE_MONTH_ONLY'])
  assert.deepEqual(hold(r('4', '20300110', 'badnm001', 'F ', null, 'LAN')), ['IDENTITY_ID_NAME_PATTERN_MISMATCH'])
  assert.deepEqual(hold(r('5', '20300110', 'zzzzz001', 'F ', null, 'LAN')), ['IDENTITY_NOT_IN_REGISTER'])
  assert.deepEqual(hold(r('6', '20300110', 'smitj001', 'F ', 'SEA', 'LAN')), ['UNEXPECTED_FROM_TEAM'])
  assert.deepEqual(hold(r('7', '20300110', 'smitj001', 'W ', 'Long Island', 'LAN')), ['FROM_NOT_AN_MLB_CLUB'])
  assert.deepEqual(hold(r('8', '20300110', 'smitj001', 'P ', null, 'LAN')), ['PURCHASE_WITHOUT_SELLER'])
  assert.deepEqual(hold(r('9', '20300110', 'smitj001', 'F ', null, 'Long Island')), ['ACQUIRER_NOT_AN_MLB_CLUB'])
  assert.deepEqual(hold(r('10', '20300110', 'smitj001', 'F ', null, 'LAN'), r('11', '20300301', 'smitj001', 'Fv', null, 'LAN')), ['VOIDED_BY_SOURCE_ROW'])
  const ok = build(parse(r('12', '20300110', 'smitj001', 'F ', null, 'LAN'), r('13', '20290301', 'smitj001', 'Fv', null, 'LAN'))).out
  assert.equal(ok.candidates, 1, 'a void dated before the signing does not hold it')
})

test('the record validator names what is wrong; batch rules catch a duplicated acquisition', () => {
  const { out } = build(parse(r('1', '20300110', 'smitj001', 'F ', null, 'LAN')))
  const base = out.doc.records[0]
  const shape = (rec) => { const e = []; validateAcquisition(rec, e, [], (k) => { if (!DECL.some((s) => s.source_key === k)) e.push(`undeclared ${k}`) }); return e }
  assert.deepEqual(shape(base), [])
  const mut = (f) => { const c = JSON.parse(JSON.stringify(base)); f(c); return shape(c) }
  assert.ok(mut((c) => { c.acquisition_class = 'DRAFT' }).some((m) => /not acquisitions/.test(m)), 'a draft selection is not an acquisition class')
  assert.ok(mut((c) => { c.move.source_event_code = 'Fg' }).some((m) => /not a FREE_AGENT code/.test(m)), 'a departure code is refused')
  assert.ok(mut((c) => { c.move.from_organization = 'SEA' }).some((m) => /no from-club/.test(m)))
  assert.ok(mut((c) => { c.move.player.external_ids = {} }).some((m) => /MLBAM/.test(m)))
  assert.ok(mut((c) => { c.date_precision = 'MONTH' }).some((m) => /day-precise/.test(m)))
  assert.ok(mut((c) => { c.organization = 'SEA' }).some((m) => /acquiring club/.test(m)))
  assert.ok(mut((c) => { c.transaction_type = 'PURCHASE' }).some((m) => /is transaction_type FREE_AGENT_SIGNING/.test(m)))
  assert.ok(mut((c) => { c.sources[0].independence_group = '' }).some((m) => /independence_group/.test(m)))
  const dup = JSON.parse(JSON.stringify(base)); dup.external_ids = [{ scheme: 'RETROSHEET_TXN', id: 'other', source_key: base.source_key }]
  assert.equal(batchProblemsAcquisitions([base, dup]).size, 1, 'the same player, club, day and type twice')
  assert.equal(Object.keys(ACQUISITION_CLASSES).length, 5)
})

test('preparing is deterministic and the source note is kept verbatim, never parsed', () => {
  const rows = parse(r('2', '20300111', 'jonea001', 'P ', 'Long Island', 'SEA', { info: '$' }), r('1', '20300110', 'smitj001', 'F ', null, 'LAN'))
  const a = build(rows).out.doc
  const b = build(parse(...[r('1', '20300110', 'smitj001', 'F ', null, 'LAN'), r('2', '20300111', 'jonea001', 'P ', 'Long Island', 'SEA', { info: '$' })])).out.doc
  const bare = (d) => prepareAcquisitionText(d).replace(/tran\.txt line \d+/g, 'tran.txt line N')   // the locator is the row's line in the file, which is the input order
  assert.equal(bare(a), bare(b))
  assert.equal(a.records.find((x) => x.acquisition_class === 'PURCHASE').move.source_info, '$')
  assert.doesNotMatch(JSON.stringify(a), /"(amount|salary|contract|bonus|years|service)/i)
})

test('voidIndex keys by player and club', () => {
  const rows = parse(r('1', '20300301', 'smitj001', 'Fv', null, 'LAN'))
  assert.equal(voidIndex(R.groupRows(rows)).get('smitj001|LAD'), '20300301')
  assert.ok(typeof acquisitionHoldReasons === 'function')
})
