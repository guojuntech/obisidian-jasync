import { Notice } from 'obsidian'
import { JASYNC_SYNC_ICON_ID } from '~/assets/icons/jasync-sync-icon'
import { addClassTokens, removeClassTokens } from '~/utils/class-tokens'
import logger from '~/utils/logger'
import { emitCancelSync } from '../events'
import i18n from '../i18n'
import type JASyncPlugin from '../index'
import { BaseService } from '../services/service.interface'
import { SyncStartMode } from '../sync'
import { type SyncPolicy } from '../settings'
import SyncConfirmModal from './SyncConfirmModal'

export class SyncRibbonManager extends BaseService {
	private startRibbonEl: HTMLElement | null = null
	private stopRibbonEl: HTMLElement | null = null

	constructor(private plugin: JASyncPlugin) {
		super()
	}

	override onload() {
		this.startRibbonEl = this.plugin.addRibbonIcon(
			JASYNC_SYNC_ICON_ID,
			i18n.t('sync.startButton'),
			async () => {
				if (this.plugin.isSyncing) {
					return
				}

				// 检查账号配置
				if (!this.plugin.isAccountConfigured()) {
					new Notice(i18n.t('sync.error.accountNotConfigured'))
					// 打开设置页面，引导用户配置账号
					try {
						const setting = this.plugin.app.setting
						if (setting) {
							setting.open()
							setting.openTabById(this.plugin.manifest.id)
						}
					} catch (error) {
						logger.error('Failed to open settings:', error)
					}
					return
				}

				const startSync = async (syncPolicy?: SyncPolicy) => {
					await this.plugin.syncExecutorService.executeSync({
						mode: SyncStartMode.MANUAL_SYNC,
						syncPolicy,
					})
				}
				if (this.plugin.settings.confirmBeforeSync) {
					new SyncConfirmModal(
						this.plugin.app,
						this.plugin.settings,
						this.plugin.localSettings,
						(syncPolicy) => {
							void startSync(syncPolicy)
						},
					).open()
				} else {
					void startSync()
				}
			},
		)

		this.startRibbonEl.addClass('jasync-sync-ribbon')

		this.stopRibbonEl = this.plugin.addRibbonIcon(
			'square',
			i18n.t('sync.stopButton'),
			() => emitCancelSync(),
		)
		addClassTokens(this.stopRibbonEl, ':uno: hidden')
	}

	public update() {
		if (!this.startRibbonEl || !this.stopRibbonEl) {
			return
		}
		if (this.plugin.isSyncing) {
			this.startRibbonEl.setAttr('aria-disabled', 'true')
			this.startRibbonEl.addClass('jasync-sync-ribbon--syncing')
			removeClassTokens(this.stopRibbonEl, ':uno: hidden')
		} else {
			this.startRibbonEl.removeAttribute('aria-disabled')
			this.startRibbonEl.removeClass('jasync-sync-ribbon--syncing')
			addClassTokens(this.stopRibbonEl, ':uno: hidden')
		}
	}
}
