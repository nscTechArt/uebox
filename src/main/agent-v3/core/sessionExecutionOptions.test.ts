import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const root = mkdtempSync(join(tmpdir(), 'agent-v3-options-'))
vi.mock('electron', () => ({ app: { getPath: (): string => root } }))

import {
  copyExecutionOptions,
  deleteExecutionOptions,
  loadExecutionOptions,
  resumeExecutionOptions,
  saveExecutionOptions
} from './sessionExecutionOptions'

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('会话执行配置', () => {
  it('目标、复核次数和上次卡点可以跨进程重新读取', async () => {
    const goal = {
      objective: '完成用户目标',
      rounds: 4,
      lastFailReason: '缺验证',
      mutations: ['blueprint_compile'],
      settled: false
    }
    await saveExecutionOptions('goal', { mode: 'agent', goal })
    expect((await loadExecutionOptions('goal'))?.goal).toEqual(goal)
    await copyExecutionOptions('goal', 'goal-copy')
    expect((await loadExecutionOptions('goal-copy'))?.goal).toEqual(goal)
  })
  it('重新读取后继续保留只读、知识库和思考/技能设置', async () => {
    const options = {
      mode: 'ask',
      thinkingLevel: 'max',
      skillLearning: 'off',
      notebook: { id: 'book', title: '资料' }
    } as const
    await saveExecutionOptions('original', options)
    expect(resumeExecutionOptions(await loadExecutionOptions('original'), 'agent')).toEqual(options)
    await copyExecutionOptions('original', 'copy')
    await deleteExecutionOptions('original')
    expect(await loadExecutionOptions('original')).toBeUndefined()
    expect(await loadExecutionOptions('copy')).toEqual(options)
  })

  /**
   * 「允许编辑器截图」也要跨进程记住。
   *
   * 「从断点继续」那条路不经过渲染层，args 里没有这个字段 —— 不落盘的话，
   * 用户点一下「接着跑」，半程就重新长出了他明确关掉的截图能力。
   */
  it('编辑器截图这一档跟着执行记录走，续跑不会重新长出来', async () => {
    await saveExecutionOptions('shots-off', { mode: 'agent', editorScreenshotEnabled: false })

    expect((await loadExecutionOptions('shots-off'))?.editorScreenshotEnabled).toBe(false)
    expect(
      resumeExecutionOptions(await loadExecutionOptions('shots-off')).editorScreenshotEnabled
    ).toBe(false)
  })

  /**
   * 缺省时**不在 zod 里补默认**：兜底只有 `EDITOR_SCREENSHOT_DEFAULT` 那一份。
   * 在这里写 `.default(true)` 等于再抄一份默认，和主进程、渲染层那两份迟早漂移。
   */
  it('存量记录里没有这一档时保持缺省，交给读取方兜底', async () => {
    await saveExecutionOptions('legacy', { mode: 'agent' })

    const loaded = await loadExecutionOptions('legacy')
    expect(loaded?.editorScreenshotEnabled).toBeUndefined()
  })

  it('旧会话没有配置时默认只读，显式普通模式可恢复普通任务', () => {
    expect(resumeExecutionOptions(undefined).mode).toBe('ask')
    expect(resumeExecutionOptions(undefined, 'agent').mode).toBe('agent')
    expect(resumeExecutionOptions({ mode: 'agent' }, 'ask').mode).toBe('ask')
  })

  it('损坏的权限配置不能当成没配置而放行', async () => {
    await saveExecutionOptions('broken', { mode: 'ask' })
    writeFileSync(join(root, 'agent-v3-sessions', 'broken.execution.json'), '{broken')
    await expect(loadExecutionOptions('broken')).rejects.toThrow()
  })
})
