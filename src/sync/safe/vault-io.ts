import { TFile, type App, type Vault } from 'obsidian'
import { dirname } from 'path-browserify'
import { mkdirsVault } from '~/utils/mkdirs-vault'
import { sha256Hex } from '~/utils/sha256'
import { validateRelativePath } from '~/remote-storage/paths'
import { isAdapterPath, writeLocalBinary } from '~/utils/local-vault-io'
import { PlanChangedError, textContent } from './engine'
import type { LocalSyncIO, PlanItem, SyncPersistence, SyncState } from './types'

export class VaultSyncIO implements LocalSyncIO {
	constructor(
		private readonly vault: Vault,
		private readonly fileManager: App['fileManager'],
	) {}
	async read(path: string) {
		validateRelativePath(path)
		const stat = await this.vault.adapter.stat(path)
		if (!stat) return undefined
		if (stat.type !== 'file') throw new PlanChangedError(path)
		return this.vault.adapter.readBinary(path)
	}
	private async check(path: string, hash?: string) {
		const data = await this.read(path)
		if ((data ? await sha256Hex(data) : undefined) !== hash)
			throw new PlanChangedError(path)
		return data
	}
	async write(path: string, data: ArrayBuffer, expectedHash?: string) {
		validateRelativePath(path)
		await mkdirsVault(this.vault, dirname(path))
		const temp = `${path}.jasync-${crypto.randomUUID()}.download`
		try {
			await this.vault.adapter.writeBinary(temp, data)
			const staged = await this.vault.adapter.readBinary(temp)
			if ((await sha256Hex(staged)) !== (await sha256Hex(data)))
				throw new Error(`Staged download verification failed: ${path}`)
			const old = await this.check(path, expectedHash)
			const file = this.vault.getAbstractFileByPath(path)
			const oldText = old ? textContent(old) : undefined,
				nextText = textContent(staged)
			if (
				!isAdapterPath(this.vault, path) &&
				file instanceof TFile &&
				oldText !== undefined &&
				nextText !== undefined
			) {
				// Vault.process serializes text edits and validates the latest content.
				await this.vault.process(file, (current) => {
					if (current !== oldText) throw new PlanChangedError(path)
					return nextText
				})
			} else if (!old && !isAdapterPath(this.vault, path)) {
				await this.vault.createBinary(path, staged)
			} else {
				// Desktop adapter writes are atomic. Recovery copies protect adapters
				// without atomic replacement; never remove the original before a write.
				await writeLocalBinary(this.vault, path, staged)
			}
		} finally {
			if (await this.vault.adapter.exists(temp))
				await this.vault.adapter.remove(temp)
		}
	}
	async remove(path: string, expectedHash: string) {
		validateRelativePath(path)
		await this.check(path, expectedHash)
		const file = this.vault.getAbstractFileByPath(path)
		if (file instanceof TFile && !isAdapterPath(this.vault, path))
			await this.fileManager.trashFile(file)
		else await this.vault.adapter.remove(path)
	}
}

export class VaultSyncPersistence implements SyncPersistence {
	private readonly statePath: string
	constructor(
		private readonly vault: Vault,
		private readonly root: string,
		private readonly identity: string,
	) {
		this.statePath = `${root}/cache/sync-v2-${identity}.json`
	}
	async load(): Promise<SyncState> {
		if (!(await this.vault.adapter.exists(this.statePath)))
			return { format: 2, identity: this.identity, records: {} }
		const state = JSON.parse(
			await this.vault.adapter.read(this.statePath),
		) as SyncState
		if (
			state.format !== 2 ||
			state.identity !== this.identity ||
			!state.records ||
			typeof state.records !== 'object' ||
			Array.isArray(state.records)
		)
			throw new Error(
				'Invalid JASync history. Existing history has been preserved.',
			)
		for (const [path, record] of Object.entries(state.records)) {
			validateRelativePath(path)
			if (
				!record ||
				!/^[0-9a-f]{64}$/.test(record.hash) ||
				!Number.isSafeInteger(record.size) ||
				record.size < 0 ||
				(record.version !== undefined &&
					(!record.version || typeof record.version.etag !== 'string')) ||
				(record.text !== undefined && typeof record.text !== 'string')
			)
				throw new Error(
					'Corrupt JASync history. Existing history has been preserved.',
				)
			if (
				record.text !== undefined &&
				(await sha256Hex(new TextEncoder().encode(record.text))) !== record.hash
			)
				throw new Error(
					'Corrupt merge baseline. Existing history has been preserved.',
				)
		}
		return state
	}
	async save(state: SyncState) {
		await mkdirsVault(this.vault, dirname(this.statePath))
		await this.vault.adapter.write(this.statePath, JSON.stringify(state))
	}
	async backup(
		run: string,
		path: string,
		side: 'local' | 'remote',
		data: ArrayBuffer,
	) {
		const target = `${this.root}/recovery/${run}/${side}/${path}`
		await mkdirsVault(this.vault, dirname(target))
		await this.vault.adapter.writeBinary(target, data)
		if (
			(await sha256Hex(await this.vault.adapter.readBinary(target))) !==
			(await sha256Hex(data))
		)
			throw new Error(`Recovery backup verification failed: ${path}`)
	}
	async journal(run: string, item: PlanItem, status: 'pending' | 'complete') {
		const name = await sha256Hex(new TextEncoder().encode(item.path))
		const target = `${this.root}/recovery/${run}/journal/${name}.json`
		await mkdirsVault(this.vault, dirname(target))
		await this.vault.adapter.write(
			target,
			JSON.stringify(
				{
					target: this.identity,
					time: new Date().toISOString(),
					status,
					...item,
				},
				null,
				2,
			),
		)
	}
}
