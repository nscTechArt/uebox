import { describe, expect, it, vi } from 'vitest'

import { electronMock, servicesMock, targetContextMock } from '../testSupport/toolMocks'

// createAgent → registry → 全部 V2 工具模块。理由见 testSupport/toolMocks.ts
// 包一层箭头：vi.mock 会被提升到 import 之上，直接传标识符会在初始化前访问它
// （ReferenceError: Cannot access '__vi_import_0__' before initialization）。
// 箭头把标识符的求值推迟到工厂真正被调用时。
vi.mock('electron', () => electronMock())
vi.mock('../../services', () => servicesMock())
vi.mock('../../agent-v3/core/projectTargetContext', async (importOriginal) =>
  targetContextMock(importOriginal)
)

import {
  buildSystemPrompt,
  resolveAgentTools,
  resolveTools,
  type SessionContext
} from './createAgent'
import { RUNTIME_ENVELOPE_RULES } from './runtimeEnvelope'
import { resolveSessionScope } from './sessionScope'
import { EDITOR_SNAPSHOT_RULES } from './editorSnapshot'
import type { UnrealAgentTool } from '../tools/defineTool'
import { OFFLINE_UE_TOOLS } from '../tools/toolNames'

function fakeTool(
  name: string,
  namespace: string,
  risk: 'safe' | 'mutating' | 'destructive' = 'safe'
): UnrealAgentTool<never> {
  return { name, unrealBox: { namespace, risk } } as UnrealAgentTool<never>
}

describe('resolveTools —— 动态工具过滤', () => {
  it('未连接引擎时不注册 ue.* 工具，但保留盒子本地能力', () => {
    // V2 是把 16 个专家塞进 Router prompt 让模型选；V3 直接不给它看 ——
    // 模型看不到的工具不会被误调，也不占 token。
    // 资产库 / 项目管理不依赖引擎，未连接时仍然可用。
    const tools = resolveTools({ sessionId: 's', ueConnected: false })
    const names = tools.map((t) => t.name)

    // 名单要精确匹配：多漏一个进来就意味着模型手里多了一个必然调不通的工具，
    // 而它会在上面浪费步数、最后拿一句「客户端不存在或已断开」
    const ueTools = tools.filter((t) => t.unrealBox.namespace.startsWith('ue.'))
    expect(ueTools.map((t) => t.name).sort()).toEqual(['ue_get_crash_logs', 'ue_session_health'])
    expect(names).toContain('search_assets')
    expect(tools.length).toBeGreaterThan(0)
  })

  /**
   * 崩溃日志直接读 Saved/Crashes 和 Saved/Logs 里的文件，插件连接只是可选的补充。
   *
   * 它原本被 ue.* 的过滤规则一刀切掉了 —— 而**编辑器崩了的时候正是连接断开的
   * 时候**：用户问「刚才为什么崩了」，模型手里恰好没有那个工具，只能回一句
   * 「请先连接虚幻引擎」。
   */
  it('引擎没连上时崩溃日志工具仍然可用', () => {
    const tools = resolveTools({ sessionId: 's', ueConnected: false })

    expect(tools.map((t) => t.name)).toContain('ue_get_crash_logs')
  })

  /**
   * 「这台机器上装了哪些引擎、插件在不在」是引擎**没连上**时的第一个问题。
   * 它读的是盒子自己扫出来的安装记录，跟引擎连不连没关系 —— 被 ue.* 的过滤
   * 规则捎带滤掉的话，模型就只能自己去 shell 里 reg query，翻出一份比用户
   * 眼前那排卡片还少的清单。
   */
  it('引擎没连上时引擎清单工具仍然可用', () => {
    const tools = resolveTools({ sessionId: 's', ueConnected: false })

    expect(tools.map((t) => t.name)).toContain('list_engines')
  })

  /**
   * 会话体检回答的就是「到底连没连上」，所以它必须在**没连上**时还在。
   *
   * 按 `ue.*` 一刀切掉的话，恰恰在唯一需要它的场景里它不在 —— 真机上模型
   * 只能退回去 shell 里 tasklist 数进程，再拿别的引擎工具反复试探，
   * 而那些试探本来就会因为没连接被拒。
   */
  it('引擎没连上时会话体检工具仍然可用', () => {
    const tools = resolveTools({ sessionId: 's', ueConnected: false })

    expect(tools.map((t) => t.name)).toContain('ue_session_health')
  })

  // 它标 safe，所以只读的 Ask 模式下也得在 —— 排查连接不是写操作
  it('Ask 模式下会话体检工具仍然可用', () => {
    const tools = resolveTools({ sessionId: 's', ueConnected: false, mode: 'ask' })

    expect(tools.map((t) => t.name)).toContain('ue_session_health')
  })

  it('已连接引擎时注册全部工具', () => {
    const off = resolveTools({ sessionId: 's', ueConnected: false })
    const on = resolveTools({ sessionId: 's', ueConnected: true })

    expect(on.length).toBeGreaterThan(off.length)
    expect(on.map((t) => t.name)).toEqual(
      expect.arrayContaining(['material_create', 'blueprint_create', 'ue_spawn_actor'])
    )
  })

  /**
   * 「离线视图 = 联机视图过滤一遍」——这条等式是轮内换工具那套机制的地基。
   *
   * `createUnrealAgent` 只装配**一次**工具池（按 `ueConnected: true`），离线那份
   * 从它过滤出来。不能装配两次：浏览器工具、`ask_user`、`voice_report` 是现造的，
   * 造第二遍等于凭空多出一套带自己状态的实例，前半轮拿到的 ref 全作废。
   *
   * 代价是「按 ueConnected 分叉」这件事只允许发生在那一道命名空间过滤上。哪天
   * 有人在 `resolveCandidateTools` 里为 `ueConnected` 再加一条分支，等式就破了，
   * 而破了的表现是**中途连上引擎后工具清单是错的** —— 那种 bug 靠肉眼极难发现。
   * 这一条在那时当场失败。
   */
  it('离线工具清单等于联机清单滤掉 ue.*（轮内换清单的地基）', () => {
    const online = resolveTools({ sessionId: 's', ueConnected: true })
    const offline = resolveTools({ sessionId: 's', ueConnected: false })

    const derived = online.filter(
      (tool) => !tool.unrealBox.namespace.startsWith('ue.') || OFFLINE_UE_TOOLS.has(tool.name)
    )

    expect(derived.map((t) => t.name)).toEqual(offline.map((t) => t.name))
  })

  it('namespaces 白名单把子 agent 限定在一个领域', () => {
    const tools = resolveTools({
      sessionId: 's',
      ueConnected: true,
      namespaces: ['ue.material']
    })

    // 盯的是「白名单确实收窄了」，不是材质工具具体有几个 ——
    // 写死数量的话，每次给材质加一个工具这里就红一次，而它并没有测出任何东西。
    const unfiltered = resolveTools({ sessionId: 's', ueConnected: true })
    expect(tools.length).toBeGreaterThan(0)
    expect(tools.length).toBeLessThan(unfiltered.length)
    expect(tools.every((t) => t.unrealBox.namespace === 'ue.material')).toBe(true)
  })

  it('Ask 模式只留只读工具', () => {
    const tools = resolveTools({ sessionId: 's', ueConnected: true, mode: 'ask' })

    expect(tools.every((t) => t.unrealBox.risk === 'safe')).toBe(true)
    // 只读工具应该覆盖多个领域，而不是只剩材质
    expect(new Set(tools.map((t) => t.unrealBox.namespace)).size).toBeGreaterThan(3)
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['material_describe', 'blueprint_get_graph', 'ue_get_actor'])
    )
    expect(tools.map((t) => t.name)).not.toContain('ue_destroy_actor')
  })

  it('危险工具标注正确 —— 删除类不可逆', () => {
    const byName = new Map(
      resolveTools({ sessionId: 's', ueConnected: true }).map((t) => [t.name, t])
    )

    expect(byName.get('material_delete_node')?.unrealBox.risk).toBe('destructive')
    expect(byName.get('ue_destroy_actor')?.unrealBox.risk).toBe('destructive')
  })

  /**
   * 浏览器工具的注册条件。
   *
   * 这是安全边界，不是手感问题：浏览器带着用户真实的登录态，
   * 只该给「有人正看着屏幕」的那一种会话。
   */
  describe('浏览器工具', () => {
    const withApproval = {
      sessionId: 's',
      ueConnected: true,
      requestApproval: async (): Promise<'approve'> => 'approve'
    } as const

    const browserNames = (ctx: Parameters<typeof resolveTools>[0]): string[] =>
      resolveTools(ctx)
        .map((t) => t.name)
        .filter((name) => name.startsWith('browser_'))

    it('主 agent 且有审批通道时给全六个', () => {
      expect(browserNames(withApproval).sort()).toEqual([
        'browser_close',
        'browser_interact',
        'browser_navigate',
        'browser_open',
        'browser_read',
        'browser_screenshot'
      ])
    })

    // 读网页是只读操作，那正是 Ask 想要的；会改东西的 interact
    // 跟着风险等级被滤掉，不需要为它单写规则
    it('Ask 模式留下读网页的那几个，滤掉会动页面的', () => {
      const names = browserNames({ ...withApproval, mode: 'ask' })

      expect(names.sort()).toEqual([
        'browser_close',
        'browser_navigate',
        'browser_open',
        'browser_read',
        'browser_screenshot'
      ])
      expect(names).not.toContain('browser_interact')
    })

    // task 是并行的：多个子 agent 共用一个窗口会互相把 ref 打失效
    it('子 agent 一个都不给', () => {
      expect(browserNames({ ...withApproval, isSubAgent: true })).toEqual([])
    })

    // 没有审批 UI 的场景（定时任务、无头跑）等同全放行，
    // 而这套工具恰恰不能在没人看着的时候点按钮
    it('没有审批通道时一个都不给', () => {
      expect(browserNames({ sessionId: 's', ueConnected: true })).toEqual([])
    })

    // 打开网页不算敏感操作（拦不住什么，见 builtin/browser.ts）；
    // 真正把数据发出去的那一步才拦
    it('只有 interact 带逐次审批标记，审批门据此跳过 always 和 yolo', () => {
      const byName = new Map(resolveTools(withApproval).map((t) => [t.name, t]))

      expect(byName.get('browser_interact')?.unrealBox.requiresExplicitApproval).toBe(true)
      expect(byName.get('browser_open')?.unrealBox.requiresExplicitApproval).toBeUndefined()
      expect(byName.get('browser_read')?.unrealBox.requiresExplicitApproval).toBeUndefined()
    })
  })

  describe('反问用户', () => {
    const withQuestion = {
      sessionId: 's',
      ueConnected: true,
      requestQuestion: async (): Promise<{ action: 'decline' }> => ({ action: 'decline' })
    } as const

    const hasAskUser = (ctx: Parameters<typeof resolveTools>[0]): boolean =>
      resolveTools(ctx).some((t) => t.name === 'ask_user')

    it('主 agent 且有提问通道时给', () => {
      expect(hasAskUser(withQuestion)).toBe(true)
    })

    // 只读会话同样会遇到「你到底想问哪一层」，而且问一句什么都不改
    it('Ask 模式照给', () => {
      expect(hasAskUser({ ...withQuestion, mode: 'ask' })).toBe(true)
    })

    /**
     * 子 agent 一律不给。
     *
     * 它跑在用户看不见的后台，挂起等回答就是隐形卡死 —— 而且用户根本不知道
     * 是哪个后台任务在等他。说不准的地方应该写进返回文本，由父 agent 决定
     * 要不要问人。Claude Code 也是这么禁的。
     */
    it('子 agent 不给', () => {
      expect(hasAskUser({ ...withQuestion, isSubAgent: true })).toBe(false)
    })

    // 定时任务、无头跑：没人会看见那张卡片，而提问没有超时 —— 给了等于允许它一直挂着
    it('没有提问通道时不给', () => {
      expect(hasAskUser({ sessionId: 's', ueConnected: true })).toBe(false)
    })

    // 走审批门会变成「为了弹一个问题，先弹一个确认框」
    it('风险等级是 safe，不进审批门', () => {
      const tool = resolveTools(withQuestion).find((t) => t.name === 'ask_user')
      expect(tool?.unrealBox.risk).toBe('safe')
    })
  })

  /**
   * 换这条对话归属哪个工程。
   *
   * 归属既是侧边栏的分组，也是引擎命令的硬边界（「项目对项目」）。那条边界挡住的
   * 是真实事故，但它也曾经挡住一件完全合理的事：用户在挂着旧工程的对话里说
   * 「建个新工程做荷塘」，模型把工程建好打开连上，然后停下来请用户去界面上改归属。
   * 现在给模型一把明确的钥匙 —— 要换就说出来，说了就换。
   */
  describe('换会话归属', () => {
    const withControl = {
      sessionId: 's',
      ueConnected: true,
      sessionProjectControl: { listProjects: () => [], onChange: (): void => {} }
    } as const

    const has = (ctx: Parameters<typeof resolveTools>[0]): boolean =>
      resolveTools(ctx).some((t) => t.name === 'set_session_project')

    it('宿主接了通道就给', () => {
      expect(has(withControl)).toBe(true)
    })

    /*
     * 归属住在渲染层，没人接这条通知的话改动只在这一轮算数，下一轮又弹回旧归属。
     * 半生效比不生效更难排查 —— 所以无头跑、调试入口一律不给。
     */
    it('没有宿主通道时不给', () => {
      expect(has({ sessionId: 's', ueConnected: true })).toBe(false)
    })

    // 子 agent 没有自己的会话，改的会是父会话的归属 ——
    // 一个跑在后台的子任务不该动用户在侧边栏里的组织方式
    it('子 agent 不给', () => {
      expect(has({ ...withControl, isSubAgent: true })).toBe(false)
    })

    /*
     * Ask 模式不给：它改的是用户的组织方式，还顺带改掉后续引擎命令的去向。
     * 只读会话里不该发生这种事 —— 按 `risk: 'mutating'` 自然被滤掉，
     * 这一条钉死那个风险等级没被人随手改成 safe。
     */
    it('Ask 模式不给', () => {
      expect(has({ ...withControl, mode: 'ask' })).toBe(false)
    })
  })

  describe('口头汇报进度', () => {
    const withReport = {
      sessionId: 's',
      ueConnected: true,
      onVoiceReport: (): void => {}
    } as const

    const hasVoiceReport = (ctx: Parameters<typeof resolveTools>[0]): boolean =>
      resolveTools(ctx).some((t) => t.name === 'voice_report')

    // 用户在界面上打字跑的运行没人在听，给了模型只会白调
    it('宿主给了汇报通道（语音派的活）才给', () => {
      expect(hasVoiceReport(withReport)).toBe(true)
      expect(hasVoiceReport({ sessionId: 's', ueConnected: true })).toBe(false)
    })

    // 子 agent 的进度该写进返回文本，由父 agent 决定要不要说
    it('子 agent 不给', () => {
      expect(hasVoiceReport({ ...withReport, isSubAgent: true })).toBe(false)
    })

    // 只是念一句，什么都不改
    it('Ask 模式照给', () => {
      expect(hasVoiceReport({ ...withReport, mode: 'ask' })).toBe(true)
    })
  })

  it('改同一份图表的工具声明为串行，避免并发覆盖', () => {
    const sequential = new Set(
      resolveTools({ sessionId: 's', ueConnected: true })
        .filter((t) => (t as { executionMode?: string }).executionMode === 'sequential')
        .map((t) => t.name)
    )

    for (const name of [
      'material_compile',
      'material_apply_graph',
      'blueprint_apply_graph',
      'blueprint_compile',
      'widget_add_child'
    ]) {
      expect(sequential.has(name), `${name} 应声明为 sequential`).toBe(true)
    }
  })

  describe('完整工具池的最终授权过滤', () => {
    const skills = [{ name: 'demo', description: '测试技能', path: '/tmp/demo/SKILL.md' }]
    const mcpTool = fakeTool('mcp_demo_read', 'mcp.demo')
    const taskTool = fakeTool('task', 'core')
    const mcp = {
      getTools: () => [mcpTool],
      getStatuses: () => []
    } as never

    it('toolNames 会过滤掉后追加的技能、MCP 和 task 工具', () => {
      const tools = resolveAgentTools(
        {
          sessionId: 's',
          ueConnected: true,
          toolNames: ['material_describe'],
          mcp
        },
        skills,
        taskTool
      )

      expect(tools.map((tool) => tool.name)).toEqual(['material_describe'])
    })

    it('toolNames 点名后，动态工具仍可按授权加入', () => {
      const tools = resolveAgentTools(
        {
          sessionId: 's',
          ueConnected: true,
          toolNames: ['load_skill', 'mcp_demo_read', 'task'],
          mcp
        },
        skills,
        taskTool
      )

      expect(tools.map((tool) => tool.name).sort()).toEqual(['load_skill', 'mcp_demo_read', 'task'])
    })

    it('Ask 模式的最终过滤也覆盖后追加工具', () => {
      const unsafeTask = fakeTool('task', 'core', 'mutating')
      const tools = resolveAgentTools(
        { sessionId: 's', ueConnected: true, mode: 'ask' },
        skills,
        unsafeTask
      )

      expect(tools.every((tool) => tool.unrealBox.risk === 'safe')).toBe(true)
      expect(tools.map((tool) => tool.name)).not.toContain('task')
      expect(tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(['load_skill', 'read_skill_resource'])
      )
    })
  })

  /**
   * 「允许编辑器截图」那一档。
   *
   * 这个开关以前是假的：渲染层有字段、界面有开关，主进程一次都没读过
   * （`grep -rn editorScreenshotEnabled src/main` 零命中），而 `ue_screenshot`
   * 登记的风险是 `safe`，连审批门都不过。也就是说用户关掉之后 agent 照样在拍 ——
   * 一个什么都不做的隐私开关比没有开关更糟，用户以为自己关上了。
   */
  describe('编辑器截图开关', () => {
    const names = (ctx: Partial<SessionContext>): string[] =>
      resolveTools({ sessionId: 's', ueConnected: true, ...ctx }).map((tool) => tool.name)

    it('关掉时 ue_screenshot 不进工具池', () => {
      expect(names({ editorScreenshotEnabled: false })).not.toContain('ue_screenshot')
    })

    it('开着时照常给', () => {
      expect(names({ editorScreenshotEnabled: true })).toContain('ue_screenshot')
    })

    /**
     * 省略 = 「没人说过话」，不是「用户关过」。无头跑、定时任务、调试入口都不带
     * 这个字段 —— 兜底成禁止的话，它们会静默失去截图能力，而用户一个开关都没动过。
     */
    it('不传时按默认档（允许）走', () => {
      expect(names({})).toContain('ue_screenshot')
    })

    /**
     * 只摘拍视口的那一个。整片摘掉的话，一个隐私开关会顺手关掉「验证游戏
     * 能不能跑」（试玩）和「看一眼这个 UI 对不对」（离屏渲染的 Widget 预览），
     * 而后者一个像素的隐私都没泄。
     */
    it('试玩和 Widget 预览不受影响', () => {
      const kept = names({ editorScreenshotEnabled: false })
      expect(kept).toContain('ue_playtest')
      expect(kept).toContain('widget_preview')
    })

    // 写在最终授权过滤里而不是内置工具那一段：这是用户明确关掉的能力，
    // 不论工具来自内置、技能还是 MCP 都不该有例外
    it('后追加的工具同样过滤 —— 授权边界只有一处', () => {
      const tools = resolveAgentTools(
        { sessionId: 's', ueConnected: true, editorScreenshotEnabled: false },
        [],
        fakeTool('ue_screenshot', 'ue.editor')
      )

      expect(tools.map((tool) => tool.name)).not.toContain('ue_screenshot')
    })
  })

  /**
   * 「设置 → 工具」里那一页开关。
   *
   * 一个关掉之后工具照样出现的开关比没有开关更糟：用户以为自己收窄了，
   * 而模型手上什么都没少。
   */
  describe('用户关掉的工具', () => {
    const names = (ctx: Partial<SessionContext>): string[] =>
      resolveTools({ sessionId: 's', ueConnected: true, ...ctx }).map((tool) => tool.name)

    it('关掉的不进工具池，没关的照常在', () => {
      const kept = names({ disabledToolNames: ['ue_screenshot'] })
      expect(kept).not.toContain('ue_screenshot')
      expect(kept).toContain('ue_playtest')
    })

    it('没传就是没人说过话，一个都不滤', () => {
      expect(names({})).toContain('ue_screenshot')
    })

    /*
     * 工具搜索模式下这份名单**不生效**：同一页的开关在那个模式里记的是
     * 「常驻还是搜索加载」，两份状态各管各的。一个人在全量模式下关掉整摊 PCG，
     * 切到搜索模式不该发现 PCG 连搜都搜不到 —— 那是他没点过的第二件事。
     */
    it('工具搜索模式下不按这份名单滤', () => {
      expect(names({ disabledToolNames: ['ue_screenshot'], toolSearchEnabled: true })).toContain(
        'ue_screenshot'
      )
    })

    /*
     * 设置页压根不列这几个，但配置文件是能手改的 —— 而它们被关掉的表现是
     * 「助手整个不动了，且设置页上看不出为什么」。
     */
    it('加载入口、反问通道和子任务关不掉', () => {
      const tools = resolveAgentTools(
        { sessionId: 's', ueConnected: true, disabledToolNames: ['task', 'ue_screenshot'] },
        [],
        fakeTool('task', 'core')
      )
      const names = tools.map((tool) => tool.name)
      expect(names).toContain('task')
      expect(names).not.toContain('ue_screenshot')
    })

    // 同截图开关：授权边界只有一处，技能/MCP/task 追加进来的一样要过
    it('后追加的工具同样过滤', () => {
      const tools = resolveAgentTools(
        { sessionId: 's', ueConnected: true, disabledToolNames: ['mcp_figma_read'] },
        [],
        fakeTool('mcp_figma_read', 'mcp.figma')
      )
      expect(tools.map((tool) => tool.name)).not.toContain('mcp_figma_read')
    })
  })
})

/**
 * 系统提示词是模型每一轮都读的东西，也是整个 agent 里最贵的一段常驻 token。
 * 它写错不会让任何测试变红、不会抛异常 —— 只会让模型悄悄少做一步、多猜一次。
 * 所以这里盯的是几条**改坏了就没人会发现**的性质。
 */
describe('buildSystemPrompt', () => {
  const base = { sessionId: 's', ueConnected: true } as const

  /**
   * 只取提示词末尾的 `<environment>` 块。
   *
   * 「有没有劝人装插件」是环境块这三个分支之间的差别，而 UnrealAgentLink 这个词
   * 在常驻的能力清单里也会出现（`list_engines` 就是查它装没装的）。拿整段提示词
   * 做包含判断，会把能力清单里的一次提及误当成连接引导。
   */
  const environmentOf = (prompt: string): string => prompt.slice(prompt.indexOf('<environment>'))

  /**
   * 子 agent 手里没有 `task`（`resolveAgentTools` 摘掉了），提示词却照样把它
   * 列在能力清单里。真机后果不是白说一句：子 agent 去调它，pi 回
   * `Tool task not found`，这句话被写进交给父 agent 的报告，父 agent 读成
   * 「子任务没派出去」—— 而三路其实都跑完了，其中一路还改了场景。
   */
  it('子 agent 的提示词里不提 task，并明说它不能再往下派', () => {
    const parent = buildSystemPrompt(base)
    const sub = buildSystemPrompt({ ...base, isSubAgent: true })

    // 判的是「把 task 当成它有的工具来介绍」那几句，不是任何一次提及 ——
    // 提示词里还有一句讲「task 子 agent 的环境块是冻住的」，那句对子 agent 本来就有用
    expect(parent).toContain('- `task`: hand a well-scoped subtask')
    expect(parent).toContain('issue all the `task` calls in the same turn')
    expect(sub).not.toContain('- `task`: hand a well-scoped subtask')
    expect(sub).not.toContain('issue all the `task` calls in the same turn')
    expect(sub).not.toContain('subtasks that take many intermediate steps')
    expect(sub).toContain('cannot delegate further')
  })

  it('只读子任务被告知写工具不在手上，并点名最容易被误会的那两个', () => {
    const readOnly = buildSystemPrompt({ ...base, isSubAgent: true, readOnly: true })

    expect(readOnly).toContain('This subtask is read-only')
    // 真机上反复卡在这两个：一个能写所以被摘，一个动视口所以被摘，
    // 不点名的话子任务会把「调不动」读成「工具没了」
    expect(readOnly).toContain('ue_run_python_script')
    expect(readOnly).toContain('ue_focus_viewport')
    expect(buildSystemPrompt({ ...base, isSubAgent: true })).not.toContain(
      'This subtask is read-only'
    )
  })

  /**
   * 同一个误判撞了三次：子任务发现某个工具调不动，就报「工具在逐个消失 /
   * 可用性随时间衰减」。它继承的是完整对话，里面全是主 agent 第一人称的
   * 「我刚用过这个工具」—— 手里没有 + 记忆里有过，推出来的就是「被收走了」。
   */
  it('子 agent 被告知工具清单是按层给的，不是随时间变的', () => {
    const sub = buildSystemPrompt({ ...base, isSubAgent: true })

    expect(sub).toContain('scoped to this subtask and does not change while you run')
    expect(sub).toContain('never report that the tools are degrading')
    expect(buildSystemPrompt(base)).not.toContain('scoped to this subtask')
  })

  /**
   * 回复语言只认界面语言。判据的来历见 `createAgent.ts` 里这条准则上面那段 ——
   * 「跟着用户这句话走」试过两次，两个方向各翻车一次。
   */
  it('回复语言跟着界面语言，省略时按中文', () => {
    expect(buildSystemPrompt({ ...base, uiLanguage: 'en-US' })).toContain(
      'Always write your reply to the user in English'
    )
    expect(buildSystemPrompt({ ...base, uiLanguage: 'zh-CN' })).toContain(
      'Always write your reply to the user in Chinese'
    )
    // 应用默认就是中文，没传时不能落到英文上
    expect(buildSystemPrompt(base)).toContain('Always write your reply to the user in Chinese')
  })

  /**
   * 这半句是第 2 版翻车的解药，不能省：中文界面的用户发了一段英文内容，
   * 模型照着眼前这条消息回了英文 —— 而界面明明是中文的。
   */
  it('明说不跟随用户消息和工具返回的语言', () => {
    for (const uiLanguage of ['zh-CN', 'en-US'] as const) {
      const prompt = buildSystemPrompt({ ...base, uiLanguage })

      expect(prompt).toContain('whatever language their message or the tool results are in')
      // 那句人群断言是第 1 版翻车的根，不许回来
      expect(prompt).not.toContain('mostly write Chinese')
    }
  })

  it('连上引擎时把工程写进去 —— 以前只有「没连」的分支，连上反而什么都不说', () => {
    const prompt = buildSystemPrompt({
      ...base,
      project: { name: 'MyGame', engineVersion: '5.4', path: 'H:/Projects/MyGame' }
    })

    expect(prompt).toContain('MyGame')
    expect(prompt).toContain('UE 5.4')
    expect(prompt).toContain('H:/Projects/MyGame')
  })

  // 工程字段是引擎那边报上来的，缺字段是常态，不能印出 "UE undefined"
  it('工程信息不全时跳过缺的字段，不印 undefined', () => {
    const prompt = buildSystemPrompt({ ...base, project: { name: 'MyGame' } })

    expect(prompt).toContain('MyGame')
    expect(prompt).not.toContain('undefined')
  })

  /**
   * 技能沉淀档位要真的走到提示词里。
   *
   * 档位存在渲染层、每轮随请求带下来，中间过了 IPC → SessionContext →
   * buildSystemPrompt 三道手 —— 任何一道漏传，用户在设置页选的自动档
   * 都会静默退回默认，而界面上那个按钮还亮着。
   */
  it('自动档把「不用先问」写进提示词，默认档不写', () => {
    const skills = [{ name: 'ue-skill-creator', description: '把经验沉淀成技能。', path: '/tmp/x' }]

    expect(buildSystemPrompt({ ...base, skillLearning: 'auto' }, skills)).toContain('propose first')
    expect(buildSystemPrompt(base, skills)).not.toContain('propose first')
  })

  it('视觉收尾要求当轮数字与预览，不把无法测量当成通过', () => {
    const prompt = buildSystemPrompt(base)
    expect(prompt).toContain('anim_measure and anim_preview at matching frames')
    expect(prompt).toContain('unmeasurable is not a pass')
    expect(prompt).toContain('Never invent a measurement or bypass screenshot privacy settings')
  })

  /**
   * 网页不可信规则。
   *
   * 它必须跟着工具走：没注册浏览器却说「你能上网」，模型会去调一个不存在的
   * 工具，然后把「打不开」答成「我没有这个能力」；注册了却不说这几条，
   * 模型读完一个写着「忽略之前的指令」的页面时手里没有任何判据。
   */
  it('浏览器那行只在真的注册了浏览器工具时才写', () => {
    const withBrowser = buildSystemPrompt({
      ...base,
      requestApproval: async () => 'approve'
    })

    expect(withBrowser).toContain('browser_open')
    expect(buildSystemPrompt(base)).not.toContain('browser_open')
  })

  /**
   * 不可信规则**无条件**写。
   *
   * 它原来跟着浏览器工具走，那是错的：`web_search` / `web_read` 是无头只读的，
   * 任何会话都有（Ask 模式、子 agent 也有），它们把外部内容灌进上下文的程度
   * 和浏览器一模一样 —— 而无头意味着用户根本看不见那篇文章写了什么。
   */
  it('不可信规则在没有浏览器的会话里也写', () => {
    expect(buildSystemPrompt(base)).toContain('untrusted external data')
    expect(buildSystemPrompt({ ...base, mode: 'ask' })).toContain('untrusted external data')
    expect(buildSystemPrompt({ ...base, isSubAgent: true })).toContain('untrusted external data')
  })

  /**
   * 截图那一句必须跟着开关走，理由和浏览器那行完全一样。
   *
   * 只把 `ue_screenshot` 摘掉、这句话原样留着的话，模型会照着「拍一张确认一下」
   * 去调一个手里根本没有的工具，然后把「我拍不了」答成「我没有这个能力」——
   * 而真正的原因（用户自己关的、在哪儿能打开）它一个字都说不出来。
   */
  it('关掉编辑器截图时换掉「拍一张确认」那句，并说清原因和替代做法', () => {
    const off = buildSystemPrompt({ ...base, editorScreenshotEnabled: false })

    expect(off).not.toContain('capture one and confirm')
    expect(off).toContain('allow editor screenshots')
    // 不给替代做法的话，模型只会原地绕或者去 Python 里自己截一张
    expect(off).toContain('ue_get_actor')
    expect(off).toContain('Settings → AI → Privacy')
  })

  /**
   * 用户在「设置 → 工具」里关掉的那几个，提示词必须点名说出来。
   *
   * 这份提示词硬写死了一堆工具名（`ue_save`、`blueprint_apply_graph`、
   * 「拍一张确认一下」……），技能正文里更多。只把工具摘掉、这些话原样留着，
   * 模型会照着去调一个手里没有的工具，再把「我没这个工具」答成「我没有这个
   * 能力」，或者绕去写 Python —— 和截图那个开关是同一个坑，只是现在开关有
   * 一百多个，逐条改文案不可能。
   */
  it('关掉的工具在提示词里点名，并堵死绕路', () => {
    const prompt = buildSystemPrompt({
      ...base,
      disabledToolNames: ['ue_screenshot', 'blueprint_apply_graph']
    })

    expect(prompt).toContain('ue_screenshot, blueprint_apply_graph'.split(', ').sort().join(', '))
    expect(prompt).toContain('Settings → Tools')
    expect(prompt).toContain('not through Python')
  })

  it('一个都没关就不写这句 —— 那是每轮都要付的 token', () => {
    expect(buildSystemPrompt(base)).not.toContain('Settings → Tools')
    expect(buildSystemPrompt({ ...base, disabledToolNames: [] })).not.toContain('Settings → Tools')
  })

  /*
   * 工具搜索模式下同一页的开关记的是「常驻还是搜索加载」，工具一个都没少
   * （见 `applyFinalToolPolicy`）。照着这份名单说「没了」，模型会以为自己
   * 不会做，而那些工具搜一下就在手里。
   */
  it('工具搜索模式下不写这句', () => {
    const prompt = buildSystemPrompt({
      ...base,
      toolSearchEnabled: true,
      disabledToolNames: ['ue_screenshot']
    })
    expect(prompt).not.toContain('Settings → Tools')
  })

  // 这几个 `applyFinalToolPolicy` 会放行（配置被手改也关不掉），
  // 跟着报没了就是在撒谎 —— 模型会停下来不敢调一个它手里明明有的工具
  it('关不掉的那几个不跟着报没了', () => {
    const prompt = buildSystemPrompt({
      ...base,
      disabledToolNames: ['task', 'ue_screenshot']
    })
    expect(prompt).toContain('ue_screenshot')
    expect(prompt).not.toContain('task, ue_screenshot')
  })

  it('开着（或没说）时照常写「拍一张确认」', () => {
    expect(buildSystemPrompt(base)).toContain('capture one and confirm')
    expect(buildSystemPrompt({ ...base, editorScreenshotEnabled: true })).toContain(
      'capture one and confirm'
    )
  })

  it('检索能力任何会话都写 —— 它不需要审批通道', () => {
    expect(buildSystemPrompt(base)).toContain('web_search')
    expect(buildSystemPrompt({ ...base, mode: 'ask' })).toContain('web_read')
  })

  it('不可信规则点名了最常见的几种诱导', () => {
    const prompt = buildSystemPrompt({ ...base, requestApproval: async () => 'approve' })

    // 「读本地凭据 / 跑命令 / 把对话内容贴进表单」是网页注入的三个主要目标
    expect(prompt).toContain('shell commands')
    expect(prompt).toContain('ignore previous instructions')
  })

  it('没连引擎时给出连接引导，而不是留空', () => {
    const prompt = buildSystemPrompt({ ...base, ueConnected: false })

    expect(prompt).toContain('no UnrealAgentLink connection')
    expect(environmentOf(prompt)).toContain('UnrealAgentLink')
  })

  /*
   * 这里原先有三条逐分支钉字符串的测试（「没连引擎时不得推出编辑器没开」
   * 「工程类型未知时不劝人用 UE 打开」「别把要找的东西写死成 .uproject」）。
   *
   * 它们被下面那组矩阵测试取代了，不是被删掉不管了 —— 矩阵覆盖同样的教训，
   * 但遍历**全部可达情形**而不是各挑一个上下文，所以它才是那三个洞真正的看门人。
   * 逐分支钉字符串的写法天生查不出「另一个情形里少了一句」，而那正是当时漏掉的。
   */

  /**
   * 环境块的**矩阵**测试：遍历情形，断言不变量。
   *
   * ## 为什么必须是矩阵，不能再逐分支钉字符串
   *
   * `buildEnvironmentSection` 是三段手写散文（已连接 / 连着别的工程 / 什么都没连）。
   * 每段都得自己记住全部教训，而教训是一次真机故障加一条 —— 出事落在哪个分支就
   * 补哪个分支，另外两个不会跟上。逐分支钉字符串的测试**天生查不出**「另一个
   * 情形里少了一句」，所以它一个洞都没报过，而洞是真实存在的。
   *
   * 这里反过来：先把情形铺开，再问「凡是满足 X 的情形，是不是都说了 Y」。
   * 这种断言不关心散文怎么组织，也不关心将来是不是还有三个分支。
   *
   * ## 为什么重复的措辞本身就是风险
   *
   * 同一条教训在各分支里留下措辞不同的拷贝时，模型看到的是一组潜在冲突的指令，
   * 而且它基本不会告诉你有冲突；后出现的那份更容易被遵守（ConInstruct,
   * arXiv:2511.14342）。也就是说优先级不是我们设计的，是排版排出来的。
   * 所以下面断言的是「同一条教训只有一份措辞」，不是「每个分支各写各的」。
   */
  describe('环境块不变量（矩阵）', () => {
    /*
     * 情形**从 `resolveSessionScope` 派生**，不手工列组合。
     *
     * 手工列的第一版造出了「无归属 + 没连 + 别的工程连着」这种状态，然后报了个洞。
     * 可那个状态根本不存在 —— 没有归属时 `resolveSessionScope` 走纯对话分支，
     * `outOfScopeProjects` 恒为 `[]`。照着幻影去补提示词，只会为一个永不发生的
     * 情形加一段话，正是「最小高信号 token 集」要避免的那种膨胀。
     *
     * 所以这里喂真实输入给真实的解析器，再按 `withProject()` 的方式组装 ctx ——
     * 和 `ipc/agentV3.ts` 生产路径同一套。这样矩阵里的每个状态**按构造就是可达的**，
     * 将来解析规则改了，矩阵自己跟着变。
     */
    const conn = (
      projectName: string,
      projectPath?: string,
      engineVersion?: string
    ): {
      connectionId: string
      projectName: string
      projectPath?: string
      engineVersion?: string
    } => ({
      connectionId: `conn-${projectName}`,
      projectName,
      ...(projectPath ? { projectPath } : {}),
      ...(engineVersion ? { engineVersion } : {})
    })

    interface Situation {
      label: string
      ctx: SessionContext
    }

    /** 按 `ipc/agentV3.ts` 的 `withProject()` + `engineToolsAvailable()` 组装 */
    function situationOf(
      label: string,
      sessionProject: { projectName: string; projectPath?: string; engineVersion?: string } | null,
      connected: ReturnType<typeof conn>[]
    ): Situation {
      const scope = resolveSessionScope(sessionProject, connected, connected[0])
      const summary = scope.connectedProject
      return {
        label,
        ctx: {
          sessionId: 's',
          ueConnected: connected.length > 0 && scope.engineAvailable,
          ...(summary
            ? {
                project: {
                  name: summary.projectName,
                  ...(summary.engineVersion ? { engineVersion: summary.engineVersion } : {}),
                  ...(summary.projectPath ? { path: summary.projectPath } : {})
                }
              }
            : {}),
          ...(scope.sessionProject ? { sessionProject: scope.sessionProject } : {}),
          ...(scope.outOfScopeProjects.length
            ? { outOfScopeProjects: scope.outOfScopeProjects }
            : {})
        } as SessionContext
      }
    }

    const OTHER = conn('UALinkDev55', 'D:/UE/UALinkDev55', '5.5')

    const situations: Situation[] = [
      situationOf('无归属 × 没连', null, []),
      situationOf('无归属 × 连着一个', null, [OTHER]),
      situationOf('只有名字 × 没连', { projectName: 'test222' }, []),
      situationOf('只有名字 × 连着别的', { projectName: 'test222' }, [OTHER]),
      situationOf('有路径 × 没连', { projectName: 'test222', projectPath: 'D:/Games/test222' }, []),
      situationOf(
        '有路径 × 连着别的',
        { projectName: 'test222', projectPath: 'D:/Games/test222' },
        [OTHER]
      ),
      situationOf('有引擎版本 × 没连', { projectName: 'test222', engineVersion: '5.5' }, []),
      situationOf('有引擎版本 × 连着别的', { projectName: 'test222', engineVersion: '5.5' }, [
        OTHER
      ]),
      situationOf('归属工程自己连着', { projectName: 'MyGame' }, [
        conn('MyGame', 'D:/UE/MyGame', '5.5')
      ]),
      situationOf('归属工程连着 + 还连着别的', { projectName: 'MyGame' }, [
        conn('MyGame', 'D:/UE/MyGame', '5.5'),
        OTHER
      ])
    ]

    const envOf = (s: Situation): string => environmentOf(buildSystemPrompt(s.ctx))
    /** 这一轮模型手里有没有引擎工具 —— 有的话「路径/类型」都能直接问引擎 */
    const hasEngine = (s: Situation): boolean => Boolean(s.ctx.ueConnected)
    /** 盒子记着引擎版本 —— 唯一能确认「这是 UE 工程」的时候 */
    const knowsUnreal = (s: Situation): boolean =>
      Boolean((s.ctx.sessionProject as { engineVersion?: string } | undefined)?.engineVersion)
    const pathless = (s: Situation): boolean =>
      Boolean(s.ctx.sessionProject) && !(s.ctx.sessionProject as { path?: string }).path

    // 幻影状态在这里就会暴露：没有归属时不可能有「别的工程」
    it('派生出来的情形都是可达的', () => {
      for (const s of situations) {
        if (!s.ctx.sessionProject) expect(s.ctx.outOfScopeProjects ?? []).toEqual([])
      }
    })

    /*
     * 归属工程没记路径、而且这轮**问不到引擎**时，必须说清「没记 ≠ 丢了」，
     * 并且既不扫盘、也不拒绝去找。引擎在手时不要求 —— 那时路径直接问引擎就有。
     */
    it.each(situations.filter((s) => pathless(s) && !hasEngine(s)))(
      '没记路径且问不到引擎时要说清「没记≠丢了」：$label',
      (s) => {
        const env = envOf(s)
        expect(env).toContain('no path on record')
        expect(env).toContain('only when finding it is the task they gave you')
      }
    )

    /*
     * 不知道工程类型就不许**主动**劝人用 UE 打开。会话工程是用户在侧栏点
     * 「选文件夹」挑的任意目录（`AddProjectModal.pickFolder` 只开 `openDirectory`）。
     * 反过来不成立：没有引擎版本只等于「不知道」，不等于「不是」。
     *
     * 断言查的是**肯定式的引导语**，不是「Unreal Engine」这几个字 —— 第一版正则
     * 把禁令自己（「do not tell them to open it in Unreal Engine」）也匹配上了，
     * 于是测试在为一句正确的话报错。
     */
    it.each(situations.filter((s) => s.ctx.sessionProject && !knowsUnreal(s)))(
      '工程类型未知时不主动劝人用 UE 打开：$label',
      (s) => {
        const env = envOf(s)
        expect(env).not.toContain('ask them to open it in Unreal Engine')
        expect(env).not.toContain('start Unreal Engine with the project open')
      }
    )

    /*
     * 用户明明连着引擎（只是连的不是这条会话的工程），这时候劝他装插件是答非所问。
     */
    it.each(situations.filter((s) => s.ctx.outOfScopeProjects?.length))(
      '连着别的工程时不劝人装插件：$label',
      (s) => {
        expect(envOf(s)).not.toContain('install the UnrealAgentLink plugin')
      }
    )

    /*
     * 没有映射到本会话工程的连接，推不出这个工程的编辑器状态 —— 路径键对不上时
     * 工程开得好好的也会落到这里（`sessionScope.ts` 记着那种）。
     */
    it.each(situations.filter((s) => !hasEngine(s)))(
      '没有引擎工具时要说清它推不出编辑器状态：$label',
      (s) => {
        expect(envOf(s)).toContain('leaves open whether an editor is running')
      }
    )

    /*
     * 同一条教训只许有一份措辞。措辞不同的近义句对模型是潜在冲突，而且「后者胜」
     * （ConInstruct, arXiv:2511.14342），优先级会变成排版的副产品。
     */
    it.each(situations)('同一句话不在环境块里出现两次：$label', (s) => {
      const sentences = envOf(s)
        .split(/(?<=[.!?])\s+|\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 40)

      expect([...new Set(sentences)]).toHaveLength(sentences.length)
    })
  })

  /**
   * 真机上的原始 bug：会话挂在 test222 下，编辑器开着 UALinkDev55，
   * 用户问「这是啥项目」，模型把连着的那个工程一五一十答了出来 ——
   * 答的不是用户问的那个，而且全程没说自己换了个工程。
   *
   * 规则是项目对项目：这种情况下引擎工具整个不给（`ueConnected: false`），
   * 提示词要说清楚三件事 —— 这条会话是 test222 的、连着的是别人、
   * 想在这儿干活得先把 test222 打开。
   */
  it('归属工程没开着而别的工程连着时，说清「不是你的工程」而不是「没连引擎」', () => {
    const prompt = buildSystemPrompt({
      ...base,
      ueConnected: false,
      sessionProject: { name: 'test222', connected: false },
      outOfScopeProjects: ['UALinkDev55']
    })

    expect(prompt).toContain('test222')
    expect(prompt).toContain('UALinkDev55')
    expect(prompt).toContain('out of scope')
    // 用户明明连着引擎，这时候劝人装插件是答非所问
    expect(environmentOf(prompt)).not.toContain('UnrealAgentLink')
  })

  /**
   * 真机上模型给出的第三条出路是「把右上角的工程切换到 test222」—— 点了什么都不会发生，
   * 它本来就是 test222。胶囊是用来**改投连着的那个工程**的，提示词得把这件事说死，
   * 否则模型会照着「换个工程就好了」的直觉编一个无效操作出来。
   */
  it('逃生口写清楚是改投连着的那个工程，并点破「改投自己」是空操作', () => {
    const prompt = buildSystemPrompt({
      ...base,
      ueConnected: false,
      sessionProject: { name: 'test222', connected: false },
      outOfScopeProjects: ['UALinkDev55']
    })

    expect(prompt).toContain('re-points this conversation at UALinkDev55')
    expect(prompt).toContain('changes nothing')
  })

  /**
   * 「没有映射到本会话工程的连接」**不等于**「那个工程没打开」。
   *
   * `sessionScope.ts` 自己的注释里就记着一种：戳记着 `I:/Dev/Pond/Pond.uproject`、
   * 插件报 `I:/Dev/Pond`，路径键对不上，于是工程开得好好的也走这个分支。原文写
   * 「that project is not open」，模型就会照着一个它根本不知道的事实跟用户讲话。
   */
  it('归属工程没连时说的是「没有映射的连接」，不是「工程没打开」', () => {
    const env = environmentOf(
      buildSystemPrompt({
        ...base,
        ueConnected: false,
        sessionProject: { name: 'test222', connected: false },
        outOfScopeProjects: ['UALinkDev55']
      })
    )

    expect(env).toContain('no engine connection is currently mapped to it')
    expect(env).not.toContain('not open')
  })

  /*
   * 「没记下路径是未知不是否定」那一条也搬进了矩阵（「没记路径且问不到引擎时
   * 要说清『没记≠丢了』」）。原来那条只挑了「连着别的工程」一个上下文，
   * 而洞恰恰在它没挑的那个上下文里。
   */

  // 对上了就不该再有那一大段解释 —— 那是每轮都要付的 token
  it('会话归属的工程正连着时只确认一句', () => {
    const prompt = buildSystemPrompt({
      ...base,
      project: { name: 'MyGame' },
      sessionProject: { name: 'MyGame', connected: true }
    })

    expect(prompt).toContain('This conversation belongs to project MyGame')
    expect(prompt).not.toContain('out of scope')
  })

  // 谁都没连的时候没有「别的工程」可混淆，正常走连接引导
  it('一个工程都没连时仍然走连接引导，并带上会话归属', () => {
    const prompt = buildSystemPrompt({
      ...base,
      ueConnected: false,
      sessionProject: { name: 'test222', connected: false },
      outOfScopeProjects: []
    })

    expect(prompt).toContain('test222')
    expect(prompt).toContain('UnrealAgentLink')
  })

  it('会话没有归属工程时提示词里不多一行', () => {
    expect(buildSystemPrompt(base)).not.toContain('This conversation belongs to project')
  })

  /**
   * 运行时信封的解读规则。
   *
   * 它是**无条件**写的，而且必须是**逐字不变**的一段 —— 这是整套机制的地基：
   * 规则常驻在可缓存的固定前缀里，会变的事实在每条用户消息自己的信封里。
   * 哪天有人图省事把工程名、连接状态拼进这一段，缓存就会每轮全部失效，
   * 而没有任何测试会红。所以这里直接钉「不随运行时状态变化」。
   */
  it('信封解读规则无条件写，且不随连接状态改变一个字', () => {
    const rules = RUNTIME_ENVELOPE_RULES.join('\n')

    for (const ctx of [
      base,
      { ...base, ueConnected: false },
      { ...base, mode: 'ask' as const },
      { ...base, isSubAgent: true },
      {
        ...base,
        ueConnected: false,
        sessionProject: { name: 'test222', connected: false },
        outOfScopeProjects: ['UALinkDev55']
      }
    ]) {
      expect(buildSystemPrompt(ctx)).toContain(rules)
    }
  })

  // 规则要在环境块之前 —— 环境块是提示词的收尾，见下面那条
  it('信封规则排在环境块之前', () => {
    const prompt = buildSystemPrompt(base)

    expect(prompt.indexOf('Runtime status:')).toBeLessThan(prompt.indexOf('<environment>'))
  })

  /**
   * 闪存规则和信封规则是同一类东西：**逐字不变**的一段，属于可缓存的固定前缀。
   * 会变的事实在每条用户消息自己的 `<editor-snapshot>` 块里。
   *
   * 哪天有人图省事把工程名、选中数量拼进这一段，Prompt Cache 就会每轮全部失效，
   * 而没有任何别的测试会红 —— 所以这里钉死「不随运行时状态变化」。
   */
  it('闪存解读规则无条件写，且不随连接状态改变一个字', () => {
    const rules = EDITOR_SNAPSHOT_RULES.join('\n')

    for (const ctx of [
      base,
      { ...base, ueConnected: false },
      { ...base, mode: 'ask' as const },
      { ...base, isSubAgent: true }
    ]) {
      expect(buildSystemPrompt(ctx)).toContain(rules)
    }
  })

  it('闪存规则挨着信封规则，且都在环境块之前', () => {
    const prompt = buildSystemPrompt(base)

    expect(prompt.indexOf('Runtime status:')).toBeLessThan(prompt.indexOf('Editor snapshot:'))
    expect(prompt.indexOf('Editor snapshot:')).toBeLessThan(prompt.indexOf('<environment>'))
  })

  /**
   * 环境块必须在最后。
   *
   * pi 自己的提示词把 cwd 放结尾，理由是运行时状态离当前任务最近。
   * 更要紧的是它得在 skill 清单**之后** —— 夹在 50 条清单中间的话，
   * 模型很容易把它当成第 51 条 skill。
   */
  it('环境块排在最末尾', () => {
    const prompt = buildSystemPrompt(base)
    expect(prompt.trimEnd().endsWith('</environment>')).toBe(true)
  })

  it('子 agent 被告知无法与用户交互', () => {
    const prompt = buildSystemPrompt({ ...base, isSubAgent: true })

    expect(prompt).toContain('sub-agent')
    expect(prompt).toContain('cannot talk to the user')
  })

  it('主 agent 不带子 agent 那段', () => {
    expect(buildSystemPrompt(base)).not.toContain('cannot talk to the user')
  })

  /**
   * 准则是针对**高频且沉默**的错误写的：node_id 猜错不会报「你猜错了」，
   * 只会报一个看不出根因的连线失败。这条掉了，模型就会开始凭经验编 node_id。
   */
  it('保留 node_id 必须先查的硬约束', () => {
    const prompt = buildSystemPrompt(base)

    expect(prompt).toContain('_get_graph')
    expect(prompt).toContain('MUST')
  })

  /**
   * MCP 那一段现在按**运行时真实状态**生成（见 capabilities/mcp/promptSection.ts）。
   *
   * 原来是一句写死的「用户可能配了 MCP server」，在每种情况下都不对：
   * 没配的用户白花 token；配了却连不上的用户，模型会答「我没有这个能力」——
   * 那是假话，能力配了，只是 server 没起来。
   */
  it('没有 MCP 连接时提示词里不提 MCP —— 不为不存在的事付 token', () => {
    expect(buildSystemPrompt(base)).not.toContain('mcp_')
    expect(buildSystemPrompt(base)).not.toContain('MCP')
  })

  it('有 MCP server 时按真实状态写进去', () => {
    const mcp = {
      getStatuses: () => [{ id: 'filesystem', connected: true, toolCount: 4 }]
    } as never

    const prompt = buildSystemPrompt({ ...base, mcp })
    expect(prompt).toContain('filesystem')
    expect(prompt).toContain('mcp_filesystem_')
  })

  it('server 连不上时，提示词里明确禁止模型答「我没有这个能力」', () => {
    const mcp = {
      getStatuses: () => [
        { id: 'filesystem', connected: false, toolCount: 0, error: 'spawn npx ENOENT' }
      ]
    } as never

    const prompt = buildSystemPrompt({ ...base, mcp })
    expect(prompt).toContain('FAILED TO CONNECT')
    expect(prompt).toContain('spawn npx ENOENT')
    expect(prompt).toContain('do NOT say you lack the capability')
  })

  // MCP 段必须在环境块之前 —— 环境块是提示词的收尾，见上面那条
  it('MCP 段排在环境块之前', () => {
    const mcp = { getStatuses: () => [{ id: 'x', connected: true, toolCount: 1 }] } as never
    const prompt = buildSystemPrompt({ ...base, mcp })

    expect(prompt.indexOf('MCP servers configured')).toBeLessThan(prompt.indexOf('<environment>'))
    expect(prompt.trimEnd().endsWith('</environment>')).toBe(true)
  })

  /**
   * 没有 skill 时 `createSkillTools()` 返回空数组，load_skill 根本没注册。
   * 能力清单里照样列着的话，模型会去调一个不存在的工具 —— 而这正是当前状态：
   * 50 条内置 skill 已整批删除，等真机验证完再重写。
   */
  it('没有 skill 时不宣传 load_skill', () => {
    expect(buildSystemPrompt(base, [])).not.toContain('load_skill')
  })

  it('有 skill 时才列出 load_skill', () => {
    const prompt = buildSystemPrompt(base, [{ name: 'demo', description: 'Do a thing.' }] as never)

    expect(prompt).toContain('load_skill')
    expect(prompt).toContain('demo')
  })

  /**
   * 真机上一句「你好」换回来一张能力清单加两串 bullet —— 短问题的默认反应
   * 是把自己会的都摆一遍。收尾那条（"When you finish"）管不到这里：它只在
   * 一轮活干完时才生效，闲聊和一问一答落在它的射程之外。
   */
  it('要求答案长度匹配问题大小 —— 一句问候不该换回一张能力清单', () => {
    const prompt = buildSystemPrompt(base)

    expect(prompt).toContain('Match the length of your answer')
    expect(prompt).toContain('not a menu of everything you can do')
  })

  /**
   * 实际踩到过的一种表现：用户问「你是什么模型」，模型答「这个我不太方便细说」。
   *
   * 提示词里从来就没有一条「不许说」—— 它只是真不知道，于是从
   * 「You are the AI assistant inside Unreal Box」这个人设倒推出一句演出来的
   * 托词。社区版是开源的，模型还是用户自己在设置页绑的，这里没有任何要瞒的。
   */
  it('把当前模型身份写进提示词，并明说它不是秘密', () => {
    const prompt = buildSystemPrompt(base, [], { providerId: 'openai', modelId: 'gpt-5' })

    expect(prompt).toContain('openai/gpt-5')
    expect(prompt).toContain('not a secret')
  })

  // 无头场景（HTTP server、旧调用点）不传身份就整句不出现，而不是印 undefined
  it('没传模型身份时不印半句残缺的话', () => {
    const prompt = buildSystemPrompt(base)

    expect(prompt).not.toContain('You are running on')
    expect(prompt).not.toContain('undefined')
  })

  /**
   * 模型默认的「今天」是它的知识截止日，能差上一年。而笔记和资产库里
   * 满是「上周」「这个月」这种问法 —— 没有今天，那些问题只能算错。
   */
  it('带上今天的日期', () => {
    expect(buildSystemPrompt(base)).toMatch(/Today is \d{4}-\d{2}-\d{2}\./)
  })

  /**
   * Ask 模式下写操作工具在 resolveTools 里被过滤掉了，但从来没人告诉过模型。
   * 它会照常答应「我这就去改」，然后发现手里没有那个工具 ——
   * 最糟的一种是它干脆把步骤写出来，读起来像是已经改完了。
   */
  it('Ask 模式明说只读，且不许把没做的事说成做完了', () => {
    const prompt = buildSystemPrompt({ ...base, mode: 'ask' })

    expect(prompt).toContain('Ask mode')
    expect(prompt).toContain('read-only')
    expect(prompt).toContain('never describe a change as done')
  })

  it('Agent 模式不带 Ask 模式那段 —— 那是每轮都要付的 token', () => {
    expect(buildSystemPrompt(base)).not.toContain('Ask mode')
  })

  /**
   * 没有 shell 的机器上 `run_shell_command` 根本没注册。能力清单里原先写着
   * 「run shell commands where a shell exists」—— 一句既没给能力也没给约束的
   * 话，模型照样会开口提议跑命令。
   */
  it('有 shell 才在能力清单里提命令', () => {
    expect(buildSystemPrompt({ ...base, shellAvailable: true })).toContain('run bash commands')
    expect(buildSystemPrompt({ ...base, shellAvailable: false })).not.toContain('bash')
    // 省略等同「没有」，和 resolveTools 的判断保持一致
    expect(buildSystemPrompt(base)).not.toContain('bash')
  })
})

/**
 * shell 工具按机器能力过滤。
 *
 * 和 `ueConnected` 同一套道理：pi 的 bash 在 Windows 上要 Git Bash，
 * 装了 Git for Windows 才有。引擎开发者机器上通常有，纯蓝图工程的用户未必。
 * 没有却把工具给出去，模型会反复去试，最后把一串 shell_unavailable
 * 糊到用户脸上 —— 而用户完全不知道那是什么意思。
 */
describe('shell 工具的条件注册', () => {
  const shellNames = (tools: { name: string }[]): string[] =>
    tools.filter((t) => t.name === 'run_shell_command').map((t) => t.name)

  it('有 shell 时给出 run_shell_command', () => {
    const tools = resolveTools({ sessionId: 's', ueConnected: true, shellAvailable: true })
    expect(shellNames(tools)).toEqual(['run_shell_command'])
  })

  it('没有 shell 时整个不注册', () => {
    const tools = resolveTools({ sessionId: 's', ueConnected: true, shellAvailable: false })
    expect(shellNames(tools)).toEqual([])
  })

  // 省略时按「没有」处理 —— 宁可少给，不给一个必定失败的工具
  it('没声明时按没有处理', () => {
    const tools = resolveTools({ sessionId: 's', ueConnected: true })
    expect(shellNames(tools)).toEqual([])
  })

  // 写盘工具不依赖 shell，任何机器上都该有
  it('写文件工具不受 shell 影响', () => {
    const tools = resolveTools({ sessionId: 's', ueConnected: false, shellAvailable: false })
    const names = tools.map((t) => t.name)
    expect(names).toContain('write_local_file')
    expect(names).toContain('edit_local_file')
  })

  /**
   * 这三个动的是**用户自己的硬盘**，不是虚幻工程里能重新生成的资产。
   * 默认模式是 auto-edit，那个模式下 mutating 会静默放行 ——
   * 静默改用户源码这件事不能有。
   */
  it('写 / 改 / 跑命令都必须每次都问', () => {
    const tools = resolveTools({ sessionId: 's', ueConnected: true, shellAvailable: true })
    for (const name of ['write_local_file', 'edit_local_file', 'run_shell_command']) {
      const tool = tools.find((t) => t.name === name)
      expect(tool?.unrealBox.risk, name).toBe('destructive')
    }
  })

  // Ask 模式是「只看不动」，写盘和跑命令一个都不能留
  it('Ask 模式下写盘和跑命令全部过滤掉', () => {
    const tools = resolveTools({
      sessionId: 's',
      ueConnected: true,
      shellAvailable: true,
      mode: 'ask'
    })
    const names = tools.map((t) => t.name)
    expect(names).not.toContain('write_local_file')
    expect(names).not.toContain('edit_local_file')
    expect(names).not.toContain('run_shell_command')
    // 只读的本地工具应当保留
    expect(names).toContain('read_local_file')
    expect(names).toContain('grep_local_files')
  })
})
