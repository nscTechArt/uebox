/**
 * 设置蓝图属性工具
 * 通过 WebSocket 向虚幻引擎插件发送 blueprint.set_property 命令
 * 支持修改蓝图默认值（CDO）和组件属性（SCS）
 */

import { defineV2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import { serviceManager } from '../../../../services'

import { getTargetConnectionId } from '../../../core/projectTargetContext'
import { UE_NOT_CONNECTED_MESSAGE } from '../../defineUeTool'
// ============================================================================
// Schema 定义
// ============================================================================

/**
 * 设置蓝图属性请求参数
 */
const SetBlueprintPropertySchema = z.object({
  blueprint_path: z.string().describe('蓝图路径（必填），如 /Game/Blueprints/BP_Hero'),
  component_name: z
    .string()
    .optional()
    .describe('组件名称（可选）。为空则修改蓝图默认值（CDO），填写则修改指定组件的属性'),
  // 使用 z.unknown() 以接受字符串或对象，后续在 execute 中做防御性解析
  properties: z
    .unknown()
    .describe('要设置的属性键值对。支持基础类型、结构体、颜色（0-1浮点数）、资源引用等'),
  auto_compile: z.boolean().optional().default(true).describe('是否自动编译蓝图（默认 true）')
})

// ============================================================================
// 类型定义
// ============================================================================

/** 修改成功的属性信息 */
interface ModifiedPropertyInfo {
  property: string
  type?: string
  /** 写完（编译后）从目标上读回来的值（ExportText）。旧版插件不带 */
  value?: string
}

/** 修改失败的属性信息 */
interface FailedPropertyInfo {
  property: string
  error: string
  suggestions?: string[]
}

/** 设置蓝图属性响应数据 (UE 插件返回) */
interface SetBlueprintPropertyResponse {
  ok: boolean
  blueprint_path: string
  blueprint_name: string
  target_type: 'cdo' | 'component'
  component_name?: string
  modified_properties: ModifiedPropertyInfo[]
  failed_properties: FailedPropertyInfo[]
  /** 编译是否真的通过（没要求编译时为 false） */
  compiled: boolean
  compile_status?: string
  saved: boolean
  /** 这次改动是否进了编辑器撤销栈 */
  undoable?: boolean
  message: string
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 解析 properties 输入（支持字符串或对象）
 * 防御性处理：AI 模型可能错误地将 properties 作为 JSON 字符串传递
 * @param rawProperties 原始 properties 输入
 * @returns 解析后的属性对象
 */
function parsePropertiesInput(rawProperties: unknown): Record<string, unknown> {
  if (typeof rawProperties === 'string') {
    try {
      const parsed = JSON.parse(rawProperties)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('properties 必须是对象')
      }
      console.log('[SetBlueprintPropertyTool] 检测到 properties 为字符串，已自动解析')
      return parsed as Record<string, unknown>
    } catch (e) {
      throw new Error(`properties 解析失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (typeof rawProperties !== 'object' || rawProperties === null || Array.isArray(rawProperties)) {
    throw new Error('properties 必须是对象')
  }
  return rawProperties as Record<string, unknown>
}

/** 每条失败属性一行：名字、原因、（有的话）插件给的近似名 */
function formatFailureReasons(failed: FailedPropertyInfo[]): string[] {
  return failed.map((p) => {
    const hint = p.suggestions?.length ? `（可能是：${p.suggestions.join('、')}）` : ''
    return `  - ${p.property}: ${p.error}${hint}`
  })
}

// ============================================================================
// 工具定义
// ============================================================================

/**
 * 创建设置蓝图属性工具
 * @returns 设置蓝图属性工具实例
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createSetBlueprintPropertyTool() {
  return defineV2Tool({
    description: `修改蓝图资产的属性（包括变量、默认值、组件设置）。

【功能说明】：
- 修改蓝图全局变量/默认值：将 component_name 留空
- 修改组件属性：将 component_name 设为组件名称（如 "PointLight"）

【高级数据类型支持】：
- 颜色：使用 0.0-1.0 的浮点数（如 {r:1, g:0, b:0}），工具会自动适配
- 资源引用：直接填写资源路径字符串（如 "/Game/Props/Chair"）
- 数组：提供完整的数组内容（全量覆盖）
- 结构体：只需提供要修改的字段，其他字段保持原值

【返回数据】：
- success: 全写成、编译过、已保存才为 true
- modified_properties: 值为写后读回的
- failed_properties: 失败项（含原因和建议）
- compiled / saved`,

    inputSchema: SetBlueprintPropertySchema,

    execute: async (input) => {
      console.log('[SetBlueprintPropertyTool] 收到请求:', input)

      try {
        // 防御性解析 properties（处理 AI 模型可能传递 JSON 字符串的情况）
        let properties: Record<string, unknown>
        try {
          properties = parsePropertiesInput(input.properties)
        } catch (parseError) {
          return {
            success: false,
            error: parseError instanceof Error ? parseError.message : String(parseError)
          }
        }

        // 校验 properties 不为空
        if (Object.keys(properties).length === 0) {
          return {
            success: false,
            error: 'properties 不能为空'
          }
        }

        const wsService = serviceManager.getWebSocketService()
        if (wsService.getConnectionCount() === 0) {
          return {
            success: false,
            error: UE_NOT_CONNECTED_MESSAGE
          }
        }

        // 构建请求参数（使用解析后的 properties）
        const params: Record<string, unknown> = {
          blueprint_path: input.blueprint_path,
          properties: properties
        }
        if (input.component_name) {
          params.component_name = input.component_name
        }
        if (input.auto_compile !== undefined) {
          params.auto_compile = input.auto_compile
        }

        console.log('[SetBlueprintPropertyTool] 发送 blueprint.set_property 请求:', params)

        const response = await wsService.callRequest<SetBlueprintPropertyResponse>(
          'blueprint.set_property',
          params,
          getTargetConnectionId(),
          30000
        )

        console.log('[SetBlueprintPropertyTool] 收到响应:', response ? '成功' : '无数据')

        const modified = Array.isArray(response?.modified_properties)
          ? response.modified_properties
          : []
        const failed = Array.isArray(response?.failed_properties) ? response.failed_properties : []

        /*
         * 只要有一项写成，这就是一份回执：写成的那几项必须告诉模型（不然它会再写一遍），
         * 没写成的也要。success 只在「全部写成 +（要求编译时）编译通过 + 存下盘」时为 true ——
         * 以前部分失败也回 success:true，模型读到成功就往下走了，失败那几项没人管。
         *
         * 不只信插件的 ok：旧版插件部分失败时 ok 也是 true，这里按回执内容再判一次。
         */
        if (response && (response.ok || modified.length > 0)) {
          const problems: string[] = []
          if (input.auto_compile !== false && response.compiled === false) {
            const status = response.compile_status ? `（${response.compile_status}）` : ''
            problems.push(`蓝图编译未通过${status}，用 blueprint_compile 查看错误`)
          }
          if (response.saved === false) {
            problems.push('改动只在内存里，未能保存到磁盘')
          }
          const success = response.ok && failed.length === 0 && problems.length === 0

          const result: Record<string, unknown> = {
            success,
            blueprint_name: response.blueprint_name,
            blueprint_path: response.blueprint_path,
            target_type: response.target_type,
            compiled: response.compiled,
            saved: response.saved,
            message: response.message
          }
          if (response.compile_status) {
            result.compile_status = response.compile_status
          }
          if (typeof response.undoable === 'boolean') {
            result.undoable = response.undoable
          }

          if (response.component_name) {
            result.component_name = response.component_name
          }

          // 成功修改的属性。value 是插件写完（编译后）从目标上读回来的，不是请求里的原样
          if (modified.length > 0) {
            result.modified_properties = modified.map((p) => ({
              name: p.property,
              type: p.type,
              ...(p.value !== undefined ? { value: p.value } : {})
            }))
            result.modified_count = modified.length
          }

          // 失败的属性（带建议）
          if (failed.length > 0) {
            result.failed_properties = failed.map((p) => ({
              name: p.property,
              error: p.error,
              suggestions: p.suggestions
            }))
            result.failed_count = failed.length
          }

          if (!success) {
            // 第一句就是成败比，不以成功开头
            const error = [
              `${modified.length} succeeded / ${failed.length} failed`,
              ...problems,
              ...formatFailureReasons(failed)
            ].join('\n')
            result.error = error
            result.message = error
          }

          return result
        }

        // 失败：透传插件错误（message/details/code）
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const msg = (response as any)?.error || (response as any)?.message || '无响应或 ok=false'
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const code = (response as any)?.__rpc?.code ?? (response as any)?.code
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const details = (response as any)?.details

        /*
         * 全部属性都失败时插件回 400，但每一条为什么失败它其实写在了
         * failed_properties 里 —— 以前这一支只透出「Failed to set any properties」
         * 一句话，模型对着它只能换个写法再猜一次。真机上给金币换材质就是这么
         * 试了三轮：原因（路径格式不对）插件早就说了，只是没人转告。
         */
        const reasons = formatFailureReasons(failed)
        return {
          success: false,
          error: `设置蓝图属性失败：${msg}${reasons.length ? `\n${reasons.join('\n')}` : ''}`,
          code,
          details,
          ...(failed.length > 0 ? { failed_properties: failed } : {}),
          raw: response
        }
      } catch (error) {
        console.error('[SetBlueprintPropertyTool] 执行失败:', error)
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  })
}
