/**
 * @vitest-environment node
 *
 * `material_apply` 的回执：**部分成功不许读成全部成功**。
 *
 * 这个 toOutcome 整块重写过两轮，一直没有测试，代价是实打实的：
 *
 * 1. 有一版把跳过原因从 error 里去掉、只留一句「去看 skipped」。可
 *    「一个都没应用上」那条路引擎回的是 404，盒子这边 `assertRpcOk` 直接抛，
 *    toOutcome 根本不会跑 —— 那句话指向的东西模型永远看不到。
 * 2. 有一版自己拼「…还有 N 个，原因多半和上面重复」。引擎是按顺序截断的，
 *    不是按原因截断的，这句话就是猜的。
 * 3. 一个 Actor 上不止一个网格组件时只刷了其中一个，回的却是「1/1」。
 *
 * 所以这里钉的都是「正文里说没说清楚」——**不是 details 里有没有**。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const callRequest = vi.fn()
const getConnectionCount = vi.fn(() => 1)

vi.mock('../../../services', () => ({
  serviceManager: {
    getWebSocketService: () => ({ callRequest, getConnectionCount })
  }
}))
vi.mock('../../core/projectTargetContext', () => ({
  getTargetConnectionId: () => 'conn-1'
}))

import { materialTools } from './index'

type Executable = {
  name: string
  execute: (id: string, input: unknown) => Promise<{ content: { text: string }[] }>
}

const byName = (name: string): Executable => {
  const found = (materialTools as unknown as Executable[]).find((t) => t.name === name)
  if (!found) throw new Error(`工具未注册：${name}`)
  return found
}

const apply = async (response: unknown): Promise<string> => {
  callRequest.mockResolvedValue(response)
  const result = await byName('material_apply').execute('c1', {
    targets: { names: ['Cube'] },
    path: '/Game/M_Gold'
  })
  return result.content.map((c) => c.text).join('\n')
}

beforeEach(() => {
  callRequest.mockReset()
  getConnectionCount.mockReset().mockReturnValue(1)
})

describe('material_apply 的正文', () => {
  it('刷到了哪个组件要说出来 —— 那正是重试时要填进 component_name 的词', async () => {
    const text = await apply({
      applied_count: 1,
      target_count: 1,
      actors: [{ name: 'BP_Hero', component: 'CharacterMesh0' }]
    })
    expect(text).toContain('BP_Hero（CharacterMesh0）')
  })

  /**
   * 这个 Actor 上还有别的网格组件时，「1/1」读起来是全做完了，
   * 而模块化的门只刷了门框。旁边还有谁必须报出来。
   */
  it('多组件 Actor 只刷了一个时点破，并给出没刷到的名字', async () => {
    const text = await apply({
      applied_count: 1,
      target_count: 1,
      actors: [
        {
          name: 'Door_01',
          component: 'DoorFrame',
          mesh_component_count: 2,
          other_components: 'DoorPanel'
        }
      ]
    })
    expect(text).toContain('不止一个网格组件')
    expect(text).toContain('DoorPanel')
    expect(text).toContain('component_name')
  })

  it('跳过的逐条列出来，总数用引擎给的 skipped_count', async () => {
    const text = await apply({
      applied_count: 1,
      target_count: 4,
      actors: [{ name: 'Cube', component: 'SM' }],
      skipped_count: 3,
      skipped: [{ name: 'A', reason: 'no mesh component' }]
    })
    expect(text).toContain('有 3 个匹配到的 Actor 被跳过')
    expect(text).toContain('A：no mesh component')
  })

  /*
   * 跳过名单重名时要报路径 —— 和成功名单同一个规则。
   *
   * `filter: {name_pattern:'Cube*'}` 命中五个都叫 Cube、跳了两个，只印标签的话
   * 是两行一模一样的 `- Cube：…`：既分不清是哪两个，也没法拿 targets.paths
   * 单独重试它们。而「重试没成的那几个」正是引擎在 skipped 里补上 path 的理由。
   */
  it('跳过名单里标签重名时改报路径', async () => {
    const text = await apply({
      applied_count: 3,
      target_count: 5,
      actors: [{ name: 'Cube', component: 'SM' }],
      skipped_count: 2,
      skipped: [
        {
          name: 'Cube',
          path: '/Game/L.L:PersistentLevel.Cube_7',
          reason: 'slot_index out of range'
        },
        {
          name: 'Cube',
          path: '/Game/L.L:PersistentLevel.Cube_9',
          reason: 'slot_index out of range'
        }
      ]
    })
    expect(text).toContain('Cube_7')
    expect(text).toContain('Cube_9')
  })

  // 不重名就还是印短标签：全都摊开成长路径会把正文撑爆，也更难读
  it('跳过名单里不重名就照旧印标签', async () => {
    const text = await apply({
      applied_count: 1,
      target_count: 2,
      actors: [{ name: 'Cube', component: 'SM' }],
      skipped_count: 1,
      skipped: [{ name: 'Sphere', path: '/Game/L.L:PersistentLevel.Sphere_3', reason: 'no mesh' }]
    })
    expect(text).toContain('Sphere：no mesh')
    expect(text).not.toContain('PersistentLevel.Sphere_3')
  })

  // 老插件不回 path，重名也只能印标签 —— 不能因此崩掉或印出 undefined
  it('老插件没有 path 时不印 undefined', async () => {
    const text = await apply({
      applied_count: 1,
      target_count: 3,
      actors: [{ name: 'Cube', component: 'SM' }],
      skipped_count: 2,
      skipped: [
        { name: 'Cube', reason: 'no mesh' },
        { name: 'Cube', reason: 'no mesh' }
      ]
    })
    expect(text).not.toContain('undefined')
    expect(text).toContain('Cube：no mesh')
  })

  /**
   * 引擎的截断是按顺序截的，不是按原因截的 —— 前 20 个都是「没有网格组件」
   * 不代表第 21 个不是「槽位越界」。所以转述引擎给的归类汇总，不自己猜。
   *
   * `applied_count` 必须 > 0：一个都没应用上时引擎回 404，`assertRpcOk` 会在
   * toOutcome 之前就抛出去，这段渲染根本轮不到。拿 0 当夹具等于钉住一个
   * 线上不存在的形态 —— 那样即使把 skipped_summary 从正文里挪走也照样是绿的。
   */
  it('明细被截断时转述归类汇总，不自己猜「多半重复」', async () => {
    const text = await apply({
      applied_count: 1,
      target_count: 26,
      actors: [{ name: 'Cube', component: 'SM' }],
      skipped_count: 25,
      skipped: [{ name: 'A', reason: 'no mesh component' }],
      skipped_summary: 'no mesh component (x20); slot_index out of range (x5)'
    })
    expect(text).toContain('slot_index out of range (x5)')
  })

  /**
   * 20 条这个上限只存在于新编的插件里，而插件装在用户的 UE 工程里、
   * 不随盒子升级。老插件把 299 条全发过来，这边也得自己截。
   */
  it('老插件把跳过明细全发过来时，这边自己截断', async () => {
    const skipped = Array.from({ length: 299 }, (_, i) => ({
      name: `Skipped_${i}`,
      reason: 'no mesh component'
    }))
    const text = await apply({
      applied_count: 1,
      target_count: 300,
      actors: [{ name: 'Cube', component: 'SM' }],
      skipped
    })
    expect(text).not.toContain('Skipped_298')
    expect(text.length).toBeLessThan(3000)
  })

  /**
   * 编辑器标签不唯一。三个都叫 Cube 的时候只报名字，调用方既分不清
   * 哪几个成了，也没法给没成的那几个拼一次 targets.paths 重试。
   */
  it('名字重复时改报路径', async () => {
    const text = await apply({
      applied_count: 2,
      target_count: 2,
      actors: [
        { name: 'Cube', path: '/Game/L.L:PersistentLevel.Cube_1', component: 'SM' },
        { name: 'Cube', path: '/Game/L.L:PersistentLevel.Cube_2', component: 'SM' }
      ]
    })
    expect(text).toContain('Cube_1')
    expect(text).toContain('Cube_2')
  })

  /**
   * PIE 里刷的材质停止运行就没了。不说的话「已应用到 12/12」会被读成永久生效。
   */
  it('PIE 里要点破改动不会落盘', async () => {
    const text = await apply({
      applied_count: 2,
      target_count: 2,
      actors: [
        { name: 'A', component: 'SM' },
        { name: 'B', component: 'SM' }
      ],
      world: 'pie',
      world_note: '停止运行就没了'
    })
    expect(text).toContain('游戏正在运行')
  })

  it('编辑器世界不加那句噪音', async () => {
    const text = await apply({
      applied_count: 1,
      target_count: 1,
      actors: [{ name: 'A', component: 'SM' }],
      world: 'editor'
    })
    expect(text).not.toContain('游戏正在运行')
  })

  /**
   * `applied + skipped` 对不上 `target_count` 时，差额那几个既没成功也没被解释。
   * 那种沉默正是这套回报要消灭的东西。
   *
   * 一条就够：`skipped_count ?? skipped.length` 把新旧插件收敛成了同一个分支，
   * 再写一条「老插件」用例买不到第二条路径。断言也只钉数字和一个稳定词，
   * 不钉整句 —— 钉整句的话，措辞随便动一下就红，久了人就只会照着输出改断言。
   */
  it('对不上账时把差额单独说出来', async () => {
    const text = await apply({
      applied_count: 3,
      target_count: 10,
      actors: [{ name: 'A' }, { name: 'B' }, { name: 'C' }],
      skipped_count: 6,
      skipped: [{ name: 'X', reason: 'no mesh component' }]
    })
    expect(text).toMatch(/还有 1 个/)
    expect(text).toContain('没给出原因')
  })

  /**
   * 成功名单也要封顶。跳过名单封了顶、成功名单不封是本末倒置：
   * 成功那条路跑得多得多，而每条还更长了（多了组件名）。
   */
  it('成功名单封顶，不把几百个 Actor 名糊进上下文', async () => {
    const actors = Array.from({ length: 300 }, (_, i) => ({
      name: `Actor_${i}`,
      component: 'StaticMeshComponent0'
    }))
    const text = await apply({ applied_count: 300, target_count: 300, actors })
    expect(text).toContain('共 300 个')
    expect(text).not.toContain('Actor_299')
    expect(text.length).toBeLessThan(2000)
  })

  it('全部成功且只有一个组件时，正文里没有任何警告', async () => {
    const text = await apply({
      applied_count: 2,
      target_count: 2,
      actors: [
        { name: 'A', component: 'SM' },
        { name: 'B', component: 'SM' }
      ]
    })
    expect(text).not.toContain('⚠️')
  })
})

/**
 * 多槽（2026-09-24 用户反馈）：一个 Boss 15 个槽，两组槽各换一种材质、
 * 透明槽原样保留。以前只能连调 8 次，调完还得回读整张槽位表核对。
 */
describe('material_apply 的多槽写法', () => {
  const runWith = async (input: unknown, response: unknown): Promise<string> => {
    callRequest.mockResolvedValue(response)
    const result = await byName('material_apply').execute('c1', input)
    return result.content.map((c) => c.text).join('\n')
  }

  it('slots 里每一项的 path 都改名成 material_path，顶层不带 material_path', async () => {
    await runWith(
      {
        targets: { names: ['Boss'] },
        component_name: '骨骼',
        slots: [
          { slot_index: 1, path: '/Game/MI_Skin' },
          { slot_name: 'Cloth', path: '/Game/MI_Cloth' }
        ]
      },
      { applied_count: 1, target_count: 1, actors: [] }
    )
    const [method, params] = callRequest.mock.calls.at(-1) as [string, Record<string, unknown>]
    expect(method).toBe('material.apply')
    expect(params.slots).toEqual([
      { slot_index: 1, material_path: '/Game/MI_Skin' },
      { slot_name: 'Cloth', material_path: '/Game/MI_Cloth' }
    ])
    expect('material_path' in params).toBe(false)
    expect('path' in params).toBe(false)
  })

  it('单槽写法照旧，不再给 slot_index 塞默认值（插件那头默认 0）', async () => {
    await runWith({ targets: { names: ['Cube'] }, path: '/Game/M_Gold' }, { applied_count: 1 })
    const [, params] = callRequest.mock.calls.at(-1) as [string, Record<string, unknown>]
    expect(params.material_path).toBe('/Game/M_Gold')
    expect('slot_index' in params).toBe(false)
    expect('slots' in params).toBe(false)
  })

  it('正文逐槽列出旧 → 新，并说明没列出的槽没动', async () => {
    const text = await runWith(
      { targets: { names: ['Boss'] }, slots: [{ slot_index: 1, path: '/Game/MI_Skin' }] },
      {
        applied_count: 1,
        target_count: 1,
        actors: [
          {
            name: 'Boss',
            component: '骨骼',
            slots: [
              {
                slot_index: 1,
                slot_name: 'Skin',
                previous: '/Game/Old/MI_A.MI_A',
                material: '/Game/MI_Skin'
              },
              { slot_index: 13, previous: '', material: '/Game/MI_Skin' }
            ]
          }
        ]
      }
    )
    expect(text).toContain('槽 1（Skin）：MI_A → MI_Skin')
    expect(text).toContain('槽 13：（空） → MI_Skin')
    expect(text).toContain('没列出的槽没有动')
  })

  it('只改一个槽时不重复列一遍', async () => {
    const text = await apply({
      applied_count: 1,
      target_count: 1,
      actors: [
        { name: 'Cube', component: 'SM', slots: [{ slot_index: 0, material: '/Game/M_Gold' }] }
      ]
    })
    expect(text).not.toContain('逐槽改动')
  })

  it('逐槽明细封顶', async () => {
    const actors = Array.from({ length: 10 }, (_, i) => ({
      name: `Boss_${i}`,
      slots: Array.from({ length: 8 }, (_, j) => ({ slot_index: j, material: '/Game/M' }))
    }))
    const text = await apply({ applied_count: 10, target_count: 10, actors })
    expect(text).toContain('还有 50 个槽')
  })
})
