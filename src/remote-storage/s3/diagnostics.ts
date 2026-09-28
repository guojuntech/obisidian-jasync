import { decode } from 'html-entities'
import type { S3HttpRequest, S3HttpResponse } from './transport'

export interface S3DiagnosticOptions {
	/** Evaluated for each new request, without changing the connection identity. */
	verbose?: () => boolean
}

export interface S3ProbeContext {
	capability: 'create' | 'overwrite' | 'delete'
	step:
		| 'seed'
		| 'seed-fallback'
		| 'verify-seed'
		| 'reject-mismatch'
		| 'verify-rejected'
		| 'accept-match'
		| 'verify-overwrite'
		| 'verify-deleted'
		| 'cleanup'
}

function redactSecrets(value: string, secrets: readonly string[]) {
	for (const secret of [...secrets]
		.filter(Boolean)
		.sort((a, b) => b.length - a.length)) {
		let encoded = secret
		try {
			encoded = encodeURIComponent(secret)
		} catch {
			// Diagnostics must not replace a failure with an encoding exception.
		}
		for (const form of new Set([secret, encoded]))
			value = value.split(form).join('[redacted]')
	}
	return value
}

/** Never retain a raw exception or signed URL. */
export function redactS3Diagnostic(value: string, secrets: readonly string[]) {
	return (
		redactSecrets(value, secrets)
			.replace(/https?:\/\/[^\s<>"']+/gi, '[url]')
			.replace(
				/\b(?:authorization|credential|signature|accessKeyId|secretAccessKey|sessionToken|x-amz-security-token|x-cos-security-token)\b["'\s:=]+[^\r\n]*/gi,
				'[redacted headers]',
			)
			.replace(
				/\b(?:Bearer|AWS4-HMAC-SHA256)\s+[^\r\n]*/gi,
				'[redacted authorization]',
			)
			// eslint-disable-next-line no-control-regex -- Keep native messages on one log line.
			.replace(/[\u0000-\u001f\u007f]/g, ' ')
			.slice(0, 512)
	)
}

function read(value: unknown, key: string): unknown {
	try {
		return value && typeof value === 'object'
			? (value as Record<string, unknown>)[key]
			: undefined
	} catch {
		return undefined
	}
}

/** Plain, bounded fields survive the existing log-to-note serializer. */
export function describeS3Exception(
	error: unknown,
	secrets: readonly string[],
	verbose = false,
) {
	const causes: Array<{
		name?: string
		message?: string
		code?: string
		reportedStatus?: number
		timeoutMs?: number
		stack?: string[]
	}> = []
	const seen = new Set<unknown>()
	for (
		let current = error;
		current != null && causes.length < 3;
		current = read(current, 'cause')
	) {
		if (seen.has(current)) break
		seen.add(current)
		const string = (value: unknown) =>
			typeof value === 'string' || typeof value === 'number'
				? redactS3Diagnostic(String(value), secrets)
				: undefined
		const status = read(current, 'status') ?? read(current, 'statusCode')
		const timeout = read(current, 'timeoutMs')
		const stack = verbose ? read(current, 'stack') : undefined
		causes.push({
			...(typeof stack === 'string'
				? {
						stack: stack
							.split('\n')
							.slice(0, 12)
							.map((line) => redactS3Diagnostic(line, secrets)),
					}
				: {}),
			name: string(read(current, 'name')),
			message: string(
				typeof current === 'string' ? current : read(current, 'message'),
			),
			code: string(read(current, 'code')),
			// A native exception's status is evidence, not an HTTP response. Do not
			// use it to downgrade a failed mutation into compatibility mode.
			reportedStatus:
				typeof status === 'number' &&
				Number.isInteger(status) &&
				status >= 100 &&
				status <= 599
					? status
					: undefined,
			timeoutMs:
				typeof timeout === 'number' && Number.isFinite(timeout)
					? timeout
					: undefined,
		})
	}
	return causes
}

const safeHeader =
	/^(?:host|accept(?:-encoding)?|content-(?:type|length|encoding|range|md5)|range|if-match|if-none-match|if-modified-since|if-unmodified-since|etag|last-modified|date|server|connection|transfer-encoding|cache-control|age|expires|vary|via|x-cache(?:-hits)?|cf-cache-status|x-amz-(?:date|content-sha256|request-id|id-2|version-id|delete-marker|bucket-region|server-side-encryption)|x-cos-(?:request-id|version-id|delete-marker|forbid-overwrite|hash-crc64ecma|storage-class)|accept-ranges|retry-after)$/i
const safeQuery =
	/^(?:list-type|encoding-type|prefix|delimiter|max-keys|continuation-token|start-after|versionId|response-cache-control|response-content-type|response-content-encoding|response-expires)$/i

function bounded(value: string, limit: number) {
	return value.length > limit ? value.slice(0, limit) + '…[truncated]' : value
}

/** Keep all bounded header names; only known protocol values may be disclosed. */
export function describeS3Headers(
	headers: Record<string, string>,
	secrets: readonly string[],
) {
	return Object.fromEntries(
		Object.entries(headers)
			.slice(0, 64)
			.map(([name, value]) => [
				bounded(redactS3Diagnostic(name.toLowerCase(), secrets), 128),
				safeHeader.test(name)
					? redactS3Diagnostic(String(value), secrets)
					: '[redacted]',
			]),
	)
}

export function s3ApiName(method: S3HttpRequest['method'], url: URL) {
	if (method === 'GET' && url.searchParams.get('list-type') === '2')
		return 'ListObjectsV2'
	return {
		GET: 'GetObject',
		HEAD: 'HeadObject',
		PUT: 'PutObject',
		DELETE: 'DeleteObject',
	}[method]
}

export function describeS3Request(
	request: S3HttpRequest,
	secrets: readonly string[],
) {
	const url = new URL(request.url)
	const query = [...url.searchParams].slice(0, 64).map(([name, value]) => ({
		name: redactS3Diagnostic(name, secrets),
		value: safeQuery.test(name)
			? redactS3Diagnostic(value, secrets)
			: '[redacted]',
	}))
	const safeUrl = new URL(url.origin + url.pathname)
	for (const { name, value } of query) safeUrl.searchParams.append(name, value)
	const authorization = new Headers(request.headers).get('authorization') ?? ''
	return {
		api: s3ApiName(request.method, url),
		url: bounded(redactSecrets(safeUrl.toString(), secrets), 8192),
		objectPath: bounded(
			redactSecrets(decodeURIComponent(url.pathname), secrets),
			4096,
		),
		query,
		headers: describeS3Headers(request.headers, secrets),
		headerCount: Object.keys(request.headers).length,
		queryCount: [...url.searchParams].length,
		signing: {
			algorithm: authorization.startsWith('AWS4-HMAC-SHA256 ')
				? 'AWS4-HMAC-SHA256'
				: 'unknown',
			credentialScope: redactS3Diagnostic(
				authorization.match(/Credential=[^/\s,]+\/([^\s,]+)/)?.[1] ?? '',
				secrets,
			),
			signedHeaders: redactS3Diagnostic(
				authorization.match(/SignedHeaders=([a-z0-9;-]+)/i)?.[1] ?? '',
				secrets,
			),
			credential: '[redacted]',
			signature: '[redacted]',
		},
		bodyPresent: request.body !== undefined,
		bodyBytes: request.body?.byteLength ?? 0,
		bodyContent: 'omitted',
		throwOnHttpError: false,
	}
}

export function describeS3VerboseResponse(
	response: S3HttpResponse,
	secrets: readonly string[],
) {
	const xml =
		response.status >= 300
			? new TextDecoder().decode(response.body.slice(0, 16 * 1024))
			: ''
	// Never log an error's CanonicalRequest/StringToSign/SignatureProvided or a
	// successful object/listing body. Only the service's bounded Message is added.
	const message = xml.match(/<Message>\s*([^<]*?)\s*<\/Message>/)?.[1]
	return {
		...describeS3Response(response, secrets),
		headers: describeS3Headers(response.headers, secrets),
		headerCount: Object.keys(response.headers).length,
		bodyBytes: response.body.byteLength,
		bodyContent: 'omitted',
		...(message
			? {
					serviceMessage: redactS3Diagnostic(
						decode(message, { level: 'xml' }),
						secrets,
					),
				}
			: {}),
	}
}

export function describeS3Response(
	response: S3HttpResponse,
	secrets: readonly string[],
) {
	const headers = new Headers(response.headers)
	// Error bodies can echo credentials or note data. Only extract bounded,
	// token-shaped service codes/IDs; never log XML or the server's Message.
	const xml =
		response.status >= 300
			? new TextDecoder().decode(response.body.slice(0, 16 * 1024))
			: ''
	const token = (value: string | null | undefined) => {
		if (!value || !/^[A-Za-z0-9+/=._:-]{1,256}$/.test(value)) return undefined
		return redactS3Diagnostic(value, secrets)
	}
	return {
		httpStatus: response.status,
		serviceCode: token(xml.match(/<Code>\s*([^<]+?)\s*<\/Code>/)?.[1]),
		requestId: token(
			headers.get('x-cos-request-id') ??
				headers.get('x-amz-request-id') ??
				xml.match(/<RequestId>\s*([^<]+?)\s*<\/RequestId>/)?.[1],
		),
	}
}
