/**
 * Read-only Raw Bundle presentation helpers.
 *
 * The OKS CLI VFS owns bundle discovery and file reads. This module only
 * groups bounded VFS entries into the existing browser DTO.
 */
import { defaultOksVfs, decodeOksPath, isOksUriUnder, parentOksUri, type OksFsEntry, type OksVfsClient } from './oks-vfs.ts'

export interface RawListFilters { query?: string; status?: string }
export interface RawBundleSummary {
  id: string
  bundleId: string
  captureId: string
  capturedAt: string
  status: string
  sourceType: string
  fileCount: number
  summary: string
}
export interface RawBundleDetail extends RawBundleSummary {
  body: string
  bodyTruncated: boolean
}
export interface RawListResult {
  total: number
  items: RawBundleSummary[]
  statuses: string[]
  truncated: boolean
}

const RAW_SCOPE = 'oks://raw/'
const MAX_QUERY_CHARS = 120
const MAX_DETAIL_BODY_CHARS = 60_000
const MAX_LIST_PREVIEW_CHARS = 16 * 1024
const MAX_DETAIL_BODY_CHARS_READ = 128 * 1024
const MAX_MANIFEST_CHARS = 256 * 1024
const MAX_TREE_ENTRIES = 10_000
const MAX_BUNDLES = 250

interface BundleRecord {
  summary: RawBundleSummary
  manifest: Record<string, unknown>
  files: string[]
  directoryUri: string
  contentUri?: string
  contentTruncated: boolean
}

function text(value: unknown): string { return typeof value === 'string' ? value.trim() : '' }
function normalizeFilter(value: unknown): string { return text(value).slice(0, MAX_QUERY_CHARS) }
function displaySummary(markdown: string): string {
  const plain = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^[#>*\-+\d.\s]+/gm, ' ')
    .replace(/[|`*_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length <= 220 ? plain : `${plain.slice(0, 217).trimEnd()}...`
}
function dateFromId(id: string, manifest: Record<string, unknown>): string {
  const match = /(^|\/)(\d{4})\/(\d{2})\/(\d{2})(\/|$)/.exec(id)
  if (match) return `${match[2]}-${match[3]}-${match[4]}`
  const provenance = manifest.provenance
  if (provenance && typeof provenance === 'object' && Array.isArray((provenance as { activities?: unknown }).activities)) {
    const started = (provenance as { activities: Array<{ started_at?: unknown }> }).activities.find(item => typeof item?.started_at === 'string')?.started_at
    if (started) return String(started).slice(0, 10)
  }
  return ''
}
function sourceTypeFromManifest(manifest: Record<string, unknown>): string {
  const sources = manifest.sources
  if (Array.isArray(sources)) {
    const first = sources.find(item => item && typeof item === 'object') as { media_type?: unknown; snapshot_kind?: unknown } | undefined
    const mediaType = text(first?.media_type)
    if (mediaType) return mediaType
    const snapshotKind = text(first?.snapshot_kind)
    if (snapshotKind) return snapshotKind
  }
  return 'unlabeled'
}
function relativeId(directoryUri: string): string {
  return decodeOksPath(directoryUri, 'raw') ?? ''
}
function relativeFilePath(directoryUri: string, fileUri: string): string | undefined {
  const directory = relativeId(directoryUri)
  const file = decodeOksPath(fileUri, 'raw')
  if (!file || !directory || !file.startsWith(`${directory}/`)) return undefined
  return file.slice(directory.length + 1)
}
function findContentUri(directoryUri: string, manifest: Record<string, unknown>, files: Map<string, string>): string | undefined {
  const declared = text((manifest.files as Record<string, unknown> | undefined)?.content)
  if (declared && !declared.includes('..') && !declared.includes('\\')) return files.get(declared)
  return files.get('content.md') ?? files.get('raw.md')
}
function rawFileEntries(entries: OksFsEntry[], directoryUri: string): Map<string, string> {
  const files = new Map<string, string>()
  for (const entry of entries) {
    if (entry.type !== 'file' || !isOksUriUnder(entry.uri, directoryUri)) continue
    const relative = relativeFilePath(directoryUri, entry.uri)
    if (relative) files.set(relative, entry.uri)
  }
  return files
}
function bundleDirectories(entries: OksFsEntry[]): { directories: string[]; truncated: boolean } {
  const roots = entries
    .filter(entry => entry.type === 'file' && entry.name.toLowerCase() === 'bundle.json')
    .map(entry => parentOksUri(entry.uri))
    .filter((uri): uri is string => Boolean(uri))
  const directories = [...new Set(roots)]
  return { directories: directories.slice(0, MAX_BUNDLES), truncated: directories.length > MAX_BUNDLES }
}

async function readBundle(directoryUri: string, entries: OksFsEntry[], vfs: OksVfsClient): Promise<BundleRecord | undefined> {
  const manifestUri = entries.find(entry => entry.type === 'file' && entry.name.toLowerCase() === 'bundle.json' && parentOksUri(entry.uri) === directoryUri)?.uri
  if (!manifestUri) return undefined
  try {
    const manifestRead = await vfs.read(manifestUri, MAX_MANIFEST_CHARS)
    if (manifestRead.truncated) return undefined
    const manifest = JSON.parse(manifestRead.content) as Record<string, unknown>
    const files = rawFileEntries(entries, directoryUri)
    const contentUri = findContentUri(directoryUri, manifest, files)
    const content = contentUri ? await vfs.read(contentUri, MAX_LIST_PREVIEW_CHARS) : { content: '', truncated: false }
    const id = relativeId(directoryUri)
    const bundleId = text(manifest.bundle_id) || id
    const captureId = text(manifest.capture_id) || bundleId
    const status = text(manifest.processing_status) || 'unknown'
    return {
      summary: {
        id,
        bundleId,
        captureId,
        capturedAt: dateFromId(id, manifest),
        status,
        sourceType: sourceTypeFromManifest(manifest),
        fileCount: files.size,
        summary: displaySummary(content.content) || 'This Raw Bundle has no previewable text.',
      },
      manifest,
      files: [...files.keys()].sort((a, b) => a.localeCompare(b)),
      directoryUri,
      contentUri,
      contentTruncated: content.truncated,
    }
  } catch {
    return undefined
  }
}

async function loadBundles(query: string, vfs: OksVfsClient): Promise<{ bundles: BundleRecord[]; truncated: boolean }> {
  const tree = await vfs.tree(RAW_SCOPE, 10, MAX_TREE_ENTRIES)
  let candidateUris: Set<string> | undefined
  let truncated = tree.truncated
  if (query) {
    const found = await vfs.find(query, RAW_SCOPE, 200)
    candidateUris = new Set(found.matches.map(match => match.uri))
    truncated ||= found.truncated
  }
  const bundles: BundleRecord[] = []
  const bundleRoots = bundleDirectories(tree.entries)
  truncated ||= bundleRoots.truncated
  for (const directoryUri of bundleRoots.directories) {
    if (candidateUris && ![...candidateUris].some(uri => isOksUriUnder(uri, directoryUri))) continue
    const bundle = await readBundle(directoryUri, tree.entries, vfs)
    if (bundle) bundles.push(bundle)
  }
  bundles.sort((a, b) => b.summary.capturedAt.localeCompare(a.summary.capturedAt) || a.summary.captureId.localeCompare(b.summary.captureId))
  return { bundles, truncated }
}

export async function listRawBundles(filters: RawListFilters = {}, vfs: OksVfsClient = defaultOksVfs): Promise<RawListResult> {
  const query = normalizeFilter(filters.query).toLocaleLowerCase()
  const status = normalizeFilter(filters.status)
  const loaded = await loadBundles(query, vfs)
  const items = loaded.bundles.map(item => item.summary).filter(item => !status || item.status === status)
  return {
    total: loaded.bundles.length,
    items,
    statuses: [...new Set(loaded.bundles.map(item => item.summary.status))].sort((a, b) => a.localeCompare(b)),
    truncated: loaded.truncated,
  }
}

export async function getRawBundle(requestedId: unknown, vfs: OksVfsClient = defaultOksVfs): Promise<RawBundleDetail | undefined> {
  const id = normalizeFilter(requestedId)
  if (!id || id.includes('\\') || id.split('/').some(part => !part || part === '.' || part === '..')) return undefined
  const loaded = await loadBundles('', vfs)
  const bundle = loaded.bundles.find(item => item.summary.id === id)
  if (!bundle) return undefined
  const read = bundle.contentUri ? await vfs.read(bundle.contentUri, MAX_DETAIL_BODY_CHARS_READ) : { content: '', truncated: false }
  const body = read.content.slice(0, MAX_DETAIL_BODY_CHARS)
  return { ...bundle.summary, body, bodyTruncated: bundle.contentTruncated || read.truncated || read.content.length > MAX_DETAIL_BODY_CHARS }
}

export async function countRawBundles(vfs: OksVfsClient = defaultOksVfs): Promise<number> {
  return (await listRawBundles({}, vfs)).total
}
