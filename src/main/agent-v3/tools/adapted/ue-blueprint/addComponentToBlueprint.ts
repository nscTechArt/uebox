/**
 * 为蓝图添加组件工具
 * 通过 WebSocket 向虚幻引擎插件发送 blueprint.add_component 命令
 * 为已存在的蓝图资产添加新的组件
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
 * 为蓝图添加组件请求参数
 */
const AddComponentToBlueprintSchema = z.object({
  blueprint_name: z
    .string()
    .describe('蓝图名称或路径（必填），如 "BP_MyActor" 或 "/Game/Blueprints/BP_MyActor"'),
  component_type: z
    .string()
    .describe('组件类型（必填），如 StaticMeshComponent, PointLightComponent, CameraComponent'),
  component_name: z.string().describe('组件名称（必填），如 "MyMesh", "MainLight"'),
  location: z
    .object({
      x: z.number().optional().default(0),
      y: z.number().optional().default(0),
      z: z.number().optional().default(0)
    })
    .optional()
    .describe('组件相对位置 { x, y, z }，默认 (0, 0, 0)'),
  rotation: z
    .object({
      pitch: z.number().optional().default(0),
      yaw: z.number().optional().default(0),
      roll: z.number().optional().default(0)
    })
    .optional()
    .describe('组件相对旋转 { pitch, yaw, roll }，默认 (0, 0, 0)'),
  scale: z
    .object({
      x: z.number().optional().default(1),
      y: z.number().optional().default(1),
      z: z.number().optional().default(1)
    })
    .optional()
    .describe('组件相对缩放 { x, y, z }，默认 (1, 1, 1)'),
  component_properties: z
    .unknown()
    .optional()
    .describe('组件属性键值对，如 { "Mobility": "Movable", "Intensity": 5000 }'),
  /**
   * 插件一直读这个字段，但 schema 里从来没声明过 —— 模型只能靠猜才传得对，
   * 而组件层级恰恰决定行为（门绕门轴转还是绕中心转）。
   */
  attach_to: z
    .string()
    .optional()
    .describe(
      '挂到哪个组件下面，填组件名。省略或填 "Root" 表示挂在根组件上。' +
        '指定的组件不存在时不会失败，而是挂到根上并在返回里给出 attach_warning'
    )
})

// ============================================================================
// 类型定义
// ============================================================================

/** 添加组件响应数据 (UE 插件返回) */
interface AddComponentResponse {
  ok: boolean
  blueprint_name: string
  component_name: string
  component_class: string
  /** 是不是**按请求**挂上的。父组件不存在而退到根上时为 false */
  attached: boolean
  /** 实际挂在谁下面。空字符串 = 挂在根上，和「不知道」是两回事 */
  attached_to?: string
  /** 没挂到请求的位置时说明原因，并列出这个蓝图现有哪些组件 */
  attach_warning?: string
  saved: boolean
  /**
   * 完整组件层级（name / class / attach_to / depth / source）。
   *
   * 插件一直在回这个字段，而工具层原来把它丢了 —— 于是调用方明明手里
   * 有层级信息却看不见，只能再调 describe，describe 又报不出真实父子关系，
   * 最后退到写 Python 反射 SCS。一次要绕三层。
   */
  all_components?: Array<{
    name: string
    class: string
    source: string
    attach_to?: string
    depth?: number
    editable?: boolean
  }>
  message?: string
  error?: string
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 解析 properties 输入（支持字符串或对象）
 * 防御性处理：AI 模型可能错误地将 properties 作为 JSON 字符串传递
 * @param rawProperties 原始 properties 输入
 * @returns 解析后的属性对象，如果输入为 undefined 则返回 undefined
 */
function parsePropertiesInput(rawProperties: unknown): Record<string, unknown> | undefined {
  if (rawProperties === undefined || rawProperties === null) {
    return undefined
  }
  if (typeof rawProperties === 'string') {
    try {
      const parsed = JSON.parse(rawProperties)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        console.warn('[AddComponentToBlueprintTool] component_properties 解析结果不是对象，已忽略')
        return undefined
      }
      console.log('[AddComponentToBlueprintTool] 检测到 component_properties 为字符串，已自动解析')
      return parsed as Record<string, unknown>
    } catch (e) {
      console.warn('[AddComponentToBlueprintTool] component_properties 解析失败:', e)
      return undefined
    }
  }
  if (typeof rawProperties !== 'object' || Array.isArray(rawProperties)) {
    console.warn('[AddComponentToBlueprintTool] component_properties 类型无效，已忽略')
    return undefined
  }
  return rawProperties as Record<string, unknown>
}

// ============================================================================
// 工具定义
// ============================================================================

/**
 * 为蓝图添加组件工具
 * @returns 添加组件工具实例
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createAddComponentToBlueprintTool() {
  return defineV2Tool({
    description: `为已存在的蓝图资产添加新的组件。

【功能说明】：
- 向指定蓝图添加新组件
- 支持设置组件的变换（位置、旋转、缩放）
- 支持设置组件属性

【参数说明】：
- blueprint_name: 蓝图名称或路径（必填）
- component_type: 组件类型（必填）
- component_name: 组件名称（必填）
- location: 组件相对位置 { x, y, z }
- rotation: 组件相对旋转 { pitch, yaw, roll }
- scale: 组件相对缩放 { x, y, z }
- component_properties: 组件属性键值对
- attach_to: 挂到哪个组件下面（可选，省略或填 "Root" 表示挂在根上）

【挂载关系怎么确认】：
返回里的 attached_to 是**实际**挂在了谁下面，attached 表示是不是按你要求挂的。
你指定的父组件不存在时不会失败，而是挂到根上并给出 attach_warning ——
组件层级决定行为（门绕门轴转还是绕中心转），所以看到 attach_warning 要处理，
别当成成功。

返回的 all_components 带着完整层级：attach_to 是父组件名（空 = 根），
depth 是层级深度。不需要再调 blueprint_describe 复核，更不用写 Python 去读 SCS。

【常用组件类型】：
- StaticMeshComponent - 静态网格组件
- SkeletalMeshComponent - 骨骼网格组件
- PointLightComponent - 点光源组件
- SpotLightComponent - 聚光灯组件
- DirectionalLightComponent - 平行光组件
- CameraComponent - 摄像机组件
- SceneCaptureComponent2D - 场景捕获组件
- BoxComponent - 盒体碰撞组件（**不叫** BoxCollisionComponent）
- SphereComponent - 球体碰撞组件（**不叫** SphereCollisionComponent）
- CapsuleComponent - 胶囊体组件
- AudioComponent - 音频组件
- ParticleSystemComponent - 粒子系统组件
- NiagaraComponent - Niagara 粒子组件
- WidgetComponent - UI 组件
- ArrowComponent - 箭头组件（调试用）

【返回数据】：
- ok: 是否成功
- blueprint_name: 蓝图名称
- component_name: 添加的组件名称
- component_class: 组件类型
- attached: 是否已附加
- saved: 是否已保存`,

    inputSchema: AddComponentToBlueprintSchema,

    execute: async (input) => {
      console.log('[AddComponentToBlueprintTool] 收到请求:', input)

      try {
        const wsService = serviceManager.getWebSocketService()
        if (wsService.getConnectionCount() === 0) {
          return {
            success: false,
            error: UE_NOT_CONNECTED_MESSAGE
          }
        }

        // 构建请求参数，转换为 UE 插件期望的格式
        const params: Record<string, unknown> = {
          blueprint_name: input.blueprint_name,
          component_type: input.component_type,
          component_name: input.component_name
        }

        // 挂载目标。插件一直读这个字段，而这里原来既没在 schema 里声明、
        // 也没往下透传 —— 就算模型猜对了字段名，值也到不了插件。
        if (input.attach_to) params.attach_to = input.attach_to

        // 处理位置参数（转换为数组格式）
        if (input.location) {
          params.location = [input.location.x ?? 0, input.location.y ?? 0, input.location.z ?? 0]
        }

        // 处理旋转参数（转换为数组格式）
        if (input.rotation) {
          params.rotation = [
            input.rotation.pitch ?? 0,
            input.rotation.yaw ?? 0,
            input.rotation.roll ?? 0
          ]
        }

        // 处理缩放参数（转换为数组格式）
        if (input.scale) {
          params.scale = [input.scale.x ?? 1, input.scale.y ?? 1, input.scale.z ?? 1]
        }

        // 添加组件属性（防御性解析）
        if (input.component_properties) {
          const parsedProps = parsePropertiesInput(input.component_properties)
          if (parsedProps && Object.keys(parsedProps).length > 0) {
            params.component_properties = parsedProps
          }
        }

        console.log('[AddComponentToBlueprintTool] 发送 blueprint.add_component 请求:', params)

        const response = await wsService.callRequest<AddComponentResponse>(
          'blueprint.add_component',
          params,
          getTargetConnectionId(),
          30000
        )

        console.log('[AddComponentToBlueprintTool] 收到响应:', response ? '成功' : '无数据')

        if (response && response.ok) {
          const misattached = response.attached === false && Boolean(response.attach_warning)
          return {
            success: true,
            blueprint_name: response.blueprint_name,
            component_name: response.component_name,
            component_class: response.component_class,
            attached: response.attached,
            // 实际挂在谁下面 —— 组件层级决定行为，这个必须让调用方看见
            attached_to: response.attached_to ?? '',
            ...(response.attach_warning ? { attach_warning: response.attach_warning } : {}),
            saved: response.saved,
            // 完整层级原样带上：调用方不用再调 describe，更不用写 Python 读 SCS
            ...(response.all_components ? { all_components: response.all_components } : {}),
            message: misattached
              ? `组件 "${response.component_name}" 已加到蓝图 "${response.blueprint_name}"，` +
                `但**没有挂到你要求的位置**：${response.attach_warning}`
              : `成功为蓝图 "${response.blueprint_name}" 添加组件 "${response.component_name}" ` +
                `(${response.component_class})，挂在 ${response.attached_to || '根组件'} 下`
          }
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const msg = (response as any)?.error || (response as any)?.message || '无响应或 ok=false'
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const code = (response as any)?.__rpc?.code ?? (response as any)?.code
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const details = (response as any)?.details
        return {
          success: false,
          error: `为蓝图添加组件失败：${msg}`,
          code,
          details,
          raw: response
        }
      } catch (error) {
        console.error('[AddComponentToBlueprintTool] 执行失败:', error)
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  })
}
