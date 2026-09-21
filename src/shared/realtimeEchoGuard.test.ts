/** @vitest-environment node */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_REALTIME_ECHO_GUARD,
  REALTIME_ECHO_GUARDS,
  normalizeRealtimeEchoGuard
} from './realtimeEchoGuard'

describe('normalizeRealtimeEchoGuard', () => {
  it('认识的档位原样返回', () => {
    for (const guard of REALTIME_ECHO_GUARDS) {
      expect(normalizeRealtimeEchoGuard(guard)).toBe(guard)
    }
  })

  /**
   * 这个值从渲染层的 localStorage 经 IPC 过来，可能是旧版本存的、也可能被手改过。
   * 认不出时**必须回默认档**，不能放行 —— 一个不认识的门限字符串发进首帧，
   * 服务端回一条 error，而渲染层收到 error 会掐掉整通电话。
   */
  it.each([undefined, null, '', 'loud', 42, {}])('认不出的 %s 回默认档', (value) => {
    expect(normalizeRealtimeEchoGuard(value)).toBe(DEFAULT_REALTIME_ECHO_GUARD)
  })
})
