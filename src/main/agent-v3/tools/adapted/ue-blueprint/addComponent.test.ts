/**
 * @vitest-environment node
 *
 * `blueprint_add_component` 的契约测试。
 *
 * 每一条都来自实际踩过的一路：Agent 加完组件后不信任返回值，去调 describe，
 * describe 报的挂载关系是错的，于是它退到写 Python 反射 SCS ——
 * 回答一句「这个组件挂在谁下面」要绕三次工具调用。
 *
 * 这里锁住的每一条，改坏了都**不会有任何东西报错**，只会让调用方
 * 重新掉回那条路。
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

import { createAddComponentToBlueprintTool } from './addComponentToBlueprint'

type ToolResult = Record<string, unknown>
type Executable = { execute: (input: unknown) => Promise<ToolResult> }

const run = (input: unknown): Promise<ToolResult> =>
  (createAddComponentToBlueprintTool() as unknown as Executable).execute(input)

const BASE_INPUT = {
  blueprint_name: '/Game/BP_Door',
  component_type: 'BoxComponent',
  component_name: 'Trigger'
}

const okResponse = {
  ok: true,
  blueprint_name: 'BP_Door',
  component_name: 'Trigger',
  component_class: 'BoxComponent',
  attached: true,
  attached_to: 'Hinge',
  saved: true,
  all_components: [
    { name: 'DefaultSceneRoot', class: 'SceneComponent', source: 'added', attach_to: '', depth: 0 },
    {
      name: 'Hinge',
      class: 'SceneComponent',
      source: 'added',
      attach_to: 'DefaultSceneRoot',
      depth: 1
    },
    { name: 'Trigger', class: 'BoxComponent', source: 'added', attach_to: 'Hinge', depth: 2 }
  ]
}

beforeEach(() => {
  callRequest.mockReset()
  getConnectionCount.mockReturnValue(1)
})

describe('attach_to 要能传下去', () => {
  /**
   * 插件一直读 attach_to，而工具层既没在 schema 里声明、也没往下透传。
   * 于是「挂到 Hinge 下」这个请求根本到不了插件，组件默默挂在了根上。
   */
  it('传了 attach_to 就要发给插件', async () => {
    callRequest.mockResolvedValue(okResponse)

    await run({ ...BASE_INPUT, attach_to: 'Hinge' })

    const params = callRequest.mock.calls[0][1] as Record<string, unknown>
    expect(params.attach_to).toBe('Hinge')
  })

  it('没传就不发 —— 别把 undefined 传下去', async () => {
    callRequest.mockResolvedValue(okResponse)

    await run(BASE_INPUT)

    expect(callRequest.mock.calls[0][1]).not.toHaveProperty('attach_to')
  })
})

describe('挂载结果不能撒谎', () => {
  /**
   * 插件端曾经三条分支一律 attached:true —— 包括「你要的父组件不存在，
   * 我改挂根上了」。调用方拿到 true 就不会再核对，而组件层级决定行为
   * （门绕门轴转还是绕中心转）。
   */
  it('没挂到请求的位置时，警告要带上并写进 message', async () => {
    callRequest.mockResolvedValue({
      ...okResponse,
      attached: false,
      attached_to: '',
      attach_warning:
        "Requested parent 'Hinge' does not exist in this Blueprint; the component was attached to the root instead. Existing components: DefaultSceneRoot"
    })

    const result = await run({ ...BASE_INPUT, attach_to: 'Hinge' })

    expect(result.attached).toBe(false)
    expect(String(result.attach_warning)).toContain('Hinge')
    // 只塞进字段不够 —— message 是模型最先读的那一句
    expect(String(result.message)).toContain('没有挂到你要求的位置')
  })

  it('正常挂上时 message 说清楚挂在了哪儿', async () => {
    callRequest.mockResolvedValue(okResponse)

    const result = await run({ ...BASE_INPUT, attach_to: 'Hinge' })

    expect(result.attached).toBe(true)
    expect(result.attached_to).toBe('Hinge')
    expect(String(result.message)).toContain('Hinge')
  })

  it('挂在根上时 attached_to 是空串，message 说「根组件」', async () => {
    callRequest.mockResolvedValue({ ...okResponse, attached_to: '' })

    const result = await run(BASE_INPUT)

    // 空串表示「就是根」，和「不知道」要能区分
    expect(result.attached_to).toBe('')
    expect(String(result.message)).toContain('根组件')
  })

  it('没有警告时不塞空的 attach_warning 字段', async () => {
    callRequest.mockResolvedValue(okResponse)

    const result = await run(BASE_INPUT)

    expect(result).not.toHaveProperty('attach_warning')
  })
})

describe('组件层级要带回去', () => {
  /**
   * 这条是上面那条绕路的直接原因：插件**一直在回** all_components，
   * 工具层却只挑了六个字段带走，把层级扔了。
   * 调用方手里明明有答案却看不见，只好去写 Python 读 SCS。
   */
  it('all_components 原样带上，含 attach_to 和 depth', async () => {
    callRequest.mockResolvedValue(okResponse)

    const result = await run(BASE_INPUT)

    const comps = result.all_components as typeof okResponse.all_components
    expect(comps).toHaveLength(3)
    // 真实层级：Trigger 挂在 Hinge 下，不是一片 None
    expect(comps.find((c) => c.name === 'Trigger')?.attach_to).toBe('Hinge')
    expect(comps.find((c) => c.name === 'Trigger')?.depth).toBe(2)
    // 根组件的 attach_to 是空串
    expect(comps.find((c) => c.name === 'DefaultSceneRoot')?.attach_to).toBe('')
  })

  it('插件没回层级时不造一个空数组出来', async () => {
    const { all_components, ...withoutTree } = okResponse
    void all_components
    callRequest.mockResolvedValue(withoutTree)

    const result = await run(BASE_INPUT)

    expect(result).not.toHaveProperty('all_components')
  })
})

describe('属性没写进去要摆在第一句', () => {
  /**
   * 插件一直在回 failed_properties，工具层原来把它丢了、照说「成功添加」——
   * 模型以为 Intensity 已经配好，接着往下做（AGENTS.md §5 第 14 条）。
   */
  it('部分属性失败时第一句是部分完成，失败原因逐条列出', async () => {
    callRequest.mockResolvedValue({
      ...okResponse,
      failed_properties: ['Intensity: no such property on this component class'],
      message: "Added component 'Trigger' ... but 1 of its properties were NOT applied"
    })

    const result = await run({
      ...BASE_INPUT,
      component_properties: { Mobility: 'Movable', Intensity: 5000 }
    })

    expect(Object.keys(result)[0]).toBe('message')
    const message = String(result.message)
    expect(message.split('\n')[0]).toBe('⚠️ 部分完成：1 个属性成功 / 1 个属性失败。')
    expect(message).toContain('- Intensity：no such property on this component class')
    expect(message).not.toContain('成功为蓝图')
    expect(result.failed_count).toBe(1)
    expect(result.failed_properties).toEqual([
      { item: 'Intensity', reason: 'no such property on this component class' }
    ])
  })

  it('没存上盘时第一句就说', async () => {
    callRequest.mockResolvedValue({ ...okResponse, saved: false })

    const result = await run(BASE_INPUT)

    expect(String(result.message)).toMatch(/^⚠️ 未能保存到磁盘/)
  })

  it('全部写成时不带 ⚠️，也不塞空的 failed_properties', async () => {
    callRequest.mockResolvedValue(okResponse)

    const result = await run({ ...BASE_INPUT, component_properties: { Mobility: 'Movable' } })

    expect(String(result.message)).not.toContain('⚠️')
    expect(result).not.toHaveProperty('failed_properties')
  })
})

describe('连不上引擎', () => {
  it('没有连接时直说，不发请求', async () => {
    getConnectionCount.mockReturnValue(0)

    const result = await run(BASE_INPUT)

    expect(result.success).toBe(false)
    // 断言落在「说清没连上 + 给出下一步」上，不落在具体措辞上：
    // 这句话的来源是共用常量 UE_NOT_CONNECTED_MESSAGE（`tools/defineUeTool.ts`）
    expect(String(result.error)).toContain('引擎未连接')
    expect(String(result.error)).toContain('ue_session_health')
    expect(callRequest).not.toHaveBeenCalled()
  })
})

describe('工具描述里的类名必须是真的', () => {
  /**
   * 描述里曾经推荐 `BoxCollisionComponent` / `SphereCollisionComponent`，
   * 这两个类在 UE 里**不存在**（真名是 BoxComponent / SphereComponent）。
   * 模型照着我们给的清单填，被引擎拒掉，白费一个来回 ——
   * 实测里的第一条就是这个。
   */
  it('不再推荐不存在的碰撞组件类名', () => {
    const description = (createAddComponentToBlueprintTool() as unknown as { description: string })
      .description

    expect(description).toContain('BoxComponent')
    expect(description).toContain('SphereComponent')
    expect(description).not.toMatch(/(?<!\w)BoxCollisionComponent(?!\w)\s+-/)
    expect(description).not.toMatch(/(?<!\w)SphereCollisionComponent(?!\w)\s+-/)
  })
})
