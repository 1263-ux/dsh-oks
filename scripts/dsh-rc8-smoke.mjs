import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { delimiter, join } from 'node:path'
import { tmpdir } from 'node:os'

const execFileAsync = promisify(execFile)
const root = process.cwd()
const node = process.execPath
const npmCli = join(
  join(node, '..'),
  'node_modules',
  'npm',
  'bin',
  'npm-cli.js',
)
const tempRoot = await mkdtemp(join(tmpdir(), 'dsh-oks-rc8-'))
const runtimeRoot = join(tempRoot, 'runtime')
const artifactRoot = join(tempRoot, 'artifact')
const dshHome = join(tempRoot, 'dsh-home')
await Promise.all([mkdir(runtimeRoot, { recursive: true }), mkdir(artifactRoot), mkdir(dshHome)])

const env = {
  ...process.env,
  DSH_HOME: dshHome,
  PATH: join(runtimeRoot, 'node_modules', '.bin') + delimiter + (process.env.PATH ?? ''),
}

async function run(command, args, cwd, runEnv = env) {
  const result = await execFileAsync(command, args, {
    cwd,
    env: runEnv,
    maxBuffer: 8 * 1024 * 1024,
  })
  return result.stdout
}

async function runNpm(args, cwd, runEnv = env) {
  if (process.platform === 'win32') return run(node, [npmCli, ...args], cwd, runEnv)
  return run('npm', args, cwd, runEnv)
}

async function runDsh(dsh, args, cwd, runEnv = env) {
  return run(node, ['--expose-internals', dsh, ...args], cwd, runEnv)
}

async function installProfile(dsh, archive, profileHome, withSidebar) {
  const profileEnv = { ...env, DSH_HOME: profileHome }
  await runDsh(dsh, ['plugin', '--profile', 'web', 'add', archive], runtimeRoot, profileEnv)
  if (withSidebar) await runDsh(dsh, ['plugin', '--profile', 'web', 'add', 'dsh-better-sidebar@0.15.2'], runtimeRoot, profileEnv)
  const dump = await runDsh(dsh, ['--profile', 'web', '--dump-config'], runtimeRoot, profileEnv)
  if (!dump.trim()) throw new Error(`DSH dump-config returned no output (${withSidebar ? 'with' : 'without'} Sidebar)`)
  return { profileEnv, dumpBytes: Buffer.byteLength(dump) }
}

async function webSmoke(dsh, profileEnv, withSidebar) {
  const child = spawn(node, [
    '--expose-internals',
    dsh,
    '--profile',
    'web',
    '--no-open',
    '--host',
    '127.0.0.1',
    '--port',
    '0',
  ], { cwd: runtimeRoot, env: profileEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  let stderr = ''
  let url
  const collect = (chunk) => {
    output += chunk.toString()
    url ??= output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+)/)?.[1]
  }
  child.stdout.on('data', collect)
  child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
  try {
    const deadline = Date.now() + 15_000
    while (url === void 0 && child.exitCode === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (url === void 0) throw new Error(`DSH Web did not start (${withSidebar ? 'with' : 'without'} Sidebar): ${stderr || output}`)
    const response = await fetch(url)
    const body = await response.text()
    if (!response.ok || !body.includes('DeepSeek Harness')) throw new Error(`DSH Web HTTP smoke failed: ${response.status}`)
    const wsStatuses = await Promise.all(['/api/events.mux', '/api/events.host'].map((path) => new Promise((resolve, reject) => {
      const socket = new WebSocket(url.replace(/^http/, 'ws') + path)
      const timer = setTimeout(() => { socket.close(); reject(new Error(`WebSocket timeout: ${path}`)) }, 5_000)
      socket.addEventListener('open', () => { clearTimeout(timer); socket.close(); resolve('open') })
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`WebSocket failed: ${path}`)) })
    })))
    return { url, http: response.status, ws: wsStatuses }
  } finally {
    child.kill()
    if (child.exitCode === null) await new Promise((resolve) => child.once('close', resolve))
  }
}

try {
  await runNpm(['init', '--yes'], runtimeRoot)
  await runNpm(['install', '--ignore-scripts', '@deepseek-ai/dsh@0.1.0-rc.8', 'pnpm@10.12.4'], runtimeRoot)
  await runNpm(['pack', '--ignore-scripts', '--pack-destination', artifactRoot], root)
  const archive = (await readdir(artifactRoot)).find(name => name.endsWith('.tgz'))
  if (!archive) throw new Error('dsh-oks pack did not produce a tarball')

  const dsh = join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const version = (await runDsh(dsh, ['--version'])).trim()
  const archivePath = join(artifactRoot, archive)
  const profiles = []
  for (const withSidebar of [false, true]) {
    const profileHome = join(dshHome, withSidebar ? 'with-sidebar' : 'without-sidebar')
    await mkdir(profileHome, { recursive: true })
    const { profileEnv, dumpBytes } = await installProfile(dsh, archivePath, profileHome, withSidebar)
    const web = await webSmoke(dsh, profileEnv, withSidebar)
    profiles.push({ withSidebar, dumpBytes, web })
  }
  console.log(JSON.stringify({ dshVersion: version, archive, profiles }))
} finally {
  await rm(tempRoot, { recursive: true, force: true })
}
