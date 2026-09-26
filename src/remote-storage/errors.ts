export type RemoteStorageErrorCode =
	| 'not-found'
	| 'unauthorized'
	| 'forbidden'
	| 'conflict'
	| 'precondition-failed'
	| 'unsupported'
	| 'invalid-response'
	| 'network'
	| 'rate-limited'
	| 'cancelled'
	| 'unknown'

export class RemoteStorageError extends Error {
	constructor(
		readonly code: RemoteStorageErrorCode,
		message: string,
		readonly status?: number,
		readonly cause?: unknown,
	) {
		super(message)
		this.name = 'RemoteStorageError'
	}
}

export function normalizeRemoteError(error: unknown): RemoteStorageError {
	if (error instanceof RemoteStorageError) return error
	const status =
		error &&
		typeof error === 'object' &&
		'status' in error &&
		typeof error.status === 'number'
			? error.status
			: undefined
	const codes: Partial<Record<number, RemoteStorageErrorCode>> = {
		401: 'unauthorized',
		403: 'forbidden',
		404: 'not-found',
		409: 'conflict',
		412: 'precondition-failed',
	}
	return new RemoteStorageError(
		(status && codes[status]) ||
			(error instanceof TypeError ? 'network' : 'unknown'),
		error instanceof Error ? error.message : String(error),
		status,
		error,
	)
}
