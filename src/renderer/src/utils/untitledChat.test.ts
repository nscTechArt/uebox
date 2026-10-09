import { describe, expect, it } from 'vitest'
import zhCN from '../i18n/locales/zh-CN'
import enUS from '../i18n/locales/en-US'
import { isUntitledChatTitle, UNTITLED_CHAT_FALLBACK } from './untitledChat'

/**
 * 「旧默认标题仍算未命名」的判断函数。
 *
 * 默认标题换过几轮，老用户存下的对话标题还是旧值；只比对新默认的话它们
 * 会被当成已命名，首条消息不再触发自动起名。这里钉住四类都算「未命名」：
 * 两份语言包的当前默认、四个历史默认、空标题、调用方传入的当前默认。
 */
describe('isUntitledChatTitle', () => {
  it('两份语言包的当前默认标题都算未命名', () => {
    expect(isUntitledChatTitle(zhCN.assistant.chatFlow.unnamedChat)).toBe(true)
    expect(isUntitledChatTitle(enUS.assistant.chatFlow.unnamedChat)).toBe(true)
  })

  it('四个历史默认标题也算未命名', () => {
    expect(isUntitledChatTitle('AI会话')).toBe(true)
    expect(isUntitledChatTitle('Unnamed Session')).toBe(true)
    expect(isUntitledChatTitle('快速对话')).toBe(true)
    expect(isUntitledChatTitle('Quick chat')).toBe(true)
  })

  it('空标题算未命名', () => {
    expect(isUntitledChatTitle(undefined)).toBe(true)
    expect(isUntitledChatTitle('')).toBe(true)
    expect(isUntitledChatTitle('   ')).toBe(true)
  })

  it('带首尾空白的默认标题也算未命名', () => {
    expect(isUntitledChatTitle('AI会话 ')).toBe(true)
    expect(isUntitledChatTitle('  未命名对话')).toBe(true)
    expect(isUntitledChatTitle(' Untitled chat  ')).toBe(true)
  })

  it('等于调用方传入的当前默认标题也算未命名', () => {
    expect(
      isUntitledChatTitle('assistant.chatFlow.unnamedChat', 'assistant.chatFlow.unnamedChat')
    ).toBe(true)
    expect(isUntitledChatTitle('assistant.chatFlow.unnamedChat')).toBe(false)
  })

  it('用户起的标题不算未命名', () => {
    expect(isUntitledChatTitle('Nanite 崩溃排查')).toBe(false)
    expect(isUntitledChatTitle('把主灯 调暗一点')).toBe(false)
  })

  it('兜底值取自中文语言包的 unnamedChat', () => {
    expect(UNTITLED_CHAT_FALLBACK).toBe(zhCN.assistant.chatFlow.unnamedChat)
    expect(isUntitledChatTitle(UNTITLED_CHAT_FALLBACK)).toBe(true)
  })
})
