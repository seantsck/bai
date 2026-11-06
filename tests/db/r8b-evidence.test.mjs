// R8B evidence packages: a research PROPOSAL is never a verification, categories follow from the host, independence is never confirmed by a proposal, nothing unresolved is dropped,
// no source text is stored, and the files stay private and outside git. FICTIONAL clubs, players, ids and URLs throughout (example.org / example.com are reserved names).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { assertComplete, assessRights, categoryOfUrl, classifySource, grantActive, newPackage, parseQueueIds, readiness, savePackage, triageRows, validatePackage, writePackages } from '../../scripts/research/lib/r8b-evidence.mjs'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')
const tx = (o = {}) => ({ id: 9001, season: 2099, date: '2099-06-01', clubs: ['AAA', 'BBB'], external_ids: ['00001@20990601'], created_on: '2099-06-02',
  assets: [{ position: 1, from_key: 'AAA', to_key: 'BBB', kind: 'PLAYER', player_name: 'Fictional One', detail: null, conditional: false, condition_text: null, amount_status: null, resolution_kind: null },
    { position: 2, from_key: 'BBB', to_key: 'AAA', kind: 'PLAYER', player_name: 'Fictional Two', detail: null, conditional: false, condition_text: null, amount_status: null, resolution_kind: null }],
  origin_sources: [{ position: 1, role: 'RECORD', independence_group: null, category: 'RETROSHEET' }], ...o })
const TODAY = '2099-06-04'
const cand = (id, url, o = {}) => ({ id, url, title: 'Fictional release', publisher: 'Example Club', role: 'CORROBORATION', locator: 'section 2', retrieved_on: '2099-06-03', found_by: 'HUMAN',
  rights: assessRights(url, { license: o.license, authorization: o.authorization, today: o.today ?? TODAY }),
  independence: { assessment: 'LIKELY_INDEPENDENT', group: 'club-release-aaa', lineage_note: 'first-hand club release; not derived from the origin' }, ...Object.fromEntries(Object.entries(o).filter(([k]) => !['license', 'authorization', 'today'].includes(k))) })
const V = (p, o = {}) => validatePackage(p, { today: TODAY, ...o })
const withCand = (c, cover = 'PROPOSED_CORROBORATED') => { const p = newPackage(tx()); p.candidates = [c]; for (const r of [...p.corroboration.packages, ...p.corroboration.assets]) { r.status = cover; r.candidate_ids = [c.id] } return p }

test('a new package is a well-formed proposal: everything UNRESOLVED, no candidates, nothing verified, and the open work is listed', () => {
  const p = newPackage(tx()); assert.deepEqual(V(p), []); assert.equal(p.kind, 'RESEARCH_PROPOSAL'); assert.equal(p.human_verification, null)
  assert.ok([...p.corroboration.packages, ...p.corroboration.assets].every((r) => r.status === 'UNRESOLVED'))
  assert.ok(readiness(p).includes('NO_PRIMARY_ANNOUNCEMENT_CANDIDATE') && readiness(p).includes('ASSET_1_UNRESOLVED') && readiness(p).includes('PACKAGE_AAA>BBB_UNRESOLVED'))
})

test('the source category follows from the identified source and cannot be declared; restricted categories carry the display consequence', () => {
  assert.equal(categoryOfUrl('https://www.mlb.com/news/x'), 'MLB'); assert.equal(categoryOfUrl('https://www.baseball-reference.com/x'), 'BASEBALL_REFERENCE'); assert.equal(categoryOfUrl('https://en.wikipedia.org/wiki/X'), 'WIKIPEDIA')
  assert.equal(categoryOfUrl('https://news.example.com/a'), 'OTHER_PUBLICATION')
  const relabel = withCand(cand('c1', 'https://www.mlb.com/news/x', { rights: { category: 'WIKIPEDIA', status: 'DISPLAY_CLEARED', display_consequence: 'NONE', identity: { basis: 'HOST_LABEL', rule_id: null }, assessed_on: TODAY } }))
  assert.match(V(relabel).join(), /follows from the identified source \(MLB\); it cannot be declared as WIKIPEDIA/)
  const blocked = withCand(cand('c1', 'https://news.example.com/a')); assert.deepEqual(V(blocked), []); assert.ok(readiness(blocked).includes('RIGHTS_BLOCKED_c1'))
  const bad = withCand(cand('c1', 'https://news.example.com/a')); bad.candidates[0].rights.display_consequence = 'NONE'; assert.match(V(bad).join(), /display_consequence must be WITHDRAWN_UNTIL_PERMITTED/)
  const open = withCand(cand('c1', 'https://news.example.com/a')); open.candidates[0].rights.status = 'DISPLAY_CLEARED'; assert.match(V(open).join(), /rights status is NEEDS_PERMISSION/)
})

test('arbitrary GitHub repositories and look-alike hosts are never an openly licensed source; unknown sources need permission review', () => {
  for (const u of ['https://github.com/someone/else', 'https://github.com/someone/register', 'https://github.com/chadwickbureau-fake/register', 'https://github.com/other/chadwickbureau/register', 'https://raw.githubusercontent.com/chadwickbureau/register/main/x',
    'https://chadwick-bureau.com.evil.example/x', 'https://wikipedia.org.evil.example/wiki/X', 'https://en.wikipedia.org.evil.example/wiki/X', 'https://en.wikipedia.org/w/index.php?title=X', 'https://www.wikidata.org/w/api.php', 'https://gist.github.com/chadwickbureau/register']) {
    const r = assessRights(u, { license: { spdx: 'CC0-1.0', evidence_url: u, checked_on: TODAY, checked_by: 'HUMAN' } }); assert.equal(r.category, 'OTHER_PUBLICATION', u); assert.equal(r.status, 'NEEDS_PERMISSION', u); assert.equal(r.identity.basis, 'UNKNOWN', u)
  }
  const unknownWithGrant = assessRights('https://news.example.com/a', { authorization: { grants: [{ category: 'OTHER_PUBLICATION', expires_on: 'NONE' }] }, today: TODAY }); assert.equal(unknownWithGrant.status, 'NEEDS_PERMISSION', 'a category-wide grant does not clear an unreviewed publisher')
  const gh = withCand(cand('c1', 'https://github.com/someone/else')); gh.candidates[0].rights = { category: 'CHADWICK_REGISTER', status: 'DISPLAY_CLEARED', display_consequence: 'NONE', identity: { basis: 'HOST_LABEL', rule_id: null }, assessed_on: TODAY }
  assert.match(V(gh).join(), /cannot be declared as CHADWICK_REGISTER/)
})

test('a verified Chadwick source needs its identity (exact repository) AND recorded licence evidence; Wikimedia sources carry the sitewide licence', () => {
  const url = 'https://github.com/chadwickbureau/register/blob/master/data/people.csv'; const lic = { spdx: 'CC-BY-4.0', evidence_url: 'https://github.com/chadwickbureau/register/blob/master/LICENSE', checked_on: TODAY, checked_by: 'HUMAN' }
  const noLic = assessRights(url, { today: TODAY }); assert.equal(noLic.category, 'CHADWICK_REGISTER'); assert.equal(noLic.status, 'NEEDS_PERMISSION'); assert.match(noLic.reason, /licence evidence/)
  const ok = assessRights(url, { license: lic, today: TODAY }); assert.equal(ok.status, 'DISPLAY_CLEARED'); assert.equal(ok.identity.rule_id, 'chadwick-register-repository'); assert.equal(ok.license.spdx, 'CC-BY-4.0')
  for (const [why, l] of [['not an open licence', { ...lic, spdx: 'LicenseRef-proprietary' }], ['evidence is a data page, not a licence file', { ...lic, evidence_url: url }], ['a future check date', { ...lic, checked_on: '2999-01-01' }], ['evidence on another repository', { ...lic, evidence_url: 'https://github.com/someone/else/blob/x/LICENSE' }], ['checked by a script', { ...lic, checked_by: 'SCRIPT' }], ['no date', { ...lic, checked_on: 'yesterday' }]]) assert.equal(assessRights(url, { license: l, today: TODAY }).status, 'NEEDS_PERMISSION', why)
  assert.equal(classifySource('https://en.wikipedia.org/wiki/X').rule.id, 'wikipedia-article'); assert.equal(assessRights('https://en.wikipedia.org/wiki/X', { today: TODAY }).status, 'DISPLAY_CLEARED')
  const derived = { independence: { assessment: 'LIKELY_DERIVED', group: 'chadwick', lineage_note: 'register is built from several sources including the origin' } }; const pk = withCand(cand('c1', url, { license: lic, ...derived }), 'PARTIAL'); assert.deepEqual(V(pk), []); const none = withCand(cand('c1', url, derived), 'PARTIAL'); assert.deepEqual(V(none), [], 'without licence evidence the package records NEEDS_PERMISSION'); none.candidates[0].rights.status = 'DISPLAY_CLEARED'; assert.match(V(none).join(), /rights status is NEEDS_PERMISSION/)
})

test('publication grants are read from the CURRENT authorization: absent, withdrawn or expired grants clear nothing, and a package that remembers a grant goes stale', () => {
  const auth = (g) => ({ grants: g }); const today = '2027-01-22'
  assert.equal(assessRights('https://www.retrosheet.org/x', { today }).status, 'NEEDS_PERMISSION', 'no snapshot: no grant is assumed')
  assert.equal(assessRights('https://www.retrosheet.org/x', { authorization: auth([]), today }).status, 'NEEDS_PERMISSION', 'withdrawn: the row is gone')
  assert.equal(assessRights('https://www.retrosheet.org/x', { authorization: auth([{ category: 'RETROSHEET', expires_on: '2027-01-22' }]), today }).status, 'GRANTED', 'valid through its last day')
  assert.equal(assessRights('https://www.retrosheet.org/x', { authorization: auth([{ category: 'RETROSHEET', expires_on: '2027-01-22' }]), today: '2027-01-23' }).status, 'NEEDS_PERMISSION', 'expired')
  assert.equal(assessRights('https://www.mlb.com/x', { authorization: auth([{ category: 'RETROSHEET', expires_on: 'NONE' }]), today }).status, 'NEEDS_PERMISSION', 'a grant for one category clears no other')
  assert.equal(grantActive(auth([{ category: 'MLB', expires_on: 'NONE' }]), 'MLB', today), true, 'an explicitly non-lapsing grant'); assert.equal(grantActive(auth([{ category: 'MLB', expires_on: null }]), 'MLB', today), false, 'an unknown expiry clears nothing'); assert.equal(grantActive(auth([{ category: 'MLB', expires_on: '2027-13-45' }]), 'MLB', today), false, 'a nonsense expiry clears nothing')
  const live = auth([{ category: 'RETROSHEET', expires_on: '2027-01-22' }]); const pk = withCand(cand('c1', 'https://www.retrosheet.org/x', { independence: { assessment: 'LIKELY_DERIVED', group: 'retrosheet-archive', lineage_note: 'origin' }, authorization: live, today, retrieved_on: '2027-01-01' }), 'PARTIAL')
  assert.deepEqual(V(pk, { authorization: live, today }), [], 'valid while the grant is current')
  assert.match(V(pk, { authorization: auth([]), today }).join(), /stale or wrong and must be re-assessed/, 'grant withdrawn after the package was written')
  assert.match(V(pk, { authorization: live, today: '2027-02-01' }).join(), /stale or wrong/, 'grant expired after the package was written')
  assert.match(V(pk, { today }).join(), /stale or wrong/, 'no authorization supplied: nothing is assumed')
})

test('the CLI helpers never silently drop requested records: strict queue parsing and an exact requested-versus-found check', () => {
  const csv = 'rank,tier,transaction_id\n1,P2,10\n2,P2,11\n3,P2,12\n'
  assert.deepEqual(parseQueueIds(csv, 2), [10, 11]); assert.deepEqual(parseQueueIds(csv), [10, 11, 12])
  assert.throws(() => parseQueueIds(csv, 5), /3 rows but 5 were requested/); assert.throws(() => parseQueueIds('a,b\n1,2\n'), /no transaction_id column/)
  assert.throws(() => parseQueueIds('rank,transaction_id\n1,abc\n'), /not a positive integer/); assert.throws(() => parseQueueIds('rank,transaction_id\n1,5\n2,5\n'), /more than once/); assert.throws(() => parseQueueIds('rank,transaction_id\n'), /empty/)
  assert.doesNotThrow(() => assertComplete([10, 11], [{ id: 11 }, { id: 10 }]))
  assert.throws(() => assertComplete([10, 11, 12], [{ id: 10 }, { id: 11 }]), /requested 3 transactions, found 2; missing from the published record: \[12\]/); assert.throws(() => assertComplete([10], [{ id: 10 }, { id: 99 }]), /unexpected: \[99\]/)
})

test('the validate command fails on empty directories, stray or malformed files, mismatched names and stale rights, and it counts honestly', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-r8b-cli-')); const run = (dir, ...a) => spawnSync(process.execPath, ['scripts/research/r8b-evidence.mjs', 'validate', '--dir', dir, '--offline', ...a], { cwd: root, encoding: 'utf8' })
  try {
    const empty = path.join(tmp, 'empty'); fs.mkdirSync(empty); let r = run(empty); assert.equal(r.status, 1); assert.match(r.stderr, /directory is empty/)
    const d = path.join(tmp, 'd'); writePackages([newPackage(tx())], d); r = run(d); assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout).packages_valid, 1); assert.match(r.stdout, /no publication grant is assumed/)
    fs.writeFileSync(path.join(d, 'notes.json'), '{}'); fs.writeFileSync(path.join(d, 'p-9002.json'), '{oops'); fs.copyFileSync(path.join(d, 'p-9001.json'), path.join(d, 'p-9003.json'))
    r = run(d); assert.equal(r.status, 1); assert.match(r.stderr, /notes.json: not an evidence package file/); assert.match(r.stderr, /p-9002.json: not valid JSON/); assert.match(r.stderr, /file name says 9003 but the package is for 9001/)
    const o = JSON.parse(r.stdout); assert.equal(o.files_found, 4); assert.equal(o.packages_valid, 1); assert.equal(o.packages_with_problems, 2); assert.equal(o.other_files, 1)
    assert.equal(run(d, '--grant-expiry', 'bad').status, 2)
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

test('a proposal can never confirm: no human fields, no CORROBORATED / VERIFIED / confirmed independence, unresolved claims are never dropped', () => {
  const ok = withCand(cand('c1', 'https://news.example.com/a')); assert.deepEqual(V(ok), [])
  const h = structuredClone(ok); h.human_verification = { by: 'someone' }; assert.match(V(h).join(), /carries no human verification/)
  const s = structuredClone(ok); s.corroboration.assets[0].status = 'CORROBORATED'; assert.match(V(s).join(), /not a proposal status/)
  const v = structuredClone(ok); v.corroboration.assets[0].status = 'VERIFIED_COMPLETE'; assert.match(V(v).join(), /not a proposal status/)
  const c = structuredClone(ok); c.candidates[0].independence.assessment = 'INDEPENDENT_CONFIRMED'; assert.match(V(c).join(), /a proposal cannot confirm independence/)
  const d = structuredClone(ok); d.corroboration.assets.pop(); assert.match(V(d).join(), /asset 2 has no entry/)
  const e = structuredClone(ok); e.corroboration.packages.pop(); assert.match(V(e).join(), /has no entry/)
  const u = structuredClone(ok); u.corroboration.assets[0].status = 'UNRESOLVED'; assert.match(V(u).join(), /UNRESOLVED cannot cite candidates/)
  const n = structuredClone(ok); n.corroboration.assets[0].candidate_ids = ['nope']; assert.match(V(n).join(), /unknown candidate nope/)
  const k = withCand(cand('c1', 'https://news.example.com/a', { independence: { assessment: 'LIKELY_DERIVED', group: 'x', lineage_note: 'y' } })); assert.match(V(k).join(), /needs at least one LIKELY_INDEPENDENT candidate/)
})

test('independence: the origin and known derived hosts are never independent; independent needs a lineage note and another group', () => {
  assert.match(V(withCand(cand('c1', 'https://www.baseball-reference.com/x'))).join(), /partly derived from the origin/)
  assert.match(V(withCand(cand('c1', 'https://www.retrosheet.org/x'))).join(), /partly derived from the origin/)
  const g = withCand(cand('c1', 'https://news.example.com/a', { independence: { assessment: 'LIKELY_INDEPENDENT', group: 'retrosheet-archive', lineage_note: 'x' } })); assert.match(V(g).join(), /group other than retrosheet-archive/)
  const l = withCand(cand('c1', 'https://news.example.com/a', { independence: { assessment: 'LIKELY_INDEPENDENT', group: 'g' } })); assert.match(V(l).join(), /needs a lineage note/)
  assert.deepEqual(V(withCand(cand('c1', 'https://www.baseball-reference.com/x', { independence: { assessment: 'LIKELY_DERIVED', group: 'sports-ref', lineage_note: 'copies the origin for older years' } }), 'PARTIAL')), [])
})

test('no source text, no invented or unsafe citations: bounded fields, https only, no credentials, real dates, a stated way of finding it', () => {
  const base = () => withCand(cand('c1', 'https://news.example.com/a'))
  const t = base(); t.candidates[0].excerpt = 'copied sentence'; assert.match(V(t).join(), /source text is never stored|unexpected field excerpt/)
  const q = base(); q.candidates[0].quote = 'x'; assert.match(V(q).join(), /source text is never stored|unexpected field quote/)
  const long = base(); long.candidates[0].title = 'x'.repeat(201); assert.match(V(long).join(), /title is required and at most 200/)
  const big = base(); big.unresolved_claims = ['y'.repeat(501)]; assert.match(V(big).join(), /longer than 500/)
  assert.match(V(withCand(cand('c1', 'http://news.example.com/a'))).join(), /must be https/)
  { const w = base(); const u = new URL(w.candidates[0].url); u.username = 'user'; u.password = 'pw'; w.candidates[0].url = u.href; assert.match(V(w).join(), /carries credentials/) }
  { const w = base(); w.candidates[0].url = 'not a url'; assert.match(V(w).join(), /not a valid URL/) }
  assert.match(V(withCand(cand('c1', 'https://news.example.com/a', { retrieved_on: '2099-13-45' }))).join(), /retrieved_on must be a real date/)
  assert.match(V(withCand(cand('c1', 'https://news.example.com/a', { found_by: undefined }))).join(), /found_by must say how|found_by must be text/)
  assert.match(V(withCand(cand('c1', 'https://news.example.com/a', { locator: '' }))).join(), /locator is required/)
  const dup = base(); dup.candidates.push(cand('c1', 'https://news.example.com/b')); assert.match(V(dup).join(), /duplicated/)
})

test('files: written outside git, private, never overwritten; saving into a git work tree is refused; an invalid package is never written', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-r8b-ev-')); try {
    assert.throws(() => writePackages([newPackage(tx())], path.join(root, 'evidence-out')), /inside the git work tree/)
    const out = path.join(tmp, 'pk'); writePackages([newPackage(tx()), newPackage(tx({ id: 9002 }))], out)
    assert.equal(fs.statSync(out).mode & 0o777, 0o700); for (const f of fs.readdirSync(out)) assert.equal(fs.statSync(path.join(out, f)).mode & 0o777, 0o600)
    assert.throws(() => writePackages([newPackage(tx())], out), /already exists/)
    const p = JSON.parse(fs.readFileSync(path.join(out, 'p-9001.json'), 'utf8')); p.human_verification = 'yes'; assert.throws(() => savePackage(out, p), /invalid/)
    const ok = JSON.parse(fs.readFileSync(path.join(out, 'p-9001.json'), 'utf8')); ok.gaps.push({ code: 'X' }); savePackage(out, ok); assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'p-9001.json'), 'utf8')).gaps.length, 1)
    const git = path.join(tmp, 'repo'); fs.mkdirSync(path.join(git, '.git'), { recursive: true }); fs.mkdirSync(path.join(git, 'd')); assert.throws(() => savePackage(path.join(git, 'd'), ok), /inside the git work tree/)
    const bad = newPackage(tx()); bad.kind = 'VERIFICATION'; assert.throws(() => writePackages([bad], path.join(tmp, 'pk2')), /invalid/); assert.equal(fs.existsSync(path.join(tmp, 'pk2', 'p-9001.json')), false)
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

test('PTBNL triage: one row per unresolved player-to-be-named asset with the question to answer, the cash alternative and the priority', () => {
  const a = (position, o) => ({ position, from_key: 'AAA', to_key: 'BBB', kind: 'PLAYER_TO_BE_NAMED', player_name: null, detail: 'player to be named', conditional: true, condition_text: null, amount_status: null, resolution_kind: null, ...o })
  const rows = triageRows([tx({ id: 1, assets: [a(1, {}), { position: 2, from_key: 'BBB', to_key: 'AAA', kind: 'PLAYER', conditional: false }] }), tx({ id: 2, assets: [a(1, { condition_text: 'player to be named or cash' }), { position: 2, from_key: 'BBB', to_key: 'AAA', kind: 'CASH', amount_status: 'UNKNOWN' }] }),
    tx({ id: 3, assets: [a(1, { resolution_kind: 'PLAYER' }), { position: 2, kind: 'PLAYER' }] })])
  assert.deepEqual(rows.map((r) => [r.transaction_id, r.action, r.priority, r.may_resolve_as_cash]), [[1, 'RESOLVE_PLAYER', 'P1A', false], [2, 'RESOLVE_PLAYER_OR_CASH', 'P1B', true]], 'a resolved PTBNL is not in the view')
  assert.match(rows[1].question, /cash/); assert.match(rows[0].identity_task, /separate identity task/)
})

test('the workflow is read-only and offline: no write verbs, forced read-only session, no network client, usage errors exit 2', () => {
  const lib = fs.readFileSync(path.join(root, 'scripts/research/lib/r8b-evidence.mjs'), 'utf8'); const cli = fs.readFileSync(path.join(root, 'scripts/research/r8b-evidence.mjs'), 'utf8')
  assert.match(cli, /default_transaction_read_only=on/); assert.match(cli, /begin isolation level repeatable read read only/); assert.doesNotMatch(lib + cli, /\bfetch\(|node:https?|node:net|axios|XMLHttpRequest/)
  const sql = Object.values(JSON.parse(JSON.stringify({ x: [...lib.matchAll(/`(select [^`]*)`/g)].map((m) => m[1]) })).x); assert.ok(sql.length >= 4); for (const s of sql) assert.doesNotMatch(s, /\b(insert|update|delete|truncate|drop|alter|create|grant)\b/i)
  for (const args of [[], ['bogus'], ['init'], ['validate'], ['triage']]) assert.equal(spawnSync(process.execPath, ['scripts/research/r8b-evidence.mjs', ...args], { cwd: root, encoding: 'utf8' }).status, 2, args.join(' '))
})

const withCredentials = (u) => { const x = new URL(u); x.username = 'user'; x.password = 'pw'; return x.href }
test('review hardening: derived sources by classified identity, trailing dots, ports, credentials, namespaces, closed schema, impossible dates, malformed structure', () => {
  const ind = { assessment: 'LIKELY_INDEPENDENT', group: 'g', lineage_note: 'n' }
  for (const u of ['https://github.com/chadwickbureau/register/blob/x', 'https://www.baseball-reference.com./x', 'https://retrosheet.org./x', 'https://chadwick-bureau.com./x']) {
    const lic = { spdx: 'CC0-1.0', evidence_url: 'https://github.com/chadwickbureau/register/blob/x/LICENSE', checked_on: TODAY, checked_by: 'HUMAN' }
    assert.match(V(withCand(cand('c1', u, { independence: ind, license: lic }))).join(), /partly derived from the origin/, u)
  }
  assert.equal(classifySource('https://www.mlb.com./news/x').category, 'MLB', 'a trailing dot does not escape a restricted label')
  for (const u of ['https://en.wikipedia.org:8443/wiki/X', withCredentials('https://en.wikipedia.org/wiki/X'), 'http://en.wikipedia.org/wiki/X', 'https://en.wikipedia.org/wiki/File:X.jpg', 'https://en.wikipedia.org/wiki/Special:Search', 'https://github.com:8443/chadwickbureau/register']) assert.equal(assessRights(u, { today: TODAY }).status, 'NEEDS_PERMISSION', u)
  const ok = withCand(cand('c1', 'https://news.example.com/a')); assert.deepEqual(V(ok), [])
  for (const [mut, re] of [[(p) => { p.verification_status = 'VERIFIED_COMPLETE' }, /unexpected field verification_status/], [(p) => { p.candidates[0].human_verified = true }, /unexpected field human_verified/], [(p) => { p.candidates[0].rights.reviewed_by = 'x' }, /unexpected field reviewed_by/],
    [(p) => { p.corroboration.assets[0].verified_by = 'x' }, /unexpected field verified_by/], [(p) => { p.gaps = [{ code: 'X', passage: 'copied text' }] }, /unexpected field passage/], [(p) => { p.candidates = [null] }, /must be an object/], [(p) => { p.candidates = {} }, /must be a list/], [(p) => { p.corroboration.assets = [null] }, /must be an object/]]) { const p = structuredClone(ok); mut(p); assert.match(V(p).join(), re) }
  for (const d of ['2099-02-31', '2099-04-31', '2099-00-10']) { const p = structuredClone(ok); p.candidates[0].retrieved_on = d; assert.match(V(p).join(), /retrieved_on must be a real date/, d) }
  { const p = structuredClone(ok); p.candidates[0].retrieved_on = '2999-01-01'; assert.match(V(p).join(), /not in the future/) }
  assert.throws(() => parseQueueIds('transaction_id,note\n10,"a\n20,b"\n'), /quoted CSV/); assert.throws(() => parseQueueIds('transaction_id\n9007199254740993\n'), /not a positive integer/)
})

test('the CLI rejects missing flag values, repeated flags, impossible grant-expiry dates; an unstated grant expiry is reported and clears nothing', () => {
  const run = (...a) => spawnSync(process.execPath, ['scripts/research/r8b-evidence.mjs', ...a], { cwd: root, encoding: 'utf8' })
  assert.equal(run('init', '--queue', 'q.csv', '--out', '/tmp/x', '--count').status, 2); assert.match(run('init', '--queue', 'q.csv', '--out', '/tmp/x', '--count').stderr, /needs a value/)
  assert.match(run('validate', '--dir', '--offline').stderr, /needs a value/); assert.match(run('validate', '--dir', 'a', '--dir', 'b').stderr, /more than once/)
  assert.match(run('validate', '--dir', 'a', '--offline', '--grant-expiry', 'RETROSHEET=2027-13-45').stderr, /grant-expiry needs|not a real date/); assert.match(run('validate', '--dir', 'a', '--offline', '--grant-expiry', 'RETROSHEET=2027-02-31').stderr, /not a real date/)
  const lib = fs.readFileSync(path.join(root, 'scripts/research/lib/r8b-evidence.mjs'), 'utf8'); assert.match(lib, /expiry_unknown/); assert.match(lib, /has no publication grant in the database \(typo\?\)/)
})

test('second review: encoded Wikipedia namespaces, Chadwick-org derivatives, value types, duplicate coverage, licence pinning, CLI exit codes', () => {
  for (const u of ['https://en.wikipedia.org/wiki/File%3AX.jpg', 'https://en.wikipedia.org/wiki/Special%3ARandom', 'https://en.wikipedia.org/wiki/Category%3Afoo', 'https://en.wikipedia.org/wiki/a%2Fb']) assert.equal(assessRights(u, { today: TODAY }).status, 'NEEDS_PERMISSION', u)
  assert.equal(assessRights('https://en.wikipedia.org/wiki/Some_Article_(baseball)', { today: TODAY }).status, 'DISPLAY_CLEARED')
  const ind = { assessment: 'LIKELY_INDEPENDENT', group: 'g', lineage_note: 'n' }
  for (const u of ['https://github.com/chadwickbureau/retrosheet', 'https://github.com/chadwickbureau/baseballdatabank', 'https://raw.githubusercontent.com/chadwickbureau/register/main/x', 'https://chadwickbureau.github.io/x']) assert.match(V(withCand(cand('c1', u, { independence: ind }))).join(), /partly derived from the origin/, u)
  const ok = withCand(cand('c1', 'https://news.example.com/a')); assert.deepEqual(V(ok), [])
  for (const [mut, re] of [[(p) => { p.candidates[0].evidence_basis = { human_verification: 'VERIFIED' } }, /evidence_basis must be short text, true\/false or null/], [(p) => { p.candidates[0].page_read = { verified: true } }, /page_read must be short text, true\/false or null/], [(p) => { p.transaction.assets[0].detail = { verified: 'HUMAN' } }, /detail must be text or null/],
    [(p) => { p.transaction.clubs = [{ human_verified: true }] }, /clubs must be a list of short strings/], [(p) => { p.candidates[0].url = ['https://en.wikipedia.org/wiki/Foo'] }, /url must be text/], [(p) => { p.candidates[0].title = { a: 1 } }, /title must be text/], [(p) => { p.transaction.id = '9001' }, /transaction.id must be a positive integer/],
    [(p) => { p.corroboration.assets.push({ position: 1, status: 'PROPOSED_CORROBORATED', candidate_ids: ['c1'] }) }, /listed more than once/], [(p) => { p.corroboration.assets.push({ position: 99, status: 'UNRESOLVED', candidate_ids: [] }) }, /not a side or asset of this transaction/],
    [(p) => { p.candidates[0].independence = { assessment: 'LIKELY_INDEPENDENT', group: ' Retrosheet-Archive ', lineage_note: 'n' } }, /group other than retrosheet-archive/],
    [(p) => { p.candidates[0].rights.reason = 'cleared by the owner' }, /rights.reason must be the assessed reason/], [(p) => { p.candidates[0].rights.license = { spdx: 'CC0-1.0' } }, /rights.license does not match/]]) { const p = structuredClone(ok); mut(p); assert.match(V(p).join(), re) }
  const wp = withCand(cand('c1', 'https://en.wikipedia.org/wiki/X'), 'PARTIAL'); wp.candidates[0].independence = { assessment: 'LIKELY_DERIVED', group: 'w', lineage_note: 'encyclopedia summary' }; assert.deepEqual(V(wp), []); wp.candidates[0].rights.license = { spdx: 'CC0-1.0', evidence_url: 'https://x.example/l' }; assert.match(V(wp).join(), /rights.license does not match/)
  const url = 'https://github.com/chadwickbureau/register/blob/master/data/people.csv'
  assert.equal(assessRights(url, { today: TODAY, license: { spdx: 'CC-BY-4.0', evidence_url: 'https://github.com/chadwickbureau/register/issues/9/licensed-not', checked_on: TODAY, checked_by: 'HUMAN' } }).status, 'NEEDS_PERMISSION')
  assert.equal(assessRights(url, { today: TODAY, license: { spdx: 'CC-BY-4.0', evidence_url: 'https://github.com/chadwickbureau/register/blob/master/LICENSE', checked_on: TODAY, checked_by: 'HUMAN' } }).status, 'DISPLAY_CLEARED')
  const run = (...a) => spawnSync(process.execPath, ['scripts/research/r8b-evidence.mjs', ...a], { cwd: root, encoding: 'utf8' })
  let r = run('validate', '--dir', 'a', '--offline', '--grant-expiry', 'MLB=2027-13-45'); assert.equal(r.status, 2); assert.doesNotMatch(r.stderr, /RangeError/)
  r = run('validate', '--dir', '/nonexistent-dir-for-test', '--offline'); assert.equal(r.status, 2); assert.match(r.stderr, /cannot read/)
  r = run('validate', '--dir', os.tmpdir(), '--offline', '--grant-expiry', 'MLB=NONE'); assert.equal(r.status, 2); assert.match(r.stderr, /no effect with --offline/)
})

test('third review: aliases, mirrors, proxies and archive wrappers of derived sources are never independent; season, positions and origin are pinned', () => {
  const ind = { assessment: 'LIKELY_INDEPENDENT', group: 'g', lineage_note: 'n' }
  for (const u of ['https://www.github.com/chadwickbureau/register', 'https://codeload.github.com/chadwickbureau/register/zip/master', 'https://api.github.com/repos/chadwickbureau/register', 'https://raw.github.com/chadwickbureau/register/x', 'https://cdn.jsdelivr.net/gh/chadwickbureau/register@master/x',
    'https://github.com/%63hadwickbureau/register', 'https://github.com//chadwickbureau/register', 'https://web.archive.org/web/2020/https://www.baseball-reference.com/x', 'https://news.example.com/mirror?u=https%3A%2F%2Fretrosheet.org%2Fx', 'https://someone.github.io/copy']) assert.match(V(withCand(cand('c1', u, { independence: ind }))).join(), /partly derived from the origin/, u)
  assert.deepEqual(V(withCand(cand('c1', 'https://news.example.com/a', { independence: ind }))), [], 'an ordinary publisher is not caught')
  const ok = withCand(cand('c1', 'https://news.example.com/a'))
  for (const [mut, re] of [[(p) => { p.transaction.season = { verified: true } }, /season must be an integer/], [(p) => { p.transaction.origin_sources[0].position = { a: 1 } }, /position must be an integer/], [(p) => { p.origin.independence_group = 'other-group' }, /origin must be the BAI record's own origin/],
    [(p) => { p.corroboration.assets[0].position = [1] }, /position must be an integer/], [(p) => { p.corroboration.assets[0].position = '1' }, /position must be an integer/]]) { const p = structuredClone(ok); mut(p); assert.match(V(p).join(), re) }
})
