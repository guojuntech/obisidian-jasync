import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Vault } from 'obsidian'
import type JASyncPlugin from '~/index'
import type { RemoteSession } from '~/remote-storage/remote-session'
import { JASyncCoordinator, SyncStartMode } from './index'

const observed = vi.hoisted(() => ({
	modal: vi.fn(),
	localWalk: vi.fn(),
	get: vi.fn(),
	set: vi.fn(),
	unset: vi.fn(),
}))
vi.mock('obsidian', () => ({
	Notice: class {},
	Platform: {},
	normalizePath: (path: string) => path,
	TFile: class {},
	TFolder: class {},
}))
vi.mock('~/i18n', () => ({ default: { t: (key: string) => key } }))
vi.mock('~/settings', () => ({
	SyncMode: { LOOSE: 'loose', STRICT: 'strict' },
	SyncPolicy: {
		TwoWay: 'two-way',
		SendOnly: 'send-only',
		SendOnlyOverrideChanges: 'send-only-override-changes',
		ReceiveOnly: 'receive-only',
		ReceiveOnlyRevertLocalChanges: 'receive-only-revert-local-changes',
	},
}))
vi.mock('~/storage', () => ({
	syncRecordKV: { get: observed.get, set: observed.set, unset: observed.unset },
}))
vi.mock('~/storage/blob', () => ({
	blobStore: { get: vi.fn(), store: vi.fn() },
}))
vi.mock('~/fs/local-vault', () => ({
	LocalVaultFileSystem: class {
		walk = observed.localWalk
	},
}))
vi.mock('~/components/DeleteConfirmModal', () => ({ default: class {} }))
vi.mock('~/components/FailedTasksModal', () => ({ default: class {} }))
vi.mock('~/components/TaskListConfirmModal', () => ({
	default: class {
		constructor(
			_app: unknown,
			private tasks: unknown[],
			preview: boolean,
		) {
			observed.modal(tasks, preview)
		}
		openAndWait() {
			return Promise.resolve({ confirm: true, tasks: this.tasks })
		}
	},
}))

const stat = (path: string) => ({
	path,
	basename: path,
	size: 2,
	mtime: 1,
	isDir: false as const,
	isDeleted: false,
})

function fixture() {
	const vault = { configDir: '.obsidian', getName: () => 'test-vault' } as Vault
	const plugin = {
		app: { vault },
		settings: {
			filterRules: { rules: [] },
			configDirSyncMode: 'none',
			skipLargeFiles: { maxSize: '' },
			syncMode: 'strict',
			conflictStrategy: 'diff3',
		},
		localSettings: { syncPolicy: 'two-way' },
		progressService: { closeProgressModal: vi.fn() },
	} as unknown as JASyncPlugin
	const session = {
		mode: 'preview',
		identity: 'test',
		remoteBaseDir: '/',
		storage: {
			type: 'fake',
			exists: vi.fn(),
			createDirectory: vi.fn(),
			putFileContents: vi.fn(),
			getFileContents: vi.fn(),
			deleteFile: vi.fn(),
		},
		scanner: {
			scan: vi
				.fn()
				.mockResolvedValue({ complete: true, entries: [stat('/remote.md')] }),
		},
		cache: { restore: vi.fn(), save: vi.fn() },
	} as unknown as RemoteSession
	return {
		session,
		sync: new JASyncCoordinator(plugin, {
			vault,
			session,
			recordKey: 'test-records',
		}),
	}
}

beforeEach(() => {
	vi.clearAllMocks()
	observed.get.mockResolvedValue(new Map())
	observed.localWalk.mockResolvedValue([
		{ stat: stat('local.md'), ignored: false },
	])
})

describe('preview execution boundary', () => {
	it('runs scan → real decider → preview without mutations even if the dialog returns confirm', async () => {
		const { sync, session } = fixture()
		const result = await sync.start({ mode: SyncStartMode.MANUAL_SYNC })
		expect(result).toEqual({
			ended: true,
			ranTasks: false,
			shouldReloadSettings: false,
		})
		expect(observed.modal).toHaveBeenCalledWith(expect.any(Array), true)
		const tasks = observed.modal.mock.calls[0][0] as Array<{
			constructor: { name: string }
			options: { remoteStorage: unknown }
		}>
		expect(tasks.map((task) => task.constructor.name).sort()).toEqual([
			'PullTask',
			'PushTask',
		])
		expect(
			tasks.every((task) => task.options.remoteStorage === session.storage),
		).toBe(true)
		for (const method of [
			'exists',
			'createDirectory',
			'putFileContents',
			'getFileContents',
			'deleteFile',
		] as const)
			expect(session.storage[method]).not.toHaveBeenCalled()
		expect(session.cache!.restore).not.toHaveBeenCalled()
		expect(session.cache!.save).not.toHaveBeenCalled()
		expect(observed.set).not.toHaveBeenCalled()
		expect(observed.unset).not.toHaveBeenCalled()
	})

	it('does not show a plan or mutate records after a failed scan', async () => {
		const { sync, session } = fixture()
		vi.mocked(session.scanner.scan).mockRejectedValue(new Error('page failed'))
		const result = await sync.start({ mode: SyncStartMode.MANUAL_SYNC })
		expect(result.ranTasks).toBe(false)
		expect(observed.modal).not.toHaveBeenCalled()
		expect(observed.set).not.toHaveBeenCalled()
		expect(observed.unset).not.toHaveBeenCalled()
	})

	it('does not scan or execute an automatic preview', async () => {
		const { sync, session } = fixture()
		await sync.start({ mode: SyncStartMode.AUTO_SYNC })
		expect(session.scanner.scan).not.toHaveBeenCalled()
		expect(observed.modal).not.toHaveBeenCalled()
	})
})
