import { existsSync, realpathSync } from 'node:fs'
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { delimiter, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const execFileAsync = promisify(execFile)
const root = process.cwd()
const node = process.execPath
const runtimeNode = process.env.DSH_RC8_NODE ?? node
const keepWeb = process.env.DSH_RC8_KEEP_WEB === '1'
const installTimeoutMs = 120_000
const pnpmCli = join(
  dirname(node),
  '..',
  'node_modules',
  'pnpm',
  'bin',
  'pnpm.mjs',
)
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const tempRoot = await mkdtemp(join(tmpdir(), 'dsh-oks-rc8-'))
const runtimeRoot = join(tempRoot, 'runtime')
const artifactRoot = join(tempRoot, 'artifact')
const dshHome = join(tempRoot, 'dsh-home')
const rc8BuildPolicy = {
  '@deepseek-ai/dsh-subprocess-local': true,
  '@google/genai': true,
  koffi: true,
  'node-pty': true,
  protobufjs: true,
}
const hostOptionalDependencies = `supportedArchitectures:\n  os:\n    - ${process.platform}\n  cpu:\n    - ${process.arch}\n`
await Promise.all([mkdir(runtimeRoot, { recursive: true }), mkdir(artifactRoot), mkdir(dshHome)])

function cleanPath(value) {
  return value.split(delimiter).filter(entry => !/^[a-z]:\\Kaifa-tool\\Apps\\deepseek(?:\\|$)/i.test(entry)).join(delimiter)
}

const env = {
  ...process.env,
  DSH_HOME: dshHome,
  PATH: join(runtimeRoot, 'node_modules', '.bin') + delimiter + dirname(runtimeNode) + delimiter + cleanPath(process.env.PATH ?? ''),
}

async function run(command, args, cwd, runEnv = env, timeout = 30_000) {
  const result = await execFileAsync(command, args, {
    cwd,
    env: runEnv,
    timeout,
    maxBuffer: 8 * 1024 * 1024,
  })
  return result.stdout
}

async function runNpm(args, cwd, runEnv = env) {
  if (existsSync(pnpmCli)) return run(runtimeNode, [pnpmCli, ...args], cwd, runEnv, installTimeoutMs)
  return run(pnpmCommand, args, cwd, runEnv, installTimeoutMs)
}

async function runDsh(dsh, args, cwd, runEnv = env, timeout = 30_000) {
  return run(runtimeNode, ['--expose-internals', dsh, ...args], cwd, runEnv, timeout)
}

async function installProfile(dsh, archive, profileHome) {
  const profileEnv = { ...env, DSH_HOME: profileHome }
  await runDsh(dsh, ['plugin', '--profile', 'web', 'add', archive], runtimeRoot, profileEnv)
  const dump = await runDsh(dsh, ['--profile', 'web', '--dump-config'], runtimeRoot, profileEnv)
  if (!dump.trim()) throw new Error('DSH dump-config returned no output')
  return { profileEnv, dumpBytes: Buffer.byteLength(dump) }
}

async function webSmoke(dsh, profileEnv, holdOpen = false) {
  const child = spawn(runtimeNode, [
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
    if (url === void 0) throw new Error(`DSH Web did not start: ${stderr || output}`)
    const response = await fetch(url)
    const body = await response.text()
    if (!response.ok || !body.includes('DeepSeek Harness')) throw new Error(`DSH Web HTTP smoke failed: ${response.status}`)
    const wsStatuses = await Promise.all(['/api/events.mux', '/api/events.host'].map((path) => new Promise((resolve, reject) => {
      const socket = new WebSocket(url.replace(/^http/, 'ws') + path)
      const timer = setTimeout(() => { socket.close(); reject(new Error(`WebSocket timeout: ${path}`)) }, 5_000)
      socket.addEventListener('open', () => { clearTimeout(timer); socket.close(); resolve('open') })
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`WebSocket failed: ${path}`)) })
    })))
    return { url, http: response.status, ws: wsStatuses, child }
  } finally {
    if (!holdOpen) {
      child.kill()
      if (child.exitCode === null) await new Promise((resolve) => child.once('close', resolve))
    }
  }
}

function assertLocalRuntime(dsh) {
  const resolved = realpathSync(dsh)
  if (!resolved.startsWith(runtimeRoot)) throw new Error(`DSH resolved outside isolated runtime: ${resolved}`)
  if (/^[a-z]:\\Kaifa-tool\\Apps\\deepseek(?:\\|$)/i.test(resolved)) throw new Error(`Legacy DSH path leaked into isolated runtime: ${resolved}`)
}

try {
  if (!existsSync(runtimeNode)) throw new Error(`DSH_RC8_NODE does not exist: ${runtimeNode}`)
  const runtimeVersion = (await run(runtimeNode, ['--version'], root)).trim()
  if (!/^v22\./.test(runtimeVersion)) throw new Error(`DSH rc.8 Web acceptance requires Node 22 (received ${runtimeVersion}). Set DSH_RC8_NODE to a Node 22 executable.`)
  await writeFile(join(runtimeRoot, 'package.json'), JSON.stringify({
    private: true,
  }) + '\n', 'utf8')
  await writeFile(join(runtimeRoot, 'pnpm-workspace.yaml'), `${hostOptionalDependencies}allowBuilds:\n${Object.entries(rc8BuildPolicy).map(([name, allowed]) => `  ${JSON.stringify(name)}: ${allowed}`).join('\n')}\n`, 'utf8')
  console.error('[dsh-rc8-smoke] install isolated DSH rc.8 runtime')
  await runNpm(['add', '--reporter=append-only', '@deepseek-ai/dsh@0.1.0-rc.8', 'pnpm@10.12.4'], runtimeRoot)
  console.error('[dsh-rc8-smoke] pack dsh-oks')
  await runNpm(['pack', '--pack-destination', artifactRoot], root)
  const archive = (await readdir(artifactRoot)).find(name => name.endsWith('.tgz'))
  if (!archive) throw new Error('dsh-oks pack did not produce a tarball')

  const dsh = join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  assertLocalRuntime(dsh)
  const version = (await runDsh(dsh, ['--version'])).trim()
  if (version !== '0.1.0-rc.8') throw new Error(`Expected DSH 0.1.0-rc.8, got ${version}`)
  const archivePath = join(artifactRoot, archive)
  const profiles = []
  for (const profileName of ['web']) {
    const profileHome = join(dshHome, profileName)
    await mkdir(profileHome, { recursive: true })
    const { profileEnv, dumpBytes } = await installProfile(dsh, archivePath, profileHome)
    const web = await webSmoke(dsh, profileEnv, keepWeb)
    profiles.push({ profile: profileName, dumpBytes, web: { url: web.url, http: web.http, ws: web.ws } })
    if (keepWeb) {
      console.log(JSON.stringify({ dshVersion: version, archive, profiles, ready: true }))
      await new Promise(resolve => {
        const stop = () => { web.child.kill(); resolve() }
        process.once('SIGINT', stop)
        process.once('SIGTERM', stop)
        web.child.once('close', resolve)
      })
    }
  }
  if (!keepWeb) console.log(JSON.stringify({ dshVersion: version, archive, profiles }))
} finally {
  // Windows can retain a profile directory briefly after the Web child exits.
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
}
