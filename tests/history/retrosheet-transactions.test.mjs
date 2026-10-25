// Retrosheet transaction parser, classifier and grouper (scripts/research/lib/retrosheet-transactions.mjs). The rows below are
// FICTIONAL, written in the archive's documented format (readme.txt); the real archive is local and gitignored.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import * as R from '../../scripts/research/lib/retrosheet-transactions.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const line = (f) => f.map((v) => `"${v}"`).join(',')
// date,time,approx,secondary,secApprox,id,player,type,fromTeam,fromLeague,toTeam,toLeague,draftType,round,pick,info
const row = (o) => line([o.date ?? '20300101', o.time ?? '', o.approx ?? '', o.sec ?? '', o.secApprox ?? '', o.id ?? '1', o.player ?? '', o.type ?? 'T ', o.from ?? '', o.fromLg ?? '', o.to ?? '', o.toLg ?? '', o.dt ?? '', o.round ?? '', o.pick ?? '', o.info ?? ''])
const parse = (...rows) => R.parseTran(rows.join('\n') + '\n')

test('dates: day, month-only, preseason and approximate keep their precision and never become exact', () => {
  const d = (t, a = '') => R.parseRetroDate(t, a)
  assert.deepEqual([d('20300715').precision, d('20300715').iso], ['DAY', '2030-07-15'])
  assert.deepEqual([d('20300700').precision, d('20300700').iso, d('20300700').month, d('20300700').day], ['MONTH', null, 7, null])
  assert.deepEqual([d('20300000').precision, d('20300000').iso, d('20300000').year], ['PRESEASON', null, 2030])
  assert.equal(d('20300715', '@').approximate, true)
  assert.equal(d('20300715', '@').precision, 'DAY', 'a guess is flagged, not downgraded')
  assert.equal(d('20300230').precision, 'INVALID', 'an impossible date is invalid, not repaired')
  assert.equal(d('20301300').precision, 'INVALID')
  assert.equal(d('2030').precision, 'INVALID')
})

test('rows keep every raw field, the line number and a hash; the time code orders same-day rows', () => {
  const [a, b] = parse(row({ id: '10', player: 'smitj001', type: 'F ', to: 'LAN', toLg: 'NL', time: '1' }), row({ id: '11', player: 'jonea001', type: 'F ', to: 'LAN', toLg: 'NL', time: '2' }))
  assert.equal(a.line, 1); assert.equal(b.line, 2)
  assert.equal(a.raw.length, 16)
  assert.match(a.row_sha256, /^[0-9a-f]{64}$/)
  assert.deepEqual([a.time_meaning, b.time_meaning], ['BETWEEN_GAMES', 'AFTER_GAMES'])
  assert.equal(a.type_raw, 'F ', 'the original code, trailing space included, is preserved')
  assert.equal(a.type, 'F')
})

test('type codes: every documented code is mapped, categories and flows are explicit, unknown codes are flagged and never corrected', () => {
  const documented = 'A C Cr D Da Df Dm Dn Dr Ds Dv F Fa Fb Fc Fg Fo Fv Hb Hbr Hd Hdr Hf Hfr Hh Hhr Hi Hir Hm Hmr Hs Hsr Hu Hur Hv Hvr J Jr L Lr M Mr P Pr Pv R T Tn Tp Tr Tv U Vg V W Wf Wr Wv X Xe Xm Xp Xr Z Zr'.split(' ')
  for (const c of documented) assert.ok(R.TYPE_CODES[c], `${c} is documented in readme.txt`)
  assert.equal(Object.keys(R.TYPE_CODES).length, documented.length)
  const [blank, upper, fg] = parse(row({ type: '' }), row({ type: 'FG' }), row({ type: 'Fg' }))
  assert.deepEqual([blank.category, blank.flags], ['UNCLASSIFIED', ['BLANK_TYPE_CODE']])
  assert.deepEqual([upper.category, upper.flags, upper.type], ['UNCLASSIFIED', ['UNKNOWN_TYPE_CODE'], 'FG'], '"FG" is not silently read as "Fg"')
  assert.deepEqual([fg.category, fg.flow], ['FREE_AGENT_GRANTED', 'DEPARTED'])
  assert.equal(R.TYPE_CODES.Fg.category in R.ACQUISITION_CLASS, false, 'a free agent granted is a departure, not an acquisition')
  assert.deepEqual(['T', 'Tp', 'C', 'F', 'Fa', 'W', 'P', 'D', 'Da', 'R'].map((c) => R.ACQUISITION_CLASS[R.TYPE_CODES[c].category] ?? 'NONE'), ['TRADE', 'TRADE', 'TRADE', 'FREE_AGENT', 'AMATEUR_FREE_AGENT', 'WAIVER', 'PURCHASE', 'RULE_5', 'DRAFT', 'NONE'])
})

test('players and teams: ids, name-only minor leaguers and empty players; MLB codes, independent clubs and unmapped codes', () => {
  const [a, b, c, d, e, f] = parse(
    row({ player: 'smitj001', type: 'F ', to: 'LAN', toLg: 'NL' }), row({ player: 'nix-j001', type: 'F ', to: 'NYA', toLg: 'AL' }), row({ player: 'Daniel Rosenbaum', type: 'Fa', to: 'SEA', toLg: 'AL' }),
    row({ player: '', type: 'T ', from: 'SEA', fromLg: 'AL', to: 'LAN', toLg: 'NL', info: '$' }), row({ player: 'adlet001', type: 'P ', from: 'Long Island', fromLg: '(Atlantic)', to: 'DET', toLg: 'AL' }),
    row({ player: 'smitj001', type: 'F ', to: 'WS9', toLg: 'AL' }))
  assert.deepEqual([a.player.kind, b.player.kind, c.player.kind, d.player.kind], ['RETROSHEET_ID', 'RETROSHEET_ID', 'NAME_ONLY', 'NONE'])
  assert.equal(b.player.retro_id, 'nix-j001', 'a hyphen pads a short surname')
  assert.deepEqual([a.to.kind, a.to.franchise, e.from.kind, e.from.name, f.to.kind], ['MLB', 'LAD', 'NAMED_CLUB', 'Long Island', 'UNMAPPED_MLB_CODE'])
  assert.ok(f.flags.includes('UNMAPPED_TEAM_CODE'))
})

test('the info field: a closed vocabulary only, no dollar amount is ever read, anything else stays text', () => {
  const k = (s) => R.classifyInfo(s).map((a) => a.kind)
  assert.deepEqual(R.classifyInfo('$'), [{ kind: 'CASH', amount: 'UNKNOWN', text: '$' }], '"$" is money sent, amount not stated')
  assert.deepEqual(k('player to be named or cash'), ['PTBNL'])
  assert.equal(R.classifyInfo('player to be named or cash')[0].condition_text, 'player to be named or cash')
  assert.deepEqual(k('cash and a player to be named'), ['CASH', 'PTBNL'])
  assert.deepEqual(k('international bonus slot money'), ['INTERNATIONAL_POOL_SPACE'])
  assert.deepEqual(k('2019 competitive balance round B pick'), ['DRAFT_PICK'])
  assert.deepEqual(k('$500,000'), ['OTHER_TEXT'], 'an amount in text is not parsed')
  assert.deepEqual(k('0'), ['OTHER_TEXT'], 'a bare 0 is not "zero cash"')
  assert.deepEqual(k('Ronald Roman (minors)'), ['OTHER_TEXT'], 'a name in the info field is not an identified player')
  assert.deepEqual(k('future considerations'), ['OTHER_TEXT'])
  assert.deepEqual(k(''), [])
  for (const a of ['$', 'player to be named', 'international bonus slot money']) assert.equal(R.classifyInfo(a).every((x) => !('amount_usd' in x)), true)
})

test('grouping: trade rows sharing an id are one transaction (later-dated members kept and flagged); other ids are not unique', () => {
  const rows = parse(
    row({ date: '20300601', id: '500', player: 'aaaaa001', type: 'T ', from: 'LAN', fromLg: 'NL', to: 'SEA', toLg: 'AL' }),
    row({ date: '20300601', id: '500', player: 'bbbbb001', type: 'T ', from: 'SEA', fromLg: 'AL', to: 'LAN', toLg: 'NL' }),
    row({ date: '20300601', id: '500', player: '', type: 'T ', from: 'SEA', fromLg: 'AL', to: 'LAN', toLg: 'NL', info: '$' }),
    row({ date: '20300915', id: '500', player: 'ccccc001', type: 'T ', from: 'SEA', fromLg: 'AL', to: 'LAN', toLg: 'NL' }),
    // the same id on unrelated free-agent rows years apart
    row({ date: '19790130', id: '600', player: 'ddddd001', type: 'F ', to: 'BAL', toLg: 'AL' }), row({ date: '20131117', id: '600', player: 'eeeee001', type: 'F ', to: 'KCA', toLg: 'AL' }),
    // two unrelated same-day trades between the same clubs, different ids
    row({ date: '20300710', id: '700', player: 'fffff001', type: 'T ', from: 'NYA', fromLg: 'AL', to: 'BOS', toLg: 'AL' }), row({ date: '20300710', id: '700', player: 'ggggg001', type: 'T ', from: 'BOS', fromLg: 'AL', to: 'NYA', toLg: 'AL' }),
    row({ date: '20300710', id: '701', player: 'hhhhh001', type: 'T ', from: 'NYA', fromLg: 'AL', to: 'BOS', toLg: 'AL' }), row({ date: '20300710', id: '701', player: 'iiiii001', type: 'T ', from: 'BOS', fromLg: 'AL', to: 'NYA', toLg: 'AL' }))
  const groups = R.groupRows(rows)
  const t500 = groups.find((g) => g.source_id === '500')
  assert.equal(t500.rows.length, 4)
  assert.equal(t500.key, '500@20300601')
  assert.deepEqual(t500.directions, ['LAD>SEA', 'SEA>LAD'])
  assert.ok(t500.flags.includes('LATER_DATED_MEMBERS'))
  assert.equal(t500.date.text, '20300601', 'the group is dated by its earliest member')
  const fas = groups.filter((g) => g.source_id === '600')
  assert.equal(fas.length, 2, 'free-agent rows with a repeated id stay separate')
  assert.notEqual(fas[0].key, fas[1].key)
  assert.match(fas[0].key, /^600@19790130#[0-9a-f]{8}$/)
  const same = groups.filter((g) => g.date.text === '20300710')
  assert.equal(same.length, 2)
  assert.notEqual(same[0].key, same[1].key)
  assert.deepEqual(same.map((g) => g.category), ['TRADE', 'TRADE'])
})

test('malformed rows are kept raw, flagged, and never grouped with real transactions', () => {
  const rows = R.parseTran(['"20300101","","","","","9","x","F ","","","BAL","AL","","",""', row({ id: '10', player: 'smitj001', type: 'F ', to: 'BAL', toLg: 'AL' })].join('\n') + '\n')
  assert.deepEqual([rows[0].malformed, rows[0].flags], [true, ['MALFORMED_ROW']])
  const g = R.groupRows(rows)
  assert.equal(g[0].family, 'MALFORMED')
  assert.equal(g[1].family, 'SINGLE')
})

test('groups flag what is incomplete: one direction, minor-league party, name-only players, free text, month-only dates, voids', () => {
  const g = (rows) => R.groupRows(parse(...rows))[0]
  assert.ok(g([row({ id: '1', player: 'aaaaa001', type: 'T ', from: 'LAN', fromLg: 'NL', to: 'SEA', toLg: 'AL' })]).flags.includes('ONE_DIRECTION_ONLY'))
  assert.ok(g([row({ id: '2', player: 'aaaaa001', type: 'T ', from: 'LAN', fromLg: 'NL', to: 'Texas', toLg: '(American Association)' })]).flags.includes('NON_MLB_PARTY'))
  assert.ok(g([row({ id: '3', player: 'Some Prospect', type: 'T ', from: 'LAN', fromLg: 'NL', to: 'SEA', toLg: 'AL' })]).flags.includes('NAME_ONLY_PLAYER'))
  assert.ok(g([row({ id: '4', player: '', type: 'T ', from: 'LAN', fromLg: 'NL', to: 'SEA', toLg: 'AL', info: 'future considerations' })]).flags.includes('FREE_TEXT_ASSET'))
  assert.ok(g([row({ id: '5', date: '20300700', player: 'aaaaa001', type: 'T ', from: 'LAN', fromLg: 'NL', to: 'SEA', toLg: 'AL' })]).flags.includes('DATE_MONTH_ONLY'))
  assert.ok(g([row({ id: '6', player: 'aaaaa001', type: 'Tv', from: 'LAN', fromLg: 'NL', to: 'SEA', toLg: 'AL' })]).flags.includes('VOID_RETURN_OR_REFUSAL_MEMBER'))
  assert.equal(g([row({ id: '7', player: 'aaaaa001', type: 'C ', from: 'LAN', fromLg: 'NL', to: 'SEA', toLg: 'AL' })]).category, 'CONDITIONAL_TRADE')
})

test('inventory: separate counts for raw rows, ids, groups, trades, classes, seasons and clubs', () => {
  const rows = parse(
    row({ date: '20310601', id: '1', player: 'aaaaa001', type: 'T ', from: 'LAN', fromLg: 'NL', to: 'SEA', toLg: 'AL' }), row({ date: '20310601', id: '1', player: 'bbbbb001', type: 'T ', from: 'SEA', fromLg: 'AL', to: 'LAN', toLg: 'NL' }),
    row({ date: '20310210', id: '2', player: 'ccccc001', type: 'F ', to: 'LAN', toLg: 'NL' }), row({ date: '20311030', id: '3', player: 'ccccc001', type: 'Fg', from: 'LAN', fromLg: 'NL' }),
    row({ date: '20320101', id: '4', player: 'ddddd001', type: 'R ', from: 'SEA', fromLg: 'AL' }), row({ date: '20330101', id: '5', player: 'ddddd001', type: 'R ', from: 'SEA', fromLg: 'AL' }))
  const inv = R.inventory(rows, R.groupRows(rows), { from: 2031, to: 2032 })
  assert.equal(inv.raw_records, 5)
  assert.equal(inv.unique_source_transaction_ids, 4)
  assert.equal(inv.groups, 4)
  assert.equal(inv.trade_groups, 1)
  assert.equal(inv.trade_groups_two_or_more_directions, 1)
  assert.deepEqual(inv.by_class, { TRADE: 1, FREE_AGENT: 1, NOT_AN_ACQUISITION: 2 })
  assert.deepEqual(inv.by_season, { 2031: 3, 2032: 1 })
  assert.equal(inv.by_season_club_category['2031|LAD|TRADE'], 2)
  assert.equal(inv.by_club.LAD, 4)
})

test('attribution: the archive description carries the exact Retrosheet statement', () => {
  assert.equal(R.RETROSHEET_ATTRIBUTION, 'The information used here was obtained free of charge from and is copyrighted by Retrosheet. Interested parties may contact Retrosheet at "www.retrosheet.org".')
  assert.equal(R.RETROSHEET_ARCHIVE.attribution, R.RETROSHEET_ATTRIBUTION)
})

test('the real archive, when cached locally, matches its recorded checksum and parses with no malformed row', { skip: !fs.existsSync(path.join(root, '.local/retrosheet/trandb.zip')) }, () => {
  const zip = fs.readFileSync(path.join(root, '.local/retrosheet/trandb.zip'))
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'research/history/manifest.json'), 'utf8'))
  assert.equal(crypto.createHash('sha256').update(zip).digest('hex'), manifest.entries['retrosheet/trandb.zip'].sha256)
  const rows = R.parseTran(fs.readFileSync(path.join(root, '.local/retrosheet/extracted/tran.txt'), 'utf8'))
  assert.equal(rows.length, 101594)
  assert.equal(rows.filter((r) => r.malformed).length, 0)
  const inv = R.inventory(rows, R.groupRows(rows), { from: 2015, to: 2020 })
  assert.equal(inv.raw_records, 13253)
  assert.equal(inv.unique_source_transaction_ids, 11836)
})
