import { existsLocalPath, readLocalBinary } from '~/utils/local-vault-io'
import { BaseTask, toTaskError } from './task.interface'

export default class PushTask extends BaseTask {
	async exec() {
		try {
			const exists = await existsLocalPath(this.vault, this.localPath)
			if (!exists) {
				throw new Error('cannot find file in local fs: ' + this.localPath)
			}

			const content = await readLocalBinary(this.vault, this.localPath)
			this.logger.info(
				`[PushTask] ${this.localPath} → ${this.remotePath} (${content.byteLength} bytes)`,
			)
			const res = await this.remoteStorage.putFileContents(
				this.remotePath,
				content,
				{
					mode: 'overwrite',
				},
			)
			if (!res.success) {
				throw new Error('Upload failed')
			}
			return { success: true } as const
		} catch (e) {
			this.logger.error(`[PushTask] failed: ${this.localPath}`, e)
			return { success: false, error: toTaskError(e, this) }
		}
	}
}
