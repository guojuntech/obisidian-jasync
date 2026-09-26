import type { SyncPreparationProgress } from '~/events'
import i18n from '~/i18n'

export interface SyncPreparationText {
	operation: string
	detail: string
}

export function getSyncPreparationText(
	progress: SyncPreparationProgress,
): SyncPreparationText {
	const traversal = progress.traversal
	const fileDetail = progress.files
		? i18n.t('sync.preparation.fileStats', {
				completed: progress.files.completed,
				total: progress.files.total,
			})
		: ''

	switch (progress.phase) {
		case 'scanningLocal':
			return { operation: i18n.t('sync.preparation.scanningLocal'), detail: '' }
		case 'checkingCapabilities':
			return {
				operation: i18n.t('sync.preparation.checkingCapabilities'),
				detail: i18n.t('sync.preparation.capabilitiesDetail'),
			}
		case 'validating':
			return {
				operation: i18n.t('sync.preparation.validating'),
				detail: fileDetail || i18n.t('sync.preparation.validatingDetail'),
			}
		case 'recording':
			return {
				operation: i18n.t('sync.preparation.recording'),
				detail: fileDetail,
			}
		case 'checkingRemote':
			return {
				operation: i18n.t('sync.preparation.checkingRemote'),
				detail: '',
			}
		case 'loadingState':
			return {
				operation: i18n.t('sync.preparation.loadingState'),
				detail: '',
			}
		case 'analyzing':
			return {
				operation: i18n.t('sync.preparation.analyzing'),
				detail: fileDetail || i18n.t('sync.preparation.analyzingDetail'),
			}
		case 'savingCache':
			return {
				operation: i18n.t('sync.preparation.savingCache'),
				detail: '',
			}
		case 'traversingRemote':
			break
	}

	if (!traversal || traversal.phase === 'complete') {
		return {
			operation: i18n.t('sync.preparation.analyzing'),
			detail: '',
		}
	}

	if (traversal.phase === 'retrying') {
		return {
			operation: i18n.t('sync.preparation.retryingRemote'),
			detail: traversal.currentPath ?? '',
		}
	}

	if (traversal.processedPages !== undefined) {
		return {
			operation: i18n.t('s3.scanning'),
			detail: i18n.t('s3.scanProgress', {
				pages: traversal.processedPages,
				items: traversal.discoveredItems,
			}),
		}
	}

	if (traversal.phase === 'incremental') {
		return {
			operation: i18n.t('sync.preparation.checkingChanges'),
			detail: i18n.t('sync.preparation.incrementalStats', {
				changes: traversal.processedChanges,
			}),
		}
	}

	return {
		operation: i18n.t('sync.preparation.scanningRemote'),
		detail: i18n.t('sync.preparation.traversalStats', {
			processed: traversal.processedDirectories,
			queued: traversal.queuedDirectories,
			items: traversal.discoveredItems,
		}),
	}
}
