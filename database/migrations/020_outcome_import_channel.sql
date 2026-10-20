-- 020_outcome_import_channel
-- Outcome audits enter BAI through the same staged ingestion as draft and international records: a third batch channel,
-- OUTCOMES, carrying OUTCOME_AUDIT records (audit state, MLB debut, details as of a date, WAR per provider, trades).
--
-- Rules encoded here (enforced by the pipeline):
--   * An outcome record attaches to an existing player by a strong identity; it never creates a player.
--   * Disagreeing claims (another debut date, another WAR value) become conflicts, never overwrites.
--   * NOT_AUDITED is the absence of an audit, not a value anyone imports.
alter type ingest.batch_channel add value if not exists 'OUTCOMES';

alter table ingest.staged_records drop constraint staged_records_record_type_check;
alter table ingest.staged_records add constraint staged_records_record_type_check
  check (record_type in ('DRAFT_SELECTION', 'INTERNATIONAL_SIGNING', 'OUTCOME_AUDIT'));
