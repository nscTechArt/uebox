import { beforeEach, describe, expect, it } from 'vitest'
import {
  __resetSessionBindingsForTest,
  adoptSessionBinding,
  getSessionBinding,
  setSessionBinding
} from './sessionBinding'
import { resolveSessionScope } from './sessionScope'
import { formatRuntimeEnvelope } from './runtimeEnvelope'

describe('legacy session project paths', () => {
  beforeEach(__resetSessionBindingsForTest)

  const folder = {
    projectName: 'steam-taikong-diablo',
    projectPath: 'I:/SteamGame/steam-taikong-diablo'
  }

  it.each(['new', 'live', 'restored'])(
    'includes the folder in the %s session model context',
    (state) => {
      const old = { projectName: folder.projectName.toUpperCase() }
      if (state === 'live') setSessionBinding('s', old)
      const binding = adoptSessionBinding('s', folder, state === 'restored' ? old : undefined)
      expect(binding?.projectPath).toBe(folder.projectPath)
      expect(getSessionBinding('s')).toEqual(binding)
      const scope = resolveSessionScope(binding, [])
      expect(scope.engineAvailable).toBe(false)
      expect(
        formatRuntimeEnvelope({
          runtimeScopeId: 'test',
          observedAt: '2026-09-12T00:00:00Z',
          engineLink: 'none',
          sessionProject: {
            name: scope.sessionProject!.name,
            ...(scope.sessionProject!.path ? { pathOnRecord: scope.sessionProject!.path } : {})
          }
        })
      ).toContain(`path_on_record ${folder.projectPath}`)
    }
  )

  /**
   * 补上的路径必须**落盘**，不能只活在内存里。
   *
   * `agentV3.ts` 落盘时原先抄的是文件里已有的 `sessionProject`，而不是归属表里
   * 那份权威值。于是这里补全一次、盒子一重启表就空了，`fromRecord` 读回来还是
   * 只有名字的旧戳；后台跑的活（定时任务、appAgentRunner）没有渲染层送戳下来，
   * 更是一次都拿不到。这条钉住「表 → 记录」这一步：落盘取的是
   * `getSessionBinding()`，`null`（明确解除）也要原样带过去。
   */
  it('补全之后归属表里是权威值，落盘该取它而不是文件里那份', () => {
    const stale = { projectName: folder.projectName }
    adoptSessionBinding('s', folder, stale)

    // 落盘那一步取的就是这个值（agentV3.ts 的 `const bound = getSessionBinding(...)`）
    expect(getSessionBinding('s')).toEqual(folder)
    expect(getSessionBinding('s')).not.toEqual(stale)

    // 明确解除要能和「没有记录」分开，否则落盘时会被当成 undefined 丢掉
    setSessionBinding('s', null)
    expect(getSessionBinding('s')).toBeNull()
    expect(getSessionBinding('never-seen')).toBeUndefined()
  })

  /**
   * 补上的路径必须**落盘**，不能只活在内存里。
   *
   * `agentV3.ts` 落盘时原先抄的是文件里已有的 `sessionProject`，而不是归属表里
   * 那份权威值。于是这里补全一次、盒子一重启表就空了，`fromRecord` 读回来还是
   * 只有名字的旧戳；后台跑的活（定时任务、appAgentRunner）没有渲染层送戳下来，
   * 更是一次都拿不到。这条钉住「表 → 记录」这一步：落盘取的是
   * `getSessionBinding()`，`null`（明确解除）也要原样带过去。
   */
  it('补全之后归属表里是权威值，落盘该取它而不是文件里那份', () => {
    const stale = { projectName: folder.projectName }
    adoptSessionBinding('s', folder, stale)

    // 落盘那一步取的就是这个值（agentV3.ts 的 `const bound = getSessionBinding(...)`）
    expect(getSessionBinding('s')).toEqual(folder)
    expect(getSessionBinding('s')).not.toEqual(stale)

    // 明确解除要能和「没有记录」分开，否则落盘时会被当成 undefined 丢掉
    setSessionBinding('s', null)
    expect(getSessionBinding('s')).toBeNull()
    expect(getSessionBinding('never-seen')).toBeUndefined()
  })

  it('preserves known paths, different project bindings and explicit unbinding', () => {
    for (const saved of [
      { ...folder, projectPath: 'D:/Original' },
      { projectName: 'AnotherProject' },
      null
    ]) {
      setSessionBinding('live', saved)
      expect(adoptSessionBinding('live', folder)).toEqual(saved)
      expect(adoptSessionBinding(`restored-${JSON.stringify(saved)}`, folder, saved)).toEqual(saved)
    }
  })

  it('leaves missing paths missing when the renderer has no folder', () => {
    const saved = { projectName: folder.projectName }
    setSessionBinding('s', saved)
    expect(adoptSessionBinding('s', saved)).toEqual(saved)
    expect(adoptSessionBinding('s', null)).toEqual(saved)
  })
})
