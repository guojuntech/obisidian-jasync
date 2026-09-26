import { BaseTask, toTaskError } from './task.interface'

export default class RemoveRemoteRecursivelyTask extends BaseTask {
	async exec() {
		try {
			const stat = await this.remoteStorage.stat(this.remotePath)
			if (stat.isDir) {
				await this.remoteStorage.deleteDirectoryRecursively(this.remotePath)
			} else {
				await this.remoteStorage.deleteFile(this.remotePath)
			}
			return { success: true } as const
		} catch (e) {
			this.logger.error(e)
			return { success: false, error: toTaskError(e, this) }
		}
	}
}
