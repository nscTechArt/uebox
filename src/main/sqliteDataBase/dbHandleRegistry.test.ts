/**
 * 后台网络库连接的记账。
 *
 * 红灯用例是第一条：`startAllNetworkServers` 每次切库都会重跑，
 * 原来每次都 `new Database(...)`，而 AssetServer 只是把 map 里的旧条目覆盖掉、
 * 从不 close —— 每切一次库就为每个后台网络库泄漏一个句柄。
 */
import { describe, expect, it, vi } from 'vitest'

import { DbHandleRegistry } from './dbHandleRegistry'

const fakeHandle = (): { close: ReturnType<typeof vi.fn> } => ({ close: vi.fn() })

describe('DbHandleRegistry', () => {
  it('同一个库反复 acquire 只开一次连接', () => {
    const registry = new DbHandleRegistry<{ close: () => void }>()
    const open = vi.fn(fakeHandle)

    const first = registry.acquire('vault_a', open)
    const second = registry.acquire('vault_a', open)
    const third = registry.acquire('vault_a', open)

    // 旧实现：切三次库 = 开三个连接，前两个永远没人关
    expect(open).toHaveBeenCalledTimes(1)
    expect(second).toBe(first)
    expect(third).toBe(first)
    expect(registry.size).toBe(1)
  })

  it('不同的库各开各的', () => {
    const registry = new DbHandleRegistry<{ close: () => void }>()

    registry.acquire('vault_a', fakeHandle)
    registry.acquire('vault_b', fakeHandle)

    expect(registry.size).toBe(2)
  })

  it('release 会关掉连接并销账', () => {
    const registry = new DbHandleRegistry<{ close: () => void }>()
    const handle = fakeHandle()

    registry.acquire('vault_a', () => handle)
    registry.release('vault_a')

    expect(handle.close).toHaveBeenCalledTimes(1)
    expect(registry.has('vault_a')).toBe(false)
  })

  it('release 之后再 acquire 会重新开一个', () => {
    const registry = new DbHandleRegistry<{ close: () => void }>()
    const open = vi.fn(fakeHandle)

    registry.acquire('vault_a', open)
    registry.release('vault_a')
    registry.acquire('vault_a', open)

    expect(open).toHaveBeenCalledTimes(2)
  })

  it('关闭失败也要销账 —— 留着只会让下次拿到一个已死的句柄', () => {
    const onCloseError = vi.fn()
    const registry = new DbHandleRegistry<{ close: () => void }>(onCloseError)

    registry.acquire('vault_a', () => ({
      close: () => {
        throw new Error('EBUSY')
      }
    }))
    expect(() => registry.release('vault_a')).not.toThrow()

    expect(registry.has('vault_a')).toBe(false)
    expect(onCloseError).toHaveBeenCalledWith('vault_a', expect.any(Error))
  })

  it('releaseAll 一个不留', () => {
    const registry = new DbHandleRegistry<{ close: () => void }>()
    const a = fakeHandle()
    const b = fakeHandle()

    registry.acquire('vault_a', () => a)
    registry.acquire('vault_b', () => b)
    registry.releaseAll()

    expect(a.close).toHaveBeenCalledTimes(1)
    expect(b.close).toHaveBeenCalledTimes(1)
    expect(registry.size).toBe(0)
  })

  it('release 一个不存在的库不报错', () => {
    const registry = new DbHandleRegistry<{ close: () => void }>()
    expect(() => registry.release('nope')).not.toThrow()
  })
})
