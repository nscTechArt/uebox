/**
 * V2 工具 → V3 工具的适配器。
 *
 * ## 为什么用适配而不是逐个重写
 *
 * V2 的 182 个工具已经是 `tool({ description, inputSchema, execute })`
 * （AI SDK 形态），三个字段全都可内省。写一层适配就能**一次性迁移全部**，
 * 而逐个重写 172 个工具意味着 172 次手抄 Zod schema —— 每一次都是一个
 * schema 漂移的机会，而漂移的表现是运行时参数不匹配，测试很难覆盖。
 *
 * 业务逻辑、schema、descriptions 全部逐字保留。
 *
 * ## 代价
 *
 * 适配来的工具拿不到 V3 的三项增量能力：`report()` 流式进度、`images`
 * 原生进上下文、以及工具自己声明的并发语义。需要这些的工具（如视口截图、
 * 批量导入）单独用 `defineTool` / `defineUeTool` 重写 —— 材质工具集就是
 * 这么做的。**适配是保底，重写是升级**，两者共存。
 *
 * ## 失败语义
 *
 * V2 工具的约定是 `return { success: false, error }`，而 pi 判定失败的
 * 唯一依据是 execute 抛异常（agent-loop.js 成功路径里 isError 硬编码为
 * false）。不转换的话，**工具失败会被当成功报给模型**。这里负责翻译。
 */

import type { AgentToolResult } from '@earendil-works/pi-agent-core'

import {
  EngineNotFoundError,
  EngineTimeoutError,
  RPC_NOT_FOUND,
  V2_TIMEOUT_CODE
} from './engineErrors'
import type { TSchema } from 'typebox'
import type { z } from 'zod'

import { runAbortable } from './abortable'
import { admitImageForContext } from './contextImage'
import { toToolSchema, type ToolRisk, type UnrealAgentTool } from './defineTool'

/**
 * V2 工具对象的可内省形状。
 *
 * `inputSchema` 声明成 unknown 而不是 `z.ZodTypeAny`：历史上这里接的是 AI SDK 的
 * `Tool.inputSchema`，那个类型是 `FlexibleSchema<T>`（Zod 或它自己的 Schema 包装），
 * 静态上和 ZodType 不兼容。存量工具运行时传的都是 Zod 对象，所以在 `adaptV2Tool`
 * 里按 `.parse` 是不是函数做运行时窄化 —— 不是的话直接报错，而不是等到调用时才炸。
 */
export interface V2Tool {
  description?: string
  inputSchema?: unknown
  /**
   * 参数用 `any` 而不是 `unknown`：AI SDK 的 `ToolExecuteFunction<INPUT>` 是按
   * 具体输入类型定的，`(input: T) => X` 赋不给 `(input: unknown) => X`（方差不兼容）。
   * `any` 让它双变兼容 —— 这里本来就是要接受任意存量工具，具体类型由
   * 各工具自己的 Zod schema 在运行时保证。
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute?: (input: any, options: any) => unknown
}

/** 适配层传给 V2 `execute` 的第二个参数 */
export interface V2ExecuteOptions {
  /**
   * 本轮的中止信号。
   *
   * 工具**不接它也没关系** —— 适配层已经在外面和它赛跑了（见
   * `abortable.ts`），用户按停止时这次调用会当场返回。接它的收益是把活也
   * 停掉：等引擎的 RPC 可以当场作废，后面的步骤就不会再发出去。
   */
  abortSignal?: AbortSignal
}

/**
 * 写一个 V2 工具。
 *
 * 这些工具原本调的是 AI SDK 的 `tool({ description, inputSchema, execute })`。
 * 那层 SDK 在这里**只做了一件事**：从 Zod schema 把 `execute` 的参数类型推出来。
 * 别的都没用上 —— 适配器只读这三个字段，`strict` 之类的 SDK 专属选项一直是死字段。
 *
 * 所以留下那一件事，去掉那个依赖。`tool(` 改成 `defineV2Tool(`，业务逻辑一行不动。
 */
export function defineV2Tool<TSchema extends z.ZodTypeAny>(definition: {
  description: string
  inputSchema: TSchema
  /**
   * 参数类型从 schema 推出来。
   *
   * 第二个参数是可选的：不写就是存量工具的样子（适配层传什么它都不看），
   * 写了就能拿到本轮的中止信号，把等引擎那一步也停掉。
   */
  execute: (input: z.output<TSchema>, options: V2ExecuteOptions) => unknown
}): V2Tool {
  return definition as V2Tool
}

function asZodSchema(schema: unknown, toolName: string): z.ZodTypeAny {
  const candidate = schema as { parse?: unknown }
  if (typeof candidate?.parse !== 'function') {
    throw new Error(
      `适配 ${toolName} 失败：inputSchema 不是 Zod schema（拿到 ${typeof schema}）。` +
        'AI SDK 允许非 Zod 的 schema，但适配层依赖 Zod 的 parse 来应用 default/transform。'
    )
  }
  return schema as z.ZodTypeAny
}

export interface AdaptOptions {
  /** V3 里的工具名。V2 的注册名散落在各 specialist 里，这里显式指定 */
  name: string
  namespace: string
  risk: ToolRisk
  /** 覆盖 V2 的描述。留空则沿用 */
  description?: string
  concurrency?: 'sequential' | 'parallel'
  /** 见 `ToolSpec.requiresExplicitApproval`：每次都问，不给「总是允许」 */
  requiresExplicitApproval?: boolean
}

/**
 * V2 工具返回值里表示失败的几种形状。
 *
 * 历史上不统一：有的用 `success`，有的用 `ok`，有的两个都给。
 */
interface V2Result {
  success?: boolean
  ok?: boolean
  error?: string
  message?: string
  code?: string | number
  details?: unknown
  /**
   * 结构化诊断。蓝图/材质编译失败时引擎逐条给出「哪个节点、哪个引脚、什么错」，
   * 是模型自己修图的唯一依据 —— 不并进错误正文就等于没给。
   */
  diagnostics?: unknown
  /** V2 用来给模型下一步提示的字段。V3 里并进正文 */
  nextStepHint?: string
  /** V2 塞给模型的指令，如「请调用 done 工具」。V3 没有 done 工具，要剔掉 */
  _aiInstruction?: string
  /** base64 图片。只走图片块，见 `stripImages` */
  images?: unknown
}

/** 判断 V2 的返回值是不是一次失败 */
export function isV2Failure(result: unknown): boolean {
  if (result === null || result === undefined) return true
  if (typeof result !== 'object') return false
  const r = result as V2Result
  return r.success === false || r.ok === false
}

/**
 * 从失败的 V2 返回值里拼出给模型看的完整错误信息。
 *
 * ## 为什么要带上 `diagnostics`
 *
 * 真机验证时发现的：蓝图编译失败，引擎侧其实把每条错误连同 node_id 和 pin
 * 一起返回了（插件源码里那段的注释就写着「用于 Agent 自修复」），
 * 工具也原样放进了返回值的 `diagnostics` 字段 —— 然后**在这里丢掉**。
 *
 * 模型收到的只有一句 `Failed to compile Blueprint: No response or ok=false`，
 * 既不知道哪个节点错了，也不知道错在什么地方，除了原样重试没有别的路可走，
 * 重试两次就撞上熔断。整条「连线 → 编译 → 修错」的闭环断在这一行上。
 *
 * 只取前若干条：一个连错的图可能刷出几十条同源报错，全塞进去会挤爆上下文，
 * 而模型修完第一条重编译就会拿到新的清单。
 */
const MAX_DIAGNOSTICS = 10

export function describeV2Failure(result: unknown, toolName: string): string {
  if (result === null || result === undefined) return `${toolName} 没有返回任何结果`
  const r = result as V2Result
  const reason = r.error || r.message || '未提供失败原因'
  return [
    `${toolName} 失败：${reason}`,
    r.code !== undefined ? `（错误码 ${r.code}）` : '',
    formatDiagnostics(r.diagnostics),
    r.details ? `\n详情：${JSON.stringify(r.details)}` : '',
    r.nextStepHint ? `\n${r.nextStepHint}` : ''
  ].join('')
}

/** 把 diagnostics 拍成模型能直接照着改的几行，而不是一坨 JSON */
function formatDiagnostics(diagnostics: unknown): string {
  if (!Array.isArray(diagnostics) || diagnostics.length === 0) return ''

  const lines = diagnostics.slice(0, MAX_DIAGNOSTICS).map((entry) => {
    const d = entry as { type?: string; message?: string; node_id?: string; pin?: string }
    const where = [d.node_id ? `node ${d.node_id}` : '', d.pin ? `pin ${d.pin}` : '']
      .filter(Boolean)
      .join(' / ')
    return `  - [${d.type ?? 'Error'}] ${d.message ?? JSON.stringify(entry)}${where ? `（${where}）` : ''}`
  })

  const omitted = diagnostics.length - lines.length
  return `\n诊断：\n${lines.join('\n')}${omitted > 0 ? `\n  …另有 ${omitted} 条` : ''}`
}

/**
 * 把返回值里的 `images` 摘出去。它只该走图片块，不该出现在文本和 details 里。
 *
 * 留着有两处代价，都不小：
 *
 * - **模型要为同一张图付两遍钱。** `toText` 把整个返回值 `JSON.stringify`
 *   进文本块，一张压到 180KB 的截图转成 base64 有 24 万个字符 —— 截图工具那边
 *   千辛万苦把图压到 768px 就是为了省这笔 token（见 screenshot.ts 的说明：
 *   第一版没压，两张图就把上下文冲到 123 万撞爆窗口），结果原图的等价体积
 *   又从文本这条道上流回去了，而且流回去的是模型根本读不懂的 base64 字符串。
 * - **撑爆 localStorage。** `details` 原样发给渲染层，最终随聊天记录写进
 *   localStorage（配额只有几 MB）。来回预览十几次就能撑满，之后聊天记录
 *   静默地再也存不进去。
 *
 * 图片本身仍由 `extractImages` 送进模型上下文；界面用返回值里的本地路径
 * 直接读盘显示，比压缩版更清楚，也不占存储。
 */
function stripImages(result: unknown): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result
  if (!('images' in result)) return result

  const rest = { ...(result as Record<string, unknown>) }
  delete rest.images
  return rest
}

/**
 * 把 V2 的成功返回值转成给模型的文本。
 *
 * 剔掉 `_aiInstruction` —— 那是 V2 用来驱动 Router 的（「请调用 done 工具」），
 * V3 没有 done 工具，留着只会让模型去找一个不存在的工具。
 */
function toText(result: unknown): string {
  if (typeof result === 'string') return result
  if (result === null || result === undefined) return '(无返回值)'
  if (typeof result !== 'object') return String(result)

  const rest = { ...(stripImages(result) as V2Result) }
  delete rest._aiInstruction
  return JSON.stringify(rest)
}

/**
 * 把 V2 返回值里的图片接进模型上下文。
 *
 * 适配层原本只映射 text + details，图片一律丢掉 —— 而 `ue_screenshot` 和
 * `widget_preview` 这两个工具**存在的全部意义就是给模型看一眼**。
 * 真机验证时 widget_preview 确实渲染出了正确的血条图，但模型只拿到一个
 * 本地文件路径，它打不开，等于白渲染。
 *
 * 约定：V2 工具在返回值里放 `images: [{ data, mimeType }]`（data 为 base64），
 * 这里转成 pi 的图片块。pi 原生支持图片进上下文，不需要先传到别处换 URL。
 */
async function extractImages(
  result: unknown
): Promise<
  Array<{ type: 'image'; data: string; mimeType: string } | { type: 'text'; text: string }>
> {
  const images = (result as { images?: unknown })?.images
  if (!Array.isArray(images)) return []

  const candidates = images.filter((img): img is { data: string; mimeType?: string } => {
    const i = img as { data?: unknown }
    return typeof i?.data === 'string' && i.data.length > 0
  })

  // 每一张都过关口。V2 工具那边没有统一的压缩约定，这里不拦的话，
  // 任何一个新适配进来的工具都能直接把上下文撑爆
  const admitted = await Promise.all(
    candidates.map((img) =>
      admitImageForContext({ data: img.data, mimeType: img.mimeType ?? 'image/png' })
    )
  )
  return admitted.flat()
}

/** 适配一个 V2 工具 */
export function adaptV2Tool(v2: V2Tool, options: AdaptOptions): UnrealAgentTool<unknown> {
  if (!v2.inputSchema || !v2.execute) {
    throw new Error(`适配 ${options.name} 失败：V2 工具缺少 inputSchema 或 execute`)
  }

  const schema = asZodSchema(v2.inputSchema, options.name)
  const execute = v2.execute

  const tool = {
    name: options.name,
    description: options.description ?? v2.description ?? options.name,
    parameters: toToolSchema(schema) as TSchema,
    executionMode: options.concurrency ?? 'parallel',
    execute: async (
      _toolCallId: string,
      params: unknown,
      signal?: AbortSignal
    ): Promise<AgentToolResult<unknown>> => {
      // pi 已按 JSON Schema 校验过；这里过 Zod 是为了拿到 default/transform 的结果，
      // V2 的 execute 依赖那些默认值。
      const parsed = schema.parse(params)

      // 中止信号有两条路，都要走：
      //
      //   1. 递给 V2 的 execute —— 肯接的工具能把活也停了（作废在等的 RPC）；
      //   2. 在外面和它赛跑 —— 不接的那一百多个照样能当场返回。
      //
      // 原来这里两条都没有：第二个参数一直传的是空对象，然后死等工具跑完。
      // 于是用户按下停止，界面要僵到这次调用自己结束才有反应，`ue_screenshot`
      // 带界面截图那条路最长能僵将近 40 秒。
      const result = await runAbortable(options.name, signal, () =>
        Promise.resolve(execute(parsed, { abortSignal: signal }))
      )

      if (isV2Failure(result)) {
        // 必须抛 —— pi 只认异常，返回一个"看起来成功"的结果会让模型
        // 基于错误前提继续往下做。
        const message = describeV2Failure(result, options.name)

        // 等引擎超时要抛一个**认得出来的**类型：它和普通失败的语义完全不同
        // （「不知道做没做」vs「明确没做成」），外层据此决定要不要让调用方重试。
        // 到了外层就只剩一句中文了，按字符串猜类别是另一种编造
        const code = (result as V2Result)?.code
        if (code === V2_TIMEOUT_CODE) throw new EngineTimeoutError(message)
        // 「没查到」是合法的空结果，不是故障 —— 调用方要能和真正的失败分开
        if (code === RPC_NOT_FOUND || code === String(RPC_NOT_FOUND)) {
          throw new EngineNotFoundError(message)
        }
        throw new Error(message)
      }

      return {
        content: [{ type: 'text', text: toText(result) }, ...(await extractImages(result))],
        details: stripImages(result)
      }
    },
    unrealBox: {
      namespace: options.namespace,
      risk: options.risk,
      ...(options.requiresExplicitApproval ? { requiresExplicitApproval: true } : {})
    }
  }

  return tool as unknown as UnrealAgentTool<unknown>
}

/** 批量适配。`specs` 的键是 V3 工具名 */
export function adaptV2Tools(
  specs: Array<{ tool: V2Tool } & AdaptOptions>
): UnrealAgentTool<unknown>[] {
  return specs.map(({ tool, ...options }) => adaptV2Tool(tool, options))
}
