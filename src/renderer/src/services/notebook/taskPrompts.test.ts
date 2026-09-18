import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getDefaultPrompt,
  getPrompt,
  getPromptOverrides,
  invalidatePromptCache,
  NOTEBOOK_PROMPT_SLOTS,
  savePromptOverrides,
  slotsForTask
} from './taskPrompts'
import { stubSettingsApi } from './testSettingsStub'

const settings = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  get: vi.fn(),
  set: vi.fn()
}))

beforeEach(() => {
  settings.store.clear()
  settings.get.mockReset()
  settings.set.mockReset()
  settings.get.mockImplementation(async (key: string, fallback: unknown) =>
    settings.store.has(key) ? settings.store.get(key) : fallback
  )
  settings.set.mockImplementation(async (key: string, value: unknown) => {
    settings.store.set(key, value)
    return true
  })

  stubSettingsApi({ get: settings.get, set: settings.set })
  invalidatePromptCache()
})

describe('槽位定义', () => {
  it('七个槽位都有非空的出厂提示词', () => {
    expect(NOTEBOOK_PROMPT_SLOTS).toHaveLength(7)
    for (const slot of NOTEBOOK_PROMPT_SLOTS) {
      expect(slot.defaultPrompt.trim().length).toBeGreaterThan(50)
    }
  })

  it('网页有两段，其余各一段', () => {
    expect(slotsForTask('webpage').map((slot) => slot.id)).toEqual([
      'webpage.analyze',
      'webpage.html'
    ])
    expect(slotsForTask('report').map((slot) => slot.id)).toEqual(['report'])
  })
})

describe('读取提示词', () => {
  it('没改过就用出厂的', async () => {
    await expect(getPrompt('report')).resolves.toBe(getDefaultPrompt('report'))
  })

  it('改过就用改过的', async () => {
    await savePromptOverrides({ report: '只列出可执行步骤' })
    invalidatePromptCache()
    await expect(getPrompt('report')).resolves.toBe('只列出可执行步骤')
  })

  it('设置表读不出来时退回出厂值，不让整次生成失败', async () => {
    settings.get.mockRejectedValueOnce(new Error('数据库没开'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(getPrompt('mindmap')).resolves.toBe(getDefaultPrompt('mindmap'))
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('并发读只打一次设置表', async () => {
    await Promise.all([getPrompt('report'), getPrompt('mindmap'), getPrompt('interview')])
    expect(settings.get).toHaveBeenCalledTimes(1)
  })
})

describe('保存提示词', () => {
  it('和出厂值一样的不落库 —— 落了就等于把这一槽钉死在今天这版', async () => {
    await savePromptOverrides({ report: getDefaultPrompt('report') })
    expect(settings.store.get('notebook_task_prompts')).toEqual({})
  })

  it('空字符串当恢复默认', async () => {
    await savePromptOverrides({ report: '自定义' })
    await savePromptOverrides({ report: '   ' })

    expect(await getPromptOverrides()).toEqual({})
    await expect(getPrompt('report')).resolves.toBe(getDefaultPrompt('report'))
  })

  it('null 当恢复默认', async () => {
    await savePromptOverrides({ mindmap: '自定义' })
    await savePromptOverrides({ mindmap: null })
    expect(await getPromptOverrides()).toEqual({})
  })

  it('改一个槽位不会碰掉别的', async () => {
    await savePromptOverrides({ report: 'A' })
    await savePromptOverrides({ mindmap: 'B' })

    expect(await getPromptOverrides()).toEqual({ report: 'A', mindmap: 'B' })
  })

  it('存完立刻读得到，不用等缓存过期', async () => {
    await savePromptOverrides({ interview: '只出开放题' })
    await expect(getPrompt('interview')).resolves.toBe('只出开放题')
  })

  it('读失败不写缓存，下次还会再问一遍', async () => {
    settings.get.mockRejectedValueOnce(new Error('数据库忙'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    settings.store.set('notebook_task_prompts', { report: '我写的报告提示词' })

    // 第一次读失败，退回出厂默认
    await expect(getPrompt('report')).resolves.toBe(getDefaultPrompt('report'))
    // 第二次要真的重新问，而不是拿着上次的空壳
    await expect(getPrompt('report')).resolves.toBe('我写的报告提示词')
    warn.mockRestore()
  })

  it('一次读失败之后保存，不会把没在编辑范围内的槽位抹掉', async () => {
    settings.store.set('notebook_task_prompts', {
      report: '我写的报告提示词',
      mindmap: '我写的导图提示词'
    })

    // 缓存被一次失败污染成空壳
    settings.get.mockRejectedValueOnce(new Error('数据库忙'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await getPrompt('report')
    warn.mockRestore()

    // 用户只改了报告那一段
    await savePromptOverrides({ report: '改过的报告提示词' })

    // 导图那段必须还在 —— 编辑器从没展示过它，用户也没有撤销入口
    expect(settings.store.get('notebook_task_prompts')).toEqual({
      report: '改过的报告提示词',
      mindmap: '我写的导图提示词'
    })
  })

  it('认不出来的槽位 id 一律忽略', async () => {
    await savePromptOverrides({ nonsense: 'x' } as never)
    expect(await getPromptOverrides()).toEqual({})
  })

  it('库里存着的旧键在读取时被丢掉', async () => {
    settings.store.set('notebook_task_prompts', { report: 'A', removedSlot: 'B' })
    invalidatePromptCache()

    expect(await getPromptOverrides()).toEqual({ report: 'A' })
  })
})
