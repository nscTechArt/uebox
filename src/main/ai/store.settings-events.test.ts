/** @vitest-environment node */
import { mkdtempSync, promises as fsPromises, readdirSync, readFileSync, writeFileSync } from 'fs'
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

describe('updateSettings：读改写排队', () => {
  it('两个同时改的都生效：后一个拿到的是前一个写完的配置，不是旧快照', async () => {
    const { updateSettings } = await import('./store')
    writeConfig('tripo')
    await Promise.all([
      updateSettings((current) => ({
        ...current,
        roles: { ...current.roles, chat: { providerId: 'tripo', modelId: 'v3.1-20260211' } }
      })),
      updateSettings((current) => ({
        ...current,
        roles: { ...current.roles, summary: { providerId: 'tripo', modelId: 'v3.1-20260211' } }
      }))
    ])
    const roles = (await readSettings()).roles
    expect(roles.chat?.providerId).toBe('tripo')
    expect(roles.summary?.providerId).toBe('tripo')
    expect(roles.model3d?.providerId).toBe('tripo')
  })

  it('原样返回同一个对象：不写盘、不发变更通知', async () => {
    const { updateSettings } = await import('./store')
    writeConfig('tripo')
    await readSettings()
    const listener = vi.fn()
    const off = onSettingsChanged(listener)
    await updateSettings((current) => current)
    off()
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('writeSettings：先写临时文件再替换', () => {
  it('写完不留 .tmp；change 抛错不堵住后面的写', async () => {
    const { updateSettings } = await import('./store')
    writeConfig('tripo')
    await expect(
      updateSettings(() => {
        throw new Error('坏了')
      })
    ).rejects.toThrow('坏了')
    await updateSettings((current) => ({ ...current, roles: {} }))
    expect(readdirSync(userData).filter((name) => name.endsWith('.tmp'))).toEqual([])
    expect((await readSettings()).roles).toEqual({})
  })

  it('改名被占用（EPERM）：重试几次后退回原地写，保存照样成功', async () => {
    const { updateSettings } = await import('./store')
    writeConfig('tripo')
    const rename = vi
      .spyOn(fsPromises, 'rename')
      .mockRejectedValue(Object.assign(new Error('EPERM'), { code: 'EPERM' }))
    let attempts = 0
    try {
      await updateSettings((current) => ({ ...current, roles: {} }))
      attempts = rename.mock.calls.length
    } finally {
      rename.mockRestore()
    }
    expect(attempts).toBe(3)
    expect(JSON.parse(readFileSync(settingsPath(), 'utf-8')).roles).toEqual({})
    expect(readdirSync(userData).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('读盘途中有人写过：不拿读回来的旧内容盖掉新缓存', async () => {
    const { updateSettings } = await import('./store')
    writeConfig('tripo')
    const realRead = fsPromises.readFile.bind(fsPromises)
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const read = vi.spyOn(fsPromises, 'readFile').mockImplementationOnce((async (
      ...args: Parameters<typeof fsPromises.readFile>
    ) => {
      const content = await realRead(...args)
      await gate
      return content
    }) as typeof fsPromises.readFile)
    try {
      invalidateSettingsCache()
      const slow = readSettings()
      await vi.waitFor(() => expect(read).toHaveBeenCalled())
      await updateSettings((current) => ({ ...current, roles: {} }))
      release()
      expect((await slow).roles).toEqual({})
      expect((await readSettings()).roles).toEqual({})
    } finally {
      release()
      read.mockRestore()
    }
  })
})
