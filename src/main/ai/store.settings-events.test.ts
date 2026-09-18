/** @vitest-environment node */
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * 配置的**同步读**和**变更通知**。
 *
 * 两件事都是被同一个需求逼出来的：`generate_3d_model` 的入参表取决于用户给
 * 「3D 生成」绑的是哪家厂商（厂商特供开关只对绑了那一家的人暴露），而工具注册
 * 是同步的、结果还会被全局缓存。同步读解决「造工具那一刻读不到配置」，
 * 变更通知解决「换完厂商要重启才生效」。
 */

const userData = mkdtempSync(join(tmpdir(), 'uebox-ai-store-'))

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const { readSettings, readSettingsSync, invalidateSettingsCache, onSettingsChanged, settingsPath } =
  await import('./store')

function writeConfig(providerId: string): void {
  writeFileSync(
    settingsPath(),
    JSON.stringify({
      version: 3,
      providers: [
        {
          id: providerId,
          kind: 'model3d',
          model3dApi: 'tripo',
          protocol: 'openai-completions',
          baseUrl: 'https://openapi.tripo3d.ai/v3',
          models: [{ id: 'v3.1-20260211' }]
        }
      ],
      roles: { model3d: { providerId, modelId: 'v3.1-20260211' } }
    }),
    'utf-8'
  )
}

beforeEach(() => {
  invalidateSettingsCache()
})

describe('同步读配置', () => {
  it('文件不存在时给一份空配置，不抛', () => {
    expect(readSettingsSync().providers).toEqual([])
  })

  it('读得出磁盘上的配置', () => {
    writeConfig('tripo')

    expect(readSettingsSync().roles.model3d?.providerId).toBe('tripo')
  })

  /** 与异步版共用一份缓存 —— 否则两条路会各读一次盘，还可能读出两份不同的东西 */
  it('和异步版共用缓存', async () => {
    writeConfig('tripo')
    const sync = readSettingsSync()

    expect(await readSettings()).toBe(sync)
  })

  it('作废之后再读拿到的是新写进去的那份', async () => {
    writeConfig('tripo')
    expect(readSettingsSync().providers[0].id).toBe('tripo')

    writeConfig('another-tripo')
    invalidateSettingsCache()

    expect(readSettingsSync().providers[0].id).toBe('another-tripo')
  })
})

describe('配置变更通知', () => {
  it('配置作废时通知订阅者', () => {
    const seen = vi.fn()
    const unsubscribe = onSettingsChanged(seen)

    invalidateSettingsCache()

    expect(seen).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('退订之后不再收到', () => {
    const seen = vi.fn()
    onSettingsChanged(seen)()

    invalidateSettingsCache()

    expect(seen).not.toHaveBeenCalled()
  })

  /** 订阅者自己的问题不该把「保存配置」这件事带崩 */
  it('一个订阅者抛错不影响其它订阅者', () => {
    const seen = vi.fn()
    const unsubscribeBad = onSettingsChanged(() => {
      throw new Error('订阅者坏了')
    })
    const unsubscribeGood = onSettingsChanged(seen)

    expect(() => invalidateSettingsCache()).not.toThrow()
    expect(seen).toHaveBeenCalledTimes(1)

    unsubscribeBad()
    unsubscribeGood()
  })
})
