import { describe, expect, it } from 'vitest'
import { RemoteStorageFileSystem } from './remote-storage'
import { computeEffectiveFilterRulesFromParts } from '~/utils/config-dir-rules'
import { LEGACY_PLUGIN_ID } from '~/legacy-identity'
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
	it('excludes old private state and both generations of temporary files despite includes', async () => {
		const paths = [
			`/.obsidian/plugins/${LEGACY_PLUGIN_ID}/data.local.json`,
			`/.obsidian/plugins/${LEGACY_PLUGIN_ID}/cache/state.json`,
			'/.obsidian/plugins/jasync/recovery/run/note.md',
			`/note.md.${LEGACY_PLUGIN_ID}-123.download`,
			'/note.md.jasync-123.download',
			`/.${LEGACY_PLUGIN_ID}-internal/probes/123`,
			'/.jasync-internal/probes/123',
		]
		const result = await fs({
			scan: async () => ({ complete: true, entries: paths.map(file) }),
		}).walk()
		expect(result).toHaveLength(paths.length)
		expect(result.every((entry) => entry.ignored)).toBe(true)
	})
	it('keeps ignored credentials visible as ignored, not deleted', async () => {
		const result = await fs({
			scan: async () => ({
				complete: true,
				entries: [
					file('/note.md'),
					file('/.obsidian/plugins/jasync/data.local.json'),
					file('/.obsidian/plugins/jasync/data.json'),
				],
			}),
		}).walk()
		expect(result.map(({ stat, ignored }) => [stat.path, ignored])).toEqual([
			['note.md', false],
			['.obsidian/plugins/jasync/data.local.json', true],
			['.obsidian/plugins/jasync/data.json', true],
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
