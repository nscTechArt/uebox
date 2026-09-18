/**
 * `ue_save` / `ue_list_unsaved` —— 让干完的活留下来。
 *
 * ## 为什么这是个缺口而不是个便利功能
 *
 * 在这两个工具之前，整套 UE 工具**做的所有事都不落盘**：插件里 `SavePackage`
 * 只在几个蓝图处理器内部出现过（编译时顺带存蓝图），材质、关卡、Actor 改完
 * 全靠用户自己去按保存。agent 干一整轮，工程里全是脏的 —— 用户关编辑器时
 * 撞上一堆「是否保存」弹窗，或者直接丢掉。
 *
 * ## 默认只存自己改的
 *
 * 插件端按「哪些包是在 UAL 命令执行期间被标脏的」来记账，用户自己手改的
 * 不在任何命令作用域内，因此不会被带上。
 *
 * 这条边界是有意的：替用户保存他改到一半的东西是越界的，而且不可撤销。
 * 需要时可以显式 `scope: 'all'`。
 */

import { defineV2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import { serviceManager } from '../../../../services'

import { getTargetConnectionId } from '../../../core/projectTargetContext'
import { UE_NOT_CONNECTED_MESSAGE } from '../../defineUeTool'

interface PackageEntry {
  package: string
  is_level: boolean
  /** 空包（里面的 Actor/资产已被删）：文件被移除而不是写入，插件会附一句 note 说明 */
  deleted?: boolean
  note?: string
}

interface SaveResponse {
  ok: boolean
  scope: string
  saved_count: number
  saved: PackageEntry[]
  failed?: Array<{ package: string; error: string }>
  still_dirty_count: number
  note?: string
  /** 插件用 code>=400 回错时才有（scope=list 一个都没加载、scope 拼错） */
  error?: string
  details?: { not_loaded?: string[] }
}

interface DirtyResponse {
  ok: boolean
  touched_count: number
  other_count: number
  touched: PackageEntry[]
  other: PackageEntry[]
}

const SaveSchema = z.object({
  scope: z
    .enum(['touched', 'all', 'list'])
    .optional()
    .describe(
      'touched=只存你自己改过的（默认，推荐）；' +
        'all=等同编辑器的「保存所有」，会把用户手改到一半的东西也存了；' +
        'list=只存 assets 里点名的'
    ),
  assets: z
    .array(z.string())
    .optional()
    .describe('scope=list 时必填，资产路径数组，如 ["/Game/BP_Door"]')
})

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
export function createSaveChangesTool() {
  return defineV2Tool({
    description: `把改动写到磁盘上。

**做完一件事就存一次。** 在此之前你对资产、蓝图、材质、关卡做的任何修改
都只在内存里 —— 用户关掉编辑器就没了，或者撞上一堆「是否保存」弹窗。

默认只存**你自己改过的**，用户手改到一半的东西不碰（那是他的决定，不是你的）。

**关卡也算在内。** 你挪了 Actor、改了灯，关卡包就被改脏了，scope=touched 会把它
一起存掉 —— 摆完东西调这一个就够，不用再补一次 ue_save_level。
只有三种情况才需要 ue_save_level：关卡是**从没保存过的新关卡**（/Temp/Untitled_N，
它还没有文件，也进不了「你改过的」这份名单）、要**另存为**到别的路径、
或者要存**用户自己改的**那部分关卡改动。

返回里的 still_dirty_count 是没存的数量。它大于 0 是正常的 —— 那些是别的
来源改的。要看具体是哪些，用 ue_list_unsaved。

新建但从没保存过的关卡存不了（它还没有文件），要先用 ue_save_level 给个路径。`,

    inputSchema: SaveSchema,

    execute: async (input) => {
      const notConnected = requireConnection()
      if (notConnected) return notConnected

      try {
        const params: Record<string, unknown> = {}
        if (input.scope) params.scope = input.scope
        if (input.assets) params.assets = input.assets

        const response = await serviceManager
          .getWebSocketService()
          .callRequest<SaveResponse>('editor.save', params, getTargetConnectionId(), 120000)

        if (!response) {
          return { success: false, error: '插件没有响应（editor.save）' }
        }

        /**
         * 错误响应要在这里就拦住。
         *
         * 插件用 `code>=400` 报错时（`scope=list` 点名的资产一个都没加载、
         * scope 拼错），`callRequest` 把它归一成 `{ ok:false, error, details }`
         * —— **没有 `saved` 数组**。下面那句 `response.saved.map(...)` 于是
         * 抛 `Cannot read properties of undefined`，模型收到的是一条 JS 栈，
         * 而不是「这几个资产没加载，所以没有未保存的改动」。
         *
         * 2026-09-09 真机上就是这么撞的：崩溃恢复后点名保存一张关卡，
         * 工具直接抛异常，模型只好放弃工具链路去翻磁盘。
         *
         * 判据只看 `saved` 在不在，**不看 `ok`**：正常保存里有一个包失败
         * 插件也回 `ok:false`，但那份响应是完整的，要走下面逐条报原因那条路。
         */
        if (!Array.isArray(response.saved)) {
          const notLoaded = response.details?.not_loaded ?? []
          const reason = response.error || '插件回了一个错误响应，但没说原因'
          return {
            success: false,
            error:
              notLoaded.length > 0
                ? `${reason}\n没加载的资产：${notLoaded.join('、')}\n` +
                  '没加载 = 内存里没有它，也就谈不上有未保存的改动。' +
                  '要确认它在磁盘上是什么状态，用 inspect_uasset_file 直接读文件。'
                : reason,
            ...(notLoaded.length > 0 ? { not_loaded: notLoaded } : {})
          }
        }

        const failed = response.failed ?? []

        // 一个都没存不是错误：多半是本来就没有未保存的改动。
        // 报成失败会让模型去排查一个不存在的问题。
        //
        // 但话要按 scope 说。原来不管哪一档都讲「那些不是你改的」——
        // scope=list 点名保存一张关卡、它其实是干净的时候，这句话
        // 答非所问，模型只会以为工具认错了人，接着换别的档再试一遍。
        if (response.saved_count === 0 && failed.length === 0) {
          const scope = response.scope || input.scope || 'touched'
          const leftover =
            response.still_dirty_count > 0
              ? `工程里还有 ${response.still_dirty_count} 处未保存，用 ue_list_unsaved 看是哪些。`
              : ''
          const summary =
            scope === 'list'
              ? `点名的这些资产加载着但不脏，没有东西要写 —— 它们已经是存过的状态。${leftover}`
              : scope === 'all'
                ? '整个工程没有未保存的改动。'
                : response.still_dirty_count > 0
                  ? `没有需要保存的改动。${leftover}那些不是你改的。`
                  : '没有需要保存的改动，工程是干净的。'
          return {
            success: true,
            saved_count: 0,
            scope,
            still_dirty_count: response.still_dirty_count,
            summary
          }
        }

        /**
         * 失败原因必须放到顶层 `error` 上。
         *
         * 插件其实把原因说清楚了（「Still dirty after save - the file may be
         * read-only or checked out by source control」），但它在 `failed[]`
         * 数组里。而 `describeV2Failure` 只认顶层的 `error` / `message`，
         * 两个都没有就兜底成「未提供失败原因」—— 模型于是拿到一句废话，
         * 既不知道是只读还是磁盘满，除了原样重试没有别的路。
         *
         * 只读位探针实测撞到的就是这个：文件标只读后保存失败，模型看到的
         * 全部信息是「ue_save 失败：未提供失败原因」。
         *
         * 和 formatDiagnostics 同理，只列前若干条 —— 一次 scope=all 可能
         * 几十个包同时失败，全塞进去会挤爆上下文，而原因通常是同一个。
         */
        const MAX_REPORTED_FAILURES = 10
        const failureReason = failed.length
          ? failed
              .slice(0, MAX_REPORTED_FAILURES)
              .map((entry) => `${entry.package}：${entry.error}`)
              .join('；') +
            (failed.length > MAX_REPORTED_FAILURES
              ? `；…另有 ${failed.length - MAX_REPORTED_FAILURES} 个同样失败`
              : '')
          : ''

        // 空包是被删掉的，不是存下来的：分开报，别让模型对用户说「已保存」一个已经不存在的文件
        const written = response.saved.filter((entry) => !entry.deleted)
        const deleted = response.saved.filter((entry) => entry.deleted)

        return {
          success: failed.length === 0,
          scope: response.scope,
          saved_count: written.length,
          saved: written.map((entry) => entry.package),
          ...(deleted.length > 0
            ? {
                deleted_count: deleted.length,
                deleted: deleted.map((entry) => ({ package: entry.package, note: entry.note }))
              }
            : {}),
          ...(failed.length > 0 ? { failed, error: failureReason } : {}),
          still_dirty_count: response.still_dirty_count,
          ...(response.note ? { note: response.note } : {}),
          summary:
            `已保存 ${written.length} 个` +
            (deleted.length > 0
              ? `，另有 ${deleted.length} 个空包已删除（里面的 Actor/资产已被删，文件随之移除）`
              : '') +
            (failed.length > 0 ? `，${failed.length} 个失败` : '') +
            (response.still_dirty_count > 0
              ? `。另有 ${response.still_dirty_count} 处未保存（非你所改，已刻意留着）`
              : '')
        }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  })
}

/**
 * 「这份清单只含 ue_save 存得了的包」这件事**刻意不写进工具描述**。
 *
 * 没落过盘的临时包（`/Temp/Untitled_N` 和它的外部 Actor）不在清单里，却照样会
 * 拦住换关卡和重启 —— 反馈里被当成「两个工具互相矛盾」的正是这个。但工具描述是
 * 每一轮都要付的前缀，而这句话只在两个时刻有用：清单空的时候（已写进 summary），
 * 和真的被 409 拦住的时候（已写进 `describeUnsavedRefusal`）。两处都是事后的
 * 运行时文本，不占前缀。
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createListUnsavedTool() {
  return defineV2Tool({
    description: `列出当前所有未保存的改动，并区分是谁改的。

touched = 你改的，ue_save 默认就存这些。
other = 别处改的（多半是用户自己在编辑器里动的），默认不碰。

在做任何会丢东西的操作之前用它确认一下：打开另一张关卡、新建关卡，
都会把未保存的改动丢掉。

【存盘不用先查】要保存就直接调 ue_save —— 它自己知道这一轮改脏了哪些包，
先来这里问一遍既不改变结果也不会更安全，只是多一轮。这里是给**会丢东西的**
操作打前站的，保存不是那种操作。`,

    inputSchema: z.object({}),

    execute: async () => {
      const notConnected = requireConnection()
      if (notConnected) return notConnected

      try {
        const response = await serviceManager
          .getWebSocketService()
          .callRequest<DirtyResponse>('editor.get_dirty', {}, getTargetConnectionId(), 30000)

        if (!response || !response.ok) {
          return { success: false, error: '获取未保存清单失败' }
        }

        return {
          success: true,
          touched_count: response.touched_count,
          other_count: response.other_count,
          touched: response.touched.map((entry) => entry.package),
          other: response.other.map((entry) => entry.package),
          summary:
            response.touched_count === 0 && response.other_count === 0
              ? // 不能只说「没有未保存的改动」：没落过盘的临时包不在这份清单里，
                // 但换关卡 / 重启照样会被它们拦下。原话让模型以为两个工具在打架，
                // 于是直奔 force=true —— 那会把清单外的东西一起丢掉
                '没有 ue_save 能存的未保存改动。（没落过盘的临时包不在这份清单里，' +
                '换关卡或重启时仍可能被它们拦住。）'
              : `你改的 ${response.touched_count} 处（ue_save 会存这些），别处改的 ${response.other_count} 处（默认不动）。`
        }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  })
}
