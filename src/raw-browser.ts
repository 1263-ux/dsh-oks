/**
 * Read-only Raw Bundle presentation helpers.
 *
 * The OKS CLI VFS owns bundle discovery and file reads. This module only
 * groups bounded VFS entries into the existing browser DTO.
 */
import { cachedOksTree, defaultOksVfs, decodeOksPath, isOksUriUnder, parentOksUri, type OksFsEntry, type OksVfsClient } from './oks-vfs.ts'

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
const MAX_CONCURRENT_BUNDLE_READS = 4
const MAX_BATCH_TOTAL_CHARS = 8 * 1024 * 1024
const RAW_CACHE_TTL_MS = 5_000

interface BundleRecord {
  summary: RawBundleSummary
  manifest: Record<string, unknown>
  files: string[]
  directoryUri: string
  contentUri?: string
  contentTruncated: boolean
}

interface CacheEntry<T> {
  expiresAt: number
  value?: T
  pending?: Promise<T>
}

const rawBundlesCache = new WeakMap<OksVfsClient, CacheEntry<{ bundles: BundleRecord[]; truncated: boolean }>>()

async function cachedFor<T>(cache: WeakMap<OksVfsClient, CacheEntry<T>>, vfs: OksVfsClient, load: () => Promise<T>): Promise<T> {
  const cached = cache.get(vfs)
  if (cached?.value && cached.expiresAt > Date.now()) return cached.value
  if (cached?.pending) return cached.pending
  const pending = load()
    .then(value => {
      cache.set(vfs, { expiresAt: Date.now() + RAW_CACHE_TTL_MS, value })
      return value
    })
    .catch(error => {
      cache.delete(vfs)
      throw error
    })
  cache.set(vfs, { expiresAt: 0, pending })
  return pending
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

async function readBundle(directoryUri: string, entries: OksFsEntry[], vfs: OksVfsClient, includePreview = true): Promise<BundleRecord | undefined> {
  const manifestUri = entries.find(entry => entry.type === 'file' && entry.name.toLowerCase() === 'bundle.json' && parentOksUri(entry.uri) === directoryUri)?.uri
  if (!manifestUri) return undefined
  try {
    const manifestRead = await vfs.read(manifestUri, MAX_MANIFEST_CHARS)
    if (manifestRead.truncated) return undefined
    const manifest = JSON.parse(manifestRead.content) as Record<string, unknown>
    const files = rawFileEntries(entries, directoryUri)
    const contentUri = findContentUri(directoryUri, manifest, files)
    const content = includePreview && contentUri ? await vfs.read(contentUri, MAX_LIST_PREVIEW_CHARS) : { content: '', truncated: false }
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

async function readBundlesBatch(
  directories: string[],
  entries: OksFsEntry[],
  vfs: OksVfsClient,
): Promise<{ bundles: BundleRecord[]; truncated: boolean } | undefined> {
  if (!directories.length || !vfs.readMany) return undefined
  try {
    const manifestByDirectory = new Map(directories.flatMap(directoryUri => {
      const manifestUri = entries.find(entry => entry.type === 'file'
        && entry.name.toLowerCase() === 'bundle.json'
        && parentOksUri(entry.uri) === directoryUri)?.uri
      return manifestUri ? [[directoryUri, manifestUri] as const] : []
    }))
    const manifestUris = [...manifestByDirectory.values()]
    const manifestReads = await vfs.readMany(manifestUris, MAX_MANIFEST_CHARS, MAX_BATCH_TOTAL_CHARS)
    const manifestsByUri = new Map(manifestReads.map(read => [read.uri, read]))
    let truncated = manifestUris.length < directories.length || manifestReads.length < manifestUris.length
    const prepared: Array<{
      directoryUri: string
      manifest: Record<string, unknown>
      files: Map<string, string>
      contentUri?: string
    }> = []

    for (const directoryUri of directories) {
      const manifestUri = manifestByDirectory.get(directoryUri)
      const manifestRead = manifestUri ? manifestsByUri.get(manifestUri) : undefined
      if (!manifestRead || manifestRead.truncated) { truncated = true; continue }
      try {
        const manifest = JSON.parse(manifestRead.content) as Record<string, unknown>
        const files = rawFileEntries(entries, directoryUri)
        prepared.push({
          directoryUri,
          manifest,
          files,
          contentUri: findContentUri(directoryUri, manifest, files),
        })
      } catch {
        truncated = true
      }
    }

    const contentUris = [...new Set(prepared.flatMap(item => item.contentUri ? [item.contentUri] : []))]
    const contentReads = contentUris.length
      ? await vfs.readMany(contentUris, MAX_LIST_PREVIEW_CHARS, MAX_BATCH_TOTAL_CHARS)
      : []
    const contentByUri = new Map(contentReads.map(read => [read.uri, read]))
    truncated ||= contentReads.length < contentUris.length

    const bundles = prepared.map(({ directoryUri, manifest, files, contentUri }) => {
      const content = contentUri ? contentByUri.get(contentUri) : undefined
      if (contentUri && !content) truncated = true
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
          summary: displaySummary(content?.content ?? '') || 'This Raw Bundle has no previewable text.',
        },
        manifest,
        files: [...files.keys()].sort((a, b) => a.localeCompare(b)),
        directoryUri,
        contentUri,
        contentTruncated: content?.truncated ?? false,
      }
    })
    return { bundles, truncated }
  } catch {
    // Older OKS versions do not expose read-many; retain bounded single-read compatibility.
    return undefined
  }
}

async function loadBundles(query: string, vfs: OksVfsClient): Promise<{ bundles: BundleRecord[]; truncated: boolean }> {
  const tree = await cachedOksTree(vfs, RAW_SCOPE, 10, MAX_TREE_ENTRIES)
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
  const directories = candidateUris
    ? bundleRoots.directories.filter(directoryUri => [...candidateUris].some(uri => isOksUriUnder(uri, directoryUri)))
    : bundleRoots.directories
  const batch = await readBundlesBatch(directories, tree.entries, vfs)
  if (batch) {
    bundles.push(...batch.bundles)
    truncated ||= batch.truncated
  } else {
    let nextDirectory = 0
    const readNext = async (): Promise<void> => {
      while (true) {
        const directoryUri = directories[nextDirectory++]
        if (!directoryUri) return
        const bundle = await readBundle(directoryUri, tree.entries, vfs)
        if (bundle) bundles.push(bundle)
      }
    }
    await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_BUNDLE_READS, directories.length) }, () => readNext()))
  }
  bundles.sort((a, b) => b.summary.capturedAt.localeCompare(a.summary.capturedAt) || a.summary.captureId.localeCompare(b.summary.captureId))
  return { bundles, truncated }
}

export async function listRawBundles(filters: RawListFilters = {}, vfs: OksVfsClient = defaultOksVfs): Promise<RawListResult> {
  const query = normalizeFilter(filters.query).toLocaleLowerCase()
  const status = normalizeFilter(filters.status)
  const loaded = query
    ? await loadBundles(query, vfs)
    : await cachedFor(rawBundlesCache, vfs, () => loadBundles('', vfs))
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
  const cached = rawBundlesCache.get(vfs)
  let bundle = cached?.value && cached.expiresAt > Date.now()
    ? cached.value.bundles.find(item => item.summary.id === id)
    : undefined
  if (!bundle) {
    const tree = await cachedOksTree(vfs, RAW_SCOPE, 10, MAX_TREE_ENTRIES)
    const directoryUri = bundleDirectories(tree.entries).directories.find(uri => relativeId(uri) === id)
    if (!directoryUri) return undefined
    bundle = await readBundle(directoryUri, tree.entries, vfs, false)
  }
  if (!bundle) return undefined
  const read = bundle.contentUri ? await vfs.read(bundle.contentUri, MAX_DETAIL_BODY_CHARS_READ) : { content: '', truncated: false }
  const body = read.content.slice(0, MAX_DETAIL_BODY_CHARS)
  return {
    ...bundle.summary,
    summary: displaySummary(read.content) || bundle.summary.summary,
    body,
    bodyTruncated: read.truncated || read.content.length > MAX_DETAIL_BODY_CHARS,
  }
}

export async function countRawBundles(vfs: OksVfsClient = defaultOksVfs): Promise<number> {
  return (await listRawBundles({}, vfs)).total
}
