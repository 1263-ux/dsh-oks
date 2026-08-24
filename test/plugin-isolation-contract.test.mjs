import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('browser entry remains namespaced and removable without host DOM coupling', async () => {
  const source = await readFile(new URL('../src/client/index.ts', import.meta.url), 'utf8')
  assert.match(source, /settings\.plugin\.item/)
  assert.match(source, /settings\.section/)
  assert.match(source, /namespace: 'oks'/)
  assert.doesNotMatch(source, /document\.(querySelector|getElementById|body)/)
  assert.doesNotMatch(source, /window\.(location|history)\./)
  assert.match(source, /export const inject = \['slots', 'locale', 'connection', 'remote', 'settingsScope'\]/)
  assert.match(source, /ctx\.plugin\(\{[\s\S]*name: 'dsh-oks-sidebar',[\s\S]*inject: \['betterSidebar'\]/)
  assert.match(source, /ctx\.get\('betterSidebar', false\)/)
})

test('post-tool signal delegates relevance filtering to the OKS CLI floor', async () => {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
  assert.match(source, /OKS CLI --floor is authoritative/)
  assert.match(source, /parseSignal\(out, query, floor, activeConfig\.posttool_signal_rel_floor\)/)
  assert.doesNotMatch(source, /topRelevance.*signalRelFloor/)
})

test('compiled post-tool signal keeps normalized fts5 relevance despite legacy threshold', async () => {
  const { parseSignal } = await import('../lib/index.mjs')
  const result = parseSignal(JSON.stringify({
    knowledge: [{ slug: 'fts5-hit', title: 'FTS5 hit', type: 'wiki', relevance: 0.95 }],
  }), 'query', 0.9, 2.5)
  assert.deepEqual(result?.slugs, ['fts5-hit'])
})

test('host activity surface is bounded and does not expose raw prompt paths', async () => {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
  assert.match(source, /endpoint === 'activity'/)
  assert.match(source, /events\.length = 50/)
  assert.match(source, /replace\(\/\[\\r\\n\]\+\/g, ' '\)/)
  assert.match(source, /safeTraceLabel/)
  assert.doesNotMatch(source, /traces\[0\]/)
  assert.match(source, /updateTrace\(traceId/)
  assert.doesNotMatch(source, /return \{ ok: true, value: .*messages/)
})
