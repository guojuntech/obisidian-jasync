import { App, Modal, Notice } from 'obsidian'
import JASyncPlugin from '..'

import { stdRemotePath } from '~/utils/std-remote-path'
import { mountWebDAVExplorer } from '../components/solid-js'

export default class SelectRemoteBaseDirModal extends Modal {
	constructor(
		app: App,
		private plugin: JASyncPlugin,
		private onConfirm: (path: string) => void | Promise<void>,
	) {
		super(app)
	}

	async onOpen() {
		const { contentEl } = this

		const explorer = createDiv()
		contentEl.appendChild(explorer)

		let session
		try {
			session = await this.plugin.createRemoteSession()
		} catch (error) {
			new Notice(error instanceof Error ? error.message : String(error))
			this.close()
			return
		}

		mountWebDAVExplorer(explorer, {
			readOnly: true,
			fs: {
				ls: (target: string) => session.storage.getDirectoryContents(target),
				mkdirs: (path: string) => session.storage.createDirectory(path),
			},
			onClose: () => {
				explorer.remove()
				this.close()
			},
			onConfirm: (path) => {
				void Promise.resolve(this.onConfirm(stdRemotePath(path))).then(() => {
					explorer.remove()
					this.close()
				})
			},
		})
	}

	onClose() {
		const { contentEl } = this
		contentEl.empty()
	}
}
