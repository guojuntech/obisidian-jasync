import { describe, expect, it } from 'vitest'
import { RemoteStorageFileSystem } from './remote-storage'
import { computeEffectiveFilterRulesFromParts } from '~/utils/config-dir-rules'
import type {
	RemoteScanner,
	RemoteSnapshot,
} from '~/remote-storage/remote-scanner.interface'

const file = (path: string) => ({
	path,
	basename: path.split('/').at(-1)!,
	size: 1,
	mtime: 1,
	isDir: false as const,
	isDeleted: false,
})
const fs = (scanner: RemoteScanner) =>
	new RemoteStorageFileSystem({
		scanner,
		remoteBaseDir: '/',
		filterRules: computeEffectiveFilterRulesFromParts('.obsidian', 'all', {
			rules: [
				{ type: 'include', expr: '**', options: { caseSensitive: true } },
			],
		}),
	})

describe('backend-neutral remote filesystem', () => {
	it('keeps ignored credentials visible as ignored, not deleted', async () => {
		const result = await fs({
			scan: async () => ({
				complete: true,
				entries: [
					file('/note.md'),
					file('/.obsidian/plugins/omni-sync/data.local.json'),
					file('/.obsidian/plugins/omni-sync/data.json'),
				],
			}),
		}).walk()
		expect(result.map(({ stat, ignored }) => [stat.path, ignored])).toEqual([
			['note.md', false],
			['.obsidian/plugins/omni-sync/data.local.json', true],
			['.obsidian/plugins/omni-sync/data.json', true],
		])
	})
	it('rejects failed and incomplete scans instead of supplying empty state', async () => {
		await expect(
			fs({
				scan: async () => {
					throw new Error('offline')
				},
			}).walk(),
		).rejects.toThrow('offline')
		await expect(
			fs({
				scan: async () =>
					({ complete: false, entries: [] }) as unknown as RemoteSnapshot,
			}).walk(),
		).rejects.toThrow('Incomplete')
	})
})
