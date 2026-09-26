import { type App, TFile } from 'obsidian'
import type JASyncPlugin from '~/index'
import type { SyncPolicy } from '~/settings'
import type { SyncStartMode } from '~/sync'
import type { S3HttpRequest, S3Transport } from '~/remote-storage/s3/transport'
import { S3Fixture, bytes, text } from '../../s3-fixture'
import { assert } from './assert'

const delay = (ms: number) =>
	new Promise((resolve) => window.setTimeout(resolve, ms))

async function button(pattern: RegExp): Promise<HTMLButtonElement> {
	const deadline = Date.now() + 8000
	while (Date.now() < deadline) {
		const found = Array.from(
			document.querySelectorAll<HTMLButtonElement>('.modal button'),
		).find((element) => pattern.test(element.textContent ?? ''))
		if (found) return found
		await delay(25)
	}
	throw new Error(
		`Missing modal button: ${pattern}; ${document.querySelector('.modal')?.textContent}`,
	)
}

/** Exercises the installed production bundle, real modal, Vault and record IO. */
export async function executesS3Sync(app: App) {
	const plugin = (
		app as unknown as { plugins: { plugins: Record<string, JASyncPlugin> } }
	).plugins.plugins['jasync']
	assert(plugin, 'JASync not loaded')
	const originalSettings = plugin.settings
	const originalLocal = plugin.localSettings
	const originalFactory = plugin.createRemoteSession
	const cloud = new S3Fixture()
	let inspectRequest: ((request: S3HttpRequest) => Promise<void>) | undefined
	const root = 'e2e-sync'
	await app.vault.createFolder(root)
	const note = await app.vault.create(`${root}/中文.md`, 'first')
	const unchecked = await app.vault.create(`${root}/unchecked.md`, 'keep local')
	cloud.objects.set(`vault/${root}/cloud.md`, bytes('from cloud'))
	plugin.settings = {
		...plugin.settings,
		realtimeSync: false,
		startupSyncDelaySeconds: 0,
		autoSyncIntervalSeconds: 0,
		configDirSyncMode: 'none',
		filterRules: {
			rules: [
				{ expr: '*', type: 'exclude', options: { caseSensitive: true } },
				{ expr: `/${root}`, type: 'include', options: { caseSensitive: true } },
				{
					expr: `/${root}/**`,
					type: 'include',
					options: { caseSensitive: true },
				},
			],
		},
	}
	plugin.localSettings = {
		...plugin.localSettings,
		vaultId: 'e2e-safe-sync',
		syncPolicy: 'two-way' as SyncPolicy,
		s3: {
			...plugin.localSettings.s3,
			endpoint: 'https://storage.example.test',
			region: 'us-east-1',
			bucket: 'test-bucket',
			prefix: 'vault/',
			accessKeyId: 'test',
			secretAccessKey: 'test',
			forcePathStyle: false,
		},
	}
	plugin.createRemoteSession = async () => {
		const session = await originalFactory.call(plugin)
		;(session.storage as unknown as { transport: S3Transport }).transport =
			async (request) => {
				await inspectRequest?.(request)
				return cloud.transport(request)
			}
		return session
	}
	const start = (automatic = false) =>
		plugin.syncExecutorService.executeSync({
			mode: (automatic ? 'auto_sync' : 'manual_sync') as SyncStartMode,
		})
	const approve = async () => {
		;(await button(/Confirm and sync|确认并同步/)).click()
	}
	try {
		const assertProgress = (phase: string) => {
			assert(
				plugin.progressService.preparationProgress?.phase === phase,
				`Expected progress for ${phase}`,
			)
			plugin.progressService.updateModal.flush()
			const modal = document.querySelector('.modal.jasync-progress-modal')
			assert(modal, `Progress disappeared during ${phase}`)
			assert(
				modal.querySelector('.jasync-progress__status-icon--preparing'),
				`Preparation state missing during ${phase}`,
			)
			assert(
				modal.querySelector('.jasync-progress__title-text')?.textContent,
				`Stage title missing during ${phase}`,
			)
			const bar = modal.querySelector<HTMLElement>('.jasync-progress__bar')
			const files = plugin.progressService.preparationProgress?.files
			const width =
				files && files.total > 0
					? `${Math.round((files.completed / files.total) * 100)}%`
					: '40%'
			assert(
				bar?.style.width === width,
				`Stage progress bar is incorrect during ${phase}`,
			)
			const content = modal.querySelector<HTMLElement>('.jasync-progress')
			assert(
				content && getComputedStyle(content).minHeight === '0px',
				'Preparation window retains empty file-list space',
			)
			return modal
		}
		let analyzed = false
		inspectRequest = async (request) => {
			if (request.method === 'GET' && request.url.includes('cloud.md')) {
				assertProgress('analyzing')
				assert(
					plugin.progressService.preparationProgress?.files?.currentPath ===
						`${root}/cloud.md`,
					'File being compared is missing from progress',
				)
				analyzed = true
			}
		}
		// Closing the preview must not send even capability probes or save a baseline.
		let running = start()
		await button(/Confirm and sync|确认并同步/)
		;(await button(/^Cancel$|^取消$/)).click()
		assert(!(await running), 'Cancelled preview reported success')
		assert(analyzed, 'The plan did not report content comparison progress')
		assert(
			!cloud.requests.some((request) =>
				['PUT', 'DELETE'].includes(request.method),
			),
			'Cancellation mutated S3',
		)
		assert(
			!(await app.vault.adapter.exists(`${root}/cloud.md`)),
			'Cancellation downloaded a file',
		)

		// Uncheck a visible row through the production virtual-list control.
		let checkedCapabilities = false
		let checkedValidation = false
		inspectRequest = async (request) => {
			if (request.method === 'PUT' && request.url.includes('/probes/')) {
				assertProgress('checkingCapabilities')
				checkedCapabilities = true
			}
			if (
				request.method === 'HEAD' &&
				plugin.progressService.preparationProgress?.phase === 'validating'
			) {
				assertProgress('validating')
				checkedValidation = true
			}
		}
		running = start()
		await button(/Confirm and sync|确认并同步/)
		const row = Array.from(
			document.querySelectorAll<HTMLInputElement>(
				'.modal input[type="checkbox"]',
			),
		).find((input) =>
			input.parentElement?.parentElement?.textContent?.includes('unchecked.md'),
		)
		assert(row, 'Task selection checkbox not found')
		row.click()
		await approve()
		assert(await running, 'Approved sync failed')
		assert(
			checkedCapabilities && checkedValidation,
			'Missing progress before transfers',
		)
		plugin.progressService.closeProgressModal()
		assert(
			text(cloud.objects.get(`vault/${root}/中文.md`)!) === 'first',
			'Upload missing or corrupt',
		)
		assert(
			!cloud.objects.has(`vault/${root}/unchecked.md`),
			'Unchecked upload was executed',
		)
		assert(
			(await app.vault.adapter.read(`${root}/cloud.md`)) === 'from cloud',
			'Download missing or corrupt',
		)

		// Stop including the deliberately unchecked file for subsequent decisions.
		await app.vault.delete(unchecked)
		// A known unchanged vault needs only listing and local content comparison.
		let unchangedModal: Element | undefined
		const requestOffset = cloud.requests.length
		inspectRequest = async (request) => {
			assert(
				new URL(request.url).searchParams.get('list-type') === '2',
				'Unchanged sync made a redundant per-file request',
			)
			unchangedModal = assertProgress('traversingRemote')
		}
		assert(await start(), 'Unchanged sync failed')
		assert(
			cloud.requests.length - requestOffset === 1,
			'Unchanged sync did not use the listing fast path',
		)
		assert(
			unchangedModal &&
				document.querySelector('.modal.jasync-progress-modal') ===
					unchangedModal,
			'Unchanged sync replaced its progress window',
		)
		plugin.progressService.closeProgressModal()

		// A previously untracked equal pair still verifies before saving its baseline.
		await app.vault.create(`${root}/baseline.md`, 'shared')
		cloud.objects.set(`vault/${root}/baseline.md`, bytes('shared'))
		let newBaselineVerified = false
		inspectRequest = async (request) => {
			if (request.method !== 'HEAD') return
			assert(
				request.url.includes('/baseline.md'),
				'A known unchanged file was rechecked',
			)
			assertProgress('recording')
			assert(
				plugin.progressService.preparationProgress?.files?.total === 1,
				'History progress included known unchanged files',
			)
			newBaselineVerified = true
		}
		assert(await start(), 'New common baseline was not saved')
		assert(newBaselineVerified, 'New baseline skipped verification')
		plugin.progressService.closeProgressModal()

		// Stop remains available while preflight requests are in progress.
		await app.vault.modify(note, 'preflight controls')
		let stopped = false
		inspectRequest = async () => {
			if (
				stopped ||
				plugin.progressService.preparationProgress?.phase !== 'validating'
			)
				return
			const modal = assertProgress('validating')
			assert(
				plugin.progressService.preparationProgress?.files?.total === 1,
				'Preflight included a known unchanged file',
			)
			const stop = Array.from(modal.querySelectorAll('button')).find(
				(element) => /Stop sync|停止同步/.test(element.textContent ?? ''),
			)
			assert(stop, 'Preflight stop control is missing')
			stopped = true
			stop.click()
		}
		running = start()
		await approve()
		assert(
			!(await running) && stopped,
			'Preflight cancellation did not stop sync',
		)
		assert(
			!document.querySelector('.modal.jasync-progress-modal'),
			'Cancelled progress reopened',
		)

		// Hide is a user choice: subsequent phases must not reopen the modal.
		let hidden = false
		inspectRequest = async () => {
			if (hidden) {
				assert(
					!document.querySelector('.modal.jasync-progress-modal'),
					'Hidden progress reopened',
				)
				return
			}
			if (plugin.progressService.preparationProgress?.phase !== 'validating')
				return
			const modal = assertProgress('validating')
			const hide = Array.from(modal.querySelectorAll('button')).find(
				(element) => /^Hide$|^隐藏$/.test(element.textContent ?? ''),
			)
			assert(hide, 'Preflight hide control is missing')
			hidden = true
			hide.click()
		}
		running = start()
		await approve()
		assert(await running, 'Hidden sync failed')
		assert(
			hidden && !document.querySelector('.modal.jasync-progress-modal'),
			'Hidden sync reopened at completion',
		)
		inspectRequest = undefined
		await app.vault.modify(note, 'second')
		running = start()
		await approve()
		assert(await running, 'Overwrite sync failed')
		plugin.progressService.closeProgressModal()
		assert(
			text(cloud.objects.get(`vault/${root}/中文.md`)!) === 'second',
			'Overwrite not applied',
		)
		assert(
			await app.vault.adapter.exists(`${plugin.manifest.dir}/recovery`),
			'Recovery copies missing',
		)

		// Both directions of a tracked deletion, without recursive folder deletion.
		await app.vault.delete(note)
		cloud.objects.delete(`vault/${root}/cloud.md`)
		running = start()
		await approve()
		assert(await running, 'Tracked deletion failed')
		plugin.progressService.closeProgressModal()
		assert(
			!cloud.objects.has(`vault/${root}/中文.md`),
			'Remote deletion not applied',
		)
		assert(
			!(await app.vault.adapter.exists(`${root}/cloud.md`)),
			'Local deletion not applied',
		)

		// Target changes while the modal is open must invalidate approval.
		await app.vault.create(`${root}/target.md`, 'target check')
		running = start()
		await button(/Confirm and sync|确认并同步/)
		plugin.localSettings.s3.prefix = 'other/'
		await approve()
		assert(!(await running), 'Changed target did not invalidate approval')
		assert(
			!cloud.objects.has(`vault/${root}/target.md`) &&
				!cloud.objects.has(`other/${root}/target.md`),
			'Stale target wrote a file',
		)
		plugin.localSettings.s3.prefix = 'vault/'

		// Unsupported conditions require a second, explicit per-run approval.
		cloud.conditional = false
		// Regression: some services return 304 for mutation condition headers,
		// including the first create. Compatibility writes must omit them.
		cloud.fail = (request) =>
			['PUT', 'DELETE'].includes(request.method) &&
			(request.headers['if-none-match'] || request.headers['if-match'])
				? cloud.response(undefined, 304)
				: undefined
		running = start()
		await approve()
		await button(/Continue with backups|使用备份/)
		;(await button(/^Cancel$|^取消$/)).click()
		assert(!(await running), 'Declined compatibility sync reported success')
		assert(
			!cloud.objects.has(`vault/${root}/target.md`),
			'Declined compatibility wrote a user file',
		)
		running = start()
		await approve()
		;(await button(/Continue with backups|使用备份/)).click()
		assert(await running, 'Explicit compatibility sync failed')
		plugin.progressService.closeProgressModal()
		assert(
			text(cloud.objects.get(`vault/${root}/target.md`)!) === 'target check',
			'Compatibility upload missing',
		)

		const target = app.vault.getAbstractFileByPath(`${root}/target.md`)
		assert(target instanceof TFile, 'Test file disappeared')
		await app.vault.modify(target, 'auto must wait')
		assert(
			!(await start(true)),
			'Automatic sync bypassed unsupported conditions',
		)
		assert(
			text(cloud.objects.get(`vault/${root}/target.md`)!) === 'target check',
			'Automatic compatibility overwrite occurred',
		)
		cloud.conditional = true
		cloud.fail = undefined
		assert(await start(true), 'Verified nonconflicting automatic update failed')
		assert(
			text(cloud.objects.get(`vault/${root}/target.md`)!) === 'auto must wait',
			'Automatic update missing',
		)
		await app.vault.modify(target, 'local conflict')
		cloud.objects.set(`vault/${root}/target.md`, bytes('remote conflict'))
		assert(
			!(await start(true)),
			'Automatic sync resolved a conflict without review',
		)
		assert(
			(await app.vault.read(target)) === 'local conflict',
			'Automatic conflict changed local content',
		)
		assert(
			text(cloud.objects.get(`vault/${root}/target.md`)!) === 'remote conflict',
			'Automatic conflict changed remote content',
		)
	} finally {
		plugin.progressService.closeProgressModal()
		plugin.createRemoteSession = originalFactory
		plugin.settings = originalSettings
		plugin.localSettings = originalLocal
	}
}
