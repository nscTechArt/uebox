/** @vitest-environment node */
import { describe, expect, it } from 'vitest'

import { trayOpenOutcome } from './openOutcome'

/**
 * 点「最近项目」的四种结局：
 * - 文件没了 → 「工程文件已经不在了」（不拿 error 原文，那是写死的中文）
 * - 别的失败 → 标题 + error 原文
 * - 开了但插件没装上 → 通知点击要派 plugin-failure 给界面
 * - 干干净净开了 → 不弹通知
 */

const t = (key: string, params?: Record<string, string | number>): string =>
  params ? `${key}(${Object.values(params).join(',')})` : key

const project = { name: 'Demo', originPath: 'D:/Demo/Demo.uproject' }

describe('打开工程的结果 → 托盘通知', () => {
  it('工程文件没了：专门的 missing 文案，不带界面动作', () => {
    const outcome = trayOpenOutcome(
      { success: false, error: '工程文件不存在', pathNotFound: true },
      project,
      t
    )

    expect(outcome).toEqual({
      title: 'tray.openFailedTitle',
      body: 'tray.openFailedMissing(Demo)'
    })
  })

  it('别的失败：error 原文带上，不带界面动作', () => {
    const outcome = trayOpenOutcome({ success: false, error: 'os said no' }, project, t)

    expect(outcome).toEqual({
      title: 'tray.openFailedTitle',
      body: 'tray.openFailedBody(Demo,os said no)'
    })
  })

  it('失败但 error 缺省：空串兜底', () => {
    const outcome = trayOpenOutcome({ success: false }, project, t)

    expect(outcome?.body).toBe('tray.openFailedBody(Demo,)')
  })

  it('打开了但插件没装上：点击通知把 plugin-failure 派给界面', () => {
    const outcome = trayOpenOutcome({ success: true, pluginFailure: 'ENOENT' }, project, t)

    expect(outcome).toEqual({
      title: 'tray.pluginFailedTitle',
      body: 'tray.pluginFailedBody',
      action: {
        type: 'plugin-failure',
        pluginFailure: 'ENOENT',
        originPath: 'D:/Demo/Demo.uproject',
        projectName: 'Demo'
      }
    })
  })

  it('干干净净打开了：不弹通知', () => {
    expect(trayOpenOutcome({ success: true }, project, t)).toBeNull()
  })
})
