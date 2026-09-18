import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

import AgentProcessLog from './AgentProcessLog.vue'
import type { AgentProcessItem } from './AgentProcessLog.types'

/**
 * 截图 / 预览类工具渲染出来的图，用户得能看见。
 *
 * 以前它只进模型上下文：界面上只有一行「Widget 预览已渲染（1920x1080），图见附件」，
 * 而那个「附件」用户根本打不开 —— UI 迭代恰恰是最该人眼确认的场景，人却被排除在外。
 *
 * 显示的是磁盘上那张原图（工具返回值里的路径），不是进上下文的压缩版：
 * 后者为省 token 压到了 768px，而且不发到渲染层。
 */

vi.mock('@renderer/services/imageViewer', () => ({
  openSingleImage: vi.fn()
}))

function toolResult(result: unknown, toolName = 'widget_preview'): AgentProcessItem {
  return { type: 'tool-result', data: { toolName, result }, timestamp: 1 }
}

function mountLog(items: AgentProcessItem[]): ReturnType<typeof mount> {
  return mount(AgentProcessLog, {
    props: { items, isThinking: false },
    global: {
      stubs: {
        MarkdownRenderer: true,
        'a-button': true
      }
    }
  })
}

describe('过程日志里的工具产出图', () => {
  it('把 screenshot_path 显示成缩略图', () => {
    const wrapper = mountLog([
      toolResult({
        ok: true,
        screenshot_path: 'I:/UE/Saved/Screenshots/UAL/WBP_Battery.png',
        message: 'Widget 预览已渲染（1920x1080）'
      })
    ])

    const image = wrapper.find('img.report-image')
    expect(image.exists()).toBe(true)
    // 必须走 local-resource 协议：dev 模式下 file:/// 子资源会被 Chromium 拒掉
    expect(image.attributes('src')).toBe(
      'local-resource://I:/UE/Saved/Screenshots/UAL/WBP_Battery.png'
    )
  })

  // 生图一次可以出好几张，只显示第一张等于把用户花钱买的另外三张藏了
  it('生图的 image_paths 一次显示多张', () => {
    const wrapper = mountLog([
      toolResult(
        {
          success: true,
          path: 'H:/素材库/AIGC/图片/a.png',
          image_paths: ['H:/素材库/AIGC/图片/a.png', 'H:/素材库/AIGC/图片/b.png'],
          message: '出了 2 张图'
        },
        'generate_image'
      )
    ])

    expect(wrapper.findAll('img.report-image')).toHaveLength(2)
  })

  it('老截图工具的 path 字段同样认', () => {
    const wrapper = mountLog([
      toolResult(
        { success: true, path: 'I:/UE/Saved/UAShot.png', message: '截图已成功获取' },
        'ue_screenshot'
      )
    ])

    expect(wrapper.find('img.report-image').exists()).toBe(true)
  })

  // `path` 这个名字太泛，一堆工具用它指资产路径 —— 只有图片扩展名才当图
  it('不是图片的 path 不当图显示', () => {
    const wrapper = mountLog([
      toolResult(
        { success: true, path: '/Game/UI/WBP_Battery', message: '已创建' },
        'widget_create'
      )
    ])

    expect(wrapper.find('img.report-image').exists()).toBe(false)
  })

  it('相对路径定位不到真实文件，不显示', () => {
    const wrapper = mountLog([
      toolResult({ success: true, path: 'Screenshots/a.png', message: '好了' })
    ])

    expect(wrapper.find('img.report-image').exists()).toBe(false)
  })

  it('没有图的普通工具结果照旧只有一行字', () => {
    const wrapper = mountLog([toolResult({ success: true, message: '已删除 3 个 Actor' })])

    expect(wrapper.find('img.report-image').exists()).toBe(false)
    expect(wrapper.text()).toContain('已删除 3 个 Actor')
  })

  // 文件被移走或删掉之后不该留一个碎图图标
  it('图加载失败后就不再占位', async () => {
    const wrapper = mountLog([
      toolResult({ ok: true, screenshot_path: 'I:/UE/Saved/gone.png', message: '预览已渲染' })
    ])

    await wrapper.find('img.report-image').trigger('error')

    expect(wrapper.find('img.report-image').exists()).toBe(false)
    // 那一行文字还在，只是没图
    expect(wrapper.text()).toContain('预览已渲染')
  })

  it('点击缩略图打开大图查看器', async () => {
    const { openSingleImage } = await import('@renderer/services/imageViewer')
    const wrapper = mountLog([
      toolResult({ ok: true, screenshot_path: 'I:/UE/Saved/shot.png', message: '预览已渲染' })
    ])

    await wrapper.find('img.report-image').trigger('click')

    expect(openSingleImage).toHaveBeenCalledWith(
      'local-resource://I:/UE/Saved/shot.png',
      expect.any(String)
    )
  })
})
