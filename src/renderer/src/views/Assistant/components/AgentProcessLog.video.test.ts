import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

import AgentProcessLog from './AgentProcessLog.vue'
import type { AgentProcessItem } from './AgentProcessLog.types'

/**
 * 生成的视频要能在对话窗口里直接播。
 *
 * 视频这一类比截图更需要人眼确认：模型**看不到**自己生成的画面（没有能进上下文
 * 的形式），所以「这一条行不行」只能由用户判断。界面上只留一句
 * 「已存进素材库 C:\...\猫.mp4」的话，用户得自己去翻文件夹 —— 而一次生成
 * 要几分钟、按秒计费，看一眼的成本必须压到零。
 *
 * 播的是**磁盘上那份**（工具返回值里的路径），不是厂商那个临时地址：
 * 后者方舟 24 小时、MiniMax 9 小时就失效，聊天记录翻回来会是个点不开的黑框。
 */

vi.mock('@renderer/services/imageViewer', () => ({
  openSingleImage: vi.fn()
}))

function toolResult(result: unknown, toolName = 'generate_video'): AgentProcessItem {
  return { type: 'tool-result', data: { toolName, result }, timestamp: 1 }
}

function mountLog(items: AgentProcessItem[]): ReturnType<typeof mount> {
  return mount(AgentProcessLog, {
    props: { items, isThinking: false },
    global: { stubs: { MarkdownRenderer: true, 'a-button': true } }
  })
}

describe('过程日志里的生成视频', () => {
  it('把 video_path 渲染成可播放的 video 标签', () => {
    const wrapper = mountLog([
      toolResult({
        success: true,
        video_path: 'C:/vault/AIGC/video/猫跳上桌子.mp4',
        job_id: 'cgt-20260414-abc'
      })
    ])

    const video = wrapper.find('video.report-video')
    expect(video.exists()).toBe(true)
    expect(video.attributes('src')).toContain('%E7%8C%AB')
  })

  /**
   * 不自动播：过程日志会一路往下滚，几条视频同时出声是灾难。
   * preload=metadata：只取首帧和时长，不为一条可能没人点的视频拉几十兆。
   */
  it('带播放控件、不自动播、只预载元数据', () => {
    const wrapper = mountLog([toolResult({ success: true, video_path: 'C:/v/a.mp4' })])

    const video = wrapper.find('video.report-video')
    expect(video.attributes('controls')).toBeDefined()
    expect(video.attributes('autoplay')).toBeUndefined()
    expect(video.attributes('preload')).toBe('metadata')
  })

  it('播不了的扩展名不渲染 —— 免得留一个永远转圈的黑框', () => {
    const wrapper = mountLog([toolResult({ success: true, video_path: 'C:/v/a.avi' })])

    expect(wrapper.find('video.report-video').exists()).toBe(false)
  })

  /**
   * 存盘失败时 `video_path` 不存在，只有厂商的临时地址在正文里。
   * 那个地址**不该**被当成本地资源去播 —— 几小时后就是个死链。
   */
  it('没存下来时不渲染播放器，正文里的临时地址不冒充本地视频', () => {
    const wrapper = mountLog([
      toolResult({ success: true, job_id: 'cgt-1', save_error: '磁盘已满' })
    ])

    expect(wrapper.find('video.report-video').exists()).toBe(false)
  })

  it('图和视频互不干扰：生图那条仍然只出 img', () => {
    const wrapper = mountLog([
      toolResult({ ok: true, image_paths: ['C:/v/a.png'] }, 'generate_image')
    ])

    expect(wrapper.find('img.report-image').exists()).toBe(true)
    expect(wrapper.find('video.report-video').exists()).toBe(false)
  })
})
