/**
 * 细粒度只读工具：组件级回读、材质图切片。
 *
 * 来自 2026-09-24 买量定序器反馈（缺口 4）：只读评审子任务要的数据在 Actor 内部组件、
 * 材质槽、CDO 或大材质图的某一段里，手上的只读工具够不到，只能回一句「需主流程用 Python 补读」。
 * 这两个工具本身只读（risk: safe），只读子任务直接拿得到，不需要放开 Python。
 */

import { createInspectComponentsTool } from './inspectComponents'
import { createMaterialGraphSliceTool } from './materialGraphSlice'
import type { UnrealAgentTool } from '../defineTool'

export function inspectTools(): UnrealAgentTool<never>[] {
  return [
    createInspectComponentsTool(),
    createMaterialGraphSliceTool()
  ] as unknown as UnrealAgentTool<never>[]
}
