/**
 * ue_content_migrate —— 把资产连同依赖闭包拷到另一个工程。
 *
 * 等价于编辑器里右键 → Migrate，但没有对话框，而且每个文件都回读（目标存在且
 * 字节数一致才算拷成）。编辑器那条路 5.1 起才有无对话框的接口，返回 void，
 * 拷了什么一个字不说 —— 所以插件自己拷，九个引擎版本一份代码。
 */

import { z } from 'zod'

import { defineTool, type ToolOutcome } from '../defineTool'
import { callUeRawWhenRegistryReady } from '../defineUeTool'
import { NAMESPACE } from './namingAudit'
import { summarizeMigrate } from './summaries'
import type { MigrateResponse } from './types'

const MigrateInput = z.object({
  paths: z
    .array(z.string())
    .min(1)
    .describe('要迁的资产或目录，如 ["/Game/Props/SM_Rock", "/Game/Characters/Hero"]'),
  destination: z
    .string()
    .describe(
      '目标工程：.uproject 文件的绝对路径、工程目录、或它的 Content 目录都行，如 D:/Projects/Other/Other.uproject'
    ),
  include_dependencies: z
    .boolean()
    .optional()
    .describe('连依赖闭包一起迁（材质、贴图、骨骼……），默认 true。false 只拷点名的那几个'),
  on_conflict: z
    .enum(['skip', 'overwrite'])
    .optional()
    .describe('目标工程里已有同路径文件时：skip（默认，跳过）/ overwrite（覆盖）'),
  dry_run: z
    .boolean()
    .optional()
    .describe('只列出会拷哪些文件、多大、哪些会跳过，不动手。第一次先用它'),
  save_first: z
    .boolean()
    .optional()
    .describe('源资产有未保存改动时先保存再拷，默认 true。false 会拷到磁盘上旧的那份')
})

/** 大工程的依赖闭包动辄几千个文件，拷到机械盘上要很久 */
const MIGRATE_TIMEOUT_MS = 30 * 60 * 1000

export const migrateTool = defineTool<typeof MigrateInput, MigrateResponse>({
  name: 'ue_content_migrate',
  namespace: NAMESPACE,
  risk: 'mutating',
  // 插件的 dry_run 在 save_first 落盘之前就返回，什么都不写
  riskFor: (args) => (args.dry_run === true ? 'safe' : 'mutating'),
  concurrency: 'sequential',
  description: `把资产（连同它们的依赖闭包）从当前工程迁移到另一个虚幻工程，等价于编辑器右键 Migrate。

【怎么用】paths 给资产或目录，destination 给目标工程的 .uproject / 工程目录 / Content 目录。
先 dry_run=true 看会拷多少文件、多大、哪些目标已存在。

【它替你做的】
- 用注册表算依赖闭包（不加载资产），关卡会自动带上 One-File-Per-Actor 的外部 Actor 包
- 源资产有未保存改动时先落盘再拷（save_first）
- 逐文件回读：目标存在且字节数一致才算 copied
- 插件内容（/PluginName/…）只在目标工程也装了同名插件时才拷，否则列进 external_skipped
- /Engine 内容不拷（每个工程都有）

【不做】不会打开目标工程、不会在目标工程里修引用。拷完在那边打开工程让注册表扫一遍即可。
本工程内部的搬迁请用 ue_content_move。`,
  input: MigrateInput,
  execute: async (args, ctx) => {
    const params: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(args)) {
      if (value !== undefined) params[key] = value
    }
    // 不用 callUe（defineUeTool 走的就是它）：插件只要有一个文件没拷成就回 ok:false，
    // 而且不带顶层 error —— callUe 会把它压成「content.migrate 失败：未提供失败原因」，
    // 已经拷过去的数量和逐文件的失败原因一起扔掉。模型以为什么都没拷，重跑一遍
    // 又撞同一批失败。同 batchMove.ts 的 callBatch
    const response = await callUeRawWhenRegistryReady<MigrateResponse>('content.migrate', params, {
      timeoutMs: MIGRATE_TIMEOUT_MS,
      ctx
    })
    return migrateOutcome(response)
  }
})

interface RpcFailure {
  ok?: boolean
  error?: string
  message?: string
  code?: string | number
  __rpc?: { code?: string | number }
}

/**
 * 插件响应 → 给模型的结果。
 *
 * 两种 ok:false 要分开：参数错、目标不对这类是插件 SendError 回来的，**没有 files**，
 * 照旧当失败抛；拷了一半的那种带着完整的 files / copied，按部分完成来写。
 * 只有一个都没拷成、又确实有失败时才算工具失败 —— 全部因为目标已存在而跳过不是失败，
 * 预演更不是。
 */
export function migrateOutcome(response: MigrateResponse): ToolOutcome<MigrateResponse> {
  if (!Array.isArray((response as Partial<MigrateResponse>).files)) {
    const shape = response as unknown as RpcFailure
    const code = shape.__rpc?.code ?? shape.code
    throw new Error(
      `content.migrate 失败：${shape.error || shape.message || '未提供失败原因'}` +
        (code !== undefined ? `（错误码 ${code}）` : '')
    )
  }
  const text = summarizeMigrate(response)
  const nothingCopied = !response.dry_run && response.copied === 0
  const isError = nothingCopied && (response.failed > 0 || response.skipped === 0)
  return { text, details: response, ...(isError ? { isError: true } : {}) }
}
