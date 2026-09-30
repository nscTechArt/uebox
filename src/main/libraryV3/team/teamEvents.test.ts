// @vitest-environment node
/**
 * 通知流（契约 4.12）：`notification` 是给人看的那一条，`project` 只说「该重新取了」；
 * 连上算在线，401 不重连（等重新登录）。
 */
import { describe, expect, it, vi } from 'vitest'
import type { CatalogHttp } from '../http'
import { CatalogHttpError } from '../http'
import { TeamStream } from './teamEvents'

describe('team stream', () => {
  it('passes notifications and project hints on', () => {
    const onNotification = vi.fn()
    const onProject = vi.fn()
    const stream = new TeamStream({ onNotification, onProject, onState: vi.fn() })
    stream.handle(
      'notification',
      JSON.stringify({
        id: '1',
        kind: 'ask.received',
        project: 'xinghai',
        at: 1,
        key: 'k',
        data: {}
      })
    )
    stream.handle('project', JSON.stringify({ project: 'xinghai', what: ['freeze', 3] }))
    stream.handle('hello', JSON.stringify({ member: 'ajie', unread: 0 }))
    stream.handle('notification', 'not json')
    expect(onNotification).toHaveBeenCalledTimes(1)
    expect(onNotification.mock.calls[0][0]).toMatchObject({ kind: 'ask.received' })
    expect(onProject).toHaveBeenCalledWith('xinghai', ['freeze'])
  })

  it('does nothing until it has a signed-in client', () => {
    const stream = new TeamStream({ onNotification: vi.fn(), onProject: vi.fn(), onState: vi.fn() })
    stream.start()
    expect(stream.connected).toBe(false)
  })

  it('is online while the stream is open and stops retrying when signed out', () => {
    const onState = vi.fn()
    let end: ((error: CatalogHttpError | null) => void) | null = null
    const http = {
      stream: (
        _path: string,
        options: { onOpen: () => void; onEnd: (e: CatalogHttpError | null) => void }
      ) => {
        options.onOpen()
        end = options.onEnd
        return () => undefined
      }
    } as unknown as CatalogHttp
    const setTimer = vi.fn()
    const stream = new TeamStream({
      http,
      onNotification: vi.fn(),
      onProject: vi.fn(),
      onState,
      setTimer: setTimer as unknown as (fn: () => void, ms: number) => NodeJS.Timeout
    })
    stream.start()
    expect(stream.connected).toBe(true)
    end!(new CatalogHttpError('unauthorized', 401, 'expired'))
    expect(stream.connected).toBe(false)
    expect(stream.signedOut).toBe(true)
    expect(setTimer).not.toHaveBeenCalled()
    expect(onState).toHaveBeenLastCalledWith(false, true)
  })

  it('reconnects with back-off after a network drop', () => {
    let calls = 0
    let end: ((error: CatalogHttpError | null) => void) | null = null
    const http = {
      stream: (
        _path: string,
        options: { onOpen: () => void; onEnd: (e: CatalogHttpError | null) => void }
      ) => {
        calls += 1
        end = options.onEnd
        return () => undefined
      }
    } as unknown as CatalogHttp
    const timers: number[] = []
    const stream = new TeamStream({
      http,
      onNotification: vi.fn(),
      onProject: vi.fn(),
      onState: vi.fn(),
      setTimer: ((fn: () => void, ms: number) => {
        timers.push(ms)
        fn()
        return 0 as unknown as NodeJS.Timeout
      }) as (fn: () => void, ms: number) => NodeJS.Timeout
    })
    stream.start()
    end!(new CatalogHttpError('network', 0, 'reset'))
    end!(new CatalogHttpError('network', 0, 'reset'))
    expect(calls).toBe(3)
    expect(timers).toEqual([2000, 4000])
    stream.stop()
  })
})
