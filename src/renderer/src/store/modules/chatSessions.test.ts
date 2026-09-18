import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

/*
 * 归属的主人在**主进程**那张表上，store 只是投影。所以每一个改归属的 action
 * 都必须把值推给主进程 —— 漏掉一个的表现不是报错，而是界面上写着新工程、
 * 引擎命令还发往旧的那个（`renameProject` 当初就漏了）。
 *
 * 替身必须在 import store 之前装好：store 顶层 import 了这个模块。
 */
const pushed = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }))
vi.mock('@renderer/api/agentV3', () => ({
  agentV3API: {
    setSessionProject: async (args: Record<string, unknown>) => {
      pushed.calls.push(args)
    }
  }
}))

import { MAX_IMAGE_DRAFT_BYTES, useChatSessionsStore, type ChatImageDraft } from './chatSessions'
import { useChatSidebarStore } from './chatSidebarStore'
import { ensureSessionWithTitle } from '../../views/Assistant/composables/chatSendPrimitives'
import { toSessionProjectPayload } from '../../views/Assistant/composables/sessionProjectBinding'

function imageDraft(id: string, size = 1): ChatImageDraft {
  return {
    id,
    file: { size } as File,
    preview: `data:image/png;base64,${id}`,
    uploading: false
  }
}

describe('chat sessions pinning and project binding', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    pushed.calls.length = 0
  })

  it('carries a manually added folder into new and legacy project sessions', () => {
    const store = useChatSessionsStore()
    useChatSidebarStore().addManualProject({
      projectName: 'steam-taikong-diablo',
      projectPath: 'I:/SteamGame/steam-taikong-diablo'
    })
    ensureSessionWithTitle('new', '当前项目的完整路径是什么', {
      chatStore: store,
      tabsStore: { updateTabTitleByPath: vi.fn() },
      route: {
        path: '/dev-assistant',
        fullPath: '/dev-assistant?project=steam-taikong-diablo',
        query: { project: 'steam-taikong-diablo' }
      },
      unnamedTitle: 'New'
    })
    expect(store.sessionById('new')?.project?.projectPath).toBe('I:/SteamGame/steam-taikong-diablo')
    expect(structuredClone(toSessionProjectPayload(store.getProject('new')))).toEqual({
      projectName: 'steam-taikong-diablo',
      projectPath: 'I:/SteamGame/steam-taikong-diablo'
    })

    store.createSession('old', 'Old')
    store.sessionById('old')!.project = { projectName: 'STEAM-TAIKONG-DIABLO' }
    expect(store.getProject('old')?.projectPath).toBe('I:/SteamGame/steam-taikong-diablo')
  })

  /**
   * 补路径这件事之所以不必在 `withSidebarProjectPath` 里防同名，是因为清单本身
   * 就没有同名。这条钉住那个前提 —— 哪天 `addManualProject` 不再去重，
   * 补路径就会开始在两个同名工程之间瞎猜，而那种错只表现为「引擎命令发错工程」。
   */
  it('侧栏工程清单按名字唯一 —— 补路径的前提', () => {
    const sidebar = useChatSidebarStore()
    sidebar.addManualProject({ projectName: 'MyGame', projectPath: 'D:/Projects/MyGame' })
    sidebar.addManualProject({ projectName: 'mygame', projectPath: 'E:/Work/MyGame' })

    expect(
      sidebar.manualProjects.filter((p) => p.projectName.toLowerCase() === 'mygame')
    ).toHaveLength(1)
  })

  it('does not replace a known path or assign unbound sessions from the sidebar', () => {
    const store = useChatSessionsStore()
    useChatSidebarStore().addManualProject({ projectName: 'Game', projectPath: 'D:/Other' })
    store.createSession('a', 'A')
    expect(store.getProject('a')).toBeNull()
    store.setProject('a', { projectName: 'Game', projectPath: 'D:/Original' })
    expect(store.getProject('a')?.projectPath).toBe('D:/Original')
    store.clearProject('a')
    expect(store.getProject('a')).toBeNull()
    store.setProject('a', { projectName: 'Unknown' })
    expect(store.getProject('a')?.projectPath).toBeUndefined()
  })

  it('pins and unpins without disturbing the last-updated order', () => {
    const store = useChatSessionsStore()
    store.createSession('a', '会话 A')
    const updatedAt = store.sessionById('a')!.updatedAt

    expect(store.togglePinned('a')).toBe(true)
    expect(store.sessionById('a')?.pinned).toBe(true)
    expect(store.sessionById('a')?.pinnedAt).toBeGreaterThan(0)
    expect(store.sessionById('a')?.updatedAt).toBe(updatedAt)

    expect(store.togglePinned('a')).toBe(false)
    expect(store.sessionById('a')?.pinned).toBe(false)
    expect(store.sessionById('a')?.pinnedAt).toBeUndefined()
  })

  it('trims and stores the bound UE project, and clears it on request', () => {
    const store = useChatSessionsStore()
    store.createSession('a', '会话 A')
    const updatedAt = store.sessionById('a')!.updatedAt

    store.setProject('a', {
      projectName: '  ShooterGame  ',
      projectPath: ' D:/UE/Shooter ',
      engineVersion: ' 5.4 '
    })

    expect(store.getProject('a')).toEqual({
      projectName: 'ShooterGame',
      projectPath: 'D:/UE/Shooter',
      engineVersion: '5.4'
    })
    expect(store.sessionById('a')?.updatedAt).toBe(updatedAt)

    store.clearProject('a')
    expect(store.getProject('a')).toBeNull()
  })

  /**
   * 「从没定过归属」和「用户明说了不归属」得分得开：前者首条消息会自动盖上
   * 当时连着的工程，后者不该再被盖回去（见 sessionProjectBinding）。
   */
  it('records an explicit null when clearing a session that never had a project', () => {
    const store = useChatSessionsStore()
    store.createSession('a', '会话 A')
    expect(store.sessionById('a')?.project).toBeUndefined()

    store.clearProject('a')
    expect(store.sessionById('a')?.project).toBeNull()
  })

  it('moves an archived session out of the main list and drops its pin', () => {
    const store = useChatSessionsStore()
    store.createSession('a', '会话 A')
    store.createSession('b', '会话 B')
    store.setPinned('a', true)
    const updatedAt = store.sessionById('a')!.updatedAt

    expect(store.toggleArchived('a')).toBe(true)

    expect(store.displayableSessions.map((session) => session.id)).toEqual(['b'])
    expect(store.archivedSessions.map((session) => session.id)).toEqual(['a'])
    expect(store.sessionById('a')?.pinned).toBe(false)
    expect(store.sessionById('a')?.updatedAt).toBe(updatedAt)

    expect(store.toggleArchived('a')).toBe(false)
    expect(store.archivedSessions).toEqual([])
    expect(store.displayableSessions.map((session) => session.id)).toContain('a')
  })

  it('renames a project across every session that belongs to it', () => {
    const store = useChatSessionsStore()
    store.createSession('a', '会话 A')
    store.createSession('b', '会话 B')
    store.createSession('c', '会话 C')
    store.setProject('a', { projectName: 'OldName', projectPath: 'D:/UE/Old' })
    store.setProject('b', { projectName: 'oldname' })
    store.setProject('c', { projectName: 'Other' })

    expect(store.renameProject('OLDNAME', '  NewName  ')).toBe(2)

    expect(store.getProject('a')).toEqual({ projectName: 'NewName', projectPath: 'D:/UE/Old' })
    expect(store.getProject('b')?.projectName).toBe('NewName')
    expect(store.getProject('c')?.projectName).toBe('Other')
    expect(
      store
        .sessionsOfProject('newname')
        .map((session) => session.id)
        .sort()
    ).toEqual(['a', 'b'])
    expect(store.renameProject('NewName', '   ')).toBe(0)
  })

  it('marks a finished task once and clears it when the chat is opened', () => {
    const store = useChatSessionsStore()
    store.createSession('a', '会话 A')
    const updatedAt = store.sessionById('a')!.updatedAt

    store.markTaskDone('a')
    const firstMarkedAt = store.sessionById('a')!.taskDoneAt
    store.markTaskDone('a')

    expect(store.sessionById('a')?.taskDone).toBe(true)
    expect(store.sessionById('a')?.taskDoneAt).toBe(firstMarkedAt)
    expect(store.sessionById('a')?.updatedAt).toBe(updatedAt)

    store.clearTaskDone('a')
    expect(store.sessionById('a')?.taskDone).toBe(false)
    expect(store.sessionById('a')?.taskDoneAt).toBeUndefined()
  })

  it('keeps recent order while a chat is opened or its settings are changed', () => {
    const store = useChatSessionsStore()
    store.sessions = [
      {
        id: 'newer',
        title: '较新的会话',
        createdAt: 200,
        updatedAt: 200
      },
      {
        id: 'older',
        title: '较早的会话',
        createdAt: 100,
        updatedAt: 100
      }
    ]

    // 打开旧会话会恢复这些状态；旧数据里的 false 往往是 undefined。
    store.setImageGenerationMode('older', false)
    store.setAgentMode('older', true)
    store.updateTitle('older', '重命名后的会话')
    store.setAgentSessionId('older', 'agent-session')
    store.setAgentHistory('older', [{ role: 'user', content: '历史消息' }])
    store.setAgentCurrentText('older', '流式草稿')
    store.setBoundNotebook('older', { notebookId: 'note-1', title: '知识库' })
    store.setSkillMode('older', true)
    store.clearPreview('older')

    expect(store.sessionById('older')?.updatedAt).toBe(100)
    expect(store.sortedSessions.map((session) => session.id)).toEqual(['newer', 'older'])
  })

  it('moves a chat to the front only when it gets a new message', () => {
    const store = useChatSessionsStore()
    store.sessions = [
      { id: 'newer', title: '较新的会话', createdAt: 200, updatedAt: 200 },
      { id: 'older', title: '较早的会话', createdAt: 100, updatedAt: 100 }
    ]

    store.appendMessage('older', '一条新消息')

    expect(store.sessionById('older')?.updatedAt).toBeGreaterThan(200)
    expect(store.sortedSessions.map((session) => session.id)).toEqual(['older', 'newer'])
  })

  it('ignores a blank project name and unknown sessions', () => {
    const store = useChatSessionsStore()
    store.createSession('a', '会话 A')

    store.setProject('a', { projectName: '   ' })
    expect(store.getProject('a')).toBeNull()

    store.setProject('missing', { projectName: 'ShooterGame' })
    store.setPinned('missing', true)
    expect(store.sessionById('missing')).toBeNull()
    expect(store.togglePinned('missing')).toBe(false)
  })

  // 用户报的 bug：A 设成只读、B 设成完全访问，切回 A 也变成完全访问了
  it('权限档位一条会话一份，互不影响', () => {
    const store = useChatSessionsStore()

    store.setPermissionMode('a', 'read-only')
    store.setPermissionMode('b', 'yolo')

    expect(store.getPermissionMode('a')).toBe('read-only')
    expect(store.getPermissionMode('b')).toBe('yolo')
    // 没设过要能和「设成了某一档」区分开 —— 前者跟随设置页的默认档位
    expect(store.getPermissionMode('c')).toBeUndefined()
  })

  // 会话要发出第一条消息才进 sessions，而用户完全可能一开标签页就先调权限
  it('会话还没进列表也存得下权限档位', () => {
    const store = useChatSessionsStore()

    store.setPermissionMode('not-yet-created', 'read-only')

    expect(store.sessionById('not-yet-created')).toBeNull()
    expect(store.getPermissionMode('not-yet-created')).toBe('read-only')
  })

  it('删会话时档位跟着删掉', () => {
    const store = useChatSessionsStore()
    store.createSession('a', '会话 A')
    store.setPermissionMode('a', 'yolo')

    store.removeSession('a')

    expect(store.getPermissionMode('a')).toBeUndefined()
  })

  it('removeSession removes a single session and keeps the rest', () => {
    const store = useChatSessionsStore()
    store.createSession('a', '会话 A')
    store.createSession('b', '会话 B')

    store.removeSession('a')

    expect(store.sessionById('a')).toBeNull()
    expect(store.sessionById('b')).not.toBeNull()
  })

  it('removeSessions removes many in one pass and keeps the rest', () => {
    const store = useChatSessionsStore()
    store.createSession('a', '会话 A')
    store.createSession('b', '会话 B')
    store.createSession('c', '会话 C')

    store.removeSessions(['a', 'c', 'missing'])

    expect(store.sessionById('a')).toBeNull()
    expect(store.sessionById('c')).toBeNull()
    expect(store.sessionById('b')).not.toBeNull()
  })

  it('removeSessions with an empty list is a no-op', () => {
    const store = useChatSessionsStore()
    store.createSession('a', '会话 A')

    store.removeSessions([])

    expect(store.sessionById('a')).not.toBeNull()
  })

  it('keeps temporary input drafts isolated by session and clears them with the session', () => {
    const store = useChatSessionsStore()
    store.createSession('a', '会话 A')
    store.createSession('b', '会话 B')

    store.setDraft('a', 'A 的未发送内容')
    store.setDraft('b', 'B 的未发送内容')

    expect(store.getDraft('a')).toBe('A 的未发送内容')
    expect(store.getDraft('b')).toBe('B 的未发送内容')

    store.clearDraft('a')
    expect(store.getDraft('a')).toBe('')
    expect(store.getDraft('b')).toBe('B 的未发送内容')

    store.removeSession('b')
    expect(store.getDraft('b')).toBe('')
  })

  it('keeps temporary image drafts isolated by session and clears them with the whole draft', () => {
    const store = useChatSessionsStore()
    store.createSession('a', '会话 A')
    store.createSession('b', '会话 B')
    const aImage = imageDraft('image-a')
    const bImage = imageDraft('image-b')

    expect(store.trySetImageDraft('a', [aImage])).toBe(true)
    expect(store.trySetImageDraft('b', [bImage])).toBe(true)
    expect(store.getImageDraft('a')).toEqual([aImage])
    expect(store.getImageDraft('b')).toEqual([bImage])

    store.clearDraft('a')
    expect(store.getImageDraft('a')).toEqual([])
    expect(store.getImageDraft('b')).toEqual([bImage])

    store.removeSession('b')
    expect(store.getImageDraft('b')).toEqual([])
  })

  it('bounds all temporary image drafts without discarding the last accepted state', () => {
    const store = useChatSessionsStore()
    const almostFull = imageDraft('almost-full', MAX_IMAGE_DRAFT_BYTES - 1)
    const lastByte = imageDraft('last-byte', 1)

    expect(store.trySetImageDraft('', [lastByte])).toBe(false)
    expect(store.trySetImageDraft('a', [almostFull])).toBe(true)
    expect(store.trySetImageDraft('b', [lastByte])).toBe(true)
    expect(store.getImageDraftBytes()).toBe(MAX_IMAGE_DRAFT_BYTES)

    const tooLarge = imageDraft('too-large', 2)
    expect(store.trySetImageDraft('b', [tooLarge])).toBe(false)
    expect(store.getImageDraft('b')).toEqual([lastByte])

    store.clearDraft('a')
    expect(store.trySetImageDraft('b', [tooLarge])).toBe(true)
  })

  // 主进程报上来的东西（资产锁的锁主、语音派活的目标）带的是内核 id，
  // 不是界面 id。少了这条反查，界面只能显示「不认识的会话」
  it('looks a session up by the kernel session id, not just the UI one', () => {
    const store = useChatSessionsStore()
    store.createSession('chat-a', '会话 A')
    store.setAgentSessionId('chat-a', 'agent-a')

    expect(store.sessionByAgentSessionId('agent-a')?.id).toBe('chat-a')
    // 两个 id 不能混着查：拿界面 id 当内核 id 查必须查不到
    expect(store.sessionByAgentSessionId('chat-a')).toBeNull()
    expect(store.sessionByAgentSessionId('')).toBeNull()
  })

  /*
   * 三个改归属的 action 都要推到主进程。
   *
   * `renameProject` 是当初漏掉的那一个，而且它漏得最疼：只有名字的归属
   * （侧边栏「在这个工程下新建会话」盖的就是这种）拿名字当匹配键，表里留着
   * 旧名字的话，整个进程里这条会话都认不回工程、一个引擎工具都没有。
   */
  it('setProject / clearProject / renameProject 三个写入方都推给主进程', async () => {
    const store = useChatSessionsStore()
    store.createSession('a', '会话 A')
    store.setAgentSessionId('a', 'kernel-a')
    pushed.calls.length = 0

    store.setProject('a', { projectName: 'GameA', projectPath: 'D:/Games/GameA' })
    expect(pushed.calls.at(-1)).toMatchObject({
      sessionId: 'kernel-a',
      project: { projectName: 'GameA' }
    })

    store.renameProject('GameA', 'GameA-Real')
    expect(pushed.calls.at(-1)).toMatchObject({
      sessionId: 'kernel-a',
      project: { projectName: 'GameA-Real' }
    })

    store.clearProject('a')
    expect(pushed.calls.at(-1)).toMatchObject({ sessionId: 'kernel-a', project: null })
  })

  // 还没跑过的会话没有内核 id，推不出去也不该推 —— 它的第一条消息会带着戳下去，
  // 主进程照那份戳初始化，结果一样
  it('会话还没有内核 id 时不推', () => {
    const store = useChatSessionsStore()
    store.createSession('b', '会话 B')
    pushed.calls.length = 0

    store.setProject('b', { projectName: 'GameA' })

    expect(store.getProject('b')?.projectName).toBe('GameA')
    expect(pushed.calls).toEqual([])
  })
})
