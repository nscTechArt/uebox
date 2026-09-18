import { describe, expect, it } from 'vitest'
import type { ChatSession } from '@renderer/store/modules/chatSessions'
import {
  FLAT_GROUP_KEY,
  PINNED_GROUP_KEY,
  SECTION_PINNED_KEY,
  SECTION_PLAIN_KEY,
  SECTION_PROJECTS_KEY,
  UNASSIGNED_GROUP_KEY,
  collectKnownProjects,
  filterChatSessions,
  groupChatSessions,
  projectGroupKey,
  sessionActivityState,
  sessionGroupKey,
  sessionSectionKey,
  sortChatSessions
} from './chatSessionGrouping'

function createSession(overrides: Partial<ChatSession> & { id: string }): ChatSession {
  return {
    title: overrides.id,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides
  }
}

describe('chatSessionGrouping', () => {
  it('groups sessions by project name regardless of case or missing path', () => {
    const sessions = [
      createSession({ id: 'a', updatedAt: 30, project: { projectName: 'ShooterGame' } }),
      createSession({
        id: 'b',
        updatedAt: 20,
        project: { projectName: 'shootergame', projectPath: 'D:/UE/Shooter' }
      }),
      createSession({ id: 'c', updatedAt: 10 })
    ]

    const groups = groupChatSessions(sessions, { mode: 'project', sortMode: 'recent' })

    expect(groups.map((group) => group.key)).toEqual([
      projectGroupKey('ShooterGame'),
      UNASSIGNED_GROUP_KEY
    ])
    expect(groups[0].sessions.map((session) => session.id)).toEqual(['a', 'b'])
    expect(groups[0].projectPath).toBe('D:/UE/Shooter')
    expect(groups[1].sessions.map((session) => session.id)).toEqual(['c'])
  })

  it('puts pinned sessions in their own group and nowhere else', () => {
    const sessions = [
      createSession({
        id: 'pinned',
        updatedAt: 10,
        pinned: true,
        pinnedAt: 99,
        project: { projectName: 'ShooterGame' }
      }),
      createSession({ id: 'plain', updatedAt: 20, project: { projectName: 'ShooterGame' } })
    ]

    const groups = groupChatSessions(sessions, { mode: 'project', sortMode: 'recent' })

    expect(groups[0].key).toBe(PINNED_GROUP_KEY)
    expect(groups[0].sessions.map((session) => session.id)).toEqual(['pinned'])
    expect(groups[1].sessions.map((session) => session.id)).toEqual(['plain'])
  })

  it('orders connected projects first, then by activity, with plain chats last', () => {
    const sessions = [
      createSession({ id: 'old', updatedAt: 5, project: { projectName: 'Connected' } }),
      createSession({ id: 'fresh', updatedAt: 500, project: { projectName: 'Archived' } }),
      createSession({ id: 'mid', updatedAt: 50, project: { projectName: 'Legacy' } }),
      createSession({ id: 'plain', updatedAt: 900 })
    ]

    const groups = groupChatSessions(sessions, {
      mode: 'project',
      sortMode: 'recent',
      connectedProjects: [{ projectName: 'Connected', engineVersion: '5.4' }]
    })

    expect(groups.map((group) => group.projectName || group.kind)).toEqual([
      'Connected',
      'Archived',
      'Legacy',
      'unassigned'
    ])
    expect(groups[0].connected).toBe(true)
    expect(groups[0].engineVersion).toBe('5.4')
  })

  it('shows a connected project that has no chats yet, but not while searching', () => {
    const sessions = [createSession({ id: 'a', title: 'Nanite 崩溃' })]
    const connectedProjects = [{ projectName: 'FreshProject' }]

    const withEmpty = groupChatSessions(sessions, {
      mode: 'project',
      sortMode: 'recent',
      connectedProjects
    })
    expect(withEmpty.some((group) => group.projectName === 'FreshProject')).toBe(true)

    const searching = groupChatSessions(sessions, {
      mode: 'project',
      sortMode: 'recent',
      connectedProjects,
      keyword: 'Nanite'
    })
    expect(searching.some((group) => group.projectName === 'FreshProject')).toBe(false)
  })

  it('keeps a removed connected project out of the sidebar and its old chats unassigned', () => {
    const groups = groupChatSessions(
      [createSession({ id: 'old-chat', project: { projectName: 'LiveProject' } })],
      {
        mode: 'project',
        sortMode: 'recent',
        connectedProjects: [{ projectName: 'LiveProject' }],
        hiddenProjects: ['liveproject']
      }
    )

    expect(groups.map((group) => group.projectName || group.kind)).toEqual(['unassigned'])
    expect(groups[0].sessions.map((session) => session.id)).toEqual(['old-chat'])
  })

  it('flattens into pinned + all chats when grouping is disabled', () => {
    const sessions = [
      createSession({ id: 'a', updatedAt: 10, project: { projectName: 'ShooterGame' } }),
      createSession({ id: 'b', updatedAt: 20, pinned: true })
    ]

    const groups = groupChatSessions(sessions, { mode: 'flat', sortMode: 'recent' })

    expect(groups.map((group) => group.kind)).toEqual(['pinned', 'all'])
    expect(groups[1].sessions.map((session) => session.id)).toEqual(['a'])
  })

  it('matches the keyword against title, preview and project name', () => {
    const sessions = [
      createSession({ id: 'a', title: '材质优化' }),
      createSession({ id: 'b', title: '随便聊聊', lastMessagePreview: 'Lumen 反射太亮' }),
      createSession({ id: 'c', title: '无关', project: { projectName: 'LumenDemo' } })
    ]

    expect(filterChatSessions(sessions, 'lumen').map((session) => session.id)).toEqual(['b', 'c'])
    expect(filterChatSessions(sessions, '  ').map((session) => session.id)).toEqual(['a', 'b', 'c'])
  })

  it('sorts by the requested mode', () => {
    const sessions = [
      createSession({ id: 'a', title: 'B 会话', createdAt: 30, updatedAt: 10 }),
      createSession({ id: 'b', title: 'A 会话', createdAt: 10, updatedAt: 30 })
    ]

    expect(sortChatSessions(sessions, 'recent').map((session) => session.id)).toEqual(['b', 'a'])
    expect(sortChatSessions(sessions, 'created').map((session) => session.id)).toEqual(['a', 'b'])
    expect(sortChatSessions(sessions, 'name').map((session) => session.id)).toEqual(['b', 'a'])
  })

  it('puts pinned projects ahead of the connected one', () => {
    const sessions = [
      createSession({ id: 'a', updatedAt: 10, project: { projectName: 'Live' } }),
      createSession({ id: 'b', updatedAt: 5, project: { projectName: 'Favourite' } })
    ]

    const groups = groupChatSessions(sessions, {
      mode: 'project',
      sortMode: 'recent',
      connectedProjects: [{ projectName: 'Live' }],
      pinnedProjects: ['favourite']
    })

    expect(groups.map((group) => group.projectName)).toEqual(['Favourite', 'Live'])
    expect(groups[0].pinned).toBe(true)
    expect(groups[1].pinned).toBe(false)
  })

  it('always shows manually added projects, even with no chats', () => {
    const sessions = [createSession({ id: 'a', project: { projectName: 'ShooterGame' } })]

    const groups = groupChatSessions(sessions, {
      mode: 'project',
      sortMode: 'recent',
      manualProjects: [{ projectName: 'ArchViz', projectPath: 'D:/UE/ArchViz' }]
    })

    const archViz = groups.find((group) => group.projectName === 'ArchViz')
    expect(archViz?.sessions).toEqual([])
    expect(archViz?.projectPath).toBe('D:/UE/ArchViz')
    expect(groups.filter((group) => group.kind === 'project')).toHaveLength(2)
  })

  it('does not duplicate a manual project that already has chats', () => {
    const sessions = [createSession({ id: 'a', project: { projectName: 'ShooterGame' } })]

    const groups = groupChatSessions(sessions, {
      mode: 'project',
      sortMode: 'recent',
      manualProjects: [{ projectName: 'shootergame' }]
    })

    expect(groups.filter((group) => group.kind === 'project')).toHaveLength(1)
    expect(groups[0].sessions).toHaveLength(1)
  })

  it('resolves the group a session currently lives in', () => {
    const pinned = createSession({ id: 'p', pinned: true, project: { projectName: 'Shooter' } })
    const inProject = createSession({ id: 'q', project: { projectName: 'Shooter' } })
    const plain = createSession({ id: 'r' })

    expect(sessionGroupKey(pinned, 'project')).toBe(PINNED_GROUP_KEY)
    expect(sessionGroupKey(inProject, 'project')).toBe(projectGroupKey('Shooter'))
    expect(sessionGroupKey(inProject, 'flat')).toBe(FLAT_GROUP_KEY)
    expect(sessionGroupKey(plain, 'project')).toBe(UNASSIGNED_GROUP_KEY)
  })

  it('maps a session to one of the three top-level sections', () => {
    const pinned = createSession({ id: 'p', pinned: true, project: { projectName: 'Shooter' } })
    const inProject = createSession({ id: 'q', project: { projectName: 'Shooter' } })
    const plain = createSession({ id: 'r' })

    expect(sessionSectionKey(pinned, 'project')).toBe(SECTION_PINNED_KEY)
    expect(sessionSectionKey(inProject, 'project')).toBe(SECTION_PROJECTS_KEY)
    expect(sessionSectionKey(inProject, 'flat')).toBe(SECTION_PLAIN_KEY)
    expect(sessionSectionKey(plain, 'project')).toBe(SECTION_PLAIN_KEY)
  })

  it('shows running ahead of finished, and nothing when idle', () => {
    expect(sessionActivityState(true, true)).toBe('running')
    expect(sessionActivityState(true, false)).toBe('running')
    expect(sessionActivityState(false, true)).toBe('done')
    expect(sessionActivityState(false, false)).toBe('idle')
  })

  /**
   * 「等你回答」压过其它一切。
   *
   * 阻塞在 `ask_user` 时这条会话确实**也**在跑，但转圈说的是「它在忙，你等着就行」,
   * 而事实正相反：提问没有超时，不答就永远不动。两句话只能显示一个，
   * 得让要人动手的那句赢。
   */
  it('puts waiting-for-answer ahead of running and finished', () => {
    expect(sessionActivityState(true, false, true)).toBe('waiting')
    expect(sessionActivityState(true, true, true)).toBe('waiting')
    expect(sessionActivityState(false, false, true)).toBe('waiting')
  })

  it('keeps the old behaviour when nothing is waiting', () => {
    expect(sessionActivityState(true, false, false)).toBe('running')
    expect(sessionActivityState(false, true, false)).toBe('done')
    expect(sessionActivityState(false, false, false)).toBe('idle')
  })

  it('collects known projects from connections and existing sessions', () => {
    const sessions = [
      createSession({ id: 'a', project: { projectName: 'ShooterGame' } }),
      createSession({ id: 'b', project: { projectName: 'shootergame' } }),
      createSession({ id: 'c' })
    ]

    const known = collectKnownProjects(sessions, [{ projectName: 'LiveProject' }])

    expect(known.map((project) => project.projectName)).toEqual(['LiveProject', 'ShooterGame'])
  })
})
