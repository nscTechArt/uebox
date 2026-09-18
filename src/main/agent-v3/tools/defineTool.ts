/**
 * V3 工具定义。
 *
 * 存量 182 个 V2 工具是 AI SDK 的 `tool({ description, inputSchema, execute })`，
 * pi 要的是 `AgentTool<TSchema>`。这一层负责抹平差异，让迁移一个工具只需要：
 *
 *   1. `tool(` → `defineTool(`
 *   2. `inputSchema` → `input`
 *   3. 补 `namespace` 和 `risk`
 *
 * **业务逻辑零改动**，Zod schema 原样保留。
 *
 * 相比 V2 多出来的三件事：
 *   - `report()` 流式局部结果 —— 取代 V2 的 `reportProgress` 工具
 *   - `images` 原生进上下文 —— 取代 V2 的 `AgentImageContext` 回灌
 *   - `risk` 声明 —— 取代 V2 的 `SensitiveToolWrapper` 包装
 */

import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import type { TSchema } from 'typebox'
import { z } from 'zod'

import { runAbortable } from './abortable'

/** 工具的危险等级，审批门（core/approval.ts）据此决定是否拦截 */
export type ToolRisk =
  /** 只读。不需要审批 */
  | 'safe'
  /** 会改动用户数据，可撤销。默认需要审批，auto-edit 模式下放行 */
  | 'mutating'
  /** 不可逆（删除、覆盖、批量改写）。始终需要审批 */
  | 'destructive'

/** 工具产出。text / images 进模型上下文，details 只给宿主 UI */
export interface ToolOutcome<TDetails = unknown> {
  text?: string
  /**
   * 图片直接进上下文。
   *
   * UE 视口截图、材质预览、蓝图渲染图走这里 —— 模型下一轮就能"看到"，
   * 不需要 V2 那套先存盘再回灌的绕路。
   */
  images?: { data: Buffer | string; mimeType: string }[]
  /** 结构化数据。只发给渲染进程做 UI，**不进模型上下文**（省 token 的正确姿势） */
  details?: TDetails
  isError?: boolean
  /** 提示 agent 本批工具跑完后停下 */
  terminate?: boolean
  /** 完整工具定义在下一轮装载；支持的供应商由 pi 将它们锚定在本次结果处。 */
  addedToolNames?: string[]
}

/** execute 拿到的运行时上下文 */
export interface ToolCallContext<TDetails = unknown> {
  toolCallId: string
  signal?: AbortSignal
  /**
   * 上报局部进度。
   *
   * 长任务（批量导入、蓝图编译）边跑边推给界面，用户不用盯着转圈。
   * 只在本次 execute 期间有效，返回后调用无效。
   */
  report: (partial: ToolOutcome<TDetails>) => void
}

export interface ToolSpec<TIn extends z.ZodTypeAny, TDetails = unknown> {
  name: string
  /**
   * 命名空间，用于动态过滤、审批策略、MCP 暴露范围。
   * 形如 `ue.material` / `asset` / `mcp.<serverId>`。
   */
  namespace: string
  description: string
  input: TIn
  risk?: ToolRisk
  /**
   * 除完全访问权限外，每一次调用都必须由用户当场批准。
   *
   * 「本次会话都允许」对它无效；`yolo` 档直接放行 —— 见 `core/approval.ts`。
   * 给的是那种**每次的参数都不一样、而参数本身就是风险**的工具：浏览器
   * 打开哪个网址、往输入框里发什么内容，批准一次不能代表批准下一次。
   */
  requiresExplicitApproval?: boolean
  /** 能否与同批其他工具并发执行。改同一份资源的工具要声明 sequential */
  concurrency?: 'sequential' | 'parallel'
  execute: (args: z.infer<TIn>, ctx: ToolCallContext<TDetails>) => Promise<ToolOutcome<TDetails>>
}

/**
 * Zod → TypeBox TSchema。
 *
 * 用 Zod 4 内建的 `z.toJSONSchema()`。**不要用 `zod-to-json-schema`** ——
 * 那个包只支持 Zod 3，本仓库是 4.x，类型直接对不上。
 * TSchema 本质就是 JSON Schema 对象，转换后结构兼容。
 *
 * `io: 'input'` 很关键：带 `.default()` 的字段在输出侧是必填、输入侧是可选，
 * 取输出侧会让模型以为必须填。
 */
export function toToolSchema(schema: z.ZodTypeAny): TSchema {
  return z.toJSONSchema(schema, {
    target: 'draft-7',
    io: 'input',
    // 厂商对 JSON Schema 的支持参差不齐，遇到表达不了的结构降级成宽松对象，
    // 而不是整个工具注册失败。
    unrepresentable: 'any'
  }) as unknown as TSchema
}

function toContent(outcome: ToolOutcome): AgentToolResult<unknown>['content'] {
  const content: AgentToolResult<unknown>['content'] = []
  if (outcome.text) content.push({ type: 'text', text: outcome.text })
  for (const image of outcome.images ?? []) {
    content.push({
      type: 'image',
      data: typeof image.data === 'string' ? image.data : image.data.toString('base64'),
      mimeType: image.mimeType
    })
  }
  // pi 要求 content 非空；工具只返了 details 时给个占位，
  // 否则模型看到一个空 tool result 会以为调用失败。
  if (content.length === 0) content.push({ type: 'text', text: '(无文本输出)' })
  return content
}

function toAgentResult<TDetails>(outcome: ToolOutcome<TDetails>): AgentToolResult<TDetails> {
  return {
    content: toContent(outcome),
    details: outcome.details as TDetails,
    ...(outcome.terminate !== undefined ? { terminate: outcome.terminate } : {}),
    ...(outcome.addedToolNames ? { addedToolNames: outcome.addedToolNames } : {})
  }
}

/**
 * 工具失败要以**抛异常**的形式交给 pi。
 *
 * pi 判定失败的唯一依据是 `execute` 是否抛出 —— 成功路径里 `isError` 硬编码为
 * false（见 agent-loop.js 的 executeToolCall）。`AgentToolResult` 上根本没有
 * `isError` 字段，在返回值里设它会被静默忽略，结果就是**工具失败被当成功报给模型**。
 *
 * pi 捕获后会自己生成带错误信息的 tool result、标记 isError、喂回模型，
 * 循环不会中断 —— 正是我们想要的行为，不需要自己 try/catch。
 */
class ToolFailure extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolFailure'
  }
}

/** 附在 AgentTool 上的 V3 元数据，注册表和审批门读它 */
export interface ToolMeta {
  namespace: string
  risk: ToolRisk
  /** 见 `ToolSpec.requiresExplicitApproval` */
  requiresExplicitApproval?: boolean
}

export type UnrealAgentTool<TDetails = unknown> = AgentTool<TSchema, TDetails> & {
  unrealBox: ToolMeta
}

export function defineTool<TIn extends z.ZodTypeAny, TDetails = unknown>(
  spec: ToolSpec<TIn, TDetails>
): UnrealAgentTool<TDetails> {
  const risk: ToolRisk = spec.risk ?? 'mutating'

  const tool = {
    name: spec.name,
    description: spec.description,
    parameters: toToolSchema(spec.input),
    executionMode: spec.concurrency ?? 'parallel',
    execute: async (
      toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
      onUpdate?: (partial: AgentToolResult<TDetails>) => void
    ): Promise<AgentToolResult<TDetails>> => {
      // pi 已按 JSON Schema 校验过一遍，这里再过 Zod 是为了拿到
      // `.default()` / `.transform()` 的结果和精确的 TS 类型。
      const parsed = spec.input.parse(params) as z.infer<TIn>

      // 不 try/catch：异常直接交给 pi，由它标记 isError 并喂回模型。
      // 自己吞掉再返回一个"看起来成功"的结果，会让循环以为工具跑通了。
      //
      // 外面套一层 `runAbortable`：`signal` 一直都传进 `ctx` 了，但工具体里
      // 真去读它的只有个位数，其余都是「等引擎回话为止」—— 于是用户按下停止
      // 之后要一直等到这次调用自己结束。赛跑放在这里，所有工具一次覆盖，
      // 工具体照旧可以自己读 `ctx.signal` 提前收尾（那样更干净）。
      const outcome = await runAbortable(spec.name, signal, () =>
        spec.execute(parsed, {
          toolCallId,
          signal,
          report: (partial) => onUpdate?.(toAgentResult(partial))
        })
      )

      // 工具用 isError 表达失败时（不想自己 throw），转成异常给 pi。
      if (outcome.isError) {
        throw new ToolFailure(outcome.text || `${spec.name} 执行失败`)
      }

      return toAgentResult(outcome)
    },
    unrealBox: {
      namespace: spec.namespace,
      risk,
      ...(spec.requiresExplicitApproval ? { requiresExplicitApproval: true } : {})
    }
  }

  return tool as unknown as UnrealAgentTool<TDetails>
}
