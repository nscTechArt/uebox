import { describe, expect, it } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import {
  joinTimelineText,
  reconcileAgentTimeline,
  resolveTrailingContent,
  splitAgentTimeline
} from './agentTimeline'
import type { AgentProcessItem } from '../components/AgentProcessLog.types'
import { useAgentStreamStore } from '@renderer/store/modules/agentStream'

function text(value: string, timestamp = 1): AgentProcessItem {
  return { type: 'text', data: { text: value }, timestamp }
}

function toolCall(name: string, timestamp = 1): AgentProcessItem {
  return {
    type: 'tool-call',
    data: { function: { name, arguments: '{}' } },
    timestamp
  }
}

function steer(value: string, timestamp = 1, applied = false): AgentProcessItem {
  return { type: 'user-steer', data: { text: value, applied }, timestamp }
}

describe('splitAgentTimeline', () => {
  /**
   * 这是整件事的重点：模型在两次工具调用之间说的话，必须留在它说话的位置。
   * 原来界面把所有正文拼成一根字符串挂在最底下，读的人对不上哪句话在说哪一步。
   */
  it('按发生顺序切成「过程 → 正文 → 过程 → 正文」', () => {
    const blocks = splitAgentTimeline([
      toolCall('list_assets', 1),
      text('工程是空的，先建输入资产。', 2),
      toolCall('ue_run_python_script', 3),
      text('增强输入建好了，接着映射按键。', 4)
    ])

    expect(blocks.map((block) => block.kind)).toEqual(['process', 'text', 'process', 'text'])
    expect(blocks[1]).toMatchObject({ kind: 'text', text: '工程是空的，先建输入资产。' })
    expect(blocks[3]).toMatchObject({ kind: 'text', text: '增强输入建好了，接着映射按键。' })
  })

  it('连续的过程条目并成一段', () => {
    const blocks = splitAgentTimeline([
      toolCall('a', 1),
      { type: 'tool-result', data: { toolName: 'a', result: { success: true } }, timestamp: 2 },
      toolCall('b', 3)
    ])

    expect(blocks).toHaveLength(1)
    expect(blocks[0].kind).toBe('process')
    expect((blocks[0] as { items: AgentProcessItem[] }).items).toHaveLength(3)
  })

  it('连续的正文段并成一块', () => {
    const blocks = splitAgentTimeline([text('前半句', 1), text('后半句', 2)])

    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ kind: 'text', text: '前半句后半句' })
  })

  /**
   * 模型在两次工具调用之间经常只吐一个换行。给它开一个块，界面上就是
   * 凭空多出来的一道空隙 —— 而且会把本来连着的两段过程切成两个框。
   */
  it('只有空白的正文段不占块，两侧的过程仍并成一段', () => {
    const blocks = splitAgentTimeline([toolCall('a', 1), text('\n\n', 2), toolCall('b', 3)])

    expect(blocks).toHaveLength(1)
    expect(blocks[0].kind).toBe('process')
    expect((blocks[0] as { items: AgentProcessItem[] }).items).toHaveLength(2)
  })

  // 流式过程中块只往后追加，前面的 key 不该变；变了 Vue 会把画好的块整个重建
  it('已有块的 key 在时间线继续增长时保持不变', () => {
    const items = [toolCall('a', 1), text('说明', 2)]
    const before = splitAgentTimeline(items).map((block) => block.key)
    const after = splitAgentTimeline([...items, toolCall('b', 3)]).map((block) => block.key)

    expect(after.slice(0, before.length)).toEqual(before)
  })

  it('流式增长时复用已完成区块，避免历史过程反复重算', () => {
    const firstTool = toolCall('list_assets', 1)
    const firstText = text('先检查工程。', 2)
    const before = reconcileAgentTimeline([], [firstTool, firstText])

    firstText.data.text = '先检查工程。已经确认目录结构。'
    const after = reconcileAgentTimeline(before, [firstTool, firstText])

    // 工具步骤已经完成，保持同一份 props 引用，历史 AgentProcessLog 不会更新。
    expect(after[0]).toBe(before[0])
    // 正在流出的正文才需要更新。
    expect(after[1]).not.toBe(before[1])
    expect(after[1]).toMatchObject({ kind: 'text', text: '先检查工程。已经确认目录结构。' })
  })

  it('没有正文条目时退回单独一段过程', () => {
    const blocks = splitAgentTimeline([toolCall('a', 1)])
    expect(blocks).toEqual([expect.objectContaining({ kind: 'process' })])
  })

  it('空时间线不产出块', () => {
    expect(splitAgentTimeline([])).toEqual([])
  })

  /**
   * 插话必须留在它发生的位置。
   *
   * 原来它被推到消息列表末尾：agent 后面又干了十件事，全显示在那句话上面，
   * 那条气泡一直浮在屏幕最下角 —— 看起来像是压根没被读到。
   */
  it('插话单独成块，留在它发生的位置', () => {
    const blocks = splitAgentTimeline([
      toolCall('a', 1),
      steer('别用 legacy 映射', 2),
      toolCall('b', 3)
    ])

    expect(blocks.map((block) => block.kind)).toEqual(['process', 'steer', 'process'])
    expect(blocks[1]).toMatchObject({ kind: 'steer', text: '别用 legacy 映射', applied: false })
  })

  // 撤回按钮要用号和会话去指认这一条；投影里漏掉的话按钮就没得可点
  it('插话块带上撤回要用的号和会话', () => {
    const blocks = splitAgentTimeline([
      {
        type: 'user-steer',
        data: { text: '算了', applied: false, cancelled: true, steerId: 's-1', sessionId: 'a-1' },
        timestamp: 2
      }
    ])

    expect(blocks[0]).toMatchObject({
      kind: 'steer',
      cancelled: true,
      steerId: 's-1',
      sessionId: 'a-1'
    })
  })

  /**
   * 插话带的图也要投影出来。
   *
   * 输入框发完就把图清了，时间线是它唯一的去处 —— 漏在这里的话，用户回头看
   * 只剩一句「照着这张改」，而「这张」是哪张再也说不清。
   */
  it('插话块带上一起插进去的图', () => {
    const blocks = splitAgentTimeline([
      {
        type: 'user-steer',
        data: { text: '照着这张改', applied: false, images: ['data:image/png;base64,a', ''] },
        timestamp: 2
      }
    ])

    // 空串是画不出来的东西，滤掉才不会在气泡上留一个碎图标
    expect(blocks[0]).toMatchObject({ kind: 'steer', images: ['data:image/png;base64,a'] })
  })

  // 撤回是就地改状态，块必须跟着重建，否则界面停在「排队中」
  it('撤回状态变了就不复用旧块', () => {
    const item = steer('算了', 2)
    const before = reconcileAgentTimeline([], [item])

    item.data.cancelled = true
    const after = reconcileAgentTimeline(before, [item])

    expect(after[0]).not.toBe(before[0])
    expect(after[0]).toMatchObject({ kind: 'steer', cancelled: true })
  })

  // 混进工具调用列表里会被读成 agent 自己的一步，而它是用户说的话
  it('插话不并进相邻的过程块', () => {
    const blocks = splitAgentTimeline([toolCall('a', 1), steer('等一下', 2)])

    expect(blocks).toHaveLength(2)
    expect((blocks[0] as { items: AgentProcessItem[] }).items).toHaveLength(1)
  })

  it('内核确认收到之后带上已生效标记', () => {
    const blocks = splitAgentTimeline([steer('等一下', 1, true)])

    expect(blocks[0]).toMatchObject({ kind: 'steer', applied: true })
  })
})

describe('joinTimelineText', () => {
  it('把所有正文段按顺序拼回全文', () => {
    expect(joinTimelineText([text('A', 1), toolCall('x', 2), text('B', 3)])).toBe('AB')
  })
})

describe('resolveTrailingContent', () => {
  it('正文和时间线一致时不再重复渲染', () => {
    expect(resolveTrailingContent('AB', 'AB')).toBe('')
  })

  // 写回消息有节流，流式中 content 会比时间线慢半拍；此时重复渲染会闪字
  it('content 落后于时间线时返回空串', () => {
    expect(resolveTrailingContent('A', 'AB')).toBe('')
  })

  /**
   * content 会被别处整段覆盖或追加（报错、「用户已停止」）。
   * 那些内容一个字都不能吞掉，否则用户只看到半截答案却不知道出了什么事。
   */
  it('content 在时间线之后追加了内容时只补差额', () => {
    expect(resolveTrailingContent('AB\n\n用户已停止生成', 'AB')).toBe('\n\n用户已停止生成')
  })

  it('content 和时间线完全对不上时整段显示', () => {
    expect(resolveTrailingContent('执行出错：连接被拒绝', 'AB')).toBe('执行出错：连接被拒绝')
  })

  /**
   * 刷新重连时占位符被当成正文留在了 content 开头，两边谁也不是谁的前缀。
   * 兜底分支会把整条回复又画一遍 —— 用户看到一模一样的回答出现两次。
   */
  it('多出来的那截在前面时只补那一截，不整段重影', () => {
    expect(resolveTrailingContent('思考中...AB', 'AB')).toBe('思考中...')
  })

  it('没有时间线正文时原样返回 content', () => {
    expect(resolveTrailingContent('普通对话的回复', '')).toBe('普通对话的回复')
  })

  /**
   * 收尾写进 content 的是 trim 过的全文，时间线里是带着原始空白的增量：
   * 模型在工具调用之后常以换行开口。首尾空白不该让两边「对不上」——
   * 对不上的代价是整段重影，自动朗读把答复念两遍。
   */
  it('只差首尾空白时视为一致', () => {
    expect(resolveTrailingContent('AB', '\n\nAB')).toBe('')
    expect(resolveTrailingContent('AB', 'AB\n')).toBe('')
    expect(resolveTrailingContent('AB\n\n用户已停止生成', '\n\nAB')).toBe('\n\n用户已停止生成')
  })
})

describe('agentStream 把正文记进时间线', () => {
  const CHAT = 'chat-1'
  const SESSION = 'session-1'

  it('刷新接回时复制历史过程，后续实时更新不能写穿持久化消息', () => {
    setActivePinia(createPinia())
    const store = useAgentStreamStore()
    const persisted = [text('刷新前半截')]

    store.initStream(CHAT, SESSION, 'typing-1', { agentProcess: persisted })
    const live = store.getAgentProcess(CHAT)

    expect(live[0]).not.toBe(persisted[0])
    live[0].data.text = '刷新后继续'
    expect(persisted[0].data.text).toBe('刷新前半截')
  })

  it('正文增量并进同一段，工具调用之后另起一段', () => {
    setActivePinia(createPinia())
    const store = useAgentStreamStore()
    store.initStream(CHAT, SESSION, 'typing-1')

    store.appendText(SESSION, '先看看工程里有什么。')
    store.flushBuffer(SESSION)
    store.addAgentProcess(SESSION, toolCall('list_assets', 2))
    store.appendText(SESSION, '空的，开始建资产。')
    store.flushBuffer(SESSION)

    const items = store.getAgentProcess(CHAT)
    expect(items.map((item) => item.type)).toEqual(['text', 'tool-call', 'text'])
    expect(items[0].data.text).toBe('先看看工程里有什么。')
    expect(items[2].data.text).toBe('空的，开始建资产。')
    // 全文照旧完整，复制/落库/发回模型都还用它
    expect(store.getCurrentText(CHAT)).toBe('先看看工程里有什么。空的，开始建资产。')
  })

  it('插话记在时间线当前位置，不追加到别处', () => {
    setActivePinia(createPinia())
    const store = useAgentStreamStore()
    store.initStream(CHAT, SESSION, 'typing-1')

    store.addAgentProcess(SESSION, toolCall('list_assets', 1))
    expect(store.pushUserSteer(SESSION, '别用 legacy 映射')).toBe(true)
    store.addAgentProcess(SESSION, toolCall('ue_run_python_script', 3))

    expect(store.getAgentProcess(CHAT).map((item) => item.type)).toEqual([
      'tool-call',
      'user-steer',
      'tool-call'
    ])
  })

  // 没有流在跑就没有时间线可插；调用方据此退回普通用户气泡
  it('会话没有流在跑时插话返回 false', () => {
    setActivePinia(createPinia())
    expect(useAgentStreamStore().pushUserSteer('不存在的会话', '喂')).toBe(false)
  })

  /**
   * 「已生效」只认内核那条回执。
   * steer 的 IPC 返回 success 只代表**入队成功** —— 拿它当生效，用户会在
   * 模型压根还没看到这句话的时候就被告知已经处理了。
   */
  it('收到内核回执才标记插话已生效', () => {
    setActivePinia(createPinia())
    const store = useAgentStreamStore()
    store.initStream(CHAT, SESSION, 'typing-1')

    store.pushUserSteer(SESSION, '别用 legacy 映射')
    expect(store.getAgentProcess(CHAT)[0].data.applied).toBe(false)

    store.markSteerApplied(SESSION, '别用 legacy 映射')
    expect(store.getAgentProcess(CHAT)[0].data.applied).toBe(true)
  })

  it('同一句话插两次时先进的先生效', () => {
    setActivePinia(createPinia())
    const store = useAgentStreamStore()
    store.initStream(CHAT, SESSION, 'typing-1')

    store.pushUserSteer(SESSION, '快点')
    store.pushUserSteer(SESSION, '快点')
    store.markSteerApplied(SESSION, '快点')

    expect(store.getAgentProcess(CHAT).map((item) => item.data.applied)).toEqual([true, false])
  })

  /**
   * 撤回掉的那条留在原地，只是标成「已撤回」。
   *
   * 删掉它的话，用户确实打过、确实按过发送的一句话在记录里凭空消失，
   * 文字本身也一起没了 —— 他想改两个字再发一遍都没得可抄。
   */
  it('撤回后条目还在时间线上，只是标成已撤回', () => {
    setActivePinia(createPinia())
    const store = useAgentStreamStore()
    store.initStream(CHAT, SESSION, 'typing-1')

    store.pushUserSteer(SESSION, '算了别改了', 'steer-1')
    store.markSteerCancelled(SESSION, 'steer-1')

    const items = store.getAgentProcess(CHAT)
    expect(items).toHaveLength(1)
    expect(items[0].data.cancelled).toBe(true)
    expect(items[0].data.text).toBe('算了别改了')
  })

  // 撤回的那条永远不会生效；同一句话插两次撤了头一条时，生效要记在还留着的那条上
  it('已撤回的条目不会被内核回执标成已生效', () => {
    setActivePinia(createPinia())
    const store = useAgentStreamStore()
    store.initStream(CHAT, SESSION, 'typing-1')

    store.pushUserSteer(SESSION, '快点', 'steer-1')
    store.pushUserSteer(SESSION, '快点', 'steer-2')
    store.markSteerCancelled(SESSION, 'steer-1')
    store.markSteerApplied(SESSION, '快点')

    expect(store.getAgentProcess(CHAT).map((item) => item.data.applied)).toEqual([false, true])
  })

  // 本轮最初的 prompt 也会走这条回执通道，不能让它误标掉待生效的插话
  it('对不上任何待生效插话的用户消息被忽略', () => {
    setActivePinia(createPinia())
    const store = useAgentStreamStore()
    store.initStream(CHAT, SESSION, 'typing-1')

    store.pushUserSteer(SESSION, '别用 legacy 映射')
    store.markSteerApplied(SESSION, '帮我做个跳跃')

    expect(store.getAgentProcess(CHAT)[0].data.applied).toBe(false)
  })

  // <think> 里的内容是推理不是正文，不该出现在时间线的正文段里
  it('<think> 块里的内容不进正文段', () => {
    setActivePinia(createPinia())
    const store = useAgentStreamStore()
    store.initStream(CHAT, SESSION, 'typing-1')

    store.appendText(SESSION, '正文<think>推理</think>')
    store.flushBuffer(SESSION)

    expect(joinTimelineText(store.getAgentProcess(CHAT))).toBe('正文')
    expect(store.getCurrentThinking(CHAT)).toBe('推理')
  })
})

/**
 * agent 反问用户的那张卡片。
 *
 * 它不是 agent 的一步，是一次人机往返 —— 混进工具调用列表里读不出来，
 * 所以要单独成块，和插话同一个待遇。
 */
describe('splitAgentTimeline —— 提问卡片', () => {
  const question = (toolCallId: string, timestamp = 1, action?: string): AgentProcessItem => ({
    type: 'question',
    data: {
      toolCallId,
      sessionId: 's1',
      questions: [
        {
          header: '用在哪',
          question: '先给谁用？',
          multiSelect: false,
          options: [
            { label: '补适配层', description: '只加能力位' },
            { label: '改音频概览', description: '改动面更大' }
          ]
        }
      ],
      ...(action ? { action } : {})
    },
    timestamp
  })

  it('单独成块，不并进相邻的过程框', () => {
    const blocks = splitAgentTimeline([toolCall('read_file', 1), question('q1', 2)])

    expect(blocks.map((b) => b.kind)).toEqual(['process', 'question'])
    expect(blocks[1]).toMatchObject({ kind: 'question', question: { toolCallId: 'q1' } })
  })

  it('提问之后的工具调用另起一个过程块，不会倒灌回提问之前', () => {
    const blocks = splitAgentTimeline([
      toolCall('read_file', 1),
      question('q1', 2),
      toolCall('write_file', 3)
    ])

    expect(blocks.map((b) => b.kind)).toEqual(['process', 'question', 'process'])
  })

  /**
   * key 用 toolCallId 而不是块序号：用户答完之后这一条会**就地改**
   * （从待答变成只读）。key 跟着变的话 Vue 会把整张卡片重建一遍，
   * 已经填进「其他」输入框的字会当场消失。
   */
  it('答完之后 key 不变，卡片不会被重建', () => {
    const before = splitAgentTimeline([question('q1', 2)])
    const after = splitAgentTimeline([question('q1', 2, 'accept')])

    expect(before[0].key).toBe(after[0].key)
    expect(before[0].key).toContain('q1')
  })

  /** 没有 toolCallId 就没法把答案送回去，画一张点了没反应的卡片更糟 */
  it('缺 toolCallId 的条目整条丢掉', () => {
    const broken: AgentProcessItem = { type: 'question', data: { questions: [] }, timestamp: 1 }
    expect(splitAgentTimeline([broken])).toEqual([])
  })

  it('正文段在提问前后各自成块，不会被吞掉', () => {
    const blocks = splitAgentTimeline([
      text('我看了一下工程。', 1),
      question('q1', 2),
      text('好，按你说的做。', 3)
    ])

    expect(blocks.map((b) => b.kind)).toEqual(['text', 'question', 'text'])
  })
})
