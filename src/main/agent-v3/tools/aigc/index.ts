/**
 * AIGC 工具集：生图、视频生成与分析、3D 生成均使用用户配置的模型服务。
 */

import type { UnrealAgentTool } from '../defineTool'
import { createGenerateImageTool } from './generateImage'
import { createGenerateVideoTool } from './generateVideo'
import { createAnalyzeVideoTool } from './analyzeVideo'
import { createGenerate3dModelTool } from './generate3dModel'

export function aigcTools(): UnrealAgentTool<never>[] {
  return [
    createGenerateImageTool(),
    createGenerateVideoTool(),
    // 出片和看片是一对：没有后者，模型只能转述参数，说不出画面
    createAnalyzeVideoTool(),
    createGenerate3dModelTool()
  ] as unknown as UnrealAgentTool<never>[]
}

export { createGenerateImageTool } from './generateImage'
export type { GeneratedImageDetails } from './generateImage'
export { createGenerateVideoTool } from './generateVideo'
export type { GeneratedVideoDetails } from './generateVideo'
export { createAnalyzeVideoTool } from './analyzeVideo'
export type { AnalyzedVideoDetails } from './analyzeVideo'
export { createGenerate3dModelTool } from './generate3dModel'
export type { Generated3dModelDetails } from './generate3dModel'
