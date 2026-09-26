import { addIcon } from 'obsidian'
import source from './jasync-sync-icon.svg?raw'

export const JASYNC_SYNC_ICON_ID = 'jasync-sync'

// Obsidian supplies the outer SVG in the same 100 × 100 coordinate space.
export function registerJASyncIcon() {
	addIcon(
		JASYNC_SYNC_ICON_ID,
		source.replace(/^<svg\b[^>]*>/, '').replace(/<\/svg>\s*$/, ''),
	)
}
