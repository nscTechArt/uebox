/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  captureEditorSnapshot,
  formatEditorSnapshotBlock,
  snapshotMatchesScope,
  stripEditorSnapshotBlock,
  type EditorSnapshot
} from './editorSnapshot'
import type { SessionProjectScope } from './sessionScope'

/*
 * WebSocket 服务的替身**不用 `vi.fn()`**。
 *
 * vi.fn 会把每次返回的 promise 记进 `mock.settledResults`，为此它自己挂一个
 * `.then` —— 而那个派生 promise 在返回值是 rejected 时没人接，vitest 当场报
 * 「未处理的拒绝」，把一个明明通过了的用例判成失败（只在同一个 mock 先成功过
 * 一次之后才发作，非常难查）。改用普通函数，自己记调用参数。
 */
let callRequestImpl: (...args: unknown[]) => Promise<unknown> = async () => ({})
const callRequestCalls: unknown[][] = []

vi.mock('../../services', () => ({
  serviceManager: {
    getWebSocketService: () => ({
      callRequest: (...args: unknown[]) => {
        callRequestCalls.push(args)
        return callRequestImpl(...args)
      }
    })
  }
}))

const scopeOf = (overrides: Partial<SessionProjectScope> = {}): SessionProjectScope => ({
  engineAvailable: true,
  targetConnectionId: 'conn-1',
  connectedProject: {
    connectionId: 'conn-1',
    projectName: 'MyGame',
    projectPath: 'D:/Games/MyGame'
  },
  outOfScopeProjects: [],
  ...overrides
})

const snapshotOf = (overrides: Partial<EditorSnapshot> = {}): EditorSnapshot => ({
  capturedAt: '2026-09-07T14:21:33.000Z',
  project: { projectName: 'MyGame', projectPath: 'D:/Games/MyGame', connectionId: 'conn-1' },
  focus: {},
  ...overrides
})

describe('captureEditorSnapshot', () => {
  beforeEach(() => {
    callRequestCalls.length = 0
    callRequestImpl = async () => ({})
  })

  /*
   * 「一个都没连」和「连着但不是你的工程」对用户是两句完全不同的话：
   * 前者要说「先把引擎打开」，后者要说「你开的是另一个工程」。
   * 作用域本身分不出来 —— 两种情况它都只是没有 targetConnectionId。
   */
  it('一个引擎都没连 → not-connected，不发请求', async () => {
    const result = await captureEditorSnapshot({
      scope: { engineAvailable: false, outOfScopeProjects: [] },
      anyConnected: false
    })

    expect(result).toEqual({ ok: false, reason: 'not-connected' })
    expect(callRequestCalls).toHaveLength(0)
  })

  /**
   * 这条是**最要命**的那个：会话属于 A、只有 B 连着。
   *
   * 这时作用域没有目标连接。要是把 `undefined` 传给 `callRequest`，服务端看到只有
   * 一个活连接就会自动选 B（`pickDefaultConnectionId`）—— 拿到的是**另一个工程**
   * 的选区，而结果里没有任何东西能看出这件事。所以这里必须一个请求都不发。
   */
  it('归属工程没连上 → project-offline，一个请求都不发', async () => {
    const result = await captureEditorSnapshot({
      scope: { engineAvailable: false, outOfScopeProjects: ['OtherGame'] },
      anyConnected: true
    })

    expect(result).toEqual({ ok: false, reason: 'project-offline' })
    expect(callRequestCalls).toHaveLength(0)
  })

  it('抓到了 —— 连接 id 是作用域给的那个，绝不是 undefined', async () => {
    callRequestImpl = async () => ({
      focusedEditor: { type: 'blueprint', name: 'BP_Player', path: '/Game/BP_Player' }
    })

    const result = await captureEditorSnapshot({ scope: scopeOf(), anyConnected: true })

    expect(result.ok).toBe(true)
    expect(callRequestCalls).toEqual([['editor.get_focus_context', {}, 'conn-1', 2000]])
    if (!result.ok) throw new Error('unreachable')
    expect(result.snapshot.project).toEqual({
      projectName: 'MyGame',
      projectPath: 'D:/Games/MyGame',
      connectionId: 'conn-1'
    })
  })

  /** 超时被记成「用户什么都没开着」的话，模型会照着一句假话往下答 */
  it('超时 → timeout，不抛', async () => {
    callRequestImpl = async () => {
      throw Object.assign(new Error('timeout'), { code: 'E_TIMEOUT' })
    }

    await expect(captureEditorSnapshot({ scope: scopeOf(), anyConnected: true })).resolves.toEqual({
      ok: false,
      reason: 'timeout'
    })
  })

  it('插件报别的错 → error，不抛', async () => {
    callRequestImpl = async () => {
      throw new Error('boom')
    }

    await expect(captureEditorSnapshot({ scope: scopeOf(), anyConnected: true })).resolves.toEqual({
      ok: false,
      reason: 'error'
    })
  })
})

describe('snapshotMatchesScope', () => {
  /** 编辑器重连一次连接 id 就换，工程还是那个工程 —— 所以认路径 */
  it('路径相同就算同一个工程，连接 id 变了也认', () => {
    expect(
      snapshotMatchesScope(
        snapshotOf({
          project: { projectName: 'MyGame', projectPath: 'D:/Games/MyGame', connectionId: '旧的' }
        }),
        scopeOf()
      )
    ).toBe(true)
  })

  it('斜杠方向和大小写不一致也认', () => {
    expect(
      snapshotMatchesScope(
        snapshotOf({
          project: { projectName: 'MyGame', projectPath: 'd:\\games\\mygame\\', connectionId: 'x' }
        }),
        scopeOf()
      )
    ).toBe(true)
  })

  /** 拦不住的后果是「拿着 A 的选区在 B 上动手」，而且全程不报错 */
  it('路径不同 → 拦下', () => {
    expect(
      snapshotMatchesScope(
        snapshotOf({
          project: { projectName: 'Other', projectPath: 'D:/Games/Other', connectionId: 'x' }
        }),
        scopeOf()
      )
    ).toBe(false)
  })

  it('两边都没记路径时退回比名字', () => {
    const scope = scopeOf({
      connectedProject: { connectionId: 'conn-1', projectName: 'MyGame' }
    })
    expect(
      snapshotMatchesScope(
        snapshotOf({ project: { projectName: 'MyGame', connectionId: 'x' } }),
        scope
      )
    ).toBe(true)
    expect(
      snapshotMatchesScope(
        snapshotOf({ project: { projectName: 'Other', connectionId: 'x' } }),
        scope
      )
    ).toBe(false)
  })

  /** 这一轮压根没有目标工程，块描述的东西这轮碰不到 */
  it('作用域没有目标连接 → 拦下', () => {
    expect(
      snapshotMatchesScope(snapshotOf(), { engineAvailable: false, outOfScopeProjects: [] })
    ).toBe(false)
  })
})

describe('formatEditorSnapshotBlock', () => {
  it('什么都没开：只报关卡那一行，不占篇幅', () => {
    const block = formatEditorSnapshotBlock(
      snapshotOf({
        focus: { focusedEditor: { type: 'level', name: 'TestMap', path: '' } }
      })
    )

    expect(block).toContain('last_active_asset_editor: level TestMap')
    expect(block).toContain('selected_nodes: none')
    expect(block).toContain('selected_actors: none')
    expect(block).toContain('content_browser: none')
  })

  /**
   * 键名叫 `last_active_asset_editor` 不是 `focused`，这是**故意**的。
   *
   * 插件挑的是「所有打开的资产编辑器里最后激活的那个」，只有一个都没开时才回退
   * 成关卡。蓝图开着、用户回到关卡里选 Actor 时，这一行写的仍是蓝图 ——
   * 叫 `focused` 会让模型以为那就是用户眼前的界面，然后去改错东西。
   */
  it('键名是 last_active_asset_editor，不是 focused', () => {
    const block = formatEditorSnapshotBlock(
      snapshotOf({
        focus: { focusedEditor: { type: 'blueprint', name: 'BP_X', path: '/Game/BP_X' } }
      })
    )

    expect(block).toContain('last_active_asset_editor:')
    expect(block).not.toContain('focused:')
  })

  it('蓝图节点报 NodeGuid，材质节点报 guid，注释框没 id 就不写 #', () => {
    const block = formatEditorSnapshotBlock(
      snapshotOf({
        focus: {
          focusedEditor: { type: 'blueprint', name: 'BP_Player', path: '/Game/BP_Player' },
          focusedGraph: { name: 'EventGraph', path: '/Game/BP_Player:EventGraph', node_count: 42 },
          selectedNodes: [
            {
              node_id: 'A1B2',
              class: 'K2Node_Event',
              title: 'Event BeginPlay',
              pos_x: 0,
              pos_y: 0
            },
            {
              node_id: 'MaterialExpressionAdd_3',
              guid: 'GUID-STABLE',
              class: 'MaterialGraphNode',
              title: 'Add',
              pos_x: 0,
              pos_y: 0
            },
            { class: 'EdGraphNode_Comment', title: '这一段是跳跃', pos_x: 0, pos_y: 0 }
          ],
          selectedNodeCount: 3
        }
      })
    )

    expect(block).toContain('graph: EventGraph (42 nodes)')
    expect(block).toContain('selected_nodes (3):')
    expect(block).toContain('- Event BeginPlay (K2Node_Event) #A1B2')
    // 材质优先用 GUID —— 位置编号删个节点就会漂到别人身上
    expect(block).toContain('- Add (MaterialGraphNode) #GUID-STABLE')
    expect(block).not.toContain('#MaterialExpressionAdd_3')
    expect(block).toContain('- 这一段是跳跃 (EdGraphNode_Comment)')
  })

  /**
   * 用户工程里装着**旧插件**时，材质节点只有位置编号（`类名_数组下标`）。
   *
   * 那个编号删一个节点就会漂到另一个同类节点上，而且不报错。系统提示词承诺
   * 「块里的 id 稳定、可以直接喂给 ue_material_*」—— 把位置编号写进去就是在
   * 兑现一个做不到的承诺，而闪存天然要隔一段时间才被用上。
   */
  it('材质节点缺 guid（旧插件）→ 整份不给 id，并说明原因', () => {
    const block = formatEditorSnapshotBlock(
      snapshotOf({
        focus: {
          focusedEditor: { type: 'material', name: 'M_Glow', path: '/Game/M_Glow' },
          selectedNodes: [
            {
              node_id: 'MaterialExpressionAdd_3',
              class: 'MaterialGraphNode',
              title: 'Add',
              pos_x: 0,
              pos_y: 0
            }
          ],
          selectedNodeCount: 1
        }
      })
    )

    expect(block).not.toContain('#MaterialExpressionAdd_3')
    expect(block).toContain('does not report stable ones')
    expect(block).toContain('- Add (MaterialGraphNode)')
  })

  /** 一份里只要有一个缺 guid 就整份不给 —— 混着给等于让模型自己判断哪个能信 */
  it('材质节点部分缺 guid → 整份都不给 id', () => {
    const block = formatEditorSnapshotBlock(
      snapshotOf({
        focus: {
          focusedEditor: { type: 'material', name: 'M_Glow', path: '/Game/M_Glow' },
          selectedNodes: [
            {
              node_id: 'A_1',
              guid: 'GUID-A',
              class: 'MaterialGraphNode',
              title: 'A',
              pos_x: 0,
              pos_y: 0
            },
            { node_id: 'B_2', class: 'MaterialGraphNode', title: 'B', pos_x: 0, pos_y: 0 }
          ],
          selectedNodeCount: 2
        }
      })
    )

    expect(block).not.toContain('#GUID-A')
    expect(block).not.toContain('#B_2')
  })

  /** 蓝图的 node_id 本身就是 NodeGuid，跟着节点走，不受这条规则影响 */
  it('蓝图节点照常给 id —— 它的 node_id 是稳的', () => {
    const block = formatEditorSnapshotBlock(
      snapshotOf({
        focus: {
          focusedEditor: { type: 'blueprint', name: 'BP_X', path: '/Game/BP_X' },
          selectedNodes: [
            { node_id: 'NODE-GUID', class: 'K2Node_Event', title: 'BeginPlay', pos_x: 0, pos_y: 0 }
          ],
          selectedNodeCount: 1
        }
      })
    )

    expect(block).toContain('#NODE-GUID')
    expect(block).not.toContain('does not report stable ones')
  })

  it('坐标不进块 —— 模型用不上，一条节点省一半字', () => {
    const block = formatEditorSnapshotBlock(
      snapshotOf({
        focus: {
          selectedNodes: [
            { node_id: 'A', class: 'K2Node_Event', title: 'X', pos_x: 1234, pos_y: 5678 }
          ]
        }
      })
    )

    expect(block).not.toContain('1234')
    expect(block).not.toContain('5678')
  })

  it('被插件截断时把总数说出来', () => {
    const block = formatEditorSnapshotBlock(
      snapshotOf({
        focus: {
          selectedNodes: [{ node_id: 'A', class: 'K2Node_Event', title: 'X', pos_x: 0, pos_y: 0 }],
          selectedNodeCount: 73,
          selectedNodesTruncated: true
        }
      })
    )

    expect(block).toContain('selected_nodes (73, showing 1):')
  })

  it('Actor 和内容浏览器各自成段', () => {
    const block = formatEditorSnapshotBlock(
      snapshotOf({
        focus: {
          selectedActors: [
            { name: 'Cube_2', label: '大箱子', class: 'StaticMeshActor', path: '/Game/Map.Cube_2' }
          ],
          selectedActorCount: 1,
          contentBrowser: {
            selectedAssets: [{ name: 'M_Glow', path: '/Game/M_Glow', class: 'Material' }],
            selectedAssetCount: 1,
            selectedAssetsTruncated: false,
            selectedFolders: ['/Game/Materials']
          }
        }
      })
    )

    expect(block).toContain('- 大箱子 (StaticMeshActor) /Game/Map.Cube_2')
    expect(block).toContain('- M_Glow /Game/M_Glow')
    expect(block).toContain('folders: /Game/Materials')
  })
})

describe('stripEditorSnapshotBlock', () => {
  /**
   * 插话的「已生效」回执是**按文本相等**匹配的（`agentStream.markSteerApplied`）：
   * 界面存的是用户打的原话，模型收到的是「块 + 原话」。不剥的话两边永远对不上，
   * 那条插话会一直显示「未生效」—— 而它其实早就进上下文了。
   */
  it('剥掉开头的块，留下用户真正说的那句', () => {
    const text = `${formatEditorSnapshotBlock(snapshotOf())}\n\n把这个改成 Lerp`

    expect(stripEditorSnapshotBlock(text)).toBe('把这个改成 Lerp')
  })

  it('没有块就原样返回', () => {
    expect(stripEditorSnapshotBlock('把这个改成 Lerp')).toBe('把这个改成 Lerp')
  })

  /** 用户自己在话里打出这串字符不该被动到 —— 只认开头那一个 */
  it('块不在开头就不动它', () => {
    const text = '这段 <editor-snapshot foo>bar</editor-snapshot> 是我贴的日志'

    expect(stripEditorSnapshotBlock(text)).toBe(text)
  })

  it('只有开标签没有闭标签时原样返回，不吞掉正文', () => {
    const text = '<editor-snapshot captured_at="x">\n没写完'

    expect(stripEditorSnapshotBlock(text)).toBe(text)
  })
})
