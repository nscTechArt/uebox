/**
 * 获取虚幻引擎项目信息工具
 * 通过 WebSocket 向虚幻引擎插件发送项目信息查询命令（兼容不同插件版本）
 * - editor.get_project_info（优先）
 * - project.info（fallback）
 * 返回项目名称、路径、版本、模块列表等信息
 */

import { defineV2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import { serviceManager } from '../../../../services'
import UnrealPathManagerUtil from '../../../../utils/UnrealPathManager'

import { getTargetConnectionId } from '../../../core/projectTargetContext'
import { UE_NOT_CONNECTED_MESSAGE } from '../../defineUeTool'
// ============================================================================
// Schema 定义
// ============================================================================

/**
 * 获取项目信息请求参数。
 *
 * 原来这是个空对象 —— 和另一个同样不收参数的 `ue_analyze_uproject` 并列在
 * 工具池里，两个都「无需参数、返回模块和插件」，模型没有任何依据在它们之间
 * 选。差别只在实现（一个走 project.get_info，一个解析 .uproject 文件），
 * 而实现差异不该暴露成两个工具。
 *
 * 合并后唯一需要保留的是 .uproject 那边独有的「禁用插件清单」，
 * 做成一个开关：要盘点插件时才多发一次请求。
 */
const GetProjectInfoSchema = z.object({
  include_disabled_plugins: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      '是否连**禁用**的插件一起列出来（默认 false，只返回已启用的）。' +
        '做插件盘点、精简项目时才需要打开 —— 会多解析一次 .uproject 文件'
    )
})

// ============================================================================
// 类型定义
// ============================================================================

/** 项目信息响应数据 (UE 插件返回) */
interface ProjectInfoResponse {
  projectName: string
  projectPath: string
  projectFile: string
  contentDir: string
  configDir: string
  savedDir: string
  pluginsDir: string
  projectVersion?: string
  engineVersion: string
  engineAssociation?: string
  /**
   * 引擎装在哪、引擎源码在哪、工程源码在哪，以及这个工程有没有 C++。
   *
   * 这四条是给**写 C++** 用的，不是给展示用的：
   *
   *   - `engineSourceDir` 让 `grep_local_files` 能去核对一个 UE API 的真实签名。
   *     UE 的 API 在 5.0–5.8 之间会漂，而模型的记忆停在某个版本 —— 不给这条路径，
   *     它只能凭记忆写，编不过算走运，编过了但行为不对才是坏结果。
   *   - `hasCode` 为 false 时**不要试图加 C++ 类**：引擎那条路在工程原先没有代码时
   *     会弹模态对话框，而命令跑在游戏线程上，弹出来就是编辑器和这次调用一起卡死。
   *
   * 老插件不返回这四个字段，所以全是可选的。
   */
  engineDir?: string
  engineSourceDir?: string
  projectSourceDir?: string
  hasCode?: boolean
  /** 当前跑着的插件是从哪份源码编出来的（出包时写进 .ual-build 的指纹） */
  pluginBuild?: string
  /** 这份引擎能不能跑 Python（IPythonScriptPlugin::IsPythonAvailable）。老插件不回 */
  pythonAvailable?: boolean
  defaultMap?: string
  editorStartupMap?: string
  globalDefaultGameMode?: string
  transitionMap?: string
  currentLevelName?: string
  currentLevelPath?: string
  naniteEnabled?: boolean
  lumenGIEnabled?: boolean
  lumenReflectionsEnabled?: boolean
  dynamicGIMethod?: string
  reflectionMethod?: string
  companyName?: string
  projectId?: string
  supportContact?: string
  targetPlatforms?: string[]
  modules?: string[]
  enabledPlugins?: Array<{
    name: string
    versionName: string
    category: string
    baseDir: string
  }>
}

/**
 * 插件新不新、Python 能不能用 —— 两件在会话开头就该讲清楚的事。
 *
 * 新用户那一轮：装的插件比盒子自带的旧，Python 因此永远失败，模型把
 * 一整段时间花在改 .uproject、重启编辑器上，方向从头就是错的。
 * 这两个字段让它在第一次问工程信息时就知道该绕开什么、该让用户更新什么。
 *
 * 指纹比不了（老插件不回、自编译引擎定位不到随包 zip）就说「无法判断」，
 * 不猜「是新的」。
 */
export function describePluginState(response: {
  engineVersion?: string
  pluginBuild?: string
  pythonAvailable?: boolean
}): {
  pluginUpToDate?: boolean
  pluginHint?: string
  pythonAvailable?: boolean
  pythonHint?: string
} {
  const out: ReturnType<typeof describePluginState> = {}

  // 读不到随包指纹（没有对应版本的 zip、不在 Electron 里）就当「无法判断」，
  // 绝不能让它把整个工程信息查询拖垮
  let bundled: string | null = null
  try {
    bundled = response.engineVersion
      ? UnrealPathManagerUtil.readBundledPluginFingerprint(response.engineVersion)
      : null
  } catch {
    bundled = null
  }
  if (!response.pluginBuild) {
    out.pluginUpToDate = false
    out.pluginHint =
      '工程里的 UnrealAgentLink 插件太旧，连构建指纹都不上报。让用户在盒子设置里更新插件后重启编辑器，' +
      '否则新工具的行为都对不上。'
  } else if (response.pluginBuild === 'unknown') {
    // 插件在没有 .ual-build 戳的时候发的是字面量 "unknown"（宿主工程里直接编的、
    // 或旧 zip 装的）。这是「不知道」，不是「旧」—— 按旧处理会让人把刚编的开发版覆盖掉
    out.pluginHint =
      '工程里的 UnrealAgentLink 插件没有构建指纹（本机直接编译的，或旧包装的），无法判断新旧。' +
      '工具行为和描述对不上时再考虑更新，不要仅凭这一条让用户重装。'
  } else if (bundled) {
    out.pluginUpToDate = response.pluginBuild === bundled
    if (!out.pluginUpToDate) {
      // 指纹是内容哈希，比不出先后：可能更旧，也可能是本机刚编的更新版本
      out.pluginHint =
        '工程里跑着的 UnrealAgentLink 插件和盒子自带的不是同一份构建，可能更旧，也可能是本机刚编的。' +
        '碰到工具行为和描述对不上时先确认哪份更新，再决定是否让用户在盒子设置里更新插件并重启编辑器。'
    }
  }

  if (response.pythonAvailable !== undefined) {
    out.pythonAvailable = response.pythonAvailable
    if (!response.pythonAvailable) {
      out.pythonHint =
        '这份引擎没有可用的 Python，ue_run_python_script 一定失败。用专用工具做，不要去启插件或重启编辑器。'
    }
  }

  return out
}

// ============================================================================
// 工具定义
// ============================================================================

/**
 * 创建获取项目信息工具
 * @returns 获取项目信息工具实例
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createGetProjectInfoTool() {
  return defineV2Tool({
    description: `获取当前虚幻引擎项目的详细信息。

【功能说明】：
- 获取项目名称、路径、版本等基础信息
- 获取引擎版本和关联信息
- 获取项目模块和启用的插件列表
- 获取地图配置和渲染设置

【无需参数】：直接调用即可

【返回数据】：
- projectName: 项目名称
- projectPath: 项目根目录路径
- engineVersion: 引擎版本
- currentLevelName: 当前打开的关卡名称
- currentLevelPath: 当前关卡完整路径
- defaultMap: 游戏默认关卡（打包后启动的关卡）
- editorStartupMap: 编辑器启动关卡
- globalDefaultGameMode: 全局默认游戏模式
- transitionMap: 场景切换过渡关卡
- naniteEnabled: Nanite 是否启用（读的就是 DefaultEngine.ini 的
  r.Nanite.ProjectEnabled，和 ue_get_config 同一个值，不会对不上。
  它只说"工程开没开这个开关"，不说"有没有模型真的在用" —— 后者问 ue_content_audit_optimization）
- lumenGIEnabled: Lumen 全局光照是否启用
- lumenReflectionsEnabled: Lumen 反射是否启用
- pluginBuild: UnrealAgentLink 插件的构建指纹（改完插件代码验证时，先确认这个值是新的）
- pluginUpToDate: 工程里的插件是不是盒子自带的那一份；false 时 pluginHint 里写了该让用户做什么
- pythonAvailable: 这份引擎能不能跑 Python；false 就别用 ue_run_python_script，也别去启插件
- engineDir / engineSourceDir: 引擎安装目录 / 引擎源码目录（绝对路径）
- projectSourceDir: 工程 C++ 源码目录（绝对路径）
- hasCode: 这个工程有没有 C++ 代码
- modules: 项目模块列表
- enabledPlugins: 启用的插件列表
- disabled_plugins: 禁用的插件列表（仅当 include_disabled_plugins=true）
- target_platforms: 目标平台列表

【什么时候用】：
- 需要知道当前是哪个工程、什么引擎版本、开着哪张关卡
- 检查 Nanite / Lumen 等渲染设置
- 盘点模块和插件（想连禁用的插件一起看，把 include_disabled_plugins 设为 true）
- **动手写 UE C++ 之前先调一次**：拿 engineSourceDir 去 grep 引擎头文件核对 API 的
  真实签名（UE 的 API 在版本之间会变，不要凭记忆写）；拿 hasCode 判断这个工程
  能不能加 C++ 类 —— 为 false 说明是纯蓝图工程，要先请用户在编辑器里手动加一次

【注意】：若 defaultMap 为空，说明项目未在 Project Settings → Maps & Modes 中设置 Game Default Map。`,

    inputSchema: GetProjectInfoSchema,

    execute: async (input) => {
      console.log('[GetProjectInfoTool] 收到请求:', input)

      try {
        const wsService = serviceManager.getWebSocketService()
        if (wsService.getConnectionCount() === 0) {
          return {
            success: false,
            error: UE_NOT_CONNECTED_MESSAGE
          }
        }

        // 兼容：不同插件版本可能使用不同 method
        // - 新/期望：editor.get_project_info
        // - 旧/当前插件：project.info
        const tryCall = async (method: string): Promise<ProjectInfoResponse> => {
          console.log(`[GetProjectInfoTool] 发送 ${method} 请求`)
          return await wsService.callRequest<ProjectInfoResponse>(
            method,
            {},
            getTargetConnectionId(),
            10000
          )
        }

        let response = await tryCall('editor.get_project_info')

        // 若插件不支持 editor.get_project_info，则降级到 project.info
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const firstRpcOk = (response as any)?.ok
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const firstRpcSuccess = (response as any)?.success
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const firstCode = (response as any)?.__rpc?.code ?? (response as any)?.code
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const firstMsg = (response as any)?.error || (response as any)?.message

        const isUnknownMethod =
          (firstRpcOk === false || firstRpcSuccess === false) &&
          firstCode === 404 &&
          typeof firstMsg === 'string' &&
          firstMsg.includes('Unknown method')

        if (isUnknownMethod) {
          response = await tryCall('project.info')
        }

        console.log('[GetProjectInfoTool] 收到响应:', response ? '成功' : '无数据')

        if (response) {
          // RPC 错误响应透传
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const rpcOk = (response as any)?.ok
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const rpcSuccess = (response as any)?.success
          if (rpcOk === false || rpcSuccess === false) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const msg = (response as any)?.error || (response as any)?.message || '获取项目信息失败'
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const code = (response as any)?.__rpc?.code ?? (response as any)?.code
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const details = (response as any)?.details
            return {
              success: false,
              error: `获取项目信息失败：${msg}`,
              code,
              details,
              raw: response
            }
          }

          // 要禁用插件清单时才多解析一次 .uproject。
          // 拿不到就算了 —— 主查询的结果是完整的，不该因为附加信息失败而整个作废
          let disabledPlugins: unknown[] | undefined
          if (input.include_disabled_plugins) {
            try {
              const analyzed = await wsService.callRequest<{
                plugins?: Array<{ enabled?: boolean }>
              }>('project.analyze_uproject', {}, getTargetConnectionId(), 10000)
              disabledPlugins = analyzed?.plugins?.filter((p) => !p.enabled)
            } catch (error) {
              console.warn('[GetProjectInfoTool] 解析 .uproject 取禁用插件失败:', error)
            }
          }

          const pluginState = describePluginState(response)
          const hints = [pluginState.pluginHint, pluginState.pythonHint].filter(Boolean)

          return {
            success: true,
            ...(disabledPlugins
              ? { disabled_plugins: disabledPlugins, disabled_plugin_count: disabledPlugins.length }
              : {}),
            projectName: response.projectName,
            projectPath: response.projectPath,
            projectFile: response.projectFile,
            contentDir: response.contentDir,
            configDir: response.configDir,
            savedDir: response.savedDir,
            pluginsDir: response.pluginsDir,
            projectVersion: response.projectVersion,
            engineVersion: response.engineVersion,
            engineAssociation: response.engineAssociation,
            /*
             * 引擎与源码位置。老插件不返回，此时留空而不是编一个出来 ——
             * 给模型一个猜出来的路径，它会拿去 grep，然后拿到「目录不存在」，
             * 再花一轮去猜下一个。说「不知道」比猜错便宜。
             */
            engineDir: response.engineDir,
            engineSourceDir: response.engineSourceDir,
            projectSourceDir: response.projectSourceDir,
            hasCode: response.hasCode,
            /*
             * 插件构建指纹。
             *
             * 排查「改了代码但行为没变」时，第一件要确认的事就是**跑着的插件
             * 到底是不是刚编的那份**。真为此白跑过一整轮回归：代码改了、没出包，
             * 测试在旧 DLL 上跑出「修复未生效」，接下来整轮都在找不存在的 bug。
             * 旧插件不返回这个字段，那本身就说明它是旧的。
             */
            pluginBuild: response.pluginBuild ?? '未知（插件较旧，不上报构建指纹）',
            // 插件新不新、Python 能不能用：会话开头就要讲清楚，别让模型撞上去才知道
            ...pluginState,
            // 地图配置
            currentLevelName: response.currentLevelName,
            currentLevelPath: response.currentLevelPath,
            defaultMap: response.defaultMap,
            editorStartupMap: response.editorStartupMap,
            globalDefaultGameMode: response.globalDefaultGameMode,
            transitionMap: response.transitionMap,
            // 渲染设置
            naniteEnabled: response.naniteEnabled,
            lumenGIEnabled: response.lumenGIEnabled,
            lumenReflectionsEnabled: response.lumenReflectionsEnabled,
            dynamicGIMethod: response.dynamicGIMethod,
            reflectionMethod: response.reflectionMethod,
            // 项目设置
            companyName: response.companyName,
            projectId: response.projectId,
            supportContact: response.supportContact,
            targetPlatforms: response.targetPlatforms,
            modules: response.modules,
            enabledPlugins: response.enabledPlugins,
            pluginCount: response.enabledPlugins?.length || 0,
            moduleCount: response.modules?.length || 0,
            message:
              `项目 "${response.projectName}" 信息获取成功，引擎版本 ${response.engineVersion}` +
              (hints.length ? `\n⚠️ ${hints.join('\n⚠️ ')}` : '')
          }
        }

        return {
          success: false,
          error: '服务未返回有效数据'
        }
      } catch (error) {
        console.error('[GetProjectInfoTool] 执行失败:', error)
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  })
}
