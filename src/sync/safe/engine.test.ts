import { describe, expect, it, vi } from 'vitest'
import { S3RemoteStorage } from '~/remote-storage/s3/s3-storage'
import { DEFAULT_S3_SETTINGS } from '~/remote-storage/s3/settings'
import type { SyncPolicy } from '~/settings'
import { sha256Hex } from '~/utils/sha256'
import { S3Fixture, bytes, text } from '../../../test/s3-fixture'
import { SafeSyncEngine, SyncCancelledError } from './engine'
import {
	chooseAction,
	type LocalSyncIO,
	type SyncPersistence,
	type SyncState,
} from './types'

async function fixture() {
	const cloud = new S3Fixture()
	const remote = new S3RemoteStorage(
		{
			...DEFAULT_S3_SETTINGS,
			endpoint: 'https://storage.example.test',
			bucket: 'test-bucket',
			prefix: 'notes/MyNotes/',
			accessKeyId: 'key',
			secretAccessKey: 'secret',
		},
		cloud.transport,
	)
	const files = new Map<string, ArrayBuffer>()
	let state: SyncState = { format: 2, identity: 'target', records: {} }
	let cancelled = false
	const check = async (path: string, hash?: string) => {
		const data = files.get(path)
		if ((data ? await sha256Hex(data) : undefined) !== hash)
			throw new Error('Local edit detected')
	}
	const local: LocalSyncIO = {
		read: vi.fn(async (path) => files.get(path)?.slice(0)),
		write: vi.fn(async (path, data, hash) => {
			await check(path, hash)
			files.set(path, data.slice(0))
		}),
		remove: vi.fn(async (path, hash) => {
			await check(path, hash)
			files.delete(path)
		}),
	}
	const backups = new Map<string, ArrayBuffer>()
	const persistence: SyncPersistence = {
		load: async () => structuredClone(state),
		save: vi.fn(async (next) => {
			state = structuredClone(next)
		}),
		backup: vi.fn(async (_run, path, side, data) => {
			backups.set(`${side}/${path}`, data.slice(0))
		}),
		journal: vi.fn(async () => {}),
	}
	const engine = new SafeSyncEngine({
		identity: 'target',
		local,
		remote,
		persistence,
		checkCancelled: () => {
			if (cancelled) throw new SyncCancelledError()
		},
		chunkSize: 4,
	})
	const plan = async (
		policy = 'two-way',
		strategy = 'no-conflict-merge',
		include = (_path: string) => true,
	) =>
		engine.plan({
			local: [...files].map(([path, data]) => ({
				path,
				isDir: false,
				ignored: false,
				size: data.byteLength,
			})),
			remote: await remote.scanEntries(),
			include,
			maxBytes: 1024 * 1024,
			policy: policy as SyncPolicy,
			strategy,
		})
	await remote.verifyMutationSupport()
	return {
		cloud,
		remote,
		files,
		local,
		engine,
		plan,
		backups,
		persistence,
		state: () => state,
		cancel: () => {
			cancelled = true
		},
		put: (path: string, value: string) =>
			cloud.objects.set(`notes/MyNotes/${path}`, bytes(value)),
		get: (path: string) => cloud.objects.get(`notes/MyNotes/${path}`),
	}
}

describe('complete S3 sync execution', () => {
	it('needs only one listing and one local read per file for an unchanged vault', async () => {
		const f = await fixture()
		for (let index = 0; index < 20; index++) {
			f.files.set(`${index}.md`, bytes('memo'))
			f.put(`${index}.md`, 'memo')
		}
		for (const item of await f.plan()) await f.engine.execute(item)
		const baseline = structuredClone(f.state())
		f.cloud.requests.length = 0
		vi.mocked(f.local.read).mockClear()
		vi.mocked(f.persistence.save).mockClear()
		const plan = await f.plan()
		expect(plan.every((item) => item.action === 'equal')).toBe(true)
		expect(plan.some((item) => f.engine.needsBaselineRefresh(item))).toBe(false)
		await f.engine.validate(plan)
		for (const item of plan) await f.engine.execute(item)
		expect(f.cloud.requests).toHaveLength(1)
		expect(new URL(f.cloud.requests[0].url).searchParams.get('list-type')).toBe(
			'2',
		)
		expect(f.local.read).toHaveBeenCalledTimes(20)
		expect(f.persistence.save).not.toHaveBeenCalled()
		expect(f.state()).toEqual(baseline)
	})

	it('checks each side once to establish a new common baseline', async () => {
		const f = await fixture()
		f.files.set('note.md', bytes('memo'))
		f.put('note.md', 'memo')
		const [item] = await f.plan()
		expect(f.engine.needsBaselineRefresh(item)).toBe(true)
		f.cloud.requests.length = 0
		vi.mocked(f.local.read).mockClear()
		await f.engine.execute(item)
		expect(f.cloud.requests.map((request) => request.method)).toEqual(['HEAD'])
		expect(f.local.read).toHaveBeenCalledTimes(1)
		expect(f.state().records['note.md'].text).toBe('memo')
		expect(f.persistence.backup).not.toHaveBeenCalled()
		expect(f.persistence.journal).not.toHaveBeenCalled()
	})

	it.each(['local', 'remote'])(
		'rejects a stale new baseline after a %s edit',
		async (side) => {
			const f = await fixture()
			f.files.set('note.md', bytes('memo'))
			f.put('note.md', 'memo')
			const [item] = await f.plan()
			if (side === 'local') f.files.set('note.md', bytes('edit'))
			else f.put('note.md', 'edit')
			await expect(f.engine.execute(item)).rejects.toThrow(
				'changed since preview',
			)
			expect(f.persistence.save).not.toHaveBeenCalled()
		},
	)

	it.each(['local', 'remote'])(
		'retains the baseline so a late %s edit is detected on the next scan',
		async (side) => {
			const f = await fixture()
			f.files.set('note.md', bytes('memo'))
			f.put('note.md', 'memo')
			await f.engine.execute((await f.plan())[0])
			const baseline = structuredClone(f.state())
			const [item] = await f.plan()
			if (side === 'local') f.files.set('note.md', bytes('edit'))
			else f.put('note.md', 'edit')
			vi.mocked(f.persistence.save).mockClear()
			f.cloud.requests.length = 0
			await f.engine.execute(item)
			expect(f.cloud.requests).toHaveLength(0)
			expect(f.persistence.save).not.toHaveBeenCalled()
			expect(f.state()).toEqual(baseline)
			expect((await f.plan())[0].action).toBe(
				side === 'local' ? 'upload' : 'download',
			)
		},
	)

	it('refreshes an equal pair that changed together and clears history only after both deletions are checked', async () => {
		const f = await fixture()
		f.files.set('note.md', bytes('base'))
		f.put('note.md', 'base')
		await f.engine.execute((await f.plan())[0])
		f.files.set('note.md', bytes('next'))
		f.put('note.md', 'next')
		let [item] = await f.plan()
		expect(f.engine.needsBaselineRefresh(item)).toBe(true)
		await f.engine.execute(item)
		expect(f.state().records['note.md'].text).toBe('next')
		f.files.delete('note.md')
		f.cloud.objects.delete('notes/MyNotes/note.md')
		;[item] = await f.plan()
		expect(f.engine.needsBaselineRefresh(item)).toBe(true)
		await f.engine.execute(item)
		expect(f.state().records['note.md']).toBeUndefined()
	})

	it('preserves a recorded VersionId when the listing only returns an unchanged ETag', async () => {
		const f = await fixture()
		f.files.set('note.md', bytes('memo'))
		f.put('note.md', 'memo')
		await f.engine.execute((await f.plan())[0])
		f.state().records['note.md'].version!.versionId = 'recorded-version'
		const [item] = await f.plan()
		expect(item.remote?.version?.versionId).toBeUndefined()
		expect(f.engine.needsBaselineRefresh(item)).toBe(false)
		await f.engine.execute(item)
		expect(f.state().records['note.md'].version?.versionId).toBe(
			'recorded-version',
		)
	})

	it('does not save a new baseline when cancelled during its remote check', async () => {
		const f = await fixture()
		f.files.set('note.md', bytes('memo'))
		f.put('note.md', 'memo')
		const [item] = await f.plan()
		f.cloud.fail = (request) => {
			if (request.method === 'HEAD') f.cancel()
			return undefined
		}
		await expect(f.engine.execute(item)).rejects.toThrow('cancelled')
		expect(f.persistence.save).not.toHaveBeenCalled()
	})

	it('reports content comparison and preflight progress over included files', async () => {
		const f = await fixture()
		f.files.set('a.md', bytes('a'))
		f.files.set('b.md', bytes('b'))
		const onProgress = vi.fn()
		const plan = await f.engine.plan({
			local: ['a.md', 'b.md', 'ignored.md', 'folder'].map((path) => ({
				path,
				isDir: path === 'folder',
				ignored: path === 'ignored.md',
				size: 1,
			})),
			remote: [],
			include: () => true,
			maxBytes: 1024,
			policy: 'two-way' as SyncPolicy,
			strategy: 'no-conflict-merge',
			onProgress,
		})
		const expected = [
			[{ completed: 0, total: 2 }],
			[{ completed: 0, total: 2, currentPath: 'a.md' }],
			[{ completed: 1, total: 2, currentPath: 'b.md' }],
			[{ completed: 2, total: 2 }],
		]
		expect(onProgress.mock.calls).toEqual(expected)
		onProgress.mockClear()
		await f.engine.validate(plan, onProgress)
		expect(onProgress.mock.calls).toEqual(expected)
	})

	it('does not report completed preflight when a preview becomes stale', async () => {
		const f = await fixture()
		f.files.set('a.md', bytes('a'))
		const plan = await f.plan()
		f.files.set('a.md', bytes('edited while preview was open'))
		const onProgress = vi.fn()
		await expect(f.engine.validate(plan, onProgress)).rejects.toThrow(
			'File changed since preview',
		)
		expect(onProgress.mock.calls).toEqual([
			[{ completed: 0, total: 1 }],
			[{ completed: 0, total: 1, currentPath: 'a.md' }],
		])
	})

	it('does not advance history when an actual file PUT returns 304', async () => {
		const f = await fixture()
		f.files.set('note.md', bytes('local content'))
		const [item] = await f.plan()
		f.cloud.fail = (request, key) =>
			request.method === 'PUT' && key.endsWith('/note.md')
				? f.cloud.response(undefined, 304)
				: undefined
		await expect(f.engine.execute(item)).rejects.toMatchObject({ status: 304 })
		expect(f.get('note.md')).toBeUndefined()
		expect(text(f.files.get('note.md')!)).toBe('local content')
		expect(f.state().records['note.md']).toBeUndefined()
		expect(f.persistence.journal).toHaveBeenCalledWith(
			f.engine.run,
			item,
			'pending',
		)
		expect(f.persistence.journal).not.toHaveBeenCalledWith(
			f.engine.run,
			item,
			'complete',
		)
	})
	it('round trips uploads, downloads, Unicode, empty files and later deletions', async () => {
		const f = await fixture()
		f.files.set('folder/中文.md', bytes('hello local'))
		f.files.set('empty.md', bytes(''))
		f.put('remote.md', 'hello remote')
		let plan = await f.plan()
		expect(plan.map((item) => item.action)).toEqual([
			'upload',
			'upload',
			'download',
		])
		await f.engine.validate(plan)
		for (const item of plan) await f.engine.execute(item)
		expect(text(f.get('folder/中文.md')!)).toBe('hello local')
		expect(text(f.files.get('remote.md')!)).toBe('hello remote')
		expect(f.get('empty.md')!.byteLength).toBe(0)
		expect((await f.plan()).every((item) => item.action === 'equal')).toBe(true)
		f.files.delete('folder/中文.md')
		f.cloud.objects.delete('notes/MyNotes/remote.md')
		plan = await f.plan()
		for (const item of plan) await f.engine.execute(item)
		expect(f.get('folder/中文.md')).toBeUndefined()
		expect(f.files.has('remote.md')).toBe(false)
		expect(text(f.backups.get('remote/folder/中文.md')!)).toBe('hello local')
		expect(text(f.backups.get('local/remote.md')!)).toBe('hello remote')
	})

	it('treats equal-size differing files as conflicts and preserves both without a base', async () => {
		const f = await fixture()
		f.files.set('note.md', bytes('LOCAL'))
		f.put('note.md', 'CLOUD')
		const [item] = await f.plan()
		expect(item.action).toBe('keep-both')
		await f.engine.execute(item)
		expect(text(f.files.get('note.md')!)).toBe('CLOUD')
		expect(text(f.files.get(item.copyPath!)!)).toBe('LOCAL')
		expect(text(f.get(item.copyPath!)!)).toBe('LOCAL')
		expect((await f.plan()).every((item) => item.action === 'equal')).toBe(true)
	})

	it('merges independent edits only with a verified shared base', async () => {
		const f = await fixture()
		f.files.set('note.md', bytes('a\nb\nc'))
		f.put('note.md', 'a\nb\nc')
		await f.engine.execute((await f.plan())[0])
		f.files.set('note.md', bytes('A\nb\nc'))
		f.put('note.md', 'a\nb\nC')
		const [item] = await f.plan()
		expect(item.action).toBe('merge')
		await f.engine.execute(item)
		expect(text(f.files.get('note.md')!)).toBe('A\nb\nC')
		expect(text(f.get('note.md')!)).toBe('A\nb\nC')
	})

	it.each(['local', 'remote'])(
		'refuses a stale %s plan before writes',
		async (side) => {
			const f = await fixture()
			f.files.set('note.md', bytes('local'))
			f.put('note.md', 'remote')
			const [item] = await f.plan('two-way', 'local-priority')
			if (side === 'local') f.files.set('note.md', bytes('edited'))
			else f.put('note.md', 'edited')
			await expect(f.engine.execute(item)).rejects.toThrow(
				'changed since preview',
			)
			expect(f.persistence.save).not.toHaveBeenCalled()
		},
	)

	it('records transferred content, not edits made during an upload', async () => {
		const f = await fixture()
		f.files.set('note.md', bytes('first'))
		const [item] = await f.plan()
		f.cloud.afterWrite = (key) => {
			if (key.endsWith('/note.md')) f.files.set('note.md', bytes('second'))
		}
		await f.engine.execute(item)
		expect(f.state().records['note.md'].hash).toBe(
			await sha256Hex(bytes('first')),
		)
		expect((await f.plan())[0].action).toBe('upload')
	})

	it('never expands a selected file deletion into a prefix deletion', async () => {
		const f = await fixture()
		f.put('folder/a.md', 'a')
		f.put('folder/b.md', 'b')
		const plan = await f.plan('send-only-override-changes')
		await f.engine.execute(plan.find((item) => item.path === 'folder/a.md')!)
		expect(f.get('folder/a.md')).toBeUndefined()
		expect(text(f.get('folder/b.md')!)).toBe('b')
	})

	it('preserves files and baseline if backup persistence fails', async () => {
		const f = await fixture()
		f.files.set('note.md', bytes('local'))
		f.put('note.md', 'remote')
		const [item] = await f.plan('two-way', 'local-priority')
		vi.mocked(f.persistence.backup).mockRejectedValue(new Error('disk full'))
		await expect(f.engine.execute(item)).rejects.toThrow('disk full')
		expect(text(f.get('note.md')!)).toBe('remote')
		expect(f.persistence.save).not.toHaveBeenCalled()
	})

	it('retains backups and old baseline when record persistence fails after a transfer', async () => {
		const f = await fixture()
		f.files.set('note.md', bytes('local'))
		f.put('note.md', 'remote')
		const [item] = await f.plan('two-way', 'local-priority')
		vi.mocked(f.persistence.save).mockRejectedValue(
			new Error('database unavailable'),
		)
		await expect(f.engine.execute(item)).rejects.toThrow('database unavailable')
		expect(text(f.get('note.md')!)).toBe('local')
		expect(text(f.backups.get('remote/note.md')!)).toBe('remote')
		expect(f.state().records).toEqual({})
		expect(f.persistence.journal).not.toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			'complete',
		)
	})

	it('cancels without updating files or records', async () => {
		const f = await fixture()
		f.files.set('note.md', bytes('local'))
		const [item] = await f.plan()
		f.cancel()
		await expect(f.engine.execute(item)).rejects.toThrow('cancelled')
		expect(f.get('note.md')).toBeUndefined()
		expect(f.persistence.save).not.toHaveBeenCalled()
	})

	it('rejects a changed object between range requests without touching the destination', async () => {
		const f = await fixture()
		f.files.set('note.md', bytes('original'))
		f.put('note.md', 'long remote text')
		let reads = 0
		f.cloud.fail = (request, key) => {
			if (
				request.method === 'GET' &&
				request.headers.range &&
				key.endsWith('note.md') &&
				++reads === 2
			)
				f.put('note.md', 'concurrent edit!')
			return undefined
		}
		await expect(f.plan()).rejects.toThrow('412')
		expect(text(f.files.get('note.md')!)).toBe('original')
	})

	it('does not propagate a filtered path as a deletion', async () => {
		const f = await fixture()
		f.files.set('hidden.md', bytes('same'))
		f.put('hidden.md', 'same')
		await f.engine.execute((await f.plan())[0])
		f.files.delete('hidden.md')
		expect(await f.plan('two-way', 'no-conflict-merge', () => false)).toEqual(
			[],
		)
		expect(f.get('hidden.md')).toBeDefined()
	})

	it('preserves changed content when the other side deleted its old copy', async () => {
		const f = await fixture()
		f.files.set('note.md', bytes('base'))
		f.put('note.md', 'base')
		await f.engine.execute((await f.plan())[0])
		f.files.delete('note.md')
		f.put('note.md', 'changed')
		const [item] = await f.plan()
		expect(item.action).toBe('download')
		await f.engine.execute(item)
		expect(text(f.files.get('note.md')!)).toBe('changed')
	})
})

describe('sync policy directions', () => {
	it.each([
		['send-only', undefined, 'base', 'base', 'delete-remote'],
		['receive-only', 'base', undefined, 'base', 'delete-local'],
		['send-only', undefined, 'changed', 'base', 'skip'],
		['receive-only', 'changed', undefined, 'base', 'skip'],
		['send-only', 'changed', undefined, 'base', 'skip'],
		['receive-only', undefined, 'changed', 'base', 'skip'],
		['send-only', 'changed', 'base', 'base', 'upload'],
		['receive-only', 'base', 'changed', 'base', 'download'],
		['send-only', 'local', 'changed', 'base', 'skip'],
		['send-only', 'local', undefined, undefined, 'upload'],
		['receive-only', 'changed', 'remote', 'base', 'skip'],
		['receive-only', undefined, 'remote', undefined, 'download'],
		[
			'send-only-override-changes',
			undefined,
			'remote',
			undefined,
			'delete-remote',
		],
		[
			'receive-only-revert-local-changes',
			'local',
			undefined,
			undefined,
			'delete-local',
		],
		['two-way', undefined, 'base', 'base', 'delete-remote'],
		['two-way', 'base', undefined, 'base', 'delete-local'],
	])(
		'%s compares content and history',
		(policy, local, remote, base, action) => {
			expect(chooseAction(local, remote, base, policy as SyncPolicy)).toBe(
				action,
			)
		},
	)
})
