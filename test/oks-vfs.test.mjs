import assert from 'node:assert/strict'
import test from 'node:test'
import { childOksUri, createOksVfs, decodeOksPath, isOksUriUnder, OksVfsError, parentOksUri } from '../src/oks-vfs.ts'

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
