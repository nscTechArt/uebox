import { describe, expect, it } from 'vitest'
import { reactive } from 'vue'
import type { ChatSession, ChatSessionProject } from '@renderer/store/modules/chatSessions'
import {
  shouldStampSessionProject,
  stampSessionProject,
  toSessionProjectPayload
} from './sessionProjectBinding'

function createSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: 'sid-1',
    title: '会话',
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function createDeps(session: ChatSession | null): {
  store: Map<string, ChatSessionProject | null>
  deps: {
    sessionId: string
    getSession: () => ChatSession | null
    setProject: (id: string, value: ChatSessionProject | null) => void
    preferredProjectName?: string
  }
} {
  const store = new Map<string, ChatSessionProject | null>()
  return {
    store,
    deps: {
      sessionId: session?.id || 'sid-1',
      getSession: (): ChatSession | null => session,
      setProject: (id: string, value: ChatSessionProject | null): void => {
        store.set(id, value)
      }
    }
  }
}

describe('sessionProjectBinding', () => {
  it('only stamps sessions that have no project yet', () => {
    expect(shouldStampSessionProject(createSession())).toBe(true)
    expect(shouldStampSessionProject(createSession({ project: { projectName: '  ' } }))).toBe(true)
    expect(shouldStampSessionProject(createSession({ project: { projectName: 'X' } }))).toBe(false)
    expect(shouldStampSessionProject(null)).toBe(false)
  })

  /**
   * `null` 是用户点过「移出项目」，不是「还没定过」——再盖一次戳，
   * 用户刚从工程里移出来的会话下一条消息就又被塞回去了。
   */
  it('never re-stamps a session the user explicitly moved out of a project', () => {
    expect(shouldStampSessionProject(createSession({ project: null }))).toBe(false)

    const { store, deps } = createDeps(createSession({ project: null }))

    expect(stampSessionProject({ ...deps, preferredProjectName: 'ArchViz' })).toBeNull()
    expect(store.size).toBe(0)
  })

  it('stamps the project the user started the chat under', () => {
    const { store, deps } = createDeps(createSession())

    const stamped = stampSessionProject({ ...deps, preferredProjectName: '  ArchViz  ' })

    expect(stamped).toEqual({ projectName: 'ArchViz' })
    expect(store.get('sid-1')).toEqual({ projectName: 'ArchViz' })
  })

  /**
   * 真机上的原始症状：侧边栏顶部点「新对话」（没带 `?project=`），发一条
   * 「你好啊」，会话自己跑进了当时连着的 UALinkDev55 组里。用户没选过工程，
   * 却要去工程分组下面找这条对话；更远的代价是会话的引擎作用域被锁死，
   * 等 UALinkDev55 不开了，这条随手建的对话里 ue.* 工具会整个消失。
   */
  it('leaves a plain new chat unassigned even while an editor is connected', () => {
    const { store, deps } = createDeps(createSession())

    expect(stampSessionProject(deps)).toBeNull()
    expect(stampSessionProject({ ...deps, preferredProjectName: '   ' })).toBeNull()
    expect(store.size).toBe(0)
  })

  it('leaves an already bound session alone', () => {
    const { store, deps } = createDeps(createSession({ project: { projectName: 'Old' } }))

    expect(stampSessionProject({ ...deps, preferredProjectName: 'New' })).toBeNull()
    expect(store.size).toBe(0)
  })

  it('does nothing without a session id', () => {
    const { store, deps } = createDeps(createSession())

    expect(
      stampSessionProject({ ...deps, sessionId: '', preferredProjectName: 'ArchViz' })
    ).toBeNull()
    expect(store.size).toBe(0)
  })
})

/**
 * 这一组盯的是一个只在真机上才炸、单测里很容易漏掉的东西：
 * store 里的工程戳是 Vue 的响应式代理，直接塞进 `ipcRenderer.invoke` 会让
 * Electron 抛 `An object could not be cloned.` —— 用户看到的是发一条消息
 * 弹「Agent 执行异常」，正文一个字都没有。真机上就是这么炸的。
 */
describe('toSessionProjectPayload', () => {
  it('响应式代理拍成普通对象，能过结构化克隆', () => {
    const reactiveProject = reactive({
      projectName: 'test222',
      projectPath: 'H:/UE/test222',
      engineVersion: '5.5.4'
    })

    // 先把「不处理就会炸」这件事钉住：代理本身克隆不了
    expect(() => structuredClone(reactiveProject)).toThrow()

    const payload = toSessionProjectPayload(reactiveProject)

    expect(() => structuredClone(payload)).not.toThrow()
    expect(payload).toEqual({
      projectName: 'test222',
      projectPath: 'H:/UE/test222',
      engineVersion: '5.5.4'
    })
  })

  // 「纯对话」和「名字是空白」是同一件事，都该让主进程按没有归属处理
  it('没有归属、空名字都归一成 null', () => {
    expect(toSessionProjectPayload(null)).toBeNull()
    expect(toSessionProjectPayload(undefined)).toBeNull()
    expect(toSessionProjectPayload({ projectName: '   ' })).toBeNull()
  })

  it('缺的字段不塞 undefined 进去', () => {
    expect(toSessionProjectPayload({ projectName: 'test222' })).toEqual({ projectName: 'test222' })
  })
})
