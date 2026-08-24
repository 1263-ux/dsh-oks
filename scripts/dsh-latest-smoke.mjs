import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
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
const tempRoot = await mkdtemp(join(tmpdir(), 'dsh-oks-latest-'))
const runtimeRoot = join(tempRoot, 'runtime')
const artifactRoot = join(tempRoot, 'artifact')
const dshHome = join(tempRoot, 'dsh-home')
await Promise.all([mkdir(runtimeRoot, { recursive: true }), mkdir(artifactRoot), mkdir(dshHome)])

const env = {
  ...process.env,
  DSH_HOME: dshHome,
  PATH: join(runtimeRoot, 'node_modules', '.bin') + delimiter + (process.env.PATH ?? ''),
}

async function run(command, args, cwd) {
  const result = await execFileAsync(command, args, { cwd, env, maxBuffer: 8 * 1024 * 1024 })
  return result.stdout
}

async function runNpm(args, cwd) {
  if (process.platform === 'win32') return run(node, [npmCli, ...args], cwd)
  return run('npm', args, cwd)
}

try {
  await runNpm(['init', '--yes'], runtimeRoot)
  await runNpm(['install', '--ignore-scripts', '--legacy-peer-deps', '@deepseek-ai/dsh@latest', 'pnpm@11.19.0'], runtimeRoot)
  await runNpm(['pack', '--ignore-scripts', '--pack-destination', artifactRoot], root)
  const archive = (await readdir(artifactRoot)).find(name => name.endsWith('.tgz'))
  if (!archive) throw new Error('dsh-oks pack did not produce a tarball')

  const dsh = join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const runDsh = (args) => run(node, [dsh, ...args], runtimeRoot)
  const version = (await runDsh(['--version'])).trim()
  await runDsh(['plugin', '--profile', 'web', 'add', join(artifactRoot, archive)])
  await runDsh(['plugin', '--profile', 'web', 'add', 'dsh-better-sidebar@0.15.2'])
  const dump = await runDsh(['--profile', 'web', '--dump-config'])
  if (!dump.trim()) throw new Error('latest DSH dump-config returned no output')
  console.log(JSON.stringify({ dshVersion: version, archive, dumpBytes: Buffer.byteLength(dump), track: 'latest-advisory' }))
} finally {
  await rm(tempRoot, { recursive: true, force: true })
}
