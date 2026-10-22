// 2020 reconciliation helpers: evidence comparison, article links, Wikidata lookups by Q-id and MLB id, career narrowing.
// Offline; nothing touches the network or a database.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEvidenceRows, compareLists, compareSchools } from '../../scripts/history/lib/evidence-compare.mjs'
import { linkTitle } from '../../scripts/history/lib/wikipedia-draft.mjs'
import { pagePropsUrl, pagePropsKey, parsePageProps, qidQuery, parseQidResults, mlbamQuery } from '../../scripts/history/lib/wikidata.mjs'
import { narrowByCareer, decideIdentity, chadwickCandidates, candidatesFor } from '../../scripts/history/lib/identity-2020.mjs'

const picks = [
  { overall_pick: 1, name: 'Ann Able', franchise: 'DET', school_label: 'Arizona State' },
  { overall_pick: 2, name: 'Bo Baker', franchise: 'TEX', school_label: 'Jesuit High School, OR' },
  { overall_pick: 3, name: 'Cy Carter', franchise: 'ATH', school_label: 'Dallas Baptist' },
  { overall_pick: 4, name: 'Di Dunn', franchise: 'NYM', school_label: 'NC State' }
]

test('evidence rows parse strictly and comparisons report every disagreement without resolving it', () => {
  assert.throws(() => parseEvidenceRows('1|only|three'), /expected pick\|club\|player\|school/)
  const rows = parseEvidenceRows('# comment\n1|Detroit Tigers|Ann Able|Arizona State\n2|Texas Rangers|Beau Baker|Jesuit HS (Ore)\n3|Oakland Athletics|Cy Carter|San Jose State\n5|New York Mets|Extra Person|Nowhere\n')
  const r = compareLists(picks, rows)
  assert.deepEqual(r.summary, { picks: 4, evidence_rows: 4, agree: 1, disagree: 2, absent: 1, evidence_only: 1 })
  const kinds = r.findings.map((f) => `${f.pick}:${f.kind}`).sort()
  assert.deepEqual(kinds, ['2:GIVEN_NAME_DIFFERS', '3:SCHOOL_DIFFERS', '4:NOT_IN_EVIDENCE', '5:NOT_IN_RECONSTRUCTION'])
  assert.deepEqual(r.clubs.DET, { picks: 1, agree: 1, disagree: 0, absent: 0 })
})

test('a different club or spelling of the surname is a finding', () => {
  const r = compareLists([picks[0]], parseEvidenceRows('1|Texas Rangers|Ann Abel|Arizona State'))
  assert.deepEqual(r.findings.map((f) => f.kind).sort(), ['CLUB_DIFFERS', 'SURNAME_SPELLING_DIFFERS'])
})

test('school comparison tolerates abbreviations and state tails but not different schools', () => {
  assert.equal(compareSchools('NC State', 'North Carolina State'), 'SAME')
  assert.equal(compareSchools('Mount Carmel High School, IL', 'Mt. Carmel HS (Ill.)'), 'SAME')
  assert.equal(compareSchools('St. Joseph High School, CA', 'San Jose State'), 'DIFFERENT')
  assert.equal(compareSchools('', 'Duke'), 'UNKNOWN')
})

test('article links: sortname with its disambiguator, piped links, plain text', () => {
  assert.equal(linkTitle('!scope="row" style="x"|{{sortname|Max|Meyer| dab=baseball}}'), 'Max Meyer (baseball)')
  assert.equal(linkTitle('!scope="row"|{{sortname|Ann|Able}}'), 'Ann Able')
  assert.equal(linkTitle('!scope="row"|{{sortname|Ann|Able|nolink=1}}'), null)
  assert.equal(linkTitle('!scope="row"|[[Logan Allen (baseball, born 1998)|Logan Allen]]'), 'Logan Allen (baseball, born 1998)')
  assert.equal(linkTitle('!scope="row"|Ben Hernandez'), null)
})

test('page properties resolve titles through normalisation and redirects, and refuse oversize requests', () => {
  const j = { query: { normalized: [{ from: 'ann able', to: 'Ann able' }], redirects: [{ from: 'Ann able', to: 'Ann Able' }], pages: [{ title: 'Ann Able', pageprops: { wikibase_item: 'Q42' } }, { title: 'Nobody', missing: true }, { title: 'Bare' }] } }
  const m = parsePageProps(j)
  assert.equal(m.get('ann able'), 'Q42')
  assert.equal(m.get('Ann Able'), 'Q42')
  assert.equal(m.has('Nobody'), false)
  assert.equal(m.has('Bare'), false)
  assert.throws(() => pagePropsUrl(Array.from({ length: 51 }, (_, i) => `T${i}`)), /1 to 50/)
  assert.match(pagePropsKey(['A', 'B']), /^wikipedia\/pageprops-[0-9a-f]{16}\.json$/)
  assert.ok(pagePropsUrl(['A', 'B']).includes('titles=A%7CB'))
})

test('Q-id and MLB-id queries validate their inputs and group results by person', () => {
  assert.throws(() => qidQuery(['Q1; DROP']), /not a Q-id/)
  assert.throws(() => mlbamQuery(['12"3']), /not an MLB id/)
  assert.ok(qidQuery(['Q1', 'Q2']).includes('wd:Q1 wd:Q2'))
  const rows = parseQidResults({ results: { bindings: [
    { p: { value: 'http://www.wikidata.org/entity/Q1' }, label: { value: 'Ann Able' }, mlb: { value: '9' }, schoolLabel: { value: 'Arizona State University' } },
    { p: { value: 'http://www.wikidata.org/entity/Q1' }, label: { value: 'Ann Able' }, schoolLabel: { value: 'Tempe HS' } }
  ] } })
  assert.deepEqual(rows.get('Q1').educated_at, ['Arizona State University', 'Tempe HS'])
  assert.equal(rows.get('Q1').mlbam, '9')
})

const csv = (rows) => 'key_person,key_uuid,key_mlbam,key_retro,key_bbref,key_bbref_minors,key_fangraphs,key_wikidata,name_last,name_first,name_given,name_suffix,birth_year,birth_month,birth_day,pro_played_first,mlb_played_first,col_played_first,col_played_last\n' + rows.join('\n') + '\n'
const cand = (rows, name, schoolType) => {
  const idx = chadwickCandidates(csv(rows), { minBirth: 1994, maxBirth: 2004 })
  return candidatesFor(name, idx, { draftYear: 2020 })
}

test('career narrowing keeps one consistent candidate, shows every elimination, and never guesses between two', () => {
  const rows = [
    'a,u,111,,,,,,Brown,Tyler,Tyler,,1998,10,2,2021,,2018,2020',   // consistent college career
    'b,u,,,,,,,Brown,Tyler,Tyler,,1996,6,2,,,2016,2018',            // no MLBAM id, no pro start, college ended long ago
    'c,u,113,,,,,,Brown,Tyler,Tyler,,1996,10,3,2021,,2019,2020'     // also consistent
  ]
  const all = cand(rows, 'Tyler Brown')
  assert.equal(all.length, 3)
  const two = narrowByCareer(all, { schoolType: 'COLLEGE', draftYear: 2020 })
  assert.equal(two.narrowed, false, 'two consistent candidates: nothing is narrowed')
  const one = narrowByCareer(all.filter((c) => c.key_person !== 'c'), { schoolType: 'COLLEGE', draftYear: 2020 })
  assert.equal(one.narrowed, true)
  assert.deepEqual(one.kept.map((c) => c.key_person), ['a'])
  assert.match(one.eliminated[0].reason, /no MLBAM id/)
  const hs = narrowByCareer(cand(['a,u,111,,,,,,Doe,Jo,Jo,,2002,1,1,2021,,,', 'b,u,112,,,,,,Doe,Jo,Jo,,2000,1,1,2021,,2019,2020'], 'Jo Doe'), { schoolType: 'HIGH_SCHOOL', draftYear: 2020 })
  assert.deepEqual(hs.kept.map((c) => c.key_person), ['a'], 'a high-school pick cannot have college seasons before the draft')
})

test('a namesake link never overrides the register tie, and a verified identity reports the conflict', () => {
  const [c] = cand(['a,u,111,,,,Q7,,Able,Ann,Anne,,1999,2,3,2021,,2018,2020'], 'Ann Able')
  const w = (o) => ({ qid: 'Q9', mlbam: null, birth_date: null, bbref: null, retrosheet: null, drafted: [], ...o })
  const namesake = w({ qid: 'Q1', label: 'Ann Able' })
  const baseball = w({ qid: 'Q2', mlbam: '111' })
  const r = decideIdentity([c], [baseball], namesake)
  assert.equal(r.status, 'VERIFIED')
  assert.equal(r.wikidata.qid, 'Q2')
  assert.ok(!r.basis.includes('ARTICLE_LINK'))
  assert.match(r.link_conflict, /different Wikidata item/)
  const tied = decideIdentity([c], [], w({ qid: 'Q2', mlbam: '111' }))
  assert.ok(tied.basis.includes('ARTICLE_LINK'))
  assert.equal(tied.link_conflict, null)
  assert.equal(decideIdentity([c], [], namesake).status, 'SINGLE_SOURCE', 'a link to an unrelated item confirms nothing')
})

test('school comparison needs equal token sets: a state school is not the school it shares a word with', async () => {
  const { compareSchools: cmp } = await import('../../scripts/history/lib/evidence-compare.mjs')
  assert.equal(cmp('Michigan', 'Michigan State'), 'DIFFERENT')
  assert.equal(cmp('Oklahoma State', 'Oklahoma'), 'DIFFERENT')
  assert.equal(cmp('Ole Miss', 'Mississippi'), 'SAME')
  assert.equal(cmp('Ole Miss', 'Mississippi State'), 'DIFFERENT')
  assert.equal(cmp('McLennan Community College', 'McLennan CC'), 'SAME')
  assert.equal(cmp('Le Moyne', 'LeMoyne College'), 'SAME')
})

test('club codes outlets print are normalised, and an unknown code is a finding', () => {
  const p = [{ overall_pick: 1, name: 'Ann Able', franchise: 'ATH', school_label: 'Duke' }, { overall_pick: 2, name: 'Bo Baker', franchise: 'CWS', school_label: 'Duke' }, { overall_pick: 3, name: 'Cy Carter', franchise: 'SF', school_label: 'Duke' }]
  const r = compareLists(p, parseEvidenceRows('1|OAK|Ann Able|Duke\n2|CHW|Bo Baker|Duke\n3|ZZZ|Cy Carter|Duke'))
  assert.deepEqual(r.findings.map((f) => `${f.pick}:${f.kind}`), ['3:CLUB_DIFFERS'])
})

test('printed initials match their dotted form, and career reasons name each failure', async () => {
  const { compareNames } = await import('../../scripts/history/lib/retrosheet.mjs')
  assert.equal(compareNames('AJ Vukovich', 'A. J. Vukovich'), 'EXACT')
  assert.equal(compareNames('RJ Dabovich', 'R. J. Dabovich'), 'EXACT')
  assert.equal(compareNames('Mac Wainwright', 'Mackenzie Wainwright'), 'SAME_SURNAME_COMPATIBLE_FIRST')
  assert.equal(compareNames('Jesse Franklin V', 'Jesse Franklin'), 'EXACT')
  const { careerReasons } = await import('../../scripts/history/lib/identity-2020.mjs')
  const [c] = cand(['a,u,,,,,,,Doe,Jo,Jo,,1999,1,1,,,2015,2016'], 'Jo Doe')
  const why = careerReasons(c, { schoolType: 'COLLEGE', draftYear: 2020 })
  assert.equal(why.length, 3)
  assert.match(why.join(' | '), /no MLBAM id.*no professional start.*college record does not end at the draft/)
})
