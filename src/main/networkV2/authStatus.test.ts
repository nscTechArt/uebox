/**
 * 401 到底该跟用户说哪句话。
 *
 * 这个映射本来根本没被调用过：SyncClient 发了 `auth-required` 事件，
 * 主进程没有任何一处监听，界面只会显示一句含糊的「同步失败」，
 * 用户不知道自己该去填码。
 */
import { describe, it, expect } from 'vitest'

import { authStatusOf } from './SyncClient'

describe('authStatusOf', () => {
  it('服务端说要码 → 提示去填配对码', () => {
    expect(authStatusOf({ statusCode: 401, errorCode: 'AUTH_REQUIRED' })).toBe('authRequired')
  })

  it('服务端说码不对 → 提示码填错了，别让用户以为是自己没填', () => {
    expect(authStatusOf({ statusCode: 401, errorCode: 'AUTH_INVALID' })).toBe('authInvalid')
  })

  it('403 = 码认出来了但权限不够，不是「没填码」', () => {
    expect(authStatusOf({ statusCode: 403 })).toBe('authInvalid')
  })

  it('拿不到 errorCode 时（WS 握手就只有状态码）退回「要填码」', () => {
    expect(authStatusOf({ statusCode: 401 })).toBe('authRequired')
  })
})
