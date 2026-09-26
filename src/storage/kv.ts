import localforage from 'localforage'
import type { ChatSessionIndexItem } from '~/ai/chat/domain'
import type { PersistedChatSession } from '~/ai/chat/session/session-persistence'
import { SyncRecordModel } from '~/model/sync-record.model'
import useStorage from './use-storage'

const CACHE_DB_NAME = 'JASync_Plugin_Cache'

function createRecoverableStorage<T>(storeName: string) {
	return useStorage<T>({
		getFreshInstance: () =>
			localforage.createInstance({
				name: CACHE_DB_NAME,
				storeName,
			}),
		maxRetries: 1,
	})
}

export const syncRecordKV =
	createRecoverableStorage<Map<string, SyncRecordModel>>('sync_record')

export const blobKV = createRecoverableStorage<Blob>('base_blob_store')

export interface ChatMetaRecord {
	activeSessionId?: string
	orderedSessionIds: string[]
}

export const chatSessionKV =
	createRecoverableStorage<PersistedChatSession>('chat_sessions')

export const chatMetaKV = createRecoverableStorage<
	ChatMetaRecord | ChatSessionIndexItem[]
>('chat_meta')
