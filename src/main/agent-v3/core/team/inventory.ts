/**
 * 工程里到底有什么 —— 直接数磁盘上的 `Content/`。
 *
 * ## 为什么数磁盘，不问引擎
 *
 * 2026-09-26 真机反馈：制作人一天里拿到三个版本的「现状」—— 自己搜出 8 个蓝图、
 * 队员说磁盘上有 39 个资产、另一个队员说 HUD 不是空壳。连接状态、内容浏览器缓存、
 * 时序都会让「问引擎」和「问队友」对不上。磁盘是唯一不看视角的真相：
 * 存下来的就在，没存的就不在；编辑器崩了、没连上也照样数得出来。
 *
 * 分类按 UE 的命名惯例（`BP_` / `WBP_` / `M_` …）和扩展名（`.umap` 是关卡）猜，
 * 猜不出来的归「其他」。这是给人和模型看的概况，不是资产审计。
 */

import { promises as fs } from 'fs'
import { join, relative } from 'path'

export interface InventoryItem {
  /** 相对 Content 的路径，正斜杠 */
  path: string
  category: string
  modifiedAt: number
}

export interface Inventory {
  total: number
  counts: Record<string, number>
  /** 最近改过的，新的在前 */
  recent: InventoryItem[]
  /** 数到上限就停了，total 是下限 */
  truncated: boolean
}

const PREFIXES: Array<[RegExp, string]> = [
  [/^WBP_/i, 'UI'],
  [/^(BP|B)_/i, '蓝图'],
  [/^ABP_/i, '动画蓝图'],
  [/^MI_/i, '材质实例'],
  [/^(M|MF)_/i, '材质'],
  [/^T_/i, '贴图'],
  [/^SM_/i, '静态网格'],
  [/^(SK|SKM)_/i, '骨骼网格'],
  [/^(A|AM|AS)_/i, '动画'],
  [/^(S|SC|SW)_/i, '声音'],
  [/^(NS|P|FX)_/i, '特效'],
  [/^(DT|D)_/i, '数据表'],
  [/^E_/i, '枚举'],
  [/^(F|ST)_/i, '结构体']
]

export function categorize(fileName: string): string {
  if (/\.umap$/i.test(fileName)) return '关卡'
  for (const [pattern, category] of PREFIXES) if (pattern.test(fileName)) return category
  return '其他'
}

/** 最多数这么多个文件。再大的工程，概况也不需要逐个列 */
const MAX_FILES = 20_000

export async function contentInventory(projectDir: string, recentCount = 10): Promise<Inventory> {
  const root = join(projectDir, 'Content')
  const items: InventoryItem[] = []
  let truncated = false

  const walk = async (dir: string): Promise<void> => {
    if (truncated) return
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (items.length >= MAX_FILES) {
        truncated = true
        return
      }
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        // 引擎自带的开发者目录、集合不算工程资产
        if (entry.name === 'Developers' || entry.name === 'Collections') continue
        await walk(full)
      } else if (/\.(uasset|umap)$/i.test(entry.name)) {
        const stat = await fs.stat(full).catch(() => null)
        items.push({
          path: relative(root, full).replace(/\\/g, '/'),
          category: categorize(entry.name),
          modifiedAt: stat?.mtimeMs ?? 0
        })
      }
    }
  }
  await walk(root)

  const counts: Record<string, number> = {}
  for (const item of items) counts[item.category] = (counts[item.category] ?? 0) + 1
  return {
    total: items.length,
    counts,
    recent: [...items].sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, recentCount),
    truncated
  }
}

/** 一行概况：「共 39 · 蓝图 8 · UI 5 · 材质 5 · 关卡 1」。数量多的在前 */
export function formatCounts(inventory: Inventory): string {
  const parts = Object.entries(inventory.counts)
    .sort((a, b) => b[1] - a[1])
    .map(([category, count]) => `${category} ${count}`)
  return [`共 ${inventory.total}${inventory.truncated ? '+' : ''}`, ...parts].join(' · ')
}
