// Player identity, aliases, external ids and organization history.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as h from './harness.mjs'

let db
before(async () => { await h.startServer(); db = await h.freshDatabase() }, { timeout: 120000 })
after(async () => { await h.stopServer() })

const addPlayer = (slug, name) => h.id(db, 'insert into players (slug, full_name, display_name) values ($1, $2, $2) returning id', [slug, name])

test('30 current MLB organizations are seeded with stable franchise keys and unique MLBAM team ids', async () => {
  const r = await h.one(db, `select count(*)::int n, count(distinct franchise_key)::int keys, count(distinct mlb_team_id)::int teams,
    count(*) filter (where league = 'AL')::int al, count(*) filter (where league = 'NL')::int nl from organizations`)
  assert.deepEqual(r, { n: 30, keys: 30, teams: 30, al: 15, nl: 15 })
  const divisions = await h.rows(db, 'select league, division, count(*)::int n from organizations group by 1, 2 order by 1, 2')
  assert.ok(divisions.every((d) => d.n === 5), 'six divisions of five')
})

test('organization history: names by season survive renames without changing identity', async () => {
  const cle = await h.one(db, "select id, slug from organizations where franchise_key = 'CLE'")
  assert.equal((await h.one(db, 'select organization_name_in_season($1, 2019) n', [cle.id])).n, 'Cleveland Indians')
  assert.equal((await h.one(db, 'select organization_name_in_season($1, 2022) n', [cle.id])).n, 'Cleveland Guardians')
  const ath = await h.one(db, "select id from organizations where franchise_key = 'ATH'")
  assert.equal((await h.one(db, 'select organization_name_in_season($1, 2024) n', [ath.id])).n, 'Oakland Athletics')
  assert.equal((await h.one(db, 'select organization_name_in_season($1, 2025) n', [ath.id])).n, 'Athletics')
  // historical name resolves to the same franchise through aliases
  const alias = await h.one(db, "select organization_id from organization_aliases where alias_normalized = normalize_name('Cleveland Indians')")
  assert.equal(alias.organization_id, cle.id)
  // overlapping name ranges are rejected
  await h.rejects(db, "insert into organization_names (organization_id, name, first_season, last_season, source_id) values ($1, 'Overlap', 2020, 2023, 1)", [cle.id], /conflicting key value violates exclusion constraint/)
})

test('players: same name is allowed, slug and player_key are unique, names are not identity', async () => {
  const a = await addPlayer('juan-perez-1', 'Juan Pérez')
  const b = await addPlayer('juan-perez-2', 'Juan Perez')
  assert.notEqual(a, b)
  await h.rejects(db, "insert into players (slug, full_name, display_name) values ('juan-perez-1', 'X', 'X')", [], /players_slug_key/)
  const keys = await h.one(db, 'select count(distinct player_key)::int n from players where id = any($1)', [[a, b]])
  assert.equal(keys.n, 2)
  const cands = await h.rows(db, "select player_id from player_name_candidates('JUAN PEREZ') order by 1")
  assert.deepEqual(cands.map((c) => Number(c.player_id)), [a, b], 'name lookup returns every candidate for disambiguation')
})

test('external ids resolve to exactly one player and a player has one id per system', async () => {
  const a = await addPlayer('ext-a', 'Ext A')
  const b = await addPlayer('ext-b', 'Ext B')
  await db.query("insert into player_external_ids (player_id, id_system, external_id) values ($1, 'MLBAM', '123')", [a])
  await h.rejects(db, "insert into player_external_ids (player_id, id_system, external_id) values ($1, 'MLBAM', '123')", [b], /player_external_ids_id_system_external_id_key/)
  await h.rejects(db, "insert into player_external_ids (player_id, id_system, external_id) values ($1, 'MLBAM', '456')", [a], /player_external_ids_player_id_id_system_key/)
  assert.equal(Number((await h.one(db, "select resolve_player('MLBAM', '123') p")).p), a)
  assert.equal((await h.one(db, "select resolve_player('MLBAM', '999') p")).p, null, 'unresolved ids return null, never a guess')
})

test('aliases: accent/punctuation-insensitive matching, unique per player', async () => {
  const p = await addPlayer('alias-player', 'José Ñúñez Jr.')
  await db.query("insert into player_aliases (player_id, alias, alias_type) values ($1, 'Jose Nunez', 'ROMANIZATION')", [p])
  await h.rejects(db, "insert into player_aliases (player_id, alias, alias_type) values ($1, 'JOSÉ NÚÑEZ', 'MISSPELLING')", [p], /player_aliases_player_id_alias_normalized_key/)
  const found = await h.rows(db, "select player_id, matched_on from player_name_candidates('jose nunez')")
  assert.deepEqual(found.map((r) => [Number(r.player_id), r.matched_on]), [[p, 'alias:ROMANIZATION']])
  assert.equal((await h.one(db, 'select name_normalized from players where id = $1', [p])).name_normalized, 'jose nunez jr')
})
