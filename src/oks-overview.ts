/** Read-only lifecycle diagnostics backed by the OKS CLI VFS. */
import { cachedOksTree, defaultOksVfs, parentOksUri, type OksFsTree, type OksVfsClient } from './oks-vfs.ts'

export interface OksOverview {
  connected: true
  wikiCount: number
  draftCount: number
  rawFileCount: number
  rawBundleCount: number
  truncated?: boolean
}

export type OksConnectionStatus =
  | 'connected'
  | 'oks-not-installed'
  | 'not-configured'
  | 'not-initialized'
  | 'partial'
  | 'read-error'

export interface OksDiagnostics {
  connected: boolean
  status: OksConnectionStatus
  message: string
  oksCliAvailable: boolean
  knowledgeBaseConfigured: boolean
  wikiDirectory: boolean
  draftsDirectory: boolean
  rawDirectory: boolean
  wikiCount: number
  draftCount: number
  rawFileCount: number
  rawBundleCount: number
  truncated?: boolean
}

type LifecycleSnapshot = { overview: OksOverview; wikiDirectory: boolean; draftsDirectory: boolean; rawDirectory: boolean }

const LIFECYCLE_CACHE_TTL_MS = 5_000
const lifecycleCache = new WeakMap<OksVfsClient, { expiresAt: number; value?: LifecycleSnapshot; pending?: Promise<LifecycleSnapshot> }>()

function countRawBundles(tree: OksFsTree | undefined): number {
  if (!tree) return 0
  return new Set(
    tree.entries
      .filter(entry => entry.type === 'file' && entry.name.toLowerCase() === 'bundle.json')
      .map(entry => parentOksUri(entry.uri))
      .filter((uri): uri is string => Boolean(uri)),
  ).size
}

async function collectLifecycleCounts(vfs: OksVfsClient): Promise<LifecycleSnapshot> {
  const scopes = await Promise.allSettled([
    cachedOksTree(vfs, 'oks://wiki/', 10, 1_000),
    cachedOksTree(vfs, 'oks://drafts/', 10, 1_000),
    cachedOksTree(vfs, 'oks://raw/', 10, 10_000),
  ])
  const wiki = scopes[0].status === 'fulfilled' ? scopes[0].value : undefined
  const drafts = scopes[1].status === 'fulfilled' ? scopes[1].value : undefined
  const raw = scopes[2].status === 'fulfilled' ? scopes[2].value : undefined
  if (!wiki && !drafts && !raw) throw new Error('OKS VFS scopes are unavailable')
  const wikiFiles = wiki?.entries.filter(entry => entry.type === 'file' && entry.name.toLowerCase().endsWith('.md')).length ?? 0
  const draftFiles = drafts?.entries.filter(entry => entry.type === 'file' && entry.name.toLowerCase().endsWith('.md')).length ?? 0
  const rawFiles = raw?.entries.filter(entry => entry.type === 'file' && entry.name !== '.gitkeep').length ?? 0
  const truncated = Boolean(wiki?.truncated || drafts?.truncated || raw?.truncated)
  return {
    overview: { connected: true, wikiCount: wikiFiles, draftCount: draftFiles, rawFileCount: rawFiles, rawBundleCount: countRawBundles(raw), ...(truncated ? { truncated: true } : {}) },
    wikiDirectory: Boolean(wiki),
    draftsDirectory: Boolean(drafts),
    rawDirectory: Boolean(raw),
  }
}

async function lifecycleCounts(vfs: OksVfsClient): Promise<LifecycleSnapshot> {
  const now = Date.now()
  const cached = lifecycleCache.get(vfs)
  if (cached?.value && cached.expiresAt > now) return cached.value
  if (cached?.pending) return cached.pending
  const pending = collectLifecycleCounts(vfs)
    .then(value => {
      lifecycleCache.set(vfs, { expiresAt: Date.now() + LIFECYCLE_CACHE_TTL_MS, value })
      return value
    })
    .catch(error => {
      lifecycleCache.delete(vfs)
      throw error
    })
  lifecycleCache.set(vfs, { expiresAt: 0, pending })
  return pending
}

export async function getOksOverview(vfs: OksVfsClient = defaultOksVfs): Promise<OksOverview> {
  return (await lifecycleCounts(vfs)).overview
}

/** Classify first-use connectivity without exposing the local root path. */
export async function getOksDiagnostics(knowledgeBasePath: string, oksCliAvailable: boolean, vfs: OksVfsClient = defaultOksVfs): Promise<OksDiagnostics> {
  const empty = { wikiCount: 0, draftCount: 0, rawFileCount: 0, rawBundleCount: 0, wikiDirectory: false, draftsDirectory: false, rawDirectory: false }
  if (!oksCliAvailable) return { connected: false, status: 'oks-not-installed', message: '未检测到 OKS 命令。请先安装 OKS CLI，然后重新打开 DSH。', oksCliAvailable: false, knowledgeBaseConfigured: Boolean(knowledgeBasePath), ...empty }
  if (!knowledgeBasePath) return { connected: false, status: 'not-configured', message: '已检测到 OKS，但还没有连接知识库。请在系统设置中配置知识库位置。', oksCliAvailable: true, knowledgeBaseConfigured: false, ...empty }
  try {
    const result = await lifecycleCounts(vfs)
    const complete = result.wikiDirectory && result.draftsDirectory && result.rawDirectory
    return {
      ...result.overview,
      connected: complete,
      status: complete ? 'connected' : 'partial',
      message: complete ? 'OKS 知识库已连接。' : '已找到 OKS 知识库目录，但目录结构不完整；请运行 oks init --upgrade 修复。',
      oksCliAvailable: true,
      knowledgeBaseConfigured: true,
      wikiDirectory: result.wikiDirectory,
      draftsDirectory: result.draftsDirectory,
      rawDirectory: result.rawDirectory,
    }
  } catch {
    return { connected: false, status: 'read-error', message: '无法通过 OKS CLI 读取知识库。', oksCliAvailable: true, knowledgeBaseConfigured: true, ...empty }
  }
}
