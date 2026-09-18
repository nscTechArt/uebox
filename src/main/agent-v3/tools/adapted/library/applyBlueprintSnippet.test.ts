/**
 * @vitest-environment node
 *
 * `blueprint_library_apply` 的四道闸。
 *
 * 这个工具是整条链路里唯一会改用户工程的一步，前面几轮评审推翻的每一条
 * 都在这里落成一道闸。测的就是「哪一道被摘掉了都不会有别的东西变红」：
 *
 *   闸 1 能力探测 —— 摘掉它，旧插件会静默忽略 require_empty 照写不误
 *   连接钉死 —— 不钉的话，探的是 A 连接、写的可能是 B，闸 1 白设
 *   闸 2 require_empty —— 摘掉它，同名事件被复用、已有连线被顶掉
 *   闸 3 粘完核对 —— 只看 ok 的话，编不过的图照样存进去还说「编译通过」
 *   闸 4 落盘核对 —— 摘掉它，会报「成功」但改动只在内存里
 *
 * 另外钉住改道之后的那条性质：**发下去的是库里那段正文，盒子一个字都不改**。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const callRequest = vi.fn()
const getConnectionCount = vi.fn(() => 1)

vi.mock('../../../../services', () => ({
  serviceManager: {
    getWebSocketService: () => ({ callRequest, getConnectionCount })
  }
}))

/**
 * 每次调用返回**不同**的 id —— 模拟 `getTargetConnectionId()` 的自愈重连。
 *
 * 工具如果老老实实每次都调它，各条命令就会散到不同连接上；
 * 钉死了的话，全程只会看到第一次那个 id。
 */
const { getTargetConnectionId } = vi.hoisted(() => {
  let seq = 0
  return { getTargetConnectionId: vi.fn((): string | undefined => `conn-${++seq}`) }
})

vi.mock('../../../core/projectTargetContext', () => ({ getTargetConnectionId }))

/** 交互式编辑器列表 —— 上下文没指定目标时的兜底解析走它 */
const { getInteractiveProjects } = vi.hoisted(() => ({
  getInteractiveProjects: vi.fn(() => [
    { connectionId: 'only-conn', projectName: 'Probe', projectPath: 'I:/Probe' }
  ])
}))

vi.mock('../../../../services/project/projectManager', () => ({
  projectManager: { getInteractiveProjects }
}))

vi.mock('./vaultRoot', () => ({
  requireVaultRoot: () => ({ vaultRoot: 'H:/fake-vault' }),
  getVaultRoot: () => 'H:/fake-vault'
}))

// vi.mock 的工厂会被提到文件最顶上执行，所以引用到的变量必须也提上去
const { findEntryById } = vi.hoisted(() => ({ findEntryById: vi.fn() }))
vi.mock('../../../../services/library/libraryEntryStore', async () => {
  const actual = await vi.importActual<
    typeof import('../../../../services/library/libraryEntryStore')
  >('../../../../services/library/libraryEntryStore')
  return { ...actual, findEntryById }
})

import { createBlueprintLibraryApplyTool } from './applyBlueprintSnippet'

type ToolResult = Record<string, unknown>
type Executable = { execute: (input: unknown) => Promise<ToolResult> }

const run = (input: unknown): Promise<ToolResult> =>
  (createBlueprintLibraryApplyTool() as unknown as Executable).execute(input)

const INPUT = {
  entry_id: 'entry-1',
  blueprint_path: '/Game/BP_Enemy',
  graph_name: 'EventGraph',
  mode: 'into_empty_graph' as const
}

const T3D =
  'Begin Object Class=/Script/BlueprintGraph.K2Node_Event Name="K2Node_Event_0"\nEnd Object'

function snippetEntry(): unknown {
  return {
    form: 'snippet',
    entry: {
      dirPath: 'x',
      relPath: 'x',
      library: 'blueprint',
      manifest: {
        format: 'unreal-box-blueprint',
        formatVersion: 1,
        id: 'entry-1',
        name: '受击闪红',
        createdAt: 1,
        updatedAt: 2,
        cover: '',
        payload: {
          form: 'snippet',
          t3d: T3D,
          meta: { nodeCount: 1, connectionCount: 0, classes: ['Event'], openPorts: [] }
        }
      }
    }
  }
}

/** 默认：能力齐、粘贴成功、编译零错误、保存成功 */
function happyPath(): void {
  callRequest.mockImplementation(async (method: string, params: Record<string, unknown>) => {
    if (method === 'system.get_project_info') {
      return {
        plugin_version: '1.4.0',
        capabilities: { blueprint_require_empty: true, material_fail_if_exists: true }
      }
    }
    if (method === 'blueprint.import_t3d') {
      return { ok: true, undoable: true, imported_count: 1, compiled: true, compile_error_count: 0 }
    }
    if (method === 'editor.save') {
      return { saved: (params.assets as string[]) ?? [], failed: [], still_dirty_count: 0 }
    }
    return null
  })
}

/** 只覆盖 import_t3d 的回执，其余保持顺利 */
function withApplyResponse(apply: Record<string, unknown>): void {
  callRequest.mockImplementation(async (method: string, params: Record<string, unknown>) => {
    if (method === 'system.get_project_info') {
      return { capabilities: { blueprint_require_empty: true } }
    }
    if (method === 'blueprint.import_t3d') return apply
    if (method === 'editor.save') {
      return { saved: (params.assets as string[]) ?? [], failed: [], still_dirty_count: 0 }
    }
    return null
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  getConnectionCount.mockReturnValue(1)
  getTargetConnectionId.mockImplementation(() => 'conn-pinned')
  getInteractiveProjects.mockReturnValue([
    { connectionId: 'only-conn', projectName: 'Probe', projectPath: 'I:/Probe' }
  ])
  findEntryById.mockResolvedValue(snippetEntry())
  happyPath()
})

describe('闸 1：能力探测，失败即关', () => {
  it('插件没有 capabilities（旧版）→ 写入前就拒绝', async () => {
    callRequest.mockImplementation(async (method: string) => {
      if (method === 'system.get_project_info') return { plugin_version: '1.0.0' }
      return { ok: true }
    })

    const result = await run(INPUT)

    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('太旧')
    // 关键：一条写入命令都没发出去
    expect(callRequest).not.toHaveBeenCalledWith(
      'blueprint.import_t3d',
      expect.anything(),
      expect.anything(),
      expect.anything()
    )
  })

  it('capabilities 里那一项是 false → 拒绝', async () => {
    callRequest.mockImplementation(async (method: string) => {
      if (method === 'system.get_project_info') {
        return { capabilities: { blueprint_require_empty: false } }
      }
      return { ok: true }
    })

    const result = await run(INPUT)
    expect(result.success).toBe(false)
    expect(callRequest).not.toHaveBeenCalledWith(
      'blueprint.import_t3d',
      expect.anything(),
      expect.anything(),
      expect.anything()
    )
  })

  it('探测本身失败 → 当作不支持，不是「先试试」', async () => {
    callRequest.mockImplementation(async (method: string) => {
      if (method === 'system.get_project_info') throw new Error('timeout')
      return { ok: true }
    })

    const result = await run(INPUT)
    expect(result.success).toBe(false)
    expect(callRequest).not.toHaveBeenCalledWith(
      'blueprint.import_t3d',
      expect.anything(),
      expect.anything(),
      expect.anything()
    )
  })

  it('没连引擎 → 给人话，不是「失败」', async () => {
    getConnectionCount.mockReturnValue(0)
    const result = await run(INPUT)
    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('虚幻编辑器')
  })

  it('插件认得 require_empty 但不认得 import_t3d → 翻译成「插件太旧」', async () => {
    /*
     * 这两件事是分两次进插件的：`require_empty` 先落地，`import_t3d` 后落地。
     * 所以存在一个中间版本 —— 能力位答 true，命令表里却没有这条。
     * 插件回的是 404 "Unknown method"，**一个字都没写**，安全上没问题，
     * 但那句原文对用户毫无意义。
     */
    withApplyResponse({
      ok: false,
      success: false,
      code: 404,
      error: 'Unknown method: blueprint.import_t3d'
    })

    const result = await run(INPUT)
    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('插件太旧')
    expect(String(result.error)).not.toContain('Unknown method')
    expect(callRequest).not.toHaveBeenCalledWith(
      'editor.save',
      expect.anything(),
      expect.anything(),
      expect.anything()
    )
  })
})

describe('连接钉死 —— 探的和写的必须是同一条', () => {
  it('能力探测、粘贴、保存全发给同一个 connectionId', async () => {
    /*
     * getTargetConnectionId 在这个测试里每次返回不同的 id（模拟自愈重连）。
     * 工具要是每条命令都现调它，能力探测发给 conn-1、写入发给 conn-2 ——
     * 而 conn-2 那头的插件版本没人验过，闸 1 等于没设。
     */
    await run(INPUT)

    const connectionIds = callRequest.mock.calls.map((args) => args[2])
    expect(connectionIds.length).toBeGreaterThanOrEqual(3)
    expect(new Set(connectionIds).size).toBe(1)
  })

  it('全程只解析一次连接', async () => {
    await run(INPUT)
    expect(getTargetConnectionId).toHaveBeenCalledTimes(1)
  })

  it('上下文没指定目标时，解析成那个唯一连接的具体 id —— 不传 undefined 下去', async () => {
    /*
     * 传 undefined 的话，底层 pickDefaultConnectionId() 会在**每次请求时**
     * 重新挑一遍。能力探测挑中新版、中间重连、写入挑中旧版 —— 闸 1 白设，
     * 而工具还会报成功。外部 MCP 客户端没指定工程时走的正是这条路。
     */
    getTargetConnectionId.mockReturnValue(undefined)

    await run(INPUT)

    const connectionIds = callRequest.mock.calls.map((args) => args[2])
    expect(connectionIds.every((id) => id === 'only-conn')).toBe(true)
  })

  it('一个编辑器都没连 → 拒绝，不发任何命令', async () => {
    getTargetConnectionId.mockReturnValue(undefined)
    getInteractiveProjects.mockReturnValue([])

    const result = await run(INPUT)
    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('虚幻编辑器')
    expect(callRequest).not.toHaveBeenCalled()
  })

  it('连着好几个工程又没指定 → 拒绝，不猜', async () => {
    getTargetConnectionId.mockReturnValue(undefined)
    getInteractiveProjects.mockReturnValue([
      { connectionId: 'a', projectName: 'ProjA', projectPath: 'I:/A' },
      { connectionId: 'b', projectName: 'ProjB', projectPath: 'I:/B' }
    ])

    const result = await run(INPUT)
    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('ProjA')
    expect(callRequest).not.toHaveBeenCalled()
  })
})

describe('发下去的就是库里那段正文', () => {
  it('text 原样发出，盒子不重排、不翻译', async () => {
    await run(INPUT)

    const call = callRequest.mock.calls.find((args) => args[0] === 'blueprint.import_t3d')
    const params = call![1] as Record<string, unknown>
    expect(params.text).toBe(T3D)
    // 改道之前这里会先算一遍 ELK 布局再发 nodes / connections
    expect(params).not.toHaveProperty('nodes')
    expect(params).not.toHaveProperty('connections')
  })

  it('蓝图路径归一化成包路径', async () => {
    await run({ ...INPUT, blueprint_path: '/Game/BP_Enemy.BP_Enemy' })

    const call = callRequest.mock.calls.find((args) => args[0] === 'blueprint.import_t3d')
    expect((call![1] as Record<string, unknown>).blueprint_path).toBe('/Game/BP_Enemy')
  })
})

describe('拒绝原因要原样带出来', () => {
  it('SendError 归一化后的形状（error / code），不是 errors 数组', async () => {
    /*
     * 插件的 require_empty 拒绝走的是 SendError()，传输层把它归一化成
     * `{ ok:false, success:false, error: <message>, code: 409 }` ——
     * **没有 errors 数组**。只读 errors 的话，「函数已有局部变量」
     * 会被降级成一句「粘贴失败」，用户不知道该去改什么。
     */
    withApplyResponse({
      ok: false,
      success: false,
      code: 409,
      error:
        "require_empty: graph 'Fn_LocalVar' is not empty - function entry declares 1 local variable(s). Nothing was written.",
      reason: 'function entry declares 1 local variable(s)',
      graph_name: 'Fn_LocalVar',
      __rpc: { code: 409 }
    })

    const result = await run(INPUT)
    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('local variable')
    expect(String(result.error)).not.toBe('粘贴失败')
  })

  it('只有 message 时也认（有些路径不填 error）', async () => {
    withApplyResponse({ ok: false, message: 'Blueprint is currently compiling' })
    expect(String((await run(INPUT)).error)).toContain('currently compiling')
  })

  it('只有 Details.reason 时也认', async () => {
    withApplyResponse({ ok: false, reason: 'pin Then_2 is already connected' })
    expect(String((await run(INPUT)).error)).toContain('Then_2')
  })

  it('引擎不收这段文本时，把原话带出来', async () => {
    // CanImportNodesFromText 说不行 —— 比如这段节点在目标图类型里不合法
    withApplyResponse({
      ok: false,
      code: 400,
      error: 'This graph will not accept that text (CanImportNodesFromText said no).'
    })
    expect(String((await run(INPUT)).error)).toContain('CanImportNodesFromText')
  })

  it('插件什么都没说才退回泛化文案，并说明是插件没给原因', async () => {
    withApplyResponse({ ok: false })
    expect(String((await run(INPUT)).error)).toContain('插件没有给出原因')
  })
})

describe('判空只由引擎做，app 侧不再自己数节点', () => {
  it('不发 get_graph 去数节点', async () => {
    /*
     * 上一版在这儿探一次、节点数大于零就拒绝 —— 结果把真正的空图挡在门外：
     * 新建的函数图自带 FunctionEntry，新建 Actor 蓝图的事件图自带三个占位
     * 事件节点（真机实测，发现二）。判据只有一份，在插件里。
     */
    await run(INPUT)

    expect(callRequest).not.toHaveBeenCalledWith(
      'blueprint.get_graph',
      expect.anything(),
      expect.anything(),
      expect.anything()
    )
  })

  it('插件说不空 → 把插件给的原因原样透出来，不自己编一句', async () => {
    withApplyResponse({
      ok: false,
      code: 409,
      error:
        "require_empty: graph 'Fn_LocalVar' is not empty - function entry declares 1 local variable(s). Nothing was written."
    })

    const result = await run(INPUT)
    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('local variable')
    // 没写成就绝不保存
    expect(callRequest).not.toHaveBeenCalledWith(
      'editor.save',
      expect.anything(),
      expect.anything(),
      expect.anything()
    )
  })
})

describe('闸 3：粘完核对 —— ok:true 不代表干净', () => {
  it('编译报错 → 报失败、不保存', async () => {
    // 插件先无条件 ok:true（粘贴成功），再把编译结果附上。
    // 只看 ok 的话，一张编不过的图会被照常保存还回一句「编译通过」。
    withApplyResponse({
      ok: true,
      compiled: true,
      compile_error_count: 1,
      diagnostics: [{ severity: 'error', message: 'Branch node has no exec input', node_id: 'br' }]
    })

    const result = await run(INPUT)

    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('编译没过')
    expect(String(result.error)).toContain('Branch node has no exec input')
    expect(callRequest).not.toHaveBeenCalledWith(
      'editor.save',
      expect.anything(),
      expect.anything(),
      expect.anything()
    )
  })

  it('有节点的自身引用断了 → 报失败、不保存', async () => {
    /*
     * 粘过来的节点调的是源蓝图自己类上的函数，这个工程里没有。
     * 编辑器粘贴到这一步会弹修正框，自动化路径弹不了，插件如实报告。
     * 这种图在编辑器里是红的，存进去就是给用户留一堆红节点。
     */
    withApplyResponse({
      ok: true,
      compile_error_count: 0,
      self_context_unresolved: ['计算伤害 (A1B2)', '刷新血条 (C3D4)']
    })

    const result = await run(INPUT)
    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('计算伤害')
    expect(result.self_context_unresolved).toHaveLength(2)
    expect(callRequest).not.toHaveBeenCalledWith(
      'editor.save',
      expect.anything(),
      expect.anything(),
      expect.anything()
    )
  })

  it('编译零错误、引用也没断，才往下走', async () => {
    withApplyResponse({ ok: true, compiled: true, compile_error_count: 0 })
    expect((await run(INPUT)).success).toBe(true)
  })

  it('编译警告不拦，但要如实带出来', async () => {
    withApplyResponse({
      ok: true,
      compiled: true,
      compile_error_count: 0,
      compile_warning_count: 2
    })

    const result = await run(INPUT)
    expect(result.success).toBe(true)
    expect(result.compile_warning_count).toBe(2)
  })
})

describe('闸 2：引擎内保证', () => {
  it('写入命令一定带 require_empty', async () => {
    await run(INPUT)

    const call = callRequest.mock.calls.find((args) => args[0] === 'blueprint.import_t3d')
    expect(call).toBeDefined()
    const params = call![1] as Record<string, unknown>
    expect(params.require_empty).toBe(true)
  })

  it('插件回 ok:false → 报失败，且不去保存', async () => {
    withApplyResponse({ ok: false, error: 'require_empty: graph is not empty' })

    const result = await run(INPUT)
    expect(result.success).toBe(false)
    // 没粘成功就绝不能顺手 save
    expect(callRequest).not.toHaveBeenCalledWith(
      'editor.save',
      expect.anything(),
      expect.anything(),
      expect.anything()
    )
  })
})

describe('闸 4：落盘核对', () => {
  it('点名存目标资产，不是 scope:all', async () => {
    await run(INPUT)

    const call = callRequest.mock.calls.find((args) => args[0] === 'editor.save')
    expect(call).toBeDefined()
    const params = call![1] as Record<string, unknown>
    expect(params.scope).toBe('list')
    expect(params.assets).toEqual(['/Game/BP_Enemy'])
  })

  it('目标资产在 saved 里 → 成功', async () => {
    const result = await run(INPUT)
    expect(result.success).toBe(true)
    expect(result.blueprint_path).toBe('/Game/BP_Enemy')
  })

  it('saved 里回的是对象路径也认得出 —— 比之前先归一化', async () => {
    callRequest.mockImplementation(async (method: string) => {
      if (method === 'system.get_project_info') {
        return { capabilities: { blueprint_require_empty: true } }
      }
      if (method === 'blueprint.import_t3d') return { ok: true, compile_error_count: 0 }
      if (method === 'editor.save') {
        return { saved: ['/Game/BP_Enemy.BP_Enemy'], failed: [] }
      }
      return null
    })

    expect((await run(INPUT)).success).toBe(true)
  })

  it('目标不在 saved 也不在 failed → 报「没确认上」，不许报成功', async () => {
    callRequest.mockImplementation(async (method: string) => {
      if (method === 'system.get_project_info') {
        return { capabilities: { blueprint_require_empty: true } }
      }
      if (method === 'blueprint.import_t3d') return { ok: true, compile_error_count: 0 }
      // still_dirty_count 是全工程口径，判断不了目标资产 —— 给个非零值，
      // 确认工具没拿它当判据
      if (method === 'editor.save') return { saved: [], failed: [], still_dirty_count: 7 }
      return null
    })

    const result = await run(INPUT)
    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('没确认上')
  })

  it('保存失败 → 把插件给的原因原样带出来', async () => {
    callRequest.mockImplementation(async (method: string) => {
      if (method === 'system.get_project_info') {
        return { capabilities: { blueprint_require_empty: true } }
      }
      if (method === 'blueprint.import_t3d') return { ok: true, compile_error_count: 0 }
      if (method === 'editor.save') {
        return {
          saved: [],
          failed: [{ package: '/Game/BP_Enemy', error: 'file is read-only' }]
        }
      }
      return null
    })

    const result = await run(INPUT)
    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('read-only')
  })
})

describe('条目形态', () => {
  it('手工粘进库的老条目明确拒绝，不偷偷失败', async () => {
    findEntryById.mockResolvedValue({
      form: 't3d',
      entry: { manifest: { id: 'entry-1', name: '旧条目', payload: { graphs: [] } } }
    })

    const result = await run(INPUT)
    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('老条目')
    expect(String(result.error)).toContain('粘贴')
  })

  it('条目不存在 → 说清楚是哪个 id', async () => {
    findEntryById.mockResolvedValue(null)
    const result = await run(INPUT)
    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('entry-1')
  })
})

describe('回执如实上报', () => {
  it('undoable:false 要带出来 —— Ctrl+Z 兜不了底这件事用户得知道', async () => {
    withApplyResponse({ ok: true, undoable: false, compile_error_count: 0 })

    const result = await run(INPUT)
    expect(result.success).toBe(true)
    expect(result.undoable).toBe(false)
    expect(String(result.summary)).toContain('Ctrl+Z')
  })

  it('顶掉的引擎占位事件节点要说一声 —— 删了东西就得让用户看见', async () => {
    /*
     * 新建 Actor 蓝图自带三个灰色占位事件（BeginPlay / Tick / ActorBeginOverlap）。
     * 粘一个同名事件进去，引擎那个会被顶掉 —— 编辑器自己的粘贴也是这么做的。
     * 用户自己放的事件节点插件一个都不动，但被顶掉这件事还是要回上来。
     */
    withApplyResponse({
      ok: true,
      compile_error_count: 0,
      removed_ghost_events: ['事件开始运行']
    })

    const result = await run(INPUT)
    expect(result.success).toBe(true)
    expect(result.removed_ghost_events).toEqual(['事件开始运行'])
  })

  it('片段里的悬空端口要提醒去接', async () => {
    findEntryById.mockResolvedValue({
      form: 'snippet',
      entry: {
        manifest: {
          id: 'entry-1',
          name: '受击闪红',
          payload: {
            form: 'snippet',
            t3d: T3D,
            meta: {
              nodeCount: 1,
              connectionCount: 0,
              classes: ['Event'],
              openPorts: [{ nodeId: 'print', pinName: 'execute', dir: 'in', formerPeer: 'x.then' }]
            }
          }
        }
      }
    })

    const result = await run(INPUT)
    expect(result.success).toBe(true)
    expect(result.open_ports).toEqual(['print.execute'])
    expect(String(result.summary)).toContain('悬空端口')
  })
})
