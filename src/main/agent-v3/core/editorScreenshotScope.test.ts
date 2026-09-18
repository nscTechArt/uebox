/**
 * @vitest-environment node
 *
 * 「允许编辑器截图」这一档的作用域。
 *
 * 测的重点不是 AsyncLocalStorage 会不会存值，而是**这个开关关上之后到底还漏不漏**：
 * 并发的两条会话会不会互相串档、拒绝的话说不说得清怎么放开。前者一旦串了，
 * 表现就是「一条关着截图的会话真的拍了一张」—— 没有任何报错，用户也看不见。
 */

import { describe, expect, it } from 'vitest'

import {
  EDITOR_SCREENSHOT_DEFAULT,
  EDITOR_SCREENSHOT_SKIPPED_NOTE,
  editorScreenshotAllowed,
  editorScreenshotRefusal,
  runWithEditorScreenshotScope,
  VIEWPORT_CAPTURE_TOOLS
} from './editorScreenshotScope'

describe('editorScreenshotAllowed', () => {
  /**
   * 「没人说过话」不能当成「用户关过」。
   *
   * 无头跑、定时任务、调试入口、单元测试都不带这个字段 —— 兜底成禁止的话，
   * 每一个还没接这个字段的入口都会静默失去截图能力，而用户一个开关都没动过。
   */
  it('不在作用域里时按默认档走，而默认档是允许', () => {
    expect(EDITOR_SCREENSHOT_DEFAULT).toBe(true)
    expect(editorScreenshotAllowed()).toBe(true)
  })

  it('作用域里说关就是关', () => {
    expect(runWithEditorScreenshotScope(false, () => editorScreenshotAllowed())).toBe(false)
    expect(runWithEditorScreenshotScope(true, () => editorScreenshotAllowed())).toBe(true)
  })

  /**
   * 这条是整个模块存在的理由。
   *
   * 写成模块级变量的话，两条并发会话里后启动的那个会把前一个的档位覆盖掉，
   * 而被覆盖的后果是一条明确关着截图的会话真的拍了一张 —— 和
   * `projectTargetContext.ts` 里那个「指令静默发到别的工程」是同一类事故。
   */
  it('两条并发的执行流各读各的档位，互不覆盖', async () => {
    const off = runWithEditorScreenshotScope(false, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return editorScreenshotAllowed()
    })
    const on = runWithEditorScreenshotScope(true, async () => editorScreenshotAllowed())

    expect(await Promise.all([off, on])).toEqual([false, true])
  })

  // 子 agent 和并发工具跑在同一条执行流的后代里，不需要各自再传一遍
  it('异步后代继承上层的档位', async () => {
    const nested = await runWithEditorScreenshotScope(false, async () => {
      await Promise.resolve()
      return (async () => editorScreenshotAllowed())()
    })
    expect(nested).toBe(false)
  })
})

describe('VIEWPORT_CAPTURE_TOOLS', () => {
  it('只摘拍视口那一个工具', () => {
    expect([...VIEWPORT_CAPTURE_TOOLS]).toEqual(['ue_screenshot'])
  })

  /**
   * 这两个刻意不在名单里，理由见模块头。断言写在这里是因为「按名字往里加」
   * 是最自然的下一步改动，而两个都会造成真实损失：
   * 试玩被整个摘掉 = 拿隐私开关顺手关掉了「验证游戏能不能跑」；
   * Widget 预览离屏渲染的是模型点名的那个资产，一个像素的隐私都没泄。
   */
  it('试玩和 Widget 预览不在名单里', () => {
    expect(VIEWPORT_CAPTURE_TOOLS.has('ue_playtest')).toBe(false)
    expect(VIEWPORT_CAPTURE_TOOLS.has('widget_preview')).toBe(false)
  })
})

describe('editorScreenshotRefusal', () => {
  const text = editorScreenshotRefusal('抓取编辑器视口截图')

  it('说清楚被挡的是什么', () => {
    expect(text).toContain('抓取编辑器视口截图')
    expect(text).toContain('允许编辑器截图')
  })

  // 少了这一句，模型会拿 Python 或 shell 自己去截一张 —— 那是在绕开用户明确关掉的东西
  it('明说不许换条路绕过去', () => {
    expect(text).toContain('ue_run_python_script')
    expect(text).toContain('run_shell_command')
  })

  // 只说「不许」的话，用户看到的是一次没有下文的失败
  it('给得出替代做法和放开的路径', () => {
    expect(text).toContain('ue_get_actor')
    expect(text).toContain('设置 → AI 助手 → 隐私')
  })

  // 转达与否要交给模型判断：他明确要求看画面就原样转达，顺手想看一眼就别打扰他
  it('告诉模型什么时候该把这段话转达给用户', () => {
    expect(text).toContain('这不是故障，是用户自己设的')
    expect(text).toContain('你自己判断')
  })
})

describe('EDITOR_SCREENSHOT_SKIPPED_NOTE', () => {
  /**
   * 试玩没被挡住，只是不出图。不说清是**用户关的**的话，模型只会看见一份
   * 没有图的报告，然后再调一次 `ue_screenshot` 去补 —— 那次同样会被挡。
   */
  it('说清是用户关的，且试玩本身跑完了', () => {
    expect(EDITOR_SCREENSHOT_SKIPPED_NOTE).toContain('允许编辑器截图')
    expect(EDITOR_SCREENSHOT_SKIPPED_NOTE).toContain('试玩本身照常跑完')
  })
})
