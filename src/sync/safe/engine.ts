import { diff3Merge } from 'node-diff3'
import type RemoteStorage from '~/remote-storage/remote-storage.interface'
import type {
	RemoteStat,
	RemoteVersion,
} from '~/remote-storage/remote-storage.interface'
import { RemoteStorageError } from '~/remote-storage/errors'
import { validateRelativePath } from '~/remote-storage/paths'
import type { SyncPolicy } from '~/settings'
import { sha256Hex } from '~/utils/sha256'
import { isMergeablePath } from '~/sync/utils/is-mergeable-path'
import {
	chooseAction,
	type Baseline,
	type FileState,
	type LocalSyncIO,
	type PlanItem,
	type SyncPersistence,
	type SyncState,
	type SyncFileProgress,
} from './types'

export class PlanChangedError extends Error {
	constructor(path: string) {
		super(
			`File changed since preview: ${path}. Run JASync again to review a fresh plan.`,
		)
	}
}

export class SyncCancelledError extends Error {
	constructor() {
		super('Sync cancelled')
	}
}

export function textContent(data: ArrayBuffer): string | undefined {
	if (data.byteLength > 1024 * 1024) return undefined
	try {
		const text = new TextDecoder('utf-8', {
			fatal: true,
			ignoreBOM: true,
		}).decode(data)
		return text.includes('\0') ? undefined : text
	} catch {
		return undefined
	}
}

export class SafeSyncEngine {
	readonly run = crypto.randomUUID()
	private state!: SyncState
	private readonly planned = new Set<PlanItem>()
	constructor(
		private readonly options: {
			identity: string
			local: LocalSyncIO
			remote: RemoteStorage
			persistence: SyncPersistence
			checkCancelled: () => void
			chunkSize: number
		},
	) {}

	async plan(input: {
		local: Array<{
			path: string
			isDir: boolean
			ignored: boolean
			size?: number
		}>
		remote: RemoteStat[]
		include: (path: string) => boolean
		maxBytes: number
		policy: SyncPolicy
		strategy: string
		onProgress?: (progress: SyncFileProgress) => void
	}): Promise<PlanItem[]> {
		this.state = await this.options.persistence.load()
		if (
			this.state.format !== 2 ||
			this.state.identity !== this.options.identity
		)
			throw new Error('Sync history belongs to another target')
		const locals = new Map(input.local.map((file) => [file.path, file]))
		const remotes = new Map(
			input.remote.map((file) => [file.path.replace(/^\//, ''), file]),
		)
		const paths = new Set([
			...locals.keys(),
			...remotes.keys(),
			...Object.keys(this.state.records),
		])
		const aliases = new Map<string, string>()
		for (const path of paths) {
			if (!input.include(path)) continue
			validateRelativePath(path)
			const alias = path.normalize('NFC').toLowerCase()
			if (aliases.has(alias) && aliases.get(alias) !== path)
				throw new Error(
					`Ambiguous local/remote names: ${path} / ${aliases.get(alias)}`,
				)
			aliases.set(alias, path)
			if (
				locals.has(path) &&
				remotes.has(path) &&
				locals.get(path)!.isDir !== remotes.get(path)!.isDir
			)
				throw new Error(
					`File/folder collision: ${path}. Resolve the collision before syncing.`,
				)
		}
		const result: PlanItem[] = []
		this.planned.clear()
		const total = [...paths].filter(
			(path) =>
				!locals.get(path)?.ignored &&
				input.include(path) &&
				!locals.get(path)?.isDir &&
				!remotes.get(path)?.isDir,
		).length
		let completed = 0
		input.onProgress?.({ completed, total })
		for (const path of [...paths].sort()) {
			this.options.checkCancelled()
			const local = locals.get(path)
			const remote = remotes.get(path)
			if (local?.ignored || !input.include(path)) continue
			if (local?.isDir || remote?.isDir) {
				if (local && remote && local.isDir !== remote.isDir)
					result.push({
						path,
						action: 'skip',
						reason: 'File/folder name collision',
					})
				continue
			}
			input.onProgress?.({ completed, total, currentPath: path })
			if (
				(local?.size ?? 0) > input.maxBytes ||
				(remote?.size ?? 0) > input.maxBytes
			) {
				result.push({
					path,
					action: 'skip',
					reason: 'File exceeds configured size limit',
				})
				completed++
				continue
			}
			const localData = local ? await this.options.local.read(path) : undefined
			if (local && !localData) throw new PlanChangedError(path)
			const l = localData
				? { hash: await sha256Hex(localData), size: localData.byteLength }
				: undefined
			const record = Object.prototype.hasOwnProperty.call(
				this.state.records,
				path,
			)
				? this.state.records[path]
				: undefined
			let remoteData: ArrayBuffer | undefined
			let r: FileState | undefined
			if (remote) {
				if (!remote.version?.etag) throw new Error(`Missing S3 ETag: ${path}`)
				if (
					record?.version?.etag === remote.version.etag &&
					record.size === remote.size
				) {
					r = { hash: record.hash, size: remote.size, version: remote.version }
				} else {
					remoteData = await this.readRemote(path, {
						size: remote.size,
						hash: '',
						version: remote.version,
					})
					r = {
						hash: await sha256Hex(remoteData),
						size: remoteData.byteLength,
						version: remote.version,
					}
				}
			}
			const item: PlanItem = {
				path,
				local: l,
				remote: r,
				action: chooseAction(l?.hash, r?.hash, record?.hash, input.policy),
			}
			if (item.action === 'keep-both') {
				item.conflict = true
				if (input.strategy === 'local-priority') item.action = 'upload'
				else if (input.strategy === 'server-priority') item.action = 'download'
				else {
					if (record?.text !== undefined && isMergeablePath(path)) {
						remoteData ??= await this.readRemote(path, r!)
						const a = textContent(localData!),
							b = textContent(remoteData)
						if (a !== undefined && b !== undefined) {
							const regions = diff3Merge(
								a.split('\n'),
								record.text.split('\n'),
								b.split('\n'),
								{ excludeFalseConflicts: true },
							)
							if (regions.every((region) => region.ok)) {
								item.action = 'merge'
								item.mergedText = regions
									.flatMap((region) => region.ok ?? [])
									.join('\n')
							}
						}
					}
					if (item.action === 'keep-both') {
						const dot = path.lastIndexOf('.'),
							slash = path.lastIndexOf('/')
						const stem = dot > slash ? path.slice(0, dot) : path
						const extension = dot > slash ? path.slice(dot) : ''
						item.copyPath = `${stem}.conflict-${this.run}${extension}`
					}
				}
			}
			result.push(item)
			completed++
		}
		this.options.checkCancelled()
		input.onProgress?.({ completed, total })
		for (const item of result) this.planned.add(item)
		return result
	}

	/** Unchanged files with an existing common baseline need no history write. */
	needsBaselineRefresh(item: PlanItem): boolean {
		if (!this.planned.has(item)) throw new Error('Unapproved sync operation')
		if (item.action !== 'equal') return false
		const previous = Object.prototype.hasOwnProperty.call(
			this.state.records,
			item.path,
		)
			? this.state.records[item.path]
			: undefined
		if (!item.local && !item.remote) return previous !== undefined
		return !(
			previous &&
			item.local &&
			item.remote &&
			previous.hash === item.local.hash &&
			previous.hash === item.remote.hash &&
			previous.size === item.local.size &&
			previous.size === item.remote.size &&
			previous.version?.etag === item.remote.version?.etag &&
			// Listings may omit VersionId; absence is not evidence of a new version.
			(!item.remote.version?.versionId ||
				previous.version?.versionId === item.remote.version.versionId)
		)
	}

	/** Revalidate approved work before the first user-file mutation. */
	async validate(
		items: PlanItem[],
		onProgress?: (progress: SyncFileProgress) => void,
	): Promise<void> {
		const pending = items.filter((item) => {
			if (!this.planned.has(item)) throw new Error('Unapproved sync operation')
			return (
				item.action !== 'skip' &&
				(item.action !== 'equal' || this.needsBaselineRefresh(item))
			)
		})
		const total = pending.length
		let completed = 0
		onProgress?.({ completed, total })
		for (const item of pending) {
			this.options.checkCancelled()
			onProgress?.({ completed, total, currentPath: item.path })
			await this.verifyLocal(item.path, item.local)
			await this.verifyRemote(item.path, item.remote)
			if (item.copyPath) {
				await this.verifyLocal(item.copyPath, undefined)
				await this.verifyRemote(item.copyPath, undefined)
			}
			completed++
		}
		this.options.checkCancelled()
		onProgress?.({ completed, total })
	}

	async execute(item: PlanItem, allowUnconditional = false): Promise<void> {
		this.options.checkCancelled()
		if (!this.planned.has(item)) throw new Error('Unapproved sync operation')
		if (item.action === 'equal') {
			// Keeping the old baseline does not mark later edits as synchronized.
			// A new baseline still requires one fresh check of each side, but no
			// mutation, recovery backup or second pre-write validation is involved.
			if (!this.needsBaselineRefresh(item)) return
			const data = await this.verifyLocal(item.path, item.local)
			await this.verifyRemote(item.path, item.remote)
			this.options.checkCancelled()
			await this.commit(item.path, data, item.remote?.version)
			return
		}
		await this.validate([item])
		if (item.action === 'skip') return
		const { local, persistence, remote } = this.options
		const localData = item.local ? await local.read(item.path) : undefined
		if (
			item.local &&
			(!localData || (await sha256Hex(localData)) !== item.local.hash)
		)
			throw new PlanChangedError(item.path)
		let remoteData: ArrayBuffer | undefined
		// Capture recovery copies before any destructive step, even for a merge.
		if (item.remote) remoteData = await this.readRemote(item.path, item.remote)
		if (localData)
			await persistence.backup(this.run, item.path, 'local', localData)
		if (remoteData)
			await persistence.backup(this.run, item.path, 'remote', remoteData)
		await persistence.journal(this.run, item, 'pending')
		await this.validate([item])
		let data: ArrayBuffer | undefined
		this.options.checkCancelled()
		let version: RemoteVersion | undefined
		switch (item.action) {
			case 'upload':
				data = localData!
				version = await this.upload(
					item.path,
					data,
					item.remote,
					allowUnconditional,
				)
				break
			case 'download':
				data = remoteData!
				version = item.remote!.version
				await local.write(item.path, data, item.local?.hash)
				break
			case 'delete-local':
				await local.remove(item.path, item.local!.hash)
				break
			case 'delete-remote':
				await remote.deleteFile(`/${item.path}`, {
					expectedVersion: item.remote!.version,
					allowUnconditional,
				})
				break
			case 'merge':
				data = new TextEncoder().encode(item.mergedText).buffer
				version = await this.upload(
					item.path,
					data,
					item.remote,
					allowUnconditional,
				)
				this.options.checkCancelled()
				await local.write(item.path, data, item.local?.hash)
				break
			case 'keep-both': {
				const copyVersion = await this.upload(
					item.copyPath!,
					localData!,
					undefined,
					allowUnconditional,
				)
				this.options.checkCancelled()
				await local.write(item.copyPath!, localData!)
				await this.commit(item.copyPath!, localData, copyVersion)
				// A concurrent local edit must survive even if the conflict copy succeeded.
				await this.verifyRemote(item.path, item.remote)
				data = remoteData!
				version = item.remote!.version
				await local.write(item.path, data, item.local?.hash)
				break
			}
		}
		// Persist the transferred bytes, never a fresh local stat after an upload.
		await this.commit(item.path, data, version)
		await persistence.journal(this.run, item, 'complete')
	}

	private async commit(
		path: string,
		data?: ArrayBuffer,
		version?: RemoteVersion,
	) {
		const records = Object.assign(
			Object.create(null) as Record<string, Baseline>,
			this.state.records,
		)
		if (data) {
			const record: Baseline = {
				hash: await sha256Hex(data),
				size: data.byteLength,
				version,
			}
			if (isMergeablePath(path)) record.text = textContent(data)
			const previous = records[path]
			if (
				previous?.hash === record.hash &&
				previous.size === record.size &&
				previous.version?.etag === record.version?.etag &&
				previous.version?.versionId === record.version?.versionId &&
				previous.text === record.text
			)
				return
			records[path] = record
		} else {
			if (!Object.prototype.hasOwnProperty.call(records, path)) return
			delete records[path]
		}
		const next = { ...this.state, records }
		await this.options.persistence.save(next)
		this.state = next
	}

	private async upload(
		path: string,
		data: ArrayBuffer,
		expected: FileState | undefined,
		allowUnconditional: boolean,
	) {
		this.options.checkCancelled()
		await this.verifyRemote(path, expected)
		const receipt = await this.options.remote.putFileContents(
			`/${path}`,
			data,
			{
				mode: expected ? 'overwrite' : 'create',
				expectedVersion: expected?.version,
				allowUnconditional,
			},
		)
		if (!receipt.version?.etag)
			throw new Error(
				`Upload receipt is missing: ${path}. Rescan before retrying.`,
			)
		return receipt.version
	}

	private async verifyLocal(path: string, expected?: FileState) {
		const data = await this.options.local.read(path)
		if ((data ? await sha256Hex(data) : undefined) !== expected?.hash)
			throw new PlanChangedError(path)
		return data
	}

	private async verifyRemote(path: string, expected?: FileState) {
		let current: RemoteStat | undefined
		try {
			current = await this.options.remote.stat(`/${path}`)
		} catch (error) {
			if (!(error instanceof RemoteStorageError) || error.code !== 'not-found')
				throw error
		}
		if (
			current?.isDir ||
			Boolean(current) !== Boolean(expected) ||
			(current &&
				(!current.version?.etag ||
					current.version.etag !== expected?.version?.etag ||
					current.size !== expected.size))
		)
			throw new PlanChangedError(path)
	}

	private async readRemote(
		path: string,
		expected: FileState,
	): Promise<ArrayBuffer> {
		const chunks: Uint8Array[] = []
		const size = expected.size,
			chunkSize = this.options.chunkSize
		if (size <= chunkSize) {
			this.options.checkCancelled()
			const result = await this.options.remote.getFileContents(`/${path}`, {
				expectedVersion: expected.version,
			})
			if (result.data.byteLength !== size) throw new PlanChangedError(path)
			if (expected.hash && (await sha256Hex(result.data)) !== expected.hash)
				throw new PlanChangedError(path)
			return result.data
		}
		for (let start = 0; start < size; start += chunkSize) {
			this.options.checkCancelled()
			const end = Math.min(size, start + chunkSize) - 1
			const result = await this.options.remote.getFileContents(`/${path}`, {
				expectedVersion: expected.version,
				range: { start, end },
			})
			if (
				result.range?.start !== start ||
				result.range.end !== end ||
				result.range.total !== size ||
				result.data.byteLength !== end - start + 1
			)
				throw new PlanChangedError(path)
			chunks.push(new Uint8Array(result.data))
		}
		const data = new Uint8Array(size)
		let offset = 0
		for (const chunk of chunks) {
			data.set(chunk, offset)
			offset += chunk.byteLength
		}
		if (expected.hash && (await sha256Hex(data)) !== expected.hash)
			throw new PlanChangedError(path)
		return data.buffer
	}
}
