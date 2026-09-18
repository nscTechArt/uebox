import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

import AgentProcessLog from './AgentProcessLog.vue'
import type { AgentProcessItem } from './AgentProcessLog.types'

/**
 * agent **看过**的图（`read_local_file` 读到图片）。
 *
 * 以前聊天里只剩一行「Read image file [image/png]」—— 模型看见了，人没看见，
 * 用户没法判断它到底在看什么、看清没有。
 *
 * 和工具产出的图分开处理：产出的图立刻铺开，看过的图默认收起 ——
 * 一轮里 agent 可能连着看十几张，全铺开会把过程日志淹掉。
 */

vi.mock('@renderer/services/imageViewer', () => ({
  openSingleImage: vi.fn()
}))

function readResult(result: unknown): AgentProcessItem {
  return { type: 'tool-result', data: { toolName: 'read_local_file', result }, timestamp: 1 }
}

function mountLog(items: AgentProcessItem[]): ReturnType<typeof mount> {
  return mount(AgentProcessLog, {
    props: { items, isThinking: false },
    global: { stubs: { MarkdownRenderer: true, 'a-button': true } }
  })
}

describe('过程日志里 agent 看过的图', () => {
  it('默认收起，只给一个入口，不去读盘', () => {
    const wrapper = mountLog([
      readResult({ message: '看了图片 a.png', viewed_image_path: 'H:/refs/a.png' })
    ])

    expect(wrapper.find('button.peek-toggle').exists()).toBe(true)
    expect(wrapper.find('img.report-image').exists()).toBe(false)
  })

  it('点一下才加载出来，走 local-resource 协议', async () => {
    const wrapper = mountLog([
      readResult({ message: '看了图片 a.png', viewed_image_path: 'H:/refs/a.png' })
    ])

    await wrapper.find('button.peek-toggle').trigger('click')

    const image = wrapper.find('img.report-image')
    expect(image.exists()).toBe(true)
    // dev 模式下 file:/// 子资源会被 Chromium 拒掉，必须走特权协议
    expect(image.attributes('src')).toBe('local-resource://H:/refs/a.png')
  })

  it('再点一下收起来', async () => {
    const wrapper = mountLog([
      readResult({ message: '看了图片 a.png', viewed_image_path: 'H:/refs/a.png' })
    ])

    await wrapper.find('button.peek-toggle').trigger('click')
    await wrapper.find('button.peek-toggle').trigger('click')

    expect(wrapper.find('img.report-image').exists()).toBe(false)
  })

  it('展开后点缩略图打开大图查看器', async () => {
    const { openSingleImage } = await import('@renderer/services/imageViewer')
    const wrapper = mountLog([
      readResult({ message: '看了图片 a.png', viewed_image_path: 'H:/refs/a.png' })
    ])

    await wrapper.find('button.peek-toggle').trigger('click')
    await wrapper.find('img.report-image').trigger('click')

    expect(openSingleImage).toHaveBeenCalledWith(
      'local-resource://H:/refs/a.png',
      expect.any(String)
    )
  })

  // 读文本文件的那绝大多数次，不该多出一个点不出东西的按钮
  it('读的不是图就没有这个入口', () => {
    const wrapper = mountLog([readResult({ message: '读了 DefaultEngine.ini' })])

    expect(wrapper.find('button.peek-toggle').exists()).toBe(false)
  })
})
