function encodePath(path) {
  return path.split('/').map(part => encodeURIComponent(part)).join('/')
}

export function oksUri(scope, path = '') {
  return `oks://${scope}/${encodePath(path)}`
}

export function createFakeVfs(files, options = {}) {
  const entries = new Map(Object.entries(files))
  const entryList = [...entries.keys()].map(uri => ({
    name: decodeURIComponent(uri.split('/').at(-1) ?? ''),
    type: 'file',
    uri,
  }))
  return {
    async tree(uri, _depth, maxEntries) {
      const matching = entryList.filter(entry => entry.uri === uri || entry.uri.startsWith(uri.endsWith('/') ? uri : `${uri}/`))
      return { uri, entries: matching.slice(0, maxEntries), depth: 10, truncated: Boolean(options.treeTruncated) || matching.length > maxEntries }
    },
    async read(uri, limit) {
      if (!entries.has(uri)) {
        const error = new Error(`missing ${uri}`)
        error.code = 'PATH_NOT_FOUND'
        throw error
      }
      const content = entries.get(uri)
      const sliced = content.slice(0, limit)
      return { uri, content: sliced, offset: 0, returned_chars: sliced.length, total_chars: content.length, truncated: sliced.length < content.length, next_offset: sliced.length < content.length ? sliced.length : null }
    },
    async overview(uri) {
      const matching = entryList.filter(entry => entry.uri.startsWith(uri.endsWith('/') ? uri : `${uri}/`))
      return { uri, directories: [], files: matching, counts: { files: matching.length }, index_uri: null }
    },
    async find(query, under, maxResults) {
      const needle = query.toLocaleLowerCase()
      const matching = entryList.filter(entry => entry.uri.startsWith(under.endsWith('/') ? under : `${under}/`))
        .filter(entry => entry.uri.toLocaleLowerCase().includes(needle) || entries.get(entry.uri).toLocaleLowerCase().includes(needle))
      const limited = matching.slice(0, maxResults)
      return { uri: under, query, matches: limited.map(entry => ({ uri: entry.uri, match: query, snippet: entries.get(entry.uri).slice(0, 80) })), skipped_count: 0, truncated: matching.length > maxResults }
    },
  }
}
