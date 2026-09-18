/**
 * ue_content_dependencies —— 依赖 / 被引用闭包。
 *
 * `ue_content_describe` 只给一层直接依赖，`ue_asset_size_map` 给闭包但只关心体积。
 * 整理工程时真正要问的是：这个目录搬走谁会断、迁走要带上谁、哪些引用已经断了、
 * 哪些资产没人用。全程只读注册表，不加载资产。
 */

import { z } from 'zod'

import { defineUeTool } from '../defineUeTool'
import { NAMESPACE } from './namingAudit'
import { summarizeDependencies } from './summaries'
import type { DependenciesResponse } from './types'

const DependenciesInput = z.object({
  path: z.string().describe('一个资产（/Game/Props/SM_Rock）或一个目录（/Game/Props）'),
  direction: z
    .enum(['dependencies', 'referencers', 'both', 'unreferenced'])
    .optional()
    .describe(
      'dependencies（默认）= 它用到了谁；referencers = 谁用到了它；both = 两个方向；' +
        'unreferenced = 目录里没有任何引用者的资产（清理候选）'
    ),
  recursive: z
    .boolean()
    .optional()
    .describe('是否沿着依赖链一直走下去（闭包），默认 true；false 只看直接一层'),
  max_depth: z.number().int().min(1).max(64).optional().describe('最多走几层，默认 8'),
  hard_only: z
    .boolean()
    .optional()
    .describe('只算硬引用（加载时必须一起加载的），默认 false 连软引用一起算'),
  include_engine: z
    .boolean()
    .optional()
    .describe('把 /Engine 下的引擎内置资产也算进去，默认 false'),
  max_nodes: z
    .number()
    .int()
    .min(1)
    .max(20000)
    .optional()
    .describe('闭包最多收集多少个包，默认 2000；到上限就标 truncated'),
  limit: z.number().int().min(1).max(2000).optional().describe('结果里最多列多少条，默认 200'),
  include_edges: z.boolean().optional().describe('是否返回逐条的引用边（from → to），默认 false')
})

export const dependenciesTool = defineUeTool<typeof DependenciesInput, DependenciesResponse>({
  name: 'ue_content_dependencies',
  namespace: NAMESPACE,
  method: 'content.dependencies',
  risk: 'safe',
  timeoutMs: 180_000,
  description: `查一个资产或整个目录的依赖闭包 / 被引用闭包。只读注册表，不加载资产，大工程也是秒级。

【和另外两个查引用的分工】同一份注册表，形状不同：单个资产「能不能删」用
material_get_referencers（它会警告有未保存的包，那正是删之前最该知道的）；
读一个资产时顺带看一层用 ue_content_describe；**递归整条链、分内外、找断链**才用本工具。

回答的是整理工程时的四个问题：
1. **这个目录搬走 / 删掉，外面谁会断？** direction=referencers，看 referencers.external
2. **这个目录要迁到别的工程，得带上外面的谁？** direction=dependencies，看 dependencies.external
3. **哪些引用已经断了？** dependencies.missing 列出注册表里不存在的依赖包（加载时会报 Failed to load）
4. **目录里哪些资产没人用？** direction=unreferenced（只按注册表判断，代码 / 配置里按路径加载的算不到，删之前要确认）

给单个资产时 external 字段不出现；给目录时按「在不在这个目录下面」分内外。
结果按深度、再按磁盘体积排序。条目多时只列前 20 条并给出总数 ——
要看全的话把 path 收窄到子目录、或者把 max_depth 调小，分几次查。`,
  input: DependenciesInput,
  toParams: (args) => {
    const params: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(args)) {
      if (value !== undefined) params[key] = value
    }
    return params
  },
  toOutcome: (response) => ({
    text: summarizeDependencies(response),
    details: response
  })
})
