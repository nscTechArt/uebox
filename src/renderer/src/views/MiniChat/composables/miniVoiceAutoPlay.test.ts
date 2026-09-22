import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { effectScope } from 'vue'

import { StorageUtils } from '@renderer/common/utils/storage'
import { readVoiceAutoPlayFlag, useMiniVoiceAutoPlay } from './miniVoiceAutoPlay'

/**
 * 小窗的自动朗读开关直接读 localStorage，不碰 store —— 主窗口拨了开关，小窗要跟着变，
 * 但不能反过来把小窗手里的旧配置写回去。
 */

function writeFlag(enabled: boolean): void {
  localStorage.setItem(
    'ai-config-store',
    StorageUtils.encrypt({ config: { voiceAutoPlayEnabled: enabled } })
  )
}

describe('小窗读自动朗读开关', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  it('没存过、存的是坏数据，都当关', () => {
    expect(readVoiceAutoPlayFlag()).toBe(false)
    localStorage.setItem('ai-config-store', '{not-base64')
    expect(readVoiceAutoPlayFlag()).toBe(false)
  })

  it('读到的是主窗口 store 持久化的那一份', () => {
    writeFlag(true)
    expect(readVoiceAutoPlayFlag()).toBe(true)
    writeFlag(false)
    expect(readVoiceAutoPlayFlag()).toBe(false)
  })

  it('别的窗口改了开关，这边跟着变；作用域一撤就不再听', () => {
    writeFlag(false)
    const scope = effectScope()
    const enabled = scope.run(() => useMiniVoiceAutoPlay())!
    expect(enabled.value).toBe(false)

    writeFlag(true)
    window.dispatchEvent(new StorageEvent('storage', { key: 'ai-config-store' }))
    expect(enabled.value).toBe(true)

    // 无关的 key 不惊动它
    writeFlag(false)
    window.dispatchEvent(new StorageEvent('storage', { key: 'something-else' }))
    expect(enabled.value).toBe(true)

    scope.stop()
    window.dispatchEvent(new StorageEvent('storage', { key: 'ai-config-store' }))
    expect(enabled.value).toBe(true)
  })
})
