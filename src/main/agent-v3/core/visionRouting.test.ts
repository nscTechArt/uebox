/** @vitest-environment node */
import { describe, expect, it } from 'vitest'

import type { AgentMessage } from '@earendil-works/pi-agent-core'

import { currentTurnHasImages } from './visionRouting'

const user = (text: string): AgentMessage =>
  ({ role: 'user', content: [{ type: 'text', text }], timestamp: 0 }) as unknown as AgentMessage

const userWithImage = (text: string): AgentMessage =>
  ({
    role: 'user',
    content: [
      { type: 'text', text },
      { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }
    ],
    timestamp: 0
  }) as unknown as AgentMessage

const assistant = (text: string): AgentMessage =>
  ({
    role: 'assistant',
    content: [{ type: 'text', text }],
    stopReason: 'endTurn',
    timestamp: 0
  }) as unknown as AgentMessage

const toolResult = (withImage = false): AgentMessage =>
  ({
    role: 'toolResult',
    content: withImage
      ? [{ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }]
      : [{ type: 'text', text: '找到 3 个资产' }],
    timestamp: 0
  }) as unknown as AgentMessage

describe('currentTurnHasImages', () => {
  it('这一轮用户贴了图 → 走视觉', () => {
    expect(currentTurnHasImages([userWithImage('这个怎么用啊')])).toBe(true)
  })

  it('纯文本的一轮不动用视觉模型', () => {
    expect(currentTurnHasImages([user('打开 test222')])).toBe(false)
  })

  // 截图类工具把图片直接塞进 toolResult，续跑时同样要看得见
  it('工具结果里的图片也算', () => {
    expect(currentTurnHasImages([user('看看编辑器'), toolResult(true)])).toBe(true)
  })

  /**
   * pi 每次都会把整条 transcript 发出去，所以历史里的图确实也会被文本模型
   * 换成占位符。但据此把整条会话永久钉在视觉模型上是过度反应 ——
   * 五轮前那张图早就答过了，正在问的这句才是要伺候的对象。
   */
  it('上一轮的图不影响这一轮的选型', () => {
    const transcript = [userWithImage('这是什么'), assistant('是个蓝图'), user('那怎么用')]
    expect(currentTurnHasImages(transcript)).toBe(false)
  })

  it('上一轮答完之后这一轮又贴了图 → 还是走视觉', () => {
    const transcript = [userWithImage('这是什么'), assistant('是个蓝图'), userWithImage('那这个呢')]
    expect(currentTurnHasImages(transcript)).toBe(true)
  })

  it('空 transcript 不炸', () => {
    expect(currentTurnHasImages([])).toBe(false)
  })

  it('content 是纯字符串（pi 允许）时不误判', () => {
    const plain = { role: 'user', content: '你好', timestamp: 0 } as unknown as AgentMessage
    expect(currentTurnHasImages([plain])).toBe(false)
  })
})
