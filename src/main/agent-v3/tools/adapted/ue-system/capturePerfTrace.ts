/**
 * 用引擎自带的 CSV Profiler 采一段时间的帧时序，而不是一帧快照。
 *
 * `ue_get_performance_stats` 读的是引擎的滚动平均值，本质是**此刻**的快照。
 * 掉帧往往是偶发尖峰——加载了一张贴图、生成了一批粒子——平均值会把它抹平，
 * 快照大概率根本没落在那一帧上。这个工具让插件在游戏线程里连续采样
 * `duration_seconds` 秒，回一段真实的百分位统计（p50/p95/p99）和最卡的
 * 那一帧长什么样，而不是一个被平均掉的数字。
 *
 * 采样前会先尝试把编辑器窗口拉到前台（见 foregroundEditorWindow.ts）——
 * 用户在盒子聊天窗口里问性能问题时，UE 窗口大概率被挡在后面，不做这一步
 * 采样时长越长、白采的代价越大：等完 duration_seconds 才发现是空转样本。
 */

import { defineV2Tool, type V2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import { serviceManager } from '../../../../services'

import { getTargetConnectionId, getTargetProjectPath } from '../../../core/projectTargetContext'
import { resolveEngineOutputPath } from './engineOutputPath'
import { foregroundUnrealEditorWindow } from './foregroundEditorWindow'
import { UE_NOT_CONNECTED_MESSAGE } from '../../defineUeTool'
import { assertFreshFile } from '../../assertFreshFile'

const CapturePerfTraceSchema = z.object({
  duration_seconds: z
    .number()
    .optional()
    .default(10)
    .describe(
      '采样时长，秒。1–120，默认 10。这段时间内编辑器/PIE 该干什么就干什么，工具只是在旁边记账'
    ),
  gpu_stats: z
    .boolean()
    .optional()
    .default(false)
    .describe('是否同时记录 GPU 各 pass 耗时（有额外开销，默认关）。开了之后不会自动关回去')
})

interface ColumnStats {
  avg: number
  min: number
  max: number
  p50: number
  p95: number
  p99: number
}

interface CapturePerfTraceResponse {
  ok?: boolean
  csv_path?: string
  frame_count?: number
  requested_duration_seconds?: number
  actual_elapsed_seconds?: number
  gpu_stats_enabled?: boolean
  stats?: Record<string, ColumnStats>
  avg_fps?: number
  p99_fps?: number
  worst_frame?: Record<string, number>
  bottleneck?: string
  idle_sample?: boolean
  note?: string
}

function round1(n: number | undefined): number | undefined {
  return typeof n === 'number' ? Math.round(n * 10) / 10 : n
}

export function createCapturePerfTraceTool(): V2Tool {
  return defineV2Tool({
    description: `连续采样一段时间的帧时序（用引擎自带的 CSV Profiler），回百分位统计而不是一帧快照。

【和 ue_get_performance_stats 的区别】那个是**此刻**的滚动平均值，一次尖峰很容易被抹平、
也很容易根本没采到。这个工具**跑够 duration_seconds 秒**，逐帧记录 FrameTime /
GameThreadTime / RenderThreadTime / GPUTime，回：
- 每列的 avg / min / max / p50 / p95 / p99
- 最卡的那一帧（worst_frame）各项耗时，用来定位"卡顿发生时到底是谁在忙"
- bottleneck：GPU / GameThread / RenderThread / balanced

【什么时候用】用户说"感觉会掉帧""有没有卡顿""压力测试一下性能"，或者你需要一个
不是单帧快照、能反映一段时间内真实情况的性能数字。

【调用是同步等待的】duration_seconds 秒之后才会返回，不是立即返回再轮询。

【参数】
- duration_seconds: 采样时长，默认 10，最长 120。数字越大越能捕捉到偶发尖峰，
  但用户也要等这么久
- gpu_stats: 要不要顺便记 GPU 各 pass 耗时（有额外开销，默认不开）

【读结果时注意】
- 和 ue_get_performance_stats 同一条纪律：\`idle_sample: true\` 说明采样期间编辑器
  视口根本没在渲染（后台/失焦降帧），这组数字不能用来下性能结论——让用户把编辑器
  置前、进 PIE，再采一次
- 数据采自编辑器，不等于打包后的运行表现
- \`csv_path\` 是完整原始数据，想用 Session Frontend 深挖可以直接打开这个文件`,

    inputSchema: CapturePerfTraceSchema,

    execute: async ({ duration_seconds, gpu_stats }) => {
      console.log('[CapturePerfTraceTool] 收到请求:', { duration_seconds, gpu_stats })

      try {
        const wsService = serviceManager.getWebSocketService()
        if (wsService.getConnectionCount() === 0) {
          return {
            success: false,
            error: UE_NOT_CONNECTED_MESSAGE
          }
        }

        // 采样前先尝试把编辑器窗口拉到前台，见文件头说明
        await foregroundUnrealEditorWindow('[CapturePerfTraceTool]')

        // 超时给采样时长留足余量：插件端还有一段结束宽限期，
        // 网络往返和引擎那边的调度也需要时间
        const timeoutMs = duration_seconds * 1000 + 60000

        const since = Date.now()
        const response = await wsService.callRequest<CapturePerfTraceResponse>(
          'system.capture_perf_trace',
          { duration_seconds, gpu_stats },
          getTargetConnectionId(),
          timeoutMs
        )

        if (!response) {
          return { success: false, error: '服务未返回有效数据' }
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const failed = (response as any)?.ok === false || (response as any)?.success === false
        if (failed) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const msg = (response as any)?.error || (response as any)?.message || '性能采样失败'
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const code = (response as any)?.__rpc?.code ?? (response as any)?.code
          return {
            success: false,
            error: code === 409 ? `${msg}` : `性能采样失败：${msg}`,
            code
          }
        }

        /*
         * 旧插件回的是相对引擎目录的路径，直接 stat 会按盒子的工作目录补出一个
         * 盘符不同、其余全对的路径（见 engineOutputPath.ts）。这里按工程目录落回去，
         * 让工具在没升级插件的机器上照样出数 —— 用户手里的插件新不新不该由他负责。
         */
        const csvPath = resolveEngineOutputPath(response.csv_path, getTargetProjectPath())
        await assertFreshFile(csvPath, since)
        const stats = response.stats ?? {}
        const roundedStats: Record<string, ColumnStats> = {}
        for (const [key, s] of Object.entries(stats)) {
          roundedStats[key] = {
            avg: round1(s.avg) ?? 0,
            min: round1(s.min) ?? 0,
            max: round1(s.max) ?? 0,
            p50: round1(s.p50) ?? 0,
            p95: round1(s.p95) ?? 0,
            p99: round1(s.p99) ?? 0
          }
        }

        const summaryParts: string[] = []
        if (response.avg_fps !== undefined) {
          summaryParts.push(`平均 ${response.avg_fps.toFixed(1)} FPS`)
        }
        if (stats.FrameTime) {
          summaryParts.push(
            `p95 帧时间 ${round1(stats.FrameTime.p95)}ms，p99 ${round1(stats.FrameTime.p99)}ms`
          )
        }
        if (response.bottleneck && response.bottleneck !== 'unknown') {
          summaryParts.push(`瓶颈：${response.bottleneck}`)
        }
        summaryParts.push(`共 ${response.frame_count ?? 0} 帧`)

        let message = summaryParts.join('，') + '。'
        if (response.idle_sample) {
          message +=
            '\n警告：渲染线程和 GPU 耗时全程接近 0，采样期间编辑器视口没有在渲染' +
            '（窗口在后台或失去焦点会主动降帧）。这组数字不能用来判断性能问题，' +
            '请让编辑器窗口置前、进入 PIE 运行，再重新采集。'
        } else {
          message += '\n注：数据采自编辑器，不等于打包后的运行表现。'
        }

        return {
          success: true,
          // 回落回去的那一份：相对路径给出去，用户和模型都打不开
          csv_path: csvPath,
          frame_count: response.frame_count,
          requested_duration_seconds: response.requested_duration_seconds,
          actual_elapsed_seconds: response.actual_elapsed_seconds,
          gpu_stats_enabled: response.gpu_stats_enabled,
          stats: roundedStats,
          avg_fps: round1(response.avg_fps),
          p99_fps: round1(response.p99_fps),
          worst_frame: response.worst_frame,
          bottleneck: response.bottleneck,
          idle_sample: response.idle_sample,
          message
        }
      } catch (error) {
        console.error('[CapturePerfTraceTool] 执行失败:', error)
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  })
}
