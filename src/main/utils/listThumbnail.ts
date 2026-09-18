import { createHash } from 'crypto'
import { mkdir, stat, rename, rm, copyFile } from 'fs/promises'
import { join, resolve } from 'path'
import { getSharp } from './sharpLoader'

const pending = new Map<string, Promise<string>>()
// ponytail: one decoder at a time; widen only if measured first-load latency requires it.
let queue: Promise<unknown> = Promise.resolve()

/** Disposable disk cache. Source metadata invalidates edited images without touching originals. */
export async function getListThumbnail(source: string, cacheDir: string): Promise<string> {
  const info = await stat(source)
  if (!info.isFile()) throw new Error('Thumbnail source is not a file')
  const absolute = resolve(source).replace(/\\/g, '/')
  const sourceKey = process.platform === 'win32' ? absolute.toLowerCase() : absolute
  const key = createHash('sha256')
    .update(JSON.stringify([sourceKey, info.size, info.mtimeMs, '400-webp-v1']))
    .digest('hex')
  const target = join(cacheDir, `${key}.webp`)
  try {
    await stat(target)
    return target
  } catch {
    // Missing cache entries are generated on demand.
  }
  const existing = pending.get(target)
  if (existing) return existing
  const job = queue
    .catch(() => undefined)
    .then(async () => {
      await mkdir(cacheDir, { recursive: true })
      const temporary = `${target}.tmp`
      try {
        const sharp = await getSharp()
        const image = sharp(source)
        const metadata = await image.metadata()
        if (
          metadata.format === 'webp' &&
          metadata.width &&
          metadata.width <= 400 &&
          metadata.height &&
          metadata.height <= 400 &&
          (!metadata.orientation || metadata.orientation === 1) &&
          (metadata.pages ?? 1) === 1
        ) {
          await copyFile(source, temporary)
        } else {
          await image
            .rotate()
            .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
            .webp({ quality: 80 })
            .toFile(temporary)
        }
        await rename(temporary, target)
        return target
      } finally {
        await rm(temporary, { force: true })
      }
    })
  pending.set(target, job)
  queue = job.catch(() => undefined)
  try {
    return await job
  } finally {
    pending.delete(target)
  }
}
