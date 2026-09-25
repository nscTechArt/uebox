/**
 * Server-Sent Events 的增量解析（WHATWG 规范的子集：event / data / id / retry，
 * 冒号开头的注释行当心跳）。纯函数式的小状态机，方便单测。
 */

export interface SseMessage {
  event: string
  data: string
  id: string | null
}

export class SseParser {
  private buffer = ''
  private event = ''
  private data: string[] = []
  private id: string | null = null
  /** 最近一次收到的 id，重连时作为 Last-Event-ID 带上 */
  lastEventId: string | null = null
  retryMs: number | null = null
  /** 收到任何字节（含心跳注释）的时刻，给空闲检测用 */
  lastActivity = 0

  push(chunk: string, now = Date.now()): SseMessage[] {
    this.lastActivity = now
    this.buffer += chunk
    const out: SseMessage[] = []
    for (;;) {
      const match = /\r\n|\r|\n/.exec(this.buffer)
      if (!match) break
      const line = this.buffer.slice(0, match.index)
      this.buffer = this.buffer.slice(match.index + match[0].length)
      if (line === '') {
        if (this.data.length > 0) {
          out.push({ event: this.event || 'message', data: this.data.join('\n'), id: this.id })
          if (this.id !== null) this.lastEventId = this.id
        }
        this.event = ''
        this.data = []
        this.id = null
        continue
      }
      if (line.startsWith(':')) continue
      const colon = line.indexOf(':')
      const field = colon === -1 ? line : line.slice(0, colon)
      let value = colon === -1 ? '' : line.slice(colon + 1)
      if (value.startsWith(' ')) value = value.slice(1)
      switch (field) {
        case 'event':
          this.event = value
          break
        case 'data':
          this.data.push(value)
          break
        case 'id':
          if (!value.includes('\u0000')) this.id = value
          break
        case 'retry': {
          const ms = Number(value)
          if (Number.isInteger(ms) && ms >= 0) this.retryMs = ms
          break
        }
        default:
          break
      }
    }
    // 一行不该这么长；对面不是 SSE 就别无限攒
    if (this.buffer.length > 1024 * 1024) this.buffer = ''
    return out
  }

  reset(): void {
    this.buffer = ''
    this.event = ''
    this.data = []
    this.id = null
  }
}

/** 设计 3.7 的事件，按库拆开后的形状 */
export type CatalogEvent =
  | {
      type: 'generation'
      library: string
      generation: number
      epoch: number | null
      dirs: Array<string | number> | 'broad'
      /** dirs 是整棵子树都可能变了（服务端 broad） */
      subtree: boolean
    }
  | { type: 'annotations'; library: string; paths: string[] | 'bulk' }
  | { type: 'previews'; library: string; hashes: string[] }
  | {
      type: 'state'
      library: string
      state: string
      epoch: number | null
      generation: number | null
    }
  | { type: 'access'; library: string | null }
  | { type: 'reset'; library: string | null }
  | { type: 'enrich'; library: string; done: number; total: number }

function asNumber(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

/**
 * 把一条 SSE 消息翻成目录事件。服务端的字段名还没定稿，这里对常见写法都宽容
 * （gen / generation，dirs / dirtyDirs，lib / library）；不认识的事件返回 null。
 */
export function decodeCatalogEvent(
  message: SseMessage,
  defaultLibrary: string | null
): CatalogEvent | null {
  let payload: Record<string, unknown> = {}
  if (message.data.trim()) {
    try {
      const parsed = JSON.parse(message.data) as unknown
      if (parsed && typeof parsed === 'object') payload = parsed as Record<string, unknown>
    } catch {
      return null
    }
  }
  const library =
    (typeof payload.library === 'string' && payload.library) ||
    (typeof payload.lib === 'string' && payload.lib) ||
    defaultLibrary
  switch (message.event) {
    case 'generation': {
      const generation = asNumber(payload.gen ?? payload.generation)
      if (!library || generation === null) return null
      const rawDirs = payload.dirtyDirs ?? payload.dirs
      // 服务端（第二切片）：dirtyDirs 是直接内容变了的文件夹（"" 是根）；超过 256 个时折叠成
      // 最深公共祖先并置 broad —— 那时要重取的是那棵子树
      if (rawDirs === 'broad' || !Array.isArray(rawDirs)) {
        return {
          type: 'generation',
          library,
          generation,
          epoch: asNumber(payload.epoch),
          dirs: 'broad',
          subtree: false
        }
      }
      const dirs = rawDirs.filter((d) => typeof d === 'string' || typeof d === 'number') as Array<
        string | number
      >
      return {
        type: 'generation',
        library,
        generation,
        epoch: asNumber(payload.epoch),
        dirs,
        subtree: payload.broad === true
      }
    }
    case 'annotations': {
      if (!library) return null
      const paths = Array.isArray(payload.paths)
        ? (payload.paths.filter((p) => typeof p === 'string') as string[])
        : ('bulk' as const)
      return { type: 'annotations', library, paths }
    }
    case 'previews': {
      if (!library) return null
      const hashes = Array.isArray(payload.hashes)
        ? (payload.hashes.filter((h) => typeof h === 'string') as string[])
        : []
      return { type: 'previews', library, hashes }
    }
    case 'state': {
      if (!library) return null
      return {
        type: 'state',
        library,
        state: String(payload.state ?? ''),
        epoch: asNumber(payload.epoch),
        // 连上时的第一条 state 带基线代号
        generation: asNumber(payload.generation)
      }
    }
    case 'access':
      return { type: 'access', library }
    case 'reset':
      return { type: 'reset', library }
    case 'enrich': {
      if (!library) return null
      return {
        type: 'enrich',
        library,
        done: asNumber(payload.done) ?? 0,
        total: asNumber(payload.total) ?? 0
      }
    }
    default:
      return null
  }
}
