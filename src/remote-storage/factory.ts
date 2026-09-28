import { sha256Hex } from '~/utils/sha256'
import type { RemoteSession } from './remote-session'
import { S3RemoteStorage } from './s3/s3-storage'
import type { S3Settings } from './s3/settings'
import { obsidianS3Transport, type S3Transport } from './s3/transport'
import type { S3DiagnosticOptions } from './s3/diagnostics'

export async function createRemoteSession(
	settings: S3Settings,
	transport: S3Transport = obsidianS3Transport,
	diagnostics: S3DiagnosticOptions = {},
): Promise<RemoteSession> {
	const storage = new S3RemoteStorage({ ...settings }, transport, diagnostics)
	const config = storage.settings
	const identity = await sha256Hex(
		new TextEncoder().encode(
			JSON.stringify({
				backend: 's3',
				endpoint: config.endpoint,
				region: config.region,
				bucket: config.bucket,
				prefix: config.prefix,
				account: config.accessKeyId,
				forcePathStyle: config.forcePathStyle,
			}),
		),
	)
	return Object.freeze<RemoteSession>({
		identity,
		remoteBaseDir: '/',
		mode: 'read-write',
		storage,
		scanner: {
			scan: async (options) => ({
				complete: true,
				entries: await storage.scanEntries(options),
			}),
		},
	})
}
