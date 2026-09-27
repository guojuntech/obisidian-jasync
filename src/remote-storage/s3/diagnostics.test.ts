import { beforeEach, describe, expect, it, vi } from 'vitest'
import { S3Fixture } from '../../../test/s3-fixture'
import logger from '~/utils/logger'
import logsStringify from '~/utils/logs-stringify'
import {
	describeS3Exception,
	describeS3Response,
	redactS3Diagnostic,
} from './diagnostics'
import { S3RemoteStorage } from './s3-storage'
import { DEFAULT_S3_SETTINGS } from './settings'

vi.mock('~/utils/logger', () => ({
	default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))
beforeEach(() => vi.clearAllMocks())

const credentials = {
	accessKeyId: 'AKID-private-example',
	secretAccessKey: 'private/secret+value=',
	sessionToken: 'private-session-token',
}
const secrets = Object.values(credentials)
const backend = (cloud: S3Fixture) =>
	new S3RemoteStorage(
		{
			...DEFAULT_S3_SETTINGS,
			...credentials,
			endpoint: 'https://storage.example.test',
			bucket: 'test-bucket',
			prefix: 'vault/',
		},
		cloud.transport,
	)
const exportedLogs = () =>
	[logger.debug, logger.info, logger.warn]
		.flatMap((log) =>
			vi
				.mocked(log)
				.mock.calls.map((args) =>
					logsStringify({ timestamp: 'now', level: 'debug', args }),
				),
		)
		.join('\n')

describe('safe S3 diagnostics', () => {
	it('redacts configured credentials, encoded secrets, signed URLs and authorization lines', () => {
		const raw = `Connection failed ${credentials.accessKeyId} ${encodeURIComponent(credentials.secretAccessKey)} ${credentials.sessionToken}\nhttps://example.test/private.md?X-Amz-Signature=hidden-query\nAuthorization: AWS4-HMAC-SHA256 Credential=other-id Signature=hidden-signature\nECONNRESET`
		const safe = redactS3Diagnostic(raw, secrets)
		expect(safe).toContain('ECONNRESET')
		for (const secret of [
			...secrets,
			encodeURIComponent(credentials.secretAccessKey),
			'private.md',
			'hidden-query',
			'other-id',
			'hidden-signature',
		])
			expect(safe).not.toContain(secret)
		expect(redactS3Diagnostic('x'.repeat(2000), secrets)).toHaveLength(512)
	})

	it('retains nested native error fields without serializing arbitrary objects, stacks or cycles', () => {
		const error = Object.assign(
			new Error(`Failed ${credentials.secretAccessKey}`),
			{
				status: 404,
				code: 'NATIVE_HTTP_ERROR',
				request: { body: 'do-not-log' },
			},
		)
		const cause = Object.assign(new Error('Socket closed'), {
			code: 'ECONNRESET',
			cause: error,
		})
		Object.assign(error, { cause })
		const result = describeS3Exception(error, secrets)
		expect(result).toHaveLength(2)
		expect(result[0]).toMatchObject({
			name: 'Error',
			reportedStatus: 404,
			code: 'NATIVE_HTTP_ERROR',
		})
		expect(result[1]).toMatchObject({
			message: 'Socket closed',
			code: 'ECONNRESET',
		})
		expect(JSON.stringify(result)).not.toContain(credentials.secretAccessKey)
		expect(JSON.stringify(result)).not.toContain('do-not-log')
		expect(
			describeS3Exception(
				{
					get message() {
						throw new Error('getter')
					},
				},
				secrets,
			),
		).toEqual([{}])
		expect(describeS3Exception('native string error', secrets)[0].message).toBe(
			'native string error',
		)
	})

	it('extracts only bounded service codes and request IDs from headers or XML', () => {
		const response = {
			status: 403,
			headers: {
				'X-Cos-Request-Id': 'cos-request-123',
				authorization: 'do-not-log',
			},
			body: new TextEncoder().encode(
				`<Error><Code>AccessDenied</Code><Message>${credentials.secretAccessKey}</Message><RequestId>xml-id</RequestId><Resource>private.md</Resource></Error>`,
			).buffer,
		}
		expect(describeS3Response(response, secrets)).toEqual({
			httpStatus: 403,
			serviceCode: 'AccessDenied',
			requestId: 'cos-request-123',
		})
		expect(
			describeS3Response({ ...response, headers: {} }, secrets).requestId,
		).toBe('xml-id')
		expect(
			describeS3Response(
				{
					...response,
					headers: {},
					body: new TextEncoder().encode(
						'<Error><Code>' + 'a'.repeat(500) + '</Code></Error>',
					).buffer,
				},
				secrets,
			).serviceCode,
		).toBeUndefined()
	})
})

describe('S3 request and capability diagnostics', () => {
	it('identifies a native GET failure after a successful conditional delete, without treating thrown 404 as success', async () => {
		const cloud = new S3Fixture()
		const original = Object.assign(
			new Error(`GET failed ${credentials.secretAccessKey}`),
			{ status: 404, code: 'NATIVE_HTTP_ERROR' },
		)
		cloud.fail = (request, key) => {
			if (
				request.method === 'GET' &&
				key.endsWith('/delete') &&
				!cloud.objects.has(key)
			)
				throw original
			return undefined
		}
		const storage = backend(cloud)
		const error = await storage.verifyMutationSupport().catch((error) => error)
		expect(error).toMatchObject({ code: 'network', status: undefined })
		expect(error.message).toContain(
			'S3 delete capability check failed: S3 GET network request failed [delete/verify-deleted]',
		)
		expect(error.message).toContain('reportedStatus=404')
		expect(storage.capabilities.conditionalDelete).toBe('unknown')
		expect(cloud.objects.size).toBe(0)
		const log = vi
			.mocked(logger.warn)
			.mock.calls.find(([title]) =>
				String(title).includes('native request failed'),
			)!
		expect(log[1]).toMatchObject({
			method: 'GET',
			capability: 'delete',
			step: 'verify-deleted',
			attempt: 1,
			elapsedMs: expect.any(Number),
			diagnosticId: expect.any(String),
			nativeError: [{ reportedStatus: 404, code: 'NATIVE_HTTP_ERROR' }],
		})
		const exported = exportedLogs()
		expect(exported).toContain('verify-deleted')
		expect(exported).toContain('NATIVE_HTTP_ERROR')
		for (const secret of secrets)
			expect(exported + error.stack + JSON.stringify(error)).not.toContain(
				secret,
			)
		expect(cloud.requests.filter((r) => r.method === 'HEAD')).toHaveLength(0)
	})

	it('reports HTTP 403, COS Code and RequestId and never falls back for permission errors', async () => {
		const cloud = new S3Fixture()
		cloud.fail = (request) =>
			request.method === 'DELETE' &&
			new Headers(request.headers).has('if-match')
				? cloud.response(
						new TextEncoder().encode(
							`<Error><Code>AccessDenied</Code><Message>${credentials.secretAccessKey}</Message></Error>`,
						).buffer,
						403,
						{ 'x-cos-request-id': 'cos-permission-id' },
					)
				: undefined
		const error = await backend(cloud)
			.verifyMutationSupport()
			.catch((error) => error)
		expect(error).toMatchObject({ code: 'forbidden', status: 403 })
		expect(error.message).toContain('[delete/reject-mismatch]')
		expect(error.message).toContain('AccessDenied')
		expect(error.message).toContain('RequestId=cos-permission-id')
		expect(exportedLogs()).toContain('"httpStatus":403')
		expect(exportedLogs()).not.toContain(credentials.secretAccessKey)
	})

	it('records the successful delete sequence including expected 412 and 404 responses', async () => {
		await expect(
			backend(new S3Fixture()).verifyMutationSupport(),
		).resolves.toEqual({ create: true, overwrite: true, delete: true })
		const responses = vi
			.mocked(logger.debug)
			.mock.calls.filter(
				([title, data]) =>
					title === '[S3] probe response' &&
					(data as { capability?: string }).capability === 'delete',
			)
			.map(([, data]) => data)
		expect(responses).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					method: 'DELETE',
					step: 'reject-mismatch',
					httpStatus: 412,
				}),
				expect.objectContaining({
					method: 'DELETE',
					step: 'accept-match',
					httpStatus: 204,
				}),
				expect.objectContaining({
					method: 'GET',
					step: 'verify-deleted',
					httpStatus: 404,
				}),
				expect.objectContaining({
					method: 'DELETE',
					step: 'cleanup',
					httpStatus: 204,
				}),
			]),
		)
		expect(logger.warn).not.toHaveBeenCalled()
	})

	it('logs cleanup failure separately and keeps the primary probe failure', async () => {
		const cloud = new S3Fixture()
		cloud.fail = (request) => {
			if (request.method === 'PUT') return cloud.response(undefined, 403)
			if (request.method === 'DELETE') throw new Error('cleanup offline')
		}
		await expect(backend(cloud).verifyMutationSupport()).rejects.toMatchObject({
			code: 'forbidden',
			status: 403,
		})
		expect(exportedLogs()).toContain('cleanup offline')
		expect(exportedLogs()).toContain('a reserved test object may remain')
	})

	it('correlates read retries while preserving a single attempt for a failed write', async () => {
		vi.stubGlobal('window', {
			setTimeout: (callback: () => void) => {
				callback()
				return 0
			},
		})
		try {
			const cloud = new S3Fixture()
			const storage = backend(cloud)
			cloud.fail = () =>
				cloud.response(undefined, 503, { 'x-amz-request-id': 'aws-retry-id' })
			await expect(storage.getFileContents('/note.md')).rejects.toMatchObject({
				status: 503,
			})
			const logs = vi
				.mocked(logger.warn)
				.mock.calls.map(
					([, data]) => data as { diagnosticId: string; attempt: number },
				)
			expect(logs.map((log) => log.attempt)).toEqual([1, 2, 3])
			expect(new Set(logs.map((log) => log.diagnosticId)).size).toBe(1)
			vi.clearAllMocks()
			await expect(
				storage.putFileContents('/note.md', 'test', {
					mode: 'create',
					allowUnconditional: true,
				}),
			).rejects.toMatchObject({ status: 503 })
			expect(logger.warn).toHaveBeenCalledTimes(1)
		} finally {
			vi.unstubAllGlobals()
		}
	})
})
