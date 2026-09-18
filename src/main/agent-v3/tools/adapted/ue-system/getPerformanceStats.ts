/**
 * 获取性能统计工具
 * 通过 WebSocket 向虚幻引擎插件发送 system.get_performance_stats 命令
 * 返回当前采样周期的平均 FPS 以及各线程/GPU 的耗时
 */

import { defineV2Tool, type V2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import { serviceManager } from '../../../../services'

import { getTargetConnectionId } from '../../../core/projectTargetContext'
import { foregroundUnrealEditorWindow } from './foregroundEditorWindow'
import { UE_NOT_CONNECTED_MESSAGE } from '../../defineUeTool'
// ============================================================================
// Schema 定义
// ============================================================================

/**
 * 获取性能统计请求参数（无参数，但需要保留空对象以符合接口规范）
 */
const GetPerformanceStatsParamsSchema = z.object({})

// ============================================================================
// 类型定义
// ============================================================================

/** 性能统计响应数据 */
interface PerformanceStatsResponse {
  fps: number
  frame_ms: number
  game_thread_ms: number
  render_thread_ms: number
  rhi_thread_ms: number
  gpu_ms: number
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 构建性能分析摘要
 * @param stats 性能统计数据
 * @returns 人类可读的性能摘要
 */
function buildPerformanceSummary(stats: PerformanceStatsResponse): string {
  const parts: string[] = []

  // FPS 评级
  if (stats.fps >= 60) {
    parts.push(`帧率 ${stats.fps.toFixed(1)} FPS（流畅）`)
  } else if (stats.fps >= 30) {
    parts.push(`帧率 ${stats.fps.toFixed(1)} FPS（可接受）`)
  } else if (stats.fps > 0) {
    parts.push(`帧率 ${stats.fps.toFixed(1)} FPS（较低）`)
  } else {
    parts.push('帧率数据暂未就绪')
  }

  // 瓶颈分析
  if (stats.frame_ms > 0) {
    const maxCpuTime = Math.max(stats.game_thread_ms, stats.render_thread_ms, stats.rhi_thread_ms)
    if (stats.gpu_ms > maxCpuTime * 1.2) {
      parts.push('瓶颈：GPU')
    } else if (stats.game_thread_ms > stats.render_thread_ms * 1.2) {
      parts.push('瓶颈：游戏线程')
    } else if (stats.render_thread_ms > stats.game_thread_ms * 1.2) {
      parts.push('瓶颈：渲染线程')
    } else {
      parts.push('各线程负载均衡')
    }
  }

  return parts.join('，') + '。' + qualifySample(stats)
}

/**
 * 给数字加上「这是在什么情况下测的」。
 *
 * 编辑器窗口在后台或没有焦点时会主动降帧（默认限到很低），真机上量到过
 * **4.8 FPS**，工具照样输出「帧率较低，瓶颈：游戏线程」—— 调用方据此会向
 * 用户报告「你的游戏只有 5 帧，游戏线程有瓶颈」，而实际上什么问题都没有。
 *
 * 性能数字脱离采样条件就是误导。渲染线程和 GPU 都是 0 更是明证：
 * 那不是「GPU 很快」，是**根本没在渲染**。
 */
function qualifySample(stats: PerformanceStatsResponse): string {
  const idle = stats.render_thread_ms === 0 && stats.gpu_ms === 0
  if (idle) {
    return (
      '\n⚠️ 渲染线程和 GPU 耗时均为 0，说明编辑器视口当时没有在渲染' +
      '（窗口在后台或失去焦点时会主动降帧）。这组数字**不能**用来判断性能问题。' +
      '要得到有意义的数据，请让用户把编辑器窗口置前、进入 PIE 运行，再重新采集。'
    )
  }
  return (
    '\n注：数据采自编辑器当前状态，不等于打包后的运行表现。' +
    '要评估实际性能，应在 PIE 或独立运行下、在有代表性的场景里采集。'
  )
}

// ============================================================================
// 工具定义
// ============================================================================

/**
 * 创建获取性能统计工具
 * @returns 获取性能统计工具实例
 */
export function createGetPerformanceStatsTool(): V2Tool {
  return defineV2Tool({
    description: `测**当前跑得快不快** —— 实时帧率与各线程耗时。

【和另外三个性能工具的分工】
- 想知道当前关卡该改哪几个网格（面数、实例数、缺碰撞）→ ue_find_heavy_assets
- 想知道整个工程哪些资产占地方 → ue_project_asset_ranking
- 想知道整个项目配置得好不好（Nanite/Lumen 启用率）→ ue_content_audit_optimization
- 想知道此刻的帧率和瓶颈在 CPU 还是 GPU → 就是本工具

【返回指标】：
- fps：当前帧率（每秒帧数）
- frame_ms：每帧总耗时（毫秒）
- game_thread_ms：游戏线程耗时（毫秒）
- render_thread_ms：渲染线程耗时（毫秒）
- rhi_thread_ms：RHI 线程耗时（毫秒）
- gpu_ms：GPU 耗时（毫秒）

【数据来源】：
- 引擎统计全局均值（GAverageFPS/GAverageMS 等）
- 需引擎已运行一段时间以形成稳定均值

【使用场景】：
- 性能监控：实时查看帧率和各线程负载
- 性能分析：定位瓶颈（CPU-bound vs GPU-bound）
- 优化验证：验证优化措施是否生效

【注意事项】：
- 刚启动时数值可能为 0，需等待引擎形成均值
- 各耗时字段单位均为毫秒`,

    inputSchema: GetPerformanceStatsParamsSchema,

    execute: async () => {
      console.log('[GetPerformanceStatsTool] 收到请求')

      try {
        const wsService = serviceManager.getWebSocketService()
        if (wsService.getConnectionCount() === 0) {
          return {
            success: false,
            error: UE_NOT_CONNECTED_MESSAGE
          }
        }

        // 尝试将虚幻引擎窗口带到前台，避免因后台运行导致的降帧
        await foregroundUnrealEditorWindow('[GetPerformanceStatsTool]')

        console.log('[GetPerformanceStatsTool] 发送 system.get_performance_stats 请求')

        const response = await wsService.callRequest<PerformanceStatsResponse>(
          'system.get_performance_stats',
          {},
          getTargetConnectionId(),
          30000
        )

        console.log('[GetPerformanceStatsTool] 收到响应:', response)

        if (response) {
          // RPC 错误响应透传
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const rpcOk = (response as any)?.ok
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const rpcSuccess = (response as any)?.success
          if (rpcOk === false || rpcSuccess === false) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const msg = (response as any)?.error || (response as any)?.message || '获取性能统计失败'
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const code = (response as any)?.__rpc?.code ?? (response as any)?.code
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const details = (response as any)?.details
            return {
              success: false,
              error: `获取性能统计失败：${msg}`,
              code,
              details,
              raw: response
            }
          }

          // 构建性能分析摘要
          const summary = buildPerformanceSummary(response)

          return {
            success: true,
            fps: response.fps,
            frame_ms: response.frame_ms,
            game_thread_ms: response.game_thread_ms,
            render_thread_ms: response.render_thread_ms,
            rhi_thread_ms: response.rhi_thread_ms,
            gpu_ms: response.gpu_ms,
            message: summary
          }
        }

        return {
          success: false,
          error: '服务未返回有效数据'
        }
      } catch (error) {
        console.error('[GetPerformanceStatsTool] 执行失败:', error)
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  })
}
