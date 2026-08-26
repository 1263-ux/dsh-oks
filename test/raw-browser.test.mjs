import assert from 'node:assert/strict'
import test from 'node:test'
import { getRawBundle, listRawBundles } from '../src/raw-browser.ts'
import { createFakeVfs, oksUri, withFakeReadMany } from './fake-oks-vfs.mjs'

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

test('lists Raw bundles through two generic OKS batch reads when available', async () => {
  const calls = []
  const vfs = withFakeReadMany(createFixture(), call => calls.push(call))

  const listed = await listRawBundles({}, vfs)

  assert.equal(listed.total, 2)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].uris.every(uri => uri.endsWith('/bundle.json')), true)
  assert.equal(calls[1].uris.every(uri => uri.endsWith('/content.md') || uri.endsWith('/raw.md')), true)
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

test('opens a discovered Raw Bundle without rescanning every bundle preview', async () => {
  const base = createFixture()
  const reads = []
  const vfs = { ...base, read: async (uri, limit) => { reads.push(uri); return base.read(uri, limit) } }
  const detail = await getRawBundle('2026/08/19/agent-capture/bundle-a', vfs)
  assert.equal(detail?.captureId, 'capture-a')
  assert.deepEqual(reads, [
    oksUri('raw', '2026/08/19/agent-capture/bundle-a/bundle.json'),
    oksUri('raw', '2026/08/19/agent-capture/bundle-a/content.md'),
  ])
})

test('bounds concurrent Raw preview reads and reuses the short-lived list cache', async () => {
  const files = {}
  for (let index = 0; index < 8; index += 1) {
    const base = `2026/08/19/bulk/bundle-${index}`
    files[oksUri('raw', `${base}/bundle.json`)] = JSON.stringify({ bundle_id: `bundle:${index}`, capture_id: `capture-${index}`, files: { content: 'content.md' } })
    files[oksUri('raw', `${base}/content.md`)] = `preview ${index}`
  }
  const base = createFakeVfs(files)
  let active = 0
  let maxActive = 0
  let reads = 0
  const vfs = {
    ...base,
    read: async (uri, limit) => {
      reads += 1
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise(resolve => setTimeout(resolve, 2))
      try { return await base.read(uri, limit) } finally { active -= 1 }
    },
  }
  assert.equal((await listRawBundles({}, vfs)).total, 8)
  const readsAfterFirstList = reads
  assert.equal(maxActive > 1, true)
  assert.equal(maxActive <= 4, true)
  assert.equal((await listRawBundles({}, vfs)).total, 8)
  assert.equal(reads, readsAfterFirstList)
})

test('bounds Raw preview reads while preserving detail truncation semantics', async () => {
  const listed = await listRawBundles({}, createFixture('A'.repeat(140_000)))
  assert.equal(listed.items[0].summary.length <= 220, true)
  const detail = await getRawBundle(listed.items[0].id, createFixture('A'.repeat(140_000)))
  assert.equal(detail?.body.length, 60_000)
  assert.equal(detail?.bodyTruncated, true)
})

test('does not mark a complete detail body truncated only because its list preview was bounded', async () => {
  const vfs = createFixture('A'.repeat(20_000))
  const listed = await listRawBundles({}, vfs)
  const detail = await getRawBundle(listed.items[0].id, vfs)
  assert.equal(detail?.body.length, 20_000)
  assert.equal(detail?.bodyTruncated, false)
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
