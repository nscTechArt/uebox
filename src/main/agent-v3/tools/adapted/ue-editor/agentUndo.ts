/**
 * `ue_undo_history` / `ue_undo` —— agent 自己那条撤销栈。
 *
 * ## 为什么需要单独一条栈
 *
 * 编辑器只有一条全局撤销栈。agent 干一轮动辄三十步全压上去，用户想撤销
 * **自己**十分钟前做的操作，得先按三十次 Ctrl+Z；而「把 AI 刚做的全撤了」
 * 根本没有对应操作 —— 没人知道该按几次。
 *
 * 插件端在命令执行期间把 `GEditor->Trans` 换成 agent 专用缓冲（见插件的
 * UAL_AgentUndo.h），于是两条历史彻底分开：用户的 Ctrl+Z 碰不到 agent 的步骤，
 * 这两个工具也碰不到用户的步骤。
 *
 * ## 已知边界：交叉编辑
 *
 * agent 改了 A，用户接着手动也改了 A，这时撤销 agent 那一步会把对象整体还原到
 * agent 动手之前，用户那次修改跟着没了。这是「两条独立撤销栈」固有的问题，
 * 所以 ue_undo 会把受影响的资产列出来，让人先看清楚。
 */

import { defineV2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import { serviceManager } from '../../../../services'

import { getTargetConnectionId } from '../../../core/projectTargetContext'
import { describeToolError } from '../../engineErrors'
import { UE_NOT_CONNECTED_MESSAGE } from '../../defineUeTool'

interface HistoryEntry {
  step: number
  title: string
  context: string
  packages: string[]
  /**
   * 这一步动过的对象，用大纲视图里的名字。最多 8 个，全部个数看 `object_count`。
   *
   * 没有它的时候，52 步里只有四种标题（生成Actor / 删除Actor / 修改Actor属性 /
   * 批量修改Actor变换），`packages` 又只到关卡粒度 —— 想知道「哪几步是我没干过的」
   * 一点依据都没有，也就没法只回滚那几步。
   */
  objects?: string[]
  object_count?: number
}

interface HistoryResponse {
  ok: boolean
  undoable: number
  redoable: number
  returned: number
  entries: HistoryEntry[]
}

interface UndoResponse {
  ok: boolean
  action: 'undo' | 'redo'
  steps_applied: number
  step_titles: string[]
  remaining: number
  redoable: number
  affected_packages: string[]
  /**
   * 这一次撤销/重做动过的对象，大纲视图里的名字。
   *
   * 只有包名的时候，「/Game/DoorDemo/L_DoorDemo 被动了」看不出关卡里的哪个东西变了 ——
   * 而撤销完全可能把一个 Actor 撤没（编译蓝图会重新生成关卡里的实例）。旧插件没有这个字段。
   */
  affected_objects?: string[]
  error?: string
}

const TIMEOUT_MS = 120_000

function requireConnection(): { success: false; error: string } | null {
  const wsService = serviceManager.getWebSocketService()
  if (wsService.getConnectionCount() === 0) {
    return {
      success: false,
      error: UE_NOT_CONNECTED_MESSAGE
    }
  }
  return null
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createUndoHistoryTool() {
  return defineV2Tool({
    description: `列出你自己在这个工程里做过的、还能撤销的步骤。

**只有你的步骤。** 用户手动做的操作在另一条撤销栈上，这里看不到，
ue_undo 也撤不掉 —— 那是刻意的。

每条记录带上这一步动过的资产（packages）和**具体对象**（objects，大纲视图里的名字，
最多列 8 个，总数看 object_count），所以撤销之前能先看清楚会影响什么，
也能认出「哪几步不是我做的」。
step 越大越新，撤销从最大的那个往回走。

**objects 是空的**说明那一步动的都是临时对象，或者插件是旧版本 —— 后者请提醒用户更新插件。`,

    inputSchema: z.object({
      limit: z
        .number()
        .optional()
        .describe('只要最近几步，默认 20。填 0 或负数表示全要（长会话里可能几百条）')
    }),

    execute: async (input) => {
      const notConnected = requireConnection()
      if (notConnected) return notConnected

      try {
        const params: Record<string, unknown> = {}
        if (typeof input.limit === 'number') params.limit = input.limit

        const response = await serviceManager
          .getWebSocketService()
          .callRequest<HistoryResponse>(
            'editor.undo_history',
            params,
            getTargetConnectionId(),
            TIMEOUT_MS
          )

        if (!response || !response.ok) {
          return { success: false, error: '获取撤销历史失败（editor.undo_history）' }
        }

        if (response.undoable === 0) {
          return {
            success: true,
            undoable: 0,
            redoable: response.redoable,
            entries: [],
            summary:
              response.redoable > 0
                ? `你还没有可撤销的步骤，但有 ${response.redoable} 步可以重做（之前撤销掉的）。`
                : '你在这个工程里还没做过任何可撤销的改动。'
          }
        }

        return {
          success: true,
          undoable: response.undoable,
          redoable: response.redoable,
          entries: response.entries,
          summary:
            `你有 ${response.undoable} 步可撤销` +
            (response.returned < response.undoable
              ? `（只列出最近 ${response.returned} 步）`
              : '') +
            (response.redoable > 0 ? `，另有 ${response.redoable} 步可重做` : '') +
            '。'
        }
      } catch (error) {
        // 超时要留码：撤销可能已经生效，报成明确失败会让调用方重试，于是多撤一步
        return describeToolError(error)
      }
    }
  })
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createUndoTool() {
  return defineV2Tool({
    description: `撤销你自己做过的步骤（或者把撤销掉的重做回来）。

**只动你自己那条撤销栈，用户手动做的操作一步都不碰。** 所以不填 steps
就是「把我这一轮做的全撤了」，不会连带撤掉用户自己的操作。

用之前先 ue_undo_history 看一眼有哪些步、各动了什么资产 —— 撤销是按步走的，
不是按资产走的。

**撤销之后要 ue_save。** 撤销只改内存里的内容，磁盘上还是撤销前的样子；
返回的 affected_packages 就是需要重新保存的那些。

返回里的 **affected_objects 是这一次真正动到的对象**（Actor 用大纲里的名字）。
撤销是按整笔事务还原的，里面可能连带着关卡里的实例 —— 名单里出现你没预料到的
Actor，就先 ue_get_actor 查一下它还在不在，**别急着保存**：保存会把这次还原落盘。

撤多了用 direction: "redo" 走回来。

**资产级操作不在这条栈上**：导入、移动、删除资产，以及保存 —— 引擎本身就不把它们
记进撤销缓冲。「全撤了」指的是关卡里的改动，不包括这些。要确认清干净了，
撤完再查一遍实际状态，不要拿 ue_undo 报的成功当结论。

一个真实的边界：你改了某个资产、用户接着自己也手动改了同一个，
这时撤销你那一步会把整个对象还原到你动手之前，用户那次修改跟着没了。
所以受影响的资产要先给用户看清楚。`,

    inputSchema: z.object({
      steps: z
        .number()
        .optional()
        .describe('撤几步。省略或填 0 表示全部 —— 那是「把刚才做的全撤了」的意思'),
      direction: z
        .enum(['undo', 'redo'])
        .optional()
        .describe('undo=撤销（默认）；redo=把之前撤销掉的重做回来')
    }),

    execute: async (input) => {
      const notConnected = requireConnection()
      if (notConnected) return notConnected

      const direction = input.direction ?? 'undo'
      const method = direction === 'redo' ? 'editor.redo' : 'editor.undo'
      const verb = direction === 'redo' ? '重做' : '撤销'

      try {
        const params: Record<string, unknown> = {}
        if (typeof input.steps === 'number') params.steps = input.steps

        const response = await serviceManager
          .getWebSocketService()
          .callRequest<UndoResponse>(method, params, getTargetConnectionId(), TIMEOUT_MS)

        if (!response) {
          return { success: false, error: `插件没有响应（${method}）` }
        }

        // 一步都没动不是错误：多半是本来就没有可撤销的步骤。
        // 报成失败会让模型去排查一个不存在的问题。
        if (response.steps_applied === 0) {
          return {
            success: true,
            steps_applied: 0,
            remaining: response.remaining,
            redoable: response.redoable,
            summary: response.error
              ? `没有${verb}任何步骤：${response.error}`
              : `没有可${verb}的步骤。`
          }
        }

        // 对象名进正文，不只放在字段里 —— 模型只读 summary 的情况很常见，
        // 而「撤销把关卡里的 TreasureChest 撤没了」这件事只能从对象名上看出来
        const objects = response.affected_objects ?? []
        const OBJECT_PREVIEW = 8
        const objectNote =
          objects.length > 0
            ? `；动到的对象：${objects.slice(0, OBJECT_PREVIEW).join('、')}` +
              (objects.length > OBJECT_PREVIEW ? ` 等 ${objects.length} 个` : '') +
              '。其中的关卡 Actor 可能被整体还原甚至撤没，拿不准就查一遍实际状态'
            : ''

        return {
          success: !response.error,
          action: response.action,
          steps_applied: response.steps_applied,
          step_titles: response.step_titles,
          remaining: response.remaining,
          redoable: response.redoable,
          affected_packages: response.affected_packages,
          ...(objects.length > 0 ? { affected_objects: objects } : {}),
          ...(response.error ? { error: response.error } : {}),
          summary:
            `已${verb} ${response.steps_applied} 步` +
            (response.affected_packages.length > 0
              ? `，影响 ${response.affected_packages.length} 个资产（需要 ue_save 才会落盘）`
              : '') +
            objectNote +
            `。还可撤销 ${response.remaining} 步、可重做 ${response.redoable} 步。`
        }
      } catch (error) {
        // 超时要留码：撤销可能已经生效，报成明确失败会让调用方重试，于是多撤一步
        return describeToolError(error)
      }
    }
  })
}
