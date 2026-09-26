import type { RemoteStat } from './remote-storage.interface'

export interface RemoteScanProgress {
	phase: 'scanning' | 'incremental' | 'retrying' | 'complete'
	currentPath?: string
	processedPages?: number
	processedDirectories: number
	queuedDirectories: number
	discoveredItems: number
	processedChanges: number
}

export interface RemoteScanOptions {
	onProgress?: (progress: RemoteScanProgress) => void
	throwIfCancelled?: () => void
}

export interface RemoteSnapshot {
	complete: true
	entries: RemoteStat[]
}

export interface RemoteScanner {
	/** Return the complete snapshot, or reject. Never return a partial scan. */
	scan(options?: RemoteScanOptions): Promise<RemoteSnapshot>
}
