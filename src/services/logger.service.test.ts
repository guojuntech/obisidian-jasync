import { expect, it, vi } from 'vitest'
import logger from '~/utils/logger'
import LoggerService, { MAX_LOG_ENTRIES } from './logger.service'

vi.mock('obsidian', () => ({
	moment: () => ({ format: () => '2026-09-28 00:00:00' }),
}))
vi.mock('~/consts', () => ({ IN_DEV: false }))
vi.mock('~/utils/logger', () => ({ default: { setReporters: vi.fn() } }))

it('keeps recent diagnostics bounded, reports dropped entries and resets the count on clear', () => {
	const service = new LoggerService({} as never)
	service.onload()
	const reporter = vi.mocked(logger.setReporters).mock.calls[0][0][0]
	for (let index = 0; index < MAX_LOG_ENTRIES + 3; index++)
		reporter.log(
			{ date: new Date(), type: 'debug', args: [index], level: 4, tag: '' },
			{ options: {} } as never,
		)
	expect(service.logs).toHaveLength(MAX_LOG_ENTRIES)
	expect(service.logs[0].args).toEqual([3])
	expect(service.logs.at(-1)?.args).toEqual([MAX_LOG_ENTRIES + 2])
	expect(service.droppedLogCount).toBe(3)
	service.clear()
	expect(service.logs).toEqual([])
	expect(service.droppedLogCount).toBe(0)
})
