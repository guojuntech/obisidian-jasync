import { describe, expect, it, vi } from 'vitest'
import { S3RemoteStorage } from './s3-storage'
import { DEFAULT_S3_SETTINGS, normalizeS3Settings } from './settings'
import type { S3HttpResponse, S3Transport } from './transport'

const settings = {
	...DEFAULT_S3_SETTINGS,
	forcePathStyle: true,
	endpoint: 'https://storage.example.test',
	bucket: 'notes',
	prefix: 'vault',
	accessKeyId: 'test-key',
	secretAccessKey: 'test-secret',
}
const bytes = (text: string) => new TextEncoder().encode(text).buffer
const response = (
	text = '',
	status = 200,
	headers: Record<string, string> = {},
): S3HttpResponse => ({ status, headers, body: bytes(text) })
const object = (key: string, size = 1) =>
	`<Contents><Key>${encodeURIComponent(key)}</Key><Size>${size}</Size><LastModified>2026-01-01T00:00:00Z</LastModified><ETag>&quot;etag&quot;</ETag></Contents>`
const page = (objects = '', next?: string) =>
	response(
		`<ListBucketResult><EncodingType>url</EncodingType><IsTruncated>${Boolean(next)}</IsTruncated>${next ? `<NextContinuationToken>${next}</NextContinuationToken>` : ''}${objects}</ListBucketResult>`,
	)
const storage = (transport: S3Transport) =>
	new S3RemoteStorage(settings, transport)

describe('S3 scanning and signing', () => {
	it('exhausts 1,001 objects across pages and derives directories', async () => {
		const transport = vi
			.fn<S3Transport>()
			.mockResolvedValueOnce(
				page(
					Array.from({ length: 1000 }, (_, index) =>
						object(`vault/a/${index}.md`),
					).join(''),
					'opaque+cursor=',
				),
			)
			.mockResolvedValueOnce(page(object('vault/中文/a #+%.md')))
		const progress = vi.fn()
		const entries = await storage(transport).scanEntries({
			onProgress: progress,
		})
		expect(entries.filter((entry) => !entry.isDir)).toHaveLength(1001)
		expect(
			entries.find((entry) => entry.path === '/中文/a #+%.md'),
		).toMatchObject({ version: { etag: '"etag"' } })
		expect(entries.find((entry) => entry.path === '/a')).toMatchObject({
			isDir: true,
		})
		const request = transport.mock.calls[1][0]
		expect(new URL(request.url).searchParams.get('continuation-token')).toBe(
			'opaque+cursor=',
		)
		expect(new URL(request.url).searchParams.get('prefix')).toBe('vault/')
		expect(request.headers.authorization).toContain('AWS4-HMAC-SHA256')
		expect(request.headers.authorization).toContain(
			'/us-east-1/s3/aws4_request',
		)
		expect(progress.mock.lastCall?.[0].phase).toBe('complete')
	})

	it('accepts an empty prefix as a complete empty snapshot', async () => {
		await expect(storage(async () => page()).scanEntries()).resolves.toEqual([])
	})

	it.each([401, 403, 404])(
		'rejects HTTP %s on a later page without returning partial data',
		async (status) => {
			const transport = vi
				.fn<S3Transport>()
				.mockResolvedValueOnce(page(object('vault/a.md'), 'next'))
				.mockResolvedValueOnce(response('', status))
			await expect(storage(transport).scanEntries()).rejects.toMatchObject({
				status,
			})
		},
	)

	it.each([
		['neighbor prefix', object('vault-other/a.md')],
		['parent path', object('vault/../a.md')],
		['duplicate', object('vault/a.md') + object('vault/a.md')],
		['file and directory', object('vault/a') + object('vault/a/b.md')],
		['case collision', object('vault/A.md') + object('vault/a.md')],
		['Unicode collision', object('vault/é.md') + object('vault/e\u0301.md')],
		['nonempty directory marker', object('vault/dir/', 1)],
		[
			'invalid metadata',
			'<Contents><Key>vault%2Fa</Key><Size>-1</Size></Contents>',
		],
	])('rejects %s', async (_name, listing) => {
		await expect(
			storage(async () => page(listing)).scanEntries(),
		).rejects.toThrow()
	})

	it.each([
		'<ListBucketResult><IsTruncated>false</IsTruncated>',
		'<ListBucketResult><EncodingType>url</EncodingType><IsTruncated>true</IsTruncated></ListBucketResult>',
		'<ListBucketResult></ListBucketResult>',
	])('rejects malformed or incomplete listing: %s', async (body) => {
		await expect(
			storage(async () => response(body)).scanEntries(),
		).rejects.toThrow()
	})

	it('rejects repeated continuation tokens', async () => {
		await expect(
			storage(async () => page('', 'repeat')).scanEntries(),
		).rejects.toThrow('continuation token')
	})

	it('checks cancellation after in-flight page completion', async () => {
		let cancelled = false
		const transport = vi.fn<S3Transport>(async () => {
			cancelled = true
			return page(object('vault/a.md'), 'next')
		})
		await expect(
			storage(transport).scanEntries({
				throwIfCancelled: () => {
					if (cancelled) throw new Error('cancelled')
				},
			}),
		).rejects.toThrow('cancelled')
		expect(transport).toHaveBeenCalledTimes(1)
	})

	it('derives one-level browsing including empty markers', async () => {
		const result = await storage(async () =>
			page(
				object('vault/root.md') +
					object('vault/nested/a.md') +
					object('vault/empty/', 0),
			),
		).getDirectoryContents('/')
		expect(result.map((entry) => entry.path).sort()).toEqual([
			'/empty',
			'/nested',
			'/root.md',
		])
	})
})

describe('S3 read contracts', () => {
	it('only returns false for absence and propagates authorization/network errors', async () => {
		const missing = storage(async (request) =>
			request.method === 'HEAD' ? response('', 404) : page(),
		)
		await expect(missing.exists('/missing')).resolves.toBe(false)
		await expect(
			storage(async () => response('', 403)).exists('/a'),
		).rejects.toMatchObject({ code: 'forbidden' })
		await expect(
			storage(async () => {
				throw new Error('offline')
			}).exists('/a'),
		).rejects.toMatchObject({ code: 'network' })
	})

	it('reads empty objects and encodes keys exactly once', async () => {
		const transport = vi
			.fn<S3Transport>()
			.mockResolvedValue(
				response('', 200, { etag: '"empty"', 'content-length': '0' }),
			)
		const result = await storage(transport).getFileContents('/中文 #+%.md')
		expect(result.data.byteLength).toBe(0)
		expect(
			decodeURIComponent(new URL(transport.mock.calls[0][0].url).pathname),
		).toBe('/notes/vault/中文 #+%.md')
	})

	it('supports virtual-host addressing and session-token signing', async () => {
		const transport = vi.fn<S3Transport>().mockResolvedValue(page())
		await new S3RemoteStorage(
			{ ...settings, forcePathStyle: false, sessionToken: 'temporary-token' },
			transport,
		).scanEntries()
		const request = transport.mock.calls[0][0]
		expect(new URL(request.url).hostname).toBe('notes.storage.example.test')
		expect(request.headers['x-amz-security-token']).toBe('temporary-token')
	})

	it('validates range metadata and the expected version', async () => {
		const transport = vi
			.fn<S3Transport>()
			.mockResolvedValue(
				response('bc', 206, { 'content-range': 'bytes 1-2/4', etag: '"v1"' }),
			)
		const result = await storage(transport).getFileContents('/a.md', {
			range: { start: 1, end: 2 },
			expectedVersion: { etag: '"v1"' },
		})
		expect(result.range).toEqual({ start: 1, end: 2, total: 4 })
		expect(transport.mock.calls[0][0].headers['if-match']).toBe('"v1"')
	})

	it.each([
		response('bc', 200, { 'content-range': 'bytes 1-2/4' }),
		response('bc', 206, { 'content-range': 'bytes 0-1/4' }),
		response('b', 206, { 'content-range': 'bytes 1-2/4' }),
		response('bc', 206),
	])('rejects invalid range replies', async (reply) => {
		await expect(
			storage(async () => reply).getFileContents('/a', {
				range: { start: 1, end: 2 },
			}),
		).rejects.toMatchObject({ code: 'invalid-response' })
	})

	it('does not accept a server that ignores a read precondition', async () => {
		await expect(
			storage(async () => response('a', 200, { etag: '"v2"' })).getFileContents(
				'/a',
				{ expectedVersion: { etag: '"v1"' } },
			),
		).rejects.toMatchObject({ code: 'precondition-failed' })
	})

	it('rejects unverified writes and recursive deletion before sending a request', async () => {
		const transport = vi.fn<S3Transport>()
		const backend = storage(transport)
		for (const operation of [
			() => backend.putFileContents('/a', '', { mode: 'create' }),
			() => backend.putFileContents('/a', '', { mode: 'overwrite' }),
			() => backend.deleteFile('/a'),
			() => backend.deleteDirectoryRecursively('/a'),
		]) {
			await expect(operation()).rejects.toMatchObject({ code: 'unsupported' })
		}
		expect(transport).not.toHaveBeenCalled()
		await backend.createDirectory('/virtual-directory')
		expect(transport).not.toHaveBeenCalled()
	})

	it.each([
		'https://user:pass@example.test',
		'https://example.test/path',
		'https://example.test?key=value',
		'ftp://example.test',
	])('rejects ambiguous endpoint %s', (endpoint) => {
		expect(() => normalizeS3Settings({ ...settings, endpoint })).toThrow()
	})
})
