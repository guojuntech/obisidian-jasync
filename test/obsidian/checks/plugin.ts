import type { App } from 'obsidian'
import { CHATBOX_VIEW_TYPE } from '~/views/chatbox.view'
import { assert } from './assert'

interface ProductionPlugin {
	isSyncing: boolean
	settingTab: { display(): void; containerEl: HTMLElement }
	manifest: { id: string; name: string }
	commandService: {
		openChatbox(): Promise<void>
	}
	progressService: {
		syncProgress: { total: number; completed: unknown[]; current: unknown }
		preparationProgress: unknown
		syncEnd: boolean
		syncFailed: boolean
		syncFailedCount: number
		showProgressModal(): void
		closeProgressModal(): void
		updateModal: (() => void) & { flush?: () => void }
	}
}

function getProductionPlugin(app: App): ProductionPlugin {
	const plugins = (
		app as unknown as { plugins: { plugins: Record<string, unknown> } }
	).plugins
	const plugin = plugins.plugins['omni-sync'] as ProductionPlugin | undefined
	assert(plugin, 'JASync is not loaded')
	return plugin
}

export async function loadsProductionPlugin(app: App) {
	getProductionPlugin(app)
}

export async function reloadsProductionPlugin(app: App) {
	const plugins = (
		app as unknown as {
			plugins: {
				disablePlugin(id: string): Promise<void>
				enablePlugin(id: string): Promise<void>
				plugins: Record<string, unknown>
			}
		}
	).plugins
	await plugins.disablePlugin('omni-sync')
	await plugins.enablePlugin('omni-sync')
	assert(
		plugins.plugins['omni-sync'],
		'Production plugin did not reload through the real lifecycle',
	)
}

export async function detachesChatboxWhenProductionPluginIsDisabled(app: App) {
	const plugins = (
		app as unknown as {
			plugins: {
				disablePlugin(id: string): Promise<void>
				enablePlugin(id: string): Promise<void>
			}
		}
	).plugins
	const plugin = getProductionPlugin(app)
	await plugin.commandService.openChatbox()
	assert(
		app.workspace.getLeavesOfType(CHATBOX_VIEW_TYPE).length === 1,
		'ChatBox view did not open before the production plugin was disabled',
	)

	await plugins.disablePlugin('omni-sync')
	try {
		assert(
			app.workspace.getLeavesOfType(CHATBOX_VIEW_TYPE).length === 0,
			'ChatBox view remained attached after the production plugin was disabled',
		)
	} finally {
		await plugins.enablePlugin('omni-sync')
	}

	const reloadedPlugin = getProductionPlugin(app)
	try {
		await reloadedPlugin.commandService.openChatbox()
		assert(
			app.workspace.getLeavesOfType(CHATBOX_VIEW_TYPE).length === 1,
			'Production plugin created duplicate ChatBox views after it was re-enabled',
		)
	} finally {
		app.workspace.detachLeavesOfType(CHATBOX_VIEW_TYPE)
	}
}

export async function rendersSyncProgress(app: App) {
	const plugin = getProductionPlugin(app)
	const progress = plugin.progressService
	plugin.isSyncing = true
	progress.syncProgress = { total: 0, completed: [], current: null }
	progress.preparationProgress = null
	progress.syncEnd = false
	progress.syncFailed = false
	progress.syncFailedCount = 0

	try {
		progress.showProgressModal()
		const modal = document.querySelector('.modal.omni-sync-progress-modal')
		assert(modal, 'Sync progress modal did not open')
		assert(
			modal.querySelector('.omni-sync-progress__status-icon--syncing'),
			'Sync progress modal did not render syncing state',
		)

		progress.syncEnd = true
		progress.updateModal()
		progress.updateModal.flush?.()

		assert(
			modal.querySelector('.omni-sync-progress__status-icon--complete'),
			'Sync progress modal did not render complete state',
		)
		const progressLabel = modal.querySelector('.omni-sync-progress__bar-label')
		assert(
			progressLabel?.textContent?.includes('100'),
			'Sync progress modal did not show 100% for an empty completed sync',
		)
		const stopButton = modal.querySelector('.omni-sync-progress__footer button')
		assert(
			stopButton?.classList.contains('hidden'),
			`Sync progress modal kept its stop control after completion: ${stopButton?.className ?? 'missing'}`,
		)
	} finally {
		progress.closeProgressModal()
		plugin.isSyncing = false
	}
}

export async function rendersS3OnlySettings(app: App) {
	const plugin = getProductionPlugin(app)
	assert(plugin.manifest.id === 'omni-sync', 'Plugin ID is not isolated')
	assert(
		plugin.manifest.name === 'JASync',
		'Plugin display name was not updated',
	)
	plugin.settingTab.display()
	await new Promise((resolve) => window.setTimeout(resolve, 0))
	const content = plugin.settingTab.containerEl.textContent ?? ''
	assert(
		content.includes('S3') &&
			content.includes('Bucket') &&
			content.includes('Prefix'),
		'S3 settings are missing',
	)
	assert(
		!/WebDAV|SSO|坚果云|Nutstore|OmniSync/i.test(content),
		'A removed integration is still shown',
	)
	const inputs = plugin.settingTab.containerEl.querySelectorAll(
		'input[type="password"]',
	)
	assert(inputs.length >= 3, 'S3 credential inputs are not masked')
}
