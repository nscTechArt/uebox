import { describe, expect, it } from 'vitest'

import zhCN from '@renderer/i18n/locales/zh-CN'
import enUS from '@renderer/i18n/locales/en-US'

import {
  IMAGE_TASK_ACTIONS,
  getAvailableImageTaskActions,
  type ImageTaskActionContext
} from './useImageTaskActions'

/** 按 'a.b.c' 取值，用来验证 i18n 里真有这条 */
function lookup(messages: unknown, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>(
      (node, segment) => (node as Record<string, unknown> | undefined)?.[segment],
      messages
    )
}

const COMPLETED: ImageTaskActionContext = { hasImage: true, hasPrompt: true, isCompleted: true }

describe('图片动作清单', () => {
  it('每个动作在中英文里都有文案 —— 菜单里不许出现空白项或裸 key', () => {
    for (const action of IMAGE_TASK_ACTIONS) {
      expect(typeof lookup(zhCN, action.labelKey), `zh-CN 缺 ${action.labelKey}`).toBe('string')
      expect(typeof lookup(enUS, action.labelKey), `en-US 缺 ${action.labelKey}`).toBe('string')
    }
  })

  it('一条生成成功的记录能做全部七件事', () => {
    expect(getAvailableImageTaskActions(COMPLETED).map((action) => action.key)).toEqual([
      'useAsReference',
      'copyImage',
      'download',
      'useParams',
      'copyPrompt',
      'locate',
      'delete'
    ])
  })

  it('失败的记录没有图，但参数、提示词和删除还留着', () => {
    const keys = getAvailableImageTaskActions({
      hasImage: false,
      hasPrompt: true,
      isCompleted: false
    }).map((action) => action.key)

    expect(keys).toEqual(['useParams', 'copyPrompt', 'delete'])
  })

  it('没落进资产库的记录不提供「在资产库中定位」', () => {
    const keys = getAvailableImageTaskActions({ ...COMPLETED, isCompleted: false }).map(
      (action) => action.key
    )

    expect(keys).not.toContain('locate')
  })

  it('删除永远在，且是唯一标红的一项', () => {
    const dangerous = IMAGE_TASK_ACTIONS.filter((action) => action.danger)

    expect(dangerous.map((action) => action.key)).toEqual(['delete'])
    expect(
      getAvailableImageTaskActions({ hasImage: false, hasPrompt: false, isCompleted: false }).map(
        (action) => action.key
      )
    ).toEqual(['delete'])
  })
})
