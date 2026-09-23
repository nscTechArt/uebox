/**
 * 删除资产工具
 * 通过 WebSocket 向虚幻引擎插件发送 content.delete 命令
 * 彻底删除资产；目录在盒子这边展开成资产清单后**一次**提交
 *
 * ## 为什么目录在这里展开，而不是让模型自己列
 *
 * 引擎侧 `content.delete` 只认具体资产。原来的说明写着「要清空目录请先用
 * ue_content_search 列出资产再逐个删」——「逐个」两个字把模型引到 Python 里循环
 * `EditorAssetLibrary.delete_asset`：每一次调用都跑一遍完整 GC，9000 个 Actor 的关卡上
 * 每个约 3 秒，282 个资产就把主线程占了十几分钟，之后所有引擎命令一起超时
 * （2026-09-22 淘金小镇的反馈）。而 `paths` 本来就是数组，一批只跑一遍 GC。
 *
 * 所以现在目录路径直接收：盒子用 `content.search` 把目录展开成对象路径，
 * 和显式给的资产合成一批再提交。模型看到的是「传目录，一步删完」。
 */

import { defineV2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import { serviceManager } from '../../../../services'

import { toPackagePath } from '../../../core/assetLock'
import { releaseProtectionBeforeDelete } from '../../../core/assetLockEnforcement'
import { getTargetConnectionId } from '../../../core/projectTargetContext'
import { UE_NOT_CONNECTED_MESSAGE } from '../../defineUeTool'
import { describeToolError, isEngineTimeout } from '../../engineErrors'
// ============================================================================
// Schema 定义
// ============================================================================

/**
 * 删除资产请求参数
 */
const DeleteAssetsSchema = z.object({
  paths: z
    .array(z.string())
    .describe(
      '要删除的路径列表，资产和目录都收。资产写对象路径，如 "/Game/Temp/TestActor.TestActor"；' +
        '目录写包路径，如 "/Game/ThirdParty/AnimeGirl"，工具会把目录下的**全部**资产（含子目录）展开后' +
        '和其余路径合成**一批**提交，引擎只跑一遍垃圾回收。' +
        '整个目录要清掉就直接传目录，**不要**先搜再一个个传、更不要在 Python 里循环 delete_asset ——' +
        '那条路每删一个资产就做一次完整 GC，几百个资产会把编辑器主线程占死十几分钟。'
    ),
  dry_run: z
    .boolean()
    .optional()
    .describe(
      '只展开、不删：把目录会展开成哪些资产列出来回给你，引擎一个字节不动。' +
        '**传了目录就先 dry_run=true 一次**，把清单拿给用户核对，他点头了再不带 dry_run 删。' +
        '审批卡上只显示你传的那个目录路径，用户看不到里面有什么 —— 清单得由你给。'
    ),
  drop_agent_undo: z
    .boolean()
    .optional()
    .describe(
      '丢掉你自己那几步撤销记录，好让这个资产删得动。**默认 false，只有用户明确同意了才填 true。**' +
        '刚被你改过的资产会被你自己的撤销栈拽着，引擎会判成「正在使用中」而拒绝删除；' +
        '这时先别重试，把失败原因里说的「要丢几步撤销」告诉用户，等他同意再带 true 调一次。' +
        '丢掉的只有**你**的撤销步骤，用户在编辑器里的撤销历史一步不动。'
    )
})

// ============================================================================
// 类型定义
// ============================================================================

/** 删除资产响应数据 (UE 插件返回) */
interface DeleteAssetsResponse {
  ok: boolean
  deleted_count: number
  requested_count: number
  deleted: string[]
  /** 每条失败的路径和**查出来的**原因（只读位 / agent 撤销栈 / 具体引用者） */
  failed?: Array<{ path: string; reason?: string }>
  /** 这次为了删成而丢掉的 agent 撤销步骤标题 */
  dropped_agent_undo_steps?: string[]
  error?: string
}

/** `content.search` 回来的一条；`path` 是包路径，删除要的是对象路径 */
interface SearchResultItem {
  name: string
  path: string
}

interface SearchAssetsResponse {
  ok: boolean
  count: number
  total?: number
  truncated?: boolean
  results: SearchResultItem[]
}

// ============================================================================
// 目录展开
// ============================================================================

/**
 * 一次搜索最多回多少条 —— 插件把 limit 钳在 500（`Handle_SearchAssets`）。
 * 超过这个数的目录不能静默只删一半：截断了就停下来让调用方按子目录分。
 */
export const FOLDER_EXPAND_LIMIT = 500

/**
 * 一条路径**可能**是目录。
 *
 * 对象路径一定带 `.`（`/Game/A/B.B`），带点的肯定是资产。不带点的既可能是目录，
 * 也可能是资产的包路径（`/Game/A/B`，引擎侧 `content.delete` 自己会解析）——
 * 这里只做初筛，真假由 `content.search` 有没有搜到东西决定：搜到就是目录，
 * 搜不到就原样交给引擎按资产处理，不在这里替引擎判死。
 */
export function looksLikeFolder(path: string): boolean {
  const trimmed = path.trim().replace(/\/+$/, '')
  if (!trimmed.startsWith('/')) return false
  const last = trimmed.slice(trimmed.lastIndexOf('/') + 1)
  return last.length > 0 && !last.includes('.')
}

/**
 * 是不是挂载根（`/Game`、`/Engine`、`/<插件名>`）。
 *
 * 根目录也「长得像目录」，展开就是整个工程的内容。一次审批只显示 `/Game` 四个字符，
 * 用户看不出后面是几百个资产 —— 这里直接拒，要清工程就让他自己在编辑器里做。
 */
export function isMountRoot(path: string): boolean {
  const trimmed = path.trim().replace(/\/+$/, '')
  return /^\/[^/]+$/.test(trimmed)
}

/** 搜索结果的包路径 + 资产名 → 引擎删除要的对象路径 */
export function toObjectPath(item: SearchResultItem): string {
  return `${item.path}.${item.name}`
}

/**
 * 删除的超时按批量大小放。
 *
 * 原来固定 30 秒：一批 282 个必超时，引擎还在删、盒子已经报「请求超时」，
 * 模型照着「失败」重试就是第二遍占死主线程。删除在游戏线程上同步跑
 * （`ForceDeleteObjects` 内含一次 GC 加逐对象替换引用），大关卡上每个资产
 * 按 2 秒预算；封顶 10 分钟。
 */
export function deleteTimeoutMs(pathCount: number): number {
  const PER_PATH_MS = 2_000
  const BASE_MS = 30_000
  const CAP_MS = 10 * 60_000
  return Math.min(CAP_MS, BASE_MS + PER_PATH_MS * Math.max(0, pathCount))
}

type ExpandOutcome =
  | { ok: true; assetPaths: string[]; expanded: Record<string, number> }
  | { ok: false; error: string }

/**
 * 把目录换成它下面的对象路径。
 *
 * 显式给的资产原样保留；目录用 `content.search`（path 限定 + 通配）展开，
 * 引擎侧 `bRecursivePaths = true`，子目录一起进来。同一资产既被点名又在目录里
 * 只留一份 —— 引擎按路径计数，重复会把 requested_count 撑大。
 */
async function expandFolders(
  paths: string[],
  callRequest: (
    method: string,
    params: Record<string, unknown>,
    connectionId: string | undefined,
    timeoutMs: number
  ) => Promise<SearchAssetsResponse | undefined>,
  connectionId: string | undefined
): Promise<ExpandOutcome> {
  // 按包路径去重：`/Game/Dir/A`（包路径）和目录展开出的 `/Game/Dir/A.A` 是同一个资产，
  // 两个都发引擎会把 requested_count 撑大、还多报一条「no asset」的假失败。
  // 同一资产两种写法并存时留对象路径那份
  const assets = new Map<string, string>()
  const addAsset = (path: string): void => {
    const key = toPackagePath(path).toLowerCase()
    const existing = assets.get(key)
    if (!existing || (!existing.includes('.') && path.includes('.'))) assets.set(key, path)
  }
  const expanded: Record<string, number> = {}

  const explicit: string[] = []
  const folders: string[] = []
  for (const raw of paths) {
    const path = raw.trim()
    if (!path) continue
    if (isMountRoot(path)) {
      return {
        ok: false,
        error:
          `${path} 是挂载根，不能整个删 —— 那是整个工程（或整个插件）的内容。什么都没删。` +
          '要清的是里面哪些目录就点名传那些目录。'
      }
    }
    ;(looksLikeFolder(path) ? folders : explicit).push(path)
  }

  // 嵌套的目录只搜外层：引擎侧递归，内层会跟着出来，再搜一遍是白等一个往返
  const roots = folders
    .map((folder) => folder.replace(/\/+$/, ''))
    .filter(
      (folder, _index, all) =>
        !all.some((other) => other !== folder && folder.startsWith(`${other}/`))
    )

  const responses = await Promise.all(
    roots.map((folder) =>
      callRequest(
        'content.search',
        { query: '*', path: folder, limit: FOLDER_EXPAND_LIMIT },
        connectionId,
        30_000
      )
    )
  )

  for (const [index, folder] of roots.entries()) {
    const response = responses[index]
    if (!response || !response.ok) {
      const reason = (response as { error?: string } | undefined)?.error ?? '搜索无响应'
      return { ok: false, error: `展开目录 ${folder} 失败：${reason}。什么都没删。` }
    }
    if (response.truncated) {
      const total = response.total ?? response.count
      return {
        ok: false,
        error:
          `目录 ${folder} 下有 ${total} 个资产，超过一次能展开的 ${FOLDER_EXPAND_LIMIT} 个，什么都没删。` +
          '按子目录分几次传（用 ue_content_search 的 include_folders=true 看子目录各有多少），' +
          '不要退回 Python 循环 delete_asset。'
      }
    }

    // 旧插件可能没有 results 字段：当空处理，别在这里 TypeError
    const results = response.results ?? []
    if (results.length === 0) {
      // 没搜到：要么是资产的包路径，要么是空目录 / 不存在。都交给引擎，
      // 它会按包路径解析或回「no asset at this path」—— 比这里猜准
      addAsset(folder)
      continue
    }

    expanded[folder] = results.length
    for (const item of results) addAsset(toObjectPath(item))
  }

  for (const path of explicit) addAsset(path)

  return { ok: true, assetPaths: Array.from(assets.values()), expanded }
}

// ============================================================================
// 工具定义
// ============================================================================

/**
 * 创建删除资产工具
 * @returns 删除资产工具实例
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createDeleteAssetsTool() {
  return defineV2Tool({
    description: `删除虚幻引擎项目中的资产或整个目录（彻底删除，不可逆；一批提交，引擎只跑一遍 GC）。

【警告】删除不可逆，删之前和用户核对清单。

【整个目录】直接把目录路径放进 paths（如 "/Game/ThirdParty/AnimeGirl"），工具自己展开子目录里的
全部资产，合成一批提交。**传目录先 dry_run=true 拿清单给用户看**（审批卡只显示目录名，看不到里面），
用户点头再真删。挂载根（/Game、/Engine、/插件名）一律拒绝。**不要**用 ue_content_search 列出来一个个传，**更不要**在 Python 里循环
EditorAssetLibrary.delete_asset —— 每次调用都做一次完整 GC，几百个资产就是十几分钟主线程占死，
之后所有引擎命令一起超时。一个目录超过 500 个资产时工具会拒绝并让你按子目录分批。

【删不掉时**先读 reason，不要重试**】每条失败都带查出来的真原因，三类各有各的做法：
- **「this agent's own undo history」**：你自己刚才改过它，撤销记录攥着它。
  **别换 Python、别重试** —— 同一堵墙。把「要丢掉几步撤销」告诉用户，
  他同意了再带 drop_agent_undo=true 调一次（只丢你的撤销，用户的撤销历史不动）。
- **「read-only on disk」**：包文件只读。版本控制管着就让用户签出；
  另一条会话的资产锁就等它结束；用户自己设的就让用户解除。
- **「still referenced by: …」**：真被列出来的那些东西引用着。先处理引用方
  （删掉引用它的 Actor、改掉引用它的资产），或者告诉用户删不了。

【超时】大批量在大关卡上会跑很久，超时不等于失败 —— 引擎多半还在删。**不要重发**，
先用 ue_content_search 回读目录还剩什么，再决定下一步。

【参数】paths（必填，资产对象路径或目录包路径混放）、dry_run（只展开不删，传目录时先来一次）、
drop_agent_undo（见上，默认 false）。

【返回】ok、deleted_count（按路径算）、deleted、failed:[{path, reason}]、
expanded_folders（每个目录展开出多少个资产）、
dropped_agent_undo_steps（这次丢掉的撤销步骤标题，**有的话必须转述给用户**）。`,

    inputSchema: DeleteAssetsSchema,

    // dry_run 只在盒子这边展开清单，不碰引擎：按 safe 问，预演上的「本次会话都允许」放不过真删
    riskFor: (args) =>
      (args as { dry_run?: unknown } | null)?.dry_run === true ? 'safe' : 'destructive',

    execute: async (input) => {
      console.log('[DeleteAssetsTool] 收到请求:', input)

      try {
        const wsService = serviceManager.getWebSocketService()
        if (wsService.getConnectionCount() === 0) {
          return {
            success: false,
            error: UE_NOT_CONNECTED_MESSAGE
          }
        }

        const connectionId = getTargetConnectionId()

        const expansion = await expandFolders(
          input.paths,
          (method, params, conn, timeoutMs) =>
            wsService.callRequest<SearchAssetsResponse>(method, params, conn, timeoutMs),
          connectionId
        )
        if (!expansion.ok) {
          return { success: false, error: expansion.error }
        }

        const { assetPaths, expanded } = expansion
        const expandedFolders = Object.keys(expanded)

        if (assetPaths.length === 0) {
          return { success: false, error: '没有给任何路径。' }
        }

        if (input.dry_run) {
          return {
            success: true,
            dry_run: true,
            would_delete: assetPaths,
            expanded_folders: expanded,
            message:
              `预演：会删除 ${assetPaths.length} 个资产，引擎什么都没动。` +
              '把这份清单给用户核对，他同意后再不带 dry_run 调一次。'
          }
        }

        // 构建请求参数
        const params = {
          paths: assetPaths,
          drop_agent_undo: input.drop_agent_undo === true
        }

        console.log('[DeleteAssetsTool] 发送 content.delete 请求:', params)

        // 只读的包引擎删不掉且不报错（实测），而那个位可能正是盒子自己翻的。
        // 资产马上就没了，先把自己那份保护撤掉 —— 别让我们自己的锁把自己挡在门外
        await releaseProtectionBeforeDelete(connectionId, assetPaths.map(toPackagePath))

        const response = await wsService.callRequest<DeleteAssetsResponse>(
          'content.delete',
          params,
          connectionId,
          deleteTimeoutMs(assetPaths.length)
        )

        console.log('[DeleteAssetsTool] 收到响应:', response ? '成功' : '无数据')

        if (response && response.ok) {
          const result: Record<string, unknown> = {
            success: true,
            deleted_count: response.deleted_count,
            requested_count: response.requested_count,
            deleted: response.deleted,
            message: `已删除 ${response.deleted_count}/${response.requested_count} 个资产`
          }

          if (expandedFolders.length > 0) {
            result.expanded_folders = expanded
            result.message = `${result.message}（目录展开：${expandedFolders
              .map((folder) => `${folder} ${expanded[folder]} 个`)
              .join('、')}）`
          }

          if (response.failed && response.failed.length > 0) {
            result.failed = response.failed
            result.message = `${result.message}，${response.failed.length} 个失败`
          }

          // 丢掉的撤销步骤要顶到消息里，不能只躺在字段里等模型自己去翻 ——
          // 那是用户真金白银损失的东西，必须被转述出去
          const dropped = response.dropped_agent_undo_steps
          if (dropped && dropped.length > 0) {
            result.dropped_agent_undo_steps = dropped
            result.message =
              `${result.message}。为此丢掉了你自己的 ${dropped.length} 步撤销记录` +
              `（${dropped.join('、')}），这几步再也撤不回来了，请在回复里告诉用户`
          }

          return result
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const msg = (response as any)?.error || (response as any)?.message || '无响应或 ok=false'
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const code = (response as any)?.__rpc?.code ?? (response as any)?.code
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const details = (response as any)?.details
        return {
          success: false,
          error: `删除资产失败：${msg}`,
          code,
          details,
          raw: response
        }
      } catch (error) {
        console.error('[DeleteAssetsTool] 执行失败:', error)
        /*
         * 超时要保住 code，还要把「引擎多半还在删」说出来。
         *
         * 删除在游戏线程上同步跑，盒子等不到不等于引擎没做；此刻再发任何命令
         * 都只会一起超时。让模型去回读，而不是重试或试探。
         */
        const described = describeToolError(error)
        if (isEngineTimeout(error)) {
          described.error +=
            ' 删除在引擎主线程上同步执行，超时只说明盒子没等到，引擎多半还在删。' +
            '不要重发、不要再发别的命令试探 —— 主线程被占住时它们会一起超时。' +
            '先用 ue_session_health 确认编辑器进程和连接都还在，再用 ue_content_search 回读目录还剩什么。'
        }
        return described
      }
    }
  })
}
