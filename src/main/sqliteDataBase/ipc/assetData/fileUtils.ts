import { createHash } from 'crypto'
import { createReadStream, open, close, read, statSync } from 'fs'
import { getAssetNameFromFileName } from '../../../utils/assetName'

export function generateSafeAssetKey(fileName: string): string {
  const timestamp = Date.now()
  const randomSuffix = Math.random().toString(36).substr(2, 9)
  const nameWithoutExt = getAssetNameFromFileName(fileName)

  if (nameWithoutExt.length <= 30) {
    return `${nameWithoutExt}_${timestamp}_${randomSuffix}`
  }

  const prefix = nameWithoutExt.substring(0, 15).replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, '_')
  const hash = createHash('md5').update(nameWithoutExt).digest('hex').substring(0, 8)
  return `${prefix}_${hash}_${timestamp}_${randomSuffix}`
}

export async function copyFileWithRetry(src: string, dest: string, maxRetries = 5): Promise<void> {
  const fsP = require('fs').promises
  const pathUtil = require('path')

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await fsP.copyFile(src, dest)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code || ''
      const retryableCodes = [
        'EBUSY',
        'EPERM',
        'EACCES',
        'ETIMEDOUT',
        'ECONNRESET',
        'EIO',
        'UNKNOWN'
      ]

      if (attempt < maxRetries && retryableCodes.includes(code)) {
        const delay = Math.min(5000, 200 * Math.pow(2, attempt))
        console.warn(
          `⚠️ [copyFileWithRetry] 文件复制失败(${code})，${delay}ms 后重试(${attempt + 1}/${maxRetries}): ${pathUtil.basename(src)}`
        )
        await new Promise((resolve) => setTimeout(resolve, delay))
        continue
      }

      throw error
    }
  }
}

/** 完整内容指纹用于确认文件相等；抽样指纹只能筛选候选，不能据此跳过复制。 */
export async function calculateFullFileHash(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk)
  }
  return hash.digest('hex')
}

export async function calculateFastFileHash(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('md5')
    const sampleSize = 64 * 1024
    const stats = statSync(filePath)
    const fileSize = stats.size

    hash.update(Buffer.from(fileSize.toString()))

    if (fileSize <= sampleSize * 3) {
      const stream = createReadStream(filePath)
      stream.on('data', (chunk) => {
        hash.update(chunk)
      })
      stream.on('end', () => {
        resolve(hash.digest('hex'))
      })
      stream.on('error', (error) => {
        reject(error)
      })
      return
    }

    open(filePath, 'r', (error, fd) => {
      if (error) {
        reject(error)
        return
      }

      /**
       * 三段可以并发读（省 I/O），但**喂给哈希器的顺序必须固定**。
       *
       * 原来是谁先读完谁先 update，顺序由 OS 调度决定 —— 同一个文件今天和明天
       * 算出来的「指纹」可能不一样。后果：导入查重漏判（磁盘上多出一份 2GB 拷贝）、
       * 网络库「内容相同自动跳过」误判（反复弹覆盖确认框，无人值守时超时按跳过
       * 处理，然后报告说文件没导入——其实它已经在网络盘上了）。
       */
      const buffers = [Buffer.alloc(sampleSize), Buffer.alloc(sampleSize), Buffer.alloc(sampleSize)]
      const readLengths = [0, 0, 0]
      let completed = 0
      let failed = false

      const readCallback =
        (index: number) => (readError: NodeJS.ErrnoException | null, bytesRead: number) => {
          if (failed) return
          if (readError) {
            failed = true
            close(fd, () => reject(readError))
            return
          }

          readLengths[index] = bytesRead
          completed++
          if (completed < buffers.length) return

          // 全部读完之后，按 头 → 中 → 尾 的固定顺序喂哈希
          for (let i = 0; i < buffers.length; i++) {
            if (readLengths[i] > 0) hash.update(buffers[i].subarray(0, readLengths[i]))
          }

          close(fd, (closeError) => {
            if (closeError) {
              reject(closeError)
            } else {
              resolve(hash.digest('hex'))
            }
          })
        }

      const middlePos = Math.floor(fileSize / 2) - Math.floor(sampleSize / 2)
      const endPos = Math.max(0, fileSize - sampleSize)

      read(fd, buffers[0], 0, sampleSize, 0, readCallback(0))
      read(fd, buffers[1], 0, sampleSize, middlePos, readCallback(1))
      read(fd, buffers[2], 0, sampleSize, endPos, readCallback(2))
    })
  })
}
