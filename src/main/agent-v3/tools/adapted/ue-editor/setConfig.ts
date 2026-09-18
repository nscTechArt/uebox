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
  value: string
  file_path: string
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
- 修改配置后可能需要重启编辑器才能生效
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
            return {
              success: false,
              error: `设置配置失败：${msg}`,
              code
            }
          }

          return {
            success: true,
            config_name: response.config_name,
            section: response.section,
            key: response.key,
            value: response.value,
            file_path: response.file_path,
            message: `配置项 "${key}" 已设置为: ${response.value}`
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
