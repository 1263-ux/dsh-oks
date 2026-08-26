import assert from 'node:assert/strict'
import test from 'node:test'
import { getOksDiagnostics, getOksOverview } from '../src/oks-overview.ts'
import { isPrestepRecallEnabled } from '../src/prestep-control.ts'
import { createFakeVfs, oksUri } from './fake-oks-vfs.mjs'

test('counts Wiki, Draft, and Raw lifecycle files without exposing paths', async () => {
  const overview = await getOksOverview(createFakeVfs({
    [oksUri('wiki', 'computing/one.md')]: '# one',
    [oksUri('wiki', 'two.txt')]: 'ignored',
    [oksUri('drafts', 'candidate.md')]: '# draft',
    [oksUri('drafts', 'notes.txt')]: 'ignored',
    [oksUri('raw', '2026/08/source.json')]: '{}',
    [oksUri('raw', '2026/08/source.md')]: '# raw',
    [oksUri('raw', '.gitkeep')]: '',
  }))
  assert.deepEqual(overview, { connected: true, wikiCount: 1, draftCount: 1, rawFileCount: 2, rawBundleCount: 0 })
  assert.equal(JSON.stringify(overview).includes('oks://'), false)
})

test('counts Raw bundles from tree metadata without reading bundle previews', async () => {
  const reads = []
  const base = createFakeVfs({
    [oksUri('raw', '2026/08/bundle-1/bundle.json')]: '{}',
    [oksUri('raw', '2026/08/bundle-1/content.md')]: '# preview',
  })
  const vfs = { ...base, read: async (uri, limit) => { reads.push(uri); return base.read(uri, limit) } }
  const overview = await getOksOverview(vfs)
  assert.equal(overview.rawBundleCount, 1)
  assert.deepEqual(reads, [])
})

test('automatic pre-step recall defaults on and can be disabled', () => {
  assert.equal(isPrestepRecallEnabled({}), true)
  assert.equal(isPrestepRecallEnabled({ prestep_enabled: true }), true)
  assert.equal(isPrestepRecallEnabled({ prestep_enabled: false }), false)
})

test('diagnostics classifies missing CLI and unconfigured knowledge base without paths', async () => {
  const missingCli = await getOksDiagnostics('', false)
  assert.equal(missingCli.status, 'oks-not-installed')
  assert.equal(missingCli.connected, false)
  assert.equal(JSON.stringify(missingCli).includes('knowledge_base_path'), false)
  const notConfigured = await getOksDiagnostics('', true)
  assert.equal(notConfigured.status, 'not-configured')
  assert.equal(notConfigured.connected, false)
})

test('diagnostics reports a complete OKS VFS and current counts', async () => {
  const diagnostics = await getOksDiagnostics('/configured/only-used-as-a-flag', true, createFakeVfs({
    [oksUri('wiki', 'one.md')]: '# one',
    [oksUri('drafts', 'one.md')]: '# draft',
    [oksUri('raw', 'one.json')]: '{}',
  }))
  assert.equal(diagnostics.status, 'connected')
  assert.equal(diagnostics.connected, true)
  assert.deepEqual([diagnostics.wikiCount, diagnostics.draftCount, diagnostics.rawFileCount, diagnostics.rawBundleCount], [1, 1, 1, 0])
  assert.equal(JSON.stringify(diagnostics).includes('/configured'), false)
})

test('bounds overview file scans and reports truncation without exposing paths', async () => {
  const files = Object.fromEntries(Array.from({ length: 1_005 }, (_, index) => [oksUri('wiki', `page-${index}.md`), '# page']))
  const overview = await getOksOverview(createFakeVfs(files))
  assert.equal(overview.truncated, true)
  assert.equal(overview.wikiCount <= 1_000, true)
  assert.equal(JSON.stringify(overview).includes('oks://'), false)
})
