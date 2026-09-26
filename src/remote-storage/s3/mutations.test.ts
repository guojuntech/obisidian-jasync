import { expect, it } from 'vitest'
import { S3Fixture, bytes, text } from '../../../test/s3-fixture'
import { S3RemoteStorage } from './s3-storage'
import { DEFAULT_S3_SETTINGS } from './settings'

const backend = (cloud: S3Fixture, endpoint = 'https://storage.example.test') =>
	new S3RemoteStorage(
		{
			...DEFAULT_S3_SETTINGS,
			endpoint,
			bucket: 'test-bucket',
			prefix: 'vault/',
			accessKeyId: 'test',
			secretAccessKey: 'test',
		},
		cloud.transport,
	)

it('probes conditions on isolated objects and preserves unrelated objects', async () => {
	const cloud = new S3Fixture()
	cloud.objects.set('vault/user.md', bytes('user data'))
	const storage = backend(cloud)
	await expect(storage.verifyMutationSupport()).resolves.toEqual({
		create: true,
		overwrite: true,
		delete: true,
	})
	await storage.putFileContents('/中文.md', bytes('first'), { mode: 'create' })
	await expect(
		storage.putFileContents('/中文.md', bytes('second'), { mode: 'create' }),
	).rejects.toMatchObject({ code: 'precondition-failed' })
	await expect(
		storage.putFileContents('/中文.md', bytes('second'), {
			mode: 'overwrite',
			expectedVersion: { etag: '"stale"' },
		}),
	).rejects.toMatchObject({ code: 'precondition-failed' })
	await expect(
		storage.deleteFile('/中文.md', { expectedVersion: { etag: '"stale"' } }),
	).rejects.toMatchObject({ code: 'precondition-failed' })
	const receipt = await storage.putFileContents('/中文.md', bytes('second'), {
		mode: 'overwrite',
		expectedVersion: { etag: cloud.etag(bytes('first')) },
	})
	expect(receipt.version?.etag).toBe(cloud.etag(bytes('second')))
	await storage.deleteFile('/中文.md', { expectedVersion: receipt.version })
	expect([...cloud.objects.keys()]).toEqual(['vault/user.md'])
	expect(
		cloud.requests.every((request) =>
			request.headers.authorization?.startsWith('AWS4-HMAC-SHA256'),
		),
	).toBe(true)
})

it('detects silently ignored conditions and requires explicit consent for compatibility writes', async () => {
	const cloud = new S3Fixture()
	cloud.conditional = false
	const storage = backend(cloud)
	await expect(storage.verifyMutationSupport()).resolves.toEqual({
		create: false,
		overwrite: false,
		delete: false,
	})
	await expect(
		storage.putFileContents('/note.md', bytes('data'), { mode: 'create' }),
	).rejects.toMatchObject({ code: 'unsupported' })
	await storage.putFileContents('/note.md', bytes('data'), {
		mode: 'create',
		allowUnconditional: true,
	})
	expect(text(cloud.objects.get('vault/note.md')!)).toBe('data')
	await expect(
		storage.deleteFile('/note.md', { allowUnconditional: true }),
	).rejects.toMatchObject({ code: 'precondition-failed' })
})

it('never retries an upload whose response was lost', async () => {
	const cloud = new S3Fixture()
	const storage = backend(cloud)
	await storage.verifyMutationSupport()
	cloud.fail = (request, key) => {
		if (request.method === 'PUT' && key === 'vault/note.md') {
			cloud.objects.set(key, request.body!)
			throw new Error('response lost')
		}
		return undefined
	}
	await expect(
		storage.putFileContents('/note.md', bytes('data'), { mode: 'create' }),
	).rejects.toMatchObject({ code: 'network' })
	expect(
		cloud.requests.filter(
			(request) =>
				request.method === 'PUT' &&
				new URL(request.url).pathname.endsWith('/note.md'),
		),
	).toHaveLength(1)
	expect(text(cloud.objects.get('vault/note.md')!)).toBe('data')
})

it('does not probe or mutate user objects when capability checks encounter permission errors', async () => {
	const cloud = new S3Fixture()
	cloud.objects.set('vault/note.md', bytes('original'))
	cloud.fail = (request) =>
		request.method === 'PUT' ? cloud.response(undefined, 403) : undefined
	await expect(backend(cloud).verifyMutationSupport()).rejects.toMatchObject({
		code: 'forbidden',
	})
	expect(text(cloud.objects.get('vault/note.md')!)).toBe('original')
	expect(
		cloud.requests.every((request) =>
			request.url.includes('.omni-sync-internal/probes/'),
		),
	).toBe(true)
})

it('treats a duplicate-create 304 as unsupported, not an upload success or a fatal probe error', async () => {
	const cloud = new S3Fixture()
	cloud.fail = (request, key) =>
		request.method === 'PUT' &&
		request.headers['if-none-match'] &&
		cloud.objects.has(key)
			? cloud.response(undefined, 304)
			: undefined
	const storage = backend(cloud)
	await expect(storage.verifyMutationSupport()).resolves.toEqual({
		create: false,
		overwrite: true,
		delete: true,
	})
	expect(cloud.objects.size).toBe(0)
	await expect(
		storage.putFileContents('/new.md', bytes('new'), { mode: 'create' }),
	).rejects.toMatchObject({ code: 'unsupported' })
	await storage.putFileContents('/new.md', bytes('new'), {
		mode: 'create',
		allowUnconditional: true,
	})
	expect(cloud.requests.at(-1)?.headers['if-none-match']).toBeUndefined()
	// Consent for create must not remove verified overwrite/delete conditions.
	const receipt = await storage.putFileContents('/new.md', bytes('next'), {
		mode: 'overwrite',
		expectedVersion: { etag: cloud.etag(bytes('new')) },
		allowUnconditional: true,
	})
	expect(cloud.requests.at(-1)?.headers['if-match']).toBe(
		cloud.etag(bytes('new')),
	)
	await storage.deleteFile('/new.md', {
		expectedVersion: receipt.version,
		allowUnconditional: true,
	})
	expect(cloud.requests.at(-1)?.headers['if-match']).toBe(receipt.version?.etag)
})

it('handles 304 even on initial create and omits unsupported mutation headers only after explicit consent', async () => {
	const cloud = new S3Fixture()
	cloud.fail = (request) =>
		['PUT', 'DELETE'].includes(request.method) &&
		(request.headers['if-match'] || request.headers['if-none-match'])
			? cloud.response(undefined, 304)
			: undefined
	const storage = backend(cloud)
	await expect(storage.verifyMutationSupport()).resolves.toEqual({
		create: false,
		overwrite: false,
		delete: false,
	})
	expect(cloud.objects.size).toBe(0)
	await expect(
		storage.putFileContents('/note.md', bytes('first'), { mode: 'create' }),
	).rejects.toMatchObject({ code: 'unsupported' })
	await storage.putFileContents('/note.md', bytes('first'), {
		mode: 'create',
		allowUnconditional: true,
	})
	const receipt = await storage.putFileContents('/note.md', bytes('second'), {
		mode: 'overwrite',
		expectedVersion: { etag: cloud.etag(bytes('first')) },
		allowUnconditional: true,
	})
	expect(text(cloud.objects.get('vault/note.md')!)).toBe('second')
	await storage.deleteFile('/note.md', {
		expectedVersion: receipt.version,
		allowUnconditional: true,
	})
	const userMutations = cloud.requests.filter((request) =>
		new URL(request.url).pathname.endsWith('/note.md'),
	)
	expect(userMutations).toHaveLength(3)
	for (const request of userMutations) {
		expect(request.headers['if-match']).toBeUndefined()
		expect(request.headers['if-none-match']).toBeUndefined()
	}
	expect(cloud.objects.size).toBe(0)
})

it('uses the COS native create-only header without If-None-Match', async () => {
	const cloud = new S3Fixture()
	cloud.conditional = false
	cloud.cosForbidOverwrite = true
	cloud.fail = (request) =>
		request.method === 'PUT' && request.headers['if-none-match']
			? cloud.response(undefined, 304)
			: undefined
	const storage = backend(cloud, 'https://cos.ap-shanghai.myqcloud.com')
	await expect(storage.verifyMutationSupport()).resolves.toEqual({
		create: true,
		overwrite: false,
		delete: false,
	})
	await storage.putFileContents('/note.md', bytes('first'), { mode: 'create' })
	expect(cloud.requests.at(-1)?.headers['x-cos-forbid-overwrite']).toBe('true')
	expect(cloud.requests.at(-1)?.headers['if-none-match']).toBeUndefined()
	await expect(
		storage.putFileContents('/note.md', bytes('second'), { mode: 'create' }),
	).rejects.toMatchObject({ status: 409 })
	expect(text(cloud.objects.get('vault/note.md')!)).toBe('first')
})

it('still requires consent if COS ignores its native no-overwrite header', async () => {
	const cloud = new S3Fixture()
	cloud.conditional = false
	cloud.cosForbidOverwrite = false
	const storage = backend(cloud, 'https://cos.ap-shanghai.myqcloud.com')
	await expect(storage.verifyMutationSupport()).resolves.toEqual({
		create: false,
		overwrite: false,
		delete: false,
	})
	await expect(
		storage.putFileContents('/note.md', bytes('first'), { mode: 'create' }),
	).rejects.toMatchObject({ code: 'unsupported' })
	await storage.putFileContents('/note.md', bytes('first'), {
		mode: 'create',
		allowUnconditional: true,
	})
	expect(
		cloud.requests.at(-1)?.headers['x-cos-forbid-overwrite'],
	).toBeUndefined()
})

it.each(['overwrite', 'delete'] as const)(
	'does not claim %s support when all If-Match conditions are rejected',
	async (kind) => {
		const cloud = new S3Fixture()
		cloud.fail = (request) =>
			request.method === (kind === 'overwrite' ? 'PUT' : 'DELETE') &&
			request.headers['if-match']
				? cloud.response(undefined, 412)
				: undefined
		const support = await backend(cloud).verifyMutationSupport()
		expect(support[kind]).toBe(false)
		expect(support.create).toBe(true)
	},
)

it('checks probe content instead of trusting a rejection status after a write', async () => {
	const cloud = new S3Fixture()
	cloud.fail = (request, key) => {
		if (
			request.method === 'PUT' &&
			request.headers['if-none-match'] &&
			cloud.objects.has(key)
		) {
			cloud.objects.set(key, request.body!)
			return cloud.response(undefined, 412)
		}
		return undefined
	}
	expect((await backend(cloud).verifyMutationSupport()).create).toBe(false)
})

it('never counts or retries a user-file 304 as a completed write', async () => {
	const cloud = new S3Fixture()
	const storage = backend(cloud)
	await storage.verifyMutationSupport()
	cloud.fail = (_request, key) =>
		key === 'vault/note.md' ? cloud.response(undefined, 304) : undefined
	await expect(
		storage.putFileContents('/note.md', bytes('first'), {
			mode: 'create',
			allowUnconditional: true,
		}),
	).rejects.toMatchObject({ status: 304 })
	expect(cloud.objects.has('vault/note.md')).toBe(false)
	const attempts = cloud.requests.filter((request) =>
		new URL(request.url).pathname.endsWith('/note.md'),
	)
	expect(attempts).toHaveLength(1)
	expect(attempts[0].headers['if-none-match']).toBe('*')
})
