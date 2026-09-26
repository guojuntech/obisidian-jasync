import type { StatModel } from '~/model/stat.model'

type MaybePromise<T> = Promise<T> | T

export interface fs {
	ls: (path: string) => MaybePromise<StatModel[]>
	mkdirs: (path: string) => MaybePromise<void>
}
