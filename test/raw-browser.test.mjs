import assert from 'node:assert/strict'
import test from 'node:test'
import { getRawBundle, listRawBundles } from '../src/raw-browser.ts'
import { createFakeVfs, oksUri } from './fake-oks-vfs.mjs'

function createFixture(contentA = '# Raw A\n\nSensitive local-path text is not a response field.') {
  return createFakeVfs({
    [oksUri('raw', '2026/08/19/agent-capture/bundle-a/bundle.json')]: JSON.stringify({ bundle_id: 'bundle:a', capture_id: 'capture-a', processing_status: 'complete', files: { content: 'content.md' }, sources: [{ media_type: 'text/markdown' }] }),
    [oksUri('raw', '2026/08/19/agent-capture/bundle-a/content.md')]: contentA,
    [oksUri('raw', '2026/08/19/agent-capture/bundle-a/evidence.jsonl')]: '{}\n',
    [oksUri('raw', '2026/08/18/web/bundle-b/bundle.json')]: JSON.stringify({ bundle_id: 'bundle:b', capture_id: 'capture-b', processing_status: 'pending', files: { content: 'raw.md' }, sources: [{ snapshot_kind: 'content' }] }),
    [oksUri('raw', '2026/08/18/web/bundle-b/raw.md')]: '# Raw B\n\nAwaiting processing.',
  })
}

test('lists Raw Bundle v0.2 evidence by bundle rather than raw file', async () => {
  const vfs = createFixture()
  const all = await listRawBundles({}, vfs)
  assert.equal(all.total, 2)
  assert.deepEqual(all.items.map(item => item.captureId), ['capture-a', 'capture-b'])
  assert.deepEqual(all.items.map(item => item.fileCount), [3, 2])
  assert.deepEqual(all.statuses, ['complete', 'pending'])
  assert.equal(JSON.stringify(all).includes('oks://'), false)
  assert.deepEqual((await listRawBundles({ query: 'capture-b' }, vfs)).items.map(item => item.bundleId), ['bundle:b'])
  assert.deepEqual((await listRawBundles({ status: 'complete' }, vfs)).items.map(item => item.captureId), ['capture-a'])
})

test('reads only a server-discovered Raw Bundle and rejects traversal', async () => {
  const vfs = createFixture()
  const listed = await listRawBundles({}, vfs)
  const detail = await getRawBundle(listed.items[0].id, vfs)
  assert.equal(detail?.captureId, 'capture-a')
  assert.match(detail?.body ?? '', /Raw A/)
  assert.equal('files' in (detail ?? {}), false)
  assert.equal(JSON.stringify(detail).includes('oks://'), false)
  assert.equal(await getRawBundle('../wiki/secret', vfs), undefined)
  assert.equal(await getRawBundle('2026/08/19/agent-capture/../bundle-a', vfs), undefined)
  assert.equal(await getRawBundle('C:/anything', vfs), undefined)
})

test('bounds Raw preview reads while preserving detail truncation semantics', async () => {
  const listed = await listRawBundles({}, createFixture('A'.repeat(140_000)))
  assert.equal(listed.items[0].summary.length <= 220, true)
  const detail = await getRawBundle(listed.items[0].id, createFixture('A'.repeat(140_000)))
  assert.equal(detail?.body.length, 60_000)
  assert.equal(detail?.bodyTruncated, true)
})

test('bounds Raw Bundle discovery and marks a truncated scan', async () => {
  const files = {}
  for (let index = 0; index < 251; index += 1) {
    const base = `2026/08/19/bulk/bundle-${String(index).padStart(3, '0')}`
    files[oksUri('raw', `${base}/bundle.json`)] = JSON.stringify({ bundle_id: `bundle:${index}`, capture_id: `capture-${index}`, processing_status: 'complete', files: { content: 'content.md' } })
    files[oksUri('raw', `${base}/content.md`)] = 'bounded fixture'
  }
  const listed = await listRawBundles({}, createFakeVfs(files))
  assert.equal(listed.total, 250)
  assert.equal(listed.items.length, 250)
  assert.equal(listed.truncated, true)
})

test('skips an oversized Raw manifest instead of reading it unbounded', async () => {
  const files = {
    [oksUri('raw', '2026/08/19/agent-capture/bundle-a/bundle.json')]: JSON.stringify({ bundle_id: 'bundle:a', capture_id: 'capture-a', processing_status: 'complete', files: { content: 'content.md' } }),
    [oksUri('raw', '2026/08/19/agent-capture/bundle-a/content.md')]: 'content',
    [oksUri('raw', '2026/08/20/oversized/bundle-c/bundle.json')]: `{"bundle_id":"oversized","padding":"${'x'.repeat(300_000)}"}`,
  }
  const listed = await listRawBundles({}, createFakeVfs(files))
  assert.equal(listed.items.some(item => item.captureId === 'oversized'), false)
})
