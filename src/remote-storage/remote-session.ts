import type { SyncLogger } from '~/sync/log'
import type RemoteStorage from './remote-storage.interface'
import type { RemoteScanner } from './remote-scanner.interface'

export interface RemoteCacheLifecycle {
	restore(logger: SyncLogger): Promise<boolean>
	save(logger: SyncLogger, isCancelled: () => boolean): Promise<boolean>
}

/** A connection snapshot shared by scanning, tasks, browsing and cache I/O. */
export interface RemoteSession {
	readonly identity: string
	readonly mode: 'preview' | 'read-write'
	readonly remoteBaseDir: string
	readonly storage: RemoteStorage
	readonly scanner: RemoteScanner
	readonly cache?: RemoteCacheLifecycle
}
