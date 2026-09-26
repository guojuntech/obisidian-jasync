import { posix as pathPosix } from 'path-browserify'

export const VAULT_MOUNT_POINT = '/'
export const AGENTS_MOUNT_POINT = '/.agents'
export const AGENTS_VAULT_PATH = '.agents'
export const JASYNC_AGENTS_MOUNT_POINT = `${AGENTS_MOUNT_POINT}/omni-sync`
export const JASYNC_AGENTS_VAULT_PATH = `${AGENTS_VAULT_PATH}/omni-sync`
export const BASH_TMP_VAULT_PATH = `${JASYNC_AGENTS_VAULT_PATH}/tmp`
export const BASH_TMP_MOUNT_POINT = `/${BASH_TMP_VAULT_PATH}`
export const BUILTIN_SKILLS_MOUNT_POINT = `${JASYNC_AGENTS_MOUNT_POINT}/builtin-skills`
export const BUILTIN_SKILLS_RELATIVE_MOUNT_POINT = '/omni-sync/builtin-skills'
export const SETTINGS_MOUNT_POINT = '/.config/omni-sync'
export const SETTINGS_FILE_PATH = `${SETTINGS_MOUNT_POINT}/settings.json`

/** Virtual aliases kept only for interpreting sessions from older versions. */
export const LEGACY_VAULT_MOUNT_POINT = '/vault'
export const LEGACY_BASH_TMP_MOUNT_POINT = '/tmp'

export function normalizeLegacyVirtualPath(inputPath: string) {
	const normalized = pathPosix.normalize(inputPath)
	if (
		normalized === LEGACY_VAULT_MOUNT_POINT ||
		normalized.startsWith(`${LEGACY_VAULT_MOUNT_POINT}/`)
	) {
		const relative = normalized.slice(LEGACY_VAULT_MOUNT_POINT.length)
		return relative || '/'
	}
	if (
		normalized === LEGACY_BASH_TMP_MOUNT_POINT ||
		normalized.startsWith(`${LEGACY_BASH_TMP_MOUNT_POINT}/`)
	) {
		const relative = normalized.slice(LEGACY_BASH_TMP_MOUNT_POINT.length)
		return `${BASH_TMP_MOUNT_POINT}${relative}`
	}
	return normalized
}

export function getConfigDirMountPoint(configDir: string) {
	const normalized = pathPosix.normalize(configDir)
	if (
		pathPosix.isAbsolute(normalized) ||
		normalized === '.' ||
		normalized === '..' ||
		normalized.startsWith('../') ||
		normalized.endsWith('/..') ||
		normalized.includes('\0')
	) {
		throw new Error(`Invalid Obsidian config directory: '${configDir}'`)
	}
	return `/${normalized.replace(/^\/+|\/+$/g, '')}`
}
