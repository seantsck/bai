// A disposable TLS test rig for the Supabase CLI connection tests: a small private PKI (openssl) and several PostgreSQL servers (the embedded PostgreSQL binaries), each presenting a
// different certificate, all on loopback and all requiring a password. LOCAL ONLY: nothing here can reach hosted.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const PASSWORD = 'pw-TEST-secret-9f3a41c7d2'   // distinctive so that a leak into argv or a log is detectable
export const HOST = '127.0.0.2'                       // the name the "good" certificate carries as an IP subject alternative name

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
/** The PostgreSQL binaries the embedded-postgres package ships for this platform (the same ones the other database tests start). */
export function pgBin () {
  const dir = path.join(repoRoot, 'node_modules', '@embedded-postgres', `${process.platform}-${process.arch}`, 'native', 'bin')
  if (!fs.existsSync(path.join(dir, 'postgres'))) throw new Error(`no embedded PostgreSQL binaries at ${dir}`)
  return dir
}
export const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, HOST, () => { const { port } = s.address(); s.close(() => resolve(port)) }) })
const run = (cmd, args, opts = {}) => { const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts }); if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 3).join(' ')}: ${(r.stderr || r.stdout).slice(0, 300)}`); return r }

/** One private PKI: a trusted root A, an untrusted root B, and the server certificates the tests need. */
export function makePki (dir) {
  fs.mkdirSync(dir, { recursive: true })
  const ca = (name) => run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${dir}/${name}.key`, '-out', `${dir}/${name}.crt`, '-subj', `/CN=${name}`, '-days', '400', '-addext', 'basicConstraints=critical,CA:TRUE'], { stdio: 'pipe' })
  const leaf = (name, san, signer) => {
    run('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${dir}/${name}.key`, '-out', `${dir}/${name}.csr`, '-subj', `/CN=${name}`], { stdio: 'pipe' })
    fs.writeFileSync(`${dir}/${name}.ext`, `subjectAltName=${san}\nbasicConstraints=CA:FALSE\n`)
    run('openssl', ['x509', '-req', '-in', `${dir}/${name}.csr`, '-CA', `${dir}/${signer}.crt`, '-CAkey', `${dir}/${signer}.key`, '-CAcreateserial', '-out', `${dir}/${name}.crt`, '-days', '400', '-extfile', `${dir}/${name}.ext`], { stdio: 'pipe' })
  }
  ca('rootA'); ca('rootB')
  leaf('good', `IP:${HOST}`, 'rootA')            // trusted CA, right name
  leaf('wrongname', 'IP:127.0.0.9', 'rootA')     // trusted CA, a different name
  leaf('untrusted', `IP:${HOST}`, 'rootB')       // right name, a CA the client does not trust
  run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${dir}/selfsigned.key`, '-out', `${dir}/selfsigned.crt`, '-subj', '/CN=selfsigned', '-days', '400', '-addext', `subjectAltName=IP:${HOST}`], { stdio: 'pipe' })
  return { dir, rootA: `${dir}/rootA.crt`, rootB: `${dir}/rootB.crt` }
}

/** A PostgreSQL server on HOST:port that requires a password. `cert` names one of the certificates of makePki, or null for a server with TLS switched off. */
export async function startServer (workDir, pki, name, cert, { port = null } = {}) {
  const bin = pgBin(); const env = { ...process.env, LD_LIBRARY_PATH: path.join(bin, '..', 'lib') }
  const data = path.join(workDir, `pg-${name}`); port ??= await freePort()
  const pw = path.join(workDir, 'pw.txt'); fs.writeFileSync(pw, PASSWORD + '\n', { mode: 0o600 })
  run(path.join(bin, 'initdb'), ['-D', data, '-U', 'postgres', '--auth-local=trust', '--auth-host=scram-sha-256', `--pwfile=${pw}`, '--encoding=UTF8'], { env, stdio: 'pipe' })
  fs.writeFileSync(path.join(data, 'pg_hba.conf'), `local all all trust\nhost all all 127.0.0.0/8 scram-sha-256\n`)   // password required with or without TLS
  const args = ['-D', data, '-p', String(port), '-c', `listen_addresses=${HOST}`, '-c', `unix_socket_directories=${workDir}`]
  if (cert) { fs.copyFileSync(path.join(pki.dir, `${cert}.crt`), path.join(data, 'server.crt')); fs.copyFileSync(path.join(pki.dir, `${cert}.key`), path.join(data, 'server.key')); fs.chmodSync(path.join(data, 'server.key'), 0o600); args.push('-c', 'ssl=on', '-c', 'ssl_cert_file=server.crt', '-c', 'ssl_key_file=server.key') } else args.push('-c', 'ssl=off')
  const child = spawn(path.join(bin, 'postgres'), args, { env, stdio: 'ignore' })
  for (let i = 0; i < 100; i++) { const ok = await new Promise((resolve) => { const s = net.connect(port, HOST, () => { s.end(); resolve(true) }); s.on('error', () => resolve(false)) }); if (ok) break; await new Promise((r) => setTimeout(r, 100)) }
  // initdb gives a database 'postgres'; make the connection usable only with the password
  return { name, port, stop: () => new Promise((resolve) => { child.once('exit', resolve); child.kill('SIGINT'); setTimeout(() => child.kill('SIGKILL'), 5000).unref() }) }
}

export const tmpDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix))
