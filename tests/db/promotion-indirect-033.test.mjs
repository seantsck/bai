// The indirect-reference emergency suite (tests/db/promotion-indirect.test.mjs) at the 033 stage: only the website role holds a grant on the identity and evidence tables, and
// ingest.emergency_withdraw (replaced by 033) must hide or close them for it exactly as it does for tables the Data API roles read. Same tests, same assertions, schema through 033.
process.env.BAI_STAGE = '033'
await import('./promotion-indirect.test.mjs')
