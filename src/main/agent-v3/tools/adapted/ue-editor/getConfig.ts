/**
 * 读取项目配置工具
 * 通过 WebSocket 向虚幻引擎插件发送配置读取命令
 * 支持读取 DefaultEngine.ini、DefaultGame.ini 等配置文件
 */

import { defineV2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import { serviceManager } from '../../../../services'
import { UE_NOT_CONNECTED_MESSAGE } from '../../defineUeTool'

// ============================================================================
// Schema 定义
// ============================================================================

/**
 * 读取配置请求参数
 */
const GetConfigSchema = z.object({
  config_name: z
    .enum(['Engine', 'Game', 'Editor', 'EditorPerProjectUserSettings'])
    .describe('配置文件名称'),
  section: z.string().describe('配置节名称，如 /Script/Engine.RendererSettings'),
  key: z.string().describe('配置项键名，如 r.DynamicGlobalIlluminationMethod')
})

// ============================================================================
// 类型定义
// ============================================================================

/** 配置读取响应数据 */
interface GetConfigResponse {
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
 * 创建读取配置工具
 * @returns 读取配置工具实例
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createGetConfigTool() {
  return defineV2Tool({
    description: `读取项目配置文件中的配置项值。

【功能说明】：
- 读取 DefaultEngine.ini、DefaultGame.ini 等配置文件中的配置项
- 支持读取渲染设置、打包设置、平台设置等
- 如果配置项不存在，返回空字符串（不是错误）

【参数说明】：
- config_name: 配置文件名称（Engine/Game/Editor/EditorPerProjectUserSettings）
- section: 配置节名称，如 /Script/Engine.RendererSettings
- key: 配置项键名，如 r.DynamicGlobalIlluminationMethod

【常用配置项】：
- r.Nanite.ProjectEnabled: Nanite 是否启用
- r.Lumen.Enabled: Lumen 是否启用
- r.DynamicGlobalIlluminationMethod: 全局光照方法（Lumen/None）
- bShareMaterialShaderCode: 是否共享材质着色器代码
- bCreateCompressedCookedPackages: 是否创建压缩的 Cooked 包`,

    inputSchema: GetConfigSchema,

    execute: async ({ config_name, section, key }) => {
      console.log('[GetConfigTool] 收到请求:', { config_name, section, key })

      try {
        const wsService = serviceManager.getWebSocketService()
        if (wsService.getConnectionCount() === 0) {
          return {
            success: false,
            error: UE_NOT_CONNECTED_MESSAGE
          }
        }

        const response = await wsService.callRequest<GetConfigResponse>(
          'project.get_config',
          { config_name, section, key },
          undefined,
          10000
        )

        console.log('[GetConfigTool] 收到响应:', response ? '成功' : '无数据')

        if (response) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const rpcOk = (response as any)?.ok
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const rpcSuccess = (response as any)?.success
          if (rpcOk === false || rpcSuccess === false) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const msg = (response as any)?.error || (response as any)?.message || '读取配置失败'
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const code = (response as any)?.__rpc?.code ?? (response as any)?.code
            return {
              success: false,
              error: `读取配置失败：${msg}`,
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
            message: `配置项 "${key}" 的值: ${response.value || '(空)'}`
          }
        }

        return {
          success: false,
          error: '服务未返回有效数据'
        }
      } catch (error) {
        console.error('[GetConfigTool] 执行失败:', error)
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  })
}
