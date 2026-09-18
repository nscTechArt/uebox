/**
 * `ue_get_selection` —— 用户此刻在编辑器里「指的是什么」。
 *
 * ## 为什么单独做一个工具
 *
 * 「把**这个**节点改成 Lerp」「**这个** Actor 太高了」——
 * 这类句子里没有资产路径，也没有 node_id。以前模型只能猜，或者反问一句
 * 「你说的是哪个」，而答案其实就摆在编辑器里。
 *
 * `editor.get_focus_context` 早就有了，但它只报「开着哪些资产编辑器」，
 * 不报聚焦的图和选中的节点 —— 差的正是「听懂『这个』」的那一截。
 *
 * ## 报出来的 id 是能直接喂回去的
 *
 * 蓝图节点的 `node_id` 和 `ue_bp_get_graph` 回的是同一套（NodeGuid），
 * 材质节点的和 `ue_material_get_graph` 回的是同一套。所以「读选中 → 改它」
 * 是闭环的，中间不用再查一次图。
 *
 * ## 它读不到什么
 *
 * 只读有正式 API 的「选中/焦点」状态，不认光标底下的按钮、菜单项、
 * 细节面板的某一行 —— 那需要遍历 Slate 控件树，而那玩意儿跟引擎内部结构
 * 硬绑，我们要同时伺候 5.0–5.8 九个版本。详见插件侧 UAL_FocusContext.h。
 */

import { defineV2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import { serviceManager } from '../../../../services'

import { getTargetConnectionId } from '../../../core/projectTargetContext'
import type { FocusContext } from '../../../core/focusContext'
import { UE_NOT_CONNECTED_MESSAGE } from '../../defineUeTool'

const TIMEOUT_MS = 10_000

/** 人话摘要。模型先读这一句就知道「这个」指的是什么，不用自己拼 */
export function summarizeSelection(context: FocusContext): string {
  const parts: string[] = []

  const editor = context.focusedEditor
  if (editor) {
    parts.push(`焦点：${editor.type} ${editor.name}（${editor.path}）`)
  } else {
    parts.push('编辑器里没有打开任何资产')
  }

  if (context.focusedGraph) {
    parts.push(`当前图：${context.focusedGraph.name}`)
  }

  const nodes = context.selectedNodes ?? []
  if (nodes.length > 0) {
    const titles = nodes.map((node) => node.title || node.class).join('、')
    parts.push(`图里选中 ${context.selectedNodeCount ?? nodes.length} 个节点：${titles}`)
  }

  const actors = context.selectedActors ?? []
  if (actors.length > 0) {
    const labels = actors.map((actor) => actor.label || actor.name).join('、')
    parts.push(`关卡里选中 ${context.selectedActorCount ?? actors.length} 个 Actor：${labels}`)
  }

  const assets = context.contentBrowser?.selectedAssets ?? []
  if (assets.length > 0) {
    const names = assets.map((asset) => asset.name).join('、')
    parts.push(
      `内容浏览器里选中 ${context.contentBrowser?.selectedAssetCount ?? assets.length} 个资产：${names}`
    )
  }

  if (nodes.length === 0 && actors.length === 0 && assets.length === 0) {
    parts.push('当前没有选中任何东西')
  }

  return parts.join('；')
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createGetSelectionTool() {
  return defineV2Tool({
    description: `看用户**此刻**在编辑器里选中/打开着什么。

**先看消息里的 \`<editor-snapshot>\` 块。** 用户发消息那一刻的选中状态已经随消息
一起给你了，「这个」指什么通常在那里面就有答案 —— 那份还比这里准，因为它是用户
**说话当时**的状态，而这个工具查的是**现在**（用户可能早就换了选区）。

只有确实需要最新状态时才调我：用户让你「再看一眼」，或者你要改的东西可能已经动过。
消息里没有那个块（引擎没连、抓取失败）时，这里是唯一的来源。

返回：
- focusedEditor：当前聚焦的资产编辑器（不是随便一个开着的，是真正在最前面那个）
- focusedGraph：蓝图编辑器里当前正看着的那张图
- selectedNodes：图里选中的节点，带 node_id —— **可以直接喂给 ue_bp_* / ue_material_* 改**
- selectedActors：关卡视口/大纲里选中的 Actor
- contentBrowser：内容浏览器里选中的资产和文件夹

读不到的东西：光标底下的按钮、菜单项、细节面板的某一行。
用户要问「这个按钮是干嘛的」，让他截个图。

列表最多各报 50 条，超了会给 *_truncated 和总数。`,

    inputSchema: z.object({}),

    execute: async () => {
      const wsService = serviceManager.getWebSocketService()
      if (wsService.getConnectionCount() === 0) {
        return {
          success: false,
          error: UE_NOT_CONNECTED_MESSAGE
        }
      }

      try {
        const response = await wsService.callRequest<FocusContext>(
          'editor.get_focus_context',
          {},
          getTargetConnectionId(),
          TIMEOUT_MS
        )

        if (!response) {
          return { success: false, error: '插件没有响应（editor.get_focus_context）' }
        }

        return {
          success: true,
          ...response,
          summary: summarizeSelection(response)
        }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  })
}
