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
  assert.deepEqual(f, ['DUPLICATE_PICK_NUMBER', 'PICK_NUMBER_GAPS', 'UNKNOWN_TEAM'].sort())
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
