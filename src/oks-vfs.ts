import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolveOksBin } from './oks-runtime.ts'

const execFileAsync = promisify(execFile)
const FS_SCHEMA = 'oks-fs-response/v1'
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024

export interface OksFsEntry {
  name: string
  type: 'directory' | 'file' | 'special' | string
  uri: string
}

export interface OksFsTree {
  uri: string
  entries: OksFsEntry[]
  depth: number
  truncated: boolean
}

export interface OksFsRead {
  uri: string
  content: string
  offset: number
  returned_chars: number
  total_chars: number
  truncated: boolean
  next_offset: number | null
}

export interface OksFsOverview {
  uri: string
  directories: OksFsEntry[]
  files: OksFsEntry[]
  counts: Record<string, number>
  index_uri: string | null
}

export interface OksFsFind {
  uri: string
  query: string
  matches: Array<{ uri: string; match: string; snippet: string }>
  skipped_count: number
  truncated: boolean
}

export interface OksVfsClient {
  tree(uri: string, depth: number, maxEntries: number): Promise<OksFsTree>
  read(uri: string, limit: number): Promise<OksFsRead>
  overview(uri: string): Promise<OksFsOverview>
  find(query: string, under: string, maxResults: number): Promise<OksFsFind>
}

export class OksVfsError extends Error {
  readonly code: string

  constructor(message: string, code = 'CLI_ERROR') {
    super(message)
    this.code = code
    this.name = 'OksVfsError'
  }
}

export type OksCommandRunner = (args: string[]) => Promise<string>

async function runOksCommand(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(resolveOksBin(), args, {
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: MAX_OUTPUT_BYTES,
      env: { ...process.env },
    })
    return stdout
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : 'unknown CLI error'
    throw new OksVfsError(`OKS CLI request failed: ${detail}`)
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OksVfsError('OKS CLI returned a non-object JSON response.', 'INVALID_RESPONSE')
  }
  return value as Record<string, unknown>
}

function entryArray(value: unknown): OksFsEntry[] {
  if (!Array.isArray(value)) return []
  return value.filter(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false
    const entry = item as Record<string, unknown>
    return typeof entry.name === 'string' && typeof entry.type === 'string' && typeof entry.uri === 'string'
  }) as OksFsEntry[]
}

function matchArray(value: unknown): Array<{ uri: string; match: string; snippet: string }> {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const match = item as Record<string, unknown>
    if (typeof match.uri !== 'string') return []
    return [{
      uri: match.uri,
      match: typeof match.match === 'string' ? match.match : '',
      snippet: typeof match.snippet === 'string' ? match.snippet : '',
    }]
  })
}

function parseJsonResponse(stdout: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw new OksVfsError('OKS CLI returned invalid JSON.', 'INVALID_RESPONSE')
  }
  const payload = asRecord(parsed)
  if (payload.schema_version !== FS_SCHEMA) {
    throw new OksVfsError('OKS CLI returned an unsupported VFS schema.', 'UNSUPPORTED_SCHEMA')
  }
  if (payload.error && typeof payload.error === 'object') {
    const error = asRecord(payload.error)
    const code = typeof error.code === 'string' ? error.code : 'CLI_ERROR'
    const message = typeof error.message === 'string' ? error.message : 'OKS VFS request failed.'
    throw new OksVfsError(message, code)
  }
  return asRecord(payload.result)
}

function uriPath(uri: string, scope: string): string[] | undefined {
  const prefix = `oks://${scope}/`
  if (!uri.startsWith(prefix)) return undefined
  const raw = uri.slice(prefix.length).replace(/\/$/, '')
  if (!raw) return []
  const parts = raw.split('/').map(part => {
    try { return decodeURIComponent(part) } catch { return '' }
  })
  if (parts.some(part => !part || part === '.' || part === '..' || part.includes('\\'))) return undefined
  return parts
}

export function isOksUriUnder(uri: string, parent: string): boolean {
  const normalizedParent = parent.endsWith('/') ? parent : `${parent}/`
  return uri === parent || uri.startsWith(normalizedParent)
}

export function parentOksUri(uri: string): string | undefined {
  const clean = uri.endsWith('/') ? uri.slice(0, -1) : uri
  const slash = clean.lastIndexOf('/')
  if (slash < 'oks://x/'.length) return undefined
  return `${clean.slice(0, slash + 1)}`
}

export function childOksUri(scope: string, path: string): string | undefined {
  const parts = path.split('/')
  if (!parts.length || parts.some(part => !part || part === '.' || part === '..' || part.includes('\\'))) return undefined
  return `oks://${scope}/${parts.map(part => encodeURIComponent(part)).join('/')}`
}

export function decodeOksPath(uri: string, scope: string): string | undefined {
  const parts = uriPath(uri, scope)
  return parts?.join('/')
}

export function createOksVfs(run: OksCommandRunner = runOksCommand): OksVfsClient {
  async function request(args: string[]): Promise<Record<string, unknown>> {
    return parseJsonResponse(await run(args))
  }

  return {
    async tree(uri, depth, maxEntries) {
      const result = await request(['fs', 'tree', uri, '--depth', String(depth), '--max-entries', String(maxEntries), '--format', 'json'])
      return {
        uri: typeof result.uri === 'string' ? result.uri : uri,
        entries: entryArray(result.entries),
        depth: typeof result.depth === 'number' ? result.depth : depth,
        truncated: result.truncated === true,
      }
    },
    async read(uri, limit) {
      const result = await request(['fs', 'read', uri, '--limit', String(limit), '--format', 'json'])
      return {
        uri: typeof result.uri === 'string' ? result.uri : uri,
        content: typeof result.content === 'string' ? result.content : '',
        offset: typeof result.offset === 'number' ? result.offset : 0,
        returned_chars: typeof result.returned_chars === 'number' ? result.returned_chars : 0,
        total_chars: typeof result.total_chars === 'number' ? result.total_chars : 0,
        truncated: result.truncated === true,
        next_offset: typeof result.next_offset === 'number' ? result.next_offset : null,
      }
    },
    async overview(uri) {
      const result = await request(['fs', 'overview', uri, '--format', 'json'])
      return {
        uri: typeof result.uri === 'string' ? result.uri : uri,
        directories: entryArray(result.directories),
        files: entryArray(result.files),
        counts: result.counts && typeof result.counts === 'object' ? result.counts as Record<string, number> : {},
        index_uri: typeof result.index_uri === 'string' ? result.index_uri : null,
      }
    },
    async find(query, under, maxResults) {
      const result = await request(['fs', 'find', query, '--under', under, '--max-results', String(maxResults), '--format', 'json'])
      return {
        uri: typeof result.uri === 'string' ? result.uri : under,
        query: typeof result.query === 'string' ? result.query : query,
        matches: matchArray(result.matches),
        skipped_count: typeof result.skipped_count === 'number' ? result.skipped_count : 0,
        truncated: result.truncated === true,
      }
    },
  }
}

export const defaultOksVfs = createOksVfs()
