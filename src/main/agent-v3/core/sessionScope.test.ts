/** @vitest-environment node */
import { describe, expect, it } from 'vitest'

import { fillProjectPath, matchConnectedProject, resolveSessionScope } from './sessionScope'

/**
 * 真机上踩到的：会话挂在 test222 下，编辑器开着 UALinkDev55，
 * 用户问「这是啥项目」，模型把 UALinkDev55 的模块、插件、默认地图答了一遍 ——
 * 答的不是用户问的那个工程，全程也没说自己换了个工程。
 *
 * 根因是主进程只认「当前连接」：提示词和工具都以它为准，会话归属那一层
 * 压根没传下来。规则改成**项目对项目**：会话归属哪个工程就操作哪个工程，
 * 它没开着就没有引擎能力 —— 而不是顺手去动旁边那个。
 */
describe('resolveSessionScope', () => {
  const ualink = {
    connectionId: 'conn-ualink',
    projectName: 'UALinkDev55',
    projectPath: 'I:/UnrealAgent/UALinkDev55',
    engineVersion: '5.5.4'
  }
  const other = {
    connectionId: 'conn-other',
    projectName: 'OtherGame',
    projectPath: 'H:/Games/OtherGame',
    engineVersion: '5.4'
  }

  /**
   * 这条是整个改动的核心：会话的工程没开着，就**不借用**旁边那个连接。
   *
   * 借用是最坏的结果 —— 用户以为在 test222 里干活，实际改的是 UALinkDev55，
   * 而且全程没有一句提示。宁可这条会话暂时没有引擎能力。
   */
  it('会话归属的工程没开着时，不借用旁边连着的工程', () => {
    const scope = resolveSessionScope({ projectName: 'test222' }, [ualink], ualink)

    expect(scope.engineAvailable).toBe(false)
    expect(scope.targetConnectionId).toBeUndefined()
    expect(scope.connectedProject).toBeUndefined()
    expect(scope.sessionProject).toMatchObject({ name: 'test222', connected: false })
    // 连着的那个要报给提示词：用户其实连着引擎，不能劝他「请先安装插件」
    expect(scope.outOfScopeProjects).toEqual(['UALinkDev55'])
  })

  it('会话归属的工程正连着时，工具发给它而不是「最近连接的那个」', () => {
    // current 是 other（最近连接），但这条会话说的是 UALinkDev55
    const scope = resolveSessionScope(
      { projectName: 'UALinkDev55', projectPath: 'I:/UnrealAgent/UALinkDev55' },
      [ualink, other],
      other
    )

    expect(scope.engineAvailable).toBe(true)
    expect(scope.targetConnectionId).toBe('conn-ualink')
    expect(scope.connectedProject?.projectName).toBe('UALinkDev55')
    expect(scope.sessionProject).toMatchObject({ name: 'UALinkDev55', connected: true })
    expect(scope.outOfScopeProjects).toEqual(['OtherGame'])
  })

  // 没盖过工程戳的「纯会话」是常态，它跟着当前连接走 —— 也就是改动之前的老行为
  it('纯对话跟着当前连接走，且不往提示词里塞归属信息', () => {
    const scope = resolveSessionScope(null, [ualink], ualink)

    expect(scope.engineAvailable).toBe(true)
    expect(scope.targetConnectionId).toBe('conn-ualink')
    expect(scope.sessionProject).toBeUndefined()
  })

  it('一个都没连时归属仍然告诉模型，但没有「别的工程」可提', () => {
    const scope = resolveSessionScope({ projectName: 'test222' }, [], undefined)

    expect(scope.engineAvailable).toBe(false)
    expect(scope.targetConnectionId).toBeUndefined()
    expect(scope.sessionProject).toMatchObject({ name: 'test222', connected: false })
    expect(scope.outOfScopeProjects).toEqual([])
  })

  // 会话上那份是盖戳当时的快照，可能是几个月前的版本号
  it('归属工程路径匹配时，版本以引擎报上来的为准', () => {
    const scope = resolveSessionScope(
      { projectName: 'UALinkDev55', engineVersion: '5.3', projectPath: ualink.projectPath },
      [ualink],
      ualink
    )

    expect(scope.sessionProject?.engineVersion).toBe('5.5.4')
    expect(scope.sessionProject?.path).toBe('I:/UnrealAgent/UALinkDev55')
  })

  it('已知路径未连接时，不操作另一个同名副本', () => {
    const scope = resolveSessionScope(
      { projectName: ualink.projectName, projectPath: 'I:/Original/UALinkDev55' },
      [ualink],
      ualink
    )
    expect(scope.engineAvailable).toBe(false)
    expect(scope.targetConnectionId).toBeUndefined()
    expect(scope.sessionProject?.path).toBe('I:/Original/UALinkDev55')
  })

  // 空名字要当成「纯对话」，否则会把一条正常会话锁死在一个不存在的工程上
  it('空白工程名当成没有归属，按纯对话处理', () => {
    const scope = resolveSessionScope({ projectName: '   ' }, [ualink], ualink)

    expect(scope.sessionProject).toBeUndefined()
    expect(scope.engineAvailable).toBe(true)
    expect(scope.targetConnectionId).toBe('conn-ualink')
  })
})

describe('matchConnectedProject', () => {
  const byPath = {
    connectionId: 'conn-a',
    projectName: 'MyGame',
    projectPath: 'H:/Projects/MyGame'
  }
  const sameName = {
    connectionId: 'conn-b',
    projectName: 'MyGame',
    projectPath: 'D:/Backup/MyGame'
  }

  // 复制一份工程改改就是另一个工程，重名很常见 —— 路径才是唯一的
  it('路径优先于名字', () => {
    const matched = matchConnectedProject(
      { projectName: 'MyGame', projectPath: 'D:/Backup/MyGame' },
      [byPath, sameName]
    )

    expect(matched?.connectionId).toBe('conn-b')
  })

  it('路径的斜杠方向、大小写、结尾斜杠不一致也算同一个', () => {
    const matched = matchConnectedProject(
      { projectName: 'MyGame', projectPath: 'h:\\projects\\mygame\\' },
      [byPath]
    )

    expect(matched?.connectionId).toBe('conn-a')
  })

  // 老会话的戳里没有 projectPath，只能退到名字
  it('会话没存路径时退回按名字匹配', () => {
    expect(matchConnectedProject({ projectName: 'mygame' }, [byPath])?.connectionId).toBe('conn-a')
  })

  it('对不上就是对不上，不硬凑一个', () => {
    expect(matchConnectedProject({ projectName: 'test222' }, [byPath])).toBeUndefined()
  })
})

/**
 * 「这个 test222 不应该就是我们选的项目的路径吗，数据库不应该都有吗」——
 * 是的，盒子的 `projects` 表里就有，只是以前没人去查。
 *
 * 会话戳只有名字（路径只有「盖戳那一刻正连着」才顺带记下来），于是模型
 * 为了找一个 `.uproject` 从 C:/ 开始整盘扫，而答案一直躺在库里。
 */
describe('fillProjectPath', () => {
  const library = [
    { projectName: 'test222', projectPath: 'I:/UnrealAgent/test222', engineVersion: '5.5' },
    { projectName: 'OtherGame', projectPath: 'D:/Games/OtherGame' }
  ]

  it('戳上没路径时按名字去库里补', () => {
    expect(fillProjectPath({ projectName: 'test222' }, library)).toMatchObject({
      projectName: 'test222',
      projectPath: 'I:/UnrealAgent/test222',
      engineVersion: '5.5'
    })
  })

  it('名字大小写不一致也认', () => {
    expect(fillProjectPath({ projectName: ' TEST222 ' }, library)?.projectPath).toBe(
      'I:/UnrealAgent/test222'
    )
  })

  // 戳上的路径是「连接时引擎报的」，比库里那份更贴近现实，不该被覆盖
  it('戳上已经有路径就不动它', () => {
    expect(
      fillProjectPath({ projectName: 'test222', projectPath: 'H:/moved/test222' }, library)
        ?.projectPath
    ).toBe('H:/moved/test222')
  })

  it('库里没有就原样返回，不编一个路径出来', () => {
    expect(fillProjectPath({ projectName: '没登记过' }, library)?.projectPath).toBeUndefined()
    expect(fillProjectPath({ projectName: 'test222' }, [])?.projectPath).toBeUndefined()
    expect(fillProjectPath(null, library)).toBeNull()
  })

  // 补上路径之后，匹配连接就能走路径而不是只能比名字
  it('补出来的路径参与后续的连接匹配', () => {
    const scope = resolveSessionScope(
      { projectName: 'test222' },
      [{ connectionId: 'conn-t', projectName: '改过名了', projectPath: 'I:/UnrealAgent/test222' }],
      undefined,
      library
    )

    expect(scope.engineAvailable).toBe(true)
    expect(scope.targetConnectionId).toBe('conn-t')
    expect(scope.sessionProject?.path).toBe('I:/UnrealAgent/test222')
  })
})
