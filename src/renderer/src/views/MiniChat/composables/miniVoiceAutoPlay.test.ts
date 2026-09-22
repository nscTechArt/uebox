import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { effectScope } from 'vue'

import { StorageUtils } from '@renderer/common/utils/storage'
import {
  readVoiceAutoPlayFlag,
  readVoiceBriefingStyle,
  useMiniVoiceAutoPlay
} from './miniVoiceAutoPlay'

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

describe('小窗读播报风格', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  function writeStyle(style: unknown): void {
    localStorage.setItem(
      'ai-config-store',
      StorageUtils.encrypt({ config: { voiceBriefingStyle: style } })
    )
  }

  /** 老配置没这个字段、或存了个认不出的值：按「原文照念」，不能让小窗念不出声 */
  it('没存过、认不出，都按默认档', () => {
    expect(readVoiceBriefingStyle()).toBe('full')
    writeStyle('loud')
    expect(readVoiceBriefingStyle()).toBe('full')
  })

  /** 每次都直接读 localStorage，主窗口改了档位、下一次开念就用新的 */
  it('读到的是主窗口此刻存的那一档', () => {
    writeStyle('concise')
    expect(readVoiceBriefingStyle()).toBe('concise')
    writeStyle('detailed')
    expect(readVoiceBriefingStyle()).toBe('detailed')
  })
})
