import { afterEach, expect, it, vi } from 'vitest'
import { requestUrl } from 'obsidian'
import { obsidianS3Transport } from './transport'

vi.mock('obsidian', () => ({
	Platform: { isAndroidApp: false },
	requestUrl: vi.fn(),
}))
afterEach(() => {
	vi.useRealTimers()
	vi.unstubAllGlobals()
	vi.resetAllMocks()
})

it('preserves binary upload bytes and conditional headers in native requests', async () => {
	vi.stubGlobal('window', globalThis)
	vi.mocked(requestUrl).mockResolvedValue({
		status: 200,
		headers: { etag: '"receipt"' },
		arrayBuffer: new ArrayBuffer(0),
		text: '',
		json: {},
	})
	const body = new Uint8Array([0, 255, 128, 1]).buffer
	const response = await obsidianS3Transport({
		url: 'https://example.test/note',
		method: 'PUT',
		headers: { 'If-Match': '"version"' },
		body,
	})
	expect(requestUrl).toHaveBeenCalledWith({
		url: 'https://example.test/note',
		method: 'PUT',
		headers: { 'If-Match': '"version"' },
		body,
		throw: false,
	})
	expect(response.headers.etag).toBe('"receipt"')
})

it('uses native HTTP and preserves non-success status without logging credentials', async () => {
	vi.stubGlobal('window', globalThis)
	vi.mocked(requestUrl).mockResolvedValue({
		status: 403,
		headers: {},
		arrayBuffer: new ArrayBuffer(0),
		text: '',
		json: {},
	})
	const result = await obsidianS3Transport({
		url: 'https://example.test/bucket',
		method: 'GET',
		headers: { Authorization: 'test-signature' },
	})
	expect(result.status).toBe(403)
	expect(requestUrl).toHaveBeenCalledWith({
		url: 'https://example.test/bucket',
		method: 'GET',
		headers: { Authorization: 'test-signature' },
		throw: false,
	})
})

it('bounds stalled native requests without claiming to abort the network operation', async () => {
	vi.useFakeTimers()
	vi.stubGlobal('window', globalThis)
	vi.mocked(requestUrl).mockImplementation(
		() => new Promise(() => {}) as ReturnType<typeof requestUrl>,
	)
	const check = expect(
		obsidianS3Transport({
			url: 'https://example.test',
			method: 'HEAD',
			headers: {},
		}),
	).rejects.toMatchObject({
		name: 'S3RequestTimeoutError',
		code: 'S3_REQUEST_TIMEOUT',
		timeoutMs: 30_000,
		message: 'S3 request timed out after 30000 ms',
	})
	await vi.advanceTimersByTimeAsync(30_000)
	await check
	expect(vi.getTimerCount()).toBe(0)
})
