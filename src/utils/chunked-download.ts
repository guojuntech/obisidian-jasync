import { normalizePath, Platform, Vault } from 'obsidian'
import { dirname } from 'path-browserify'
import type RemoteStorage from '~/remote-storage/remote-storage.interface'
import { parseMobileAppDownloadFileChunkSize } from './download-chunk-size'
import { writeLocalBinary } from './local-vault-io'
import logger from './logger'
import { mkdirsVault } from './mkdirs-vault'

export interface DownloadRemoteFileOptions {
	vault: Vault
	remoteStorage: RemoteStorage
	remotePath: string
	localPath: string
	remoteSize: number
	mobileAppDownloadFileChunkSize?: string
}

export async function downloadRemoteFile(options: DownloadRemoteFileOptions) {
	if (!Platform.isMobileApp) {
		await downloadRemoteFileWhole(options)
		return
	}
	await downloadRemoteFileInChunks(options)
}

function concatenateChunks(chunks: ArrayBuffer[], totalSize: number) {
	const result = new ArrayBuffer(totalSize)
	const resultView = new Uint8Array(result)
	let offset = 0

	for (const chunk of chunks) {
		resultView.set(new Uint8Array(chunk), offset)
		offset += chunk.byteLength
	}

	if (offset !== totalSize) {
		throw new Error('Remote Size Not Match!')
	}

	return result
}

async function downloadRemoteFileWhole({
	vault,
	remoteStorage,
	remotePath,
	localPath,
	remoteSize,
}: DownloadRemoteFileOptions) {
	const { data: arrayBuffer } = await remoteStorage.getFileContents(remotePath)
	if (arrayBuffer.byteLength !== remoteSize) {
		throw new Error('Remote Size Not Match!')
	}
	await mkdirsVault(vault, dirname(localPath))
	await writeLocalBinary(vault, localPath, arrayBuffer)
}

async function downloadRemoteFileInChunks({
	vault,
	remoteStorage,
	remotePath,
	localPath,
	remoteSize,
	mobileAppDownloadFileChunkSize,
}: DownloadRemoteFileOptions) {
	const normalizedLocalPath = normalizePath(localPath)
	await mkdirsVault(vault, dirname(normalizedLocalPath))

	if (remoteSize === 0) {
		await writeLocalBinary(vault, normalizedLocalPath, new ArrayBuffer(0))
		return
	}

	const appendBinary = (
		vault.adapter as unknown as {
			appendBinary?: (path: string, data: ArrayBuffer) => Promise<void>
		}
	).appendBinary?.bind(vault.adapter)
	const chunks: ArrayBuffer[] = []

	const chunkSize = parseMobileAppDownloadFileChunkSize(
		mobileAppDownloadFileChunkSize,
	)
	const tempPath = normalizePath(
		`${normalizedLocalPath}.omni-sync-${Date.now()}-${Math.random()
			.toString(36)
			.slice(2)}.download`,
	)
	let offset = 0
	let chunkIndex = 0

	logger.info(
		`[ChunkedDownload] start ${remotePath} (${remoteSize} bytes, chunkSize=${chunkSize})`,
	)

	try {
		while (offset < remoteSize) {
			const end = Math.min(offset + chunkSize, remoteSize) - 1
			const response = await remoteStorage.getFileContents(remotePath, {
				range: { start: offset, end },
			})
			if (
				response.range?.start !== offset ||
				response.range.end !== end ||
				response.range.total !== remoteSize
			) {
				throw new Error('Remote range does not match the requested file')
			}
			const chunk = response.data
			const expectedLength = end - offset + 1
			if (chunk.byteLength !== expectedLength) {
				throw new Error('Remote chunk size not match!')
			}
			if (appendBinary && offset === 0) {
				await vault.adapter.writeBinary(tempPath, chunk)
			} else if (appendBinary) {
				await appendBinary(tempPath, chunk)
			} else {
				chunks.push(chunk)
			}
			offset += chunk.byteLength
			chunkIndex++
			if (chunkIndex % 5 === 0) {
				logger.debug(
					`[ChunkedDownload] progress ${offset}/${remoteSize} bytes (chunk #${chunkIndex})`,
				)
			}
		}

		if (offset !== remoteSize) {
			throw new Error('Remote Size Not Match!')
		}
		if (appendBinary) {
			if (await vault.adapter.exists(normalizedLocalPath)) {
				await vault.adapter.remove(normalizedLocalPath)
			}
			await vault.adapter.rename(tempPath, normalizedLocalPath)
		} else {
			logger.warn(
				'[ChunkedDownload] adapter.appendBinary is unavailable; assembling chunks in memory',
			)
			await writeLocalBinary(
				vault,
				normalizedLocalPath,
				concatenateChunks(chunks, remoteSize),
			)
		}
		logger.info(`[ChunkedDownload] done ${remotePath} (${chunkIndex} chunks)`)
	} catch (error) {
		if (appendBinary) {
			await removeTempDownload(vault, tempPath)
		}
		throw error
	}
}

async function removeTempDownload(vault: Vault, tempPath: string) {
	try {
		if (await vault.adapter.exists(tempPath)) {
			await vault.adapter.remove(tempPath)
		}
	} catch {
		// Best-effort cleanup only; preserve the original download error.
	}
}
