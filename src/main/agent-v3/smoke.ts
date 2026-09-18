/**
 * Agent V3 P0 构建验证。
 *
 * 这个模块存在的唯一目的，是证明 pi 全家（ESM-only）能被 rollup 打进 CJS 主进程产物
 * 并在运行时正常工作。它刻意触达了 V3 会真正依赖的几条重路径：
 *
 *   1. `Agent` 类构造        —— 内核
 *   2. `builtinModels()`     —— pi-ai 的生成式模型目录（最大的那个模块）
 *   3. compaction 工具函数    —— 上下文压缩
 *   4. Zod → TSchema 适配     —— 182 个存量工具的迁移路径
 *
 * 只 import 类型不算数：类型在编译期就被抹掉，rollup 不会把实现打进来，
 * 那样的「构建通过」是假的。所以这里全部是值级调用。
 *
 * **刻意不 import 工具注册表。** 那会把 electron / @aws-sdk / sharp 整条依赖树
 * 拉进来，而这个模块要能在一个裸 node 进程里被 `require()`（见 smoke.test.ts
 * 的 CJS 降级用例）。工具侧的诊断放在 toolDiagnostics.ts，由 IPC 层合并。
 */

import { Agent, estimateContextTokens } from '@earendil-works/pi-agent-core'
import type { AgentTool, AgentToolResult, StreamFn } from '@earendil-works/pi-agent-core'
import { builtinModels, getBuiltinProviders } from '@earendil-works/pi-ai/providers/all'
import type { TSchema } from 'typebox'
import { z } from 'zod'

export interface AgentV3SmokeReport {
  ok: boolean
  /** pi-ai 内建 provider 数量 */
  providerCount: number
  /** 抽样确认国产 provider 在目录里 */
  sampledProviders: string[]
  /** Agent 实例是否构造成功 */
  agentConstructed: boolean
  /** Zod → JSON Schema 适配产出的 schema 键 */
  toolSchemaKeys: string[]
  /** 适配后的工具能否真的执行 */
  toolExecuted: boolean
  /** compaction 的 token 估算是否可用 */
  estimatedTokens: number
  errors: string[]
}

/**
 * Zod → TypeBox TSchema。
 *
 * 用 Zod 4 内建的 `z.toJSONSchema()`，不需要 `zod-to-json-schema`
 * （那个包只支持 Zod 3，本仓库是 4.1.13，类型对不上）。
 * TSchema 本质就是 JSON Schema 对象，转换后结构兼容。
 */
function toToolSchema(schema: z.ZodTypeAny): TSchema {
  return z.toJSONSchema(schema, { target: 'draft-7', io: 'input' }) as unknown as TSchema
}

/** 最小版 defineTool，验证存量 Zod 工具的迁移路径可行 */
function defineSmokeTool(): AgentTool<TSchema, { echoed: string }> {
  const input = z.object({
    material_name: z.string().describe('材质名称'),
    two_sided: z.boolean().optional().describe('是否双面渲染')
  })

  return {
    name: 'smoke_create_material',
    description: 'P0 验证用的假工具，形状对齐 V2 的 ue-material/createMaterial.ts',
    parameters: toToolSchema(input),
    execute: async (_toolCallId, params): Promise<AgentToolResult<{ echoed: string }>> => {
      const parsed = input.parse(params)
      return {
        content: [{ type: 'text', text: `created ${parsed.material_name}` }],
        details: { echoed: parsed.material_name }
      }
    }
  } as AgentTool<TSchema, { echoed: string }>
}

/**
 * 跑一遍 P0 验证。任何一步抛错都记进 errors 而不是往外扔 ——
 * 这个函数是诊断用的，不该把主进程带崩。
 */
export async function runAgentV3Smoke(): Promise<AgentV3SmokeReport> {
  const errors: string[] = []
  let providerCount = 0
  let sampledProviders: string[] = []
  let agentConstructed = false
  let toolSchemaKeys: string[] = []
  let toolExecuted = false
  let estimatedTokens = 0

  // 1. pi-ai 模型目录 —— 触达 models.generated.js（最大的模块）
  try {
    const providers = getBuiltinProviders()
    providerCount = providers.length
    // 抽样确认那批国产 provider 确实在目录里
    sampledProviders = ['zai', 'deepseek', 'moonshotai', 'minimax', 'openrouter'].filter((id) =>
      providers.includes(id as (typeof providers)[number])
    )
    builtinModels()
  } catch (error) {
    errors.push(`pi-ai catalog: ${(error as Error).message}`)
  }

  // 2. Zod → TSchema 适配 + 真实执行
  let tool: AgentTool<TSchema, { echoed: string }> | undefined
  try {
    tool = defineSmokeTool()
    const props = (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    toolSchemaKeys = Object.keys(props)

    const result = await tool.execute('smoke-call-1', {
      material_name: 'M_SmokeTest',
      two_sided: true
    })
    toolExecuted = result.details.echoed === 'M_SmokeTest'
  } catch (error) {
    errors.push(`tool adapter: ${(error as Error).message}`)
  }

  // 3. Agent 内核构造 —— streamFn 用假的，P0 不打网络
  try {
    const noopStreamFn: StreamFn = () => {
      throw new Error('P0 smoke: streamFn 未接线')
    }
    const agent = new Agent({
      streamFn: noopStreamFn,
      toolExecution: 'parallel',
      steeringMode: 'all',
      followUpMode: 'one-at-a-time',
      sessionId: 'agent-v3-smoke'
    })
    if (tool) agent.state.tools = [tool as AgentTool<TSchema>]
    agentConstructed = agent.state.tools.length === 1 && !agent.state.isStreaming
  } catch (error) {
    errors.push(`Agent construct: ${(error as Error).message}`)
  }

  // 4. compaction 工具函数
  try {
    const usage = estimateContextTokens([
      { role: 'user', content: '虚幻盒子 agent-v3 P0 构建验证', timestamp: 0 }
    ] as Parameters<typeof estimateContextTokens>[0])
    estimatedTokens = usage.tokens
  } catch (error) {
    errors.push(`compaction: ${(error as Error).message}`)
  }

  return {
    ok: errors.length === 0,
    providerCount,
    sampledProviders,
    agentConstructed,
    toolSchemaKeys,
    toolExecuted,
    estimatedTokens,
    errors
  }
}
