import type { S3HttpResponse } from './transport'

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

/** Never retain the raw native exception, request headers, URL or response body. */
export function redactS3Diagnostic(value: string, secrets: readonly string[]) {
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
	return (
		value
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
) {
	const causes: Array<{
		name?: string
		message?: string
		code?: string
		reportedStatus?: number
		timeoutMs?: number
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
		causes.push({
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
