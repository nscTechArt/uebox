/**
 * 查询或修改插件状态工具
 * 通过 WebSocket 向虚幻引擎插件发送 system.manage_plugin 命令
 *
 * ## 为什么这里要自己回读一遍 .uproject
 *
 * 2026-08-31 的真机事故：对 PCG 执行 Enable，工具回「Plugin enabled.
 * Restart required.」，用户重启了两次，`pcg.status` 仍然说没启用 ——
 * 打开 `.uproject` 一看，`Plugins` 数组里根本没有 PCG 这一条。
 *
 * 根因在引擎侧（`IProjectManager::SetPluginEnabled` 只改内存不落盘，见
 * `UAL_SystemCommands.cpp` 里那段说明），已经修好了。但那一次事故的教训不是
 * 「引擎侧写漏了一行」，而是：
 *
 *   **没有回读校验的「成功」等于没有成功。**
 *
 * 所以盒子这边不把引擎的成功文案当结论 —— 改完之后自己打开 `.uproject`
 * 看那一条在不在。这一层还顺带兜住了装着旧插件包的用户：他们的引擎侧仍然
 * 不落盘，但现在至少不会拿到一句假的「已启用」，然后白重启两次编辑器。
 */

import { defineV2Tool, type V2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import { serviceManager } from '../../../../services'

import { getTargetConnectionId } from '../../../core/projectTargetContext'
import { UE_NOT_CONNECTED_MESSAGE } from '../../defineUeTool'
import { readUeJsonFile } from '../../../../utils/ueTextFile'
// ============================================================================
// Schema 定义
// ============================================================================

const ManagePluginParamsSchema = z.object({
  plugin_name: z
    .string()
    .describe(
      '插件名，例如 "GLTFImporter"、"DatasmithGLTFImporter"、"USDImporter"、"PythonScriptPlugin"'
    ),
  action: z
    .enum(['Query', 'Enable', 'Disable'])
    .default('Query')
    .describe('动作：查询(Query)、启用(Enable)、禁用(Disable)')
})

// ============================================================================
// 类型定义
// ============================================================================

interface ManagePluginResponse {
  plugin_name: string
  is_enabled: boolean
  requires_restart: boolean
  friendly_name?: string
  message?: string
  /** 以下四个字段来自新版插件包；老包没有，一律按「拿不到」处理 */
  uproject_path?: string
  uproject_state?: string
  uproject_verified?: boolean
  default_enabled?: boolean
}

// ============================================================================
// .uproject 回读校验
// ============================================================================

/** 一个插件在 `.uproject` 里的落盘状态 */
export type UprojectPluginState = 'enabled' | 'disabled' | 'absent'

interface UprojectData {
  Plugins?: Array<{ Name?: string; Enabled?: boolean }>
}

/**
 * `.uproject` 的 `Plugins` 数组里这个插件写成了什么。
 *
 * 大小写不敏感地匹配：UE 自己写进去的是插件的规范名，但用户手改过的项目文件里
 * 什么都可能有，而 `FindPlugin` 那侧已经把名字归一过了。
 */
export function pluginStateIn(data: UprojectData, pluginName: string): UprojectPluginState {
  const entries = Array.isArray(data.Plugins) ? data.Plugins : []
  const target = pluginName.toLowerCase()
  const entry = entries.find((p) => typeof p?.Name === 'string' && p.Name.toLowerCase() === target)
  if (!entry) return 'absent'
  return entry.Enabled === true ? 'enabled' : 'disabled'
}

/**
 * 磁盘上的状态和「刚才要求的状态」对不对得上。
 *
 * `absent` 需要单独说一句：UE 在**目标状态和默认状态一致**时会把条目删掉
 * （`FProjectManager::SetPluginEnabled` 尾部那段），所以「没有条目」有时候
 * 恰恰是正确结果。只有引擎告诉了我们默认值（`default_enabled`）才能这么判；
 * 老插件包给不出这个字段，那就只能按「没写进去」处理 —— 对老包来说这个结论
 * 几乎总是对的，因为它们的引擎侧压根不落盘。
 */
export function isDiskStateConsistent(
  state: UprojectPluginState,
  wantEnabled: boolean,
  defaultEnabled?: boolean
): boolean {
  if (state === 'enabled') return wantEnabled
  if (state === 'disabled') return !wantEnabled
  return defaultEnabled === undefined ? false : defaultEnabled === wantEnabled
}

/** 读 `.uproject` 并解析出插件状态；读不出来就交代原因 */
export async function readUprojectPluginState(
  uprojectPath: string,
  pluginName: string
): Promise<{ state: UprojectPluginState } | { error: string }> {
  try {
    return { state: pluginStateIn(await readUeJsonFile<UprojectData>(uprojectPath), pluginName) }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 拿到当前项目 `.uproject` 的绝对路径。
 *
 * 新插件包直接在 manage_plugin 的响应里给；老包没有，回落到
 * `system.get_project_info`（这条命令一直都在）。两个来源都是引擎自己算的
 * 绝对路径，比盒子这边猜工程目录可靠。
 */
async function resolveUprojectPath(response: ManagePluginResponse): Promise<string | undefined> {
  const fromResponse = response.uproject_path
  if (typeof fromResponse === 'string' && fromResponse.toLowerCase().endsWith('.uproject')) {
    return fromResponse
  }

  try {
    const info = await serviceManager.getWebSocketService().callRequest<{
      project_path?: string
    }>('system.get_project_info', {}, getTargetConnectionId(), 15000)
    const path = info?.project_path
    if (typeof path === 'string' && path.toLowerCase().endsWith('.uproject')) return path
  } catch {
    // 拿不到就拿不到，下面会如实报「没能校验」
  }
  return undefined
}

// ============================================================================
// 工具定义
// ============================================================================

export function createManagePluginTool(): V2Tool {
  return defineV2Tool({
    description: `查询或修改虚幻引擎插件状态，支持启用/禁用并返回是否需要重启。

【典型用途】：
- 导入 GLB/GLTF/PLY/USD 等特殊格式时，检查并启用对应插件（如 GLTFImporter、USDImporter）
- 需要 Python 能力时启用 PythonScriptPlugin
- 排查插件是否已启用，避免重复提示用户转换格式

【注意事项】：
- 启用或禁用插件后通常需要重启编辑器才能生效
- 建议先 Query 再 Enable，避免重复操作
- 启用/禁用会改写项目的 .uproject，改完会重新读一遍文件确认写进去了；
  返回 success=false 就是**真的没生效**，别让用户去重启`,

    inputSchema: ManagePluginParamsSchema,

    execute: async (input) => {
      console.log('[ManagePluginTool] 收到请求:', input)

      try {
        const wsService = serviceManager.getWebSocketService()
        if (wsService.getConnectionCount() === 0) {
          return {
            success: false,
            error: UE_NOT_CONNECTED_MESSAGE
          }
        }

        const response = await wsService.callRequest<ManagePluginResponse>(
          'system.manage_plugin',
          {
            plugin_name: input.plugin_name,
            action: input.action ?? 'Query'
          },
          getTargetConnectionId(),
          30000
        )

        console.log('[ManagePluginTool] 收到响应:', response)

        if (!response) {
          return {
            success: false,
            error: '服务未返回有效数据'
          }
        }

        // RPC 错误响应透传（如插件不存在 / 不支持 action / 落盘失败）
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rpcOk = (response as any)?.ok
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rpcSuccess = (response as any)?.success
        if (rpcOk === false || rpcSuccess === false) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const msg = (response as any)?.error || (response as any)?.message || '插件管理失败'
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const code = (response as any)?.__rpc?.code ?? (response as any)?.code
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const details = (response as any)?.details
          return { success: false, error: `插件管理失败：${msg}`, code, details, raw: response }
        }

        const action = input.action ?? 'Query'
        const pluginName = response.plugin_name || input.plugin_name

        // 回读校验。Enable / Disable 一律做，不看运行时状态：
        // 插件启停要重启才生效，运行时状态和 .uproject 经常对不上。刚 disable 过、
        // 还没重启时 is_enabled 仍是 true —— 这时再 enable，以前按「运行时已是目标」
        // 跳过校验直接报「插件已启用」，而磁盘上还挂着那条 disable，重启后插件照样被关。
        const wantEnabled = action === 'Enable'
        const needsVerify = action !== 'Query'
        if (needsVerify) {
          const uprojectPath = await resolveUprojectPath(response)
          if (!uprojectPath) {
            return {
              success: false,
              plugin_name: pluginName,
              error:
                `已向编辑器发出${wantEnabled ? '启用' : '禁用'}插件 ${pluginName} 的请求，` +
                '但拿不到项目 .uproject 的路径，无法确认改动是否真的写进了项目文件。' +
                '请手动打开 .uproject 检查 Plugins 数组，不要直接重启编辑器。'
            }
          }

          const read = await readUprojectPluginState(uprojectPath, pluginName)
          if ('error' in read) {
            return {
              success: false,
              plugin_name: pluginName,
              uproject_path: uprojectPath,
              error:
                `已向编辑器发出${wantEnabled ? '启用' : '禁用'}插件 ${pluginName} 的请求，` +
                `但读不回 ${uprojectPath} 来确认：${read.error}`
            }
          }

          // 老插件包不给 default_enabled：.uproject 里没有条目时判断不了默认状态。
          // 运行中的编辑器已经是目标状态时，最可能是「默认就这样、从没写过条目」，
          // 不能判成失败；但也没法确认，照实说
          if (
            read.state === 'absent' &&
            response.default_enabled === undefined &&
            response.is_enabled === wantEnabled
          ) {
            return {
              success: true,
              plugin_name: pluginName,
              is_enabled: response.is_enabled,
              requires_restart: false,
              friendly_name: response.friendly_name,
              uproject_path: uprojectPath,
              uproject_state: read.state,
              uproject_verified: false,
              message:
                `编辑器里插件 ${pluginName} 当前是${wantEnabled ? '启用' : '禁用'}的，` +
                '.uproject 里没有它的条目（按引擎默认状态走）。当前插件包给不出默认状态，' +
                '没法确认重启后是否仍是这样。'
            }
          }

          if (!isDiskStateConsistent(read.state, wantEnabled, response.default_enabled)) {
            return {
              success: false,
              plugin_name: pluginName,
              uproject_path: uprojectPath,
              uproject_state: read.state,
              error:
                `插件 ${pluginName} **没有**${wantEnabled ? '启用' : '禁用'}成功：` +
                `编辑器回了成功，但回读 ${uprojectPath} 发现 Plugins 数组里` +
                (read.state === 'absent'
                  ? '根本没有这一条'
                  : `这一条仍然是 ${read.state === 'enabled' ? '启用' : '禁用'}`) +
                '。重启编辑器不会有任何效果。' +
                '常见原因：项目里装的是旧版 UnrealAgentLink 插件包（旧版只改内存不写文件），' +
                '或者 .uproject 是只读的（版本控制没签出）。'
            }
          }

          // 运行中的编辑器已经是目标状态时，磁盘也对得上就没有东西等着重启生效
          const needsRestart = response.is_enabled !== wantEnabled
          return {
            success: true,
            plugin_name: pluginName,
            is_enabled: response.is_enabled,
            requires_restart: needsRestart,
            friendly_name: response.friendly_name,
            uproject_path: uprojectPath,
            uproject_state: read.state,
            message:
              `插件已在 .uproject 里${wantEnabled ? '启用' : '禁用'}（已回读文件确认）；` +
              (needsRestart ? '需要重启编辑器以生效' : '运行中的编辑器也已是这个状态，不用重启')
          }
        }

        // 走到这里只剩 Query：Enable / Disable 都在上面按回读结果返回了
        const messageParts: string[] = [response.is_enabled ? '插件已启用' : '插件未启用']

        if (response.requires_restart) {
          messageParts.push('需要重启编辑器以生效')
        }

        if (response.message) {
          messageParts.push(response.message)
        }

        return {
          success: true,
          plugin_name: pluginName,
          is_enabled: response.is_enabled,
          requires_restart: response.requires_restart,
          friendly_name: response.friendly_name,
          message: messageParts.join('；')
        }
      } catch (error) {
        console.error('[ManagePluginTool] 执行失败:', error)
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  })
}
