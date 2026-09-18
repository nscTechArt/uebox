import { beforeEach, describe, expect, it } from 'vitest'
import { createApp, reactive } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { takeHydratedTypingMessages, useChatMessagesStore } from './chatMessages'
import { chatHistoryStorage } from '../../utils/chatHistoryStorage'
import { chatMessagesPersistencePlugin } from '../../utils/chatMessagesPersistence'

/**
 * 会话删除后不该在存盘数据里留下任何按 sid 存的东西。
 *
 * 这个 store 一共有四份按 sid 索引的数据，其中三份会存盘。
 * 只清正文（`clearSessionMessages` 那样置空数组）的话，删得越多攒得越厚，
 * 而它们对应的会话早已不存在。
 */
describe('chatMessages 的会话删除', () => {
  it('运行失败状态随历史恢复，续跑和成功回复不继承旧失败状态', () => {
    const store = useChatMessagesStore()
    const id = store.pushAssistantTyping('outcome-test')
    store.replaceTyping('outcome-test', id, 'raw provider error', true, { outcome: 'error' })
    const snapshot = JSON.parse(JSON.stringify(store.exportChatMessagesPersistence()))
    store.dropSession('outcome-test')
    store.hydrateChatMessagesPersistence(snapshot)
    expect(store.getMessages('outcome-test')[0].outcome).toBe('error')
    store.replaceTyping('outcome-test', id, '正在继续', false)
    expect(store.getMessages('outcome-test')[0].outcome).toBeUndefined()
    store.replaceTyping('outcome-test', id, '完成', true)
    expect(store.getMessages('outcome-test')[0]).toMatchObject({ content: '完成', status: 'done' })
    expect(store.getMessages('outcome-test')[0].outcome).toBeUndefined()
  })

  beforeEach(() => {
    setActivePinia(createPinia())
    chatHistoryStorage.clear()
  })

  it('dropSession 把四份按 sid 存的数据全部删键', () => {
    const store = useChatMessagesStore()

    store.pushUser('a', '你好')
    store.setHistorySummary('a', '一段摘要')
    store.setCompressedUserCount('a', 3)
    store.pushAssistantTyping('a')
    store.stopTyping('a', store.getMessages('a').at(-1)!.id)

    expect(store.isStopped('a')).toBe(true)

    store.dropSession('a')

    // 删键，不是置空 —— 空数组留在历史文件里就是垃圾
    expect(Object.keys(store.messagesBySid)).not.toContain('a')
    expect(Object.keys(store.stoppedBySid)).not.toContain('a')
    expect(store.getHistorySummary('a')).toBeNull()
    expect(store.getCompressedUserCount('a')).toBe(0)
  })

  it('只删指定会话，别的会话不受影响', () => {
    const store = useChatMessagesStore()
    store.pushUser('a', '甲的消息')
    store.pushUser('b', '乙的消息')
    store.setHistorySummary('b', '乙的摘要')

    store.dropSession('a')

    expect(store.getMessages('b')).toHaveLength(1)
    expect(store.getHistorySummary('b')).toBe('乙的摘要')
  })

  it('空 sid 不做任何事', () => {
    const store = useChatMessagesStore()
    store.pushUser('a', '你好')

    store.dropSession('')
    store.dropSession('   ')

    expect(store.getMessages('a')).toHaveLength(1)
  })

  /**
   * 批量版保证一组会话在同一个检查点里消失，不留下半截状态。
   */
  it('dropSessions 批量删键，一次清掉一组会话', () => {
    const store = useChatMessagesStore()
    store.pushUser('a', '甲的消息')
    store.pushUser('b', '乙的消息')
    store.setHistorySummary('b', '乙的摘要')
    store.pushUser('c', '丙的消息')

    store.dropSessions(['a', 'b', ''])

    expect(Object.keys(store.messagesBySid)).toEqual(['c'])
    expect(store.getMessages('b')).toHaveLength(0)
    expect(store.getHistorySummary('b')).toBeNull()
  })

  /**
   * 摘要必须跟着一起删。留着的话，同一个 sid 万一被复用，
   * 上一段对话的记忆会以"历史摘要"的身份被注入进新会话。
   */
  it('清空（clearSessionMessages）只清正文，删除（dropSession）连摘要一起清', () => {
    const store = useChatMessagesStore()
    store.pushUser('a', '你好')
    store.setHistorySummary('a', '一段摘要')

    store.clearSessionMessages('a')
    expect(store.getMessages('a')).toHaveLength(0)
    expect(store.getHistorySummary('a')).toBe('一段摘要')

    store.dropSession('a')
    expect(store.getHistorySummary('a')).toBeNull()
  })
})

/**
 * 刷新页面时残留的 typing 消息。
 *
 * agent 跑在主进程，刷新只重启了界面 —— 所以恢复缓存时**不能就地判死**，
 * 只登记，等重连流程问过主进程再说。
 */
describe('chatMessages 的刷新残留处理', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    chatHistoryStorage.clear()
    takeHydratedTypingMessages()
  })

  it('恢复缓存时把 typing 消息登记下来，而不是直接标成已中断', () => {
    chatHistoryStorage.setItem(
      'chat-messages',
      JSON.stringify({
        messagesBySid: {
          a: [
            { id: 'm1', role: 'user', content: '帮我改一下材质' },
            { id: 'm2', role: 'assistant', content: '正在思考...', status: 'typing' }
          ]
        },
        historySummaryBySid: {},
        compressedUserCountBySid: {}
      })
    )

    // Pinia 插件要挂在一个真的 app 上才会运行。
    const pinia = createPinia()
    pinia.use(chatMessagesPersistencePlugin)
    createApp({}).use(pinia)
    setActivePinia(pinia)

    const store = useChatMessagesStore()

    // 还在跑的可能性没被排除之前，气泡就该继续转
    expect(store.getMessages('a')[1].status).toBe('typing')
    expect(takeHydratedTypingMessages()).toEqual([{ sid: 'a', messageId: 'm2' }])
  })

  it('确认停了才收尾：没输出过的整条换掉，写了一半的保留正文', () => {
    const store = useChatMessagesStore()
    store.pushUser('a', '问题')
    const emptyId = store.pushAssistantTyping('a')
    store.markTypingInterrupted('a', emptyId)

    store.pushUser('b', '问题')
    const partialId = store.pushAssistantTyping('b')
    store.replaceTyping('b', partialId, '已经写了一半', false)
    store.markTypingInterrupted('b', partialId)

    expect(store.getMessages('a').at(-1)).toMatchObject({
      content: '会话已中断（页面刷新）',
      status: 'done'
    })
    expect(store.getMessages('b').at(-1)).toMatchObject({
      content: '已经写了一半\n\n*[会话已中断（页面刷新）]*',
      status: 'done'
    })
  })

  it('已经收过尾的消息不再重复贴标记', () => {
    const store = useChatMessagesStore()
    store.pushUser('a', '问题')
    const typingId = store.pushAssistantTyping('a')

    store.markTypingInterrupted('a', typingId)
    store.markTypingInterrupted('a', typingId)

    expect(store.getMessages('a').at(-1)!.content).toBe('会话已中断（页面刷新）')
  })
})

describe('chatMessages 的实时过程快照', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('不会和 agentStream 共用嵌套对象，实时 token 不能写穿历史消息', () => {
    const store = useChatMessagesStore()
    const typingId = store.pushAssistantTyping('a')
    const liveProcess = reactive([
      { type: 'text' as const, data: { text: '第一段' }, timestamp: 1 }
    ])

    store.replaceTyping('a', typingId, '第一段', false, { agentProcess: liveProcess })
    const persistedProcess = store.getMessages('a')[0].agentProcess!

    expect(persistedProcess[0]).not.toBe(liveProcess[0])
    liveProcess[0].data.text += '继续输出'
    expect(persistedProcess[0].data.text).toBe('第一段')
  })
})

/**
 * 会话分支（forkSession）把界面消息整份复制到新会话。
 * 这里的边界：typing 不带走（分支建立时会话必然不在跑）、复制是深拷贝
 * （之后两边各改各的）、空源和同 sid 不产生怪结果。
 */
describe('copySessionMessages', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  it('整份复制，typing 状态的丢弃', () => {
    const store = useChatMessagesStore()
    store.pushUser('a', '第一句')
    const typingId = store.pushAssistantTyping('a')
    store.replaceTyping('a', typingId, '回复', true)
    store.pushUser('a', '追问')
    store.pushAssistantTyping('a') // 永远收不了尾的那条

    store.copySessionMessages('a', 'b')

    expect(store.getMessages('b').map((m) => m.status)).toEqual(['done', 'done', 'done'])
    expect(store.getMessages('b').map((m) => m.content)).toEqual(['第一句', '回复', '追问'])
  })

  it('深拷贝：改分支不写穿回源会话', () => {
    const store = useChatMessagesStore()
    store.pushUser('a', '原话')
    store.copySessionMessages('a', 'b')

    store.getMessages('b')[0].content = '分支里改的'

    expect(store.getMessages('a')[0].content).toBe('原话')
    expect(store.getMessages('b')[0].content).toBe('分支里改的')
  })

  it('给了 upToIndex 就只复制到那一条为止', () => {
    const store = useChatMessagesStore()
    store.pushUser('a', '第一句')
    const typingId = store.pushAssistantTyping('a')
    store.replaceTyping('a', typingId, '回复', true)
    store.pushUser('a', '追问')

    store.copySessionMessages('a', 'b', 1)

    expect(store.getMessages('b').map((m) => m.content)).toEqual(['第一句', '回复'])
  })

  it('源不存在 / 空 sid / 同一个 sid 都不做事', () => {
    const store = useChatMessagesStore()
    store.pushUser('a', '消息')

    store.copySessionMessages('不存在', 'b')
    store.copySessionMessages('a', '')
    store.copySessionMessages('a', 'a')

    expect(store.getMessages('b')).toEqual([])
    expect(store.getMessages('a')).toHaveLength(1)
  })
})

/**
 * 报错气泡上的「继续尝试」点完就该消失，但气泡本身必须留着 ——
 * Agent 跑一轮的全部过程日志都攒在这条消息里，删了等于把那一轮的记录抹了。
 */
describe('clearActionButtons', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    chatHistoryStorage.clear()
  })

  const resumeButton = [{ label: '继续尝试', action: 'agent-resume', data: { sessionId: 's1' } }]

  it('摘掉按钮之后，报错那一轮的过程日志还在', () => {
    const store = useChatMessagesStore()
    store.pushUser('a', '原问题')
    const errorId = store.pushAssistant('a', '错误: Connection error.', {
      actionButtons: resumeButton,
      agentProcess: [
        { type: 'tool-call', data: { toolName: 'search_assets' }, timestamp: 1 },
        {
          type: 'tool-result',
          data: { toolName: 'search_assets', result: { ok: true } },
          timestamp: 2
        }
      ]
    })

    store.clearActionButtons('a', errorId)

    const messages = store.getMessages('a')
    expect(messages).toHaveLength(2)
    const errored = messages[1]
    expect(errored.actionButtons).toBeUndefined()
    expect(errored.content).toBe('错误: Connection error.')
    expect(errored.agentProcess).toHaveLength(2)
  })

  it('会话或消息不存在时不改动记录', () => {
    const store = useChatMessagesStore()
    store.pushUser('a', '原问题')
    const errorId = store.pushAssistant('a', '错误', { actionButtons: resumeButton })

    store.clearActionButtons('', errorId)
    store.clearActionButtons('a', 'missing')

    expect(store.getMessages('a')).toHaveLength(2)
    expect(store.getMessages('a')[1].actionButtons).toEqual(resumeButton)
  })
})
