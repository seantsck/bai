import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { NAV_ITEMS, PLANNED_ROUTES, isActive } from '../../lib/nav.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test('navigation is Overview, International, Draft, Organizations, Players, Compare, Research, Sources', () => {
  assert.deepEqual(NAV_ITEMS.map((n) => n.label), ['Overview', 'International', 'Draft', 'Organizations', 'Players', 'Compare', 'Research', 'Sources'])
})

test('every planned route has an App Router page', () => {
  for (const route of PLANNED_ROUTES) {
    const file = path.join(root, 'app', route, 'page.tsx')
    assert.ok(fs.existsSync(file), `missing page for ${route}`)
  }
})

test('every page renders dynamically (no build-time database access)', () => {
  for (const route of PLANNED_ROUTES) {
    const src = fs.readFileSync(path.join(root, 'app', route, 'page.tsx'), 'utf8')
    assert.match(src, /export const dynamic = 'force-dynamic'/, route)
  }
})

test('pages never query analytics.* or call the refresh directly', () => {
  const files = [path.join(root, 'lib/queries.ts'), ...PLANNED_ROUTES.map((r) => path.join(root, 'app', r, 'page.tsx'))]
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8')
    assert.doesNotMatch(src, /analytics\.\w/, f)
    assert.doesNotMatch(src, /refresh_read_models/, f)
  }
})

test('active nav matching', () => {
  assert.ok(isActive('/', '/'))
  assert.ok(!isActive('/draft', '/'))
  assert.ok(isActive('/draft/picks', '/draft'))
  assert.ok(!isActive('/drafts', '/draft'))
})

test('.vercelignore never excludes app code or the CA file', () => {
  const lines = fs.readFileSync(path.join(root, '.vercelignore'), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !l.startsWith('!'))
  for (const l of lines) {
    if (/^[A-Za-z]/.test(l) && !l.includes('*')) assert.fail(`unanchored directory pattern "${l}" would also match inside app/ (use /${l})`)
  }
  for (const route of PLANNED_ROUTES) {
    for (const seg of route.split('/').filter(Boolean)) assert.ok(!lines.includes(seg), `${seg} would exclude app${route}`)
  }
  assert.ok(fs.readFileSync(path.join(root, '.vercelignore'), 'utf8').includes('!/supabase/prod-ca-2021.crt'))
})
