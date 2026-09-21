import { beforeAll, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { electronMock, servicesMock, targetContextMock } from '../../testSupport/toolMocks'

vi.mock('electron', () => electronMock())
vi.mock('../../../services', () => servicesMock())
vi.mock('../../core/projectTargetContext', async (importOriginal) =>
  targetContextMock(importOriginal)
)

import { buildSystemPrompt, resolveAgentTools, type SessionContext } from '../../core/createAgent'
import {
  createToolSearch,
  groupDomainTerms,
  RESIDENT_TOOL_GROUPS,
  RESIDENT_TOOL_NAMES,
  TOOL_SEARCH_RULES,
  toolDefinitionBytes,
  toolSearchGroup
} from './toolSearch'
import { createTaskTool } from './task'
import type { UnrealAgentTool } from '../defineTool'
import { BROWSER_TOOL_NAMES, OFFLINE_UE_TOOLS } from '../toolNames'
import { createSkillTools, discoverEnabledSkills } from '../../capabilities/skills'

const ctx: SessionContext = {
  sessionId: 'search-catalog',
  ueConnected: true,
  shellAvailable: true,
  requestApproval: async () => 'reject',
  requestQuestion: async () => ({ action: 'cancel' }),
  onVoiceReport: () => undefined,
  sessionProjectControl: { listProjects: () => [], onChange: () => undefined }
}
const task = createTaskTool({
  getParentMessages: () => [],
  runSubAgent: async () => ({ text: '', messageCount: 0 })
}) as UnrealAgentTool<never>
let skills: Awaited<ReturnType<typeof discoverEnabledSkills>>
let catalog: UnrealAgentTool<never>[]
beforeAll(async () => {
  skills = await discoverEnabledSkills()
  catalog = resolveAgentTools(ctx, skills, task)
})

function loadedNames(result: Awaited<ReturnType<UnrealAgentTool<never>['execute']>>): string[] {
  const text = result.content.find((block) => block.type === 'text')
  if (!text || text.type !== 'text') throw new Error('missing search result')
  return (JSON.parse(text.text) as { loaded: { name: string }[] }).loaded.map((tool) => tool.name)
}

/** 常驻判据的唯一真相：点名的 30 个 + 宿主交互 + 整组常驻的那几组 */
function residentNames(): Set<string> {
  return new Set(
    createToolSearch(catalog, () => catalog)
      .getTools()
      .map((tool) => tool.name)
  )
}

describe('真实工具库检索回归', () => {
  it('文档的 30 个和宿主交互工具全部常驻，领域工具继续按需加载', () => {
    const document = readFileSync('docs/常驻工具集选定-2026-09-17.md', 'utf8')
    const section = document.split('## 3. 推荐常驻集')[1].split('## 4.')[0]
    const recommended = [...section.matchAll(/^\| `([^`]+)`/gm)]
      .map((match) => match[1])
      .concat('task')
    expect(RESIDENT_TOOL_NAMES).toHaveLength(30)
    expect([...RESIDENT_TOOL_NAMES].sort()).toEqual(recommended.sort())
    const search = createToolSearch(catalog, () => catalog)
    /*
     * 2026-09-21：这条原来钉的是「常驻集恰好等于这 34 个名字」。现在常驻分两路
     * —— 点名的（文档 §3）和**整组**的（`RESIDENT_TOOL_GROUPS`，按 prompt cache
     * 的账算出来的小组）—— 所以断言换成「两路都在、且只有这两路」。
     *
     * 换成集合关系而不是补一份新的名字清单：整组常驻是按组算的，把组里的成员
     * 抄成名单，以后往 `ue.editor` 加一个工具就要改测试，而那恰恰是不该改的地方。
     */
    const named = [
      ...RESIDENT_TOOL_NAMES,
      ...BROWSER_TOOL_NAMES,
      'ask_user',
      'voice_report',
      'set_session_project',
      'search_tools'
    ]
    const resident = search.getTools()
    expect(resident.map((tool) => tool.name)).toEqual(expect.arrayContaining(named))
    for (const tool of resident)
      expect(
        named.includes(tool.name) || RESIDENT_TOOL_GROUPS.has(toolSearchGroup(tool)),
        `${tool.name} 既不在点名清单里，所属组 ${toolSearchGroup(tool)} 也不是整组常驻`
      ).toBe(true)
    // `ue_get_actor` / `ue_screenshot` 曾经在这份「不该常驻」名单里，2026-09-17 按
    // 「完全没有替代」改为常驻（文档 §3.8 / §4.2），所以从这里移走 —— 留着就是
    // 用测试把一个已经被推翻的结论钉死。写操作和图操作仍然按需加载。
    for (const name of ['material_get_graph', 'blueprint_compile', 'ue_spawn_actor']) {
      expect(search.getTools().some((tool) => tool.name === name)).toBe(false)
    }
  })

  /*
   * 拆组和整组常驻都是**无声**改错的地方：多一个 `ue.content` 工具没归子组、
   * 或者一个组没有领域词，表现都是「模型偶尔搜不到它」，没人会去查。
   */
  it('ue.content 的每个工具都归进了子组', () => {
    const orphans = catalog
      .filter((tool) => tool.unrealBox.namespace === 'ue.content')
      .filter((tool) => toolSearchGroup(tool) === 'ue.content')
      .map((tool) => tool.name)
    expect(
      orphans,
      `这些 ue.content 工具还没归子组：${orphans.join('、')}。` +
        '在 toolSearch.ts 的 UE_CONTENT_SUBGROUPS 里按「导入 / 整理 / 体检」归位。'
    ).toEqual([])
  })

  it('每个在用的工具组都查得到领域词', () => {
    const groups = [...new Set(catalog.map((tool) => toolSearchGroup(tool)))]
    const blank = groups.filter((group) => !groupDomainTerms(group)).sort()
    expect(
      blank,
      `这些组在 DOMAIN_TERMS 里一行都回退不到：${blank.join('、')}。` +
        '缺一行的后果是无声的 —— 那一组的中文查询只能指望描述里刚好有字面词。'
    ).toEqual([])
  })

  /*
   * 原来这条断言「每个组都能放进 64 KB 加载区」。那道闸 2026-09-17 删了
   * （见 toolSearch.ts 顶部），所以断言改成记录各组体积 —— 组多大仍然值得知道
   * （蓝图组 44,572 字节，一个就占旧闸七成），只是它不再是一条会让任务失败的线。
   */
  it('记录各按需工具组的体积', () => {
    const search = createToolSearch(catalog, () => catalog)
    const resident = new Set(search.getTools())
    const groups = new Map<string, number>()
    for (const tool of catalog.filter((tool) => !resident.has(tool))) {
      const group = toolSearchGroup(tool)
      groups.set(group, (groups.get(group) ?? 0) + toolDefinitionBytes(tool))
    }
    expect(groups.size).toBeGreaterThan(0)
    if (process.env.TOOL_SEARCH_MEASURE === '1')
      console.info('TOOL_SEARCH_GROUP_BYTES', JSON.stringify(Object.fromEntries(groups)))
  })

  /*
   * 技能带组是主路径，`search_tools` 只是兜底。所以「有没有哪个工具组，任何技能都
   * 引用不到」是一条会无声出现的缺陷：新加一组工具、谁都没在技能里提它，模型就只能
   * 靠搜索去撞 —— 而 09-11 实测模型 39 次该搜有 38 次压根没搜。
   *
   * 2026-09-17 首测：23 组里 6 组无覆盖，其中 4 组是真缺口（local / library / note /
   * ue.input，共 8 个工具），已分别补进 local-files、asset-library、
   * knowledge-base-and-projects、ue-editor-inspection 四个已有技能的正文。
   *
   * 剩下 `browser` / `host` 允许不被覆盖：它们是宿主交互工具，本来就常驻、不参与折叠。
   */
  it('每个按需工具组都至少被一个技能引用到', async () => {
    // 常驻判据现在有两路（点名 + 整组），所以这里必须问真正的常驻集，
    // 不能只拿文档那 30 个名字 —— 否则整组常驻的组会被当成「没人引用的按需组」
    const resident = residentNames()
    const groups = new Set<string>()
    for (const tool of catalog) if (!resident.has(tool.name)) groups.add(toolSearchGroup(tool))
    const covered = new Set<string>()
    for (const skill of skills as { name: string }[]) {
      const search = createToolSearch(catalog, () => catalog)
      const loader = createSkillTools(skills, 'off', search.loadFromSkill).find(
        (tool) => tool.name === 'load_skill'
      )!
      const before = new Set(search.getTools().map((tool) => tool.name))
      await loader.execute('coverage', { name: skill.name })
      for (const tool of search.getTools())
        if (!before.has(tool.name) && !resident.has(tool.name)) covered.add(toolSearchGroup(tool))
    }
    // 常驻的宿主交互组不走折叠，不需要技能带它们
    const uncovered = [...groups].filter((g) => !covered.has(g) && g !== 'browser' && g !== 'host')
    expect(
      uncovered.sort(),
      `这些工具组没有任何技能引用得到，模型只能靠 search_tools 撞：${uncovered.join('、')}。` +
        '在语义最接近的已有技能正文里加一段真正的引导（不是堆工具名），' +
        '或者说明为什么这一组只配走兜底。'
    ).toEqual([])
  })

  it.each([
    ['ue-material-authoring', 'ue.material'],
    ['ue-blueprint-graph-editing', 'ue.blueprint'],
    ['ue-actor-placement', 'ue.actor']
  ])('真实 %s 加载后直接提供整个 %s 组', async (name, group) => {
    const search = createToolSearch(catalog, () => catalog)
    const loader = createSkillTools(skills, 'off', search.loadFromSkill).find(
      (tool) => tool.name === 'load_skill'
    )!
    const result = await loader.execute('skill', { name })
    const members = catalog.filter((tool) => toolSearchGroup(tool) === group)
    expect(members.length).toBeGreaterThan(1)
    expect(search.getTools()).toEqual(expect.arrayContaining(members))
    expect(result.addedToolNames).toEqual(
      expect.arrayContaining(
        members
          .filter((tool) => !(RESIDENT_TOOL_NAMES as readonly string[]).includes(tool.name))
          .map((tool) => tool.name)
      )
    )
    if (process.env.TOOL_SEARCH_MEASURE === '1')
      console.info('TOOL_SEARCH_SKILL', name, JSON.stringify(result.details))
  })

  it('常驻也服从断连、只读、子任务和白名单，MCP 不自动常驻', async () => {
    for (const overrides of [
      { ueConnected: false },
      { readOnly: true },
      { isSubAgent: true },
      { toolNames: ['web_read'] }
    ]) {
      const tools = resolveAgentTools({ ...ctx, ...overrides }, [], task)
      const search = createToolSearch(tools, () => tools)
      const names = search.getTools().map((tool) => tool.name)
      expect(
        search
          .getTools()
          .filter((tool) => tool.name !== 'search_tools')
          .every((tool) => tools.includes(tool))
      ).toBe(true)
      if ('ueConnected' in overrides)
        expect(
          search
            .getTools()
            .filter((tool) => tool.unrealBox.namespace.startsWith('ue.'))
            .every((tool) => OFFLINE_UE_TOOLS.has(tool.name))
        ).toBe(true)
      if ('readOnly' in overrides)
        expect(search.getTools().every((tool) => tool.unrealBox.risk === 'safe')).toBe(true)
      if ('isSubAgent' in overrides) expect(names).not.toEqual(expect.arrayContaining(['task']))
      if ('isSubAgent' in overrides)
        for (const name of [
          ...BROWSER_TOOL_NAMES,
          'ask_user',
          'voice_report',
          'set_session_project'
        ])
          expect(names).not.toContain(name)
      if ('toolNames' in overrides) expect(names).toEqual(['search_tools', 'web_read'])
    }
    const external = {
      ...catalog[0],
      name: 'mcp_example_tool',
      unrealBox: { namespace: 'mcp.example', risk: 'safe' as const }
    }
    const tools = [...catalog, external]
    const search = createToolSearch(tools, () => tools)
    expect(search.getTools()).not.toContain(external)
    await search.tool.execute('load', { names: [external.name] })
    expect(search.getTools()).toContain(external)
  })

  it('测量完整真实定义，包含 task 与现造工具', async () => {
    const tools = resolveAgentTools(ctx, skills, task)
    const initial = createToolSearch(tools, () => tools).getTools()
    const coreBytes = initial.reduce((sum, tool) => sum + toolDefinitionBytes(tool), 0)
    /*
     * 常驻集合扩容也不能悄悄吞下整个工具库。
     *
     * 2026-09-17：54,962 → 73,804。涨的是按「完全没有替代」补进常驻的三个
     * （`ue_get_actor` / `ue_screenshot` / `ue_playtest`，见文档 §3.8），约 18,800 字节。
     * 上限跟着从 64,000 抬到 80,000。
     *
     * 2026-09-21 整组常驻（`RESIDENT_TOOL_GROUPS`）让总量涨到约 103 KB。
     * **没有把 80,000 那条线往上挪** —— 那会是「用被守的东西去放宽守门的线」。
     * 改成分开量两笔，每一笔都还钉在自己该在的地方：
     *
     * 1. **点名常驻**（文档 §3 那 30 个 + 宿主交互）还守原来的 80,000。这条线
     *    守的是「别靠往清单里塞名字把前缀撑大」，它一个字节都没有放松。
     * 2. **整组常驻**单独一条 30,000。它守的是另一件事：整组常驻是按
     *    prompt cache 的账算出来的（每加载一组要全价重写一次前缀，约 1.25×P₀
     *    ≈ 37,500 token，顶得上 17 轮白带着一个 6 KB 的组），所以**只有小组够格**。
     *    这条线一旦要抬，等于有人想把一个大组塞进常驻 —— 那必须先拿出它的实测 p，
     *    而不是改个数字。逐组的盈亏平衡 p 写在 `RESIDENT_TOOL_GROUPS` 的注释里。
     *
     * 两条分开还有个好处：以后是哪一路在涨，一眼就看得出来，而一条合并的线只会
     * 说「总量超了」。真要把折叠整个关掉，应该明着关（`agentToolSearchEnabled`），
     * 不是从这里一次抬一点漏过去。
     */
    const byGroup = initial.filter(
      (tool) =>
        !(RESIDENT_TOOL_NAMES as readonly string[]).includes(tool.name) &&
        RESIDENT_TOOL_GROUPS.has(toolSearchGroup(tool))
    )
    const groupBytes = byGroup.reduce((sum, tool) => sum + toolDefinitionBytes(tool), 0)
    expect(groupBytes).toBeLessThan(30_000)
    expect(coreBytes - groupBytes).toBeLessThan(80_000)
    if (process.env.TOOL_SEARCH_MEASURE !== '1') return
    const [cl100k, o200k] = await Promise.all([
      import('gpt-tokenizer/encoding/cl100k_base'),
      import('gpt-tokenizer/encoding/o200k_base')
    ])
    const count = (text: string): number =>
      Math.max(cl100k.encode(text).length, o200k.encode(text).length)
    const sum = (list: UnrealAgentTool<never>[]): number =>
      list.reduce(
        (total, tool) =>
          total +
          count(
            JSON.stringify({
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters
            })
          ),
        0
      )
    const prompt = buildSystemPrompt(ctx, skills)
    console.info(
      'TOOL_SEARCH_MEASURE',
      JSON.stringify({
        taskTokens: sum([task]),
        recommendedTokens: sum(
          tools.filter((tool) => (RESIDENT_TOOL_NAMES as readonly string[]).includes(tool.name))
        ),
        initialCount: initial.length,
        initialBytes: coreBytes,
        initialToolTokens: sum(initial),
        initialPrefixTokens: sum(initial) + count(prompt + TOOL_SEARCH_RULES),
        fullCount: tools.length,
        fullPrefixTokens: sum(tools) + count(prompt)
      })
    )
  })

  it.each([
    ['创建材质实例', 'material_create_instance'],
    ['查看材质节点连线', 'material_get_graph'],
    ['调整材质实例参数', 'material_set_param'],
    ['整理材质节点布局', 'material_tidy_graph'],
    ['compile blueprint', 'blueprint_compile'],
    ['蓝图添加变量', 'blueprint_add_variable'],
    ['按文件名查找 fbx', 'find_local_files'],
    ['网页搜索', 'web_search']
  ])('%s 应能加载 %s', async (query, expected) => {
    expect(
      catalog.some((tool) => tool.name === expected),
      `样本工具已改名：${expected}`
    ).toBe(true)
    const search = createToolSearch(catalog, () => catalog)
    const result = await search.tool.execute('probe', { query })
    expect(loadedNames(result)).toContain(expected)
  })

  it('泛称本地文件搜索时至少提供文件名查找或文件内容搜索', async () => {
    const search = createToolSearch(catalog, () => catalog)
    const result = await search.tool.execute('probe', { query: '本地文件搜索' })
    expect(
      loadedNames(result).some((name) => ['find_local_files', 'grep_local_files'].includes(name))
    ).toBe(true)
  })
})
