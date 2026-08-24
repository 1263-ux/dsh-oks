import assert from 'node:assert/strict'
import test from 'node:test'
import { getDraftPage, getWikiPage, listDraftPages, listWikiPages } from '../src/wiki-browser.ts'
import { createFakeVfs, oksUri } from './fake-oks-vfs.mjs'

const wikiFiles = {
  [oksUri('wiki', 'engineering/rpc.md')]: ['---', 'title: RPC boundary', 'type: strategy', 'area: engineering', 'created: 2026-08-19', '---', '', '# RPC boundary', '', 'The client cannot receive the local path. Deep evidence keyword: boundary-proof.'].join('\n'),
  [oksUri('wiki', 'welcome.md')]: ['---', 'title: Team welcome', 'type: concept', 'area: teamwork', 'created: 2026-08-18', '---', '', 'Welcome to the knowledge base.'].join('\n'),
}

test('lists Wiki pages with metadata, CLI full-text search, and filters', async () => {
  const vfs = createFakeVfs(wikiFiles)
  const all = await listWikiPages({}, vfs)
  assert.equal(all.total, 2)
  assert.deepEqual(all.items.map(page => page.slug), ['engineering/rpc', 'welcome'])
  assert.deepEqual(all.areas, ['engineering', 'teamwork'])
  assert.deepEqual(all.types, ['concept', 'strategy'])
  assert.equal(all.items[0].title, 'RPC boundary')
  assert.match(all.items[0].summary, /client cannot receive/)
  assert.deepEqual((await listWikiPages({ query: 'boundary-proof' }, vfs)).items.map(page => page.slug), ['engineering/rpc'])
  assert.deepEqual((await listWikiPages({ area: 'teamwork', type: 'concept' }, vfs)).items.map(page => page.slug), ['welcome'])
})

test('loads a known slug only and prevents traversal', async () => {
  const vfs = createFakeVfs(wikiFiles)
  const detail = await getWikiPage('engineering/rpc', vfs)
  assert.equal(detail?.title, 'RPC boundary')
  assert.match(detail?.body ?? '', /boundary-proof/)
  assert.equal(await getWikiPage('../settings/recall', vfs), undefined)
  assert.equal(await getWikiPage('engineering/rpc.md', vfs), undefined)
})

test('lists and loads Draft pages separately from Wiki', async () => {
  const vfs = createFakeVfs({
    [oksUri('drafts', 'review/candidate.md')]: ['---', 'title: Candidate', 'type: strategy', 'area: engineering', 'status: provisional', '---', '', '# AI candidate', '', 'Pending human review; not part of formal recall.'].join('\n'),
  })
  const drafts = await listDraftPages({}, vfs)
  assert.equal(drafts.total, 1)
  assert.equal(drafts.items[0].slug, 'review/candidate')
  assert.equal(drafts.items[0].title, 'Candidate')
  assert.equal((await getDraftPage('review/candidate', vfs))?.body.includes('Pending human review'), true)
  assert.equal(await getDraftPage('../wiki/welcome', vfs), undefined)
})

test('returns an empty list without a Wiki directory', async () => {
  assert.deepEqual(await listWikiPages({}, createFakeVfs({})), { total: 0, items: [], areas: [], types: [] })
})

test('truncates a very long page body', async () => {
  const detail = await getWikiPage('long', createFakeVfs({ [oksUri('wiki', 'long.md')]: `---\ntitle: Long page\n---\n\n${'x'.repeat(60_100)}` }))
  assert.equal(detail?.body.length, 60_000)
  assert.equal(detail?.bodyTruncated, true)
})

test('bounds large markdown reads and exposes a partial-scan marker', async () => {
  const vfs = createFakeVfs({ [oksUri('wiki', 'large.md')]: `---\ntitle: Large page\n---\n\n${'x'.repeat(600_000)}` })
  const list = await listWikiPages({}, vfs)
  assert.equal(list.total, 1)
  assert.equal(list.truncated, true)
  const detail = await getWikiPage('large', vfs)
  assert.equal(detail?.bodyTruncated, true)
  assert.equal(detail?.body.length, 60_000)
})

test('caps page discovery instead of reading an unbounded tree', async () => {
  const files = Object.fromEntries(Array.from({ length: 1_005 }, (_, index) => [oksUri('wiki', `page-${String(index).padStart(4, '0')}.md`), `# page ${index}`]))
  const list = await listWikiPages({}, createFakeVfs(files))
  assert.equal(list.total, 1_000)
  assert.equal(list.truncated, true)
})
