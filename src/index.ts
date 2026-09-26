import { createRemoteSession } from './remote-storage/factory'
import 'blob-polyfill'

import './polyfill'

import './assets/styles/global.css'

import { Menu, Plugin } from 'obsidian'
import { createSelectedTextContextItem } from './ai/chat/context/user-context'
import { registerChatboxAiIcon } from './assets/icons/chatbox-ai-icon'
import { registerJASyncIcon } from './assets/icons/jasync-sync-icon'
import { SyncRibbonManager } from './components/SyncRibbonManager'
import { emitCancelSync } from './events'
import i18n from './i18n'
import AIConflictResolverService from './services/ai-conflict-resolver.service'
import ChatService from './services/chat.service'
import CommandService from './services/command.service'
import EventsService from './services/events.service'
import GcService from './services/gc.service'
import I18nService from './services/i18n.service'
import LoggerService from './services/logger.service'
import McpService from './services/mcp.service'
import ModelsPresetService from './services/models-preset.service'
import { ProgressService } from './services/progress.service'
import ProtocolService from './services/protocol.service'
import RealtimeSyncService from './services/realtime-sync.service'
import ScheduledSyncService from './services/scheduled-sync.service'
import { BaseService } from './services/service.interface'
import SettingsService from './services/settings.service'
import { StatusService } from './services/status.service'
import SyncExecutorService from './services/sync-executor.service'
import {
	JASyncLocalSettings,
	JASyncSettings,
	JASyncSettingTab,
} from './settings'
import ChatboxView, { CHATBOX_VIEW_TYPE } from './views/chatbox.view'

export default class JASyncPlugin extends Plugin {
	declare public settings: JASyncSettings

	public isSyncing: boolean = false
	public localSettings!: JASyncLocalSettings
	public settingTab!: JASyncSettingTab

	public commandService = new CommandService(this)
	public eventsService = new EventsService(this)
	public i18nService = new I18nService(this)
	public loggerService = new LoggerService(this)
	public mcpService = new McpService(this)
	public modelsPresetService = new ModelsPresetService(this)
	public protocolService = new ProtocolService(this)
	public progressService = new ProgressService(this)
	public ribbonService = new SyncRibbonManager(this)
	public statusService = new StatusService(this)
	public settingsService = new SettingsService(this)
	public syncExecutorService = new SyncExecutorService(this)
	public gcService = new GcService(this)
	public chatService = new ChatService(this)
	public aiConflictResolverService = new AIConflictResolverService(this)
	public realtimeSyncService = new RealtimeSyncService(
		this,
		this.syncExecutorService,
	)
	public scheduledSyncService = new ScheduledSyncService(
		this,
		this.syncExecutorService,
	)

	private get services(): BaseService[] {
		return [
			this.loggerService,
			this.modelsPresetService,
			this.syncExecutorService,
			this.gcService,
			this.settingsService,
			this.i18nService,
			this.statusService,
			this.progressService,
			this.eventsService,
			this.commandService,
			this.ribbonService,
			this.protocolService,
			this.realtimeSyncService,
			this.mcpService,
			this.chatService,
			this.aiConflictResolverService,
			this.scheduledSyncService,
		]
	}

	async onload() {
		registerJASyncIcon()
		registerChatboxAiIcon()
		for (const service of this.services) {
			await service.onload()
		}
		this.settingTab = new JASyncSettingTab(this.app, this)
		this.addSettingTab(this.settingTab)
		this.registerView(CHATBOX_VIEW_TYPE, (leaf) => new ChatboxView(leaf, this))
		this.registerEvent(
			this.app.workspace.on('editor-menu', (menu: Menu, editor, view) => {
				if (!editor.somethingSelected()) return
				menu.addItem((item) => {
					item.setTitle(this.manifest.name).setIcon('cloud')
					item.setSubmenu()
					const submenu = item.submenu
					if (!submenu) return
					submenu.addItem((subItem) => {
						subItem
							.setTitle(i18n.t('chatbox.addToContext'))
							.setIcon('message-square-plus')
							.onClick(async () => {
								const sel = editor.listSelections()[0]
								if (!sel) return
								const file = (
									view as {
										file?: { path: string; basename: string } | null
									}
								).file
								if (!file) return
								this.chatService.addUserContext(
									createSelectedTextContextItem({
										type: 'selection',
										filePath: file.path,
										range: {
											from: { line: sel.anchor.line, ch: sel.anchor.ch },
											to: { line: sel.head.line, ch: sel.head.ch },
										},
										selectedText: editor.getSelection(),
									}),
								)
								await this.commandService.openChatbox()
							})
					})
				})
			}),
		)

		await this.chatService.handleSettingsChanged()
	}

	onunload() {
		emitCancelSync()
		for (const service of [...this.services].reverse()) {
			void service.onunload()
		}
	}

	toggleSyncUI(isSyncing: boolean) {
		this.isSyncing = isSyncing
		this.ribbonService.update()
	}

	createRemoteSession() {
		return createRemoteSession(this.localSettings.s3)
	}

	isAccountConfigured(): boolean {
		const { bucket, region, accessKeyId, secretAccessKey } =
			this.localSettings.s3
		return Boolean(
			bucket.trim() && region.trim() && accessKeyId.trim() && secretAccessKey,
		)
	}

	get remoteBaseDir() {
		return '/'
	}
}
