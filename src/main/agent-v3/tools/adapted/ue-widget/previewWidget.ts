/**
 * Widget 预览工具
 * 通过 WebSocket 向虚幻引擎插件发送 widget.preview 命令
 */

import { promises as fs } from 'fs'
import { defineV2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import { serviceManager } from '../../../../services'

import { getTargetConnectionId } from '../../../core/projectTargetContext'
import { compressForContext } from '../../contextImage'

/**
 * 读预览图并压到能进上下文的大小。读不到就返回空数组，不让它把整个工具带失败。
 *
 * 和视口截图（`ue-editor/screenshot.ts`）走同一个 `compressForContext`。
 * 原来这里自己抄了一份 768 / quality / 180_000 —— 抄的那份还停在「压完仍然
 * 超上限就整张放弃」，而共享模块早就改成了质量阶梯加保底。一份常量抄成四份，
 * 分叉的表现不是报错，是某一天某个工具悄悄和别人不一样。
 */
async function readPreviewImage(
  filePath: string | undefined
): Promise<Array<{ data: string; mimeType: string }>> {
  if (!filePath) return []
  try {
    const compressed = await compressForContext(await fs.readFile(filePath))
    return compressed ? [compressed] : []
  } catch (error) {
    console.warn('[PreviewWidgetTool] 读取预览图失败:', error)
    return []
  }
}
const PreviewWidgetSchema = z.object({
  path: z.string().describe('Widget Blueprint 路径，如 /Game/UI/WBP_MainMenu'),
  width: z.number().optional().describe('预览宽度，默认 1920'),
  height: z.number().optional().describe('预览高度，默认 1080')
})

interface PreviewResponse {
  ok: boolean
  path: string
  width: number
  height: number
  /** 插件写的失败原因，由 WebSocket 那层从 code>=400 的响应补上。不透传等于把诊断扔了 */
  error?: string
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function previewWidgetTool() {
  return defineV2Tool({
    description: `渲染 Widget Blueprint 的预览截图。

【功能说明】：
- 编译 Widget Blueprint 确保最新
- 使用 FWidgetRenderer 渲染到 RenderTarget
- 保存截图到项目 Saved/Screenshots/UAL 目录

【适用场景】：
- 检查 Widget 布局效果
- AI 自优化 UI 的视觉反馈`,

    inputSchema: PreviewWidgetSchema,

    execute: async (input) => {
      if (!input || !input.path) {
        return { ok: false, error: '缺少必填参数 path', input_path: 'unknown' }
      }

      const wsService = serviceManager.getWebSocketService()
      if (wsService.getConnectionCount() === 0) {
        return { ok: false, error: '没有连接的虚幻引擎项目', input_path: input.path }
      }

      try {
        const response = await wsService.callRequest<PreviewResponse>(
          'widget.preview',
          {
            path: input.path,
            width: input.width ?? 1920,
            height: input.height ?? 1080
          },
          getTargetConnectionId()
        )

        if (!response || !response.ok) {
          return { ok: false, error: response?.error || '预览渲染失败', input_path: input.path }
        }

        // 把渲染结果直接读进上下文。
        //
        // 原来只回一个本地文件路径 —— 模型打不开那个路径，等于渲染了个寂寞。
        // 真机验证时图是对的（血条 60%、文本、位置都准），但模型看不见，
        // 「检查 Widget 布局效果」这个声称的用途根本无从实现。
        const images = await readPreviewImage(response.path)

        return {
          ok: true,
          screenshot_path: response.path,
          width: response.width,
          height: response.height,
          images,
          message: images.length
            ? `Widget 预览已渲染（${response.width}x${response.height}），图见附件。`
            : `Widget 预览已保存到 ${response.path}，但读取图片失败，只能自行打开查看。`
        }
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          input_path: input.path
        }
      }
    }
  })
}
