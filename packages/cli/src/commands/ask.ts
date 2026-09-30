/**
 * `uebox ask "<一句话>"` —— 把一件事交给盒子自己的 Agent，拿回结论。
 *
 * `tools call` 交出去的是零件，调用方得自己知道先调哪个、再调哪个；这一条交出去
 * 的是整个大脑，给脚本、CI、批处理用（Claude Code 的 `claude -p` 是同一个思路）。
 * 背后调的是盒子的 `task` 工具，不带历史对话（`context_mode: fresh`）。
 *
 * ## 权限：白名单，不是全开全关
 *
 * 外部会话里，子任务的每一步都是自动批准的（见主仓库 `hostSession.ts`：客户端
 * 批准了派任务，就等于批准了子任务要做的事）。CLI 没有审批界面，所以这里必须
 * 自己把范围收住：
 *
 *   - 默认只读（`read_only: true`）：写工具根本不进子任务的清单。
 *   - `--allow-write` 才放开改动，而且只放开**引擎、素材库、工程库**这几摊。
 *     shell、本地文件、浏览器、第三方 MCP、盒子自身的管理一律不给 ——
 *     没人盯着的时候，这些出了错没有回头路。
 *
 * 命名空间从这次的工具清单里现算，不在 CLI 里抄一份：盒子加了新的 `ue.*`
 * 分组，这里自动跟上；抄一份的话，漏掉的那组就成了子任务莫名其妙做不到的事。
 */

import { success, type Envelope } from '../envelope.js'
import { UeboxError } from '../errors.js'
import { resolveProject, type ResolvedProject } from '../project.js'
import * as runtime from '../runtime.js'
import { DELEGATE_TOOL, type CatalogTool } from '../tools.js'

export interface AskOptions {
  prompt: string
  allowWrite: boolean
  project?: string
  configPath?: string
  timeoutSeconds?: number
  env?: NodeJS.ProcessEnv
  /** 子任务汇报进度时调。命令本身只在最后交一个结果，进度靠它实时往外送 */
  onProgress?: (message: string) => void
}

/** 引擎之外、子任务也能碰的几摊：素材库、工程库、蓝图/材质库，以及技能加载 */
const EXTRA_NAMESPACES = new Set(['asset', 'project', 'library', 'core'])

/** 这次子任务能用哪些命名空间 */
export function delegateNamespaces(catalog: CatalogTool[]): string[] {
  const namespaces = new Set<string>()
  for (const tool of catalog) {
    const ns = tool.meta.namespace
    if (ns.startsWith('ue.') || EXTRA_NAMESPACES.has(ns)) namespaces.add(ns)
  }
  return [...namespaces].sort()
}

export async function runAsk(options: AskOptions): Promise<Envelope> {
  const prompt = options.prompt.trim()
  if (!prompt) {
    throw new UeboxError(
      'INVALID_ARGUMENT',
      'ask 需要一句话说明要做什么。',
      '例如：uebox ask "列出当前关卡里所有点光源"'
    )
  }

  const rt = await runtime.open({
    ...(options.configPath ? { configPath: options.configPath } : {}),
    ...(options.timeoutSeconds ? { timeoutSeconds: options.timeoutSeconds } : {}),
    ...(options.env ? { env: options.env } : {})
  })

  try {
    const catalog = await runtime.catalog(rt)
    if (!catalog.some((tool) => tool.name === DELEGATE_TOOL)) {
      throw new UeboxError(
        'TOOL_UNAVAILABLE',
        `虚幻盒子没有开放 ${DELEGATE_TOOL}，ask 用不了。`,
        '在虚幻盒子的 MCP 设置里确认暴露范围没有把 core 命名空间收掉。'
      )
    }

    const project = await pickProject(rt, options.project)
    const namespaces = delegateNamespaces(catalog)

    const result = await runtime.callTool(
      rt,
      DELEGATE_TOOL,
      {
        prompt,
        context_mode: 'fresh',
        namespaces,
        ...(options.allowWrite ? {} : { read_only: true })
      },
      project?.path,
      { onProgress: options.onProgress ?? ((): void => undefined) }
    )

    return success({
      ...(project ? { project: { name: project.name, path: project.path } } : {}),
      data: {
        answer: runtime.textOf(result),
        readOnly: !options.allowWrite
      },
      warnings: project
        ? []
        : ['当前没有 UE 工程连着，子任务只能用素材库和工程库，碰不到引擎。']
    })
  } finally {
    await rt.close()
  }
}

/**
 * 目标工程。
 *
 * 和别的命令一样的规则，只多一条：一个工程都没连着、也没点名的时候不报错 ——
 * 「在素材库里找几张砖墙贴图」这种事本来就不需要引擎。
 */
async function pickProject(
  rt: runtime.Runtime,
  explicit: string | undefined
): Promise<ResolvedProject | undefined> {
  const registered = await runtime.registeredProjects(rt)
  if (registered.length === 0 && !explicit) return undefined
  return resolveProject(explicit, registered)
}
