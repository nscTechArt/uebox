/**
 * 团队服务的通知流（契约 4.12）：`GET /v1/me/events`，SSE，带 Last-Event-ID 补发。
 *
 * - 连着就算「在线」：切换器的状态点、「签出中」里别人看到的绿点都靠它。
 * - 断了指数退避重连（2 秒起，最多 60 秒）；401 不重连，等重新登录。
 * - 事件只是提示：`project` 只说「该重新取了」，`notification` 是给人看的那一条。
 *
 * 一台服务器一条连接，和这台服务器上有几个团队工程无关。
 */
import type { CatalogHttp, CatalogHttpError } from '../http'
import { SseParser } from '../sse'
import type { TeamNotification } from '../../../shared/teamProject'

export interface TeamStreamOptions {
  /** 带身份令牌的成员面客户端；拿到之前 start() 什么都不做 */
  http?: CatalogHttp | null
  onNotification: (notification: TeamNotification) => void
  onProject: (project: string, what: string[]) => void
  onState: (connected: boolean, signedOut: boolean) => void
  /** 测试用 */
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout
}

export class TeamStream {
  private close: (() => void) | null = null
  private timer: NodeJS.Timeout | null = null
  private backoffMs = 2000
  private stopped = false
  private readonly parser = new SseParser()
  connected = false
  signedOut = false

  constructor(private readonly options: TeamStreamOptions) {}

  attach(http: CatalogHttp): void {
    this.options.http = http
  }

  start(): void {
    this.stopped = false
    if (this.close || this.timer || !this.options.http) return
    this.connect()
  }

  stop(): void {
    this.stopped = true
    this.close?.()
    this.close = null
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.setState(false, this.signedOut)
  }

  /** 重新登录之后：清掉「需要重新登录」，马上重连 */
  restart(): void {
    this.stop()
    this.signedOut = false
    this.backoffMs = 2000
    this.start()
  }

  private setState(connected: boolean, signedOut: boolean): void {
    if (this.connected === connected && this.signedOut === signedOut) return
    this.connected = connected
    this.signedOut = signedOut
    this.options.onState(connected, signedOut)
  }

  /** 解一条 SSE 消息；导出给测试用的逻辑在 handle 里 */
  handle(event: string, data: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      return
    }
    if (!parsed || typeof parsed !== 'object') return
    const body = parsed as Record<string, unknown>
    if (event === 'notification') {
      if (typeof body.kind === 'string' && typeof body.project === 'string')
        this.options.onNotification(body as unknown as TeamNotification)
    } else if (event === 'project') {
      if (typeof body.project === 'string')
        this.options.onProject(
          body.project,
          Array.isArray(body.what)
            ? body.what.filter((w): w is string => typeof w === 'string')
            : []
        )
    }
  }

  private connect(): void {
    const http = this.options.http
    if (this.stopped || !http) return
    const headers: Record<string, string> = {}
    if (this.parser.lastEventId) headers['last-event-id'] = this.parser.lastEventId
    this.parser.reset()
    this.close = http.stream('/v1/me/events', {
      headers,
      onOpen: () => {
        this.backoffMs = 2000
        this.setState(true, false)
      },
      onChunk: (chunk) => {
        for (const message of this.parser.push(chunk)) this.handle(message.event, message.data)
      },
      onEnd: (error: CatalogHttpError | null) => {
        this.close = null
        const signedOut = error?.code === 'unauthorized'
        this.setState(false, signedOut)
        if (this.stopped || signedOut) return
        const delay = this.backoffMs
        this.backoffMs = Math.min(this.backoffMs * 2, 60_000)
        const schedule = this.options.setTimer ?? setTimeout
        this.timer = schedule(() => {
          this.timer = null
          this.connect()
        }, delay)
      }
    })
  }
}
