import { BaseTask, toTaskError } from './task.interface'

export default class RemoveRemoteTask extends BaseTask {
	async exec() {
		try {
			this.logger.info(`[RemoveRemote] ${this.remotePath}`)
			await this.remoteStorage.deleteFile(this.remotePath)
			return { success: true } as const
		} catch (e) {
			this.logger.error(`[RemoveRemote] failed: ${this.remotePath}`, e)
			return { success: false, error: toTaskError(e, this) }
		}
	}
}
