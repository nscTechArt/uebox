import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { enqueueFollowUp } from '@renderer/views/Assistant/composables/followUpQueue'
import { useFollowUpQueueStore } from './followUpQueue'

/**
 * 排着的话不能因为「切了个页面」就消失。
 *
 * 助手路由没开 `meta.keepAlive`，切标签页那一刻组件树就卸载了 —— 队列原来是
 * `Welcome.vue` 里的一个 ref，于是用户排了一句话、去别的页面看一眼再回来，
 * 那句话没了，而他没取消过任何东西。
 */
describe('跟进消息队列', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('存在 store 里，页面卸载再挂载还在', () => {
    const store = useFollowUpQueueStore()
    store.queues = enqueueFollowUp(store.queues, 'chat-1', '顺便把材质也调一下', {
      content: '顺便把材质也调一下'
    }).queues

    // 组件重新挂载：拿到的是同一个 store
    expect(useFollowUpQueueStore().queues['chat-1']?.[0]?.text).toBe('顺便把材质也调一下')
  })

  it('按对话分桶，别条对话看不见', () => {
    const store = useFollowUpQueueStore()
    store.queues = enqueueFollowUp(store.queues, 'chat-1', '甲', {}).queues

    expect(store.queues['chat-2']).toBeUndefined()
  })
})

/**
 * 页面这一层的两个接线点。源码断言而不是挂组件：`Welcome.vue` 是个两千多行、
 * 依赖一大堆 IPC 的页面，为这两行把它整个跑起来不划算 —— 而这两行一旦被改回去，
 * 症状又恰好是"没有任何报错，话就是没了"。
 */
describe('Welcome.vue 的接线', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/views/Assistant/Welcome.vue'),
    'utf8'
  )

  it('队列从 store 拿，不是页面自己的 ref', () => {
    expect(source).toContain('useFollowUpQueueStore')
    expect(source).not.toMatch(/const followUpQueues = ref</)
  })

  /*
   * 投递整段搬去了 `followUpDelivery`（挂在常驻布局上）。页面再监听
   * `agent-v3:released` 就是把这件事又拴回页面寿命上 —— 那正是原来的 bug。
   */
  it('页面不再自己接 released、自己投递', () => {
    expect(source).not.toContain("'agent-v3:released'")
    expect(source).not.toContain('tryFlushFollowUpQueue')
  })
})

/**
 * 刷新（Ctrl+R）之后排着的话还得在。
 *
 * agent 跑在主进程 —— 用户排完一句话刷新页面，那一轮多半还在跑，界面靠
 * `agentReattach` 接回去，唯独排着的话跟着渲染进程一起没了，而他没取消过任何东西。
 * 队列因此要落盘；落盘就必须走磁盘那套存储，不能进 localStorage（payload 里
 * 带着编辑器快照，几百 KB 起步，而 localStorage 是给界面偏好用的）。
 */
describe('队列的持久化', () => {
  const storeSource = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/store/modules/followUpQueue.ts'),
    'utf8'
  )

  it('落盘，且用的是磁盘存储不是 localStorage', () => {
    expect(storeSource).toContain('persist:')
    expect(storeSource).toMatch(/storage:\s*chatHistoryStorage/)
    // 只看真的接上去的那个 storage，注释里提到 localStorage 是在解释为什么不用它
    expect(storeSource).not.toMatch(/storage:\s*localStorage/)
  })

  it('key 在两侧白名单里 —— 少一侧就是写进去读不回来', () => {
    const rendererKeys = readFileSync(
      resolve(process.cwd(), 'src/renderer/src/utils/chatHistoryStorage.ts'),
      'utf8'
    )
    const mainKeys = readFileSync(resolve(process.cwd(), 'src/main/ipc/chatHistory.ts'), 'utf8')
    expect(rendererKeys).toContain("'follow-up-queue'")
    expect(mainKeys).toContain("'follow-up-queue'")
  })

  /*
   * 恢复出来的队列不会让 watch 响（它只认变化），`released` 也早就发过了。
   * 少了这次主动试投，症状从「刷新就没了」变成「刷新之后永远发不出去」。
   */
  it('投递器起来时对已排队的对话主动试投一次', () => {
    const delivery = readFileSync(
      resolve(process.cwd(), 'src/renderer/src/views/Assistant/composables/followUpDelivery.ts'),
      'utf8'
    )
    const afterWatch = delivery.slice(delivery.indexOf('{ deep: true }'))
    expect(afterWatch).toContain(
      'for (const chatSid of Object.keys(queueStore.queues)) deliverNext(chatSid)'
    )
  })
})

/**
 * 输入框草稿同理：切会话时留着（内存里），关掉应用却没了 —— 对用户来说这两件事
 * 没有区别，凭什么一个记一个不记。
 */
describe('输入框草稿的持久化', () => {
  it('draftsById 在 chat-sessions 的落盘字段里', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/renderer/src/store/modules/chatSessions.ts'),
      'utf8'
    )
    expect(source).toMatch(/paths: \[[^\]]*'draftsById'/)
  })
})
