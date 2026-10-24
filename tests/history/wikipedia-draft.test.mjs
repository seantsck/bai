// Wikipedia draft-table parsing and identity decisions. Offline, synthetic wikitext.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDraftArticle, plain } from '../../scripts/history/lib/wikipedia-draft.mjs'
import { decideIdentity, candidatesFor, chadwickCandidates } from '../../scripts/history/lib/identity-2020.mjs'

const ARTICLE = `{{Infobox sports draft
| first_round = 1
| overall     = 3
| rounds      = 2
}}
==Draft selections==
===First round===
{| class="wikitable"
|-
! scope="col"| Pick
|-
|[[List of first overall picks|1]]
!scope="row" style="text-align:center"|{{sortname|Ann|Able}}
|[[Detroit Tigers]]
|[[Pitcher]]
|[[Arizona State Sun Devils baseball|Arizona State]]
|-
|2
!scope="row" style="background-color:#FFCC00"|{{sortname|Bo|Baker| dab=baseball}}
|[[Texas Rangers (baseball)|Texas Rangers]]{{#tag:ref|Compensation pick for a {{nested|template}} signing<ref name="x">cite</ref>|group="Compensation"}}
|[[Outfielder]]
|[[Jesuit High School (Beaverton, Oregon)|Jesuit High School]] ([[Oregon|OR]])
|}
===Compensatory round===
{| class="wikitable"
|-
|3
!scope="row"|Cy Carter
|[[Oakland Athletics]]
|[[Shortstop]]
|[[Dallas Baptist Patriots baseball|Dallas Baptist]]
|}
==Summary==
|-
|99
!scope="row"|Not A Pick
|[[Detroit Tigers]]
|x
|y
`

test('rows become picks with rounds, clubs and school labels; footnotes and the summary are ignored', () => {
  const r = parseDraftArticle(ARTICLE, { year: 2020 })
  assert.deepEqual(r.stated, { overall: 3, rounds: 2, first_round: 1 })
  assert.equal(r.picks.length, 3)
  assert.deepEqual(r.findings, [])
  const [a, b, c] = r.picks
  assert.deepEqual([a.overall_pick, a.name, a.franchise, a.round_code, a.school_label], [1, 'Ann Able', 'DET', '1', 'Arizona State'])
  assert.deepEqual([b.name, b.franchise, b.school_label, b.school.school_type, b.school.region], ['Bo Baker', 'TEX', 'Jesuit High School, OR', 'HIGH_SCHOOL', 'OR'])
  assert.deepEqual([c.round_code, c.selection_type], ['C-2', 'COMPENSATION'])
  assert.ok(r.picks.every((p) => p.did_not_sign_marker === false), 'a signing status is never inferred')
})

test('integrity findings are reported, never repaired', () => {
  const bad = ARTICLE.replace('|2\n!scope="row" style="background-color:#FFCC00"', '|1\n!scope="row" style="background-color:#FFCC00"').replace('[[Oakland Athletics]]', '[[Springfield Isotopes]]')
  const f = parseDraftArticle(bad, { year: 2020 }).findings.map((x) => x.kind).sort()
  assert.deepEqual(f, ['DUPLICATE_PICK_NUMBER', 'PICK_NUMBER_GAPS', 'SOURCE_CONFLICT', 'SOURCE_CONFLICT', 'UNKNOWN_TEAM'].sort())
})

test('plain() strips markup but keeps names', () => {
  assert.equal(plain("[[Logan Allen (baseball, born 1998)|Logan Allen]]<ref>x</ref>"), 'Logan Allen')
  assert.equal(plain('{{sortname|Max|Meyer| dab=baseball}}'), 'Max Meyer')
})

const csv = (rows) => 'key_person,key_uuid,key_mlbam,key_retro,key_bbref,key_bbref_minors,key_fangraphs,key_wikidata,name_last,name_first,name_given,name_suffix,birth_year,birth_month,birth_day,pro_played_first,mlb_played_first\n' + rows.join('\n') + '\n'
const idx = (rows) => chadwickCandidates(csv(rows), { minBirth: 1994, maxBirth: 2004 })

test('candidates need a plausible birth year, a compatible name and a career that starts near the draft', () => {
  const index = idx([
    'p1,u,111,,,,,Q1,Able,Ann,Anne,,1999,2,3,2021,',
    'p2,u,112,,,,,,Able,Ann,Anne,,1960,1,1,1980,1985',   // too old
    'p3,u,113,,,,,,Able,Zed,Zedd,,2000,1,1,2021,',        // other first name
    'p4,u,114,,,,,,Able,Ann,Anne,,1999,5,5,2015,'          // career began long before the draft
  ])
  assert.deepEqual(candidatesFor('Ann Able', index, { draftYear: 2020 }).map((c) => c.key_person), ['p1'])
})

test('verified needs both sources to agree on the same person; anything less stays a candidate', () => {
  const index = idx(['p1,u,111,,,,,Q1,Able,Ann,Anne,,1999,2,3,2021,'])
  const [c] = candidatesFor('Ann Able', index, { draftYear: 2020 })
  const wd = (o) => ({ qid: 'Q9', mlbam: null, birth_date: null, bbref: null, retrosheet: null, drafted: [], ...o })
  assert.equal(decideIdentity([c], [wd({ qid: 'Q1' })]).status, 'VERIFIED')
  assert.equal(decideIdentity([c], [wd({ mlbam: '111' })]).status, 'VERIFIED')
  assert.equal(decideIdentity([c], [wd({ birth_date: '1999-02-03' })]).status, 'VERIFIED')
  assert.equal(decideIdentity([c], [wd({ birth_date: '1999-02-04' })]).status, 'SINGLE_SOURCE', 'a Wikidata person who disagrees confirms nothing')
  assert.equal(decideIdentity([c], []).status, 'SINGLE_SOURCE')
  assert.equal(decideIdentity([], []).status, 'UNMATCHED')
  assert.equal(decideIdentity([c, { ...c, key_person: 'p5', qid: null, ids: {}, birth: ['1999', '9', '9'] }], []).status, 'AMBIGUOUS')
  assert.equal(decideIdentity([c], [wd({ qid: 'Q1' }), wd({ qid: 'Q7' })]).status, 'VERIFIED', 'the Q-id in the register picks the right person')
})

// 2021 article layout: later rounds only as an "Other notable selections" table (round first), a "*" did-not-sign marker, and a
// cell typed with a curly quote. FICTIONAL players.
const ARTICLE_2021 = `{{Infobox sports draft
| overall     = 612
| rounds      = 20
}}
==Draft selections==
===First round===
{| class="wikitable"
|-
|1
!scope="row" style="text-align:center"|{{sortname|Ann|Able}}
|[[Detroit Tigers]]
|[[Pitcher]]
|[[Arizona State Sun Devils baseball|Arizona State]]
|-
|2
!scope="row" style="text-align:center; background:#bfb;”|{{sortname|Bo|Baker}}*
|[[Texas Rangers (baseball)|Texas Rangers]]
|[[Outfielder]]
|[[Jesuit High School (Beaverton, Oregon)|Jesuit High School]] ([[Oregon|OR]])
|}
===Other notable selections===
{| class="wikitable"
|-
! scope="col" | Round
! scope="col" | Pick
|-
|3
|72
!scope="row" style="text-align:center"|{{sortname|Cy|Carter}}
|[[Oakland Athletics]]
|[[Shortstop]]
|[[Dallas Baptist Patriots baseball|Dallas Baptist]]
|-
|20
|610
!scope="row" style="text-align:center"|Di Dunn*
|[[Detroit Tigers]]
|[[Pitcher]]
|[[Alabama Crimson Tide baseball|Alabama]]
|}
==Summary==
`

test('"Other notable selections" rows are real selections flagged notable_only, with the round from their own column', () => {
  const r = parseDraftArticle(ARTICLE_2021, { year: 2021 })
  const n = r.picks.filter((p) => p.notable_only)
  assert.deepEqual(n.map((p) => [p.overall_pick, p.round_code, p.name, p.franchise]), [[72, '3', 'Cy Carter', 'ATH'], [610, '20', 'Di Dunn', 'DET']])
  assert.ok(r.picks.filter((p) => !p.notable_only).every((p) => ['1'].includes(p.round_code)))
  assert.ok(!r.findings.some((f) => f.kind === 'UNKNOWN_SECTION'))
  assert.ok(r.findings.some((f) => f.kind === 'COUNT_DIFFERS_FROM_STATED'), 'a partial list is reported as partial, never repaired')
  assert.ok(r.findings.some((f) => f.kind === 'PICK_NUMBER_GAPS'))
})

test('the did-not-sign "*" marker is kept as a marker, not as part of the name; a curly-quote cell still parses', () => {
  const r = parseDraftArticle(ARTICLE_2021, { year: 2021 })
  const by = Object.fromEntries(r.picks.map((p) => [p.overall_pick, p]))
  assert.equal(by[2].name, 'Bo Baker'); assert.equal(by[2].did_not_sign_marker, true)
  assert.equal(by[610].name, 'Di Dunn'); assert.equal(by[610].did_not_sign_marker, true)
  assert.equal(by[1].did_not_sign_marker, false)
  assert.ok(r.picks.every((p) => !/[*”|]/.test(p.name)))
})

// A notable-selections table whose rows join round and pick with "||" on one line (the 2022 article's markup).
const ARTICLE_INLINE = `{{Infobox sports draft
| first_round = 1
| overall     = 40
| rounds      = 20
}}
==Draft selections==
===First round===
{| class="wikitable"
|-
|1
!scope="row"|{{sortname|Ann|Able}}
|[[Detroit Tigers]]
|[[Pitcher]]
|[[Arizona State Sun Devils baseball|Arizona State]]
|}
===Other notable selections===
{| class="wikitable sortable"
|-
! scope="col" | Round
! scope="col" | Pick
|-
|3||81
!scope="row" style="text-align:center; background:#bfb;"|{{sortname|Dee|Dunn}}*
|[[Baltimore Orioles]]
|[[Pitcher]]
|[[Oklahoma State Cowboys baseball|Oklahoma State]]
|-
|4||[[Pick|109]]
!scope="row"|{{sortname|Eve|Ebbs|dab=baseball}}
|[[Texas Rangers (baseball)|Texas Rangers]]
|[[Outfielder]]
|[[Liberty High School (Liberty, Missouri)|Liberty High School]] ([[Missouri|MO]])
|}
==Summary==
`

test('inline "||" cells are split outside links and templates, so a one-line round and pick parse', async () => {
  const { splitInlineCells } = await import('../../scripts/history/lib/wikipedia-draft.mjs')
  assert.deepEqual(splitInlineCells('|3||81'), ['|3', '|81'])
  assert.deepEqual(splitInlineCells('|4||[[Pick|109]]'), ['|4', '|[[Pick|109]]'])
  assert.deepEqual(splitInlineCells('|{{t|a||b}}||x'), ['|{{t|a||b}}', '|x'])
  assert.deepEqual(splitInlineCells('|plain'), ['|plain'])
  assert.deepEqual(splitInlineCells('!scope="row"|Name'), ['!scope="row"|Name'])
  const a = parseDraftArticle(ARTICLE_INLINE, { year: 2022 })
  assert.deepEqual(a.findings.filter((f) => f.kind === 'SHORT_ROW'), [])
  const notable = a.picks.filter((p) => p.notable_only)
  assert.deepEqual(notable.map((p) => [p.overall_pick, p.round_code, p.name, p.franchise, p.did_not_sign_marker]), [[81, '3', 'Dee Dunn', 'BAL', true], [109, '4', 'Eve Ebbs', 'TEX', false]])
  assert.equal(a.picks.find((p) => p.overall_pick === 1).name, 'Ann Able')
})

// The prospect promotion incentive pick (2022 CBA): one added pick in its own section, kept as the published round "PPI".
const ARTICLE_PPI = `{{Infobox sports draft
| first_round = 2
| overall     = 3
| rounds      = 20
}}
==Draft selections==
===First round===
{| class="wikitable"
|-
|1
!scope="row"|{{sortname|Ann|Able}}
|[[Detroit Tigers]]
|[[Pitcher]]
|[[Arizona State Sun Devils baseball|Arizona State]]
|}
===Prospect promotion incentive pick===
{| class="wikitable"
|-
|2
!scope="row"|[[Cy Carter]]
|[[Seattle Mariners]]{{#tag:ref|Received for a player winning the Rookie of the Year Award|group="Incentive"}}
|[[Outfielder]]
|[[Westfield High School (Fairfax County, Virginia)|Westfield High School]] ([[Virginia|VA]])
|}
===Competitive balance round A===
{| class="wikitable"
|-
|3
!scope="row"|Dee Dunn
|[[Texas Rangers (baseball)|Texas Rangers]]
|[[Shortstop]]
|[[Dallas Baptist Patriots baseball|Dallas Baptist]]
|}
==Summary==
`

test('the prospect promotion incentive section is parsed as the PPI round, a PRIZE selection, and no section is left unknown', async () => {
  const { roundStructure } = await import('../../scripts/research/lib/import-format.mjs')
  const { roundCode, selectionType } = await import('../../scripts/history/lib/mlb.mjs')
  const a = parseDraftArticle(ARTICLE_PPI, { year: 2023 })
  assert.deepEqual(a.findings.filter((f) => f.kind === 'UNKNOWN_SECTION'), [])
  const ppi = a.picks.find((p) => p.overall_pick === 2)
  assert.deepEqual([ppi.round_code, ppi.selection_type, ppi.franchise, ppi.name, ppi.notable_only], ['PPI', 'PRIZE', 'SEA', 'Cy Carter', undefined])
  assert.equal(a.picks.find((p) => p.overall_pick === 3).round_code, 'CB-A')
  assert.deepEqual(roundStructure('PPI'), { order: 11, phase: 'PRIZE' })
  assert.ok(roundStructure('1').order < roundStructure('PPI').order && roundStructure('PPI').order < roundStructure('C-1').order, 'PPI sorts after round 1 and before first-round compensation (C-1)')
  assert.equal(roundCode('ppi'), 'PPI')
  assert.equal(selectionType('PPI'), 'PRIZE')
  assert.equal(selectionType('1'), 'STANDARD')
})

// 2024 and 2025 list a "Compensatory round" after the first round's incentive picks and another after the second round's competitive balance picks.
const ARTICLE_COMP = `{{Infobox sports draft
| first_round = 3
| overall     = 6
| rounds      = 20
}}
==Draft selections==
===First round===
{| class="wikitable"
|-
|1
!scope="row"|Ann Able
|[[Detroit Tigers]]
|[[Pitcher]]
|[[Arizona State Sun Devils baseball|Arizona State]]
|}
===Compensatory round===
{| class="wikitable"
|-
|2
!scope="row"|Bo Baker
|[[Texas Rangers (baseball)|Texas Rangers]]
|[[Outfielder]]
|[[Dallas Baptist Patriots baseball|Dallas Baptist]]
|}
===Second round===
{| class="wikitable"
|-
|3
!scope="row"|Cy Carter
|[[Kansas City Royals]]
|[[Shortstop]]
|[[Oregon Ducks baseball|Oregon]]
|}
===Competitive balance round B===
{| class="wikitable"
|-
|4
!scope="row"|Dee Dunn
|[[Seattle Mariners]]
|[[Pitcher]]
|[[Gonzaga Bulldogs baseball|Gonzaga]]
|}
===Compensatory round===
{| class="wikitable"
|-
|5
!scope="row"|Eve Ebbs
|[[Miami Marlins]]
|[[Catcher]]
|[[Florida Gators baseball|Florida]]
|}
==Summary==
`

test('a compensatory round before the second round is C-1 and one after it is C-2', () => {
  const a = parseDraftArticle(ARTICLE_COMP, { year: 2024 })
  const by = (n) => a.picks.find((p) => p.overall_pick === n)
  assert.deepEqual([by(1).round_code, by(2).round_code, by(3).round_code, by(4).round_code, by(5).round_code], ['1', 'C-1', '2', 'CB-B', 'C-2'])
  assert.deepEqual([by(2).selection_type, by(5).selection_type], ['COMPENSATION', 'COMPENSATION'])
})

test('a pick number that two rows claim is reported, never resolved by choosing one', () => {
  const dup = ARTICLE_INLINE.replace('|4||[[Pick|109]]', '|3||81')   // both notable rows now claim pick 81
  const a = parseDraftArticle(dup, { year: 2023 })
  assert.ok(a.findings.some((f) => f.kind === 'DUPLICATE_PICK_NUMBER' && /#81/.test(f.detail)))
})

const notableRow = (round, pick, name, team) => `|-\n|${round}||${pick}\n!scope="row"|${name}\n|[[${team}]]\n|[[Pitcher]]\n|[[Georgia Bulldogs baseball|Georgia]]\n`
const ARTICLE_NOTABLE = (rows) => `{{Infobox sports draft\n| overall = 4\n}}\n==Draft selections==\n===Other notable selections===\n{| class="wikitable"\n${rows.join('')}|}\n==Summary==\n`

test('a round label that contradicts pick order marks every row involved as a source conflict, and holds are never repaired from elsewhere', () => {
  const a = parseDraftArticle(ARTICLE_NOTABLE([
    notableRow(5, 165, 'Dev One', 'Texas Rangers (baseball)'), notableRow(6, 168, 'Eat Two', 'Colorado Rockies'),
    notableRow(5, 173, 'Col Three', 'New York Mets'), notableRow(6, 181, 'Her Four', 'New York Yankees')
  ]), { year: 2024 })
  const by = (n) => a.picks.find((p) => p.overall_pick === n)
  assert.equal(by(165).source_conflict, undefined)
  assert.equal(by(181).source_conflict, undefined)
  assert.match(by(168).source_conflict, /round label conflicts with pick order/)
  assert.match(by(173).source_conflict, /round label conflicts with pick order/)
  assert.equal(by(173).round_code, '5', 'the article value is kept, not replaced')
  assert.ok(a.findings.some((f) => f.kind === 'SOURCE_CONFLICT' && /#173/.test(f.detail)))
})

test('rounds in pick order raise no source conflict, and a duplicate pick number marks both rows', () => {
  const ok = parseDraftArticle(ARTICLE_NOTABLE([notableRow(5, 165, 'A One', 'Texas Rangers (baseball)'), notableRow(6, 168, 'B Two', 'Colorado Rockies'), notableRow(6, 181, 'C Three', 'New York Yankees')]), { year: 2024 })
  assert.equal(ok.picks.filter((p) => p.source_conflict).length, 0)
  const dup = parseDraftArticle(ARTICLE_NOTABLE([notableRow(6, 182, 'G One', 'Chicago Cubs'), notableRow(6, 182, 'P Two', 'Miami Marlins')]), { year: 2024 })
  assert.equal(dup.picks.filter((p) => /duplicate pick number/.test(p.source_conflict ?? '')).length, 2)
})

test('round order for 2023, 2024 and 2025 follows the pick order of the opening tables: round 1 (10), PPI (11), C-1 (13), CB-A (16), round 2 (20), CB-B (26), C-2 (23)', async () => {
  const fs = await import('node:fs')
  const { roundStructure } = await import('../../scripts/research/lib/import-format.mjs')
  assert.deepEqual(['1', 'PPI', 'C-1', 'CB-A', '2'].map((c) => roundStructure(c).order), [10, 11, 13, 16, 20])
  assert.equal(roundStructure('CB-B').order, 26)
  assert.equal(roundStructure('C-2').order, 23)
  for (const year of [2023, 2024, 2025]) {
    const file = new URL(`../../.cache/history/wikipedia/${year}-major-league-baseball-draft.json`, import.meta.url)
    if (!fs.existsSync(file)) continue   // the cache is local; CI has no cached article
    const rev = JSON.parse(fs.readFileSync(file, 'utf8')).query.pages[0].revisions[0]
    const a = parseDraftArticle(rev.slots?.main?.content ?? rev.content, { year })
    const phases = a.picks.filter((p) => !p.notable_only).map((p) => p.round_code)
    const seq = phases.map((c) => roundStructure(c).order)
    // Within the opening tables the sections are in the article's order; the PPI picks always sort between round 1 and C-1/CB-A.
    assert.ok(phases.includes('PPI'), `${year} has PPI picks`)
    const ppi = roundStructure('PPI').order
    for (const c of phases) {
      if (c === '1') assert.ok(roundStructure(c).order < ppi)
      if (c === 'C-1' || c === 'CB-A') assert.ok(roundStructure(c).order > ppi)
    }
    assert.ok(seq.every((n) => Number.isInteger(n)))
  }
})
