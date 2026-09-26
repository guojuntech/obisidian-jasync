import { defineConfig } from 'vitest/config'

export default defineConfig({
	resolve: {
		alias: {
			obsidian: new URL('./test/obsidian.stub.ts', import.meta.url).pathname,
			'~': new URL('./src', import.meta.url).pathname,
		},
	},
	test: {
		environment: 'node',
		setupFiles: ['./test/vitest.setup.ts'],
	},
})
