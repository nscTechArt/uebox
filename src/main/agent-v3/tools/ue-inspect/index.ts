/**
 * 细粒度只读工具：组件级回读、材质图切片、灯光普查。
 *
 * 来自 2026-09-24 买量定序器反馈（缺口 4）：只读评审子任务要的数据在 Actor 内部组件、
 * 材质槽、CDO 或大材质图的某一段里，手上的只读工具够不到，只能回一句「需主流程用 Python 补读」。
 * 这些工具本身只读（risk: safe），只读子任务直接拿得到，不需要放开 Python。
 *
 * 灯光普查（`ue_light_census`）同理：性能排查的只读子任务要讲清渲染线程 / GPU 瓶颈的原因，
 * 之前只能现写 Python 去数每盏灯半径里的东西。
 */

import { createInspectComponentsTool } from './inspectComponents'
import { createLightCensusTool } from './lightCensus'
import { createMaterialGraphSliceTool } from './materialGraphSlice'
import type { UnrealAgentTool } from '../defineTool'

export function inspectTools(): UnrealAgentTool<never>[] {
  return [
    createInspectComponentsTool(),
    createMaterialGraphSliceTool(),
    createLightCensusTool()
  ] as unknown as UnrealAgentTool<never>[]
}
