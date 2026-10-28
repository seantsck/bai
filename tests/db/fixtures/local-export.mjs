// Deterministic stand-in for the logical export, built from the BAI catalog snapshot (schema objects, grants, RLS, policies, functions, roles), every row of
// every BAI table and every sequence position, with pg_dump-style random `\restrict` lines so the normalization is exercised. Local databases only.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import pg from 'pg'
import { catalogSnapshot } from '../../../scripts/db/lib/catalog.mjs'

const out = process.argv[2]
if (fs.existsSync(out) && fs.readdirSync(out).length) { console.error('refusing: not empty'); process.exit(2) }
const url = process.env.BAI_DATABASE_URL
if (!url || !['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) { console.error('local database only'); process.exit(2) }
fs.mkdirSync(out, { recursive: true, mode: 0o700 })
const c = new pg.Client({ connectionString: url }); await c.connect()
const token = () => crypto.randomBytes(24).toString('base64url')
try {
  await c.query('begin isolation level repeatable read read only')
  const cat = [...(await catalogSnapshot(c))].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k} -> ${v}`)
  const roles = (await c.query("select rolname, rolcanlogin, rolsuper, rolcreatedb, rolinherit, rolbypassrls, rolconnlimit from pg_roles where rolname !~ '^pg_' and rolname not in ('postgres') order by 1")).rows.map((r) => JSON.stringify(r))
  const tables = (await c.query("select table_schema s, table_name t from information_schema.tables where table_schema in ('public','ingest','research') and table_type = 'BASE TABLE' order by 1, 2")).rows
  const data = []
  for (const { s, t } of tables) { data.push(`COPY ${s}.${t}`); data.push(...(await c.query(`select to_jsonb(x)::text j from "${s}"."${t}" x order by 1`)).rows.map((r) => r.j)) }
  const seq = (await c.query("select schemaname || '.' || sequencename n, last_value from pg_sequences where schemaname in ('public','ingest','research','bai_meta') order by 1")).rows.map((r) => `setval ${r.n} ${r.last_value}`)
  const hist = (await c.query('select coalesce(json_agg(json_build_object($$version$$, version, $$file$$, file, $$checksum$$, checksum) order by version), $$[]$$::json) j from bai_meta.schema_migrations')).rows[0].j
  const t1 = token(); const t2 = token()
  fs.writeFileSync(path.join(out, 'roles.sql'), `-- \\restrict ${t1}\n${roles.join('\n')}\n-- \\unrestrict ${t1}\n`)
  fs.writeFileSync(path.join(out, 'schema.sql'), `\\restrict ${t2}\n${cat.join('\n')}\n\\unrestrict ${t2}\n`)
  fs.writeFileSync(path.join(out, 'data.sql'), `-- \\restrict ${t1}\n${data.join('\n')}\n${seq.join('\n')}\n-- \\unrestrict ${t1}\n`)
  fs.writeFileSync(path.join(out, 'supabase_migrations_history.json'), JSON.stringify(hist) + '\n')
  fs.writeFileSync(path.join(out, 'MANIFEST.txt'), 'test stand-in export\n')
} finally { await c.query('rollback').catch(() => {}); await c.end() }
const sums = ['roles.sql', 'schema.sql', 'data.sql', 'supabase_migrations_history.json'].map((f) => `${crypto.createHash('sha256').update(fs.readFileSync(path.join(out, f))).digest('hex')}  ${f}`)
fs.writeFileSync(path.join(out, 'SHA256SUMS'), sums.join('\n') + '\n')
console.log(`exported to ${out}`)
