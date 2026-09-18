/**
 * `blueprint_search_nodes` —— 写图之前先查一批。
 *
 * ## 为什么需要它
 *
 * 在它之前，蓝图工具集里**没有任何一个命令**能回答「有哪些函数能调」
 * 「这个函数有哪些引脚」。引脚信息只能作为「建节点」的副作用拿到：
 * 想知道 PrintString 有哪些引脚，唯一办法是先把这个节点建出来再看返回。
 *
 * 于是写图必然退化成「建一个 → 看一眼引脚 → 连一根线 → 再建一个」。
 * 就算整图写入的能力修好了，碰到没见过的函数还是得先建了才敢连线。
 *
 * 这个只读命令让「查一批 → 写一整张」成立 —— 一次调用拿回十几个函数的
 * 完整签名，然后 `blueprint_apply_graph` 一把写完。
 */

import { defineV2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import { serviceManager } from '../../../../services'

import { getTargetConnectionId } from '../../../core/projectTargetContext'
import { UE_NOT_CONNECTED_MESSAGE } from '../../defineUeTool'

const SearchNodesSchema = z.object({
  query: z
    .string()
    .describe(
      '函数名关键字，如 "print"、"delay"、"greater"、"spawn"。按名字匹配，不是自然语言搜索'
    ),
  blueprint_path: z
    .string()
    .optional()
    .describe('给了就把这个蓝图父类链上的成员函数也纳入搜索范围。改某个蓝图时应该带上'),
  limit: z.number().int().optional().describe('最多回几条，默认 12，上限 50')
})

interface SearchNodesResponse {
  ok: boolean
  query: string
  match_count: number
  total_candidates: number
  functions: Array<{
    /** 蓝图里的名字。建节点就用这个 */
    name: string
    member_name: string
    class: string
    /** 只在和蓝图名不同时出现（K2_GetActorLocation 这类）。排查用，不能拿去建节点 */
    cpp_name?: string
    is_pure: boolean
    summary?: string
    params: Array<{ name: string; type: string; dir: 'Input' | 'Output' }>
  }>
  note?: string
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createSearchBlueprintNodesTool() {
  return defineV2Tool({
    description: `按名字搜蓝图里能调用的函数，连**完整引脚签名**一起回。

写图之前用它，别靠猜。一次调用能拿回十几个函数的确切名字和每个引脚的
名字/类型/方向 —— 拿到之后用 blueprint_apply_graph 一次性把整片逻辑写完，
不需要「建一个节点看一眼引脚」地往返。

返回里的 member_name 可以直接填进 blueprint_apply_graph 的节点定义，
params 里的 name 就是连线时用的引脚名。

is_pure=true 的是纯函数（没有执行引脚，不用接 then/execute）。

**一定要带 blueprint_path**：范围 = 全部蓝图函数库 + 这个蓝图的父类链 +
**它身上挂的控件和组件的类**（TextBlock.SetText、StaticMeshComponent.SetStaticMesh
这些就是靠它才搜得到的）。不带就只剩函数库。

搜出 0 条时**别退而求其次**用 KismetSystemLibrary.SetXxxPropertyByName 那类
反射写字段的节点 —— 它们只改字段不通知 Slate，值变了屏幕不重画。
member_name 直接写「类名.函数名」（去掉 U 前缀）填进 blueprint_apply_graph，
那条路按类名解析，认识引擎里任何一个类。

回来的 name / member_name 是**蓝图里的名字**，可以原样填进 blueprint_apply_graph
的 member_name。有些函数的 C++ 名不一样（GetActorLocation 在 C++ 里叫
K2_GetActorLocation），那种情况会额外带一个 cpp_name 字段，**不要用它去建节点**。`,

    inputSchema: SearchNodesSchema,

    execute: async (input) => {
      try {
        const wsService = serviceManager.getWebSocketService()
        if (wsService.getConnectionCount() === 0) {
          return {
            success: false,
            error: UE_NOT_CONNECTED_MESSAGE
          }
        }

        const params: Record<string, unknown> = { query: input.query }
        if (input.blueprint_path) params.blueprint_path = input.blueprint_path
        if (input.limit !== undefined) params.limit = input.limit

        const response = await wsService.callRequest<SearchNodesResponse>(
          'blueprint.search_nodes',
          params,
          getTargetConnectionId(),
          20000
        )

        if (!response || !response.ok) {
          const message =
            (response as unknown as { error?: string; message?: string })?.error ||
            (response as unknown as { message?: string })?.message ||
            '无响应或 ok=false'
          return { success: false, error: `搜索节点失败：${message}` }
        }

        // 一条都没有时，"没找到"本身不够用 —— 说清楚下一步怎么办，
        // 否则调用方多半会用同一个词再搜一遍。
        if (response.match_count === 0) {
          return {
            success: true,
            query: response.query,
            match_count: 0,
            functions: [],
            summary:
              `没有匹配 "${response.query}" 的函数。换个更短的关键字试试（搜的是函数名的子串，` +
              `不是自然语言），或者带上 blueprint_path 把这个蓝图的父类成员函数也纳入范围。\n` +
              `⚠️ **这里搜不到不代表函数不存在**：搜索范围只有「函数库 + 这个蓝图的父类链」，` +
              `控件和组件类身上的成员函数（TextBlock.SetText、StaticMeshComponent.SetStaticMesh 这种）` +
              `照不到，但它们能用 —— 把 member_name 直接写成「类名.函数名」（去掉 U 前缀）` +
              `填进 blueprint_apply_graph 就行。不要因为搜不到就改用 ` +
              `KismetSystemLibrary.SetXxxPropertyByName 那类反射写字段的节点：` +
              `那种写法字段值会变，但屏幕不会重画。`
          }
        }

        return {
          success: true,
          query: response.query,
          match_count: response.match_count,
          total_candidates: response.total_candidates,
          functions: response.functions,
          ...(response.note ? { note: response.note } : {}),
          summary: `找到 ${response.match_count} 个函数，member_name 可直接填进 blueprint_apply_graph`
        }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  })
}
