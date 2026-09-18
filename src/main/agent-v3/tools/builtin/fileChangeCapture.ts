import { open } from 'node:fs/promises'

const MAX_BYTES = 256 * 1024

const pendingWrites = new Map<string, Promise<void>>()

/** Keep concurrent built-in writes to the same file from mixing their snapshots. */
export async function withFileChangeLock<T>(
  path: string | undefined,
  action: () => Promise<T>
): Promise<T> {
  if (!path) return action()
  const key = process.platform === 'win32' ? path.toLowerCase() : path
  const previous = pendingWrites.get(key)
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  pendingWrites.set(key, pending)
  await previous
  try {
    return await action()
  } finally {
    release()
    if (pendingWrites.get(key) === pending) pendingWrites.delete(key)
  }
}

/** Never mistake an unreadable/binary/oversize file for an empty file. */
export async function captureFile(
  path: string
): Promise<{ text: string; missing: boolean } | undefined> {
  try {
    const file = await open(path, 'r')
    try {
      const buffer = Buffer.alloc(MAX_BYTES + 1)
      let bytesRead = 0
      while (bytesRead < buffer.length) {
        const chunk = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead)
        if (!chunk.bytesRead) break
        bytesRead += chunk.bytesRead
      }
      if (bytesRead > MAX_BYTES || buffer.subarray(0, bytesRead).includes(0)) return undefined
      return {
        text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
          buffer.subarray(0, bytesRead)
        ),
        missing: false
      }
    } finally {
      await file.close()
    }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { text: '', missing: true }
      : undefined
  }
}
