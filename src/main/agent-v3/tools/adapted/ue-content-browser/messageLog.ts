/**
 * MessageLog Tool - 读取 UE 编辑器消息日志
 *
 * 设计原则：
 * - 奥卡姆剃刀：只暴露一个合并工具，通过 action 参数区分功能
 * - 墨菲定律：完善的错误处理和连接检查
 */

import { defineV2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import { serviceManager } from '../../../../services'

import { getTargetConnectionId } from '../../../core/projectTargetContext'
import { UE_NOT_CONNECTED_MESSAGE } from '../../defineUeTool'

/** UE 侧失败响应的字段。历史原因不统一，四种都可能出现 */
type RpcFailureShape =
  | {
      ok?: boolean
      success?: boolean
      __rpc?: { code?: string | number }
      code?: string | number
      error?: string
      message?: string
      details?: unknown
    }
  | null
  | undefined

// ============================================================================
// Schema 定义
// ============================================================================

/**
 * MessageLog 工具参数
 */
const MessageLogSchema = z.object({
  action: z
    .enum(['list', 'get'])
    .describe('操作类型：list（列出所有日志类别）、get（获取指定类别的消息）'),
  category: z
    .string()
    .optional()
    .describe('日志类别名称（action=get 时必填），如 BlueprintLog、MapCheck、AssetCheck'),
  limit: z.number().optional().default(50).describe('返回消息数量限制（默认 50）')
})

// ============================================================================
// 类型定义
// ============================================================================

/** 日志类别 */
interface MessageLogCategory {
  name: string
  label: string
}

/** 单条消息 */
interface MessageLogEntry {
  severity: string
  text: string
  tokens?: Array<{ type: string; text: string }>
}

/** list 响应 */
interface ListCategoriesResponse {
  categories: MessageLogCategory[]
}

/** get 响应 */
interface GetMessagesResponse {
  category: string
  count: number
  total: number
  messages: MessageLogEntry[]
}

// ============================================================================
// 工具定义
// ============================================================================

/**
 * 创建 MessageLog 工具
 * @returns MessageLog 工具实例
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createMessageLogTool() {
  return defineV2Tool({
    description: `读取虚幻引擎编辑器的消息日志（Message Log）窗口内容。

【作用】：
消息日志包含蓝图错误、地图检查警告、资产验证问题等重要信息，帮助诊断项目问题。

【支持的操作】：
- list：列出所有可用的日志类别
- get：获取指定类别的消息内容

【重要：蓝图错误有两种类型】：
- BlueprintLog：蓝图**编译**错误（语法错误、类型不匹配等，编译时发生）
- PIE：蓝图**运行时**错误（访问无效引用、空指针等，Play时发生）
⚠️ 当用户问"蓝图有什么错误"时，应该**同时检查 BlueprintLog 和 PIE 两个类别**！

【其他常见类别】：
- MapCheck：地图检查结果
- AssetCheck：资产验证问题
- LoadErrors：资产加载错误

【使用示例】：
1. 用户问"蓝图有什么错误" → 先查 BlueprintLog，再查 PIE
2. 用户问"有哪些日志可以看" → action='list'
3. 用户问"地图检查有问题吗" → action='get', category='MapCheck'`,

    inputSchema: MessageLogSchema,

    execute: async (input) => {
      console.log('[MessageLogTool] 收到请求:', input)

      try {
        // 墨菲定律：先检查连接状态
        const wsService = serviceManager.getWebSocketService()
        if (wsService.getConnectionCount() === 0) {
          return {
            success: false,
            error: UE_NOT_CONNECTED_MESSAGE
          }
        }

        // 根据 action 分发
        if (input.action === 'list') {
          return await executeListCategories(wsService)
        } else if (input.action === 'get') {
          // 墨菲定律：验证必填参数
          if (!input.category) {
            return {
              success: false,
              error: '缺少必填参数 category。请指定要查看的日志类别，如 BlueprintLog、MapCheck。'
            }
          }
          return await executeGetMessages(wsService, input.category, input.limit ?? 50)
        }

        return { success: false, error: `未知操作: ${input.action}` }
      } catch (error) {
        console.error('[MessageLogTool] 执行失败:', error)
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  })
}

/**
 * 执行列出日志类别
 */
async function executeListCategories(
  wsService: ReturnType<typeof serviceManager.getWebSocketService>
): Promise<unknown> {
  console.log('[MessageLogTool] 发送 messagelog.list 请求')

  const response = await wsService.callRequest<ListCategoriesResponse>(
    'messagelog.list',
    {},
    getTargetConnectionId(),
    10000
  )

  console.log('[MessageLogTool] 收到响应:', response)

  if (response?.categories) {
    const categories = response.categories
    const categoryList = categories
      .map((c) => `- ${c.name}${c.label ? ` (${c.label})` : ''}`)
      .join('\n')

    return {
      success: true,
      message: `找到 ${categories.length} 个日志类别：\n${categoryList}`,
      categories
    }
  }

  return {
    success: false,
    error: '获取日志类别失败',
    raw: response
  }
}

/**
 * 执行获取消息
 */
async function executeGetMessages(
  wsService: ReturnType<typeof serviceManager.getWebSocketService>,
  category: string,
  limit: number
): Promise<unknown> {
  console.log(`[MessageLogTool] 发送 messagelog.get 请求: category=${category}, limit=${limit}`)

  const response = await wsService.callRequest<GetMessagesResponse>(
    'messagelog.get',
    { category, limit },
    getTargetConnectionId(),
    15000
  )

  console.log(
    '[MessageLogTool] 收到响应:',
    response ? `${response.count}/${response.total} 条消息` : '无数据'
  )

  // 墨菲定律：处理类别不存在的情况
  if (!response || (response as RpcFailureShape)?.message?.includes('not found')) {
    return {
      success: false,
      error: `日志类别 "${category}" 不存在或未注册。请使用 action='list' 查看可用类别。`,
      suggestion: '常见类别：BlueprintLog, MapCheck, AssetCheck, LoadErrors'
    }
  }

  if (response?.messages !== undefined) {
    const messages = response.messages

    // 格式化消息为易读文本
    let summary = ''
    if (messages.length === 0) {
      summary = `✅ ${category} 日志为空，没有错误或警告。`
    } else {
      // 统计各级别数量
      const counts: Record<string, number> = {}
      for (const msg of messages) {
        counts[msg.severity] = (counts[msg.severity] || 0) + 1
      }

      const countStr = Object.entries(counts)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ')

      summary = `${category} 有 ${response.total} 条消息（显示 ${messages.length} 条）。级别分布: ${countStr}`
    }

    return {
      success: true,
      message: summary,
      category: response.category,
      count: response.count,
      total: response.total,
      messages
    }
  }

  return {
    success: false,
    error: '获取消息失败',
    raw: response
  }
}
