import assert from 'node:assert/strict'
import test from 'node:test'
import { cachedOksTree, childOksUri, createOksVfs, decodeOksPath, isOksUriUnder, OksVfsError, parentOksUri } from '../src/oks-vfs.ts'

test('executes bounded JSON VFS requests and preserves the CLI contract', async () => {
  const calls = []
  const vfs = createOksVfs(async args => {
    calls.push(args)
    return JSON.stringify({ schema_version: 'oks-fs-response/v1', result: { uri: 'oks://wiki/', entries: [], depth: 10, truncated: false } })
  })
  const result = await vfs.tree('oks://wiki/', 10, 1000)
  assert.deepEqual(result.entries, [])
  assert.deepEqual(calls[0], ['fs', 'tree', 'oks://wiki/', '--depth', '10', '--max-entries', '1000', '--format', 'json'])
})

test('executes one bounded read-many request and parses ordered items', async () => {
  const calls = []
  const vfs = createOksVfs(async args => {
    calls.push(args)
    return JSON.stringify({
      schema_version: 'oks-fs-response/v1',
      result: {
        uri: 'oks://',
        items: [
          { uri: 'oks://wiki/a.md', content: 'a', offset: 0, returned_chars: 1, total_chars: 1, truncated: false, next_offset: null },
          { uri: 'oks://wiki/b.md', content: 'bb', offset: 0, returned_chars: 2, total_chars: 2, truncated: false, next_offset: null },
        ],
      },
    })
  })

  const result = await vfs.readMany(['oks://wiki/a.md', 'oks://wiki/b.md'], 20_000, 100_000)

  assert.deepEqual(result.map(item => item.content), ['a', 'bb'])
  assert.deepEqual(calls[0], [
    'fs', 'read-many', 'oks://wiki/a.md', 'oks://wiki/b.md',
    '--limit', '20000', '--max-total-chars', '100000', '--format', 'json',
  ])
})

test('rejects unsupported envelopes and exposes stable error codes', async () => {
  const unsupported = createOksVfs(async () => JSON.stringify({ schema_version: 'other/v1', result: {} }))
  await assert.rejects(() => unsupported.tree('oks://wiki/', 1, 1), error => error instanceof OksVfsError && error.code === 'UNSUPPORTED_SCHEMA')
  const failed = createOksVfs(async () => JSON.stringify({ schema_version: 'oks-fs-response/v1', error: { code: 'PATH_NOT_FOUND', message: 'missing' } }))
  await assert.rejects(() => failed.read('oks://wiki/missing.md', 10), error => error instanceof OksVfsError && error.code === 'PATH_NOT_FOUND')
})

test('keeps URI traversal and sibling-prefix boundaries explicit', () => {
  assert.equal(childOksUri('wiki', 'engineering/rpc.md'), 'oks://wiki/engineering/rpc.md')
  assert.equal(childOksUri('wiki', '../secrets'), undefined)
  assert.equal(childOksUri('wiki', 'engineering/../secrets'), undefined)
  assert.equal(decodeOksPath('oks://wiki/engineering/rpc.md', 'wiki'), 'engineering/rpc.md')
  assert.equal(isOksUriUnder('oks://wiki/engineering/rpc.md', 'oks://wiki/engineering'), true)
  assert.equal(isOksUriUnder('oks://wiki/engineering-old/rpc.md', 'oks://wiki/engineering'), false)
  assert.equal(parentOksUri('oks://raw/2026/08/bundle/bundle.json'), 'oks://raw/2026/08/bundle/')
})

test('coalesces identical short-lived tree scans without persisting VFS data', async () => {
  let treeCalls = 0
  const vfs = {
    tree: async () => {
      treeCalls += 1
      await new Promise(resolve => setTimeout(resolve, 2))
      return { uri: 'oks://raw/', entries: [], depth: 10, truncated: false }
    },
  }
  const [first, second] = await Promise.all([
    cachedOksTree(vfs, 'oks://raw/', 10, 10_000),
    cachedOksTree(vfs, 'oks://raw/', 10, 10_000),
  ])
  const third = await cachedOksTree(vfs, 'oks://raw/', 10, 10_000)

  assert.equal(first.uri, 'oks://raw/')
  assert.equal(second.uri, 'oks://raw/')
  assert.equal(third.uri, 'oks://raw/')
  assert.equal(treeCalls, 1)
})
