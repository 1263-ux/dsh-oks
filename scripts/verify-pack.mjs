import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const managers = process.platform === 'win32' ? ['npm.cmd', 'pnpm.cmd'] : ['npm', 'pnpm']
let stdout = ''
let lastError
for (const manager of managers) {
  try {
    const packArgs = manager.startsWith('pnpm')
      ? ['pack', '--dry-run', '--json']
      : ['pack', '--dry-run', '--json', '--ignore-scripts']
    const command = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : manager
    const commandArgs = process.platform === 'win32'
      ? ['/d', '/s', '/c', [manager, ...packArgs].join(' ')]
      : packArgs
    const result = await execFileAsync(command, commandArgs, {
      cwd: process.cwd(),
      maxBuffer: 1024 * 1024,
    })
    stdout = result.stdout
    break
  } catch (error) {
    lastError = error
  }
}
if (!stdout) throw lastError

const jsonStart = Math.max(stdout.lastIndexOf('\n['), stdout.lastIndexOf('\n{'))
const parsed = JSON.parse(jsonStart >= 0 ? stdout.slice(jsonStart + 1) : stdout)
const reports = Array.isArray(parsed) ? parsed : [parsed]
const files = reports.flatMap(report => report.files ?? []).map(file => file.path)
const required = ['lib/client.js', 'lib/index.mjs', 'package.json']
const forbidden = files.filter(file => /^src\//.test(file) || /\.map$/.test(file))
const missing = required.filter(file => !files.includes(file))
if (forbidden.length || missing.length) {
  throw new Error(`invalid package contents; forbidden=${JSON.stringify(forbidden)} missing=${JSON.stringify(missing)}`)
}
console.log(JSON.stringify({ files, forbidden, missing }))
