import { describe, expect, it, vi } from 'vitest'

import { BotRpcError, createBotRpc, waitForPlay, type RawCall } from './rpc'

describe('createBotRpc', () => {
  it('每个方法映射到对应的插件命令和参数', async () => {
    const call = vi.fn<RawCall>(async () => ({ ok: true, has_navmesh: false }))
    const rpc = createBotRpc(call)

    await rpc.observe({ targets: ['BP_Door'], logSince: 7 })
    await rpc.setView(90)
    await rpc.click('W/Btn')
    await rpc.navPath({ randomRadius: 2000 })
    await rpc.navPath({ to: { x: 1, y: 2, z: 3 } })
    await rpc.stop('done')

    expect(call.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ['pie.observe', { include_widgets: true, targets: ['BP_Door'], log_since: 7 }],
      ['pie.set_view', { yaw: 90 }],
      ['pie.click_widget', { id: 'W/Btn' }],
      ['pie.nav_path', { random_radius: 2000 }],
      ['pie.nav_path', { to: { x: 1, y: 2, z: 3 } }],
      ['pie.stop', { reason: 'done' }]
    ])
  })

  it('注入的超时跟着帧数走，按住得越久等得越久', async () => {
    const call = vi.fn<RawCall>(async () => ({ ok: true }))
    const rpc = createBotRpc(call)
    await rpc.injectAction({ action: 'IA_Move', y: 1, frames: 600 })
    expect(call.mock.calls[0][2]).toBeGreaterThanOrEqual(600 * 60)
  })

  it('插件回 409「没在运行」时抛出可识别的「游戏已停」', async () => {
    const rpc = createBotRpc(async () => ({ ok: false, error: 'Play is not running.', code: 409 }))
    const error = await rpc.observe({}).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(BotRpcError)
    expect((error as BotRpcError).playEnded).toBe(true)
  })

  it('其他失败不算「游戏已停」', async () => {
    const rpc = createBotRpc(async () => ({
      ok: false,
      error: 'Button "x" is disabled',
      code: 409
    }))
    const error = (await rpc.click('x').catch((e: unknown) => e)) as BotRpcError
    expect(error.playEnded).toBe(false)
  })
})

describe('waitForPlay', () => {
  const noSleep = (): Promise<void> => Promise.resolve()

  it('PIE 起来之前的 409 是「还没到」，接着等', async () => {
    let calls = 0
    const rpc = createBotRpc(async () =>
      ++calls < 3
        ? { ok: false, error: 'Play is not running.', code: 409 }
        : { ok: true, playing: true, session_active: true }
    )
    expect(await waitForPlay(rpc, () => false, undefined, 10_000, noSleep)).toBe('ready')
  })

  it('用户自己按的 Play（不是 pie.run 起的）不算，绝不去操作它', async () => {
    const rpc = createBotRpc(async () => ({ ok: true, playing: true, session_active: false }))
    expect(await waitForPlay(rpc, () => false, undefined, 2_000, noSleep)).toBe('not_started')
  })

  it('插件太旧没有 pie.observe：当场说出来，不等满超时', async () => {
    const rpc = createBotRpc(async () => ({
      ok: false,
      error: 'Unknown method: pie.observe',
      code: 404
    }))
    expect(await waitForPlay(rpc, () => false, undefined, 60_000, noSleep)).toBe('plugin_too_old')
  })

  it('pie.run 已经回来了（起不来 / 编辑器已在 Play）就不再等', async () => {
    const rpc = createBotRpc(async () => ({ ok: false, error: 'Play is not running.', code: 409 }))
    expect(await waitForPlay(rpc, () => true, undefined, 60_000, noSleep)).toBe('not_started')
  })
})
