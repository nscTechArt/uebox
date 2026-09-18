import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import AIBubble from './AIBubble.vue'
import type { AgentProcessItem } from './AgentProcessLog.types'

/**
 * 过程与正文交替显示。
 *
 * 原来的排法是：所有工具调用折进顶部一个框，模型说的所有话拼成一坨挂在最底下。
 * 那一坨里的句子分属不同步骤（「我先摸清工程情况」「我再多探几下」「现在把资产
 * 建出来」），挤在一起之后读的人对不上哪句话在说哪一步 —— 而这恰恰是过程日志
 * 唯一有价值的信息。
 */

function textItem(text: string, timestamp: number): AgentProcessItem {
  return { type: 'text', data: { text }, timestamp }
}

function toolCallItem(name: string, timestamp: number): AgentProcessItem {
  return { type: 'tool-call', data: { function: { name, arguments: '{}' } }, timestamp }
}

function mountBubble(props: Record<string, unknown>): ReturnType<typeof mount> {
  return mount(AIBubble, {
    props: {
      id: 'msg-1',
      content: '',
      status: 'done' as const,
      ...props
    },
    global: {
      stubs: {
        // 打上可辨认的标签，好按 DOM 顺序断言
        MarkdownRenderer: {
          props: ['content'],
          template: '<div class="md" :data-content="content" />'
        },
        AgentProcessLog: {
          props: ['items', 'isThinking'],
          template: '<div class="proc" :data-count="items.length" :data-live="isThinking" />'
        },
        ThinkingProcess: true,
        ChatModelViewer: true,
        AssetList: true,
        MessageSources: true,
        NavigationButton: true,
        'a-button': true,
        'a-tooltip': true
      }
    }
  })
}

function steerItem(text: string, timestamp: number, applied = false): AgentProcessItem {
  return { type: 'user-steer', data: { text, applied }, timestamp }
}

/** DOM 里过程块、正文块、插话块的先后顺序 */
function blockOrder(wrapper: ReturnType<typeof mount>): string[] {
  return wrapper.findAll('.proc, .md, .timeline-steer').map((node) => {
    if (node.classes().includes('proc')) return 'process'
    if (node.classes().includes('timeline-steer')) return 'steer'
    return 'text'
  })
}

describe('AIBubble 过程与正文交替', () => {
  const agentProcess = [
    toolCallItem('ue_content_search', 1),
    textItem('工程是空的，先建输入资产。', 2),
    toolCallItem('ue_run_python_script', 3),
    textItem('增强输入建好了，接着映射按键。', 4)
  ]
  const content = '工程是空的，先建输入资产。增强输入建好了，接着映射按键。'

  it('按发生顺序交替渲染，而不是过程全在上、正文全在下', () => {
    const wrapper = mountBubble({ content, agentProcess })
    expect(blockOrder(wrapper)).toEqual(['process', 'text', 'process', 'text'])
  })

  // 正文已经逐段显示过了，末尾再整段渲染一遍就是重影
  it('正文不重复渲染', () => {
    const wrapper = mountBubble({ content, agentProcess })
    const rendered = wrapper.findAll('.md').map((node) => node.attributes('data-content'))

    expect(rendered).toEqual(['工程是空的，先建输入资产。', '增强输入建好了，接着映射按键。'])
  })

  /**
   * content 会被别处整段覆盖（报错、「用户已停止」的追加）。
   * 那些内容一个字都不能吞掉，否则用户只看到半截答案却不知道出了什么事。
   */
  it('时间线之外多出来的内容照常显示在最后', () => {
    const wrapper = mountBubble({
      content: `${content}\n\n（用户已停止生成）`,
      agentProcess
    })
    const rendered = wrapper.findAll('.md').map((node) => node.attributes('data-content'))

    expect(rendered.at(-1)).toBe('\n\n（用户已停止生成）')
  })

  /**
   * 只有最后那段过程还在跑。给已经跑完的段也挂上转圈动画，等于告诉用户
   * 「这里还在动」。
   */
  it('只有最后一段过程在转圈', () => {
    const wrapper = mountBubble({
      content: '',
      status: 'typing',
      agentProcess: [toolCallItem('a', 1), textItem('说明', 2), toolCallItem('b', 3)]
    })
    const live = wrapper.findAll('.proc').map((node) => node.attributes('data-live'))

    expect(live).toEqual(['false', 'true'])
  })

  // 插话不打断执行：刚才那一步还在跑，转圈不该因为用户说了句话就停
  it('末尾是插话时，前面那段过程继续转圈', () => {
    const wrapper = mountBubble({
      content: '',
      status: 'typing' as const,
      agentProcess: [toolCallItem('ue_run_python_script', 1), steerItem('别用 legacy 映射', 2)]
    })

    expect(wrapper.findAll('.proc').map((node) => node.attributes('data-live'))).toEqual(['true'])
  })

  // 模型正在说话时插话，不能倒回去给已经跑完的工具框重新点上转圈
  it('插话前面是正文段时不给更早的过程块转圈', () => {
    const wrapper = mountBubble({
      content: '',
      status: 'typing' as const,
      agentProcess: [toolCallItem('a', 1), textItem('我先看看。', 2), steerItem('等一下', 3)]
    })

    expect(wrapper.findAll('.proc').map((node) => node.attributes('data-live'))).toEqual(['false'])
  })

  it('回复结束后没有一段在转圈', () => {
    const wrapper = mountBubble({ content, agentProcess })
    const live = wrapper.findAll('.proc').map((node) => node.attributes('data-live'))

    expect(live).toEqual(['false', 'false'])
  })

  // 历史消息是在时间线记正文之前存下的，它们只有工具调用，正文还得整段显示
  it('老消息（时间线里没有正文）照旧：过程在上、正文在下', () => {
    const wrapper = mountBubble({
      content: '已经改好了',
      agentProcess: [toolCallItem('ue_content_search', 1)]
    })

    expect(blockOrder(wrapper)).toEqual(['process', 'text'])
    expect(wrapper.find('.md').attributes('data-content')).toBe('已经改好了')
  })

  /**
   * 运行中插的话要显示在**它发生的那一步旁边**。
   *
   * 原来它被推到消息列表末尾：agent 后面又做了十几步，全部显示在那句话上面，
   * 那条气泡就一直钉在屏幕右下角 —— 用户完全看不出它有没有被读到。
   */
  it('插话显示在它发生的位置，而不是全部堆到最后', () => {
    const wrapper = mountBubble({
      content: '先看看工程。改用增强输入。',
      status: 'typing' as const,
      agentProcess: [
        toolCallItem('ue_content_search', 1),
        textItem('先看看工程。', 2),
        steerItem('别用 legacy 映射', 3),
        toolCallItem('ue_run_python_script', 4),
        textItem('改用增强输入。', 5)
      ]
    })

    expect(blockOrder(wrapper)).toEqual(['process', 'text', 'steer', 'process', 'text'])
    expect(wrapper.find('.timeline-steer-bubble').text()).toBe('别用 legacy 映射')
  })

  // 「送到了」和「模型真看见了」是两件事，界面必须说清楚现在是哪一件
  it('插话生效前后显示不同的回执', () => {
    const pending = mountBubble({
      content: '',
      status: 'typing' as const,
      agentProcess: [steerItem('别用 legacy 映射', 1)]
    })
    const applied = mountBubble({
      content: '',
      status: 'typing' as const,
      agentProcess: [steerItem('别用 legacy 映射', 1, true)]
    })

    expect(pending.find('.timeline-steer-status').classes()).not.toContain('applied')
    expect(applied.find('.timeline-steer-status').classes()).toContain('applied')
    expect(applied.find('.timeline-steer-status').text()).not.toBe(
      pending.find('.timeline-steer-status').text()
    )
  })

  /**
   * 生图要一分钟。那一分钟里唯一有信息量的东西就是过程里那行
   * 「正在出图（1 张，参考图 1 张）」和它旁边的计时 —— 以前这里会把整段过程
   * 换成一个空占位框，用户只剩「在忙，但不知道在忙什么」。
   */
  it('出图期间过程日志照常显示', () => {
    const wrapper = mountBubble({
      content: '',
      status: 'typing' as const,
      agentProcess: [toolCallItem('ue_screenshot', 1), toolCallItem('generate_image', 2)]
    })

    expect(wrapper.find('.proc').exists()).toBe(true)
  })

  it('图出完之后过程日志还在（成品图在正文里，过程不该被顶掉）', () => {
    const wrapper = mountBubble({
      content: '概念图已生成',
      agentProcess: [
        toolCallItem('generate_image', 1),
        {
          type: 'tool-result',
          data: {
            toolName: 'generate_image',
            result: { success: true, image_paths: ['H:/a.png'] }
          },
          timestamp: 2
        }
      ]
    })

    expect(wrapper.find('.proc').exists()).toBe(true)
  })

  it('普通对话（没有过程日志）照旧只渲染正文', () => {
    const wrapper = mountBubble({ content: '普通对话的回复' })

    expect(blockOrder(wrapper)).toEqual(['text'])
    expect(wrapper.find('.md').attributes('data-content')).toBe('普通对话的回复')
  })
})
