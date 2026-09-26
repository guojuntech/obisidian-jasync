import * as obsidian from 'obsidian'
import type { App } from 'obsidian'
import * as editorState from '@codemirror/state'
import * as editorView from '@codemirror/view'
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
	const plugin = plugins.plugins['jasync'] as ProductionPlugin | undefined
	assert(plugin, 'JASync is not loaded')
	return plugin
}

export async function loadsProductionPlugin(app: App) {
	getProductionPlugin(app)
}

// A separate browser realm avoids Electron's Node globals masking mobile
// import-time failures. Host APIs are supplied as Obsidian does on mobile.
// This checks module evaluation, not Android's full plugin lifecycle.
export async function evaluatesProductionBundleWithoutNode(app: App) {
	const source = await app.vault.adapter.read(
		`${app.vault.configDir}/plugins/jasync/main.js`,
	)
	const frame = document.createElement('iframe')
	frame.hidden = true
	document.body.appendChild(frame)
	try {
		const browser = frame.contentWindow as Window & typeof globalThis
		assert(browser, 'Missing browser realm')
		assert(typeof browser.Buffer === 'undefined', 'Browser has Node Buffer')
		assert(typeof browser.process === 'undefined', 'Browser has Node process')
		assert(typeof browser.require === 'undefined', 'Browser has Node require')
		const modules: Record<string, unknown> = {
			obsidian,
			'@codemirror/state': editorState,
			'@codemirror/view': editorView,
		}
		const requireHostModule = (name: string) => {
			assert(Object.hasOwn(modules, name), `Unexpected host module: ${name}`)
			return modules[name]
		}
		const pluginModule = { exports: {} as { default?: unknown } }
		// Evaluate the exact release file in the iframe's realm, without host
		// globals being captured from the desktop test harness.
		const evaluate = new browser.Function(
			'require',
			'module',
			'exports',
			source,
		)
		evaluate(requireHostModule, pluginModule, pluginModule.exports)
		assert(
			typeof pluginModule.exports.default === 'function',
			'Browser bundle did not export the plugin class',
		)
		assert(
			typeof browser.Buffer === 'undefined',
			'Bundle installed a global Buffer',
		)
	} finally {
		frame.remove()
	}
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
	await plugins.disablePlugin('jasync')
	await plugins.enablePlugin('jasync')
	assert(
		plugins.plugins['jasync'],
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

	await plugins.disablePlugin('jasync')
	try {
		assert(
			app.workspace.getLeavesOfType(CHATBOX_VIEW_TYPE).length === 0,
			'ChatBox view remained attached after the production plugin was disabled',
		)
	} finally {
		await plugins.enablePlugin('jasync')
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
		const modal = document.querySelector('.modal.jasync-progress-modal')
		assert(modal, 'Sync progress modal did not open')
		assert(
			modal.querySelector('.jasync-progress__status-icon--syncing'),
			'Sync progress modal did not render syncing state',
		)

		progress.syncEnd = true
		progress.updateModal()
		progress.updateModal.flush?.()

		assert(
			modal.querySelector('.jasync-progress__status-icon--complete'),
			'Sync progress modal did not render complete state',
		)
		const progressLabel = modal.querySelector('.jasync-progress__bar-label')
		assert(
			progressLabel?.textContent?.includes('100'),
			'Sync progress modal did not show 100% for an empty completed sync',
		)
		const stopButton = modal.querySelector('.jasync-progress__footer button')
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
	assert(plugin.manifest.id === 'jasync', 'Plugin ID is not isolated')
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
		!/WebDAV|SSO|坚果云|Nutstore/i.test(content),
		'A removed integration is still shown',
	)
	const inputs = plugin.settingTab.containerEl.querySelectorAll(
		'input[type="password"]',
	)
	assert(inputs.length >= 3, 'S3 credential inputs are not masked')
}
