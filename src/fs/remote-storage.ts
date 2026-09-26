import { isAbsolute, join, normalize } from 'path-browserify'
import type {
	RemoteScanner,
	RemoteScanProgress,
} from '~/remote-storage/remote-scanner.interface'
import type { EffectiveFilterRules } from '~/utils/config-dir-rules'
import { compileFilterRules, isPathIncluded } from '~/utils/glob-match'
import { isSub } from '~/utils/is-sub'
import { stdRemotePath } from '~/utils/std-remote-path'
import AbstractFileSystem from './fs.interface'
import completeLossDir from './utils/complete-loss-dir'

export class RemoteStorageFileSystem implements AbstractFileSystem {
	constructor(
		private readonly options: {
			scanner: RemoteScanner
			remoteBaseDir: string
			filterRules: EffectiveFilterRules
			onTraversalProgress?: (progress: RemoteScanProgress) => void
			throwIfCancelled?: () => void
		},
	) {}

	async walk() {
		this.options.throwIfCancelled?.()
		const snapshot = await this.options.scanner.scan({
			onProgress: this.options.onTraversalProgress,
			throwIfCancelled: this.options.throwIfCancelled,
		})
		this.options.throwIfCancelled?.()
		if (snapshot.complete !== true) {
			throw new Error('Incomplete remote scan')
		}
		const traversedStats = snapshot.entries

		if (traversedStats.length === 0) {
			return []
		}

		const base = normalizeRemotePath(stdRemotePath(this.options.remoteBaseDir))
		const statsByLocalPath = new Map<string, (typeof traversedStats)[number]>()
		for (const stat of traversedStats) {
			const absolutePath = normalizeRemotePath(
				isAbsolute(stat.path) ? stat.path : join(base, stat.path),
			)
			if (!isSub(base, absolutePath)) {
				continue
			}

			const localPath = absolutePath
				.slice(base === '/' ? 1 : base.length)
				.replace(/^\/+/, '')
			if (!statsByLocalPath.has(localPath)) {
				statsByLocalPath.set(localPath, { ...stat, path: localPath })
			}
		}
		const stats = [...statsByLocalPath.values()]

		const compiledRules = compileFilterRules(this.options.filterRules.rules)

		const includedStats = stats.filter((stat) =>
			isPathIncluded(stat.path, compiledRules, stat.isDir),
		)
		const completeStats = completeLossDir(stats, includedStats)
		const completeStatPaths = new Set(completeStats.map((s) => s.path))
		const results = stats.map((stat) => ({
			stat,
			ignored: !completeStatPaths.has(stat.path),
		}))
		return results
	}
}

function normalizeRemotePath(path: string): string {
	const normalized = normalize(path)
	return normalized.length > 1 && normalized.endsWith('/')
		? normalized.slice(0, -1)
		: normalized
}
