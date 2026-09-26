import { expect, it, vi } from 'vitest'
import { TFile, type App, type Vault } from 'obsidian'
import { sha256Hex } from '~/utils/sha256'
import { bytes, text } from '../../../test/s3-fixture'
import { VaultSyncIO, VaultSyncPersistence } from './vault-io'

vi.mock('obsidian', () => ({
	TFile: class {
		path = 'note.md'
	},
	normalizePath: (path: string) => path,
}))

function fixture() {
	const files = new Map<string, ArrayBuffer>([['note.md', bytes('old')]])
	const folders = new Set([
		'.obsidian',
		'.obsidian/plugins',
		'.obsidian/plugins/omni-sync',
	])
	const write = vi.fn(async (path: string, data: ArrayBuffer) => {
		files.set(path, data.slice(0))
	})
	const adapter = {
		stat: async (path: string) =>
			files.has(path)
				? { type: 'file' }
				: folders.has(path)
					? { type: 'folder' }
					: null,
		exists: async (path: string) => files.has(path) || folders.has(path),
		mkdir: async (path: string) => {
			folders.add(path)
		},
		readBinary: async (path: string) => files.get(path)!.slice(0),
		writeBinary: write,
		read: async (path: string) => text(files.get(path)!),
		write: async (path: string, data: string) => {
			files.set(path, bytes(data))
		},
		remove: vi.fn(async (path: string) => {
			files.delete(path)
		}),
	}
	const vault = {
		configDir: '.obsidian',
		adapter,
		getAbstractFileByPath: (path: string) =>
			files.has(path) ? Object.assign(new TFile(), { path }) : null,
		process: vi.fn(async (file: TFile, change: (value: string) => string) => {
			files.set(file.path, bytes(change(text(files.get(file.path)!))))
		}),
		createBinary: vi.fn(async (path: string, data: ArrayBuffer) => {
			if (files.has(path)) throw new Error('Already exists')
			await write(path, data)
		}),
		createFolder: async (path: string) => {
			folders.add(path)
		},
	}
	const fileManager = {
		trashFile: vi.fn(async (file: TFile) => {
			files.delete(file.path)
		}),
	}
	return {
		files,
		vault,
		adapter,
		fileManager,
		io: new VaultSyncIO(
			vault as unknown as Vault,
			fileManager as unknown as App['fileManager'],
		),
		persistence: new VaultSyncPersistence(
			vault as unknown as Vault,
			'.obsidian/plugins/omni-sync',
			'target',
		),
	}
}

it('verifies the staged download and updates text through Vault.process', async () => {
	const f = fixture()
	await f.io.write('note.md', bytes('new'), await sha256Hex(bytes('old')))
	expect(text(f.files.get('note.md')!)).toBe('new')
	expect(f.vault.process).toHaveBeenCalledOnce()
	expect([...f.files.keys()]).toEqual(['note.md'])
})

it('keeps the original if staging fails or returns corrupt data', async () => {
	const f = fixture()
	f.adapter.writeBinary.mockImplementationOnce(async (path) => {
		f.files.set(path, bytes('corrupt'))
	})
	await expect(
		f.io.write('note.md', bytes('new'), await sha256Hex(bytes('old'))),
	).rejects.toThrow('verification failed')
	expect(text(f.files.get('note.md')!)).toBe('old')
	expect([...f.files.keys()]).toEqual(['note.md'])
})

it('preserves an edit made between the precheck and the serialized text update', async () => {
	const f = fixture()
	f.vault.process.mockImplementationOnce(async (file, change) => {
		f.files.set(file.path, bytes('user edit'))
		change('user edit')
	})
	await expect(
		f.io.write('note.md', bytes('new'), await sha256Hex(bytes('old'))),
	).rejects.toThrow('changed since preview')
	expect(text(f.files.get('note.md')!)).toBe('user edit')
})

it('does not overwrite a new file that appeared after the absence check', async () => {
	const f = fixture()
	f.vault.createBinary.mockImplementationOnce(async (path) => {
		f.files.set(path, bytes('user file'))
		throw new Error('Already exists')
	})
	await expect(f.io.write('new.md', bytes('download'))).rejects.toThrow(
		'Already exists',
	)
	expect(text(f.files.get('new.md')!)).toBe('user file')
})

it('only trashes the approved file and refuses changed content', async () => {
	const f = fixture()
	await expect(f.io.remove('note.md', 'wrong')).rejects.toThrow(
		'changed since preview',
	)
	expect(f.fileManager.trashFile).not.toHaveBeenCalled()
	await f.io.remove('note.md', await sha256Hex(bytes('old')))
	expect(f.fileManager.trashFile).toHaveBeenCalledOnce()
})

it('preserves malformed history and rejects unsafe paths and corrupt merge bases', async () => {
	const f = fixture()
	const path = '.obsidian/plugins/omni-sync/cache/sync-v2-target.json'
	f.files.set(path, bytes('{broken'))
	await expect(f.persistence.load()).rejects.toThrow()
	expect(text(f.files.get(path)!)).toBe('{broken')
	f.files.set(
		path,
		bytes(
			JSON.stringify({
				format: 2,
				identity: 'target',
				records: {
					'../outside.md': { hash: await sha256Hex(bytes('old')), size: 3 },
				},
			}),
		),
	)
	await expect(f.persistence.load()).rejects.toThrow('represented safely')
	f.files.set(
		path,
		bytes(
			JSON.stringify({
				format: 2,
				identity: 'target',
				records: {
					'note.md': {
						hash: await sha256Hex(bytes('old')),
						size: 3,
						text: 'corrupt',
					},
				},
			}),
		),
	)
	await expect(f.persistence.load()).rejects.toThrow('merge baseline')
	await expect(f.io.write('../outside.md', bytes('bad'))).rejects.toThrow(
		'represented safely',
	)
})
