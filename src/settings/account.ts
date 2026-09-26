import { Notice, Setting } from 'obsidian'
import i18n from '~/i18n'
import BaseSettings from './settings.base'

export default class AccountSettings extends BaseSettings {
	async display() {
		this.containerEl.empty()
		this.containerEl.addClass('jasync-s3-settings')
		new Setting(this.containerEl).setName('S3').setHeading()
		this.containerEl.createEl('p', { text: i18n.t('s3.syncNotice') })
		this.containerEl.createEl('p', { text: i18n.t('s3.credentialsNotice') })
		const fields = [
			['endpoint', 'Endpoint', 'https://s3.us-east-1.amazonaws.com'],
			['region', 'Region', 'us-east-1'],
			['bucket', 'Bucket', 'my-vault-bucket'],
			['prefix', 'Prefix', 'obsidian/my-vault/'],
			['accessKeyId', 'Access key ID', ''],
			['secretAccessKey', 'Secret access key', ''],
			['sessionToken', 'Session token', ''],
		] as const
		for (const [key, name, placeholder] of fields) {
			new Setting(this.containerEl)
				.setClass('jasync-s3-field')
				.setName(name)
				.addText((text) => {
					text
						.setPlaceholder(placeholder)
						.setValue(this.plugin.localSettings.s3[key])
						.onChange(async (value) => {
							this.plugin.localSettings.s3[key] = value
							await this.plugin.settingsService.saveLocalSettings()
						})
					if (['accessKeyId', 'secretAccessKey', 'sessionToken'].includes(key))
						text.inputEl.type = 'password'
				})
		}
		new Setting(this.containerEl)
			.setName(i18n.t('s3.pathStyle'))
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.localSettings.s3.forcePathStyle)
					.onChange(async (value) => {
						this.plugin.localSettings.s3.forcePathStyle = value
						await this.plugin.settingsService.saveLocalSettings()
					})
			})
		new Setting(this.containerEl)
			.setName(i18n.t('settings.checkConnection.name'))
			.addButton((button) => {
				button
					.setButtonText(i18n.t('settings.checkConnection.name'))
					.onClick(async () => {
						button.setDisabled(true)
						try {
							const session = await this.plugin.createRemoteSession()
							await session.storage.stat('/')
							new Notice(i18n.t('settings.checkConnection.success'))
						} catch (error) {
							new Notice(
								error instanceof Error
									? error.message
									: i18n.t('settings.checkConnection.failure'),
							)
						} finally {
							button.setDisabled(false)
						}
					})
			})
	}

	hide() {}
}
