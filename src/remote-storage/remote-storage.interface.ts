import type { StatModel } from '~/model/stat.model'
import { RemoteStorageError } from './errors'

// Adapted from obsidian-alipan-sync's RemoteStorage abstraction (AGPL-3.0).
// Provider-specific cursors belong to RemoteScanner, not the CRUD contract.
export type RemoteBufferLike = ArrayBuffer | Uint8Array

export interface RemoteVersion {
	etag?: string
	versionId?: string
}

export type RemoteStat = StatModel & { version?: RemoteVersion }
export type CapabilitySupport = 'supported' | 'unsupported' | 'unknown'

export interface RemoteCapabilities {
	rangeRead: CapabilitySupport
	conditionalRead: CapabilitySupport
	conditionalWrite: CapabilitySupport
	conditionalDelete: CapabilitySupport
	recursiveDelete: CapabilitySupport
}

export interface UploadOptions {
	mode: 'create' | 'overwrite'
	expectedVersion?: RemoteVersion
	/** Explicit, per-run user consent after capability detection. */
	allowUnconditional?: boolean
}

export interface DownloadOptions {
	range?: { start: number; end: number }
	expectedVersion?: RemoteVersion
}

export interface DownloadResult {
	data: ArrayBuffer
	version?: RemoteVersion
	range?: { start: number; end: number; total?: number }
}

export interface UploadResult {
	success: true
	// Only a version returned by the write itself; never a subsequent stat.
	version?: RemoteVersion
}

export interface DeleteOptions {
	expectedVersion?: RemoteVersion
	allowUnconditional?: boolean
}

export interface MutationSupport {
	create: boolean
	overwrite: boolean
	delete: boolean
}

export interface MkdirOptions {
	recursive?: boolean
}

/** All I/O rejects on failure; only a genuine absence makes exists return false. */
export default abstract class RemoteStorage {
	async verifyMutationSupport(): Promise<MutationSupport> {
		return { create: false, overwrite: false, delete: false }
	}
	abstract readonly type: string
	abstract readonly capabilities: Readonly<RemoteCapabilities>
	abstract putFileContents(
		path: string,
		content: RemoteBufferLike | string,
		options: UploadOptions,
	): Promise<UploadResult>
	abstract getFileContents(
		path: string,
		options?: DownloadOptions,
	): Promise<DownloadResult>
	/** File objects only. A directory must use the explicit recursive operation. */
	abstract deleteFile(path: string, options?: DeleteOptions): Promise<void>
	abstract stat(path: string): Promise<RemoteStat>
	abstract createDirectory(path: string, options?: MkdirOptions): Promise<void>
	/** Immediate children, with all provider pagination exhausted. */
	abstract getDirectoryContents(path: string): Promise<RemoteStat[]>

	async exists(path: string): Promise<boolean> {
		try {
			await this.stat(path)
			return true
		} catch (error) {
			if (error instanceof RemoteStorageError && error.code === 'not-found') {
				return false
			}
			throw error
		}
	}

	deleteDirectoryRecursively(_path: string): Promise<void> {
		return Promise.reject(
			new RemoteStorageError(
				'unsupported',
				'Recursive directory deletion is unsupported',
			),
		)
	}
}
