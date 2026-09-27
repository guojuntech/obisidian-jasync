import { build } from 'esbuild'
import { createContext, runInContext } from 'node:vm'
import { beforeAll, describe, expect, it } from 'vitest'
import type { S3RemoteStorage } from '../src/remote-storage/s3/s3-storage'

let source: string

beforeAll(async () => {
	const bundle = await build({
		entryPoints: ['src/remote-storage/s3/s3-storage.ts'],
		bundle: true,
		write: false,
		platform: 'browser',
		format: 'cjs',
	})
	source = bundle.outputFiles[0].text
})

function browserStorage(bodies: string[], transportError?: unknown) {
	const module = {
		exports: {} as { S3RemoteStorage: typeof S3RemoteStorage },
	}
	// Only web APIs are exposed. Node's test runner must not supply Buffer,
	// process or require to a dependency that fails on Obsidian mobile.
	const browser = createContext({
		module,
		exports: module.exports,
		TextEncoder,
		TextDecoder,
		URL,
		URLSearchParams,
		Request,
		Headers,
		crypto: globalThis.crypto,
		atob,
		btoa,
		setTimeout,
		clearTimeout,
	})
	runInContext('window = globalThis; self = globalThis', browser)
	expect(runInContext('typeof Buffer', browser)).toBe('undefined')
	expect(runInContext('typeof process', browser)).toBe('undefined')
	runInContext(source, browser, { timeout: 5000 })
	return new module.exports.S3RemoteStorage(
		{
			endpoint: 'https://storage.example.test',
			region: 'us-east-1',
			bucket: 'notes',
			prefix: 'vault/',
			accessKeyId: 'test-key',
			secretAccessKey: 'test-secret',
			sessionToken: '',
			forcePathStyle: false,
		},
		async () => {
			if (transportError !== undefined) throw transportError
			return {
				status: 200,
				headers: {},
				body: new TextEncoder().encode(bodies.shift() ?? '').buffer,
			}
		},
	)
}

describe('S3 in a browser without Node globals', () => {
	it('reports a redacted native failure without Node globals', async () => {
		const storage = browserStorage(
			[],
			Object.assign(new Error('Socket failed: test-secret'), {
				code: 'ECONNRESET',
			}),
		)
		await expect(storage.getFileContents('/note.md')).rejects.toMatchObject({
			code: 'network',
			message: expect.stringContaining('ECONNRESET'),
		})
		await expect(storage.getFileContents('/note.md')).rejects.not.toThrow(
			'test-secret',
		)
	})
	it('loads, signs and parses a Unicode listing without Buffer', async () => {
		const storage = browserStorage([
			`<ListBucketResult><EncodingType>url</EncodingType><IsTruncated>false</IsTruncated>
			<Contents><Key>${encodeURIComponent('vault/你好.md')}</Key><Size>1</Size>
			<LastModified>2026-01-01T00:00:00Z</LastModified><ETag>&quot;etag&quot;</ETag></Contents>
			</ListBucketResult>`,
		])
		await expect(storage.scanEntries()).resolves.toMatchObject([
			{ path: '/你好.md', version: { etag: '"etag"' } },
		])
	})

	it('rejects a malformed later page instead of returning a partial snapshot', async () => {
		const storage = browserStorage([
			'<ListBucketResult><EncodingType>url</EncodingType><IsTruncated>true</IsTruncated><NextContinuationToken>next</NextContinuationToken></ListBucketResult>',
			'<ListBucketResult><EncodingType>url</EncodingType><IsTruncated>false</IsTruncated>',
		])
		await expect(storage.scanEntries()).rejects.toMatchObject({
			code: 'invalid-response',
			message: 'Invalid S3 listing XML',
		})
	})
})
