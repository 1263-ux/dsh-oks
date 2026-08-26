import { readFile } from "node:fs/promises";
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join, win32 } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import z from "@deepseek-ai/schemastery";
//#region src/oks-runtime.ts
/**
* Resolve the OKS executable for a long-running DSH host process.
*
* Windows GUI/autostart processes do not always inherit the interactive user's
* PATH. Prefer the explicit override, then the standard per-user pipx shim,
* and finally let execFile report PATH-based installations on other systems.
*/
function resolveOksBin(env = process.env, platform = process.platform, home = homedir(), exists = existsSync) {
	const override = env.OKS_BIN?.trim();
	if (override) return override;
	if (platform === "win32") {
		const pathJoin = win32.join;
		const found = [pathJoin(home, ".local", "bin", "oks.exe"), pathJoin(home, ".local", "bin", "oks")].find((candidate) => exists(candidate));
		if (found) return found;
	}
	return "oks";
}
//#endregion
//#region src/oks-vfs.ts
const execFileAsync = promisify(execFile);
const FS_SCHEMA = "oks-fs-response/v1";
const MAX_OUTPUT_BYTES = 10485760;
const TREE_CACHE_TTL_MS = 5e3;
var OksVfsError = class extends Error {
	code;
	constructor(message, code = "CLI_ERROR") {
		super(message);
		this.code = code;
		this.name = "OksVfsError";
	}
};
const treeCache = /* @__PURE__ */ new WeakMap();
async function runOksCommand(args) {
	try {
		const { stdout } = await execFileAsync(resolveOksBin(), args, {
			encoding: "utf8",
			timeout: 15e3,
			maxBuffer: MAX_OUTPUT_BYTES,
			env: { ...process.env }
		});
		return stdout;
	} catch (error) {
		throw new OksVfsError(`OKS CLI request failed: ${error instanceof Error ? error.message : "unknown CLI error"}`);
	}
}
function asRecord(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new OksVfsError("OKS CLI returned a non-object JSON response.", "INVALID_RESPONSE");
	return value;
}
function entryArray(value) {
	if (!Array.isArray(value)) return [];
	return value.filter((item) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) return false;
		const entry = item;
		return typeof entry.name === "string" && typeof entry.type === "string" && typeof entry.uri === "string";
	});
}
function matchArray(value) {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) return [];
		const match = item;
		if (typeof match.uri !== "string") return [];
		return [{
			uri: match.uri,
			match: typeof match.match === "string" ? match.match : "",
			snippet: typeof match.snippet === "string" ? match.snippet : ""
		}];
	});
}
function readResult(value, fallbackUri) {
	const result = asRecord(value);
	return {
		uri: typeof result.uri === "string" ? result.uri : fallbackUri,
		content: typeof result.content === "string" ? result.content : "",
		offset: typeof result.offset === "number" ? result.offset : 0,
		returned_chars: typeof result.returned_chars === "number" ? result.returned_chars : 0,
		total_chars: typeof result.total_chars === "number" ? result.total_chars : 0,
		truncated: result.truncated === true,
		next_offset: typeof result.next_offset === "number" ? result.next_offset : null
	};
}
function parseJsonResponse(stdout) {
	let parsed;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		throw new OksVfsError("OKS CLI returned invalid JSON.", "INVALID_RESPONSE");
	}
	const payload = asRecord(parsed);
	if (payload.schema_version !== FS_SCHEMA) throw new OksVfsError("OKS CLI returned an unsupported VFS schema.", "UNSUPPORTED_SCHEMA");
	if (payload.error && typeof payload.error === "object") {
		const error = asRecord(payload.error);
		const code = typeof error.code === "string" ? error.code : "CLI_ERROR";
		throw new OksVfsError(typeof error.message === "string" ? error.message : "OKS VFS request failed.", code);
	}
	return asRecord(payload.result);
}
function uriPath(uri, scope) {
	const prefix = `oks://${scope}/`;
	if (!uri.startsWith(prefix)) return void 0;
	const raw = uri.slice(prefix.length).replace(/\/$/, "");
	if (!raw) return [];
	const parts = raw.split("/").map((part) => {
		try {
			return decodeURIComponent(part);
		} catch {
			return "";
		}
	});
	if (parts.some((part) => !part || part === "." || part === ".." || part.includes("\\"))) return void 0;
	return parts;
}
function isOksUriUnder(uri, parent) {
	const normalizedParent = parent.endsWith("/") ? parent : `${parent}/`;
	return uri === parent || uri.startsWith(normalizedParent);
}
function parentOksUri(uri) {
	const clean = uri.endsWith("/") ? uri.slice(0, -1) : uri;
	const slash = clean.lastIndexOf("/");
	if (slash < 8) return void 0;
	return `${clean.slice(0, slash + 1)}`;
}
/** Coalesce short-lived identical tree scans; OKS remains the source of truth. */
async function cachedOksTree(vfs, uri, depth, maxEntries) {
	const key = `${uri}\u0000${depth}\u0000${maxEntries}`;
	let cache = treeCache.get(vfs);
	if (!cache) {
		cache = /* @__PURE__ */ new Map();
		treeCache.set(vfs, cache);
	}
	const cached = cache.get(key);
	if (cached?.value && cached.expiresAt > Date.now()) return cached.value;
	if (cached?.pending) return cached.pending;
	const pending = vfs.tree(uri, depth, maxEntries).then((value) => {
		cache?.set(key, {
			expiresAt: Date.now() + TREE_CACHE_TTL_MS,
			value
		});
		return value;
	}).catch((error) => {
		cache?.delete(key);
		throw error;
	});
	cache.set(key, {
		expiresAt: 0,
		pending
	});
	return pending;
}
function childOksUri(scope, path) {
	const parts = path.split("/");
	if (!parts.length || parts.some((part) => !part || part === "." || part === ".." || part.includes("\\"))) return void 0;
	return `oks://${scope}/${parts.map((part) => encodeURIComponent(part)).join("/")}`;
}
function decodeOksPath(uri, scope) {
	return uriPath(uri, scope)?.join("/");
}
function createOksVfs(run = runOksCommand) {
	async function request(args) {
		return parseJsonResponse(await run(args));
	}
	return {
		async tree(uri, depth, maxEntries) {
			const result = await request([
				"fs",
				"tree",
				uri,
				"--depth",
				String(depth),
				"--max-entries",
				String(maxEntries),
				"--format",
				"json"
			]);
			return {
				uri: typeof result.uri === "string" ? result.uri : uri,
				entries: entryArray(result.entries),
				depth: typeof result.depth === "number" ? result.depth : depth,
				truncated: result.truncated === true
			};
		},
		async read(uri, limit) {
			return readResult(await request([
				"fs",
				"read",
				uri,
				"--limit",
				String(limit),
				"--format",
				"json"
			]), uri);
		},
		async readMany(uris, limit, maxTotalChars) {
			const result = await request([
				"fs",
				"read-many",
				...uris,
				"--limit",
				String(limit),
				"--max-total-chars",
				String(maxTotalChars),
				"--format",
				"json"
			]);
			if (!Array.isArray(result.items)) throw new OksVfsError("OKS CLI returned an invalid read-many result.", "INVALID_RESPONSE");
			return result.items.map((item, index) => readResult(item, uris[index] ?? "oks://"));
		},
		async overview(uri) {
			const result = await request([
				"fs",
				"overview",
				uri,
				"--format",
				"json"
			]);
			return {
				uri: typeof result.uri === "string" ? result.uri : uri,
				directories: entryArray(result.directories),
				files: entryArray(result.files),
				counts: result.counts && typeof result.counts === "object" ? result.counts : {},
				index_uri: typeof result.index_uri === "string" ? result.index_uri : null
			};
		},
		async find(query, under, maxResults) {
			const result = await request([
				"fs",
				"find",
				query,
				"--under",
				under,
				"--max-results",
				String(maxResults),
				"--format",
				"json"
			]);
			return {
				uri: typeof result.uri === "string" ? result.uri : under,
				query: typeof result.query === "string" ? result.query : query,
				matches: matchArray(result.matches),
				skipped_count: typeof result.skipped_count === "number" ? result.skipped_count : 0,
				truncated: result.truncated === true
			};
		}
	};
}
const defaultOksVfs = createOksVfs();
//#endregion
//#region src/wiki-browser.ts
/**
* Read-only Wiki/Draft presentation helpers.
*
* Discovery, search, path validation, and file reads belong to the external
* OKS CLI VFS. This module only turns bounded CLI documents into the stable
* DTO consumed by the DSH browser.
*/
const MAX_QUERY_CHARS$1 = 120;
const MAX_DETAIL_BODY_CHARS$1 = 6e4;
const MAX_MARKDOWN_READ_CHARS = 524288;
const MAX_TOTAL_READ_CHARS = 8388608;
const MAX_MARKDOWN_FILES = 1e3;
const MAX_TREE_ENTRIES$1 = 1e4;
const MAX_CONCURRENT_MARKDOWN_READS = 4;
function text$1(value) {
	return typeof value === "string" ? value.trim() : "";
}
function normalizeFilter$1(value) {
	return text$1(value).slice(0, MAX_QUERY_CHARS$1);
}
function yamlScalar(value) {
	const trimmed = value.trim();
	if (trimmed.startsWith("'") && trimmed.endsWith("'") || trimmed.startsWith("\"") && trimmed.endsWith("\"")) return trimmed.slice(1, -1);
	return trimmed.replace(/\s+#.*$/, "").trim();
}
function readFrontmatter(source) {
	const normalized = source.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
	if (!normalized.startsWith("---\n")) return {
		meta: {},
		body: normalized
	};
	const closeAt = normalized.indexOf("\n---", 4);
	if (closeAt < 0) return {
		meta: {},
		body: normalized
	};
	const meta = {};
	for (const line of normalized.slice(4, closeAt).split("\n")) {
		const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
		if (match) meta[match[1]] = yamlScalar(match[2]);
	}
	return {
		meta,
		body: normalized.slice(closeAt + 4).replace(/^\n/, "")
	};
}
function displaySummary$1(markdown) {
	const plain = markdown.replace(/```[\s\S]*?```/g, " ").replace(/!\[[^\]]*\]\([^)]*\)/g, " ").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/^[#>*\-+\d.\s]+/gm, " ").replace(/[|`*_]/g, " ").replace(/\s+/g, " ").trim();
	return plain.length <= 220 ? plain : `${plain.slice(0, 217).trimEnd()}…`;
}
function titleFromBody(body) {
	return /^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? "";
}
function comparePages(a, b) {
	return b.created.localeCompare(a.created) || a.title.localeCompare(b.title, "zh-Hans-CN");
}
function markdownEntries(tree) {
	const markdown = tree.entries.filter((entry) => entry.type === "file" && entry.name.toLowerCase().endsWith(".md"));
	return {
		entries: markdown.slice(0, MAX_MARKDOWN_FILES),
		truncated: markdown.length > MAX_MARKDOWN_FILES
	};
}
function summaryFromSource(scope, uri, source) {
	const { meta, body } = readFrontmatter(source);
	const slug = decodeOksPath(uri, scope)?.replace(/\.md$/i, "") ?? "";
	return {
		slug,
		title: meta.title || titleFromBody(body) || slug.split("/").at(-1) || slug,
		area: meta.area || "未分类",
		type: meta.type || "未分类",
		summary: displaySummary$1(body) || "暂无正文摘要。",
		created: meta.created || ""
	};
}
async function readMarkdownEntries(entries, vfs) {
	if (entries.length && vfs.readMany) try {
		const items = await vfs.readMany(entries.map((entry) => entry.uri), MAX_MARKDOWN_READ_CHARS, MAX_TOTAL_READ_CHARS);
		return {
			reads: new Map(items.map((item) => [item.uri, item])),
			truncated: items.length < entries.length || items.some((item) => item.truncated)
		};
	} catch {}
	const reads = /* @__PURE__ */ new Map();
	let truncated = false;
	let nextEntry = 0;
	let reservedChars = 0;
	const readNext = async () => {
		while (true) {
			const entry = entries[nextEntry++];
			if (!entry) return;
			const remaining = MAX_TOTAL_READ_CHARS - reservedChars;
			if (remaining <= 0) {
				truncated = true;
				return;
			}
			const limit = Math.min(MAX_MARKDOWN_READ_CHARS, remaining);
			reservedChars += limit;
			const read = await vfs.read(entry.uri, limit);
			reservedChars -= Math.max(0, limit - Math.min(limit, read.returned_chars));
			truncated ||= read.truncated;
			reads.set(entry.uri, read);
		}
	};
	await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_MARKDOWN_READS, entries.length) }, () => readNext()));
	return {
		reads,
		truncated
	};
}
async function readMarkdownList(scope, filters, vfs) {
	const tree = await cachedOksTree(vfs, `oks://${scope}/`, 10, MAX_TREE_ENTRIES$1);
	const discovered = markdownEntries(tree);
	const entries = discovered.entries;
	const normalizedQuery = normalizeFilter$1(filters.query);
	let truncated = tree.truncated || discovered.truncated;
	let matched;
	if (normalizedQuery) {
		const found = await vfs.find(normalizedQuery, `oks://${scope}/`, 200);
		matched = new Set(found.matches.map((item) => item.uri));
		truncated ||= found.truncated;
	}
	const pages = [];
	const allPages = [];
	const loaded = await readMarkdownEntries(entries, vfs);
	truncated ||= loaded.truncated;
	for (const entry of entries) {
		const read = loaded.reads.get(entry.uri);
		if (!read) continue;
		const page = summaryFromSource(scope, entry.uri, read.content);
		allPages.push(page);
		if ((!matched || matched.has(entry.uri)) && (!normalizeFilter$1(filters.area) || page.area === normalizeFilter$1(filters.area)) && (!normalizeFilter$1(filters.type) || page.type === normalizeFilter$1(filters.type))) pages.push(page);
	}
	pages.sort(comparePages);
	allPages.sort(comparePages);
	const metadataPages = allPages.length ? allPages : entries.map((entry) => ({
		slug: decodeOksPath(entry.uri, scope) ?? "",
		title: "",
		area: "未分类",
		type: "未分类",
		summary: "",
		created: ""
	}));
	return {
		total: allPages.length,
		items: pages,
		areas: [...new Set(metadataPages.map((page) => page.area))].sort((a, b) => a.localeCompare(b, "zh-Hans-CN")),
		types: [...new Set(metadataPages.map((page) => page.type))].sort((a, b) => a.localeCompare(b, "zh-Hans-CN")),
		...truncated ? { truncated: true } : {}
	};
}
async function readMarkdownPage(scope, requestedSlug, vfs) {
	const slug = normalizeFilter$1(requestedSlug);
	if (!slug || slug.toLowerCase().endsWith(".md")) return void 0;
	const uri = childOksUri(scope, `${slug}.md`);
	if (!uri) return void 0;
	try {
		const read = await vfs.read(uri, MAX_MARKDOWN_READ_CHARS);
		const { body } = readFrontmatter(read.content);
		return {
			...summaryFromSource(scope, uri, read.content),
			body: body.slice(0, MAX_DETAIL_BODY_CHARS$1),
			bodyTruncated: read.truncated || body.length > MAX_DETAIL_BODY_CHARS$1
		};
	} catch (error) {
		if (error instanceof OksVfsError && error.code === "PATH_NOT_FOUND") return void 0;
		throw error;
	}
}
function listWikiPages(filters = {}, vfs = defaultOksVfs) {
	return readMarkdownList("wiki", filters, vfs);
}
function getWikiPage(requestedSlug, vfs = defaultOksVfs) {
	return readMarkdownPage("wiki", requestedSlug, vfs);
}
function listDraftPages(filters = {}, vfs = defaultOksVfs) {
	return readMarkdownList("drafts", filters, vfs);
}
function getDraftPage(requestedSlug, vfs = defaultOksVfs) {
	return readMarkdownPage("drafts", requestedSlug, vfs);
}
//#endregion
//#region src/raw-browser.ts
/**
* Read-only Raw Bundle presentation helpers.
*
* The OKS CLI VFS owns bundle discovery and file reads. This module only
* groups bounded VFS entries into the existing browser DTO.
*/
const RAW_SCOPE = "oks://raw/";
const MAX_QUERY_CHARS = 120;
const MAX_DETAIL_BODY_CHARS = 6e4;
const MAX_LIST_PREVIEW_CHARS = 16384;
const MAX_DETAIL_BODY_CHARS_READ = 131072;
const MAX_MANIFEST_CHARS = 262144;
const MAX_TREE_ENTRIES = 1e4;
const MAX_BUNDLES = 250;
const MAX_CONCURRENT_BUNDLE_READS = 4;
const MAX_BATCH_TOTAL_CHARS = 8388608;
const RAW_CACHE_TTL_MS = 5e3;
const rawBundlesCache = /* @__PURE__ */ new WeakMap();
async function cachedFor(cache, vfs, load) {
	const cached = cache.get(vfs);
	if (cached?.value && cached.expiresAt > Date.now()) return cached.value;
	if (cached?.pending) return cached.pending;
	const pending = load().then((value) => {
		cache.set(vfs, {
			expiresAt: Date.now() + RAW_CACHE_TTL_MS,
			value
		});
		return value;
	}).catch((error) => {
		cache.delete(vfs);
		throw error;
	});
	cache.set(vfs, {
		expiresAt: 0,
		pending
	});
	return pending;
}
function text(value) {
	return typeof value === "string" ? value.trim() : "";
}
function normalizeFilter(value) {
	return text(value).slice(0, MAX_QUERY_CHARS);
}
function displaySummary(markdown) {
	const plain = markdown.replace(/```[\s\S]*?```/g, " ").replace(/!\[[^\]]*\]\([^)]*\)/g, " ").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/^[#>*\-+\d.\s]+/gm, " ").replace(/[|`*_]/g, " ").replace(/\s+/g, " ").trim();
	return plain.length <= 220 ? plain : `${plain.slice(0, 217).trimEnd()}...`;
}
function dateFromId(id, manifest) {
	const match = /(^|\/)(\d{4})\/(\d{2})\/(\d{2})(\/|$)/.exec(id);
	if (match) return `${match[2]}-${match[3]}-${match[4]}`;
	const provenance = manifest.provenance;
	if (provenance && typeof provenance === "object" && Array.isArray(provenance.activities)) {
		const started = provenance.activities.find((item) => typeof item?.started_at === "string")?.started_at;
		if (started) return String(started).slice(0, 10);
	}
	return "";
}
function sourceTypeFromManifest(manifest) {
	const sources = manifest.sources;
	if (Array.isArray(sources)) {
		const first = sources.find((item) => item && typeof item === "object");
		const mediaType = text(first?.media_type);
		if (mediaType) return mediaType;
		const snapshotKind = text(first?.snapshot_kind);
		if (snapshotKind) return snapshotKind;
	}
	return "unlabeled";
}
function relativeId(directoryUri) {
	return decodeOksPath(directoryUri, "raw") ?? "";
}
function relativeFilePath(directoryUri, fileUri) {
	const directory = relativeId(directoryUri);
	const file = decodeOksPath(fileUri, "raw");
	if (!file || !directory || !file.startsWith(`${directory}/`)) return void 0;
	return file.slice(directory.length + 1);
}
function findContentUri(directoryUri, manifest, files) {
	const declared = text(manifest.files?.content);
	if (declared && !declared.includes("..") && !declared.includes("\\")) return files.get(declared);
	return files.get("content.md") ?? files.get("raw.md");
}
function rawFileEntries(entries, directoryUri) {
	const files = /* @__PURE__ */ new Map();
	for (const entry of entries) {
		if (entry.type !== "file" || !isOksUriUnder(entry.uri, directoryUri)) continue;
		const relative = relativeFilePath(directoryUri, entry.uri);
		if (relative) files.set(relative, entry.uri);
	}
	return files;
}
function bundleDirectories(entries) {
	const roots = entries.filter((entry) => entry.type === "file" && entry.name.toLowerCase() === "bundle.json").map((entry) => parentOksUri(entry.uri)).filter((uri) => Boolean(uri));
	const directories = [...new Set(roots)];
	return {
		directories: directories.slice(0, MAX_BUNDLES),
		truncated: directories.length > MAX_BUNDLES
	};
}
async function readBundle(directoryUri, entries, vfs, includePreview = true) {
	const manifestUri = entries.find((entry) => entry.type === "file" && entry.name.toLowerCase() === "bundle.json" && parentOksUri(entry.uri) === directoryUri)?.uri;
	if (!manifestUri) return void 0;
	try {
		const manifestRead = await vfs.read(manifestUri, MAX_MANIFEST_CHARS);
		if (manifestRead.truncated) return void 0;
		const manifest = JSON.parse(manifestRead.content);
		const files = rawFileEntries(entries, directoryUri);
		const contentUri = findContentUri(directoryUri, manifest, files);
		const content = includePreview && contentUri ? await vfs.read(contentUri, MAX_LIST_PREVIEW_CHARS) : {
			content: "",
			truncated: false
		};
		const id = relativeId(directoryUri);
		const bundleId = text(manifest.bundle_id) || id;
		const captureId = text(manifest.capture_id) || bundleId;
		const status = text(manifest.processing_status) || "unknown";
		return {
			summary: {
				id,
				bundleId,
				captureId,
				capturedAt: dateFromId(id, manifest),
				status,
				sourceType: sourceTypeFromManifest(manifest),
				fileCount: files.size,
				summary: displaySummary(content.content) || "This Raw Bundle has no previewable text."
			},
			manifest,
			files: [...files.keys()].sort((a, b) => a.localeCompare(b)),
			directoryUri,
			contentUri,
			contentTruncated: content.truncated
		};
	} catch {
		return;
	}
}
async function readBundlesBatch(directories, entries, vfs) {
	if (!directories.length || !vfs.readMany) return void 0;
	try {
		const manifestByDirectory = new Map(directories.flatMap((directoryUri) => {
			const manifestUri = entries.find((entry) => entry.type === "file" && entry.name.toLowerCase() === "bundle.json" && parentOksUri(entry.uri) === directoryUri)?.uri;
			return manifestUri ? [[directoryUri, manifestUri]] : [];
		}));
		const manifestUris = [...manifestByDirectory.values()];
		const manifestReads = await vfs.readMany(manifestUris, MAX_MANIFEST_CHARS, MAX_BATCH_TOTAL_CHARS);
		const manifestsByUri = new Map(manifestReads.map((read) => [read.uri, read]));
		let truncated = manifestUris.length < directories.length || manifestReads.length < manifestUris.length;
		const prepared = [];
		for (const directoryUri of directories) {
			const manifestUri = manifestByDirectory.get(directoryUri);
			const manifestRead = manifestUri ? manifestsByUri.get(manifestUri) : void 0;
			if (!manifestRead || manifestRead.truncated) {
				truncated = true;
				continue;
			}
			try {
				const manifest = JSON.parse(manifestRead.content);
				const files = rawFileEntries(entries, directoryUri);
				prepared.push({
					directoryUri,
					manifest,
					files,
					contentUri: findContentUri(directoryUri, manifest, files)
				});
			} catch {
				truncated = true;
			}
		}
		const contentUris = [...new Set(prepared.flatMap((item) => item.contentUri ? [item.contentUri] : []))];
		const contentReads = contentUris.length ? await vfs.readMany(contentUris, MAX_LIST_PREVIEW_CHARS, MAX_BATCH_TOTAL_CHARS) : [];
		const contentByUri = new Map(contentReads.map((read) => [read.uri, read]));
		truncated ||= contentReads.length < contentUris.length;
		return {
			bundles: prepared.map(({ directoryUri, manifest, files, contentUri }) => {
				const content = contentUri ? contentByUri.get(contentUri) : void 0;
				if (contentUri && !content) truncated = true;
				const id = relativeId(directoryUri);
				const bundleId = text(manifest.bundle_id) || id;
				const captureId = text(manifest.capture_id) || bundleId;
				const status = text(manifest.processing_status) || "unknown";
				return {
					summary: {
						id,
						bundleId,
						captureId,
						capturedAt: dateFromId(id, manifest),
						status,
						sourceType: sourceTypeFromManifest(manifest),
						fileCount: files.size,
						summary: displaySummary(content?.content ?? "") || "This Raw Bundle has no previewable text."
					},
					manifest,
					files: [...files.keys()].sort((a, b) => a.localeCompare(b)),
					directoryUri,
					contentUri,
					contentTruncated: content?.truncated ?? false
				};
			}),
			truncated
		};
	} catch {
		return;
	}
}
async function loadBundles(query, vfs) {
	const tree = await cachedOksTree(vfs, RAW_SCOPE, 10, MAX_TREE_ENTRIES);
	let candidateUris;
	let truncated = tree.truncated;
	if (query) {
		const found = await vfs.find(query, RAW_SCOPE, 200);
		candidateUris = new Set(found.matches.map((match) => match.uri));
		truncated ||= found.truncated;
	}
	const bundles = [];
	const bundleRoots = bundleDirectories(tree.entries);
	truncated ||= bundleRoots.truncated;
	const directories = candidateUris ? bundleRoots.directories.filter((directoryUri) => [...candidateUris].some((uri) => isOksUriUnder(uri, directoryUri))) : bundleRoots.directories;
	const batch = await readBundlesBatch(directories, tree.entries, vfs);
	if (batch) {
		bundles.push(...batch.bundles);
		truncated ||= batch.truncated;
	} else {
		let nextDirectory = 0;
		const readNext = async () => {
			while (true) {
				const directoryUri = directories[nextDirectory++];
				if (!directoryUri) return;
				const bundle = await readBundle(directoryUri, tree.entries, vfs);
				if (bundle) bundles.push(bundle);
			}
		};
		await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_BUNDLE_READS, directories.length) }, () => readNext()));
	}
	bundles.sort((a, b) => b.summary.capturedAt.localeCompare(a.summary.capturedAt) || a.summary.captureId.localeCompare(b.summary.captureId));
	return {
		bundles,
		truncated
	};
}
async function listRawBundles(filters = {}, vfs = defaultOksVfs) {
	const query = normalizeFilter(filters.query).toLocaleLowerCase();
	const status = normalizeFilter(filters.status);
	const loaded = query ? await loadBundles(query, vfs) : await cachedFor(rawBundlesCache, vfs, () => loadBundles("", vfs));
	const items = loaded.bundles.map((item) => item.summary).filter((item) => !status || item.status === status);
	return {
		total: loaded.bundles.length,
		items,
		statuses: [...new Set(loaded.bundles.map((item) => item.summary.status))].sort((a, b) => a.localeCompare(b)),
		truncated: loaded.truncated
	};
}
async function getRawBundle(requestedId, vfs = defaultOksVfs) {
	const id = normalizeFilter(requestedId);
	if (!id || id.includes("\\") || id.split("/").some((part) => !part || part === "." || part === "..")) return void 0;
	const cached = rawBundlesCache.get(vfs);
	let bundle = cached?.value && cached.expiresAt > Date.now() ? cached.value.bundles.find((item) => item.summary.id === id) : void 0;
	if (!bundle) {
		const tree = await cachedOksTree(vfs, RAW_SCOPE, 10, MAX_TREE_ENTRIES);
		const directoryUri = bundleDirectories(tree.entries).directories.find((uri) => relativeId(uri) === id);
		if (!directoryUri) return void 0;
		bundle = await readBundle(directoryUri, tree.entries, vfs, false);
	}
	if (!bundle) return void 0;
	const read = bundle.contentUri ? await vfs.read(bundle.contentUri, MAX_DETAIL_BODY_CHARS_READ) : {
		content: "",
		truncated: false
	};
	const body = read.content.slice(0, MAX_DETAIL_BODY_CHARS);
	return {
		...bundle.summary,
		summary: displaySummary(read.content) || bundle.summary.summary,
		body,
		bodyTruncated: read.truncated || read.content.length > MAX_DETAIL_BODY_CHARS
	};
}
//#endregion
//#region src/oks-overview.ts
/** Read-only lifecycle diagnostics backed by the OKS CLI VFS. */
const LIFECYCLE_CACHE_TTL_MS = 5e3;
const lifecycleCache = /* @__PURE__ */ new WeakMap();
function countRawBundles(tree) {
	if (!tree) return 0;
	return new Set(tree.entries.filter((entry) => entry.type === "file" && entry.name.toLowerCase() === "bundle.json").map((entry) => parentOksUri(entry.uri)).filter((uri) => Boolean(uri))).size;
}
async function collectLifecycleCounts(vfs) {
	const scopes = await Promise.allSettled([
		cachedOksTree(vfs, "oks://wiki/", 10, 1e3),
		cachedOksTree(vfs, "oks://drafts/", 10, 1e3),
		cachedOksTree(vfs, "oks://raw/", 10, 1e4)
	]);
	const wiki = scopes[0].status === "fulfilled" ? scopes[0].value : void 0;
	const drafts = scopes[1].status === "fulfilled" ? scopes[1].value : void 0;
	const raw = scopes[2].status === "fulfilled" ? scopes[2].value : void 0;
	if (!wiki && !drafts && !raw) throw new Error("OKS VFS scopes are unavailable");
	const wikiFiles = wiki?.entries.filter((entry) => entry.type === "file" && entry.name.toLowerCase().endsWith(".md")).length ?? 0;
	const draftFiles = drafts?.entries.filter((entry) => entry.type === "file" && entry.name.toLowerCase().endsWith(".md")).length ?? 0;
	const rawFiles = raw?.entries.filter((entry) => entry.type === "file" && entry.name !== ".gitkeep").length ?? 0;
	const truncated = Boolean(wiki?.truncated || drafts?.truncated || raw?.truncated);
	return {
		overview: {
			connected: true,
			wikiCount: wikiFiles,
			draftCount: draftFiles,
			rawFileCount: rawFiles,
			rawBundleCount: countRawBundles(raw),
			...truncated ? { truncated: true } : {}
		},
		wikiDirectory: Boolean(wiki),
		draftsDirectory: Boolean(drafts),
		rawDirectory: Boolean(raw)
	};
}
async function lifecycleCounts(vfs) {
	const now = Date.now();
	const cached = lifecycleCache.get(vfs);
	if (cached?.value && cached.expiresAt > now) return cached.value;
	if (cached?.pending) return cached.pending;
	const pending = collectLifecycleCounts(vfs).then((value) => {
		lifecycleCache.set(vfs, {
			expiresAt: Date.now() + LIFECYCLE_CACHE_TTL_MS,
			value
		});
		return value;
	}).catch((error) => {
		lifecycleCache.delete(vfs);
		throw error;
	});
	lifecycleCache.set(vfs, {
		expiresAt: 0,
		pending
	});
	return pending;
}
async function getOksOverview(vfs = defaultOksVfs) {
	return (await lifecycleCounts(vfs)).overview;
}
/** Classify first-use connectivity without exposing the local root path. */
async function getOksDiagnostics(knowledgeBasePath, oksCliAvailable, vfs = defaultOksVfs) {
	const empty = {
		wikiCount: 0,
		draftCount: 0,
		rawFileCount: 0,
		rawBundleCount: 0,
		wikiDirectory: false,
		draftsDirectory: false,
		rawDirectory: false
	};
	if (!oksCliAvailable) return {
		connected: false,
		status: "oks-not-installed",
		message: "未检测到 OKS 命令。请先安装 OKS CLI，然后重新打开 DSH。",
		oksCliAvailable: false,
		knowledgeBaseConfigured: Boolean(knowledgeBasePath),
		...empty
	};
	if (!knowledgeBasePath) return {
		connected: false,
		status: "not-configured",
		message: "已检测到 OKS，但还没有连接知识库。请在系统设置中配置知识库位置。",
		oksCliAvailable: true,
		knowledgeBaseConfigured: false,
		...empty
	};
	try {
		const result = await lifecycleCounts(vfs);
		const complete = result.wikiDirectory && result.draftsDirectory && result.rawDirectory;
		return {
			...result.overview,
			connected: complete,
			status: complete ? "connected" : "partial",
			message: complete ? "OKS 知识库已连接。" : "已找到 OKS 知识库目录，但目录结构不完整；请运行 oks init --upgrade 修复。",
			oksCliAvailable: true,
			knowledgeBaseConfigured: true,
			wikiDirectory: result.wikiDirectory,
			draftsDirectory: result.draftsDirectory,
			rawDirectory: result.rawDirectory
		};
	} catch {
		return {
			connected: false,
			status: "read-error",
			message: "无法通过 OKS CLI 读取知识库。",
			oksCliAvailable: true,
			knowledgeBaseConfigured: true,
			...empty
		};
	}
}
//#endregion
//#region src/prestep-control.ts
/** Product-level gate for the user-facing automatic knowledge toggle. */
function isPrestepRecallEnabled(config) {
	return config.prestep_enabled !== false;
}
//#endregion
//#region src/oks-config.ts
/** Parse the Knowledge Base path from the box-drawn oks config show table. */
function parseOksKnowledgeBasePath(stdout) {
	const lines = stdout.split(/\r?\n/);
	const heading = lines.findIndex((line) => line.includes("Knowledge Base"));
	if (heading < 0) return "";
	for (const line of lines.slice(heading + 1)) {
		const candidate = line.trim().replace(/^(?:\u2502|\|)\s*/, "").replace(/\s*(?:\u2502|\|).*$/, "").trim();
		if (/^(?:[A-Za-z]:[\\/]|\\\\|\\\\\?\\\\|\/)/.test(candidate)) return candidate;
		if (candidate.startsWith("Strategy")) break;
	}
	return "";
}
/** Return the global config path used by the OKS CLI. */
function oksConfigPath(home = homedir()) {
	return join(home, ".oks", "config.json");
}
/**
* Clear the active knowledge-base pointer without invoking oks config set.
* The CLI treats an empty positional value as the current directory, which is
* unsafe for a settings "disconnect" action. Preserve all other config keys
* and use an atomic replacement so a failed write cannot leave a partial file.
*/
function clearOksKnowledgeBasePath(configPath = oksConfigPath()) {
	let config = {};
	try {
		const parsed = JSON.parse(readFileSync(configPath, "utf8"));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) config = parsed;
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	config.knowledge_base_path = "";
	const directory = dirname(configPath);
	mkdirSync(directory, { recursive: true });
	const temporary = join(directory, ".config." + process.pid + "." + randomUUID() + ".tmp");
	let fd;
	try {
		fd = openSync(temporary, "wx");
		writeFileSync(fd, JSON.stringify(config, null, 2) + "\n", "utf8");
		fsyncSync(fd);
		closeSync(fd);
		fd = void 0;
		renameSync(temporary, configPath);
	} finally {
		if (fd !== void 0) closeSync(fd);
		try {
			unlinkSync(temporary);
		} catch {}
	}
}
let sharedWriteTail = Promise.resolve();
/** Keep the settings source live as dsh-settings replaces its resolved scope. */
function createDynamicSettingsHooks(entry, sync) {
	let source = () => entry;
	let previous;
	let suppressNextChange = true;
	let pending = sharedWriteTail;
	const snapshot = (value) => {
		const out = {};
		for (const key of Object.keys(value)) out[key] = value[key];
		return out;
	};
	return {
		setSource(next) {
			source = next;
			suppressNextChange = true;
		},
		getCurrent() {
			return source();
		},
		onChange() {
			const value = source();
			const current = snapshot(value);
			if (previous === void 0 || suppressNextChange) {
				previous = current;
				suppressNextChange = false;
				return pending;
			}
			const changed = /* @__PURE__ */ new Set();
			const keys = /* @__PURE__ */ new Set([...Object.keys(previous), ...Object.keys(current)]);
			for (const key of keys) if (!Object.is(previous[key], current[key])) changed.add(key);
			previous = current;
			if (changed.size === 0) return pending;
			sharedWriteTail = sharedWriteTail.catch(() => void 0).then(() => sync(value, changed)).then(() => void 0).catch(() => void 0);
			pending = sharedWriteTail;
			return pending;
		},
		whenIdle() {
			return pending;
		}
	};
}
//#endregion
//#region src/oks-hook.ts
function finiteNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function safeTraceLabel$1(value) {
	const label = String(value ?? "").trim();
	return /^[-_\.\p{L}\p{N}]{1,120}$/u.test(label) ? label : "[知识条目]";
}
function validStatus(value) {
	return value === "skipped_minlen" || value === "skipped_cooldown" || value === "empty" || value === "injected" || value === "error";
}
/** Parse the narrow JSON contract exposed by `oks hook recall --format json`. */
function parseOksHookRecall(stdout) {
	try {
		const data = JSON.parse(stdout);
		if (data.schema !== "hook-recall-response/v1" || !validStatus(data.status) || typeof data.context !== "string") return null;
		const trace = data.trace;
		if (!trace || typeof trace !== "object") return null;
		const raw = trace;
		const count = finiteNumber(raw.candidate_count);
		const rawMatches = Array.isArray(raw.matches) ? raw.matches : [];
		return {
			status: data.status,
			context: data.context,
			trace: {
				candidateCount: Math.max(0, Math.floor(count ?? 0)),
				matches: rawMatches.map(safeTraceLabel$1).filter((value) => value !== "[知识条目]").slice(0, 12),
				topRelevance: finiteNumber(raw.top_relevance),
				threshold: finiteNumber(raw.threshold)
			}
		};
	} catch {
		return null;
	}
}
function uiStatus(status) {
	if (status === "injected") return "ok";
	if (status === "error") return "error";
	if (status === "empty") return "empty";
	return "info";
}
/** Map OKS-owned hook state to the pre-existing panel DTO without prompt/body data. */
function toOksRecallTrace(id, at, result) {
	return {
		id,
		at,
		phase: "pre-step",
		status: uiStatus(result.status),
		candidateCount: result.trace.candidateCount,
		matches: result.trace.matches,
		topRelevance: result.trace.topRelevance,
		threshold: result.trace.threshold
	};
}
/** Validate retained OKS history before it crosses the Host-to-browser RPC boundary. */
function parseOksHookHistory(stdout) {
	try {
		const data = JSON.parse(stdout);
		if (data.schema !== "hook-recall-history/v1" || !Array.isArray(data.items)) return [];
		return data.items.flatMap((item) => {
			if (!item || typeof item !== "object") return [];
			const raw = item;
			if (typeof raw.id !== "string" || typeof raw.at !== "string" || raw.phase !== "pre-step") return [];
			const count = finiteNumber(raw.candidate_count);
			const matches = Array.isArray(raw.matches) ? raw.matches.map(safeTraceLabel$1).filter((value) => value !== "[知识条目]").slice(0, 12) : [];
			return [{
				id: raw.id,
				at: raw.at,
				phase: "pre-step",
				status: raw.status === "ok" ? "ok" : "info",
				candidateCount: Math.max(0, Math.floor(count ?? 0)),
				matches,
				topRelevance: finiteNumber(raw.top_relevance),
				threshold: finiteNumber(raw.threshold)
			}];
		});
	} catch {
		return [];
	}
}
/** Prefer fresh Host events but avoid showing the same persisted injection twice. */
function mergeOksRecallTraceHistory(live, retained, limit) {
	const seen = /* @__PURE__ */ new Set();
	const unique = [...live, ...retained].sort((a, b) => {
		const left = Date.parse(a.at);
		const right = Date.parse(b.at);
		if (Number.isFinite(left) && Number.isFinite(right)) return right - left;
		return b.at.localeCompare(a.at);
	}).filter((item) => {
		const key = `${item.phase}|${item.at.slice(0, 19)}|${item.matches.join(",")}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	return {
		items: unique.slice(0, limit),
		truncated: unique.length > limit
	};
}
//#endregion
//#region src/index.ts
/**
* dsh-oks -- DeepSeek Harness plugin for the OKS knowledge base.
*
* Host half: registers model-facing tools (oks_recall/status/wiki_use/metrics),
* a settings namespace for the browser card (RecallParamsCard), and a runtime
* skill that tells the model when to recall.
*
* Integration: calls the `oks` CLI via subprocess; dsh (Node) and oks (Python)
* stay decoupled, each upgrades independently.
*/
const execAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
/** Settings namespace shared by the Host half and the browser card. */
const OKS_NS = settingsNamespace("oks");
/** Schema for the settings card. Values are synchronized through the OKS CLI. */
const OksConfigSchema = z.object({
	knowledge_base_path: z.string().default(""),
	recall_floor: z.number().min(0).max(1).step(.05).default(.7),
	recall_topn: z.number().step(1).min(1).max(10).default(3),
	recall_minlen: z.number().step(1).min(1).max(50).default(6),
	recall_cooldown: z.number().step(1).min(0).max(100).default(10),
	prestep_enabled: z.boolean().default(true),
	posttool_mode: z.union(["signal", "full"]).default("signal"),
	posttool_floor: z.number().min(0).max(1).step(.05).default(.9),
	posttool_topn: z.number().step(1).min(1).max(10).default(2),
	posttool_signal_rel_floor: z.number().min(0).max(10).step(.1).default(2.5),
	search_backend: z.union([
		"native",
		"fts5",
		"fusion"
	]).default("native")
});
/** Resolve the OKS binary even when DSH was launched without the user's PATH. */
function oksBin() {
	return resolveOksBin();
}
/** Log sync failures without making the settings UI fail silently. */
function warnSync(stage, error) {
	console.warn(`[dsh-oks] ${stage} failed`, error);
}
/** Sync settings through the OKS CLI. DSH-only hook switches remain DSH settings. */
async function syncOksConfig(cfg, changed) {
	if (changed.has("knowledge_base_path")) {
		const knowledgeBasePath = cfg.knowledge_base_path?.trim() ?? "";
		try {
			if (knowledgeBasePath) await execAsync(oksBin(), [
				"config",
				"set",
				"knowledge_base_path",
				knowledgeBasePath
			]);
			else clearOksKnowledgeBasePath();
		} catch (error) {
			warnSync("knowledge_base_path update", error);
		}
	}
	const cliKeys = /* @__PURE__ */ new Set([
		"recall_floor",
		"recall_topn",
		"recall_minlen",
		"recall_cooldown",
		"posttool_floor",
		"posttool_topn",
		"posttool_mode",
		"posttool_signal_rel_floor",
		"search_backend"
	]);
	for (const key of changed) {
		if (!cliKeys.has(key)) continue;
		const value = cfg[key];
		if (value === void 0) continue;
		try {
			await execAsync(oksBin(), [
				"config",
				"set",
				key,
				String(value)
			]);
		} catch (error) {
			warnSync(`OKS config set ${key}`, error);
		}
	}
}
/** Read the current knowledge_base_path from `oks config show` output. */
async function readOksKnowledgeBasePath() {
	try {
		const { stdout } = await execAsync(oksBin(), ["config", "show"], {
			encoding: "utf-8",
			timeout: 5e3
		});
		return parseOksKnowledgeBasePath(stdout);
	} catch (error) {
		warnSync("knowledge_base_path read", error);
		return "";
	}
}
/** Run `oks <args>` and return stdout. Uses execFile (no shell) so args like
* `;rm -rf /` are passed literally to oks, never parsed by a shell. */
async function runOks(args) {
	const { stdout } = await execAsync(oksBin(), args, {
		maxBuffer: 10485760,
		env: { ...process.env }
	});
	return stdout;
}
const name = "dsh-oks";
/** Browser Wiki panel depends on the DSH Connection RPC host seam. */
const inject = [
	"settings",
	"tools",
	"connection"
];
/** Source label for hook-injected messages; lets downstream see who spoke. */
const PLUGIN_SOURCE = {
	kind: "plugin",
	plugin: "dsh-oks"
};
/** Tools whose results are worth a post-tool memory signal. */
const SIGNAL_TOOLS = /* @__PURE__ */ new Set([
	"read",
	"write",
	"edit",
	"bash",
	"grep",
	"glob"
]);
/** Pull the plain-text query out of the last user message's content blocks. */
function extractQuery(messages) {
	const last = messages[messages.length - 1];
	if (!last?.content) return "";
	return last.content.filter((b) => b.type === "text" && "text" in b).map((b) => b.text).join(" ").trim();
}
/** Parse `oks recall --format json` into context text, cited slugs, and inject_id, or null.
* Mirrors pi's user-prompt-recall.py template: <recalled-memory source="oks">
* The wrapper includes a concise body preview and guidance for stronger evidence. */
function parseRecall(stdout) {
	try {
		const data = JSON.parse(stdout);
		const items = [...data.knowledge ?? [], ...data.episodic ?? []];
		if (items.length === 0) return null;
		const lines = ["## Relevant OKS memory", "Use this evidence as context. If it conflicts with current facts, verify before relying on it."];
		for (const item of items) if ("slug" in item) {
			lines.push(`- [${item.type ?? ""}] ${item.title ?? item.slug ?? ""} (${item.slug ?? ""}) rel=${(item.relevance ?? 0).toFixed(2)}`);
			const preview = String(item.body_preview ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
			if (preview) lines.push(`    ${preview}`);
		} else {
			lines.push(`- [episodic] ${item.source_path ?? ""} rel=${(item.relevance ?? 0).toFixed(2)}`);
			const snippet = String(item.snippet ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
			if (snippet) lines.push(`    ${snippet}`);
		}
		const slugs = items.map((item) => "slug" in item ? item.slug ?? "" : item.source_path ?? "").filter(Boolean);
		const injectId = randomUUID().slice(0, 8);
		return {
			text: [
				"<recalled-memory source=\"oks\">",
				lines.join("\n"),
				"",
				"If the task needs stronger evidence, call oks_recall or oks recall before making a claim.",
				`<!-- inject_id:${injectId} slugs:${slugs.join(",")} -->`,
				"</recalled-memory>"
			].join("\n"),
			injectId,
			slugs
		};
	} catch {
		return null;
	}
}
/** A short post-tool signal: mirrors pi's post-tool-edit.py signal mode.
* The signal contains slugs and relevance only; the model can call oks_recall for details.
*
* OKS CLI --floor is authoritative. Older dsh-oks releases applied a second
* local threshold (default 2.5), which silently rejected normalized fts5
* relevance values in the 0..1 range. Keep the optional fourth argument for
* source compatibility, but intentionally do not use it as a second filter.
*/
function parseSignal(stdout, query, floor, _legacySignalRelFloor) {
	try {
		const data = JSON.parse(stdout);
		const items = [...data.knowledge ?? [], ...data.episodic ?? []];
		if (items.length === 0) return null;
		const lines = [`<!-- query="${query}" floor=${floor} (signal: slugs only, no body; OKS CLI floor is authoritative) -->`];
		for (const m of items) if ("slug" in m) lines.push(`- [${m.type ?? ""}] ${m.title ?? m.slug ?? ""} (slug: ${m.slug ?? ""}, rel: ${(m.relevance ?? 0).toFixed(2)})`);
		else lines.push(`- [episodic] ${m.source_path ?? ""} (rel: ${(m.relevance ?? 0).toFixed(2)})`);
		lines.push(`  如需更强证据，请调用 oks_recall 或执行 oks recall "${query}" --explain`);
		const slugs = items.map((m) => "slug" in m ? m.slug ?? "" : m.source_path ?? "").filter(Boolean);
		const injectId = randomUUID().slice(0, 8);
		lines.push(`<!-- inject_id:${injectId} slugs:${slugs.join(",")} -->`);
		return {
			text: [
				"<oks-memory-signal source=\"oks-posttool\">",
				...lines,
				"</oks-memory-signal>"
			].join("\n"),
			injectId,
			slugs
		};
	} catch {
		return null;
	}
}
/** Build a UserMessage carrying context text, tagged with our plugin source. */
function contextMessage(text) {
	return createUserMessage({
		content: [{
			type: "text",
			text
		}],
		source: PLUGIN_SOURCE
	});
}
/** Path to the inject-feedback JSONL log (under ~/.oks/, the global config dir). */
function feedbackLogPath() {
	return join(process.env.HOME ?? "/tmp", ".oks", "inject_feedback.log");
}
/** Append a feedback record as one JSONL line. Best-effort; never throws. */
function appendFeedback(record) {
	try {
		const line = JSON.stringify({
			...record,
			ts: (/* @__PURE__ */ new Date()).toISOString()
		});
		const dir = dirname(feedbackLogPath());
		mkdirSync(dir, { recursive: true });
		appendFileSync(feedbackLogPath(), line + "\n", "utf-8");
	} catch {}
}
/** Parse oks recall JSON to a plain {knowledge, episodic} object (no prompt text).
* Used by the multi-query fan-out in oks_recall. */
function parseRecallJson(stdout) {
	try {
		const d = JSON.parse(stdout);
		return {
			knowledge: d.knowledge ?? [],
			episodic: d.episodic ?? []
		};
	} catch {
		return {
			knowledge: [],
			episodic: []
		};
	}
}
/** Read ~/.oks/inject_feedback.log and tally ratings. Best-effort; never throws. */
function readInjectStats() {
	const empty = {
		total: 0,
		useful: 0,
		noise: 0,
		irrelevant: 0,
		bySlug: {}
	};
	try {
		const raw = readFileSync(feedbackLogPath(), "utf-8").trim();
		if (!raw) return empty;
		for (const line of raw.split("\n")) try {
			const r = JSON.parse(line);
			const rating = r.rating;
			if (!rating || !(rating in empty)) continue;
			empty[rating]++;
			empty.total++;
			const slugs = String(r.slugs ?? "").split(",").map((s) => s.trim()).filter(Boolean);
			for (const s of slugs) {
				empty.bySlug[s] ??= {
					useful: 0,
					noise: 0,
					irrelevant: 0
				};
				empty.bySlug[s][rating]++;
			}
		} catch {}
	} catch {}
	return empty;
}
/** Derive a recall query from a tool execution: its name + stringified args. */
function deriveQuery(exec) {
	const args = Object.entries(exec.args ?? {}).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" ");
	return `${exec.name} ${args}`.slice(0, 200);
}
/** Extract UI-safe recall facts without exposing prompts, snippets, or paths. */
function parseRecallStats(stdout) {
	try {
		const data = JSON.parse(stdout);
		const knowledge = data.knowledge ?? [];
		const episodic = data.episodic ?? [];
		const items = [...knowledge, ...episodic];
		const matches = [...knowledge.map((item) => safeTraceLabel(item.slug)).filter((value) => value !== "[知识条目]"), ...episodic.map(() => "episodic")].slice(0, 12);
		const relevance = items.map((item) => item.relevance).find((value) => typeof value === "number" && Number.isFinite(value));
		return {
			candidateCount: items.length,
			matches,
			topRelevance: relevance
		};
	} catch {
		return {
			candidateCount: 0,
			matches: []
		};
	}
}
/** Trace labels are identifiers only; never surface arbitrary OKS title text. */
function safeTraceLabel(value) {
	const label = String(value ?? "").trim();
	return /^[-_\.\p{L}\p{N}]{1,120}$/u.test(label) ? label : "[知识条目]";
}
/** Keep only short, sanitized, process-local activity facts for the browser. */
function pushActivity(events, kind, label, detail, status = "info", traceId) {
	events.unshift({
		id: randomUUID(),
		at: (/* @__PURE__ */ new Date()).toISOString(),
		kind,
		label,
		detail: detail.replace(/[\r\n]+/g, " ").replace(/[A-Za-z]:\\[^ ]+|\/(?:Users|home|tmp)\/[^ ]+/g, "[本地路径已隐藏]").replace(/(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^ ]+/gi, "[敏感值已隐藏]").slice(0, 180),
		status,
		traceId
	});
	if (events.length > 50) events.length = 50;
}
function apply(ctx, config = {}) {
	const activity = [];
	const traces = [];
	const oksVfs = createOksVfs();
	const recordActivity = (kind, label, detail, status = "info", traceId) => pushActivity(activity, kind, label, detail, status, traceId);
	const recordTrace = (phase, stdout, threshold, status = "ok") => {
		const traceId = randomUUID().slice(0, 12);
		const stats = parseRecallStats(stdout);
		traces.unshift({
			id: traceId,
			at: (/* @__PURE__ */ new Date()).toISOString(),
			phase,
			status,
			candidateCount: stats.candidateCount,
			matches: stats.matches,
			topRelevance: stats.topRelevance,
			threshold
		});
		if (traces.length > 50) traces.length = 50;
		return traceId;
	};
	const updateTrace = (traceId, status) => {
		const trace = traces.find((item) => item.id === traceId);
		if (trace) trace.status = status;
		return trace;
	};
	const recordHookTrace = (result) => {
		const traceId = randomUUID().slice(0, 12);
		traces.unshift(toOksRecallTrace(traceId, (/* @__PURE__ */ new Date()).toISOString(), result));
		if (traces.length > 50) traces.length = 50;
		return traceId;
	};
	const hookScopeArgs = () => [
		"--session-id",
		"dsh-oks",
		"--agent-id",
		"dsh-oks"
	];
	const settingsHooks = createDynamicSettingsHooks(config, async (cfg, changed) => {
		await syncOksConfig(cfg, changed);
		recordActivity("settings", "设置更新", `${changed.size} 项设置已同步`, "ok");
	});
	installSettingsSection(ctx, OKS_NS, OksConfigSchema, config, settingsHooks);
	ctx.connection.rpc.handle("/oks", async (endpoint, payload) => {
		const body = payload && typeof payload === "object" ? payload : {};
		const configuredPath = settingsHooks.getCurrent().knowledge_base_path || await readOksKnowledgeBasePath();
		if (endpoint === "activity") {
			const requested = typeof body.limit === "number" && Number.isFinite(body.limit) ? Math.floor(body.limit) : 12;
			const limit = Math.max(1, Math.min(20, requested));
			return {
				ok: true,
				value: {
					items: activity.slice(0, limit),
					truncated: activity.length > limit
				}
			};
		}
		if (endpoint === "recall-trace") {
			const requested = typeof body.limit === "number" && Number.isFinite(body.limit) ? Math.floor(body.limit) : 12;
			const limit = Math.max(1, Math.min(20, requested));
			let retained = [];
			try {
				retained = parseOksHookHistory(await runOks([
					"hook",
					"history",
					"--format",
					"json",
					"--limit",
					String(limit),
					"--session-id",
					"dsh-oks"
				]));
			} catch {}
			return {
				ok: true,
				value: mergeOksRecallTraceHistory(traces, retained, limit)
			};
		}
		const endpointLabels = {
			diagnostics: "读取连接诊断",
			overview: "读取知识库概览",
			"wiki-list": "浏览 Wiki 知识",
			"wiki-get": "打开 Wiki 详情",
			"draft-list": "浏览审核草稿",
			"draft-get": "打开草稿详情",
			"raw-list": "浏览 Raw 资料",
			"raw-get": "打开 Raw 详情"
		};
		if (endpointLabels[endpoint]) recordActivity("browser", endpointLabels[endpoint], "来自 OKS 工作区的只读请求");
		if (endpoint === "diagnostics") {
			let oksCliAvailable = true;
			try {
				await execAsync(oksBin(), ["--version"], { timeout: 5e3 });
			} catch {
				oksCliAvailable = false;
			}
			try {
				return {
					ok: true,
					value: await getOksDiagnostics(configuredPath, oksCliAvailable, oksVfs)
				};
			} catch (error) {
				warnSync("OKS diagnostics", error);
				return {
					ok: true,
					value: {
						connected: false,
						status: "read-error",
						message: "Unable to read OKS knowledge-base data.",
						oksCliAvailable,
						knowledgeBaseConfigured: Boolean(configuredPath),
						wikiDirectory: false,
						draftsDirectory: false,
						rawDirectory: false,
						wikiCount: 0,
						draftCount: 0,
						rawFileCount: 0,
						rawBundleCount: 0
					}
				};
			}
		}
		if (!configuredPath) return {
			ok: false,
			error: {
				code: "internal",
				message: "OKS knowledge_base_path is not configured.",
				details: {}
			}
		};
		try {
			if (endpoint === "overview") return {
				ok: true,
				value: await getOksOverview(oksVfs)
			};
			if (endpoint === "raw-list") return {
				ok: true,
				value: await listRawBundles({
					query: typeof body.query === "string" ? body.query : void 0,
					status: typeof body.status === "string" ? body.status : void 0
				}, oksVfs)
			};
			if (endpoint === "raw-get") {
				const value = await getRawBundle(body.id, oksVfs);
				if (!value) return {
					ok: false,
					error: {
						code: "internal",
						message: "The requested Raw Bundle was not found.",
						details: {}
					}
				};
				return {
					ok: true,
					value
				};
			}
			if (endpoint === "draft-list") return {
				ok: true,
				value: await listDraftPages({
					query: typeof body.query === "string" ? body.query : void 0,
					area: typeof body.area === "string" ? body.area : void 0,
					type: typeof body.type === "string" ? body.type : void 0
				}, oksVfs)
			};
			if (endpoint === "draft-get") {
				const value = await getDraftPage(body.slug, oksVfs);
				if (!value) return {
					ok: false,
					error: {
						code: "internal",
						message: "The requested Draft was not found.",
						details: {}
					}
				};
				return {
					ok: true,
					value
				};
			}
			if (endpoint === "wiki-list") return {
				ok: true,
				value: await listWikiPages({
					query: typeof body.query === "string" ? body.query : void 0,
					area: typeof body.area === "string" ? body.area : void 0,
					type: typeof body.type === "string" ? body.type : void 0
				}, oksVfs)
			};
			if (endpoint === "wiki-get") {
				const value = await getWikiPage(body.slug, oksVfs);
				if (!value) return {
					ok: false,
					error: {
						code: "internal",
						message: "The requested Wiki page was not found.",
						details: {}
					}
				};
				return {
					ok: true,
					value
				};
			}
			return {
				ok: false,
				error: {
					code: "internal",
					message: "Unknown dsh-oks browser endpoint.",
					details: {}
				}
			};
		} catch (error) {
			warnSync(`OKS lifecycle browser ${endpoint}`, error);
			return {
				ok: false,
				error: {
					code: "internal",
					message: "Unable to read the requested OKS lifecycle data.",
					details: {}
				}
			};
		}
	}, { authority: "trusted-host" });
	ctx.tools.register(defineTool({
		name: "oks_recall",
		description: "Recall relevant memories from the OKS knowledge base. Use when the task involves uncertain concepts, historical decisions, or competitor comparison. Query with task intent, not tool operations. Pass `queries` (5-6 guesses) to fan out: each is recalled in parallel and results merged + deduped by slug for richer coverage for ambiguous tasks.",
		parameters: {
			query: {
				type: "string",
				required: true,
				description: "Task-intent query. E.g. \"OKS memory system vs ai-book chapter 3\""
			},
			queries: {
				type: "array",
				description: "Optional 5-6 alternative phrasings; fanned out in parallel and deduped. E.g. [\"git branch naming\", \"branch strategy\", \"trunk-based development\"]."
			},
			limit: {
				type: "number",
				description: "Max results per query (default: recall.topn from settings, or 3)"
			}
		},
		output: {
			schema: { type: "string" },
			render: (_args, value) => [{
				type: "text",
				text: value
			}]
		},
		async execute(args) {
			const limit = args.limit ?? 3;
			const all = [args.query, ...args.queries ?? []].filter(Boolean);
			if (all.length <= 1) try {
				const out = await runOks([
					"recall",
					args.query,
					"--format",
					"json",
					"--limit",
					String(limit)
				]);
				const traceId = recordTrace("tool", out, limit);
				const trace = updateTrace(traceId, "ok");
				recordActivity("tool", "oks_recall", `返回 ${trace?.candidateCount ?? 0} 个候选`, "ok", traceId);
				return out;
			} catch (error) {
				const traceId = recordTrace("tool", "", limit, "error");
				recordActivity("tool", "oks_recall 失败", "OKS CLI 未返回可用结果", "error", traceId);
				throw error;
			}
			const outs = await Promise.all(all.map((q) => runOks([
				"recall",
				q,
				"--format",
				"json",
				"--limit",
				String(limit)
			]).then(parseRecallJson).catch(() => ({
				knowledge: [],
				episodic: []
			}))));
			const seen = /* @__PURE__ */ new Set();
			const knowledge = [];
			const episodic = [];
			for (const o of outs) {
				for (const h of o.knowledge ?? []) {
					const slug = String(h.slug ?? "");
					if (slug && !seen.has(slug)) {
						seen.add(slug);
						knowledge.push(h);
					}
				}
				for (const h of o.episodic ?? []) {
					const p = String(h.source_path ?? "");
					if (p && !seen.has(p)) {
						seen.add(p);
						episodic.push(h);
					}
				}
			}
			const out = JSON.stringify({
				schema_version: "recall-response/v1-multi",
				query: args.query,
				knowledge,
				episodic
			});
			const traceId = recordTrace("tool", out, limit);
			const trace = updateTrace(traceId, "ok");
			recordActivity("tool", "oks_recall 多查询", `合并 ${trace?.candidateCount ?? 0} 个候选`, "ok", traceId);
			return out;
		}
	}));
	ctx.tools.register(defineTool({
		name: "oks_status",
		description: "Show OKS knowledge base status: wiki count, tier distribution, drafts.",
		parameters: {},
		output: {
			schema: { type: "string" },
			render: (_args, value) => [{
				type: "text",
				text: value
			}]
		},
		async execute() {
			try {
				const out = await runOks(["status"]);
				recordActivity("tool", "oks_status", "读取知识库状态", "ok");
				return out;
			} catch (error) {
				recordActivity("tool", "oks_status 失败", "OKS CLI 未返回状态", "error");
				throw error;
			}
		}
	}));
	ctx.tools.register(defineTool({
		name: "oks_wiki_use",
		description: "Mark a wiki page as used (access_count++). Call this when you actually cited or applied a recalled memory; it is the self-evaluation signal.",
		parameters: { slug: {
			type: "string",
			required: true,
			description: "Wiki page slug"
		} },
		output: {
			schema: { type: "string" },
			render: (_args, value) => [{
				type: "text",
				text: value
			}]
		},
		async execute(args) {
			try {
				const out = await runOks([
					"wiki",
					"use",
					args.slug
				]);
				recordActivity("tool", "oks_wiki_use", "记录 Wiki 使用信号", "ok");
				return out;
			} catch (error) {
				recordActivity("tool", "oks_wiki_use 失败", "Wiki 使用信号记录失败", "error");
				throw error;
			}
		}
	}));
	ctx.tools.register(defineTool({
		name: "oks_metrics",
		description: "Show OKS 4-dimension knowledge metrics (scale, vitality, value, credibility) plus injection stats and current recall params.",
		parameters: {},
		output: {
			schema: { type: "string" },
			render: (_args, value) => [{
				type: "text",
				text: value
			}]
		},
		async execute() {
			const base = await runOks(["metrics"]);
			const s = readInjectStats();
			const rate = s.total > 0 ? Math.round(s.useful / s.total * 100) : 0;
			const injectBlock = `\n--- OKS injection feedback ---\nTotal: ${s.total} | useful ${s.useful} (${s.total ? Math.round(s.useful / s.total * 100) : 0}%) | noise ${s.noise} | irrelevant ${s.irrelevant} | useful rate ${rate}%`;
			const topSlugs = Object.entries(s.bySlug).sort((a, b) => b[1].useful + b[1].noise - (a[1].useful + a[1].noise)).slice(0, 5);
			const slugLines = topSlugs.length ? topSlugs.map(([slug, c]) => `  ${slug}: useful ${c.useful} / noise ${c.noise}`).join("\n") : "  No per-slug feedback yet.";
			return base + injectBlock + "\nTop slugs:\n" + slugLines;
		}
	}));
	ctx.tools.register(defineTool({
		name: "oks_inject_stats",
		description: "Show OKS injection-quality stats: total feedback count, useful/noise/irrelevant breakdown, and per-slug ratings. Use to decide whether to adjust the OKS recall floor (more noise vs. missed useful context).",
		parameters: {},
		output: {
			schema: { type: "string" },
			render: (_args, value) => [{
				type: "text",
				text: value
			}]
		},
		async execute() {
			const s = readInjectStats();
			if (s.total === 0) return "No OKS injection feedback recorded yet.";
			return JSON.stringify(s, null, 2);
		}
	}));
	ctx.tools.register(defineTool({
		name: "oks_inject_feedback",
		description: "Rate a prior OKS memory injection by its inject_id. Call this after answering when an injected <recalled-memory> or <oks-memory-signal> block carried a <!-- inject_id:xxx slugs:a,b --> tag. useful = cited/applied the memory; noise = irrelevant clutter; irrelevant = on-topic but not needed this turn. This feeds the injection-quality metric used to tune recall floors.",
		parameters: {
			inject_id: {
				type: "string",
				required: true,
				description: "inject_id from the injection tag"
			},
			rating: {
				type: "string",
				required: true,
				description: "one of: useful | noise | irrelevant"
			},
			slugs: {
				type: "string",
				description: "comma-list of slugs that were in the injection (optional)"
			},
			reason: {
				type: "string",
				description: "one-line why (optional)"
			}
		},
		output: {
			schema: { type: "string" },
			render: (_args, value) => [{
				type: "text",
				text: value
			}]
		},
		async execute(args) {
			const rating = String(args.rating);
			if (![
				"useful",
				"noise",
				"irrelevant"
			].includes(rating)) return `error: rating must be useful|noise|irrelevant, got '${rating}'`;
			appendFeedback({
				inject_id: args.inject_id,
				rating,
				slugs: args.slugs ?? "",
				reason: args.reason ?? ""
			});
			return `recorded: inject_id=${args.inject_id} rating=${rating}`;
		}
	}));
	ctx.on("agent/pre-step", async ({ messages }, next) => {
		if (!isPrestepRecallEnabled(settingsHooks.getCurrent())) return next();
		const query = extractQuery(messages);
		let recalled = null;
		try {
			recalled = parseOksHookRecall(await runOks([
				"hook",
				"recall",
				query,
				"--format",
				"json",
				...hookScopeArgs()
			]));
		} catch {
			recalled = null;
		}
		if (!recalled) {
			const traceId = recordTrace("pre-step", "", void 0, "error");
			recordActivity("prestep", "Pre-step 召回失败", "OKS Hook CLI 未返回有效结果", "error", traceId);
			return next();
		}
		const traceId = recordHookTrace(recalled);
		if (recalled.status !== "injected" || !recalled.context) {
			const trace = traces.find((item) => item.id === traceId);
			const detail = recalled.status === "skipped_minlen" ? "OKS 按最短问题长度跳过召回" : recalled.status === "skipped_cooldown" ? "OKS 按冷却策略跳过重复注入" : recalled.status === "error" ? "OKS Hook 召回失败" : `OKS 未命中可注入的知识（${trace?.candidateCount ?? 0} 个候选）`;
			recordActivity("prestep", "Pre-step 召回", detail, recalled.status === "error" ? "error" : "info", traceId);
			return next();
		}
		const trace = traces.find((item) => item.id === traceId);
		recordActivity("prestep", "Pre-step 召回", `已由 OKS 生成上下文注入（${trace?.candidateCount ?? 0} 个候选）`, "ok", traceId);
		const downstream = await next();
		if (downstream.kind !== "enter") return downstream;
		return {
			kind: "enter",
			messages: [...downstream.messages, contextMessage(recalled.context)]
		};
	});
	ctx.on("tools/post-execute", async (exec, _result, next) => {
		if (!SIGNAL_TOOLS.has(exec.name)) return next();
		const query = deriveQuery(exec);
		if (query.length < 6) return next();
		const activeConfig = settingsHooks.getCurrent();
		const floor = activeConfig.posttool_floor ?? .9;
		const topn = activeConfig.posttool_topn ?? 2;
		let out = "";
		try {
			out = await runOks([
				"recall",
				query,
				"--format",
				"json",
				"--limit",
				String(topn),
				"--floor",
				String(floor)
			]);
		} catch {
			const traceId = recordTrace("post-tool", "", floor, "error");
			recordActivity("posttool", "Post-tool 召回失败", `工具 ${exec.name} 未返回可用结果`, "error", traceId);
			return next();
		}
		const traceId = recordTrace("post-tool", out, floor);
		const signal = (activeConfig.posttool_mode === "full" ? "full" : "signal") === "full" ? parseRecall(out) : parseSignal(out, query, floor, activeConfig.posttool_signal_rel_floor);
		if (!signal) {
			updateTrace(traceId, "empty");
			recordActivity("posttool", "Post-tool 信号", `工具 ${exec.name} 未命中相关知识`, "info", traceId);
			return next();
		}
		recordActivity("posttool", "Post-tool 信号", `工具 ${exec.name} 生成脱敏记忆提示`, "ok", traceId);
		const downstream = await next();
		return {
			...downstream,
			additionalContexts: [contextMessage(signal.text), ...downstream.additionalContexts ?? []]
		};
	});
	const skills = ctx.get("skills");
	if (skills) readFile(join(__dirname, "..", "skills", "SKILL.md"), "utf8").then((content) => {
		skills.register({
			name: "oks-recall",
			description: "Recall OKS memories when facing uncertain concepts or historical decisions",
			content,
			source: "runtime",
			provider: "dsh-oks"
		});
	}).catch(() => {});
}
//#endregion
export { OKS_NS, OksConfigSchema, apply, inject, name, parseSignal };
