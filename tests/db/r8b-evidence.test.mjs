// R8B evidence packages: a research PROPOSAL is never a verification, categories follow from the host, independence is never confirmed by a proposal, nothing unresolved is dropped,
// no source text is stored, and the files stay private and outside git. FICTIONAL clubs, players, ids and URLs throughout (example.org / example.com are reserved names).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { categoryOfUrl, newPackage, readiness, rightsStatus, savePackage, triageRows, validatePackage, writePackages } from '../../scripts/research/lib/r8b-evidence.mjs'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')
const tx = (o = {}) => ({ id: 9001, season: 2099, date: '2099-06-01', clubs: ['AAA', 'BBB'], external_ids: ['00001@20990601'], created_on: '2099-06-02',
  assets: [{ position: 1, from_key: 'AAA', to_key: 'BBB', kind: 'PLAYER', player_name: 'Fictional One', detail: null, conditional: false, condition_text: null, amount_status: null, resolution_kind: null },
    { position: 2, from_key: 'BBB', to_key: 'AAA', kind: 'PLAYER', player_name: 'Fictional Two', detail: null, conditional: false, condition_text: null, amount_status: null, resolution_kind: null }],
  origin_sources: [{ position: 1, role: 'RECORD', independence_group: null, category: 'RETROSHEET' }], ...o })
const cand = (id, url, o = {}) => ({ id, url, title: 'Fictional release', publisher: 'Example Club', role: 'CORROBORATION', locator: 'section 2', retrieved_on: '2099-06-03', found_by: 'HUMAN',
  rights: { category: categoryOfUrl(url), status: rightsStatus(categoryOfUrl(url)), display_consequence: rightsStatus(categoryOfUrl(url)) === 'NEEDS_PERMISSION' ? 'WITHDRAWN_UNTIL_PERMITTED' : 'NONE' },
  independence: { assessment: 'LIKELY_INDEPENDENT', group: 'club-release-aaa', lineage_note: 'first-hand club release; not derived from the origin' }, ...o })
const withCand = (c, cover = 'PROPOSED_CORROBORATED') => { const p = newPackage(tx()); p.candidates = [c]; for (const r of [...p.corroboration.packages, ...p.corroboration.assets]) { r.status = cover; r.candidate_ids = [c.id] } return p }

test('a new package is a well-formed proposal: everything UNRESOLVED, no candidates, nothing verified, and the open work is listed', () => {
  const p = newPackage(tx()); assert.deepEqual(validatePackage(p), []); assert.equal(p.kind, 'RESEARCH_PROPOSAL'); assert.equal(p.human_verification, null)
  assert.ok([...p.corroboration.packages, ...p.corroboration.assets].every((r) => r.status === 'UNRESOLVED'))
  assert.ok(readiness(p).includes('NO_PRIMARY_ANNOUNCEMENT_CANDIDATE') && readiness(p).includes('ASSET_1_UNRESOLVED') && readiness(p).includes('PACKAGE_AAA>BBB_UNRESOLVED'))
})

test('the source category follows from the host and cannot be declared; restricted categories carry the display consequence', () => {
  assert.equal(categoryOfUrl('https://www.mlb.com/news/x'), 'MLB'); assert.equal(categoryOfUrl('https://www.baseball-reference.com/x'), 'BASEBALL_REFERENCE'); assert.equal(categoryOfUrl('https://en.wikipedia.org/wiki/X'), 'WIKIPEDIA')
  assert.equal(categoryOfUrl('https://news.example.com/a'), 'OTHER_PUBLICATION'); assert.equal(rightsStatus('MLB'), 'NEEDS_PERMISSION'); assert.equal(rightsStatus('WIKIPEDIA'), 'DISPLAY_CLEARED'); assert.equal(rightsStatus('RETROSHEET'), 'GRANTED')
  const relabel = withCand(cand('c1', 'https://www.mlb.com/news/x', { rights: { category: 'WIKIPEDIA', status: 'DISPLAY_CLEARED', display_consequence: 'NONE' } }))
  assert.match(validatePackage(relabel).join(), /follows from the host \(MLB\); it cannot be declared as WIKIPEDIA/)
  const blocked = withCand(cand('c1', 'https://news.example.com/a')); assert.deepEqual(validatePackage(blocked), []); assert.ok(readiness(blocked).includes('RIGHTS_BLOCKED_c1'))
  assert.match(validatePackage(withCand(cand('c1', 'https://news.example.com/a', { rights: { category: 'OTHER_PUBLICATION', status: 'NEEDS_PERMISSION', display_consequence: 'NONE' } }))).join(), /display_consequence must be WITHDRAWN_UNTIL_PERMITTED/)
})

test('a proposal can never confirm: no human fields, no CORROBORATED / VERIFIED / confirmed independence, unresolved claims are never dropped', () => {
  const ok = withCand(cand('c1', 'https://news.example.com/a')); assert.deepEqual(validatePackage(ok), [])
  const h = structuredClone(ok); h.human_verification = { by: 'someone' }; assert.match(validatePackage(h).join(), /carries no human verification/)
  const s = structuredClone(ok); s.corroboration.assets[0].status = 'CORROBORATED'; assert.match(validatePackage(s).join(), /not a proposal status/)
  const v = structuredClone(ok); v.corroboration.assets[0].status = 'VERIFIED_COMPLETE'; assert.match(validatePackage(v).join(), /not a proposal status/)
  const c = structuredClone(ok); c.candidates[0].independence.assessment = 'INDEPENDENT_CONFIRMED'; assert.match(validatePackage(c).join(), /a proposal cannot confirm independence/)
  const d = structuredClone(ok); d.corroboration.assets.pop(); assert.match(validatePackage(d).join(), /asset 2 has no entry/)
  const e = structuredClone(ok); e.corroboration.packages.pop(); assert.match(validatePackage(e).join(), /has no entry/)
  const u = structuredClone(ok); u.corroboration.assets[0].status = 'UNRESOLVED'; assert.match(validatePackage(u).join(), /UNRESOLVED cannot cite candidates/)
  const n = structuredClone(ok); n.corroboration.assets[0].candidate_ids = ['nope']; assert.match(validatePackage(n).join(), /unknown candidate nope/)
  const k = withCand(cand('c1', 'https://news.example.com/a', { independence: { assessment: 'LIKELY_DERIVED', group: 'x', lineage_note: 'y' } })); assert.match(validatePackage(k).join(), /needs at least one LIKELY_INDEPENDENT candidate/)
})

test('independence: the origin and known derived hosts are never independent; independent needs a lineage note and another group', () => {
  assert.match(validatePackage(withCand(cand('c1', 'https://www.baseball-reference.com/x'))).join(), /partly derived from the origin/)
  assert.match(validatePackage(withCand(cand('c1', 'https://www.retrosheet.org/x'))).join(), /partly derived from the origin/)
  const g = withCand(cand('c1', 'https://news.example.com/a', { independence: { assessment: 'LIKELY_INDEPENDENT', group: 'retrosheet-archive', lineage_note: 'x' } })); assert.match(validatePackage(g).join(), /group other than retrosheet-archive/)
  const l = withCand(cand('c1', 'https://news.example.com/a', { independence: { assessment: 'LIKELY_INDEPENDENT', group: 'g' } })); assert.match(validatePackage(l).join(), /needs a lineage note/)
  assert.deepEqual(validatePackage(withCand(cand('c1', 'https://www.baseball-reference.com/x', { independence: { assessment: 'LIKELY_DERIVED', group: 'sports-ref', lineage_note: 'copies the origin for older years' } }), 'PARTIAL')), [])
})

test('no source text, no invented or unsafe citations: bounded fields, https only, no credentials, real dates, a stated way of finding it', () => {
  const base = () => withCand(cand('c1', 'https://news.example.com/a'))
  const t = base(); t.candidates[0].excerpt = 'copied sentence'; assert.match(validatePackage(t).join(), /source text is never stored/)
  const q = base(); q.candidates[0].quote = 'x'; assert.match(validatePackage(q).join(), /source text is never stored/)
  const long = base(); long.candidates[0].title = 'x'.repeat(201); assert.match(validatePackage(long).join(), /title is required and at most 200/)
  const big = base(); big.unresolved_claims = ['y'.repeat(501)]; assert.match(validatePackage(big).join(), /longer than 500/)
  assert.match(validatePackage(withCand(cand('c1', 'http://news.example.com/a'))).join(), /must be https/)
  assert.match(validatePackage(withCand(cand('c1', 'https://user:pw@news.example.com/a'))).join(), /carries credentials/)
  { const w = base(); w.candidates[0].url = 'not a url'; assert.match(validatePackage(w).join(), /not a valid URL/) }
  assert.match(validatePackage(withCand(cand('c1', 'https://news.example.com/a', { retrieved_on: '2099-13-45' }))).join(), /retrieved_on must be a real date/)
  assert.match(validatePackage(withCand(cand('c1', 'https://news.example.com/a', { found_by: undefined }))).join(), /found_by must say how/)
  assert.match(validatePackage(withCand(cand('c1', 'https://news.example.com/a', { locator: '' }))).join(), /locator is required/)
  const dup = base(); dup.candidates.push(cand('c1', 'https://news.example.com/b')); assert.match(validatePackage(dup).join(), /duplicated/)
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
