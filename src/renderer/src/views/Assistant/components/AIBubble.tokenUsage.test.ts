import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import AIBubble from './AIBubble.vue'
import type { AgentTurnUsage } from '@core/shared/agentUsage'

/**
 * 回复下面那一小行 token 用量。
 *
 * 用户要的是「我刚才这一轮花了多少」—— 输入框上那个上下文指示器答不了这个问题：
 * 它是瞬时快照，压缩一次就掉回去，而这一行只增不减，对得上账单。
 */

const usage = (patch: Partial<AgentTurnUsage> = {}): AgentTurnUsage => ({
  input: 12_000,
  output: 480,
  cacheRead: 1024,
  cacheWrite: 96,
  total: 13_600,
  cost: 0.0031,
  ...patch
})

function mountBubble(responseMetadata?: Record<string, unknown>): ReturnType<typeof mount> {
  return mount(AIBubble, {
    props: {
      id: 'msg-1',
      content: '已经改好了',
      status: 'done' as const,
      ...(responseMetadata ? { responseMetadata } : {})
    },
    global: {
      stubs: {
        MarkdownRenderer: true,
        AgentProcessLog: true,
        ThinkingProcess: true,
        ChatModelViewer: true,
        AssetList: true,
        MessageSources: true,
        NavigationButton: true,
        'a-button': true,
        // AppTooltip 默认只在悬浮时渲染 title，这里把两个插槽都摊开好断言明细
        AppTooltip: { template: '<div><slot name="title" /><slot /></div>' }
      }
    }
  })
}

describe('AIBubble 本轮 token 用量', () => {
  it('显示合计与费用', () => {
    const wrapper = mountBubble({ usage: usage() })
    expect(wrapper.find('.token-usage').text()).toBe('14k tokens · $0.0031')
  })

  // 自带 key / 本地模型算不出钱，显示「$0.00」会让人以为是免费额度被扣了
  it('厂商没报费用时只显示 token 数', () => {
    const wrapper = mountBubble({ usage: usage({ cost: 0 }) })
    expect(wrapper.find('.token-usage').text()).toBe('14k tokens')
  })

  it('悬浮明细列出输入 / 输出 / 缓存 / 合计，数字带千分位', () => {
    const wrapper = mountBubble({ usage: usage() })
    const rows = wrapper.findAll('.token-usage-tip-row').map((row) => row.text())

    expect(rows).toEqual([
      '输入12,000',
      '输出480',
      '缓存读取1,024',
      '缓存写入96',
      '合计13,600',
      '费用$0.0031'
    ])
  })

  // 大多数厂商压根不报缓存，列两行 0 只是噪音
  it('没有缓存时不列缓存行', () => {
    const wrapper = mountBubble({ usage: usage({ cacheRead: 0, cacheWrite: 0, total: 12_480 }) })
    const rows = wrapper.findAll('.token-usage-tip-row').map((row) => row.text())

    expect(rows.some((row) => row.startsWith('缓存'))).toBe(false)
  })

  it('这一轮没走到厂商那边时整段不显示，而不是画一个 0', () => {
    expect(mountBubble().find('.token-usage').exists()).toBe(false)
    expect(
      mountBubble({
        usage: usage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 })
      })
        .find('.token-usage')
        .exists()
    ).toBe(false)
  })
})
