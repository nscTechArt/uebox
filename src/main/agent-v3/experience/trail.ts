/**
 * 原始账：一次会话里引擎工具的调用记录，给会话结束后的整理员看。
 *
 * ## 记什么、不记什么
 *
 * 只记**引擎工具**的：工具名、参数摘要、成败、归一化后的报错、这次有没有经验出场。
 * **不记聊天内容** —— 经验只从引擎的客观结果里学，聊天不产生经验；
 * 不记下来，也就不存在「一句话把它带偏」的通道（记忆投毒）。
 *
 * 放在 userData 而不是工程里：它是盒子自己的过程数据，不是用户的东西，
 * 7 天后由整理员清掉。userData 在 `pathBoundary` 的禁区里，干活的 agent 读不到它。
 */

import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import { join } from 'path'

import type { SkillLearningMode } from '../capabilities/skills'

/** 原始账在经验「家」（`<userData>/experience`）下的子目录。点开头，不会被当成经验文件读 */
export const TRAIL_SUBDIR = '.trail'

/** 参数摘要的长度上限。Python 脚本可能很长，而整理员只需要看出「改了什么」 */
const ARGS_DIGEST_LIMIT = 800
export const TRAIL_RETENTION_MS = 7 * 24 * 3600 * 1000

export interface TrailHeader {
  kind: 'header'
  sessionId: string
  projectRoot: string
  engineVersion?: string
  skillLearning: SkillLearningMode
  /** 界面语言：整理员用它决定经验标题和做法用哪种语言写，用户在技能页里看的就是这两样 */
  language?: 'zh-CN' | 'en-US'
  startedAt: string
}

export interface TrailCall {
  kind: 'call'
  /** 哪个 agent 调的（主会话或某个子任务）。子任务并行时调用流交错，整理员按它分开配对 */
  agent: string
  /** 这次会话里第几次引擎工具调用 */
  i: number
  tool: string
  ok: boolean
  args: string
  /** 失败时：归一化后的报错与指纹 */
  error?: string
  fp?: string
  /** 环境类失败（超时、没连上……），整理员不学 */
  env?: boolean
  /** 这次报错出场 / 被留作对照的经验 id */
  shown?: string[]
  held?: string[]
}

/** 整理员看过前多少条调用。同一条会话结束好几轮时，下一次只看新的，不重复花钱 */
export interface TrailCurated {
  kind: 'curated'
  through: number
}

export type TrailLine = TrailHeader | TrailCall | TrailCurated

/**
 * 参数摘要：仍是合法 JSON，只把过长的字符串值截短。
 *
 * 不能整段截：截断的 JSON 解析不了，按参数判采纳（`runtime.ts`）、对账（`curator.ts`）
 * 就都读成 undefined。截短的值后面带上全文的哈希 —— 只改了第 800 字之后几行的两段脚本，
 * 摘要也必须不一样，否则「换了参数才成功」会被当成原样重试。
 */
export function digestArgs(args: unknown): string {
  try {
    return (
      JSON.stringify(args, (_key, value: unknown) =>
        typeof value === 'string' && value.length > ARGS_DIGEST_LIMIT
          ? `${value.slice(0, ARGS_DIGEST_LIMIT)}…#${createHash('sha1').update(value).digest('hex').slice(0, 12)}`
          : value
      ) ?? ''
    )
  } catch {
    return '<unserializable>'
  }
}

function fileFor(dir: string, sessionId: string): string {
  return join(dir, `${sessionId.replace(/[^\w-]/g, '_')}.jsonl`)
}

export class TrailWriter {
  private wroteHeader = false
  private chain: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly dir: string,
    private readonly header: Omit<TrailHeader, 'kind' | 'startedAt'>
  ) {}

  /** 追加一条。失败只吞掉：原始账写不了不该让工具调用失败 */
  record(call: Omit<TrailCall, 'kind'>): Promise<void> {
    const lines: TrailLine[] = []
    if (!this.wroteHeader) {
      this.wroteHeader = true
      lines.push({ kind: 'header', ...this.header, startedAt: new Date().toISOString() })
    }
    lines.push({ kind: 'call', ...call })
    const text = lines.map((line) => JSON.stringify(line)).join('\n') + '\n'
    const next = this.chain.then(async () => {
      await fs.mkdir(this.dir, { recursive: true })
      await fs.appendFile(fileFor(this.dir, this.header.sessionId), text, 'utf8')
    })
    this.chain = next.catch(() => undefined)
    return next.catch(() => undefined)
  }
}

export async function readTrail(
  dir: string,
  sessionId: string
): Promise<{ header: TrailHeader; calls: TrailCall[]; curatedThrough: number } | undefined> {
  let text: string
  try {
    text = await fs.readFile(fileFor(dir, sessionId), 'utf8')
  } catch {
    return undefined
  }
  let header: TrailHeader | undefined
  const calls: TrailCall[] = []
  let curatedThrough = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as TrailLine
      if (parsed.kind === 'header') header ??= parsed
      else if (parsed.kind === 'call') calls.push(parsed)
      else if (parsed.kind === 'curated') curatedThrough = Math.max(curatedThrough, parsed.through)
    } catch {
      // 半行（写到一半断电）跳过
    }
  }
  return header ? { header, calls, curatedThrough } : undefined
}

export async function markCurated(dir: string, sessionId: string, through: number): Promise<void> {
  const line: TrailCurated = { kind: 'curated', through }
  await fs.appendFile(fileFor(dir, sessionId), `${JSON.stringify(line)}\n`, 'utf8')
}

/** 清掉超过保留期的原始账 */
export async function pruneTrails(dir: string, now: number = Date.now()): Promise<void> {
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return
  }
  for (const name of names) {
    const path = join(dir, name)
    try {
      const { mtimeMs } = await fs.stat(path)
      if (now - mtimeMs > TRAIL_RETENTION_MS) await fs.rm(path, { force: true })
    } catch {
      // 并发删掉了就算了
    }
  }
}
