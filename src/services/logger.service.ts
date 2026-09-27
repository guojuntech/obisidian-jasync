import type { ConsolaReporter, LogObject } from 'consola'
import { moment } from 'obsidian'
import { IN_DEV } from '~/consts'
import logger from '~/utils/logger'
import { BaseService } from './service.interface'
import JASyncPlugin from '..'

export interface LogEntry {
	timestamp: string
	level: string
	args: unknown[]
}

export const MAX_LOG_ENTRIES = 2000

export default class LoggerService extends BaseService {
	logs: LogEntry[] = []
	droppedLogCount = 0

	constructor(plugin: JASyncPlugin) {
		super()
		void plugin
	}

	override onload() {
		const reporter: ConsolaReporter = {
			log: (logObj: LogObject) => {
				this.logs.push({
					timestamp: moment(logObj.date).format('YYYY-MM-DD HH:mm:ss'),
					level: logObj.type,
					args: logObj.args,
				})
				if (this.logs.length > MAX_LOG_ENTRIES) {
					const count = this.logs.length - MAX_LOG_ENTRIES
					this.logs.splice(0, count)
					this.droppedLogCount += count
				}
			},
		}
		if (IN_DEV) {
			// Keep default Consola console reporter; add ours alongside it.
			logger.addReporter(reporter)
		} else {
			logger.setReporters([reporter])
		}
	}

	clear() {
		this.logs = []
		this.droppedLogCount = 0
	}
}
