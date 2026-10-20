// Catalog snapshot of the BAI-owned part of a database, for local-vs-hosted parity. Every object becomes one
// `kind|name -> description` entry so two snapshots diff as plain maps. Objects that belong to extensions are left out
// (extensions are listed with their versions instead), and so is everything outside BAI's schemas.
export const BAI_SCHEMAS = ['public', 'analytics', 'ingest', 'research', 'bai_meta']
/** Roles BAI's migrations grant to or rely on. ACL entries for any other role are platform-managed. */
export const BAI_ROLES = ['postgres', 'anon', 'authenticated', 'service_role', 'bai_web', 'PUBLIC']
/** Login roles BAI's migrations create (cluster-level, so compared by attributes and memberships). */
export const BAI_CREATED_ROLES = ['bai_web']

const q = async (db, sql, params) => (await db.query(sql, params)).rows

/**
 * SQL for an object's EFFECTIVE privileges as sorted "grantee:PRIV,PRIV" entries. A NULL ACL is expanded to the
 * owner's implicit defaults (acldefault), so "never granted" and "explicitly granted the same" compare equal.
 * Grantors are dropped: who issued a grant is platform detail, what is granted is BAI's.
 */
const effectiveAcl = (aclCol, kind, ownerCol) => `(select string_agg(g, ' ' order by g) from (
    select coalesce(nullif(pg_get_userbyid(a.grantee), '-'), 'PUBLIC') || ':' || string_agg(a.privilege_type, ',' order by a.privilege_type) g
    from aclexplode(coalesce(${aclCol}, acldefault(${kind}, ${ownerCol}))) a group by a.grantee) x)`
/** Functions in BAI schemas that the platform owns: event-trigger handlers (e.g. Supabase's public.rls_auto_enable). */
export const PLATFORM_FUNCTION_FILTER = 'not exists (select 1 from pg_event_trigger e where e.evtfoid = p.oid)'

export async function catalogSnapshot (db) {
  const S = BAI_SCHEMAS
  const out = new Map()
  const put = (k, v) => out.set(k, typeof v === 'string' ? v : JSON.stringify(v))
  // Objects that belong to an extension (e.g. btree_gist operator support in public).
  const extMember = (cls, col) => `not exists (select 1 from pg_depend d where d.classid = '${cls}'::regclass and d.objid = ${col} and d.deptype = 'e')`

  for (const r of await q(db, `select nspname, pg_get_userbyid(nspowner) owner, ${effectiveAcl('nspacl', "'n'", 'nspowner')} acl from pg_namespace where nspname = any($1)`, [S])) {
    put(`schema|${r.nspname}`, { owner: r.owner, acl: r.acl })
  }
  for (const r of await q(db, "select extname, extversion, n.nspname from pg_extension e join pg_namespace n on n.oid = e.extnamespace where n.nspname = any($1)", [S])) {
    put(`extension|${r.extname}`, { schema: r.nspname, version: r.extversion })
  }
  for (const r of await q(db, `select n.nspname, c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity, c.reloptions,
        ${effectiveAcl('c.relacl', "case c.relkind when 'S' then 's'::\"char\" else 'r'::\"char\" end", 'c.relowner')} acl, pg_get_userbyid(c.relowner) owner
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = any($1) and c.relkind in ('r','p','v','m','S','f') and ${extMember('pg_class', 'c.oid')}`, [S])) {
    put(`relation|${r.nspname}.${r.relname}`, { kind: r.relkind, rls: r.relrowsecurity, force_rls: r.relforcerowsecurity, options: r.reloptions ?? [], owner: r.owner })
    put(`grant|${r.nspname}.${r.relname}`, r.acl)
  }
  for (const r of await q(db, `select n.nspname, c.relname, a.attname, format_type(a.atttypid, a.atttypmod) type, a.attnotnull, a.attidentity, a.attgenerated,
        pg_get_expr(ad.adbin, ad.adrelid) def, case when a.attacl is null then null else ${effectiveAcl('a.attacl', "'c'", 'c.relowner')} end acl
      from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
      left join pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum
      where n.nspname = any($1) and c.relkind in ('r','p','v','m','f') and a.attnum > 0 and not a.attisdropped and ${extMember('pg_class', 'c.oid')}`, [S])) {
    put(`column|${r.nspname}.${r.relname}.${r.attname}`, { type: r.type, not_null: r.attnotnull, identity: r.attidentity, generated: r.attgenerated, default: r.def, acl: r.acl })
  }
  for (const r of await q(db, `select n.nspname, c.relname, k.conname, k.contype, pg_get_constraintdef(k.oid) def
      from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = any($1)`, [S])) {
    put(`constraint|${r.nspname}.${r.relname}.${r.conname}`, { type: r.contype, def: r.def })
  }
  for (const r of await q(db, `select n.nspname, c.relname, pg_get_indexdef(i.indexrelid) def
      from pg_index i join pg_class c on c.oid = i.indexrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = any($1)`, [S])) {
    put(`index|${r.nspname}.${r.relname}`, r.def)
  }
  for (const r of await q(db, `select n.nspname, c.relname, pg_get_viewdef(c.oid) def from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = any($1) and c.relkind in ('v','m')`, [S])) {
    put(`view|${r.nspname}.${r.relname}`, r.def)
  }
  for (const r of await q(db, `select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) args, pg_get_function_result(p.oid) result,
        p.prokind, p.prosecdef, p.provolatile, p.proconfig, md5(p.prosrc) src, l.lanname,
        ${effectiveAcl('p.proacl', "'f'", 'p.proowner')} acl, pg_get_userbyid(p.proowner) owner
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
      where n.nspname = any($1) and ${extMember('pg_proc', 'p.oid')} and ${PLATFORM_FUNCTION_FILTER}`, [S])) {
    const name = `${r.nspname}.${r.proname}(${r.args})`
    put(`function|${name}`, { kind: r.prokind, result: r.result, security_definer: r.prosecdef, volatility: r.provolatile, config: r.proconfig ?? [], language: r.lanname, src: r.src, owner: r.owner })
    put(`execute|${name}`, r.acl)
  }
  for (const r of await q(db, `select n.nspname, c.relname, t.tgname, pg_get_triggerdef(t.oid) def from pg_trigger t join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace where n.nspname = any($1) and not t.tgisinternal`, [S])) {
    put(`trigger|${r.nspname}.${r.relname}.${r.tgname}`, r.def)
  }
  for (const r of await q(db, `select n.nspname, t.typname, t.typtype, format_type(t.typbasetype, t.typtypmod) base, t.typnotnull,
        (select array_agg(e.enumlabel order by e.enumsortorder) from pg_enum e where e.enumtypid = t.oid) labels,
        (select array_agg(pg_get_constraintdef(k.oid) order by k.conname) from pg_constraint k where k.contypid = t.oid) checks
      from pg_type t join pg_namespace n on n.oid = t.typnamespace
      where n.nspname = any($1) and t.typtype in ('e','d') and ${extMember('pg_type', 't.oid')}`, [S])) {
    put(`type|${r.nspname}.${r.typname}`, { kind: r.typtype, labels: r.labels, base: r.typtype === 'd' ? r.base : null, not_null: r.typnotnull, checks: r.checks })
  }
  for (const r of await q(db, `select schemaname, tablename, policyname, permissive, roles::text[] roles, cmd, qual, with_check from pg_policies where schemaname = any($1)`, [S])) {
    put(`policy|${r.schemaname}.${r.tablename}.${r.policyname}`, { permissive: r.permissive, roles: [...r.roles].sort(), cmd: r.cmd, using: r.qual, check: r.with_check })
  }
  for (const r of await q(db, `select r.rolname, r.rolcanlogin, r.rolinherit, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolbypassrls, r.rolreplication,
        (select array_agg(g.rolname::text || case when m.inherit_option then '+inherit' else '' end || case when m.set_option then '+set' else '' end order by g.rolname)
           from pg_auth_members m join pg_roles g on g.oid = m.roleid where m.member = r.oid) member_of
      from pg_roles r where r.rolname = any($1)`, [BAI_CREATED_ROLES])) {
    const { rolname, ...attrs } = r
    put(`role|${rolname}`, attrs)
  }
  const hasMeta = (await q(db, "select to_regclass('bai_meta.schema_migrations') is not null e"))[0].e
  if (hasMeta) for (const r of await q(db, 'select version, file, checksum from bai_meta.schema_migrations')) put(`migration|${r.version}`, { file: r.file, checksum: r.checksum })
  return out
}

/** Content fingerprint of the reference data the migrations seed (no timestamps: they record when, not what). */
export const SEEDED_TABLES = ['organizations', 'organization_names', 'organization_aliases', 'sources', 'rules_eras', 'drafts', 'international_signing_periods',
  'source_observations', 'fact_resolutions', 'conflict_rules', 'research_queue_types', 'provenance_fact_tables', 'internal_objects', 'markets', 'draft_rounds']

/**
 * Seed tables whose surrogate ids depend on the query plan: migration 002 fills them with INSERT ... SELECT from a join
 * without ORDER BY, so two servers can number the same rows differently. No foreign key or observation references
 * these ids, so they are compared by content only.
 */
export const PLAN_DEPENDENT_ID_TABLES = ['organization_names', 'organization_aliases']

export async function seedFingerprint (db, tables = SEEDED_TABLES) {
  const out = new Map()
  for (const t of tables) {
    if (!(await q(db, 'select to_regclass($1) is not null e', [`public.${t}`]))[0].e) continue
    const cols = (await q(db, `select column_name from information_schema.columns where table_schema = 'public' and table_name = $1
        and data_type not in ('timestamp with time zone', 'timestamp without time zone') order by ordinal_position`, [t]))
      .filter((r) => !(PLAN_DEPENDENT_ID_TABLES.includes(t) && r.column_name === 'id')).map((r) => `"${r.column_name}"`)
    const r = (await q(db, `select count(*)::int n, md5(coalesce(string_agg(row_text, E'\\n' order by row_text collate "C"), '')) h
        from (select (row(${cols.join(', ')}))::text row_text from public.${t}) x`))[0]
    out.set(`data|${t}`, JSON.stringify({ rows: r.n, md5: r.h }))
  }
  return out
}

export function diffSnapshots (a, b) {
  const diffs = []
  for (const [k, v] of a) if (!b.has(k)) diffs.push({ key: k, reference: v, target: null }); else if (b.get(k) !== v) diffs.push({ key: k, reference: v, target: b.get(k) })
  for (const [k, v] of b) if (!a.has(k)) diffs.push({ key: k, reference: null, target: v })
  return diffs.sort((x, y) => x.key.localeCompare(y.key))
}
