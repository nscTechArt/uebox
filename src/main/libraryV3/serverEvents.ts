/**
 * 一台服务器的变化通知（设计 3.7）：SSE `GET /v1/events?libraries=a,b`，带 Last-Event-ID 续传。
 *
 * - 服务端还没有这条路由（第一切片），或者代理把 SSE 拦了：每 30 秒轮询一次 `/v1/libraries`
 *   上的代号，每 5 分钟再试一次 SSE。
 * - 断线：指数退避重连（2 秒起，最多 60 秒）；重连前先轮询一次补课 —— 休眠醒来后
 *   代号对不上时，调用方会用 `/changes?since=` 找出变了哪些文件夹。
 * - 事件只是提示：每个响应都带代号，正确性从不依赖事件是否送达。
 *
 * 只有渲染层打开了这台服务器上某个库的视图时才连（见 CatalogService.watch），
 * 不打开资产库就不发任何请求。
 */
import type { CatalogHttp, CatalogHttpError } from './http'
import { SseParser, decodeCatalogEvent, type CatalogEvent } from './sse'

export interface ServerEventsOptions {
  http: CatalogHttp
  onEvent: (event: CatalogEvent) => void
  /** SSE 可用（true）/ 不可用改轮询（false） */
  onStreamState: (available: boolean) => void
  poll: () => Promise<void>
  pollIntervalMs?: number
  sseRetryAfterMissingMs?: number
}

export class ServerEvents {
  private libraries: string[] = []
  private closeStream: (() => void) | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private backoffMs = 2000
  private stopped = false
  private readonly parser = new SseParser()
  private streamAvailable: boolean | null = null

  constructor(private readonly options: ServerEventsOptions) {}

  setLibraries(ids: string[]): void {
    const next = [...new Set(ids)].sort()
    const same = next.join(',') === this.libraries.join(',')
    this.libraries = next
    this.stopped = false
    if (next.length === 0) {
      this.stop()
      return
    }
    if (same && (this.closeStream || this.pollTimer || this.reconnectTimer)) return
    this.closeStream?.()
    this.closeStream = null
    void this.options.poll().catch(() => undefined)
    this.connect()
  }

  private setStreamState(available: boolean): void {
    if (this.streamAvailable === available) return
    this.streamAvailable = available
    this.options.onStreamState(available)
  }

  private startPolling(): void {
    if (this.pollTimer) return
    this.pollTimer = setInterval(() => {
      void this.options.poll().catch(() => undefined)
    }, this.options.pollIntervalMs ?? 30_000)
    this.pollTimer.unref?.()
  }

  private stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
  }

  private schedule(delayMs: number): void {
    if (this.stopped || this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.options.poll().catch(() => undefined)
      this.connect()
    }, delayMs)
    this.reconnectTimer.unref?.()
  }

  private connect(): void {
    if (this.stopped || this.libraries.length === 0) return
    this.parser.reset()
    const defaultLibrary = this.libraries.length === 1 ? this.libraries[0] : null
    const headers: Record<string, string> = {}
    if (this.parser.lastEventId) headers['last-event-id'] = this.parser.lastEventId
    this.closeStream = this.options.http.stream('/v1/events', {
      query: { libraries: this.libraries.join(',') },
      headers,
      onOpen: () => {
        this.backoffMs = 2000
        this.stopPolling()
        this.setStreamState(true)
      },
      onChunk: (text) => {
        for (const message of this.parser.push(text)) {
          const event = decodeCatalogEvent(message, defaultLibrary)
          if (event) this.options.onEvent(event)
        }
      },
      onEnd: (error: CatalogHttpError | null) => {
        this.closeStream = null
        if (this.stopped) return
        if (error && (error.code === 'route-missing' || error.code === 'bad-request')) {
          // 服务端没有 SSE：轮询，隔一阵再试
          this.setStreamState(false)
          this.startPolling()
          this.schedule(this.options.sseRetryAfterMissingMs ?? 5 * 60_000)
          return
        }
        this.startPolling()
        const delay = this.backoffMs
        this.backoffMs = Math.min(this.backoffMs * 2, 60_000)
        this.schedule(delay)
      }
    })
  }

  stop(): void {
    this.stopped = true
    this.closeStream?.()
    this.closeStream = null
    this.stopPolling()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }
}
