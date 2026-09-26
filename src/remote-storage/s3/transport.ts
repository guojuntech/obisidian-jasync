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

export type S3Transport = (request: S3HttpRequest) => Promise<S3HttpResponse>

/** Obsidian's native HTTP transport avoids browser CORS configuration. */
export const obsidianS3Transport: S3Transport = async (request) => {
	let timer: number | undefined
	try {
		const response = await Promise.race([
			requestUrl({ ...request, throw: false }),
			new Promise<never>((_resolve, reject) => {
				timer = window.setTimeout(
					() => reject(new Error('S3 request timed out')),
					request.method === 'PUT' ? 120_000 : 30_000,
				)
			}),
		])
		return {
			status: response.status,
			headers: response.headers,
			body: response.arrayBuffer,
		}
	} finally {
		if (timer !== undefined) window.clearTimeout(timer)
	}
}
