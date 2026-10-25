// Keeps the benchmark cluster running so several benchmark scripts can attach to it. Stop it with SIGTERM.
import { startCluster, PORT } from './cluster.mjs'
const c = await startCluster()
console.log(`benchmark cluster on port ${PORT}`)
const stop = async () => { await c.stop(); process.exit(0) }
process.on('SIGTERM', stop); process.on('SIGINT', stop)
setInterval(() => {}, 1 << 30)
