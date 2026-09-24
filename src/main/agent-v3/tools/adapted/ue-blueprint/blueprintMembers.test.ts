/**
 * @vitest-environment node
 *
 * 蓝图成员「调 / 删」三件套的契约测试。
 *
 * 测的重点不是「RPC 发出去了」，而是三条容易静默出错的约定：
 *   1. 没传的字段**不能**透传成 null —— 引擎侧 TryGetBoolField 会把 null
 *      读成 false，等于用户没碰的开关被我们悄悄关掉了
 *   2. 删变量必须把「引用它的节点变成孤儿」讲出来，否则调用方以为删干净了
 *   3. 建完分发器必须告诉调用方广播/订阅的节点名怎么写，否则建了也用不上
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const callRequest = vi.fn()
const getConnectionCount = vi.fn(() => 1)

vi.mock('../../../../services', () => ({
  serviceManager: {
    getWebSocketService: () => ({ callRequest, getConnectionCount })
  }
}))

vi.mock('../../../core/projectTargetContext', () => ({
  getTargetConnectionId: () => 'conn-1'
}))

import {
  createBlueprintComponentEventTool,
  createBlueprintEventDispatcherTool,
  createBlueprintFunctionSignatureTool,
  createSetBlueprintParentClassTool,
  createRemoveBlueprintVariableTool,
  createSetBlueprintVariableMetaTool
} from './blueprintMembers'

type ToolResult = Record<string, unknown>
type Executable = { execute: (input: unknown) => Promise<ToolResult> }

const runMeta = (input: unknown): Promise<ToolResult> =>
  (createSetBlueprintVariableMetaTool() as unknown as Executable).execute(input)
const runRemove = (input: unknown): Promise<ToolResult> =>
  (createRemoveBlueprintVariableTool() as unknown as Executable).execute(input)
const runDispatcher = (input: unknown): Promise<ToolResult> =>
  (createBlueprintEventDispatcherTool() as unknown as Executable).execute(input)

/** 上一次 callRequest 的 (method, params) */
const lastCall = (): { method: string; params: Record<string, unknown> } => {
  const [method, params] = callRequest.mock.calls.at(-1) as [string, Record<string, unknown>]
  return { method, params }
}

beforeEach(() => {
  callRequest.mockReset()
  getConnectionCount.mockReturnValue(1)
})

describe('blueprint_set_variable_meta', () => {
  const ok = {
    ok: true,
    blueprint_path: '/Game/BP_Door',
    name: 'OpenSpeed',
    applied: ['instance_editable', 'category'],
    variable: {
      name: 'OpenSpeed',
      type: 'real',
      instance_editable: true,
      blueprint_read_only: false,
      category: '门'
    }
  }

  /**
   * 这条是整个文件里最要紧的。
   *
   * 全量透传的话，没传的布尔会变成 JSON 里的 null，引擎侧
   * `TryGetBoolField` 读到就当 false —— 用户只想改分类，
   * 结果实例可编辑被顺手关掉了，而且**没有任何报错**。
   */
  it('没传的字段不透传，避免被引擎读成 false', async () => {
    callRequest.mockResolvedValue(ok)
    await runMeta({ blueprint_path: '/Game/BP_Door', name: 'OpenSpeed', category: '门' })

    const { params } = lastCall()
    expect(params).toEqual({ blueprint_path: '/Game/BP_Door', name: 'OpenSpeed', category: '门' })
    expect('instance_editable' in params).toBe(false)
    expect('expose_on_spawn' in params).toBe(false)
  })

  it('显式传 false 要透传 —— 那是用户的意图，不是「没传」', async () => {
    callRequest.mockResolvedValue(ok)
    await runMeta({
      blueprint_path: '/Game/BP_Door',
      name: 'OpenSpeed',
      instance_editable: false
    })

    expect(lastCall().params.instance_editable).toBe(false)
  })

  it('走 blueprint.set_variable_meta 这条 RPC', async () => {
    callRequest.mockResolvedValue(ok)
    await runMeta({ blueprint_path: '/Game/BP_Door', name: 'OpenSpeed', category: '门' })
    expect(lastCall().method).toBe('blueprint.set_variable_meta')
  })

  it('回执里带上引擎实际生效的值，而不是请求里的值', async () => {
    // expose_on_spawn 会被引擎顺带打开 instance_editable，
    // 回请求里的值会骗人
    callRequest.mockResolvedValue({
      ...ok,
      applied: ['expose_on_spawn'],
      variable: { ...ok.variable, instance_editable: true }
    })
    const result = await runMeta({
      blueprint_path: '/Game/BP_Door',
      name: 'OpenSpeed',
      expose_on_spawn: true
    })

    expect(result.success).toBe(true)
    expect(String(result.message)).toContain('实例可编辑=true')
  })

  /**
   * 引擎侧改完会顺带编译 —— 实例认的是生成类上的属性，不编译就还是旧标记
   * （2026-09-24 用户反馈：回执说可编辑，实例赋值却被拒）。
   * 编译失败时生成类可能没换新，这时必须把话说出来，不能只报「已更新」。
   */
  it('编译有错时带回错误数和警告，提示先编译再赋值', async () => {
    callRequest.mockResolvedValue({
      ...ok,
      compiled: true,
      compile_error_count: 2,
      warning: 'The variable is not on the compiled class yet'
    })
    const result = await runMeta({
      blueprint_path: '/Game/BP_Door',
      name: 'OpenSpeed',
      instance_editable: true
    })

    expect(result.success).toBe(true)
    expect(result.compile_error_count).toBe(2)
    expect(result.warning).toContain('compiled class')
    expect(String(result.message)).toContain('blueprint_compile')
  })

  it('编译干净时不塞多余字段', async () => {
    callRequest.mockResolvedValue({ ...ok, compiled: true, compile_error_count: 0 })
    const result = await runMeta({ blueprint_path: '/Game/BP_Door', name: 'OpenSpeed', category: '门' })

    expect('compile_error_count' in result).toBe(false)
    expect('warning' in result).toBe(false)
    expect(String(result.message)).not.toContain('blueprint_compile')
  })

  it('引擎报错时把 details 一起带回 —— 那里有可用变量名', async () => {
    callRequest.mockResolvedValue({
      ok: false,
      error: "Variable 'Speeed' not found (available: OpenSpeed, IsLocked)",
      details: { available: ['OpenSpeed', 'IsLocked'] }
    })
    const result = await runMeta({ blueprint_path: '/Game/BP_Door', name: 'Speeed', category: 'x' })

    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('OpenSpeed')
    expect(result.details).toEqual({ available: ['OpenSpeed', 'IsLocked'] })
  })

  it('没有连接的引擎时给出可操作的提示，不是一句失败', async () => {
    getConnectionCount.mockReturnValue(0)
    const result = await runMeta({ blueprint_path: '/Game/BP_Door', name: 'X', category: 'y' })

    expect(result.success).toBe(false)
    // 断言落在「说清没连上 + 给出下一步」上，不落在具体措辞上：
    // 这句话的来源是共用常量 UE_NOT_CONNECTED_MESSAGE（`tools/defineUeTool.ts`）
    expect(String(result.error)).toContain('引擎未连接')
    expect(String(result.error)).toContain('ue_session_health')
    expect(callRequest).not.toHaveBeenCalled()
  })
})

describe('blueprint_remove_variable', () => {
  it('删完必须说清楚引用它的节点变成了孤儿', async () => {
    // 不说的话调用方以为删干净了，直到某次编译突然报一堆错
    callRequest.mockResolvedValue({
      ok: true,
      blueprint_path: '/Game/BP_Door',
      name: 'Unused',
      removed: true
    })
    const result = await runRemove({ blueprint_path: '/Game/BP_Door', name: 'Unused' })

    expect(result.success).toBe(true)
    expect(String(result.message)).toContain('blueprint_compile')
  })

  it('变量不存在时把可用变量名带回来', async () => {
    callRequest.mockResolvedValue({
      ok: false,
      error: "Variable 'Nope' not found on BP_Door (available: OpenSpeed, IsLocked)"
    })
    const result = await runRemove({ blueprint_path: '/Game/BP_Door', name: 'Nope' })

    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('IsLocked')
  })
})

describe('blueprint_event_dispatcher', () => {
  it('list 回全部分发器和它们的参数', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      blueprint_path: '/Game/BP_Door',
      dispatchers: [
        { name: 'OnDoorOpened', params: [{ name: 'Opener', type: 'object', class: 'Actor' }] },
        { name: 'OnDoorLocked', params: [] }
      ]
    })
    const result = await runDispatcher({ blueprint_path: '/Game/BP_Door', action: 'list' })

    expect(result.success).toBe(true)
    expect(String(result.message)).toContain('OnDoorOpened(Opener)')
    expect(String(result.message)).toContain('OnDoorLocked')
  })

  it('一个都没有时说得明确，不是空字符串', async () => {
    callRequest.mockResolvedValue({ ok: true, blueprint_path: '/Game/BP_Door', dispatchers: [] })
    const result = await runDispatcher({ blueprint_path: '/Game/BP_Door', action: 'list' })

    expect(result.success).toBe(true)
    expect(String(result.message)).toContain('还没有任何事件分发器')
  })

  /**
   * 建完必须给出节点名的写法。
   *
   * 分发器建出来只是个声明，不告诉调用方怎么广播/订阅的话，
   * 它拿着一个用不上的分发器，下一步多半是放弃然后改回轮询。
   */
  it('add 之后告诉调用方广播和订阅的节点名怎么写', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      blueprint_path: '/Game/BP_Door',
      name: 'OnDoorOpened',
      created: true,
      params: ['Opener']
    })
    const result = await runDispatcher({
      blueprint_path: '/Game/BP_Door',
      action: 'add',
      name: 'OnDoorOpened',
      params: [{ name: 'Opener', type: 'object', class: 'Actor' }]
    })

    expect(result.success).toBe(true)
    // 这两个 class 名要和插件端真认的写法一致 —— 以前这里给的是
    // "Call <名字>" 这种编辑器标题，插件的写图解析器根本没有那条分支，
    // 照着做必然 Function not found（2026-09-16 反馈）
    expect(String(result.message)).toContain('CallDispatcher')
    expect(String(result.message)).toContain('BindEvent')
    expect(String(result.message)).toContain('OnDoorOpened')
  })

  it('无参分发器也说清楚是无参，不留空括号', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      blueprint_path: '/Game/BP_Door',
      name: 'OnDoorLocked',
      created: true,
      params: []
    })
    const result = await runDispatcher({
      blueprint_path: '/Game/BP_Door',
      action: 'add',
      name: 'OnDoorLocked'
    })

    expect(String(result.message)).toContain('无参数')
  })

  // 本地判得出来的错就别浪费一次往返
  it('action=add 少了 name 时本地就拦下来，不发 RPC', async () => {
    const result = await runDispatcher({ blueprint_path: '/Game/BP_Door', action: 'add' })

    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('name')
    expect(callRequest).not.toHaveBeenCalled()
  })

  it('params 为空数组时不透传，让引擎走无参路径', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      blueprint_path: '/Game/BP_Door',
      name: 'X',
      params: []
    })
    await runDispatcher({ blueprint_path: '/Game/BP_Door', action: 'add', name: 'X', params: [] })

    expect('params' in lastCall().params).toBe(false)
  })

  it('重名时把引擎的 409 原样交回去', async () => {
    callRequest.mockResolvedValue({
      ok: false,
      error: 'Event dispatcher already exists: OnDoorOpened'
    })
    const result = await runDispatcher({
      blueprint_path: '/Game/BP_Door',
      action: 'add',
      name: 'OnDoorOpened'
    })

    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('already exists')
  })
})

/**
 * 组件事件 —— 触发式交互的入口。
 *
 * 测的重点是**事件名容易记混**这件事：OnComponentBeginOverlap 不是
 * OnBeginOverlap，不同组件类型能绑的还不一样。所以 list 要给全，
 * add 失败时要把该组件实际有哪些事件带回来。
 */
describe('blueprint_component_event', () => {
  const runComponent = (input: unknown): Promise<ToolResult> =>
    (createBlueprintComponentEventTool() as unknown as Executable).execute(input)

  it('list 回可绑事件和它们的参数签名', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      blueprint_path: '/Game/BP_Door',
      component_name: 'TriggerBox',
      component_class: 'BoxComponent',
      events: [
        { name: 'OnComponentBeginOverlap', params: [{ name: 'OtherActor', type: 'AActor*' }] },
        { name: 'OnComponentEndOverlap', params: [] }
      ]
    })

    const result = await runComponent({
      blueprint_path: '/Game/BP_Door',
      component_name: 'TriggerBox',
      action: 'list'
    })

    expect(result.success).toBe(true)
    expect(String(result.message)).toContain('OnComponentBeginOverlap')
    expect(String(result.message)).toContain('BoxComponent')
  })

  it('绑完把 node_id 和引脚一起回 —— 下一步直接拿去连线', async () => {
    // 不回引脚的话模型得再读一次整张图才知道 then / OtherActor 叫什么
    callRequest.mockResolvedValue({
      ok: true,
      blueprint_path: '/Game/BP_Door',
      node_id: 'ABC-123',
      event_name: 'OnComponentBeginOverlap',
      reused: false,
      pins: [
        { name: 'then', dir: 'Output' },
        { name: 'OtherActor', dir: 'Output' }
      ]
    })

    const result = await runComponent({
      blueprint_path: '/Game/BP_Door',
      component_name: 'TriggerBox',
      action: 'add',
      event_name: 'OnComponentBeginOverlap'
    })

    expect(result.success).toBe(true)
    expect(result.node_id).toBe('ABC-123')
    expect(result.pins).toHaveLength(2)
    expect(String(result.message)).toContain('ABC-123')
  })

  // 重复绑同一个事件，编译不报错但两条链都会执行 —— 和 BeginPlay 重复建节点同一类坑
  it('已经绑过时说清楚是复用，不假装新建了一个', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      blueprint_path: '/Game/BP_Door',
      node_id: 'OLD-1',
      event_name: 'OnComponentBeginOverlap',
      reused: true,
      pins: []
    })

    const result = await runComponent({
      blueprint_path: '/Game/BP_Door',
      component_name: 'TriggerBox',
      action: 'add',
      event_name: 'OnComponentBeginOverlap'
    })

    expect(result.reused).toBe(true)
    expect(String(result.message)).toContain('已经绑过')
  })

  it('事件名写错时把该组件实际有哪些事件带回来', async () => {
    callRequest.mockResolvedValue({
      ok: false,
      error:
        "Event 'OnBeginOverlap' is not bindable on BoxComponent (available: OnComponentBeginOverlap, OnComponentEndOverlap)"
    })

    const result = await runComponent({
      blueprint_path: '/Game/BP_Door',
      component_name: 'TriggerBox',
      action: 'add',
      event_name: 'OnBeginOverlap'
    })

    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('OnComponentBeginOverlap')
  })

  it('action=add 少了 event_name 时本地拦下，不发 RPC', async () => {
    const result = await runComponent({
      blueprint_path: '/Game/BP_Door',
      component_name: 'TriggerBox',
      action: 'add'
    })

    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('event_name')
    expect(callRequest).not.toHaveBeenCalled()
  })

  it('组件名写错时把该蓝图实际有哪些组件带回来', async () => {
    callRequest.mockResolvedValue({
      ok: false,
      error: "Component 'Trigger' not found on BP_Door (available: TriggerBox, DoorMesh)"
    })

    const result = await runComponent({
      blueprint_path: '/Game/BP_Door',
      component_name: 'Trigger',
      action: 'list'
    })

    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('TriggerBox')
  })
})

describe('blueprint_function_signature', () => {
  const runSig = (input: unknown): Promise<ToolResult> =>
    (createBlueprintFunctionSignatureTool() as unknown as Executable).execute(input)

  it('加参数之后回完整签名，省一次读图', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      blueprint_path: '/Game/BP_Door',
      graph_name: 'OpenDoor',
      action: 'add_param',
      inputs: [{ name: 'Speed', type: 'real' }],
      outputs: []
    })

    const result = await runSig({
      blueprint_path: '/Game/BP_Door',
      graph_name: 'OpenDoor',
      action: 'add_param',
      param: { name: 'Speed', type: 'float' }
    })

    expect(result.success).toBe(true)
    expect(String(result.message)).toContain('Speed:real')
    // 改签名之后已有调用点要重连，不说的话下次编译才发现
    expect(String(result.message)).toContain('blueprint_compile')
  })

  it('删函数时说清楚调用点会变成孤儿', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      blueprint_path: '/Game/BP_Door',
      graph_name: 'UnusedHelper',
      action: 'remove_function'
    })

    const result = await runSig({
      blueprint_path: '/Game/BP_Door',
      graph_name: 'UnusedHelper',
      action: 'remove_function'
    })

    expect(String(result.message)).toContain('孤儿')
  })

  // 本地判得出来的错不该浪费一次往返
  it('add_param 少了 type 时本地拦下', async () => {
    const result = await runSig({
      blueprint_path: '/Game/BP_Door',
      graph_name: 'OpenDoor',
      action: 'add_param',
      param: { name: 'Speed' }
    })

    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('type')
    expect(callRequest).not.toHaveBeenCalled()
  })

  it('remove_param 少了 param 时本地拦下', async () => {
    const result = await runSig({
      blueprint_path: '/Game/BP_Door',
      graph_name: 'OpenDoor',
      action: 'remove_param'
    })

    expect(result.success).toBe(false)
    expect(callRequest).not.toHaveBeenCalled()
  })

  // 事件图不是函数，删它等于把整个蓝图的事件逻辑删了
  it('引擎拒绝删 EventGraph 时原样交回', async () => {
    callRequest.mockResolvedValue({
      ok: false,
      error: 'Refusing to delete EventGraph - it is not a function.'
    })

    const result = await runSig({
      blueprint_path: '/Game/BP_Door',
      graph_name: 'EventGraph',
      action: 'remove_function'
    })

    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('EventGraph')
  })
})

describe('blueprint_set_parent_class', () => {
  const runReparent = (input: unknown): Promise<ToolResult> =>
    (createSetBlueprintParentClassTool() as unknown as Executable).execute(input)

  /**
   * 改父类大概率打断一批节点。
   *
   * 编译错误埋在 JSON 里等于没说 —— 模型会看到 success:true 就往下做，
   * 拿着一个坏掉的蓝图继续。所以错误要顶到消息最前面。
   */
  it('编译报错时把错误顶到最前面，不埋在字段里', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      blueprint_path: '/Game/BP_Hero',
      old_parent: 'Actor',
      new_parent: 'Character',
      compile_errors: 2,
      compile_warnings: 0,
      messages: ['Node SetActorLocation broke', 'Missing pin Target']
    })

    const result = await runReparent({
      blueprint_path: '/Game/BP_Hero',
      parent_class: 'Character'
    })

    expect(result.compile_errors).toBe(2)
    const message = String(result.message)
    expect(message.startsWith('⚠️')).toBe(true)
    expect(message).toContain('SetActorLocation')
  })

  it('干净通过时说清楚没有错误', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      blueprint_path: '/Game/BP_Hero',
      old_parent: 'Actor',
      new_parent: 'Pawn',
      compile_errors: 0,
      compile_warnings: 0,
      messages: []
    })

    const result = await runReparent({ blueprint_path: '/Game/BP_Hero', parent_class: 'Pawn' })

    expect(String(result.message)).toContain('Actor → Pawn')
    expect(String(result.message)).toContain('没有错误')
  })

  it('循环继承被引擎拒绝时原样交回', async () => {
    callRequest.mockResolvedValue({
      ok: false,
      error: "'BP_Child' derives from this blueprint - reparenting to it would create a cycle"
    })

    const result = await runReparent({
      blueprint_path: '/Game/BP_Hero',
      parent_class: 'BP_Child'
    })

    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('cycle')
  })
})
