import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { requestUrl } from 'obsidian'
import logger from '~/utils/logger'
import { S3RemoteStorage } from './s3-storage'
import { DEFAULT_S3_SETTINGS } from './settings'
import { obsidianS3Transport } from './transport'
import {
	describeS3Headers,
	describeS3Request,
	describeS3VerboseResponse,
} from './diagnostics'

vi.mock('obsidian', () => ({ requestUrl: vi.fn() }))
vi.mock('~/utils/logger', () => ({
	default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))
beforeEach(() => {
	vi.clearAllMocks()
	vi.stubGlobal('window', globalThis)
})
afterEach(() => vi.unstubAllGlobals())
const settings = {
	...DEFAULT_S3_SETTINGS,
	endpoint: 'https://storage.example.test',
	bucket: 'test-bucket',
	prefix: 'vault/',
	accessKeyId: 'AKID-private-example',
	secretAccessKey: 'private/secret+value=',
	sessionToken: 'private-session-token',
}
const reply = () => ({
	status: 200,
	headers: {
		etag: '"version"',
		'content-length': '31',
		'last-modified': 'Mon, 28 Sep 2026 00:00:00 GMT',
		'x-cos-request-id': 'cos-request-id',
		'cache-control': 'max-age=60',
		'content-encoding': 'identity',
		'set-cookie': 'private-cookie',
		'x-amz-meta-private': 'private-metadata',
	},
	arrayBuffer: new ArrayBuffer(0),
	text: '',
	json: {},
})
const entries = () => [
	...vi.mocked(logger.debug).mock.calls,
	...vi.mocked(logger.warn).mock.calls,
]
const logs = () => JSON.stringify(entries())

it('enables verbose logging per request and never changes the signed request or HEAD result', async () => {
	let enabled = false
	const storage = new S3RemoteStorage(settings, obsidianS3Transport, {
		verbose: () => enabled,
	})
	vi.mocked(requestUrl).mockResolvedValue(reply())
	await storage.stat('/中文 #+%.md')
	expect(entries()).toHaveLength(0)
	enabled = true
	await expect(storage.stat('/中文 #+%.md')).resolves.toMatchObject({
		size: 31,
		version: { etag: '"version"' },
	})
	const request = entries().find(
		([title]) => title === '[S3] verbose request',
	)?.[1]
	expect(request).toMatchObject({
		api: 'HeadObject',
		method: 'HEAD',
		addressing: 'virtual-host',
		bodyPresent: false,
		bodyBytes: 0,
		objectPath: '/vault/中文 #+%.md',
		headers: {
			authorization: '[redacted]',
			'x-amz-security-token': '[redacted]',
		},
		signing: {
			algorithm: 'AWS4-HMAC-SHA256',
			credentialScope: expect.stringContaining('/us-east-1/s3/aws4_request'),
		},
	})
	expect(logs()).toContain('response-arraybuffer')
	expect(logs()).toContain('cos-request-id')
	expect(logs()).toContain('max-age=60')
	const actual = vi.mocked(requestUrl).mock.calls[1][0]
	expect(actual).toMatchObject({ method: 'HEAD', throw: false })
	expect(actual).not.toHaveProperty('body')
	const signature = (
		actual as { headers: Record<string, string> }
	).headers.authorization.match(/Signature=(\w+)/)![1]
	for (const secret of [
		settings.accessKeyId,
		settings.secretAccessKey,
		settings.sessionToken,
		signature,
		'private-cookie',
		'private-metadata',
	])
		expect(logs()).not.toContain(secret)
	vi.clearAllMocks()
	enabled = false
	await storage.stat('/中文 #+%.md')
	expect(entries()).toHaveLength(0)
})

it('distinguishes a rejected requestUrl promise from response body access failure', async () => {
	const storage = new S3RemoteStorage(settings, obsidianS3Transport, {
		verbose: () => true,
	})
	vi.mocked(requestUrl).mockRejectedValueOnce(
		new Error('Request Failed. IOException Stream closed'),
	)
	await expect(storage.stat('/note.md')).rejects.toMatchObject({
		code: 'network',
		status: undefined,
	})
	expect(entries()).toEqual(
		expect.arrayContaining([
			[
				expect.any(String),
				expect.objectContaining({
					stage: 'request-url',
					state: 'failed',
					responseReceived: false,
				}),
			],
		]),
	)
	vi.clearAllMocks()
	const broken = reply()
	broken.status = 404
	Object.defineProperty(broken, 'arrayBuffer', {
		get() {
			throw new Error('Stream closed ' + settings.secretAccessKey)
		},
	})
	vi.mocked(requestUrl).mockResolvedValueOnce(broken)
	await expect(storage.exists('/note.md')).rejects.toMatchObject({
		code: 'network',
		status: undefined,
	})
	expect(entries()).toEqual(
		expect.arrayContaining([
			[
				expect.any(String),
				expect.objectContaining({
					stage: 'response-arraybuffer',
					state: 'failed',
					responseReceived: true,
					httpStatus: 404,
				}),
			],
		]),
	)
	expect(logs()).toContain('native response processing failed')
	expect(logs()).toContain('stack')
	expect(logs()).not.toContain(settings.secretAccessKey)
	expect(requestUrl).toHaveBeenCalledTimes(1)
})

it('logs ListObjectsV2 query parameters and successful responses without file contents', async () => {
	const storage = new S3RemoteStorage(settings, obsidianS3Transport, {
		verbose: () => true,
	})
	vi.mocked(requestUrl).mockResolvedValueOnce({
		...reply(),
		arrayBuffer: new TextEncoder().encode(
			'<ListBucketResult><EncodingType>url</EncodingType><IsTruncated>false</IsTruncated></ListBucketResult>',
		).buffer,
	})
	await storage.scanEntries()
	expect(
		entries().find(([title]) => title === '[S3] verbose request')?.[1],
	).toMatchObject({
		api: 'ListObjectsV2',
		query: expect.arrayContaining([
			{ name: 'prefix', value: 'vault/' },
			{ name: 'max-keys', value: '1000' },
		]),
	})
	expect(logs()).not.toContain('ListBucketResult')
	const content = 'private note contents'
	vi.mocked(requestUrl).mockResolvedValueOnce({
		...reply(),
		headers: { etag: '"v1"' },
		arrayBuffer: new TextEncoder().encode(content).buffer,
	})
	await storage.getFileContents('/note.md')
	expect(logs()).toContain('GetObject')
	expect(logs()).not.toContain(content)
})

it('redacts signed query parameters, credentials and unknown headers while preserving protocol evidence', () => {
	const secrets = [
		settings.accessKeyId,
		settings.secretAccessKey,
		settings.sessionToken,
	]
	const described = describeS3Request(
		{
			method: 'GET',
			url: 'https://example.test/vault/note?prefix=notes%2F&X-Amz-Signature=private-signature&X-Amz-Credential=foreign-access-key&unknown=private-token',
			headers: { Authorization: 'Bearer private-bearer', Range: 'bytes=0-0' },
		},
		secrets,
	)
	expect(described.query).toContainEqual({ name: 'prefix', value: 'notes/' })
	expect(described.headers.range).toBe('bytes=0-0')
	const headers = describeS3Headers(
		{
			'X-Secret': 'secret-header',
			'Set-Cookie': 'session=abc',
			ETag: '"v1"',
			'x-amz-meta-content': 'private text',
		},
		secrets,
	)
	expect(headers).toEqual({
		'x-secret': '[redacted]',
		'set-cookie': '[redacted]',
		etag: '"v1"',
		'x-amz-meta-content': '[redacted]',
	})
	for (const secret of [
		'private-signature',
		'foreign-access-key',
		'private-token',
		'private-bearer',
	])
		expect(JSON.stringify(described)).not.toContain(secret)
})

it('adds bounded service error messages without dumping XML, echoed signatures or credentials', () => {
	const result = describeS3VerboseResponse(
		{
			status: 403,
			headers: { 'x-amz-request-id': 'request123' },
			body: new TextEncoder().encode(
				`<Error><Code>AccessDenied</Code><Message>Denied ${settings.secretAccessKey.replace('/', '&#47;')}</Message><CanonicalRequest>private-request</CanonicalRequest><SignatureProvided>private-signature</SignatureProvided></Error>`,
			).buffer,
		},
		[settings.secretAccessKey],
	)
	expect(result).toMatchObject({
		httpStatus: 403,
		serviceCode: 'AccessDenied',
		serviceMessage: 'Denied [redacted]',
		requestId: 'request123',
		bodyContent: 'omitted',
	})
	for (const secret of [
		settings.secretAccessKey,
		'private-request',
		'private-signature',
	])
		expect(JSON.stringify(result)).not.toContain(secret)
})

it('correlates read retries without retrying native failures', async () => {
	const storage = new S3RemoteStorage(settings, obsidianS3Transport, {
		verbose: () => true,
	})
	vi.mocked(requestUrl)
		.mockResolvedValueOnce({ ...reply(), status: 503 })
		.mockResolvedValueOnce(reply())
	await storage.stat('/note.md')
	const requests = entries()
		.filter(([title]) => title === '[S3] verbose request')
		.map(([, details]) => details as { diagnosticId: string; attempt: number })
	expect(requests.map(({ attempt }) => attempt)).toEqual([1, 2])
	expect(requests[0].diagnosticId).toBe(requests[1].diagnosticId)
	expect(entries()).toContainEqual([
		'[S3] verbose retry scheduled',
		expect.objectContaining({ httpStatus: 503, delayMs: 200, nextAttempt: 2 }),
	])
	vi.clearAllMocks()
	vi.mocked(requestUrl).mockRejectedValueOnce(new Error('Stream closed'))
	await expect(storage.stat('/note.md')).rejects.toMatchObject({
		code: 'network',
	})
	expect(requestUrl).toHaveBeenCalledTimes(1)
	expect(logs()).not.toContain('retry scheduled')
})

it('ignores a failing diagnostic observer and preserves the native result', async () => {
	vi.mocked(requestUrl).mockResolvedValue(reply())
	await expect(
		obsidianS3Transport(
			{ url: 'https://example.test/note', method: 'HEAD', headers: {} },
			() => {
				throw new Error('logger failed')
			},
		),
	).resolves.toMatchObject({ status: 200 })
})
