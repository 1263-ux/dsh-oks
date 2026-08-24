import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { delimiter, join } from 'node:path'
import { tmpdir } from 'node:os'

const execFileAsync = promisify(execFile)
const root = process.cwd()
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const binName = process.platform === 'win32' ? 'dsh.cmd' : 'dsh'
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

async function run(command, args, cwd) {
  const result = await execFileAsync(command, args, {
    cwd,
    env,
    maxBuffer: 8 * 1024 * 1024,
  })
  return result.stdout
}

try {
  await run(npm, ['init', '--yes'], runtimeRoot)
  await run(npm, ['install', '--ignore-scripts', '@deepseek-ai/dsh@0.1.0-rc.8', 'pnpm@10.12.4'], runtimeRoot)
  await run(npm, ['pack', '--ignore-scripts', '--pack-destination', artifactRoot], root)
  const archive = (await readdir(artifactRoot)).find(name => name.endsWith('.tgz'))
  if (!archive) throw new Error('dsh-oks pack did not produce a tarball')

  const dsh = join(runtimeRoot, 'node_modules', '.bin', binName)
  const version = (await run(dsh, ['--version'], runtimeRoot)).trim()
  await run(dsh, ['plugin', '--profile', 'web', 'add', join(artifactRoot, archive)], runtimeRoot)
  await run(dsh, ['plugin', '--profile', 'web', 'add', 'dsh-better-sidebar@0.15.2'], runtimeRoot)
  const dump = await run(dsh, ['--profile', 'web', '--dump-config'], runtimeRoot)
  if (!dump.trim()) throw new Error('DSH dump-config returned no output')
  console.log(JSON.stringify({ dshVersion: version, archive, dumpBytes: Buffer.byteLength(dump) }))
} finally {
  await rm(tempRoot, { recursive: true, force: true })
}
