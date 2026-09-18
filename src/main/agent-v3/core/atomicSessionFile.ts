import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'

/** 先完整写好同目录临时文件，再替换；失败时保留旧文件。 */
export async function writeSessionFile(path: string, content: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' })
    await fs.rename(temporary, path)
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
  }
}
