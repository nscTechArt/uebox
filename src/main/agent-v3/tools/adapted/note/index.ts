/**
 * 笔记管理原子工具集
 */

import { defineV2Tool, type V2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import { WebContents } from 'electron'
import {
  createNoteAction,
  getNoteAction,
  searchNotesAction,
  updateNoteAction,
  deleteNoteAction
} from '../../../../agent/tools/app-control/notes/NotesController'

/**
 * 创建笔记工具
 */
export function createCreateNoteTool(sender: WebContents): V2Tool {
  return defineV2Tool({
    description: `给一个资产或文件夹写「详细说明」。

【使用场景】：用户让你把某个资产/文件夹的用法、参数、注意事项记下来。
【必须挂载】：assetKey 和 folderKey 二选一，必须给一个 —— 笔记在界面上的入口
就是资产/文件夹详情面板里的「备注」区，没有挂载的笔记用户永远看不到。
【目标已有说明】：会拒绝并告诉你已有笔记的 id，改用 update_note，不要新建。
【参数说明】：title 和 content 至少提供一个。`,
    inputSchema: z.object({
      title: z.string().optional().describe('笔记标题'),
      content: z.string().optional().describe('笔记内容，支持 Markdown 格式'),
      assetKey: z.string().optional().describe('挂在哪个资产上（和 folderKey 二选一，必须给一个）'),
      folderKey: z
        .string()
        .optional()
        .describe('挂在哪个文件夹上（和 assetKey 二选一，必须给一个）')
    }),
    execute: async (input) => {
      if (!input.title && !input.content) {
        return { success: false, error: '至少需要提供 title 或 content' }
      }
      const result = await createNoteAction(input)
      if (result.success) {
        sender.send('agent:note:changed', { action: 'create', noteId: result.noteId })
      }
      return result
    }
  })
}

/**
 * 获取笔记详情工具
 */
export function createGetNoteTool(): V2Tool {
  return defineV2Tool({
    description: `获取笔记详情，返回**完整正文**（不截断）。

【使用场景】：用户需要查看某个笔记的完整内容时使用。
【必须参数】：id（笔记 ID）`,
    inputSchema: z.object({
      id: z.number().describe('笔记 ID')
    }),
    execute: async (input) => {
      return getNoteAction(input)
    }
  })
}

/**
 * 搜索笔记工具
 */
export function createSearchNotesTool(): V2Tool {
  return defineV2Tool({
    description: `搜索或列出笔记。

【使用场景】：用户需要查找笔记或列出所有笔记时使用。
【参数说明】：不提供 keyword 则列出全部笔记。
【正文】默认每篇只给开头一段；被截断的会带 contentTruncated 标记。
  预计要读正文时直接加 full=true，一次拿全 —— 不用再一篇篇 note_get。`,
    inputSchema: z.object({
      keyword: z.string().optional().describe('搜索关键词，搜索标题和内容'),
      limit: z.number().optional().describe('返回数量限制，默认 50'),
      offset: z.number().optional().describe('分页偏移量'),
      full: z
        .boolean()
        .optional()
        .describe('是否直接返回每篇的完整正文，默认 false（只给开头一段）')
    }),
    execute: async (input) => {
      return searchNotesAction(input)
    }
  })
}

/**
 * 更新笔记工具
 */
export function createUpdateNoteTool(sender: WebContents): V2Tool {
  return defineV2Tool({
    description: `更新笔记。

【使用场景】：用户需要修改笔记内容时使用。
【必须参数】：id（笔记 ID）和至少一个更新字段。`,
    inputSchema: z.object({
      id: z.number().describe('笔记 ID'),
      title: z.string().optional().describe('新标题'),
      content: z.string().optional().describe('新内容')
    }),
    execute: async (input) => {
      if (input.title === undefined && input.content === undefined) {
        return { success: false, error: '至少需要提供 title 或 content' }
      }
      const result = await updateNoteAction(input)
      if (result.success) {
        sender.send('agent:note:changed', { action: 'update', noteId: input.id })
      }
      return result
    }
  })
}

/**
 * 删除笔记工具
 */
export function createDeleteNoteTool(sender: WebContents): V2Tool {
  return defineV2Tool({
    description: `删除笔记。

【使用场景】：用户需要删除笔记时使用。
【必须参数】：id（笔记 ID）`,
    inputSchema: z.object({
      id: z.number().describe('笔记 ID')
    }),
    execute: async (input) => {
      const result = await deleteNoteAction(input)
      if (result.success) {
        sender.send('agent:note:changed', { action: 'delete', noteId: input.id })
      }
      return result
    }
  })
}
