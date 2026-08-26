import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('pre-step Recall delegates policy and retained history to the OKS Hook CLI', async () => {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
  assert.match(source, /\['hook', 'history', '--format', 'json'/)
  assert.match(source, /\['hook', 'recall', query, '--format', 'json', \.\.\.hookScopeArgs\(\)\]/)
  assert.doesNotMatch(source, /\['hook', 'history',[\s\S]*process\.cwd\(\)/)
  assert.equal(source.includes('query.length < 10'), false)
  assert.equal(source.includes('prestep_floor'), false)
  assert.equal(source.includes('prestep_knowledge_only'), false)
})
