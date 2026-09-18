/** @vitest-environment node */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd()
  }
}))

async function loadConfigFresh(): Promise<{ http: { enabled: boolean; host: string } }> {
  vi.resetModules()
  const { loadConfig } = await import('./config')
  return loadConfig()
}

afterEach(() => {
  delete process.env.HTTP_ENABLED
})

describe('本地 HTTP 服务的默认状态', () => {
  it('默认不启动', async () => {
    // 这个服务器只剩一组没有鉴权的 debug 路由（跑工具、跑 Agent、导数据库）。
    // UE 插件走 WebSocket，渲染进程也不访问它 —— 不该在每台用户机器上无条件监听。
    const config = await loadConfigFresh()
    expect(config.http.enabled).toBe(false)
  })

  it('需要时可以用 HTTP_ENABLED=true 打开（pnpm dev:smoke 依赖这条）', async () => {
    process.env.HTTP_ENABLED = 'true'
    const config = await loadConfigFresh()
    expect(config.http.enabled).toBe(true)
  })

  it('只监听回环地址，不对局域网暴露', async () => {
    const config = await loadConfigFresh()
    expect(config.http.host).toBe('127.0.0.1')
  })
})
