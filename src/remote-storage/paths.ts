/** Reject names that Obsidian/filesystems would reinterpret; never normalize keys. */
export function validateRelativePath(path: string): void {
	if (
		path
			.split('/')
			.some(
				(part) =>
					!part ||
					part === '.' ||
					part === '..' ||
					[...part].some(
						(char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
					) ||
					/[\\:*?"<>|]/.test(part) ||
					/[. ]$/.test(part) ||
					/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
			)
	) {
		throw new Error(`S3 path cannot be represented safely in a vault: ${path}`)
	}
}
