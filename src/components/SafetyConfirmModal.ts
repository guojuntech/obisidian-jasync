import { Modal, Setting, type App } from 'obsidian'
import i18n from '~/i18n'

/** Explicit per-operation consent, never a persisted downgrade of S3 safety. */
export default class SafetyConfirmModal extends Modal {
	private accepted = false
	private resolve?: (accepted: boolean) => void
	constructor(
		app: App,
		private readonly title: string,
		private readonly message: string,
		private readonly confirmText: string,
	) {
		super(app)
	}
	onOpen() {
		this.setTitle(this.title)
		this.contentEl.createEl('p', {
			text: this.message,
			cls: ':uno: whitespace-pre-wrap',
		})
		new Setting(this.contentEl)
			.addButton((button) =>
				button
					.setButtonText(i18n.t('taskList.cancel'))
					.onClick(() => this.close()),
			)
			.addButton((button) =>
				button
					.setButtonText(this.confirmText)
					.setCta()
					.onClick(() => {
						this.accepted = true
						this.close()
					}),
			)
	}
	openAndWait(): Promise<boolean> {
		return new Promise((resolve) => {
			this.resolve = resolve
			this.open()
		})
	}
	onClose() {
		this.resolve?.(this.accepted)
		this.resolve = undefined
		this.contentEl.empty()
	}
}
