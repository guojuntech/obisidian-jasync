import { Subject } from 'rxjs'
import type { RemoteScanProgress } from '~/remote-storage/remote-scanner.interface'
import type { SyncFileProgress } from '~/sync/safe/types'

export type SyncPreparationPhase =
	| 'checkingRemote'
	| 'scanningLocal'
	| 'loadingState'
	| 'traversingRemote'
	| 'analyzing'
	| 'savingCache'
	| 'checkingCapabilities'
	| 'validating'
	| 'recording'

export interface SyncPreparationProgress {
	phase: SyncPreparationPhase
	traversal?: RemoteScanProgress
	files?: SyncFileProgress
}

const syncPreparationProgress = new Subject<SyncPreparationProgress>()

export const onSyncPreparationProgress = () =>
	syncPreparationProgress.asObservable()

export const emitSyncPreparationProgress = (
	progress: SyncPreparationProgress,
) => syncPreparationProgress.next(progress)
