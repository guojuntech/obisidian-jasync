import type { RemoteBufferLike } from './remote-storage.interface'

export function toArrayBuffer(data: RemoteBufferLike): ArrayBuffer {
	if (data instanceof ArrayBuffer) return data
	// Copy the view, not its backing allocation (which may be shared or sliced).
	const result = new ArrayBuffer(data.byteLength)
	new Uint8Array(result).set(data)
	return result
}
