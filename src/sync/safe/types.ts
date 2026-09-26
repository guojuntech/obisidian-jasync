import type { RemoteVersion } from '~/remote-storage/remote-storage.interface'
import type { SyncPolicy } from '~/settings'

export interface FileState {
	hash: string
	size: number
	version?: RemoteVersion
}

export interface SyncFileProgress {
	completed: number
	total: number
	currentPath?: string
}

export interface Baseline {
	hash: string
	size: number
	version?: RemoteVersion
	/** Only retained for small UTF-8 files to allow a genuine three-way merge. */
	text?: string
}

export type SyncAction =
	| 'upload'
	| 'download'
	| 'delete-local'
	| 'delete-remote'
	| 'merge'
	| 'keep-both'
	| 'equal'
	| 'skip'
export interface PlanItem {
	path: string
	action: SyncAction
	local?: FileState
	remote?: FileState
	copyPath?: string
	mergedText?: string
	reason?: string
	conflict?: boolean
}

export interface SyncState {
	format: 2
	identity: string
	records: Record<string, Baseline>
}

export interface LocalSyncIO {
	read(path: string): Promise<ArrayBuffer | undefined>
	write(path: string, data: ArrayBuffer, expectedHash?: string): Promise<void>
	remove(path: string, expectedHash: string): Promise<void>
}

export interface SyncPersistence {
	load(): Promise<SyncState>
	save(state: SyncState): Promise<void>
	backup(
		run: string,
		path: string,
		side: 'local' | 'remote',
		data: ArrayBuffer,
	): Promise<void>
	journal(
		run: string,
		item: PlanItem,
		status: 'pending' | 'complete',
	): Promise<void>
}

/** Content, not timestamps or byte counts, establishes a common baseline. */
export function chooseAction(
	local: string | undefined,
	remote: string | undefined,
	base: string | undefined,
	policy: `${SyncPolicy}`,
): SyncAction {
	if (local === remote) return 'equal'
	if (policy === 'send-only-override-changes')
		return local ? 'upload' : 'delete-remote'
	if (policy === 'receive-only-revert-local-changes')
		return remote ? 'download' : 'delete-local'
	if (policy === 'send-only') {
		if (!local) return base && remote === base ? 'delete-remote' : 'skip'
		if ((base && remote !== base) || (!base && remote)) return 'skip'
		return 'upload'
	}
	if (policy === 'receive-only') {
		if (!remote) return base && local === base ? 'delete-local' : 'skip'
		if ((base && local !== base) || (!base && local)) return 'skip'
		return 'download'
	}
	if (!local) return base && remote === base ? 'delete-remote' : 'download'
	if (!remote) return base && local === base ? 'delete-local' : 'upload'
	if (base === local) return 'download'
	if (base === remote) return 'upload'
	return 'keep-both'
}
