/**
 * Read-only Wiki/Draft presentation helpers.
 *
 * Discovery, search, path validation, and file reads belong to the external
 * OKS CLI VFS. This module only turns bounded CLI documents into the stable
 * DTO consumed by the DSH browser.
 */
import { cachedOksTree, defaultOksVfs, childOksUri, decodeOksPath, type OksFsEntry, type OksVfsClient, OksVfsError } from './oks-vfs.ts'

export interface WikiListFilters { query?: string; area?: string; type?: string }
export interface WikiSummary { slug: string; title: string; area: string; type: string; summary: string; created: string }
export interface WikiDetail extends WikiSummary { body: string; bodyTruncated: boolean }
export interface WikiListResult { total: number; items: WikiSummary[]; areas: string[]; types: string[]; truncated?: boolean }

const MAX_QUERY_CHARS = 120
const MAX_DETAIL_BODY_CHARS = 60_000
const MAX_MARKDOWN_READ_CHARS = 512 * 1024
const MAX_TOTAL_READ_CHARS = 8 * 1024 * 1024
const MAX_MARKDOWN_FILES = 1_000
const MAX_TREE_ENTRIES = 10_000
const MAX_CONCURRENT_MARKDOWN_READS = 4

function text(value: unknown): string { return typeof value === 'string' ? value.trim() : '' }
function normalizeFilter(value: unknown): string { return text(value).slice(0, MAX_QUERY_CHARS) }
function yamlScalar(value: string): string {
  const trimmed = value.trim()
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) return trimmed.slice(1, -1)
  return trimmed.replace(/\s+#.*$/, '').trim()
}
function readFrontmatter(source: string): { meta: Record<string, string>; body: string } {
  const normalized = source.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) return { meta: {}, body: normalized }
  const closeAt = normalized.indexOf('\n---', 4)
  if (closeAt < 0) return { meta: {}, body: normalized }
  const meta: Record<string, string> = {}
  for (const line of normalized.slice(4, closeAt).split('\n')) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line)
    if (match) meta[match[1]] = yamlScalar(match[2])
  }
  return { meta, body: normalized.slice(closeAt + 4).replace(/^\n/, '') }
}
function displaySummary(markdown: string): string {
  const plain = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^[#>*\-+\d.\s]+/gm, ' ')
    .replace(/[|`*_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length <= 220 ? plain : `${plain.slice(0, 217).trimEnd()}…`
}
function titleFromBody(body: string): string { return /^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? '' }
function comparePages(a: WikiSummary, b: WikiSummary): number { return b.created.localeCompare(a.created) || a.title.localeCompare(b.title, 'zh-Hans-CN') }
function markdownEntries(tree: { entries: OksFsEntry[] }): { entries: OksFsEntry[]; truncated: boolean } {
  const markdown = tree.entries.filter(entry => entry.type === 'file' && entry.name.toLowerCase().endsWith('.md'))
  return { entries: markdown.slice(0, MAX_MARKDOWN_FILES), truncated: markdown.length > MAX_MARKDOWN_FILES }
}
function summaryFromSource(scope: 'wiki' | 'drafts', uri: string, source: string): WikiSummary {
  const { meta, body } = readFrontmatter(source)
  const slug = decodeOksPath(uri, scope)?.replace(/\.md$/i, '') ?? ''
  return {
    slug,
    title: meta.title || titleFromBody(body) || slug.split('/').at(-1) || slug,
    area: meta.area || '未分类',
    type: meta.type || '未分类',
    summary: displaySummary(body) || '暂无正文摘要。',
    created: meta.created || '',
  }
}

async function readMarkdownEntries(
  entries: OksFsEntry[],
  vfs: OksVfsClient,
): Promise<{ reads: Map<string, { content: string; returned_chars: number; truncated: boolean }>; truncated: boolean }> {
  if (entries.length && vfs.readMany) {
    try {
      const items = await vfs.readMany(
        entries.map(entry => entry.uri),
        MAX_MARKDOWN_READ_CHARS,
        MAX_TOTAL_READ_CHARS,
      )
      return {
        reads: new Map(items.map(item => [item.uri, item])),
        truncated: items.length < entries.length || items.some(item => item.truncated),
      }
    } catch {
      // Older OKS versions do not expose read-many; retain bounded single-read compatibility.
    }
  }

  const reads = new Map<string, { content: string; returned_chars: number; truncated: boolean }>()
  let truncated = false
  let nextEntry = 0
  let reservedChars = 0
  const readNext = async (): Promise<void> => {
    while (true) {
      const entry = entries[nextEntry++]
      if (!entry) return
      const remaining = MAX_TOTAL_READ_CHARS - reservedChars
      if (remaining <= 0) { truncated = true; return }
      const limit = Math.min(MAX_MARKDOWN_READ_CHARS, remaining)
      reservedChars += limit
      const read = await vfs.read(entry.uri, limit)
      reservedChars -= Math.max(0, limit - Math.min(limit, read.returned_chars))
      truncated ||= read.truncated
      reads.set(entry.uri, read)
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_MARKDOWN_READS, entries.length) }, () => readNext()))
  return { reads, truncated }
}

async function readMarkdownList(scope: 'wiki' | 'drafts', filters: WikiListFilters, vfs: OksVfsClient): Promise<WikiListResult> {
  const tree = await cachedOksTree(vfs, `oks://${scope}/`, 10, MAX_TREE_ENTRIES)
  const discovered = markdownEntries(tree)
  const entries = discovered.entries
  const normalizedQuery = normalizeFilter(filters.query)
  let truncated = tree.truncated || discovered.truncated
  let matched: Set<string> | undefined
  if (normalizedQuery) {
    const found = await vfs.find(normalizedQuery, `oks://${scope}/`, 200)
    matched = new Set(found.matches.map(item => item.uri))
    truncated ||= found.truncated
  }
  const pages: WikiSummary[] = []
  const allPages: WikiSummary[] = []
  const loaded = await readMarkdownEntries(entries, vfs)
  truncated ||= loaded.truncated
  for (const entry of entries) {
    const read = loaded.reads.get(entry.uri)
    if (!read) continue
    const page = summaryFromSource(scope, entry.uri, read.content)
    allPages.push(page)
    if ((!matched || matched.has(entry.uri))
      && (!normalizeFilter(filters.area) || page.area === normalizeFilter(filters.area))
      && (!normalizeFilter(filters.type) || page.type === normalizeFilter(filters.type))) {
      pages.push(page)
    }
  }
  pages.sort(comparePages)
  allPages.sort(comparePages)
  const metadataPages = allPages.length ? allPages : entries.map(entry => ({ slug: decodeOksPath(entry.uri, scope) ?? '', title: '', area: '未分类', type: '未分类', summary: '', created: '' }))
  return {
    total: allPages.length,
    items: pages,
    areas: [...new Set(metadataPages.map(page => page.area))].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')),
    types: [...new Set(metadataPages.map(page => page.type))].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')),
    ...(truncated ? { truncated: true } : {}),
  }
}

async function readMarkdownPage(scope: 'wiki' | 'drafts', requestedSlug: unknown, vfs: OksVfsClient): Promise<WikiDetail | undefined> {
  const slug = normalizeFilter(requestedSlug)
  if (!slug || slug.toLowerCase().endsWith('.md')) return undefined
  const uri = childOksUri(scope, `${slug}.md`)
  if (!uri) return undefined
  try {
    const read = await vfs.read(uri, MAX_MARKDOWN_READ_CHARS)
    const { body } = readFrontmatter(read.content)
    return {
      ...summaryFromSource(scope, uri, read.content),
      body: body.slice(0, MAX_DETAIL_BODY_CHARS),
      bodyTruncated: read.truncated || body.length > MAX_DETAIL_BODY_CHARS,
    }
  } catch (error) {
    if (error instanceof OksVfsError && error.code === 'PATH_NOT_FOUND') return undefined
    throw error
  }
}

export function listMarkdownPages(filters: WikiListFilters = {}, vfs: OksVfsClient = defaultOksVfs): Promise<WikiListResult> {
  return readMarkdownList('wiki', filters, vfs)
}
export function getMarkdownPage(requestedSlug: unknown, vfs: OksVfsClient = defaultOksVfs): Promise<WikiDetail | undefined> {
  return readMarkdownPage('wiki', requestedSlug, vfs)
}
export function listWikiPages(filters: WikiListFilters = {}, vfs: OksVfsClient = defaultOksVfs): Promise<WikiListResult> {
  return readMarkdownList('wiki', filters, vfs)
}
export function getWikiPage(requestedSlug: unknown, vfs: OksVfsClient = defaultOksVfs): Promise<WikiDetail | undefined> {
  return readMarkdownPage('wiki', requestedSlug, vfs)
}
export function listDraftPages(filters: WikiListFilters = {}, vfs: OksVfsClient = defaultOksVfs): Promise<WikiListResult> {
  return readMarkdownList('drafts', filters, vfs)
}
export function getDraftPage(requestedSlug: unknown, vfs: OksVfsClient = defaultOksVfs): Promise<WikiDetail | undefined> {
  return readMarkdownPage('drafts', requestedSlug, vfs)
}
