import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.cwd()
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const expected = ['lib/index.mjs', 'lib/client.js']
const entryValues = [packageJson.main, packageJson.exports?.['.']?.default, packageJson.exports?.['./client']?.default]
if (entryValues.some(value => typeof value !== 'string' || !expected.includes(value.replace(/^\.\//, '')))) {
  throw new Error(`production entries must resolve to ${expected.join(' and ')}`)
}
for (const file of expected) {
  const source = await readFile(join(root, file), 'utf8')
  if (/\b(?:import|export)\s[^\n]*src\/[^\n]*\.ts\b/.test(source)) {
    throw new Error(`${file} contains a production import from src/**/*.ts`)
  }
}
console.log(JSON.stringify({ entries: entryValues, sourceImports: 'none' }))
