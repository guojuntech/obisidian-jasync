import type { App } from 'obsidian'
import type JASyncPlugin from '~/index'
import type { S3Transport } from '~/remote-storage/s3/transport'
import { S3Fixture } from '../../s3-fixture'
import { assert } from './assert'

/** Exercise the release bundle's logger and the Android-accessible export path. */
export async function exportsS3Diagnostics(app: App) {
	const plugin = (
		app as unknown as { plugins: { plugins: Record<string, JASyncPlugin> } }
	).plugins.plugins.jasync
	const original = structuredClone(plugin.localSettings)
	const secrets = [
		'diagnostic-access-key',
		'diagnostic/secret+key=',
		'diagnostic-session-token',
	]
	try {
		assert(
			plugin.localSettings.verboseS3Log !== true,
			'Verbose logging must default off',
		)
		plugin.settingTab.display()
		const tab =
			plugin.settingTab.containerEl.querySelectorAll<HTMLButtonElement>(
				'.ns-settings-tab',
			)[1]
		assert(tab, 'Missing troubleshooting tab')
		tab.click()
		await plugin.settingTab.troubleshootingSettings.display()
		const item = Array.from(
			plugin.settingTab.containerEl.querySelectorAll('.setting-item'),
		).find((el) => el.textContent?.includes('Verbose log'))
		const toggle = item?.querySelector<HTMLElement>('.checkbox-container')
		assert(toggle, 'Verbose log toggle is missing from Troubleshoot')
		// This harness renders the setting tab off-screen; use its native keyboard
		// interaction because a detached label cannot activate its checkbox.
		toggle.dispatchEvent(
			new KeyboardEvent('keydown', { key: ' ', bubbles: true }),
		)
		const settingsPath = `${plugin.manifest.dir}/data.local.json`
		let persisted = false
		for (let attempt = 0; attempt < 50; attempt++) {
			await new Promise((resolve) => window.setTimeout(resolve, 20))
			const stored = JSON.parse(await app.vault.adapter.read(settingsPath)) as {
				verboseS3Log?: boolean
			}
			if (stored.verboseS3Log === true) {
				persisted = true
				break
			}
		}
		assert(persisted, 'Verbose toggle was not saved to local settings')
		await plugin.settingsService.loadLocalSettings()
		assert(
			Boolean(plugin.localSettings.verboseS3Log),
			'Verbose toggle did not survive settings reload',
		)
		plugin.localSettings = {
			...plugin.localSettings,
			s3: {
				...original.s3,
				endpoint: 'https://storage.example.test',
				region: 'us-east-1',
				bucket: 'test-bucket',
				prefix: 'vault/',
				accessKeyId: secrets[0],
				secretAccessKey: secrets[1],
				sessionToken: secrets[2],
			},
		}
		const session = await plugin.createRemoteSession()
		const cloud = new S3Fixture()
		cloud.fail = (request, key) => {
			if (request.method === 'HEAD' && !cloud.objects.has(key))
				throw new Error('Request Failed. IOException Stream closed')
			return undefined
		}
		;(session.storage as unknown as { transport: S3Transport }).transport =
			cloud.transport
		const support = await session.storage.verifyMutationSupport()
		assert(support.delete, 'Deletion probe still depends on native HEAD')
		assert(cloud.objects.size === 0, 'Successful probe cleanup was skipped')
		assert(
			cloud.requests.every((request) => request.method !== 'HEAD'),
			'Capability probe unexpectedly sent HEAD',
		)
		const failingSession = await plugin.createRemoteSession()
		cloud.fail = (request, key) => {
			if (
				request.method === 'GET' &&
				key.endsWith('/delete') &&
				!cloud.objects.has(key)
			)
				throw Object.assign(new Error(`Native GET failed ${secrets[1]}`), {
					status: 404,
					code: 'NATIVE_HTTP_ERROR',
				})
			return undefined
		}
		;(
			failingSession.storage as unknown as { transport: S3Transport }
		).transport = cloud.transport
		let failure: unknown
		try {
			await failingSession.storage.verifyMutationSupport()
		} catch (error) {
			failure = error
		}
		assert(
			failure instanceof Error &&
				failure.message.includes('[delete/verify-deleted]'),
			'Missing failing method/probe step',
		)
		assert(cloud.objects.size === 0, 'Probe cleanup was skipped')
		const existing = new Set(app.vault.getFiles().map((file) => file.path))
		await (
			plugin.settingTab.troubleshootingSettings as unknown as {
				saveLogsToNote(): Promise<void>
			}
		).saveLogsToNote()
		const file = app.vault
			.getFiles()
			.find(
				(file) =>
					file.path.startsWith('jasync/logs/') && !existing.has(file.path),
			)
		assert(file, 'Troubleshoot did not export logs to a note')
		const content = await app.vault.read(file)
		for (const marker of [
			'Verbose S3 log: true',
			'verbose request',
			'verbose response',
			'PutObject',
			'objectPath',
			'credentialScope',
			'[redacted]',
			'Platform:',
			'Obsidian API version:',
			'native request failed',
			'verify-deleted',
			'GET',
			'reportedStatus',
			'404',
			'NATIVE_HTTP_ERROR',
			'diagnosticId',
		])
			assert(content.includes(marker), `Export is missing ${marker}`)
		for (const secret of secrets)
			assert(!content.includes(secret), 'Export leaked a configured credential')
	} finally {
		plugin.localSettings = original
		await plugin.settingsService.saveLocalSettings()
	}
}
