import { copyFile, mkdir } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const dist = new URL('dist/', root)
await mkdir(dist, { recursive: true })

// Package the final SWC output, not the intermediate esbuild bundle.
for (const file of [
	'main.js',
	'manifest.json',
	'styles.css',
	'LICENSE',
	'NOTICE.md',
]) {
	await copyFile(new URL(file, root), new URL(file, dist))
}

console.log('Packaged JASync in dist/')
