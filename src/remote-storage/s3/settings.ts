import { validateRelativePath } from '../paths'
export { validateRelativePath } from '../paths'

export interface S3Settings {
	endpoint: string
	region: string
	bucket: string
	prefix: string
	accessKeyId: string
	secretAccessKey: string
	sessionToken: string
	forcePathStyle: boolean
}

export const DEFAULT_S3_SETTINGS: S3Settings = {
	endpoint: '',
	region: 'us-east-1',
	bucket: '',
	prefix: '',
	accessKeyId: '',
	secretAccessKey: '',
	sessionToken: '',
	forcePathStyle: false,
}

export function normalizeS3Settings(
	settings: S3Settings,
): Readonly<S3Settings> {
	const region = settings.region.trim()
	const bucket = settings.bucket.trim()
	if (!/^[a-z0-9][a-z0-9-]*$/.test(region)) throw new Error('Invalid S3 region')
	if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket))
		throw new Error('Invalid S3 bucket name')
	if (!settings.accessKeyId.trim() || !settings.secretAccessKey)
		throw new Error('S3 credentials are required')
	const endpoint = new URL(
		settings.endpoint.trim() || `https://s3.${region}.amazonaws.com`,
	)
	if (
		!['https:', 'http:'].includes(endpoint.protocol) ||
		endpoint.username ||
		endpoint.password ||
		endpoint.search ||
		endpoint.hash ||
		!['', '/'].includes(endpoint.pathname)
	) {
		throw new Error(
			'S3 endpoint must be an HTTP(S) origin without credentials, path, query or fragment',
		)
	}
	const prefix = normalizePrefix(settings.prefix)
	return Object.freeze({
		...settings,
		region,
		bucket,
		prefix,
		accessKeyId: settings.accessKeyId.trim(),
		endpoint: endpoint.origin,
	})
}

export function normalizePrefix(prefix: string): string {
	const value = prefix.replace(/^\/+|\/+$/g, '')
	if (value) validateRelativePath(value)
	return value ? `${value}/` : ''
}
