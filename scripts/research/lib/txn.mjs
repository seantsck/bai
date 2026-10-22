// Transactions that nest. The research pipeline opens and closes its own transaction for each step (stage, validate,
// apply). A release that must be all-or-nothing wraps those steps in ONE outer transaction (withOuterTransaction); inside
// it each step uses a savepoint instead, so nothing commits until the whole release has been verified. Outside an outer
// transaction the helpers behave exactly like begin / commit / rollback.
const SP = Symbol('bai.outer')

export async function begin (db) {
  const o = db[SP]
  if (o) { o.depth++; await db.query(`savepoint bai_step_${o.depth}`) } else await db.query('begin')
}
export async function commit (db) {
  const o = db[SP]
  if (o) { await db.query(`release savepoint bai_step_${o.depth}`); o.depth-- } else await db.query('commit')
}
export async function rollback (db) {
  const o = db[SP]
  if (o && o.depth > 0) { await db.query(`rollback to savepoint bai_step_${o.depth}`); await db.query(`release savepoint bai_step_${o.depth}`); o.depth-- } else await db.query('rollback')
}
export const inOuterTransaction = (db) => Boolean(db[SP])

/** Runs fn with every pipeline step inside one transaction; commits only if fn resolves, rolls back everything if it throws. */
export async function withOuterTransaction (db, fn) {
  if (db[SP]) throw new Error('already inside an outer transaction')
  await db.query('begin')
  db[SP] = { depth: 0 }
  try {
    const r = await fn()
    delete db[SP]
    await db.query('commit')
    return r
  } catch (err) {
    delete db[SP]
    try { await db.query('rollback') } catch { /* connection already failed */ }
    throw err
  }
}
