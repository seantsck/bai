-- 026_publication_guard_upserts
-- 025's publication guard ran BEFORE INSERT, and PostgreSQL fires BEFORE INSERT row triggers for an INSERT ... ON CONFLICT
-- row even when the row already exists. A no-op re-seed of existing reference data (re-running migration 015's calendar
-- upsert, as hosted:verify does inside a rolled-back transaction) was therefore refused as if it published a new record.
--
-- The guard now fires:
--   * AFTER INSERT: only for rows actually inserted (an ON CONFLICT DO UPDATE / DO NOTHING row does not fire it);
--   * BEFORE UPDATE OF source_id, only WHEN the source actually changes (an upsert that sets the same source passes).
-- Raising in an AFTER row trigger still aborts the statement, so nothing new is published. Rules are unchanged: on a
-- Supabase (hosted) database a new record citing a group other than Chadwick Register, Wikipedia or BAI research needs a
-- row in ingest.source_publication_grants; existing records are untouched; local databases are not guarded.

do $$
declare
  t text;
begin
  for t in select c.table_name from information_schema.columns c join information_schema.tables x using (table_schema, table_name)
           where c.table_schema = 'public' and c.column_name = 'source_id' and x.table_type = 'BASE TABLE' and c.table_name <> 'fact_resolutions' order by 1
  loop
    execute format('drop trigger if exists %I on public.%I', t || '_publication_guard', t);
    execute format('create trigger %I after insert on public.%I for each row execute function public.source_publication_guard()', t || '_publication_guard_insert', t);
    execute format('create trigger %I before update of source_id on public.%I for each row when (old.source_id is distinct from new.source_id) execute function public.source_publication_guard()', t || '_publication_guard_update', t);
  end loop;
end $$;

select public.apply_public_boundary();
