import { describe, expect, it, vi } from 'vitest'
import { createRemoteSession } from './factory'
import { DEFAULT_S3_SETTINGS } from './s3/settings'
import type { S3Transport } from './s3/transport'

vi.mock('obsidian', () => ({ requestUrl: vi.fn() }))
const config = {
	...DEFAULT_S3_SETTINGS,
	bucket: 'test-bucket',
	accessKeyId: 'key',
	secretAccessKey: 'secret',
}
const transport: S3Transport = async () => ({
	status: 200,
	headers: {},
	body: new TextEncoder().encode(
		'<ListBucketResult><EncodingType>url</EncodingType><IsTruncated>false</IsTruncated></ListBucketResult>',
	).buffer,
})

describe('remote session identity', () => {
	it('uses the configured prefix for connection checks, scans and reads', async () => {
		const settings = { ...config, prefix: 'notes/MyNotes/' }
		const request = vi.fn<S3Transport>(transport)
		const session = await createRemoteSession(settings, request)
		await session.storage.stat('/')
		await session.scanner.scan()
		await session.storage.getFileContents('/folder/note.md')
		const urls = request.mock.calls.map(([call]) => new URL(call.url))
		expect(
			urls.slice(0, 2).map((url) => url.searchParams.get('prefix')),
		).toEqual(['notes/MyNotes/', 'notes/MyNotes/'])
		expect(urls[2].hostname).toBe('test-bucket.s3.us-east-1.amazonaws.com')
		expect(urls[2].pathname).toBe('/notes/MyNotes/folder/note.md')

		settings.prefix = 'notes/AnotherVault'
		const updatedSession = await createRemoteSession(settings, request)
		await updatedSession.storage.stat('/')
		expect(
			new URL(request.mock.lastCall![0].url).searchParams.get('prefix'),
		).toBe('notes/AnotherVault/')
		expect(updatedSession.identity).not.toBe(session.identity)
	})

	it('freezes the target and excludes credentials from its identity', async () => {
		const settings = { ...config, prefix: 'vault' }
		const session = await createRemoteSession(settings, transport)
		settings.bucket = 'another-bucket'
		expect(Object.isFrozen(session)).toBe(true)
		expect(session.mode).toBe('read-write')
		expect(session.identity).toMatch(/^[0-9a-f]{64}$/)
		const sameTarget = await createRemoteSession(
			{ ...config, prefix: '/vault/', secretAccessKey: 'rotated' },
			transport,
		)
		expect(session.identity).toBe(sameTarget.identity)
		for (const changed of [
			{ bucket: 'another-bucket' },
			{ prefix: 'another-prefix' },
			{ accessKeyId: 'another-key' },
			{ endpoint: 'https://another.example.test' },
		]) {
			expect(
				(
					await createRemoteSession(
						{ ...config, prefix: 'vault', ...changed },
						transport,
					)
				).identity,
			).not.toBe(session.identity)
		}
	})
})
