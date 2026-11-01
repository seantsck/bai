// The indirect-reference emergency suite (tests/db/promotion-indirect.test.mjs) at the 034 stage: player_aliases is now closed to the Data API roles and read by the website role alone, and an
// alias that points at a promoted player must be hidden (hide mode) or its table closed (close-api) for the website role, then given back exactly (revert, finish). Same assertions, schema through 034.
process.env.BAI_STAGE = '034'
await import('./promotion-indirect.test.mjs')
