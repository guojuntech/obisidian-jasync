import { Notice, type Modal } from 'obsidian'
import { parse as parseBytes } from 'bytes-iec'
import type JASyncPlugin from '~/index'
import type { RemoteSession } from '~/remote-storage/remote-session'
import type { SyncPolicy } from '~/settings'
import { LocalVaultFileSystem } from '~/fs/local-vault'
import { SyncRecord } from '~/storage/sync-record'
import { syncRecordKV } from '~/storage'
import { compileFilterRules, isPathIncluded } from '~/utils/glob-match'
import {
	computeEffectiveFilterRules,
	isPluginSelfPath,
} from '~/utils/config-dir-rules'
import { parseMobileAppDownloadFileChunkSize } from '~/utils/download-chunk-size'
import { sha256Hex } from '~/utils/sha256'
import { createSyncLogger } from '~/sync/log'
import { BaseTask, type BaseTaskOptions } from '~/sync/tasks/task.interface'
import type { SyncStartResult } from '~/sync'
import {
	emitPreparingSync,
	emitSyncPreparationProgress,
	emitSyncProgress,
	emitStartSync,
	emitEndSync,
	emitSyncCancelled,
	onCancelSync,
	type CompletedTask,
} from '~/events'
import TaskListConfirmModal from '~/components/TaskListConfirmModal'
import SafetyConfirmModal from '~/components/SafetyConfirmModal'
import i18n from '~/i18n'
import { SafeSyncEngine, SyncCancelledError } from './engine'
import { VaultSyncIO, VaultSyncPersistence } from './vault-io'
import type { PlanItem } from './types'

class PlannedTask extends BaseTask {
	constructor(
		options: BaseTaskOptions,
		readonly item: PlanItem,
	) {
		super(options)
	}
	override get displayName() {
		const names = {
			upload: 'upload',
			download: 'download',
			'delete-local': 'removeLocal',
			'delete-remote': 'removeRemote',
			merge: 'merge',
			equal: 'noop',
			skip: 'skip',
		} as const
		if (this.item.action === 'keep-both')
			return i18n.t('s3.keepBoth', { path: this.item.copyPath })
		const label = i18n.t(`sync.fileOp.${names[this.item.action]}`)
		return this.item.reason ? `${label}: ${this.item.reason}` : label
	}
	exec(): never {
		throw new Error(
			'Planned tasks must execute through the validated S3 coordinator',
		)
	}
}

/** Production coordinator. The retained upstream task executor is not used for S3. */
export async function runSafeSync(
	plugin: JASyncPlugin,
	session: RemoteSession,
	policy: SyncPolicy,
	automatic: boolean,
): Promise<SyncStartResult> {
	let cancelled = false
	let pendingModal: Modal | undefined
	const cancel = onCancelSync().subscribe(() => {
		cancelled = true
		pendingModal?.close()
	})
	const checkCancelled = () => {
		if (cancelled) throw new SyncCancelledError()
	}
	const result = { ended: false, ranTasks: false, shouldReloadSettings: false }
	const settings = structuredClone(plugin.settings)
	const filters = structuredClone(computeEffectiveFilterRules(plugin))
	const compiled = compileFilterRules(filters.rules)
	const identity = await sha256Hex(
		new TextEncoder().encode(
			`${plugin.localSettings.vaultId}:${session.identity}`,
		),
	)
	const record = new SyncRecord(identity, syncRecordKV)
	const vault = plugin.app.vault
	const persistence = new VaultSyncPersistence(
		vault,
		plugin.manifest.dir!,
		identity,
	)
	const engine = new SafeSyncEngine({
		identity,
		local: new VaultSyncIO(vault, plugin.app.fileManager),
		remote: session.storage,
		persistence,
		checkCancelled,
		chunkSize: parseMobileAppDownloadFileChunkSize(
			settings.mobileAppDownloadFileChunkSize,
		),
	})
	const prompt = async (modal: SafetyConfirmModal) => {
		plugin.progressService.closeProgressModal()
		pendingModal = modal
		const accepted = await modal.openAndWait()
		pendingModal = undefined
		checkCancelled()
		if (accepted && !automatic) plugin.progressService.showProgressModal()
		return accepted
	}
	try {
		emitPreparingSync({ showNotice: !automatic })
		emitSyncPreparationProgress({ phase: 'scanningLocal' })
		const locals = await new LocalVaultFileSystem({
			vault,
			syncRecord: record,
			filterRules: filters,
		}).walk()
		checkCancelled()
		const remote = await session.scanner.scan({
			throwIfCancelled: checkCancelled,
			onProgress: (traversal) =>
				emitSyncPreparationProgress({ phase: 'traversingRemote', traversal }),
		})
		if (!remote.complete) throw new Error('Incomplete S3 scan')
		emitSyncPreparationProgress({ phase: 'analyzing' })
		const plan = await engine.plan({
			local: locals.map(({ stat, ignored }) => ({ ...stat, ignored })),
			remote: remote.entries,
			include: (path) => isPathIncluded(path, compiled, false),
			maxBytes:
				parseBytes(settings.skipLargeFiles.maxSize, { mode: 'jedec' }) ??
				30 * 1024 * 1024,
			policy,
			strategy: settings.conflictStrategy,
			onProgress: (files) =>
				emitSyncPreparationProgress({ phase: 'analyzing', files }),
		})
		for (const item of plan) {
			if (
				(item.action === 'delete-local' || item.action === 'delete-remote') &&
				isPluginSelfPath(item.path, vault.configDir)
			) {
				item.action = 'skip'
				item.reason = i18n.t('s3.protectPlugin')
			}
		}
		const tasks = plan
			.filter((item) => item.action !== 'equal')
			.map(
				(item) =>
					new PlannedTask(
						{
							vault,
							syncRecord: record,
							remoteStorage: session.storage,
							remoteBaseDir: '/',
							localPath: item.path,
							remotePath: `/${item.path}`,
							logger: createSyncLogger('JASync'),
						},
						item,
					),
			)
		checkCancelled()
		let approved = tasks
		if (!automatic && tasks.length) {
			plugin.progressService.closeProgressModal()
			const modal = new TaskListConfirmModal(plugin.app, tasks)
			pendingModal = modal
			const confirmation = await modal.openAndWait()
			pendingModal = undefined
			if (!confirmation.confirm) {
				emitSyncCancelled()
				return result
			}
			approved = confirmation.tasks as PlannedTask[]
			emitSyncPreparationProgress({ phase: 'validating' })
			checkCancelled()
			plugin.progressService.showProgressModal()
		}
		checkCancelled()
		const actionable = approved.filter((task) => task.item.action !== 'skip')
		const deletionCount = actionable.filter((task) =>
			task.item.action.startsWith('delete-'),
		).length
		// Conflicts and protected deletions require a subsequent manual preview.
		if (
			automatic &&
			(actionable.some(({ item }) => item.conflict) ||
				(deletionCount > 0 && settings.confirmBeforeDeleteInAutoSync) ||
				deletionCount >= 10)
		) {
			new Notice(i18n.t('s3.manualReviewRequired'))
			emitSyncCancelled()
			return result
		}
		if (
			deletionCount >= 10 &&
			!(await prompt(
				new SafetyConfirmModal(
					plugin.app,
					i18n.t('s3.deleteTitle'),
					i18n.t('s3.deleteNotice', { count: deletionCount }),
					i18n.t('s3.confirmDelete'),
				),
			))
		) {
			emitSyncCancelled()
			return result
		}
		const needsRemote = actionable.some(({ item }) =>
			['upload', 'merge', 'keep-both', 'delete-remote'].includes(item.action),
		)
		let allowUnconditional = false
		if (needsRemote) {
			checkCancelled()
			emitSyncPreparationProgress({ phase: 'checkingCapabilities' })
			const support = await session.storage.verifyMutationSupport()
			checkCancelled()
			const unsupported = actionable.some(({ item }) =>
				item.action === 'delete-remote'
					? !support.delete
					: item.action === 'keep-both'
						? !support.create
						: item.action === 'merge' ||
							  (item.action === 'upload' && item.remote)
							? !support.overwrite
							: item.action === 'upload'
								? !support.create
								: false,
			)
			if (unsupported) {
				if (automatic) {
					new Notice(i18n.t('s3.manualReviewRequired'))
					emitSyncCancelled()
					return result
				}
				allowUnconditional = await prompt(
					new SafetyConfirmModal(
						plugin.app,
						i18n.t('s3.compatibilityTitle'),
						i18n.t('s3.compatibilityNotice'),
						i18n.t('s3.compatibilityConfirm'),
					),
				)
				if (!allowUnconditional) {
					emitSyncCancelled()
					return result
				}
			}
		}
		emitSyncPreparationProgress({ phase: 'validating' })
		// A settings change while the preview was open invalidates the consent.
		if ((await plugin.createRemoteSession()).identity !== session.identity)
			throw new Error(i18n.t('s3.targetChanged'))
		const work = [
			...actionable.map((task) => task.item),
			...plan.filter((item) => item.action === 'equal'),
		]
		await engine.validate(work, (files) =>
			emitSyncPreparationProgress({ phase: 'validating', files }),
		)
		checkCancelled()
		if (actionable.length) emitStartSync({ showNotice: !automatic })
		const completed: CompletedTask[] = []
		for (const task of actionable) {
			checkCancelled()
			emitSyncProgress(actionable.length, completed, task)
			await engine.execute(task.item, allowUnconditional)
			result.ranTasks = true
			completed.push({ task, success: true })
			emitSyncProgress(actionable.length, [...completed], null)
		}
		const unchanged = work.filter((item) => item.action === 'equal')
		for (const [index, item] of unchanged.entries()) {
			checkCancelled()
			emitSyncPreparationProgress({
				phase: 'recording',
				files: {
					completed: index,
					total: unchanged.length,
					currentPath: item.path,
				},
			})
			await engine.execute(item)
		}
		checkCancelled()
		result.ended = true
		emitEndSync({ showNotice: !automatic, failedCount: 0 })
		const skipped = tasks.length - actionable.length
		if (skipped && !automatic)
			new Notice(i18n.t('s3.skippedNotice', { count: skipped }))
		return result
	} catch (error) {
		if (error instanceof SyncCancelledError) {
			emitSyncCancelled()
			return result
		}
		throw error
	} finally {
		cancel.unsubscribe()
		plugin.toggleSyncUI(false)
	}
}
