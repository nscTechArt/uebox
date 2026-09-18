/**
 * 插件能力探测 —— 写用户工程之前必须过的那道闸。
 *
 * ## 为什么加了参数还不够
 *
 * 插件解析 payload 一律是「认识就读、不认识跳过」（`TryGetBoolField`）。
 * 盒子发一个 `require_empty` 过去，**旧版插件根本不知道它是什么，
 * 也不会因此拒绝执行** —— 盒子以为自己开了保险，插件照写不误。
 *
 * 而插件装在**用户的 UE 工程**里，不随盒子升级：盒子更新到最新，
 * 用户工程里那份可能还是半年前的。「我编过新版 ZIP」和「用户此刻连着的
 * 是新版插件」是两件事。
 *
 * ## 失败即关
 *
 * 字段为 false、字段不存在、整个 `capabilities` 不存在、探测调用本身失败 ——
 * **一律当作不支持**。旧插件的表现恰恰是「什么都不说」，把沉默当默许
 * 等于这道闸从来没关过。
 *
 * 选 `system.get_project_info` 来问，是因为**旧插件也答得上它**（老命令），
 * 所以「答得上但没有 capabilities」能被干净地识别成「插件太旧」，
 * 而不是和「没连上引擎」混成一团。
 */

import { serviceManager } from '../../services'
import { getTargetConnectionId } from '../../agent-v3/core/projectTargetContext'

/** 每一项对应插件里一段具体的保护代码，不是版本号 */
export interface PluginCapabilities {
  /** blueprint.create_graph 支持 require_empty：目标图不空就一个节点都不建 */
  blueprint_require_empty?: boolean
  /** material.create 支持 fail_if_exists：同名不覆盖，直接报错返回 */
  material_fail_if_exists?: boolean
}

export type CapabilityName = keyof PluginCapabilities

interface ProjectInfoResponse {
  plugin_version?: string
  plugin_build?: string
  capabilities?: PluginCapabilities
}

export interface CapabilityCheck {
  /** 只有明确探到 true 才是 true */
  supported: boolean
  /** 给用户看的原因；supported 为 true 时是空串 */
  reason: string
  pluginVersion?: string
  pluginBuild?: string
}

const PROBE_TIMEOUT_MS = 10_000

/** 给用户看的能力说明，出现在「插件太旧」的提示里 */
const CAPABILITY_LABEL: Record<CapabilityName, string> = {
  blueprint_require_empty: '写图前在引擎内确认目标图为空',
  material_fail_if_exists: '新建材质时同名不覆盖'
}

/**
 * 问一次插件支不支持某项保护。
 *
 * **不缓存。** 用户可能在盒子开着的时候更新插件、或者切到另一个工程，
 * 缓存住一个旧答案的后果是「明明升级了还说太旧」，或者更糟 ——
 * 「切到一个装着旧插件的工程，却还用着上一个工程的能力位」。
 * 这条查询很便宜，每次写入前问一遍。
 */
export async function checkPluginCapability(
  capability: CapabilityName,
  /**
   * 探哪一条连接。**调用方要写用户资产时必须显式传**，而且后面每一条命令
   * 都得发给同一个 id。
   *
   * 不传就退回 `getTargetConnectionId()` —— 但那个函数每次调用都会重新解析、
   * 连接掉了会自愈到同工程的新连接。对只读工具没问题，对「探完再写」是致命的：
   * 探的是 A、写的可能是 B，而 B 那头的插件版本没人验过。
   */
  connectionId?: string
): Promise<CapabilityCheck> {
  const wsService = serviceManager.getWebSocketService()

  if (wsService.getConnectionCount() === 0) {
    return {
      supported: false,
      reason: '没有连上虚幻编辑器。请打开工程，并确认 UnrealAgentLink 插件已连接。'
    }
  }

  const target = connectionId ?? getTargetConnectionId()

  let response: ProjectInfoResponse | null = null
  try {
    response = await wsService.callRequest<ProjectInfoResponse>(
      'system.get_project_info',
      {},
      target,
      PROBE_TIMEOUT_MS
    )
  } catch (error) {
    // 探测本身失败也算不支持 —— 「问不到」不等于「有」
    return {
      supported: false,
      reason: `探测插件能力失败：${error instanceof Error ? error.message : String(error)}`
    }
  }

  if (!response) {
    return { supported: false, reason: '插件没有响应（system.get_project_info）' }
  }

  const pluginVersion = response.plugin_version
  const pluginBuild = response.plugin_build

  // 关键分支：答得上 get_project_info、但没有 capabilities —— 这就是旧插件。
  // 不能当成「没查到，先试试」。
  if (!response.capabilities || typeof response.capabilities !== 'object') {
    return {
      supported: false,
      reason:
        `工程里的 UnrealAgentLink 插件版本太旧${pluginVersion ? `（${pluginVersion}）` : ''}，` +
        `没有「${CAPABILITY_LABEL[capability]}」这道保护。请在设置里更新插件后再试。`,
      pluginVersion,
      pluginBuild
    }
  }

  if (response.capabilities[capability] !== true) {
    return {
      supported: false,
      reason:
        `工程里的 UnrealAgentLink 插件不支持「${CAPABILITY_LABEL[capability]}」` +
        `${pluginVersion ? `（当前版本 ${pluginVersion}）` : ''}。请更新插件后再试。`,
      pluginVersion,
      pluginBuild
    }
  }

  return { supported: true, reason: '', pluginVersion, pluginBuild }
}
