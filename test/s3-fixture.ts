import { createHash } from 'node:crypto'
import type {
	S3HttpRequest,
	S3HttpResponse,
	S3Transport,
} from '../src/remote-storage/s3/transport'

export const bytes = (text: string) => new TextEncoder().encode(text).buffer
export const text = (data: ArrayBuffer) => new TextDecoder().decode(data)

/** Stateful protocol fixture: exercises signing, paths, receipts and conditions. */
export class S3Fixture {
	objects = new Map<string, ArrayBuffer>()
	requests: S3HttpRequest[] = []
	conditional = true
	cosForbidOverwrite = false
	fail?: (request: S3HttpRequest, key: string) => S3HttpResponse | undefined
	afterWrite?: (key: string) => void
	etag(data: ArrayBuffer) {
		return `"${createHash('md5').update(new Uint8Array(data)).digest('hex')}"`
	}
	response(
		body: ArrayBuffer = new ArrayBuffer(0),
		status = 200,
		headers: Record<string, string> = {},
	): S3HttpResponse {
		return { body, status, headers }
	}
	transport: S3Transport = async (request) => {
		this.requests.push(request)
		const url = new URL(request.url)
		const key = decodeURIComponent(url.pathname)
			.replace(/^\/test-bucket\//, '')
			.replace(/^\//, '')
		const failure = this.fail?.(request, key)
		if (failure) return failure
		if (url.searchParams.get('list-type') === '2') {
			const prefix = url.searchParams.get('prefix') ?? ''
			const contents = [...this.objects]
				.filter(([path]) => path.startsWith(prefix))
				.map(
					([path, data]) =>
						`<Contents><Key>${encodeURIComponent(path)}</Key><Size>${data.byteLength}</Size><LastModified>2026-09-25T00:00:00Z</LastModified><ETag>${this.etag(data)}</ETag></Contents>`,
				)
				.join('')
			return this.response(
				bytes(
					`<ListBucketResult><EncodingType>url</EncodingType><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`,
				),
			)
		}
		const data = this.objects.get(key)
		const headers = new Headers(request.headers)
		if (
			this.cosForbidOverwrite &&
			request.method === 'PUT' &&
			headers.get('x-cos-forbid-overwrite') === 'true' &&
			data
		)
			return this.response(undefined, 409)
		if (this.conditional) {
			if (headers.get('if-none-match') === '*' && data)
				return this.response(undefined, 412)
			if (
				headers.has('if-match') &&
				(!data || headers.get('if-match') !== this.etag(data))
			)
				return this.response(undefined, 412)
		}
		if (request.method === 'PUT') {
			if (!request.body) throw new Error('Missing upload body')
			this.objects.set(key, request.body.slice(0))
			this.afterWrite?.(key)
			return this.response(undefined, 200, { etag: this.etag(request.body) })
		}
		if (request.method === 'DELETE') {
			this.objects.delete(key)
			return this.response(undefined, 204)
		}
		if (!data) return this.response(undefined, 404)
		const metadata = {
			etag: this.etag(data),
			'content-length': String(data.byteLength),
			'last-modified': 'Fri, 25 Sep 2026 00:00:00 GMT',
		}
		if (request.method === 'HEAD')
			return this.response(undefined, 200, metadata)
		if (headers.has('range')) {
			const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(headers.get('range')!)!
			return this.response(data.slice(Number(start), Number(end) + 1), 206, {
				...metadata,
				'content-length': String(Number(end) - Number(start) + 1),
				'content-range': `bytes ${start}-${end}/${data.byteLength}`,
			})
		}
		return this.response(data.slice(0), 200, metadata)
	}
}
