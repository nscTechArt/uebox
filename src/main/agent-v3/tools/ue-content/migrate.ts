/**
 * ue_content_migrate —— 把资产连同依赖闭包拷到另一个工程。
 *
 * 等价于编辑器里右键 → Migrate，但没有对话框，而且每个文件都回读（目标存在且
 * 字节数一致才算拷成）。编辑器那条路 5.1 起才有无对话框的接口，返回 void，
 * 拷了什么一个字不说 —— 所以插件自己拷，九个引擎版本一份代码。
 */

import { z } from 'zod'

import { defineUeTool } from '../defineUeTool'
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

export const migrateTool = defineUeTool<typeof MigrateInput, MigrateResponse>({
  name: 'ue_content_migrate',
  namespace: NAMESPACE,
  method: 'content.migrate',
  risk: 'mutating',
  concurrency: 'sequential',
  timeoutMs: 30 * 60 * 1000,
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
  toParams: (args) => {
    const params: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(args)) {
      if (value !== undefined) params[key] = value
    }
    return params
  },
  toOutcome: (response) => ({
    text: summarizeMigrate(response),
    details: response
  })
})
