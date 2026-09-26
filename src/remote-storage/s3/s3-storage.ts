import { AwsClient } from 'aws4fetch'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { LEGACY_PLUGIN_ID } from '~/legacy-identity'
import { RemoteStorageError } from '../errors'
import type { RemoteScanOptions } from '../remote-scanner.interface'
import RemoteStorage, {
	type DeleteOptions,
	type DownloadOptions,
	type DownloadResult,
	type MkdirOptions,
	type MutationSupport,
	type RemoteCapabilities,
	type RemoteBufferLike,
	type RemoteStat,
	type UploadOptions,
	type UploadResult,
} from '../remote-storage.interface'
import {
	normalizeS3Settings,
	validateRelativePath,
	type S3Settings,
} from './settings'
import type { S3HttpResponse, S3Transport } from './transport'

const xml = new XMLParser({
	parseTagValue: false,
	trimValues: false,
	ignoreAttributes: true,
	processEntities: true,
})

/** S3 mutations require a version condition or explicit compatibility consent. */
export class S3RemoteStorage extends RemoteStorage {
	readonly type = 's3'
	get capabilities(): Readonly<RemoteCapabilities> {
		return Object.freeze({
			rangeRead: 'supported',
			conditionalRead: 'supported',
			conditionalWrite: this.mutationSupport
				? this.mutationSupport.create && this.mutationSupport.overwrite
					? 'supported'
					: 'unsupported'
				: 'unknown',
			conditionalDelete: this.mutationSupport
				? this.mutationSupport.delete
					? 'supported'
					: 'unsupported'
				: 'unknown',
			recursiveDelete: 'unsupported',
		})
	}
	readonly settings: Readonly<S3Settings>
	private readonly signer: AwsClient
	private mutationSupport?: MutationSupport

	constructor(
		settings: S3Settings,
		private readonly transport: S3Transport,
	) {
		super()
		this.settings = normalizeS3Settings(settings)
		this.signer = new AwsClient({
			accessKeyId: this.settings.accessKeyId,
			secretAccessKey: this.settings.secretAccessKey,
			sessionToken: this.settings.sessionToken || undefined,
			region: this.settings.region,
			service: 's3',
			retries: 0,
		})
	}

	async stat(path: string): Promise<RemoteStat> {
		const relative = this.relativePath(path)
		if (!relative) {
			// A missing prefix is valid. A missing/inaccessible bucket is not.
			await this.listPage(this.settings.prefix, undefined, 1)
			return this.directory('')
		}
		try {
			const response = await this.request(
				'HEAD',
				this.objectUrl(this.key(path)),
			)
			const headers = new Headers(response.headers)
			return this.file(
				relative,
				headers.get('content-length'),
				headers.get('last-modified'),
				headers.get('etag'),
				headers.get('x-amz-version-id'),
			)
		} catch (error) {
			if (!(error instanceof RemoteStorageError) || error.code !== 'not-found')
				throw error
			const page = await this.listPage(
				`${this.settings.prefix}${relative}/`,
				undefined,
				1,
			)
			if (page.contents.length) return this.directory(relative)
			throw error
		}
	}

	async getDirectoryContents(path: string): Promise<RemoteStat[]> {
		const relative = this.relativePath(path)
		const prefix = relative ? `/${relative}/` : '/'
		return (await this.scanEntries()).filter(
			(entry) =>
				entry.path.startsWith(prefix) &&
				!entry.path.slice(prefix.length).includes('/'),
		)
	}

	async getFileContents(
		path: string,
		options: DownloadOptions = {},
	): Promise<DownloadResult> {
		const url = this.objectUrl(this.key(path))
		const headers: Record<string, string> = {}
		if (options.expectedVersion?.etag)
			headers['If-Match'] = options.expectedVersion.etag
		if (options.expectedVersion?.versionId)
			url.searchParams.set('versionId', options.expectedVersion.versionId)
		if (
			options.expectedVersion &&
			!options.expectedVersion.etag &&
			!options.expectedVersion.versionId
		)
			throw new RemoteStorageError(
				'unsupported',
				'A nonempty object version is required',
			)
		if (options.range) {
			const { start, end } = options.range
			if (
				!Number.isSafeInteger(start) ||
				!Number.isSafeInteger(end) ||
				start < 0 ||
				end < start
			)
				throw new RemoteStorageError(
					'invalid-response',
					'Invalid download range',
				)
			headers.Range = `bytes=${start}-${end}`
		}
		const response = await this.request('GET', url, headers)
		const responseHeaders = new Headers(response.headers)
		const etag = responseHeaders.get('etag') || undefined
		const versionId = responseHeaders.get('x-amz-version-id') || undefined
		if (
			(options.expectedVersion?.etag &&
				options.expectedVersion.etag !== etag) ||
			(options.expectedVersion?.versionId &&
				options.expectedVersion.versionId !== versionId)
		) {
			throw new RemoteStorageError(
				'precondition-failed',
				'S3 returned a different object version',
			)
		}
		const result: DownloadResult = {
			data: response.body,
			version: { etag, versionId },
		}
		if (options.range) {
			const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
				responseHeaders.get('content-range') ?? '',
			)
			const { start, end } = options.range
			if (
				response.status !== 206 ||
				!match ||
				Number(match[1]) !== start ||
				Number(match[2]) !== end ||
				Number(match[3]) <= end ||
				response.body.byteLength !== end - start + 1
			) {
				throw new RemoteStorageError(
					'invalid-response',
					'S3 returned an invalid byte range',
				)
			}
			result.range = { start, end, total: Number(match[3]) }
		} else if (
			response.status !== 200 ||
			responseHeaders.get('content-range')
		) {
			throw new RemoteStorageError(
				'invalid-response',
				'S3 returned a partial response for a full download',
			)
		}
		const length = responseHeaders.get('content-length')
		if (length !== null && Number(length) !== response.body.byteLength)
			throw new RemoteStorageError(
				'invalid-response',
				'S3 response length mismatch',
			)
		return result
	}

	async scanEntries(options: RemoteScanOptions = {}): Promise<RemoteStat[]> {
		const entries = new Map<string, RemoteStat>()
		const keys = new Set<string>()
		const aliases = new Map<string, string>()
		const cursors = new Set<string>()
		let cursor: string | undefined
		let pages = 0
		options.onProgress?.({
			phase: 'scanning',
			processedPages: 0,
			processedDirectories: 0,
			queuedDirectories: 0,
			discoveredItems: 0,
			processedChanges: 0,
		})
		const add = (entry: RemoteStat) => {
			const alias = entry.path.normalize('NFC').toLowerCase()
			const priorPath = aliases.get(alias)
			const prior = entries.get(entry.path)
			if (
				(priorPath && priorPath !== entry.path) ||
				(prior && prior.isDir !== entry.isDir)
			) {
				throw new RemoteStorageError(
					'conflict',
					`Ambiguous S3 paths: ${priorPath ?? entry.path} / ${entry.path}`,
				)
			}
			aliases.set(alias, entry.path)
			entries.set(entry.path, entry)
		}
		do {
			options.throwIfCancelled?.()
			const page = await this.listPage(
				this.settings.prefix,
				cursor,
				1000,
				options,
			)
			options.throwIfCancelled?.()
			for (const object of page.contents) {
				const key = decodeKey(object.Key)
				if (!key.startsWith(this.settings.prefix))
					throw new RemoteStorageError(
						'invalid-response',
						'S3 listed an object outside the configured prefix',
					)
				if (keys.has(key))
					throw new RemoteStorageError(
						'invalid-response',
						'S3 listed a duplicate object; retry the scan',
					)
				keys.add(key)
				const rawRelative = key.slice(this.settings.prefix.length)
				if (
					rawRelative.startsWith('.jasync-internal/') ||
					rawRelative.startsWith(`.${LEGACY_PLUGIN_ID}-internal/`)
				)
					continue
				if (!rawRelative) {
					if (object.Size !== '0')
						throw new RemoteStorageError(
							'conflict',
							'Nonempty S3 prefix marker cannot be synchronized',
						)
					continue
				}
				const isDirectory = rawRelative.endsWith('/')
				const relative = isDirectory ? rawRelative.slice(0, -1) : rawRelative
				validateRelativePath(relative)
				const parts = relative.split('/')
				for (let index = 1; index < parts.length; index++)
					add(this.directory(parts.slice(0, index).join('/')))
				if (isDirectory) {
					if (object.Size !== '0')
						throw new RemoteStorageError(
							'conflict',
							'Nonempty S3 directory marker cannot be synchronized',
						)
					add(this.directory(relative))
				} else
					add(
						this.file(relative, object.Size, object.LastModified, object.ETag),
					)
			}
			cursor = page.next
			if (cursor && cursors.has(cursor))
				throw new RemoteStorageError(
					'invalid-response',
					'S3 repeated a continuation token',
				)
			if (cursor) cursors.add(cursor)
			pages++
			options.onProgress?.({
				phase: cursor ? 'scanning' : 'complete',
				processedPages: pages,
				processedDirectories: 0,
				queuedDirectories: 0,
				discoveredItems: entries.size,
				processedChanges: 0,
			})
		} while (cursor)
		options.throwIfCancelled?.()
		return [...entries.values()]
	}

	async putFileContents(
		path: string,
		content: RemoteBufferLike | string,
		options: UploadOptions,
	): Promise<UploadResult> {
		const supported =
			this.mutationSupport?.[options.mode === 'create' ? 'create' : 'overwrite']
		if (!supported && !options.allowUnconditional)
			throw new RemoteStorageError(
				'unsupported',
				'Conditional upload is not verified. Confirm compatibility mode to proceed.',
			)
		if (options.mode === 'overwrite' && !options.expectedVersion?.etag)
			throw new RemoteStorageError(
				'precondition-failed',
				'An expected ETag is required for overwrite',
			)
		const headers: Record<string, string> = {
			'Content-Type': 'application/octet-stream',
		}
		// Keep verified protections even when a different operation required
		// compatibility consent. Do not resend headers the service rejected.
		if (supported) {
			if (options.mode === 'create')
				Object.assign(headers, this.createConditionHeaders())
			else headers['If-Match'] = options.expectedVersion!.etag!
		}
		const body =
			typeof content === 'string'
				? new TextEncoder().encode(content).buffer
				: content instanceof Uint8Array
					? new Uint8Array(content).buffer
					: content
		const response = await this.request(
			'PUT',
			this.objectUrl(this.key(path)),
			headers,
			{},
			body,
		)
		const responseHeaders = new Headers(response.headers)
		const etag = responseHeaders.get('etag')
		if (!etag)
			throw new RemoteStorageError(
				'invalid-response',
				'Upload returned no ETag; outcome is uncertain. Rescan before retrying.',
			)
		return {
			success: true,
			version: {
				etag,
				versionId:
					responseHeaders.get('x-amz-version-id') ||
					responseHeaders.get('x-cos-version-id') ||
					undefined,
			},
		}
	}
	async deleteFile(path: string, options: DeleteOptions = {}): Promise<void> {
		if (!this.mutationSupport?.delete && !options.allowUnconditional)
			throw new RemoteStorageError(
				'unsupported',
				'Conditional deletion is not verified. Confirm compatibility mode to proceed.',
			)
		if (!options.expectedVersion?.etag)
			throw new RemoteStorageError(
				'precondition-failed',
				'An expected ETag is required for deletion',
			)
		// Never delete a historical version: that can expose an older object.
		await this.request(
			'DELETE',
			this.objectUrl(this.key(path)),
			this.mutationSupport?.delete
				? { 'If-Match': options.expectedVersion.etag }
				: {},
		)
	}
	async createDirectory(path: string, _options?: MkdirOptions): Promise<void> {
		// S3 folders are virtual; uploading a child creates the prefix.
		this.relativePath(path)
	}

	private createConditionHeaders(): Record<string, string> {
		// COS documents its own create-only condition. Sending If-None-Match
		// alongside it can trigger unrelated cache-validation behavior.
		return this.settings.endpoint.endsWith('.myqcloud.com')
			? { 'x-cos-forbid-overwrite': 'true' }
			: { 'If-None-Match': '*' }
	}

	override async verifyMutationSupport(): Promise<MutationSupport> {
		if (this.mutationSupport) return this.mutationSupport
		const probeRoot = `${this.settings.prefix}.jasync-internal/probes/${crypto.randomUUID()}`
		const first = new TextEncoder().encode('JASync capability probe A').buffer
		const second = new TextEncoder().encode(
			'JASync capability probe B',
		).buffer
		// A 304 is never a completed mutation or sufficient proof of safe
		// conditional writes. Classify it as unsupported only inside probes.
		const attempt = async (operation: () => Promise<S3HttpResponse>) => {
			try {
				return await operation()
			} catch (error) {
				if (
					error instanceof RemoteStorageError &&
					[304, 400, 409, 412, 501].includes(error.status ?? 0)
				)
					return error.status!
				throw error
			}
		}
		const etag = (response: S3HttpResponse) => {
			const value = new Headers(response.headers).get('etag')
			if (!value)
				throw new RemoteStorageError(
					'invalid-response',
					'S3 capability probe returned no ETag',
				)
			return value
		}
		const matches = async (url: URL, data: ArrayBuffer, version: string) => {
			try {
				const response = await this.request('GET', url)
				return (
					etag(response) === version &&
					response.body.byteLength === data.byteLength &&
					new Uint8Array(response.body).every(
						(value, index) => value === new Uint8Array(data)[index],
					)
				)
			} catch (error) {
				if (error instanceof RemoteStorageError && error.code === 'not-found')
					return false
				throw error
			}
		}
		const probe = async (kind: keyof MutationSupport): Promise<boolean> => {
			const url = this.objectUrl(`${probeRoot}/${kind}`)
			try {
				// The first conditional PUT is itself the positive create test.
				let seed = await attempt(() =>
					this.request('PUT', url, this.createConditionHeaders(), {}, first),
				)
				if (typeof seed === 'number') {
					if (kind === 'create') return false
					// Only our random probe object can be seeded unconditionally.
					// A real user-file write is never retried without its condition.
					if (![304, 400, 501].includes(seed)) return false
					seed = await this.request('PUT', url, {}, {}, first)
				}
				const version = etag(seed)
				if (!(await matches(url, first, version))) return false
				const condition =
					kind === 'create'
						? this.createConditionHeaders()
						: { 'If-Match': '"jasync-impossible-etag"' }
				const negative = await attempt(() =>
					this.request(
						kind === 'delete' ? 'DELETE' : 'PUT',
						url,
						condition,
						{},
						kind === 'delete' ? undefined : second,
					),
				)
				if (negative !== 409 && negative !== 412) return false
				if (!(await matches(url, first, version))) return false
				if (kind === 'create') return true
				// Rejection alone does not prove support: matching conditions must
				// also work, and the resulting bytes/absence must match the receipt.
				const positive = await attempt(() =>
					this.request(
						kind === 'delete' ? 'DELETE' : 'PUT',
						url,
						{ 'If-Match': version },
						{},
						kind === 'delete' ? undefined : second,
					),
				)
				if (typeof positive === 'number') return false
				if (kind === 'overwrite')
					return await matches(url, second, etag(positive))
				try {
					await this.request('HEAD', url)
					return false
				} catch (error) {
					if (error instanceof RemoteStorageError && error.code === 'not-found')
						return true
					throw error
				}
			} catch (error) {
				if (error instanceof RemoteStorageError)
					throw new RemoteStorageError(
						error.code,
						`S3 ${kind} capability check failed: ${error.message}`,
						error.status,
						error,
					)
				throw error
			} finally {
				await this.request('DELETE', url).catch(() => {})
			}
		}
		const create = await probe('create')
		const overwrite = await probe('overwrite')
		const deletion = await probe('delete')
		this.mutationSupport = { create, overwrite, delete: deletion }
		return this.mutationSupport
	}

	private relativePath(path: string): string {
		if (!path.startsWith('/')) throw new Error('Remote paths must be absolute')
		const relative = path.slice(1).replace(/\/$/, '')
		if (relative) validateRelativePath(relative)
		return relative
	}

	private key(path: string): string {
		const relative = this.relativePath(path)
		if (!relative) throw new Error('A file path is required')
		return `${this.settings.prefix}${relative}`
	}

	private objectUrl(key: string): URL {
		const url = new URL(this.settings.endpoint)
		const segments = key
			.split('/')
			.map((part) =>
				encodeURIComponent(part).replace(
					/[!'()*]/g,
					(char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
				),
			)
			.join('/')
		if (this.settings.forcePathStyle)
			url.pathname = `/${this.settings.bucket}/${segments}`
		else {
			url.hostname = `${this.settings.bucket}.${url.hostname}`
			url.pathname = `/${segments}`
		}
		return url
	}

	private async listPage(
		prefix: string,
		cursor?: string,
		limit = 1000,
		options: RemoteScanOptions = {},
	) {
		const url = this.objectUrl('')
		url.searchParams.set('list-type', '2')
		url.searchParams.set('encoding-type', 'url')
		url.searchParams.set('prefix', prefix)
		url.searchParams.set('max-keys', String(limit))
		if (cursor) url.searchParams.set('continuation-token', cursor)
		const response = await this.request('GET', url, {}, options)
		const text = new TextDecoder().decode(response.body)
		try {
			if (/<!DOCTYPE/i.test(text)) throw new Error('Unexpected DOCTYPE')
			// The parser already includes a browser-safe syntax validator. The
			// separate fast-xml-validator package pulls in Node-only startup code.
			if (XMLValidator.validate(text) !== true)
				throw new Error('Malformed XML')
		} catch {
			throw new RemoteStorageError('invalid-response', 'Invalid S3 listing XML')
		}
		const parsed = xml.parse(text) as {
			ListBucketResult?: {
				EncodingType?: string
				IsTruncated?: string
				NextContinuationToken?: string
				Contents?: S3Object | S3Object[]
			}
		}
		const page = parsed.ListBucketResult
		if (
			!page ||
			page.EncodingType !== 'url' ||
			!['true', 'false'].includes(page.IsTruncated ?? '')
		)
			throw new RemoteStorageError(
				'invalid-response',
				'Incomplete S3 listing response',
			)
		if (
			page.Contents !== undefined &&
			(typeof page.Contents !== 'object' || page.Contents === null)
		) {
			throw new RemoteStorageError(
				'invalid-response',
				'Invalid S3 listing contents',
			)
		}
		const contents = page.Contents
			? Array.isArray(page.Contents)
				? page.Contents
				: [page.Contents]
			: []
		const next =
			page.IsTruncated === 'true' ? page.NextContinuationToken : undefined
		if (page.IsTruncated === 'true' && (typeof next !== 'string' || !next))
			throw new RemoteStorageError(
				'invalid-response',
				'S3 listing is truncated without a continuation token',
			)
		return { contents, next }
	}

	private file(
		relative: string,
		size: unknown,
		modified: unknown,
		etag: unknown,
		versionId?: string | null,
	): RemoteStat {
		const bytes =
			typeof size === 'string' && /^\d+$/.test(size) ? Number(size) : NaN
		const mtime = typeof modified === 'string' ? Date.parse(modified) : NaN
		if (
			!Number.isSafeInteger(bytes) ||
			bytes < 0 ||
			!Number.isFinite(mtime) ||
			typeof etag !== 'string' ||
			!etag
		)
			throw new RemoteStorageError(
				'invalid-response',
				'S3 object metadata is incomplete',
			)
		return {
			path: `/${relative}`,
			basename: relative.split('/').at(-1)!,
			isDir: false,
			isDeleted: false,
			size: bytes,
			mtime,
			version: { etag, versionId: versionId || undefined },
		}
	}

	private directory(relative: string): RemoteStat {
		return {
			path: `/${relative}`,
			basename: relative.split('/').at(-1) || '/',
			isDir: true,
			isDeleted: false,
		}
	}

	private async request(
		method: 'GET' | 'HEAD' | 'PUT' | 'DELETE',
		url: URL,
		headers: Record<string, string> = {},
		options: RemoteScanOptions = {},
		body?: ArrayBuffer,
	): Promise<S3HttpResponse> {
		for (let attempt = 0; ; attempt++) {
			options.throwIfCancelled?.()
			const signed = await this.signer.sign(url.toString(), {
				method,
				headers,
				body,
				aws: { allHeaders: true },
			})
			const signedHeaders: Record<string, string> = {}
			signed.headers.forEach((value, key) => {
				signedHeaders[key] = value
			})
			let response: S3HttpResponse
			try {
				response = await this.transport({
					url: signed.url,
					method,
					headers: signedHeaders,
					...(body === undefined ? {} : { body }),
				})
			} catch {
				throw new RemoteStorageError('network', 'S3 network request failed')
			}
			options.throwIfCancelled?.()
			if (response.status >= 200 && response.status < 300) return response
			if (
				(method === 'GET' || method === 'HEAD') &&
				[429, 500, 502, 503, 504].includes(response.status) &&
				attempt < 2
			) {
				await new Promise((resolve) =>
					window.setTimeout(resolve, 200 * 2 ** attempt),
				)
				continue
			}
			const code =
				response.status === 404
					? 'not-found'
					: response.status === 401
						? 'unauthorized'
						: response.status === 403
							? 'forbidden'
							: response.status === 412
								? 'precondition-failed'
								: response.status === 429 || response.status === 503
									? 'rate-limited'
									: 'unknown'
			throw new RemoteStorageError(
				code,
				`S3 ${method} failed (HTTP ${response.status})`,
				response.status,
			)
		}
	}
}

interface S3Object {
	Key?: string
	Size?: string
	LastModified?: string
	ETag?: string
}

function decodeKey(value: unknown): string {
	if (typeof value !== 'string')
		throw new RemoteStorageError('invalid-response', 'S3 object key is missing')
	try {
		return decodeURIComponent(value)
	} catch {
		throw new RemoteStorageError(
			'invalid-response',
			'S3 object key has invalid URL encoding',
		)
	}
}
