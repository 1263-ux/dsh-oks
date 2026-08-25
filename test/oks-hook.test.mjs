import assert from 'node:assert/strict'
import test from 'node:test'
import { mergeOksRecallTraceHistory, mergeOksRecallTraces, parseOksHookHistory, parseOksHookRecall, toOksRecallTrace } from '../src/oks-hook.ts'

test('parses the OKS-owned automatic recall contract without exposing context in traces', () => {
  const result = parseOksHookRecall(JSON.stringify({
    schema: 'hook-recall-response/v1',
    status: 'injected',
    context: '<recalled-memory>safe for the agent only</recalled-memory>',
    trace: { candidate_count: 2, matches: ['architecture'], top_relevance: 1.25, threshold: 0.7 },
  }))
  assert.ok(result)
  assert.equal(result.context.includes('safe for the agent only'), true)
  const trace = toOksRecallTrace('trace-1', '2026-08-25T00:00:00.000Z', result)
  assert.deepEqual(trace, {
    id: 'trace-1', at: '2026-08-25T00:00:00.000Z', phase: 'pre-step', status: 'ok',
    candidateCount: 2, matches: ['architecture'], topRelevance: 1.25, threshold: 0.7,
  })
  assert.equal(JSON.stringify(trace).includes('safe for the agent only'), false)
})

test('maps policy skips and malformed CLI output safely', () => {
  const skipped = parseOksHookRecall(JSON.stringify({
    schema: 'hook-recall-response/v1', status: 'skipped_minlen', context: '',
    trace: { candidate_count: 0, matches: [], top_relevance: null, threshold: 0.7 },
  }))
  assert.ok(skipped)
  assert.equal(toOksRecallTrace('skip', '2026-08-25T00:00:00.000Z', skipped).status, 'info')
  assert.equal(parseOksHookRecall('{not-json'), null)
  assert.equal(parseOksHookRecall(JSON.stringify({ schema: 'wrong', status: 'injected', context: '', trace: {} })), null)
})

test('validates retained OKS history and deduplicates the current persisted injection', () => {
  const retained = parseOksHookHistory(JSON.stringify({
    schema: 'hook-recall-history/v1',
    items: [{
      id: 'inject-1', at: '2026-08-25T00:00:00Z', phase: 'pre-step', status: 'ok',
      candidate_count: 1, matches: ['architecture', 'C:\\private\\path'], top_relevance: 1.1, threshold: null,
    }],
  }))
  assert.equal(retained.length, 1)
  assert.deepEqual(retained[0].matches, ['architecture'])
  const merged = mergeOksRecallTraces([
    { ...retained[0], id: 'live-1', at: '2026-08-25T00:00:00.123Z' },
  ], retained, 12)
  assert.equal(merged.length, 1)
  assert.equal(merged[0].id, 'live-1')
  assert.equal(mergeOksRecallTraceHistory([
    { ...retained[0], id: 'live-1', at: '2026-08-25T00:00:00.123Z' },
  ], retained, 12).truncated, false)
})

test('marks recall history truncated only when unique retained entries exceed the requested limit', () => {
  const base = { phase: 'pre-step', status: 'ok', candidateCount: 1, matches: ['architecture'] }
  const result = mergeOksRecallTraceHistory([
    { ...base, id: 'live-1', at: '2026-08-25T00:00:02.000Z' },
  ], [
    { ...base, id: 'stored-1', at: '2026-08-25T00:00:01.000Z', matches: ['history'] },
  ], 1)
  assert.equal(result.items.length, 1)
  assert.equal(result.truncated, true)
})
