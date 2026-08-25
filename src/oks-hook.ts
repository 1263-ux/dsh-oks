export type OksTraceStatus = 'ok' | 'info' | 'empty' | 'error'

export interface OksRecallTrace {
  id: string
  at: string
  phase: string
  status: OksTraceStatus
  candidateCount: number
  matches: string[]
  topRelevance?: number
  threshold?: number
}

export interface OksHookRecall {
  status: 'skipped_minlen' | 'skipped_cooldown' | 'empty' | 'injected' | 'error'
  context: string
  trace: {
    candidateCount: number
    matches: string[]
    topRelevance?: number
    threshold?: number
  }
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function safeTraceLabel(value: unknown): string {
  const label = String(value ?? '').trim()
  return /^[-_\.\p{L}\p{N}]{1,120}$/u.test(label) ? label : '[知识条目]'
}

function validStatus(value: unknown): value is OksHookRecall['status'] {
  return value === 'skipped_minlen' || value === 'skipped_cooldown' || value === 'empty' || value === 'injected' || value === 'error'
}

/** Parse the narrow JSON contract exposed by `oks hook recall --format json`. */
export function parseOksHookRecall(stdout: string): OksHookRecall | null {
  try {
    const data = JSON.parse(stdout) as Record<string, unknown>
    if (data.schema !== 'hook-recall-response/v1' || !validStatus(data.status) || typeof data.context !== 'string') return null
    const trace = data.trace
    if (!trace || typeof trace !== 'object') return null
    const raw = trace as Record<string, unknown>
    const count = finiteNumber(raw.candidate_count)
    const rawMatches = Array.isArray(raw.matches) ? raw.matches : []
    return {
      status: data.status,
      context: data.context,
      trace: {
        candidateCount: Math.max(0, Math.floor(count ?? 0)),
        matches: rawMatches.map(safeTraceLabel).filter(value => value !== '[知识条目]').slice(0, 12),
        topRelevance: finiteNumber(raw.top_relevance),
        threshold: finiteNumber(raw.threshold),
      },
    }
  } catch {
    return null
  }
}

function uiStatus(status: OksHookRecall['status']): OksTraceStatus {
  if (status === 'injected') return 'ok'
  if (status === 'error') return 'error'
  if (status === 'empty') return 'empty'
  return 'info'
}

/** Map OKS-owned hook state to the pre-existing panel DTO without prompt/body data. */
export function toOksRecallTrace(id: string, at: string, result: OksHookRecall): OksRecallTrace {
  return {
    id,
    at,
    phase: 'pre-step',
    status: uiStatus(result.status),
    candidateCount: result.trace.candidateCount,
    matches: result.trace.matches,
    topRelevance: result.trace.topRelevance,
    threshold: result.trace.threshold,
  }
}

/** Validate retained OKS history before it crosses the Host-to-browser RPC boundary. */
export function parseOksHookHistory(stdout: string): OksRecallTrace[] {
  try {
    const data = JSON.parse(stdout) as Record<string, unknown>
    if (data.schema !== 'hook-recall-history/v1' || !Array.isArray(data.items)) return []
    return data.items.flatMap((item): OksRecallTrace[] => {
      if (!item || typeof item !== 'object') return []
      const raw = item as Record<string, unknown>
      if (typeof raw.id !== 'string' || typeof raw.at !== 'string' || raw.phase !== 'pre-step') return []
      const count = finiteNumber(raw.candidate_count)
      const matches = Array.isArray(raw.matches) ? raw.matches.map(safeTraceLabel).filter(value => value !== '[知识条目]').slice(0, 12) : []
      return [{
        id: raw.id,
        at: raw.at,
        phase: 'pre-step',
        status: raw.status === 'ok' ? 'ok' : 'info',
        candidateCount: Math.max(0, Math.floor(count ?? 0)),
        matches,
        topRelevance: finiteNumber(raw.top_relevance),
        threshold: finiteNumber(raw.threshold),
      }]
    })
  } catch {
    return []
  }
}

/** Prefer fresh Host events but avoid showing the same persisted injection twice. */
export function mergeOksRecallTraceHistory(live: OksRecallTrace[], retained: OksRecallTrace[], limit: number): { items: OksRecallTrace[]; truncated: boolean } {
  const seen = new Set<string>()
  const unique = [...live, ...retained]
    .sort((a, b) => {
      const left = Date.parse(a.at)
      const right = Date.parse(b.at)
      if (Number.isFinite(left) && Number.isFinite(right)) return right - left
      return b.at.localeCompare(a.at)
    })
    .filter(item => {
      const key = `${item.phase}|${item.at.slice(0, 19)}|${item.matches.join(',')}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  return { items: unique.slice(0, limit), truncated: unique.length > limit }
}

/** Backward-compatible convenience for callers that need only the entries. */
export function mergeOksRecallTraces(live: OksRecallTrace[], retained: OksRecallTrace[], limit: number): OksRecallTrace[] {
  return mergeOksRecallTraceHistory(live, retained, limit).items
}
