/**
 * 关卡的打开 / 新建 / 保存 / 查当前。
 *
 * 此前 `ue.level` 命名空间只有「查资产」和「整理 Actor」—— 能在当前关卡里
 * 摆东西，但换不了关卡、也存不了关卡。所有 Actor 操作都作用于"当前关卡"，
 * 而当前关卡是哪张、改完怎么留下来，整套工具答不上来。
 *
 * ## 会丢东西的两个操作
 *
 * `ue_open_level` 和 `ue_new_level` 都会丢弃未保存的改动，而且不可撤销。
 * 插件端在有脏改动时**默认拒绝**并回 409 + 脏包清单，要显式 force 才执行。
 * 这里把那个拒绝原样透传给模型，并告诉它正确的下一步是先保存。
 */

import { defineV2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import { serviceManager } from '../../../../services'

import { getTargetConnectionId } from '../../../core/projectTargetContext'
import { UE_NOT_CONNECTED_MESSAGE } from '../../defineUeTool'
import { describeUnsavedRefusal } from '../unsavedRefusal'

interface LevelResponse {
  ok: boolean
  package?: string
  name?: string
  is_dirty?: boolean
  is_temporary?: boolean
  actor_count?: number
  /** 实际落盘的那张关卡的包名（新插件按引擎写出的文件换算，不回显请求） */
  saved_as?: string
  /** 新插件才有：实际写出的 .umap 绝对路径 */
  saved_file?: string
  /**
   * 新插件才有。level.save 存的是「当前关卡」—— 用户把某个子关卡设成当前时，
   * 存的是那个子关卡，持久关卡没动
   */
  saved_level_is_persistent?: boolean
  saved?: boolean
  /** level.new 给了 save_as 但存盘失败时的原因（新插件） */
  save_error?: string
  note?: string
}

function requireConnection(): { success: false; error: string } | null {
  if (serviceManager.getWebSocketService().getConnectionCount() === 0) {
    return {
      success: false,
      error: UE_NOT_CONNECTED_MESSAGE
    }
  }
  return null
}

const OpenLevelSchema = z.object({
  path: z.string().describe('关卡路径，如 /Game/Maps/MainLevel'),
  force: z
    .boolean()
    .optional()
    .describe('丢弃未保存的改动强行打开。只有用户明确要求丢弃时才用，不可撤销')
})

const NewLevelSchema = z.object({
  save_as: z
    .string()
    .optional()
    .describe('顺手把新关卡存到这个路径，如 /Game/Maps/NewLevel。不给的话关卡只存在于内存里'),
  force: z.boolean().optional().describe('丢弃未保存的改动。不可撤销')
})

const SaveLevelSchema = z.object({
  path: z
    .string()
    .optional()
    .describe('另存为的路径。从没保存过的新关卡必须给；已有关卡省略即原地保存')
})

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createGetCurrentLevelTool() {
  return defineV2Tool({
    description: `查当前打开的是哪张关卡，以及它有没有未保存的改动。

摆 Actor、改场景之前先确认自己在对的关卡上 —— 所有 Actor 操作都作用于当前
关卡，走错关卡的改动会落在错误的地方。

is_temporary=true 表示这是张从没保存过的新关卡，它还没有文件，
存盘时必须用 ue_save_level 给个路径。`,
    inputSchema: z.object({}),
    execute: async () => {
      const notConnected = requireConnection()
      if (notConnected) return notConnected
      try {
        const response = await serviceManager
          .getWebSocketService()
          .callRequest<LevelResponse>('level.get_current', {}, getTargetConnectionId(), 20000)
        if (!response || !response.ok) {
          return { success: false, error: '拿不到当前关卡信息' }
        }
        return {
          success: true,
          package: response.package,
          name: response.name,
          is_dirty: response.is_dirty,
          is_temporary: response.is_temporary,
          actor_count: response.actor_count,
          summary:
            `当前关卡 ${response.package}，${response.actor_count} 个 Actor` +
            (response.is_dirty ? '，有未保存改动' : '') +
            (response.is_temporary ? '（未保存过的新关卡，还没有文件）' : '')
        }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  })
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createSaveLevelTool() {
  return defineV2Tool({
    description: `保存当前关卡。

**一般不用它。** 你挪 Actor、改场景会把关卡包改脏，而 ue_save 默认就存「你改脏的」，
关卡在里面 —— 摆完东西调 ue_save 一个就够。

这个工具管三件 ue_save 做不到的事：存**从没保存过的新关卡**（/Temp/Untitled_N，
它还没有文件，也进不了「你改过的」那份名单）、**另存为**到别的路径、
以及存**用户自己改的**那部分关卡改动。

从没保存过的新关卡必须给 path（它还没有文件）；已经存在的关卡省略 path
就是原地保存。给了 path 就是另存为。`,
    inputSchema: SaveLevelSchema,
    execute: async (input) => {
      const notConnected = requireConnection()
      if (notConnected) return notConnected
      try {
        const params: Record<string, unknown> = {}
        if (input.path) params.path = input.path

        const response = await serviceManager
          .getWebSocketService()
          .callRequest<LevelResponse>('level.save', params, getTargetConnectionId(), 120000)

        if (!response || !response.ok) {
          const message = (response as unknown as { error?: string })?.error || '保存关卡失败'
          return { success: false, error: message }
        }
        // 存的是子关卡时第一句就要说：用户以为存了「这张关卡」，其实持久关卡还是脏的
        const sublevelOnly = response.saved_level_is_persistent === false
        return {
          summary: sublevelOnly
            ? `⚠️ 只保存了当前子关卡 ${response.saved_as}，持久关卡 ${response.package} 和其他子关卡没有保存` +
              (response.is_dirty ? '（持久关卡仍有未保存改动，用 ue_save 存）' : '')
            : `关卡已保存到 ${response.saved_as}`,
          success: true,
          package: response.package,
          saved_as: response.saved_as,
          ...(response.saved_file ? { saved_file: response.saved_file } : {}),
          ...(response.saved_level_is_persistent !== undefined
            ? { saved_level_is_persistent: response.saved_level_is_persistent }
            : {}),
          ...(response.is_dirty !== undefined ? { is_dirty: response.is_dirty } : {}),
          ...(response.note ? { note: response.note } : {})
        }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  })
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createOpenLevelTool() {
  return defineV2Tool({
    description: `打开一张关卡。

**会丢弃所有未保存的改动。** 如果有未保存的东西，这个调用会被拒绝并列出
是哪些 —— 那时候应该先 ue_save，而不是直接加 force 重试。

打开之后所有 Actor 操作都作用于新关卡。`,
    inputSchema: OpenLevelSchema,
    execute: async (input) => {
      const notConnected = requireConnection()
      if (notConnected) return notConnected
      try {
        const params: Record<string, unknown> = { path: input.path }
        if (input.force !== undefined) params.force = input.force

        const response = await serviceManager
          .getWebSocketService()
          .callRequest<LevelResponse>('level.open', params, getTargetConnectionId(), 180000)

        const refusal = describeUnsavedRefusal(response, '打开另一张关卡')
        if (refusal) return { success: false, error: refusal, needs_save_first: true }

        if (!response || !response.ok) {
          const message = (response as unknown as { error?: string })?.error || '打开关卡失败'
          return { success: false, error: message }
        }
        return {
          success: true,
          package: response.package,
          actor_count: response.actor_count,
          summary: `已打开 ${response.package}，${response.actor_count} 个 Actor`
        }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  })
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createNewLevelTool() {
  return defineV2Tool({
    description: `新建一张空关卡。

**会丢弃所有未保存的改动**，规则和 ue_open_level 一样：有未保存的东西就会
被拒绝，先 ue_save。

建议一并给 save_as，否则新关卡只存在于内存里、没有文件，后面还得单独存一次。`,
    inputSchema: NewLevelSchema,
    execute: async (input) => {
      const notConnected = requireConnection()
      if (notConnected) return notConnected
      try {
        const params: Record<string, unknown> = {}
        if (input.save_as) params.save_as = input.save_as
        if (input.force !== undefined) params.force = input.force

        const response = await serviceManager
          .getWebSocketService()
          .callRequest<LevelResponse>('level.new', params, getTargetConnectionId(), 180000)

        const refusal = describeUnsavedRefusal(response, '新建关卡')
        if (refusal) return { success: false, error: refusal, needs_save_first: true }

        if (!response || !response.ok) {
          const message = (response as unknown as { error?: string })?.error || '新建关卡失败'
          return { success: false, error: message }
        }
        // 给了 save_as 却没存上：关卡已经换成新的了（撤不回），但落盘这一步没成，第一句就说
        const saveFailed = Boolean(input.save_as) && !response.saved
        return {
          summary: response.saved
            ? `已新建并保存关卡 ${response.saved_as ?? response.package}`
            : saveFailed
              ? `⚠️ 新关卡已建好，但没存到 ${input.save_as}：` +
                (response.save_error || '插件没给原因') +
                '。它现在只在内存里，用 ue_save_level 给 path 再存一次'
              : '已新建空关卡（仅在内存里，还没有文件）',
          success: true,
          package: response.package,
          saved: response.saved,
          ...(response.saved_as ? { saved_as: response.saved_as } : {}),
          ...(response.saved_file ? { saved_file: response.saved_file } : {}),
          ...(response.save_error ? { save_error: response.save_error } : {}),
          ...(response.note ? { note: response.note } : {})
        }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  })
}
