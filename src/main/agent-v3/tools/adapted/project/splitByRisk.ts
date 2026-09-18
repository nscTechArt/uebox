/**
 * 把 `project_manage` 按风险拆成两个工具。
 *
 * ## 为什么要拆
 *
 * 这个工具后面挂着七个动作，风险差了两个量级：`list_templates` 只是读一份
 * 内置模板清单，`import_assets_to_scene` 会往用户的关卡里放 Actor，
 * `setup_level_sequence` 会建定序器并绑动画。
 *
 * 注册表按**工具**声明 risk，没法按动作细分。整个标 `mutating` 的话，
 * 默认的 `auto-edit` 模式会静默放行 —— 用户一句话就可能被改了关卡；
 * 整个标 `destructive` 的话，连"列一下有哪些模板"都要弹窗确认，
 * 用户很快就会养成无脑点确认的习惯，那比不弹更危险。
 *
 * 所以按动作切成两个工具，各自带正确的 risk。
 *
 * ## 为什么不是重写
 *
 * 底下那 1700 行（依赖解析、包文件搬运、定序器绑定）是能用的，
 * 真机验证过：从素材库导一个 .uasset 进工程，文件落到
 * `Content/UAImported/`，引擎的资产注册表也认。重写没有意义，
 * 这里只做入口的收窄。
 */

import { z } from 'zod'

import type { V2Tool } from '../../adaptV2Tool'

import { createProjectTool } from './projectTool'

/** 只读动作：不碰用户的工程和磁盘 */
export const READ_ACTIONS = ['list_templates', 'list_projects'] as const

/** 写动作：建工程、开工程、往工程里导资产、往关卡里放东西 */
export const WRITE_ACTIONS = [
  'create_project',
  'open_project',
  'import_assets',
  'import_assets_to_scene',
  'setup_level_sequence'
] as const

type AnyTool = V2Tool & {
  description?: string
  inputSchema?: unknown
  execute?: (args: Record<string, unknown>, ctx?: unknown) => Promise<unknown>
}

/**
 * 造一个只接受指定动作的壳。
 *
 * execute 入口的拦截**必须保留**：schema 只是给模型看的建议，厂商不保证
 * 传回来的 action 一定在枚举里，而底层实现按 action 分支，漏进去的会走到
 * default 拿一个 "unknown action"。这里明确挡掉并告诉调用方该用哪个工具。
 *
 * `inputSchema` 可以另给一份更窄的。原先两个工具都直接继承底层那一份七动作
 * 的完整 schema —— 只读的 `project_list` 因此背着 create/import/sequencer
 * 的全部参数，实测约 1,200 token，而它一个都用不上。schema 常驻系统提示，
 * 每一轮对话都付一次这个钱。不给就沿用底层那份（写工具确实要全部字段）。
 *
 * **这是故意窄，不是「工具比后端窄」那类漏口。** 对表审计看到 `project_list`
 * 的 action 枚举只有两个、而底层 `createProjectTool` 有七个时，不要当成回退：
 * 另外五个原样挂在 `project_manage` 上，两个工具的并集就是后端的全集，
 * 模型的能力一分没少。窄掉的那五个在这里本来就调不通（下面的 execute 会拒）。
 */
function restrictTo(
  actions: readonly string[],
  name: string,
  description: string,
  inputSchema?: unknown
): V2Tool {
  const inner = createProjectTool() as AnyTool
  const allowed = new Set<string>(actions)
  const sibling = name === 'project_list' ? 'project_manage' : 'project_list'

  return {
    ...inner,
    name,
    description,
    ...(inputSchema ? { inputSchema } : {}),
    execute: async (args: Record<string, unknown>, ctx?: unknown) => {
      const action = String(args?.action ?? '')
      if (!allowed.has(action)) {
        return {
          success: false,
          error:
            `${name} 不支持 action="${action}"。这个工具只能做：${[...allowed].join('、')}。` +
            `其余动作请用 ${sibling}。`
        }
      }
      return inner.execute!(args, ctx)
    }
  } as unknown as V2Tool
}

/** 只读：列模板、列项目 */
export function createProjectListTool(): V2Tool {
  return restrictTo(
    READ_ACTIONS,
    'project_list',
    `查看可用的工程模板和已有的工程（只读）。

【action 取值】
- list_templates：列出内置工程模板
- list_projects：列出盒子里已登记的工程，每个带 engineVersion、collection（所在合集）
  和 pinned（是否置顶），另附 collections 合集清单

创建工程、导入资产、建定序器请用 project_manage；
分组、置顶、改合集名字用 project_organize。`,
    // 两个动作都不吃参数，所以 schema 里就只有 action 一个字段
    z.object({
      action: z.enum(READ_ACTIONS).describe('【必填】list_templates 列模板，list_projects 列工程')
    })
  )
}

/**
 * 写工具的 action 枚举也要收窄。
 *
 * 拆分原来只做了一半：`project_list` 换了一份窄 schema，而 `project_manage`
 * 沿用底层那份七动作的，于是**枚举里还露着 `list_templates` / `list_projects`**，
 * 而描述里又只讲了五个写动作。2026-09-11 盒子自己的 agent 报的就是这个：
 * 「描述偏偏没列这两个，于是我不知道那两个 action 是不是真能用，还是历史遗留的名字」
 * —— 它只能挑一个先试。
 *
 * 运行时一直是拒绝的（`restrictTo` 的 execute），所以这不是能力问题，是**声明在骗人**：
 * 模型照着枚举调一次，换回一句「不支持」。更坏的是它可能因此以为「列工程」
 * 该走这个 destructive 工具，于是一次只读操作平白弹一次审批框。
 *
 * 只覆盖 `action` 一个字段，其余照旧 —— 写动作确实要底层那份完整参数。
 */
function withWriteActionsOnly(inner: AnyTool): unknown {
  const schema = inner.inputSchema as { extend?: (shape: Record<string, unknown>) => unknown }
  // 底层不是 ZodObject（将来换写法）时原样返回，宁可枚举宽一点也不要在这里抛
  if (typeof schema?.extend !== 'function') return undefined
  return schema.extend({
    action: z
      .enum(WRITE_ACTIONS)
      .describe(
        '【必填】create_project 建工程 / open_project 开工程 / import_assets 导资产 / ' +
          'import_assets_to_scene 导入并放进关卡 / setup_level_sequence 建定序器。' +
          '列模板、列工程用 project_list'
      )
  })
}

/** 写：建/开工程、导资产、建定序器 */
export function createProjectWriteTool(): V2Tool {
  return restrictTo(
    WRITE_ACTIONS,
    'project_manage',
    `创建工程、打开工程，或把**素材库里的资产**导入当前虚幻工程。

【action 取值】
- create_project：按模板建新工程（需要 templateName、projectName、targetDir）
- open_project：打开一个已有工程（给 projectKey，或直接给 projectPath）
- import_assets：把素材库资产导入工程（需要 assetKeys，来自 search_assets 的结果）
- import_assets_to_scene：导入并直接放进当前关卡
- setup_level_sequence：建定序器，可选绑定角色和动画

【导 .uasset 不用先开工程】import_assets 对 .uasset/.umap 是把文件拷进
<工程>/Content/ 并解析依赖，不经过引擎。用 projectKey（project_list 的
list_projects 里查）或 projectPath 点名工程就能导，别为此先 open_project 白等一趟
编辑器启动。要工程开着的只有两件事：外部文件（FBX/PNG/OBJ…）必须过引擎的导入
API，以及 import_assets_to_scene 往关卡里放 Actor。

【打开工程不用先挑引擎】open_project 就是把 .uproject 交给系统打开，
用哪个引擎由 Windows 按工程里的 EngineAssociation 自己定 —— 这里没有引擎参数，
你也决定不了。所以别在打开之前先去 list_engines 盘点一遍引擎，那一步既慢又
改变不了结果。插件同理：盒子会在打开前把 UnrealAgentLink 装进「工程/Plugins」
并在 .uproject 里启用，不需要你先去查引擎里装没装。

【打开默认立即返回】open_project 默认 waitSeconds=0，启动后返回正在加载，
connected=false 不是打开失败，不要重复启动。用 ue_session_health 查询连接列表，
按目标工程路径确认已经连上后，再对同一工程调用 open_project、waitSeconds: 5，
校验就绪并把**这一轮剩下的引擎命令**改发给它；已连接工程不会重复启动。
显式等待必须短于 MCP 调用方超时，加载期间分次查询，不要一次挂几分钟。
【打开之后不用请用户帮忙切工程】只有返回 connected=true 才表示只读命令验证通过；
switched_target=true 表示本轮目标已切换。两者都确认后直接接着干。
不要说「请你在界面上把当前工程切过去」，也不要说「请再发一条消息我下轮再来」：
那两句话在这里都是错的，盒子已经替用户做完了。
唯一切不过去的情况是这条会话被用户归到了另一个工程下，那时 details 里会写清楚，
照实转告即可。

【open_project 不改这条对话的归属】它动的是**这一轮引擎命令发给谁**，
不动侧边栏里这条对话挂在哪个工程下。两者通常一致，所以多数时候开完就能接着干。
只有在「这条对话被归到了别的工程」时才会撞上 session-scoped 的拒绝 ——
那时候才需要 set_session_project，而且那是用户的组织方式，换之前要有依据。

【assetKeys 从哪来】先用 search_assets 找到资产，结果里的 assetKey 就是。
猜不出来，也不能用资产名代替。

【导入不是复制到任意位置】资产按它在素材库里记录的 softPath 落到工程的
对应目录。导入后用 ue_content_search 确认一下再向用户汇报。

【注意】.uasset 文件里存着资产自己的名字。用不同的文件名导入时，
引擎里显示的仍是包内原名 —— 别因为名字对不上就以为导错了。

先看有哪些模板/工程请用 project_list。`,
    withWriteActionsOnly(createProjectTool() as AnyTool)
  )
}
