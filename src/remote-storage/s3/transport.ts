import { requestUrl } from 'obsidian'

export interface S3HttpRequest {
	url: string
	method: 'GET' | 'HEAD' | 'PUT' | 'DELETE'
	headers: Record<string, string>
	body?: ArrayBuffer
}

export interface S3HttpResponse {
	status: number
	headers: Record<string, string>
	body: ArrayBuffer
}

export interface S3TransportEvent {
	stage: 'request-url' | 'response-metadata' | 'response-arraybuffer'
	state: 'start' | 'complete' | 'failed'
	elapsedMs: number
	timeoutMs: number
	responseReceived: boolean
	httpStatus?: number
	headers?: Record<string, string>
	bodyBytes?: number
	error?: unknown
}

export type S3Transport = (
	request: S3HttpRequest,
	observe?: (event: S3TransportEvent) => void,
) => Promise<S3HttpResponse>

export class S3RequestTimeoutError extends Error {
	readonly code = 'S3_REQUEST_TIMEOUT'
	constructor(readonly timeoutMs: number) {
		super(`S3 request timed out after ${timeoutMs} ms`)
		this.name = 'S3RequestTimeoutError'
	}
}

/** Obsidian's native HTTP transport avoids browser CORS configuration. */
export const obsidianS3Transport: S3Transport = async (request, observe) => {
	let timer: number | undefined
	const timeoutMs = request.method === 'PUT' ? 120_000 : 30_000
	const started = Date.now()
	let stage: S3TransportEvent['stage'] = 'request-url'
	let responseReceived = false
	let httpStatus: number | undefined
	const emit = (
		state: S3TransportEvent['state'],
		details: Partial<S3TransportEvent> = {},
	) => {
		try {
			observe?.({
				stage,
				state,
				timeoutMs,
				elapsedMs: Date.now() - started,
				responseReceived,
				httpStatus,
				...details,
			})
		} catch {
			// Diagnostics must never change the result of a network operation.
		}
	}
	try {
		emit('start')
		const response = await Promise.race([
			requestUrl({ ...request, throw: false }),
			new Promise<never>((_resolve, reject) => {
				timer = window.setTimeout(
					() => reject(new S3RequestTimeoutError(timeoutMs)),
					timeoutMs,
				)
			}),
		])
		responseReceived = true
		emit('complete')
		stage = 'response-metadata'
		emit('start')
		httpStatus = response.status
		const headers = response.headers
		emit('complete', { headers })
		stage = 'response-arraybuffer'
		emit('start')
		const body = response.arrayBuffer
		emit('complete', { bodyBytes: body.byteLength })
		return { status: httpStatus, headers, body }
	} catch (error) {
		emit('failed', { error })
		throw error
	} finally {
		if (timer !== undefined) window.clearTimeout(timer)
	}
}
