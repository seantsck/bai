-- 018_btree_gist_extensions_schema
-- 001 created btree_gist without a schema, so it landed in public. On Supabase, public is the Data API schema, and the
-- extension's support functions there stay executable by PUBLIC: the extension belongs to the platform (supabase_admin),
-- so BAI's boundary cannot revoke them (011/012 report "no privileges could be revoked"). The Supabase advisor flags this
-- as extension_in_public. Moving the extension to its own schema resolves both.
--
-- Rules encoded here:
--   * Extensions live in the `extensions` schema, never in public (Supabase's convention; created locally if missing).
--   * Existing exclusion constraints keep working: they reference the btree_gist operator classes by OID, not by name.
--   * A future migration that names a btree_gist operator class must qualify it (extensions.gist_int4_ops) or put
--     extensions on its search_path.

create schema if not exists extensions;
alter extension btree_gist set schema extensions;
