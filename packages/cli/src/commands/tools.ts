/**
 * `uebox tools list / show / call`。
 *
 * ## list 只给名字和简述，show 才给完整 schema
 *
 * 清单有五十来个工具，每个的完整 JSON Schema 加起来是几万 token。列表那一步
 * 调用方要的是「有没有我想要的那个」，把 schema 全塞进去只会让它更难找。
 *
 * ## 不为没验证过的工具编示例
 *
 * `show` 回的是服务端给的真实描述和参数定义。**不根据工具名字自动生成
 * 「示例参数」** —— 那种示例看着能直接抄，但没有人验证过它能跑，
 * 抄了跑不通比没有示例更浪费时间。只有维护并验证过的快捷命令才带固定示例。
 */

import { success, type Envelope } from '../envelope.js'
import { UeboxError } from '../errors.js'
import * as runtime from '../runtime.js'
import { readToolArgs } from '../toolArgs.js'
import { requireSupported, search, supportedTools, type CatalogTool } from '../tools.js'

export interface ToolsOptions {
  configPath?: string
  timeoutSeconds?: number
  env?: NodeJS.ProcessEnv
  /** 这次允许调用会改动工程的工具 */
  allowWrite?: boolean
}

function openOptions(options: ToolsOptions): runtime.RuntimeOptions {
  return {
    ...(options.configPath ? { configPath: options.configPath } : {}),
    ...(options.timeoutSeconds ? { timeoutSeconds: options.timeoutSeconds } : {}),
    ...(options.env ? { env: options.env } : {})
  }
}

/** 描述截断到一行，给列表用。完整描述去 `show` 拿 */
function brief(tool: CatalogTool): string {
  const firstLine = tool.description.split('\n')[0]?.trim() ?? ''
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}…` : firstLine
}

export async function runToolsList(options: ToolsOptions & { search?: string }): Promise<Envelope> {
  const allowWrite = options.allowWrite === true

  const rt = await runtime.open(openOptions(options))
  try {
    const all = await runtime.catalog(rt)
    const inScope = supportedTools(all, allowWrite)
    const usable = search(inScope, options.search)
    const writable = all.filter((tool) => tool.write)

    return success({
      data: {
        tools: usable.map((tool) => ({
          name: tool.name,
          brief: brief(tool),
          namespace: tool.meta.namespace,
          risk: tool.meta.risk,
          projectScoped: tool.meta.projectScoped,
          // 调用方要能分辨哪些会改东西。写工具一律要 --allow-write
          mutatesProject: tool.write
        })),
        returnedCount: usable.length,
        // 服务端开放的总数，和 CLI 能调的那部分不是一回事 —— 说清楚，
        // 免得用户以为盒子里只有这几个工具
        exposedByHost: all.length,
        // 「够不着」和「这次没开」是两回事，分开报：前者没有下一步，
        // 后者加一个开关就有。混在一个数字里，调用方读不出该干什么
        outOfScope: all.filter((tool) => !tool.readOnly && !tool.write).length,
        writeToolCount: writable.length
      },
      warnings: [
        ...(usable.length === 0 && options.search
          ? [`没有匹配「${options.search}」的工具。去掉 --search 看完整清单。`]
          : []),
        /*
         * 不说的话，用户会以为盒子只开了只读工具，而实际上是 CLI 这头没开。
         *
         * 只报个数不再逐个列名：放开范围之后写工具是几十个量级，列出来会把
         * 这条提示变成一屏刷不完的噪音，而调用方真要看清单，加上开关重跑一次
         * 就有 —— 那才是它下一步该做的事。
         */
        ...(!allowWrite && writable.length > 0
          ? [
              `另有 ${writable.length} 个会改动东西的工具没有列出来。` +
                '加 --allow-write 才会列出并允许调用。'
            ]
          : [])
      ]
    })
  } finally {
    await rt.close()
  }
}

export async function runToolsShow(options: ToolsOptions & { name: string }): Promise<Envelope> {
  const rt = await runtime.open(openOptions(options))
  try {
    const all = await runtime.catalog(rt)
    /*
     * 看参数定义不需要 `--allow-write`。
     *
     * 这里原来跟着 call 一起判开关，于是「我想知道这个工具怎么调」也会被
     * 一句「这条命令没有开写操作」挡回去 —— 而调用方正是要先看懂 schema
     * 才拼得出那条带开关的命令。放开范围之后这道坎会落在几十个工具上，
     * 等于把发现能力一起关掉了。真正会改东西的是 call，开关留在那一步。
     */
    const tool = requireSupported(all, options.name, true)

    return success({
      data: {
        name: tool.name,
        // 原文照给，不做翻译 —— 这些描述是给模型看的，转述一手只会丢信息
        description: tool.description,
        inputSchema: tool.inputSchema,
        namespace: tool.meta.namespace,
        risk: tool.meta.risk,
        projectScoped: tool.meta.projectScoped,
        requiresAllowWrite: tool.write,
        ...(tool.meta.projectScoped
          ? { projectRequirement: '这个工具要操作具体的 UE 工程，调用时需要能定下目标工程。' }
          : {})
      },
      warnings: tool.write ? ['这个工具会改动东西，调用时要加 --allow-write。'] : []
    })
  } finally {
    await rt.close()
  }
}

export async function runToolsCall(
  options: ToolsOptions & {
    name: string
    args?: string
    argsFile?: string
    project?: string
  }
): Promise<Envelope> {
  // 参数在连接之前就解析好：写错 JSON 不该先去打扰盒子
  const args = await readToolArgs({
    ...(options.args !== undefined ? { args: options.args } : {}),
    ...(options.argsFile !== undefined ? { argsFile: options.argsFile } : {})
  })

  const rt = await runtime.open(openOptions(options))
  try {
    const all = await runtime.catalog(rt)
    const tool = requireSupported(all, options.name, options.allowWrite === true)

    // 与工程无关的工具不强绑目标（§5）—— 强绑会让它们在引擎没连上时也失败，
    // 而那正是最需要它们的时候
    const project = tool.meta.projectScoped
      ? await runtime.targetProject(rt, options.project)
      : null

    /*
     * `tools call` 一律原样转发，不再按工具名分流到 `runWrite`。
     *
     * ## 为什么把那条分流去掉了
     *
     * `runWrite` 那一层会**收窄参数**：`ue_set_transform` 只放行绝对 `set`，
     * `ue_destroy_actor` 只放行单个具名目标。在准入表时代这是准入条件本身 ——
     * 不收窄就没有确定的回读判据，那个工具根本进不了 CLI。
     *
     * 门拆了之后，同一段代码的效果就反过来了：它会让 `tools call` 比盒子自己的
     * agent **更窄**，`--operation add` 这类完全正常的调用被 CLI 挡在半路，
     * 而挡它的理由（CLI 写不出回读判据）是 CLI 的局限，不是用户的问题。
     *
     * 所以按入口分工：`tools call` 是对等入口，转发什么就发什么，核实由工具
     * 自己的返回值负责（这个仓库的硬规矩：工具不回读就不许报 success）；
     * `uebox actors spawn/move/delete` 和 `actors undo` 保留加强档 ——
     * 那几条命令的参数形状是 CLI 自己定的，写得出外部判据。
     *
     * ## 超时
     *
     * 加强档能给出一条能直接敲的回读命令（§12.4）。这里给不出那么具体的一句 ——
     * CLI 不知道「这次动的是哪个东西」，那是工具自己的语义。所以只说清楚两件事：
     * **别直接重发**，以及**该去问谁**。编一句「查到 = 已生效」比不给更坏。
     */
    let result: runtime.ToolCallResult
    try {
      result = await runtime.callTool(rt, tool.name, args, project?.path)
    } catch (error) {
      throw error instanceof UeboxError && error.code === 'TIMEOUT' && tool.write
        ? new UeboxError(
            'TIMEOUT',
            `${tool.name} 的执行结局不明（请求已发出，未收到结果）。`,
            '不要直接重发 —— 先用只读工具查一遍它到底做了没有' +
              '（工程里的资产用 ue_content_search，工程库用 project_list，' +
              '关卡里的对象用 uebox actors list）。确认没做才重发。',
            'unknown'
          )
        : error
    }

    return success({
      ...(project ? { project: { name: project.name, path: project.path } } : {}),
      data: {
        // 有公共 serializer 就给结构化的，没有就是 null 并保留原文（§6.3）。
        // 不把中文摘要硬拆成业务字段。
        structured: result.structuredContent ?? null,
        content: result.content ?? []
      }
    })
  } finally {
    await rt.close()
  }
}
