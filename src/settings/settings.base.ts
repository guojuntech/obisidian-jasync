import { App } from 'obsidian'
import { JASyncSettingTab } from '.'
import JASyncPlugin from '..'

export default abstract class BaseSettings {
	constructor(
		protected app: App,
		protected plugin: JASyncPlugin,
		protected settings: JASyncSettingTab,
		protected containerEl: HTMLElement,
	) {}

	abstract display(): Promise<void>
}
