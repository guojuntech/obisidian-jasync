import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Platform, requestUrl, type RequestUrlParam } from 'obsidian'
import logger from '~/utils/logger'
import type { SyncPolicy } from '~/settings'
import { SafeSyncEngine, PlanChangedError } from '~/sync/safe/engine'
import { S3Fixture, bytes } from '../../../test/s3-fixture'
import { S3RemoteStorage } from './s3-storage'
import { DEFAULT_S3_SETTINGS } from './settings'
import { obsidianS3Transport, type S3HttpRequest } from './transport'

vi.mock('obsidian', () => ({
	Platform: { isAndroidApp: true },
	requestUrl: vi.fn(),
}))
vi.mock('~/utils/logger', () => ({
	default: { debug: vi.fn(), warn: vi.fn() },
}))
const nativeError = () => new Error('Request Failed. IOException Stream closed')
const settings = {
	...DEFAULT_S3_SETTINGS,
	endpoint: 'https://storage.example.test',
	bucket: 'test-bucket',
	prefix: 'vault/',
	accessKeyId: 'test-key',
	secretAccessKey: 'test-secret',
}
const reply = (
	status = 200,
	headers: Record<string, string> = {},
	body = '',
) => ({
	status,
	headers,
	arrayBuffer: bytes(body),
	text: body,
	json: {},
})
const metadata = {
	'content-length': '20',
	'last-modified': 'Mon, 28 Sep 2026 00:00:00 GMT',
	etag: '"current"',
	'x-amz-version-id': 'current-version',
}
const rangeReply = () =>
	reply(
		206,
		{ ...metadata, 'content-length': '1', 'content-range': 'bytes 0-0/20' },
		'a',
	)
const emptyList = () =>
	reply(
		200,
		{},
		'<ListBucketResult><EncodingType>url</EncodingType><IsTruncated>false</IsTruncated></ListBucketResult>',
	)
const storage = (verbose = false) =>
	new S3RemoteStorage(settings, obsidianS3Transport, { verbose: () => verbose })
const mockNative = (
	handle: (request: S3HttpRequest) => Promise<ReturnType<typeof reply>>,
) =>
	vi
		.mocked(requestUrl)
		.mockImplementation(
			(request) =>
				handle(request as S3HttpRequest) as ReturnType<typeof requestUrl>,
		)
const requests = () =>
	vi.mocked(requestUrl).mock.calls.map(([r]) => r as RequestUrlParam)
const methods = () => requests().map((r) => r.method)
beforeEach(() => {
	vi.resetAllMocks()
	Platform.isAndroidApp = true
	vi.stubGlobal('window', globalThis)
})
afterEach(() => {
	vi.useRealTimers()
	vi.unstubAllGlobals()
})

it.each([false, true])(
	'signs a same-key Range GET and uses total size with verbose=%s',
	async (verbose) => {
		vi.mocked(requestUrl)
			.mockRejectedValueOnce(nativeError())
			.mockResolvedValueOnce(rangeReply())
		await expect(storage(verbose).stat('/中文 #+%.md')).resolves.toMatchObject({
			path: '/中文 #+%.md',
			size: 20,
			version: { etag: '"current"', versionId: 'current-version' },
		})
		expect(methods()).toEqual(['HEAD', 'GET'])
		const [head, get] = requests()
		expect(get.url).toBe(head.url)
		expect(get.headers?.range).toBe('bytes=0-0')
		expect(get.headers?.authorization).toContain('range;')
		expect(get.headers?.authorization).not.toBe(head.headers?.authorization)
		const failure = vi
			.mocked(logger.warn)
			.mock.calls.find(
				([title]) => title === '[S3] native request failed (no HTTP response)',
			)?.[1]
		expect(failure).not.toHaveProperty('httpStatus')
		const fallback = vi
			.mocked(logger.debug)
			.mock.calls.find(
				([title]) => title === '[S3] HEAD fallback response',
			)?.[1]
		expect(fallback).toMatchObject({
			method: 'GET',
			httpStatus: 206,
			fallbackStep: 'range-get',
			parentDiagnosticId: (failure as { diagnosticId: string }).diagnosticId,
		})
		expect(fallback).not.toHaveProperty(
			'diagnosticId',
			(failure as { diagnosticId: string }).diagnosticId,
		)
	},
)

it('keeps successful Android HEAD on the original path', async () => {
	vi.mocked(requestUrl).mockResolvedValueOnce(reply(200, metadata))
	await expect(storage().stat('/a')).resolves.toMatchObject({ size: 20 })
	expect(methods()).toEqual(['HEAD'])
})

it.each([false, true])(
	'uses a real fallback 404 to check virtual directories: directory=%s',
	async (directory) => {
		const cloud = new S3Fixture()
		if (directory) cloud.objects.set('vault/a/child.md', bytes('child'))
		mockNative(async (r) => {
			if (r.method === 'HEAD') throw nativeError()
			const result = await cloud.transport(r)
			return {
				...reply(result.status, result.headers),
				arrayBuffer: result.body,
			}
		})
		if (directory)
			await expect(storage().stat('/a')).resolves.toMatchObject({ isDir: true })
		else await expect(storage().exists('/a')).resolves.toBe(false)
		expect(methods()).toEqual(['HEAD', 'GET', 'GET'])
		expect(new URL(requests()[2].url).searchParams.get('prefix')).toBe(
			'vault/a/',
		)
	},
)

it.each([
	[401, 'unauthorized'],
	[403, 'forbidden'],
	[412, 'precondition-failed'],
	[304, 'unknown'],
] as const)(
	'preserves fallback HTTP %s without assuming absence or making writes',
	async (status, code) => {
		vi.mocked(requestUrl)
			.mockRejectedValueOnce(nativeError())
			.mockResolvedValueOnce(
				reply(
					status,
					{ 'x-cos-request-id': 'request-id' },
					'<Error><Code>AccessDenied</Code><Message>Permission denied</Message></Error>',
				),
			)
		await expect(storage(true).exists('/a')).rejects.toMatchObject({
			code,
			status,
		})
		expect(methods()).toEqual(['HEAD', 'GET'])
		expect(JSON.stringify(vi.mocked(logger.debug).mock.calls)).toContain(
			'Permission denied',
		)
	},
)

it('preserves bounded HTTP retries on the fallback read', async () => {
	vi.mocked(requestUrl)
		.mockRejectedValueOnce(nativeError())
		.mockResolvedValue(reply(503))
	const check = expect(storage().stat('/a')).rejects.toMatchObject({
		code: 'rate-limited',
		status: 503,
	})
	await check
	expect(methods()).toEqual(['HEAD', 'GET', 'GET', 'GET'])
})

it('does not trust a status attached to a thrown GET exception', async () => {
	vi.mocked(requestUrl)
		.mockRejectedValueOnce(nativeError())
		.mockRejectedValueOnce(Object.assign(nativeError(), { status: 404 }))
	await expect(storage().exists('/a')).rejects.toMatchObject({
		code: 'network',
		status: undefined,
	})
	expect(methods()).toEqual(['HEAD', 'GET'])
})

it.each([0, 20])(
	'handles GET 416 with one new HEAD, including current size %s',
	async (size) => {
		vi.mocked(requestUrl)
			.mockRejectedValueOnce(nativeError())
			.mockResolvedValueOnce(reply(416))
			.mockResolvedValueOnce(
				reply(200, { ...metadata, 'content-length': String(size) }),
			)
		await expect(storage().stat('/a')).resolves.toMatchObject({
			size,
			version: { etag: '"current"' },
		})
		expect(methods()).toEqual(['HEAD', 'GET', 'HEAD'])
		expect(requests()[2].headers).not.toHaveProperty('range')
	},
)

it('does not recursively retry the HEAD after 416', async () => {
	vi.mocked(requestUrl)
		.mockRejectedValueOnce(nativeError())
		.mockResolvedValueOnce(reply(416))
		.mockRejectedValueOnce(nativeError())
	await expect(storage().stat('/a')).rejects.toMatchObject({ code: 'network' })
	expect(methods()).toEqual(['HEAD', 'GET', 'HEAD'])
})

it('handles disappearance between 416 and the final HEAD', async () => {
	vi.mocked(requestUrl)
		.mockRejectedValueOnce(nativeError())
		.mockResolvedValueOnce(reply(416))
		.mockResolvedValueOnce(reply(404))
		.mockResolvedValueOnce(emptyList())
	await expect(storage().exists('/a')).resolves.toBe(false)
	expect(methods()).toEqual(['HEAD', 'GET', 'HEAD', 'GET'])
})

it.each([403, 204])(
	'rejects final HEAD status %s after 416',
	async (status) => {
		vi.mocked(requestUrl)
			.mockRejectedValueOnce(nativeError())
			.mockResolvedValueOnce(reply(416))
			.mockResolvedValueOnce(reply(status, metadata))
		await expect(storage().stat('/a')).rejects.toMatchObject({
			code: status === 403 ? 'forbidden' : 'invalid-response',
		})
		expect(methods()).toEqual(['HEAD', 'GET', 'HEAD'])
	},
)

it.each(['', 'full body'])(
	'accepts a validated full body when Range is ignored: %j',
	async (body) => {
		vi.mocked(requestUrl)
			.mockRejectedValueOnce(nativeError())
			.mockResolvedValueOnce(
				reply(
					200,
					{ ...metadata, 'content-length': String(body.length) },
					body,
				),
			)
		await expect(storage().stat('/a')).resolves.toMatchObject({
			size: body.length,
		})
	},
)

it.each([
	reply(206, { ...metadata, 'content-length': '1' }, 'a'),
	reply(
		206,
		{ ...metadata, 'content-length': '1', 'content-range': 'bytes 0-0/0' },
		'a',
	),
	reply(
		206,
		{
			...metadata,
			'content-length': '1',
			'content-range': 'bytes 0-0/9007199254740992',
		},
		'a',
	),
	reply(
		206,
		{ ...metadata, 'content-length': '1', 'content-range': 'bytes 1-1/20' },
		'a',
	),
	reply(206, {
		...metadata,
		'content-length': '0',
		'content-range': 'bytes 0-0/20',
	}),
	reply(
		206,
		{ ...metadata, 'content-length': '2', 'content-range': 'bytes 0-0/20' },
		'ab',
	),
	reply(
		206,
		{ ...metadata, 'content-length': '20', 'content-range': 'bytes 0-0/20' },
		'a',
	),
	reply(
		200,
		{ ...metadata, 'content-length': '1', 'content-range': 'bytes 0-0/20' },
		'a',
	),
	reply(200, { ...metadata, 'content-length': '-1' }, 'a'),
	reply(200, { ...metadata, 'content-length': '20' }, 'a'),
	reply(200, { etag: '"v"', 'last-modified': metadata['last-modified'] }, 'a'),
	reply(206, { 'content-range': 'bytes 0-0/20' }, 'a'),
	reply(204, metadata),
])('rejects invalid fallback metadata/body %#', async (response) => {
	vi.mocked(requestUrl)
		.mockRejectedValueOnce(nativeError())
		.mockResolvedValueOnce(response)
	await expect(storage().stat('/a')).rejects.toMatchObject({
		code: 'invalid-response',
	})
	expect(methods()).toEqual(['HEAD', 'GET'])
})

it('does not activate on desktop or iOS', async () => {
	Platform.isAndroidApp = false
	vi.mocked(requestUrl).mockRejectedValueOnce(nativeError())
	await expect(storage().stat('/a')).rejects.toMatchObject({ code: 'network' })
	expect(methods()).toEqual(['HEAD'])
})

it.each([
	'offline',
	'Stream closed',
	'Request Failed. SocketTimeoutException timeout',
])('does not activate on unrelated native exception: %s', async (message) => {
	vi.mocked(requestUrl).mockRejectedValueOnce(new Error(message))
	await expect(storage().stat('/a')).rejects.toMatchObject({ code: 'network' })
	expect(methods()).toEqual(['HEAD'])
})

it.each(['status', 'arrayBuffer'] as const)(
	'does not activate after a response arrived and reading %s failed',
	async (field) => {
		const response = reply(404)
		Object.defineProperty(response, field, {
			get() {
				throw nativeError()
			},
		})
		vi.mocked(requestUrl).mockResolvedValueOnce(response)
		await expect(storage(true).stat('/a')).rejects.toMatchObject({
			code: 'network',
		})
		expect(methods()).toEqual(['HEAD'])
	},
)

it.each([403, 404])(
	'keeps delivered HEAD HTTP %s on its original path',
	async (status) => {
		vi.mocked(requestUrl)
			.mockResolvedValueOnce(reply(status))
			.mockResolvedValueOnce(emptyList())
		if (status === 404)
			await expect(storage().exists('/a')).resolves.toBe(false)
		else await expect(storage().exists('/a')).rejects.toMatchObject({ status })
		expect(requests().some((r) => r.headers?.range)).toBe(false)
	},
)

it.each(['GET', 'PUT', 'DELETE'] as const)(
	'preserves native failures for %s without the HEAD marker',
	async (method) => {
		const error = nativeError()
		vi.mocked(requestUrl).mockRejectedValueOnce(error)
		await expect(
			obsidianS3Transport({
				url: 'https://example.test/a',
				method,
				headers: {},
			}),
		).rejects.toBe(error)
		expect(requestUrl).toHaveBeenCalledTimes(1)
	},
)

it.each(['created', 'changed', 'deleted'] as const)(
	'rejects stale sync plans when the fallback finds an object %s since preview',
	async (change) => {
		const cloud = new S3Fixture()
		const remote = storage()
		mockNative(async (r) => {
			if (r.method === 'HEAD') throw nativeError()
			const result = await cloud.transport(r)
			return {
				...reply(result.status, result.headers),
				arrayBuffer: result.body,
			}
		})
		if (change !== 'created')
			cloud.objects.set('vault/a.md', bytes('old remote'))
		const local = {
			read: vi.fn(async () => bytes('local note')),
			write: vi.fn(),
			remove: vi.fn(),
		}
		const persistence = {
			load: async () => ({ format: 2 as const, identity: 'test', records: {} }),
			save: vi.fn(),
			backup: vi.fn(),
			journal: vi.fn(),
		}
		const engine = new SafeSyncEngine({
			identity: 'test',
			remote,
			local,
			persistence,
			checkCancelled: () => {},
			chunkSize: 1024,
		})
		const plan = await engine.plan({
			local: [{ path: 'a.md', isDir: false, ignored: false, size: 10 }],
			remote: await remote.scanEntries(),
			include: () => true,
			maxBytes: 1024,
			policy: 'send-only-override-changes' as SyncPolicy,
			strategy: 'no-conflict-merge',
		})
		if (change === 'deleted') cloud.objects.delete('vault/a.md')
		else cloud.objects.set('vault/a.md', bytes('new remote'))
		await expect(engine.validate(plan)).rejects.toBeInstanceOf(PlanChangedError)
		expect(methods()).toContain('HEAD')
		expect(requests().some((r) => r.headers?.range === 'bytes=0-0')).toBe(true)
		expect(methods()).not.toContain('PUT')
		expect(methods()).not.toContain('DELETE')
		expect(persistence.save).not.toHaveBeenCalled()
	},
)
