/**
 * 决策 trace —— 每次试玩一份 JSONL，落在本机。
 *
 * ## 为什么要落盘
 *
 * 这份文件是做这个机器人的一半理由：换策略（判定模型、大模型）之前，
 * 先拿同一批真实决策点离线回放，看它们选得是不是比规则基线好。
 * 前六轮判定模型的评估全死在「设想的用法和真实用法对不上」—— 这次让用法先真实存在，
 * 数据从真实运行里来。
 *
 * ## 只在本机
 *
 * 不上传、不进遥测（AGENTS §1）。内容是工具参数级别的执行记录：坐标、按钮文字、
 * PrintString。PrintString 可能带工程里的文字，所以这份文件只放在用户自己的数据目录下。
 */

import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs'
import { join } from 'node:path'

export interface TraceSink {
  /** 落盘路径；内存实现为 undefined */
  readonly path?: string
  write(record: Record<string, unknown>): void
  close(): Promise<void>
}

export class MemoryTrace implements TraceSink {
  readonly records: Record<string, unknown>[] = []
  write(record: Record<string, unknown>): void {
    this.records.push(record)
  }
  close(): Promise<void> {
    return Promise.resolve()
  }
}

/**
 * 写到 `<dir>/autoplay-<时间戳>.jsonl`。建目录或开文件失败时退化成只在内存里 ——
 * trace 是副产品，不能因为磁盘问题让这次试玩失败。
 */
export function createFileTrace(dir: string, now: Date = new Date()): TraceSink {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')
  const path = join(dir, `autoplay-${stamp}.jsonl`)
  let stream: WriteStream | null = null
  try {
    mkdirSync(dir, { recursive: true })
    stream = createWriteStream(path, { flags: 'a', encoding: 'utf8' })
    stream.on('error', (error) => {
      console.warn('[Autoplay] trace 写入失败，本次决策记录不完整:', error)
      stream = null
    })
  } catch (error) {
    console.warn('[Autoplay] trace 文件开不了，本次不落盘:', error)
    stream = null
  }

  // 开成功过就回路径：中途写失败的文件是不完整的，但前半段仍然有用
  const opened = stream !== null
  return {
    get path() {
      return opened ? path : undefined
    },
    write(record) {
      stream?.write(`${JSON.stringify(record)}\n`)
    },
    close() {
      const current = stream
      stream = null
      if (!current) return Promise.resolve()
      return new Promise<void>((resolve) => current.end(() => resolve()))
    }
  }
}
