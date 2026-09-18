import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { setTimeout } from 'node:timers/promises'

/** Retry only Windows sharing violations, never repeat the paid operation preceding the write. */
export async function retryMediaFile<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation()
    } catch (error) {
      if (!['EBUSY', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      if (attempt === 5)
        throw new Error(
          '视频素材文件仍被占用。请关闭占用它的程序后继续同一工程、同一请求；已生成的音频和任务记录会保留。',
          { cause: error }
        )
      await setTimeout(100 * 2 ** attempt)
    }
  }
}

/** A hash written before the bytes lets a later invocation verify a fully written paid result. */
export async function recoverMediaFile(file: string): Promise<void> {
  let expected: string
  try {
    expected = await fs.readFile(`${file}.pending.sha256`, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const valid = async (candidate: string): Promise<boolean> => {
    const bytes = await fs.readFile(candidate).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    return !!bytes && createHash('sha256').update(bytes).digest('hex') === expected
  }
  if (!(await valid(file))) {
    if (!(await valid(`${file}.pending`)))
      throw new Error(
        '已生成音频的本地保存未完成，请检查工程中的 pending 文件；不会自动重复生成收费音频。'
      )
    await retryMediaFile(() => fs.rename(`${file}.pending`, file))
  }
  await retryMediaFile(() => fs.unlink(`${file}.pending.sha256`))
}

export async function saveMediaFile(file: string, bytes: Buffer): Promise<void> {
  await retryMediaFile(() =>
    fs.writeFile(`${file}.pending.sha256`, createHash('sha256').update(bytes).digest('hex'))
  )
  await retryMediaFile(() => fs.writeFile(`${file}.pending`, bytes))
  await recoverMediaFile(file)
}
