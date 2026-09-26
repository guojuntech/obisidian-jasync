import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { zipSync } from 'fflate'

const root = new URL('../', import.meta.url)
const dist = new URL('dist/', root)
await mkdir(dist, { recursive: true })

// Package the final SWC output, not the intermediate esbuild bundle.
const files = ['main.js', 'manifest.json', 'styles.css', 'LICENSE', 'NOTICE.md']
for (const file of files) {
	await copyFile(new URL(file, root), new URL(file, dist))
}

const manifest = JSON.parse(
	await readFile(new URL('manifest.json', dist), 'utf8'),
)
const archive = {}
for (const file of files) {
	archive[`${manifest.id}/${file}`] = await readFile(new URL(file, dist))
}
await writeFile(
	new URL(`${manifest.id}-${manifest.version}.zip`, dist),
	zipSync(archive),
)

console.log('Packaged JASync in dist/')
