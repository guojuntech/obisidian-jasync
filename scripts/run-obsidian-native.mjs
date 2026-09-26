import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

// Always uses a disposable vault/profile. Never attach to the user's app.
export async function runNativeObsidian({
	artifactRoot,
	vault,
	resultPath,
	timeout,
}) {
	if (process.platform !== 'darwin')
		throw new Error('--native currently requires macOS')
	const profile = join(artifactRoot, 'profile')
	await mkdir(profile)
	await writeFile(
		join(profile, 'obsidian.json'),
		JSON.stringify({
			vaults: { e2e0000000000001: { path: vault, ts: Date.now(), open: true } },
		}),
	)
	await writeFile(join(profile, 'e2e0000000000001.json'), '{}')
	// Bootstrap only the profile on the first launch. Some Obsidian builds
	// already permit community plugins and would otherwise run the harness
	// twice against the same synthetic files when we restart below.
	const pluginListPath = join(vault, '.obsidian', 'community-plugins.json')
	const pluginList = await readFile(pluginListPath, 'utf8')
	await writeFile(pluginListPath, '[]')
	const server = createServer()
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
	const port = server.address().port
	await new Promise((resolve) => server.close(resolve))
	let child
	let output = ''
	const launch = () => {
		child = spawn(
			process.env.OBSIDIAN_E2E_EXECUTABLE ??
				'/Applications/Obsidian.app/Contents/MacOS/Obsidian',
			[
				`--user-data-dir=${profile}`,
				`--remote-debugging-port=${port}`,
				'--no-sandbox',
			],
			{ stdio: ['ignore', 'pipe', 'pipe'] },
		)
		child.stdout.on('data', (data) => {
			output += data
		})
		child.stderr.on('data', (data) => {
			output += data
		})
		child.on('error', (error) => {
			output += String(error)
		})
	}
	const stop = async () => {
		if (!child || child.exitCode !== null) return
		const stopped = new Promise((resolve) => child.once('exit', resolve))
		child.kill('SIGTERM')
		await Promise.race([stopped, delay(3000)])
		if (child.exitCode === null) {
			child.kill('SIGKILL')
			await stopped
		}
	}
	let socket
	try {
		launch()
		const deadline = Date.now() + timeout
		while (Date.now() < deadline) {
			try {
				const targets = await (
					await fetch(`http://127.0.0.1:${port}/json/list`)
				).json()
				const target = targets.find((target) => target.type === 'page')
				if (target) {
					socket = new WebSocket(target.webSocketDebuggerUrl)
					await new Promise((resolve, reject) => {
						socket.onopen = resolve
						socket.onerror = reject
					})
					const response = new Promise((resolve) => {
						socket.onmessage = (event) => resolve(JSON.parse(event.data))
					})
					socket.send(
						JSON.stringify({
							id: 1,
							method: 'Runtime.evaluate',
							params: {
								expression:
									"typeof app !== 'undefined' && (localStorage.setItem('enable-plugin-' + app.appId, 'true'), app.appId)",
								returnByValue: true,
							},
						}),
					)
					const result = await response
					socket.close()
					socket = undefined
					if (result.result?.result?.value) break
				}
			} catch {
				/* App is still starting. */
			}
			await delay(250)
		}
		await delay(500)
		await stop()
		await writeFile(pluginListPath, pluginList)
		launch()
		const resultDeadline = Date.now() + timeout
		while (Date.now() < resultDeadline) {
			let result
			try {
				result = JSON.parse(await readFile(join(vault, resultPath), 'utf8'))
			} catch {
				/* Harness not loaded yet. */
			}
			if (result && !result.started) {
				const failures = result.results.filter((entry) => entry.error)
				if (!result.passed) throw new Error(JSON.stringify(failures, null, 2))
				console.log(
					`[obsidian-e2e] ${result.results.length} native Obsidian checks passed`,
				)
				return
			}
			await delay(250)
		}
		throw new Error('Timed out waiting for the native integration harness')
	} finally {
		socket?.close()
		await stop()
		await writeFile(pluginListPath, pluginList)
		await writeFile(join(artifactRoot, 'obsidian.log'), output)
		console.log(`[obsidian-e2e] isolated artifacts: ${artifactRoot}`)
	}
}
