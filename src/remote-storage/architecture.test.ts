import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

function sources(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name)
		return entry.isDirectory()
			? sources(path)
			: path.endsWith('.ts') && !path.endsWith('.test.ts')
				? [path]
				: []
	})
}

it('keeps provider clients out of sync and filesystem code', () => {
	for (const path of [
		...sources('src/sync'),
		...sources('src/fs'),
		'src/utils/chunked-download.ts',
	]) {
		const source = readFileSync(path, 'utf8')
		expect(source, path).not.toMatch(
			/from ['"](?:webdav|aws4fetch|@aws-sdk|~\/api\/|~\/remote-storage\/s3\/|~\/remote-storage\/factory)/,
		)
	}
	for (const path of ['package.json', 'pnpm-lock.yaml']) {
		expect(readFileSync(path, 'utf8')).not.toContain('@nutstore/sso-js')
	}
})
