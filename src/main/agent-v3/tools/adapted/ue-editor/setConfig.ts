/**
 * 设置项目配置工具
 * 通过 WebSocket 向虚幻引擎插件发送配置写入命令
 * 支持修改 DefaultEngine.ini、DefaultGame.ini 等配置文件
 */

import { defineV2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import { serviceManager } from '../../../../services'
import { UE_NOT_CONNECTED_MESSAGE } from '../../defineUeTool'

// ============================================================================
// Schema 定义
// ============================================================================

/**
 * 设置配置请求参数
 */
const SetConfigSchema = z.object({
  config_name: z
    .enum(['Engine', 'Game', 'Editor', 'EditorPerProjectUserSettings'])
    .describe('配置文件名称'),
  section: z.string().describe('配置节名称，如 /Script/Engine.RendererSettings'),
  key: z.string().describe('配置项键名，如 r.Nanite.ProjectEnabled'),
  value: z.string().describe('配置项值，统一传字符串格式（如 "True", "False", "1", "0" 等）')
})

// ============================================================================
// 类型定义
// ============================================================================

/** 配置设置响应数据 */
interface SetConfigResponse {
  config_name: string
  section: string
  key: string
  /**
   * 新插件：写完、刷盘之后从 GConfig 读回来的值（read_back=true 时才有）。
   * 老插件：请求里的 value 原样回显，并不代表引擎里是这个值
   */
  value?: string
  file_path: string
  /** 新插件才有。老插件缺这几个字段，据此判断 value 是不是回显 */
  read_back?: boolean
  requested_value?: string
  /** 刷盘后配置文件是否已不脏（= 真写到磁盘上了） */
  persisted?: boolean
  /**
   * 新插件（2026-09-26 起）才有：怎么写进工程的 Default*.ini 的。
   * settings_object = 走设置类，和项目设置界面同一条路，编辑器里当场生效；
   * ini = 只写了文件里这一个键。有这个字段时 value / persisted 都是**从磁盘上的
   * Default*.ini 读回来**的，插件已经按引擎的规范写法核对过。
   */
  via?: 'settings_object' | 'ini'
  applied_live?: boolean
}

// ============================================================================
// 工具定义
// ============================================================================

/**
 * 创建设置配置工具
 * @returns 设置配置工具实例
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createSetConfigTool() {
  return defineV2Tool({
    description: `修改项目配置文件中的配置项值，并立即刷新到磁盘。

【功能说明】：
- 修改 DefaultEngine.ini、DefaultGame.ini 等配置文件中的配置项
- 支持修改渲染设置、打包设置、平台设置等
- 修改后自动刷新到磁盘

【参数说明】：
- config_name: 配置文件名称（Engine/Game/Editor/EditorPerProjectUserSettings）
- section: 配置节名称，如 /Script/Engine.RendererSettings
- key: 配置项键名，如 r.Nanite.ProjectEnabled
- value: 配置项值，统一传字符串（如 "True", "False", "1", "0", "Lumen" 等）

【常用配置项】：
- r.Nanite.ProjectEnabled: 设置 Nanite 是否启用（"True"/"False"）
- r.Lumen.Enabled: 设置 Lumen 是否启用（"True"/"False"）
- r.DynamicGlobalIlluminationMethod: 设置全局光照方法（"Lumen"/"None"）
- bShareMaterialShaderCode: 是否共享材质着色器代码（"True"/"False"）
- bCreateCompressedCookedPackages: 是否创建压缩的 Cooked 包（"True"/"False"）

【注意事项】：
- 写的是工程的 Config/Default*.ini（跟着工程走、进打包），EditorPerProjectUserSettings 除外（本机设置）
- 返回里 applied_live=false 时，已经加载的设置要重启编辑器才会看到
- 某些配置项修改后需要重新构建项目`,

    inputSchema: SetConfigSchema,

    execute: async ({ config_name, section, key, value }) => {
      console.log('[SetConfigTool] 收到请求:', { config_name, section, key, value })

      try {
        const wsService = serviceManager.getWebSocketService()
        if (wsService.getConnectionCount() === 0) {
          return {
            success: false,
            error: UE_NOT_CONNECTED_MESSAGE
          }
        }

        const response = await wsService.callRequest<SetConfigResponse>(
          'project.set_config',
          { config_name, section, key, value },
          undefined,
          10000
        )

        console.log('[SetConfigTool] 收到响应:', response ? '成功' : '无数据')

        if (response) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const rpcOk = (response as any)?.ok
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const rpcSuccess = (response as any)?.success
          if (rpcOk === false || rpcSuccess === false) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const msg = (response as any)?.error || (response as any)?.message || '设置配置失败'
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const code = (response as any)?.__rpc?.code ?? (response as any)?.code
            // 插件在回读对不上 / 刷盘失败时把回读结果放在 details 里，一起交给模型
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const details = (response as any)?.details as Partial<SetConfigResponse> | undefined
            const readBackNote =
              details && details.read_back === true && details.value !== undefined
                ? `\n引擎里现在的值：${details.value}`
                : ''
            return {
              success: false,
              error: `设置配置失败：${msg}${readBackNote}`,
              code
            }
          }

          // 新插件：写进工程的 Default*.ini，并从磁盘读回、按引擎的规范写法核对过。
          // 规范写法可能和请求不逐字相同（true → True），所以这里信插件的 persisted
          if (response.via) {
            if (response.persisted !== true) {
              return {
                success: false,
                error: `设置配置失败：[${section}] ${key} 没写进 ${response.file_path}`
              }
            }
            return {
              success: true,
              config_name: response.config_name,
              section: response.section,
              key: response.key,
              value: response.value,
              file_path: response.file_path,
              verified: true,
              applied_live: response.applied_live === true,
              message:
                `配置项 "${key}" 已写进工程设置文件 ${response.file_path}，读回的值：${response.value}。` +
                (response.applied_live
                  ? '编辑器里已经生效。'
                  : '已经加载的设置要重启编辑器才会看到。')
            }
          }

          // 老插件没有 read_back 字段，它回的 value 只是请求的回显，不能当成引擎里的值报
          if (response.read_back === undefined) {
            return {
              success: true,
              config_name: response.config_name,
              section: response.section,
              key: response.key,
              requested_value: value,
              file_path: response.file_path,
              verified: false,
              message:
                `已请求把配置项 "${key}" 设为 ${value}，但当前插件版本不回读，` +
                '写没写进去未经引擎确认。需要确认时用 ue_get_config 读一次。'
            }
          }

          // 新插件回读成功才会走到这里；仍按回读值再核一遍，对不上就不说成功
          if (
            response.read_back !== true ||
            response.value !== value ||
            response.persisted === false
          ) {
            return {
              success: false,
              error:
                response.read_back !== true
                  ? `设置配置失败：写入后读不回 [${section}] ${key}`
                  : response.value !== value
                    ? `设置配置失败：请求的是 ${value}，引擎读回的是 ${response.value}`
                    : `设置配置失败：[${section}] ${key} 只改在内存里，没写到磁盘，重启编辑器就会丢`
            }
          }

          return {
            success: true,
            config_name: response.config_name,
            section: response.section,
            key: response.key,
            value: response.value,
            file_path: response.file_path,
            verified: true,
            message: `配置项 "${key}" 已写入磁盘，引擎读回的值: ${response.value}`
          }
        }

        return {
          success: false,
          error: '服务未返回有效数据'
        }
      } catch (error) {
        console.error('[SetConfigTool] 执行失败:', error)
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  })
}
