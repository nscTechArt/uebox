import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineTool, type UnrealAgentTool } from '../defineTool'
import { createToolSearch, toolDefinitionBytes } from './toolSearch'

function tool(
  name: string,
  namespace = 'ue.material',
  description = '材质颜色 roughness'
): UnrealAgentTool<never> {
  return defineTool({
    name,
    namespace,
    description,
    risk: 'safe',
    input: z.object({ value: z.number().default(1) }),
    execute: async () => ({ text: 'ok' })
  }) as unknown as UnrealAgentTool<never>
}

async function search(
  controller: ReturnType<typeof createToolSearch>,
  args: Record<string, unknown>
): Promise<{
  loaded?: { name: string }[]
  missing?: string[]
  evicted?: string[]
  directories?: { namespace: string }[]
  nextOffset: number | null
}> {
  const result = await controller.tool.execute('search', args)
  const first = result.content[0]
  if (first.type !== 'text') throw new Error('expected text')
  return JSON.parse(first.text)
}

describe('Beta 工具搜索', () => {
  it('工具库翻倍不会扩大初始注入，未来工具和 MCP 自动可搜', async () => {
    const catalog = Array.from({ length: 400 }, (_, i) =>
      tool(`future_${i}`, `mcp.future${Math.floor(i / 20)}`, '新能力 '.repeat(100))
    )
    const small = createToolSearch(catalog.slice(0, 200), () => catalog.slice(0, 200))
    const large = createToolSearch(catalog, () => catalog)
    expect(large.getTools().map((t) => t.name)).toEqual(['search_tools'])
    expect(large.getTools().reduce((sum, t) => sum + toolDefinitionBytes(t), 0)).toBe(
      small.getTools().reduce((sum, t) => sum + toolDefinitionBytes(t), 0)
    )
    await search(large, { names: ['future_399'] })
    expect(large.getTools()).toContain(catalog[399])
  })

  it('自然语言、精确名称都可加载；原始完整说明、参数和执行函数不变', async () => {
    const material = tool(
      'set_surface_color',
      'ue.material',
      '设置表面颜色。危险边界及修复说明。'.repeat(30)
    )
    const catalog = [material, tool('open_project', 'project', '打开工程')]
    const controller = createToolSearch(catalog, () => catalog)
    expect((await search(controller, { query: '材质颜色', limit: 1 })).loaded?.[0].name).toBe(
      material.name
    )
    expect(controller.getTools().find((t) => t.name === material.name)).toBe(material)
    const result = await controller.tool.execute('exact', { names: [material.name] })
    expect(result.addedToolNames).toEqual([])
    expect((await search(controller, { query: 'open_project', limit: 1 })).loaded?.[0].name).toBe(
      'open_project'
    )
  })

  it('目录及目录内工具可以分页发现，不因没命中检索永久丢失', async () => {
    const catalog = [tool('a'), tool('b'), tool('c', 'mcp.blender')]
    const controller = createToolSearch(catalog, () => catalog)
    const page = await search(controller, { limit: 1 })
    expect(page.directories).toHaveLength(1)
    expect(page.nextOffset).toBe(1)
    expect((await search(controller, { namespace: 'ue.material', limit: 1 })).loaded).toEqual([
      { name: 'a', description: '材质颜色 roughness' }
    ])
    expect(
      (await search(controller, { namespace: 'ue.material', offset: 1, limit: 1 })).loaded?.[0].name
    ).toBe('b')
    expect((await search(controller, { query: 'zxqwv' })).loaded).toEqual([])
  })

  it('搜索和精确加载都不能取回当前不可用的工具，断开引擎后已加载工具也移除', async () => {
    const catalog = [tool('hidden'), tool('visible')]
    let available = [catalog[1]]
    const controller = createToolSearch(catalog, () => available)
    const result = await search(controller, { names: ['hidden', 'visible'] })
    expect(result.missing).toEqual(['hidden'])
    expect(controller.getTools().map((t) => t.name)).toEqual(['search_tools', 'visible'])
    available = []
    expect(controller.getTools().map((t) => t.name)).toEqual(['search_tools'])
    available = catalog
    expect((await search(controller, { names: ['hidden'] })).loaded?.[0].name).toBe('hidden')
  })

  /*
   * 这里原本有三条容量测试（组装不下就 deferred、单个超大定义不加载、常驻不挤占
   * 加载区）。2026-09-17 那道 64 KB 闸整个删了，理由见 toolSearch.ts 顶部：
   * 已加载 + 常驻永远是全库子集，最坏情况等于全量注入，闸防不住任何事，
   * 却会把仍然省一半的跨领域任务判死。
   *
   * 替换成对**新行为**的断言 —— 守的是「装得下」而不是「拦得住」。
   */
  it('多个大组可以同时加载，先装的组不被淘汰', async () => {
    const a = tool('a', 'ue.material', 'a'.repeat(35000))
    const b = tool('b', 'ue.blueprint', 'b'.repeat(35000))
    const catalog = [a, b]
    const controller = createToolSearch(catalog, () => catalog)
    await search(controller, { names: ['a'] })
    await search(controller, { names: ['b'] })
    // 两个加起来 70,000 字节，在旧闸下第二个会被拒；现在都在
    expect(controller.getTools()).toContain(a)
    expect(controller.getTools()).toContain(b)
  })

  it('单个超大定义照常整体加载，不截断也不假报', async () => {
    const oversized = tool('oversized', 'mcp.large', '汉'.repeat(64000))
    const controller = createToolSearch([oversized], () => [oversized])
    expect((await search(controller, { names: [oversized.name] })).loaded?.[0].name).toBe(
      'oversized'
    )
    expect(controller.getTools()).toContain(oversized)
  })

  it('常驻清单不会被搜索加载挤掉', async () => {
    const resident = tool('ue_save', 'ue.editor', '完整常驻说明'.repeat(5000))
    const a = tool('a', 'ue.material', 'a'.repeat(35000))
    const b = tool('b', 'ue.blueprint', 'b'.repeat(35000))
    const catalog = [resident, a, b]
    const controller = createToolSearch(catalog, () => catalog)
    expect(controller.getTools()).toContain(resident)
    await search(controller, { names: ['a'] })
    await search(controller, { names: ['b'] })
    expect(controller.getTools()).toContain(resident)
    expect(controller.getTools()).toContain(a)
    expect(controller.getTools()).toContain(b)
  })

  it('技能正文精确引用带入整组，重复读取不重排，资源可追加另一组', () => {
    const catalog = [
      tool('blueprint_read', 'ue.blueprint'),
      tool('material_read'),
      tool('material_write'),
      tool('ue_save', 'ue.editor')
    ]
    const controller = createToolSearch(catalog, () => catalog)
    const initial = controller.getTools()
    const first = controller.loadFromSkill(
      '先用 `material_read`；unknown_tool 和 material_read_fake 不是可用工具。'
    )
    expect(first.addedToolNames).toEqual(['material_read', 'material_write'])
    const materialTools = controller.getTools()
    expect(materialTools.slice(0, initial.length)).toEqual(initial)
    expect(controller.loadFromSkill('material_write').addedToolNames).toEqual([])
    controller.loadFromSkill('blueprint_read')
    expect(controller.getTools().slice(0, materialTools.length)).toEqual(materialTools)
    expect(controller.getTools().at(-1)).toBe(catalog[0])
  })

  it('截图和聚焦随场景组加载，权限排除的成员不会被带回', async () => {
    const catalog = [
      tool('ue_get_actor', 'ue.actor'),
      tool('ue_screenshot', 'ue.editor'),
      tool('ue_focus_viewport', 'ue.editor')
    ]
    const allowed = catalog.slice(0, 2)
    const controller = createToolSearch(allowed, () => allowed)
    await search(controller, { names: ['ue_get_actor'] })
    expect(controller.getTools().slice(1)).toEqual(allowed)
  })

  /**
   * 「设置 → 工具」在搜索模式下那一排开关，记的就是这份差量。
   *
   * 只存差量而不是整份常驻清单：内置清单会随实验结论调整，存全量的话，
   * 用户点过一次开关就永远停在他点那天的那一版清单上。
   */
  describe('用户改过的常驻清单', () => {
    it('改成常驻的一起首发，不必再被搜出来', async () => {
      const catalog = [tool('material_write'), tool('ue_save', 'ue.editor')]
      const controller = createToolSearch(catalog, () => catalog, { material_write: true })
      expect(controller.getTools().map((entry) => entry.name)).toEqual([
        'search_tools',
        'material_write',
        'ue_save'
      ])
    })

    it('改成搜索加载的就不首发了，但仍然搜得回来', async () => {
      const catalog = [tool('ue_save', 'ue.editor'), tool('ue_undo', 'ue.editor')]
      const controller = createToolSearch(catalog, () => catalog, { ue_save: false })
      expect(controller.getTools().map((entry) => entry.name)).toEqual(['search_tools', 'ue_undo'])
      await search(controller, { names: ['ue_save'] })
      expect(controller.getTools().map((entry) => entry.name)).toContain('ue_save')
    })

    it('加载入口关不掉 —— 关掉之后就没人能再加载任何工具了', () => {
      const catalog = [tool('load_skill', 'core'), tool('material_write')]
      const controller = createToolSearch(catalog, () => catalog, {
        load_skill: false,
        material_write: false
      })
      expect(controller.getTools().map((entry) => entry.name)).toEqual([
        'search_tools',
        'load_skill'
      ])
    })

    it('没写差量的照旧按内置清单走', () => {
      const catalog = [tool('ue_save', 'ue.editor'), tool('material_write')]
      const controller = createToolSearch(catalog, () => catalog)
      expect(controller.getTools().map((entry) => entry.name)).toEqual(['search_tools', 'ue_save'])
    })
  })
})
