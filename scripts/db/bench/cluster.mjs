// A persistent, disk-backed PostgreSQL 17 cluster for the repeatable scale benchmarks (never /tmp: tmpfs is quota-limited).
// Layout under BAI_BENCH_DIR (default ~/tmp-bai/bench): pg/ (the cluster), snapshot/ (fixed input rows), results/.
import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import pg from 'pg'
import EmbeddedPostgres from 'embedded-postgres'

export const benchDir = path.resolve(process.env.BAI_BENCH_DIR ?? path.join(os.homedir(), 'tmp-bai', 'bench'))
export const PORT = Number(process.env.BAI_BENCH_PORT ?? 54329)

export async function startCluster () {
  const databaseDir = path.join(benchDir, 'pg')
  fs.mkdirSync(benchDir, { recursive: true })
  const server = new EmbeddedPostgres({ databaseDir, user: 'postgres', password: 'postgres', port: PORT, persistent: true, onLog: () => {}, onError: () => {},
    postgresFlags: ['-c', 'shared_buffers=512MB', '-c', 'work_mem=64MB', '-c', 'maintenance_work_mem=256MB', '-c', 'max_connections=40'] })
  // Attach to a cluster another benchmark process already started (the data directory has one owner); only the owner stops it.
  const running = await new Promise((resolve) => { const sock = net.connect(PORT, '127.0.0.1'); sock.on('connect', () => { sock.destroy(); resolve(true) }); sock.on('error', () => resolve(false)) })
  if (!running) {
    if (!fs.existsSync(path.join(databaseDir, 'PG_VERSION'))) await server.initialise()
    await server.start()
  }
  const url = (name) => `postgresql://postgres:postgres@127.0.0.1:${PORT}/${name}`
  const connect = async (name) => { const c = new pg.Client({ connectionString: url(name) }); c.on('error', () => {}); await c.connect(); return c }
  const exists = async (name) => { const a = await connect('postgres'); try { return (await a.query('select 1 from pg_database where datname = $1', [name])).rowCount > 0 } finally { await a.end() } }
  const drop = async (name) => { const a = await connect('postgres'); try { await a.query(`drop database if exists ${name} with (force)`) } finally { await a.end() } }
  const clone = async (from, to) => { await drop(to); const a = await connect('postgres'); try { await a.query(`create database ${to} template ${from}`) } finally { await a.end() } }
  const create = async (name) => { await drop(name); const a = await connect('postgres'); try { await a.query(`create database ${name}`) } finally { await a.end() } }
  return { url, connect, exists, drop, clone, create, stop: async () => { if (!running) await server.stop() } }
}

export function hardware () {
  const cpus = os.cpus()
  return { cpu: cpus[0]?.model, logical_cpus: cpus.length, memory_gb: Math.round(os.totalmem() / 1e8) / 10, platform: `${os.platform()} ${os.release()}`, node: process.version }
}
