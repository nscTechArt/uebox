/**
 * `uebox actors list` —— 关卡里有哪些 Actor。
 *
 * ## 数量绝不能误报
 *
 * 这条命令最容易出的事故不是查不到，是**查到了但少报**：有 137 个匹配项、
 * 返回了前 50 个，调用方读成「场景里一共 50 个」，然后据此下结论。
 *
 * 所以三个数一起给：`returnedCount`（这次给了几个）、`totalCount`（一共几个）、
 * `truncated`（是不是被截断了）。总数不知道时 `totalCount` 是 null，
 * `truncated` 也是 null —— 不知道总数就不知道有没有截断，猜一个 false
 * 等于替引擎编事实。截断时还会另外给一条警告。
 *
 * ## 不换算单位
 *
 * 位置厘米、旋转度、缩放倍数，原样给，另附 `units` 说明。裸数字 `-19.5`
 * 按米读、按厘米读都成立，而替调用方换算是那类「数据全程自洽、场景全程
 * 是错的」事故的源头。
 */

import { success, type Envelope } from '../envelope.js'
import { UeboxError } from '../errors.js'
import * as runtime from '../runtime.js'

const TOOL = 'ue_get_actor'

/** 和工具自己的默认值一致（见 `adapted/ue-actor/getActor.ts` 的 schema） */
export const DEFAULT_LIMIT = 50

export interface ActorsOptions {
  configPath?: string
  timeoutSeconds?: number
  project?: string
  name?: string
  limit?: number
  /** 把引擎自己的记账 Actor 也算进来（HLOD、导航网格、物理体积那些） */
  includeSystem?: boolean
  env?: NodeJS.ProcessEnv
}

export async function runActorsList(options: ActorsOptions): Promise<Envelope> {
  const rt = await runtime.open({
    ...(options.configPath ? { configPath: options.configPath } : {}),
    ...(options.timeoutSeconds ? { timeoutSeconds: options.timeoutSeconds } : {}),
    ...(options.env ? { env: options.env } : {})
  })

  try {
    const catalog = await runtime.catalog(rt)
    if (!catalog.some((item) => item.name === TOOL)) {
      throw new UeboxError(
        'TOOL_UNAVAILABLE',
        `虚幻盒子没有开放 ${TOOL}，无法查询 Actor。`,
        '在盒子的 MCP 设置里确认暴露范围没有被命名空间白名单收得太窄。'
      )
    }

    const project = await runtime.targetProject(rt, options.project)
    const limit = options.limit ?? DEFAULT_LIMIT

    let result: runtime.ToolCallResult
    try {
      result = await queryActors(rt, options, project.path, limit)
    } catch (error) {
      // 「没查到」是空结果，不是失败 —— §6.2 写死了「查询结果为空也算成功」。
      // 真机上插件对不存在的名字回 RPC 404，原来这里会变成退出码 8，
      // 于是「这个 Actor 在不在」这种最常见的检查一律报错
      if (error instanceof UeboxError && error.code === 'ENGINE_NOT_FOUND') {
        return success({
          project: { name: project.name, path: project.path },
          data: {
            actors: [],
            returnedCount: 0,
            totalCount: 0,
            truncated: false,
            systemActorsExcluded: null,
            units: { location: 'cm', rotation: 'deg', scale: 'multiplier', bounds: 'cm' },
            message: null,
            limit,
            includesSystemActors: options.includeSystem === true,
            ...(options.name ? { nameFilter: options.name } : {})
          },
          warnings: options.name ? [`关卡里没有叫「${options.name}」的 Actor。`] : []
        })
      }
      throw error
    }

    const data = result.structuredContent
    if (!data) {
      throw new UeboxError(
        'INCOMPATIBLE_SERVER',
        '虚幻盒子没有返回结构化的 Actor 列表。',
        '升级虚幻盒子 —— 旧版本只把结果写在一段文字里，没法当接口用。'
      )
    }

    return success({
      project: { name: project.name, path: project.path },
      data: {
        ...data,
        limit,
        includesSystemActors: options.includeSystem === true,
        ...(options.name ? { nameFilter: options.name } : {})
      },
      warnings: [...describeTruncation(data, limit), ...describeSystemExclusion(data)]
    })
  } finally {
    await rt.close()
  }
}

function queryActors(
  rt: runtime.Runtime,
  options: ActorsOptions,
  projectPath: string,
  limit: number
): Promise<runtime.ToolCallResult> {
  return runtime.callTool(
    rt,
    TOOL,
    {
      // 给了名字就点名查（精准匹配 Name 或 Label），没给就扫整个关卡。
      //
      // `filter: {}` 而不是 `targets: {}`：工具那侧的 targets 是 `.strict()` 的，
      // 键名写错会被当成「没给选择条件」然后返回整个关卡 —— 显式写出扫描意图，
      // 比依赖一个空对象的默认行为可靠。
      targets: options.name ? { names: [options.name] } : { filter: {} },
      return_transform: true,
      limit,
      ...(options.includeSystem ? { include_system_actors: true } : {})
    },
    projectPath
  )
}

/**
 * 被截断时说出来。
 *
 * 只有 `truncated === true` 才报「还有更多」；`null`（总数未知）单独报，
 * 说的是「不确定有没有更多」——把这两种混成一句，等于把「不知道」讲成了
 * 一个确定的结论。
 */
/**
 * 引擎默认藏起来的那些系统 Actor，藏了多少必须说出来。
 *
 * ## 这是真机上被一个外部 Agent 逮到的
 *
 * 关卡里实际有 47 个 Actor，`actors list` 报的是 `totalCount: 42`、
 * `truncated: false`、没有任何警告 —— 而 `truncated: false` 读起来就是
 * 「就这些了」。那个 Agent 因此差点把 42 当成全部，是它自己去翻底层工具的
 * 参数才发现有 5 个被默认过滤掉了。
 *
 * 42 本身没错（它是「非系统 Actor 的准确总数」），错的是**没说这里有个过滤器**。
 * 这和「前 50 条当成全部」是同一类误报，只是更隐蔽：截断有 `truncated` 提示，
 * 过滤却什么都不说。
 */
function describeSystemExclusion(data: Record<string, unknown>): string[] {
  const excluded = typeof data.systemActorsExcluded === 'number' ? data.systemActorsExcluded : 0
  if (excluded <= 0) return []

  const total = typeof data.totalCount === 'number' ? data.totalCount : null
  const real = total !== null ? `：关卡里其实是 ${total + excluded} 个` : ''

  return [
    `另有 ${excluded} 个引擎自己的记账 Actor（HLOD、导航网格、物理体积这类）被默认过滤掉了${real}。` +
      '上面的计数不含它们。要把它们也算进来，加 --include-system。'
  ]
}

function describeTruncation(data: Record<string, unknown>, limit: number): string[] {
  const returned = typeof data.returnedCount === 'number' ? data.returnedCount : null
  const total = typeof data.totalCount === 'number' ? data.totalCount : null

  if (data.truncated === true && total !== null && returned !== null) {
    return [
      `一共匹配到 ${total} 个 Actor，这里只给了前 ${returned} 个。` +
        `不要把它当成全部 —— 用 --limit 调大（上限 1000），或者用 --name 缩小范围。`
    ]
  }

  if (total === null && returned !== null && returned >= limit) {
    return [
      `返回了 ${returned} 个，正好等于 --limit。当前插件版本没有报告匹配总数，` +
        `所以无法确认这是不是全部 —— 调大 --limit 再跑一次可以看出来。`
    ]
  }

  return []
}
