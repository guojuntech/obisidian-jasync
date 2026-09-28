import { RemoteStorageError } from '../errors'

/** Only the Android native transport may identify the lost HEAD response. */
export class AndroidHeadResponseError extends RemoteStorageError {
	constructor(
		message: string,
		cause: unknown,
		readonly diagnosticId?: string,
	) {
		super('network', message, undefined, cause)
	}
}

export interface HeadFallbackContext {
	parentDiagnosticId: string
	fallbackReason: 'android-head-stream-closed'
	fallbackStep: 'range-get' | 'empty-file-head'
}
