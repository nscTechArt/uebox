/**
 * `blueprint_library_apply` —— 把库里的一段逻辑放进当前工程。
 *
 * ## 走的是引擎自己的粘贴
 *
 * 发给插件的是 `blueprint.import_t3d`，它调的是编辑器 Ctrl+V 那对函数
 * （`FEdGraphUtilities::ImportNodesFromText`）。盒子这边**不重建节点、
 * 不翻译、不排版** —— 存进库的是哪段文本，发下去的就是哪段。
 *
 * 上一版走的是「读侧描述 → 写侧重建」那条结构化路线，2026-09-12 的真机验证
 * 把它否了：重建只建默认形态，用户手动加过引脚的 Sequence 粘回去少一条分支，
 * 挂在上面的逻辑静默断开。。
 *
 * ## 这是整条链路里唯一会改用户工程的一步，四道闸按顺序过
 *
 *   1. **能力探测**（决定 9 前置 C）—— 插件必须自称支持 `require_empty`。
 *      为 false / 字段缺失 / 探不到，一律拒绝。旧插件收到 `require_empty`
 *      不会拒绝执行，盒子以为开了保险、插件照写不误。
 *      探完把 connectionId **钉死**，后面每一条命令都发给同一条连接（见下）。
 *   2. **引擎内保证** —— `require_empty: true` 交给插件，在同一条命令里判空，
 *      不空就一个节点都不粘。
 *   3. **粘完核对** —— 插件的 `ok: true` 只代表**粘进去了**。编译结果另在
 *      `compile_error_count` / `diagnostics` 里，断掉的自身引用另在
 *      `self_context_unresolved` 里。只看 `ok` 会把一张编不过的图存进用户工程
 *      还说「编译通过」。
 *   4. **落盘 + 核对**（决定 8）—— 前面都过了才 `ue_save`，点名存目标资产，
 *      再确认它出现在回执的 `saved` 里。不确认就不许报 success。
 *
 * ## 为什么把 connectionId 钉死
 *
 * `getTargetConnectionId()` 每次调用都会重新解析，连接掉了会自动认回同一个
 * 工程的新连接（`projectTargetContext.ts` 的自愈）。那个自愈对普通工具是对的，
 * 但对这里是致命的：**能力探测发给了 A 连接，写入可能发给 B 连接**，
 * 而 B 那头装的插件可能是旧的 —— 探过的和写入的不是同一个对象，闸 1 白设。
 * 所以开头取一次、之后全程用它。
 *
 * ## 为什么不再自己探目标图是否为空
 *
 * 上一版在这里先 get_graph 数一遍节点，大于零就拒绝。那是错的：
 * **新建的空函数图自带 FunctionEntry**（可能还有 Result），节点数不为零；
 * **新建的 Actor 蓝图事件图自带三个占位事件节点**（真机实测，发现二）。
 * 判空的判据只有一份，在插件里（`UAL_IsGraphEmptyForImport`，它会忽略
 * 引擎自己铺的占位节点），它的错误信息也比我们猜的更准 —— 直接把它透出来。
 */

import { z } from 'zod'

import { defineV2Tool, type V2Tool } from '../../adaptV2Tool'
import { serviceManager } from '../../../../services'
import { resolveBlueprintPathInput } from '../ue-blueprint/resolveBlueprintPath'
import { resolveWriteConnection } from './writeConnection'
import { findEntryById, readSnippetPayload } from '../../../../services/library/libraryEntryStore'
import { checkPluginCapability } from '../../../../services/library/pluginCapabilities'
import { containsAsset, toPackagePath } from '../../../../utils/uePackagePath'
import { requireVaultRoot } from './vaultRoot'

const ApplySchema = z.object({
  entry_id: z.string().describe('库条目 id，用 library_search 拿'),
  blueprint_path: z
    .string()
    .describe('要写进哪个蓝图，如 "/Game/Blueprints/BP_Enemy" 或短名 "BP_Enemy"'),
  graph_name: z
    .string()
    .optional()
    .describe('写进哪张图，默认 EventGraph。**这张图必须已存在且为空**'),
  mode: z
    .literal('into_empty_graph')
    .describe('第一版只支持写进一张已存在的空图。追加到有内容的图还没做')
})

interface CompileDiagnostic {
  severity?: string
  message?: string
  node_id?: string
}

interface ImportT3dResponse {
  /** **只代表粘进去了**，不代表编译过了 —— 编译结果在下面几个字段里 */
  ok?: boolean
  graph_name?: string
  imported_count?: number
  structural?: boolean
  undoable?: boolean
  /** 被顶掉的引擎占位事件节点（新建蓝图自带的灰色 BeginPlay 那种） */
  removed_ghost_events?: string[]
  /**
   * 粘进来但**引用断了**的节点：它们调的是源蓝图自己类上的函数，
   * 这个工程里没有。编辑器粘贴到这一步会弹修正框，自动化路径弹不了，
   * 所以插件如实报告。
   */
  self_context_unresolved?: string[]
  compiled?: boolean
  compile_error_count?: number
  compile_warning_count?: number
  diagnostics?: CompileDiagnostic[]
  /**
   * 插件走 `SendError()` 时（`require_empty` 拒绝就是这一条），原因落在这儿。
   *
   * 传输层把 `code >= 400` 的响应归一化成
   * `{ ok:false, success:false, error: <message>, code }`
   * （`websocket/server.ts` 的 normalized 那段）。
   */
  error?: string
  message?: string
  code?: number
  /** SendError 的 Details，`require_empty` 把 `reason` 放在这里 */
  reason?: string
}

/**
 * 从回执里抠出「为什么没粘成」。
 *
 * `error`/`message` 是 SendError 归一化后的那句，`reason` 是 Details 里的原因
 * （通常已经被包在 error 那句里了，只在没被覆盖时补上）。
 * 一个都没有才退回泛化文案 —— 那说明插件确实什么都没说。
 */
function describeApplyFailure(response: ImportT3dResponse): string {
  const parts: string[] = []

  const topLevel = response.error || response.message
  if (topLevel) parts.push(topLevel)

  if (response.reason && !parts.some((part) => part.includes(response.reason as string))) {
    parts.push(response.reason)
  }

  return parts.length > 0 ? parts.join('；') : '粘贴失败（插件没有给出原因）'
}

/**
 * 插件根本不认识这条命令。
 *
 * 路由表查不到时插件回的是 404 `Unknown method: xxx`。这种情况下**一个字都没写**，
 * 安全上没问题，但错误原文（"Unknown method"）对用户毫无意义 —— 翻译成「插件太旧」。
 *
 * 为什么不像 `require_empty` 那样加一个能力位：能力位要改插件源码，
 * 而改一行源码就得把九个引擎版本的分发包全部重编。`import_t3d` 的缺席是
 * **命令级**的，插件会明着拒绝、不会静默照做，所以事后识别就够了 ——
 * 这和 `require_empty`「旧插件收到会静默忽略」是两种性质的问题。
 */
function isUnknownCommand(response: ImportT3dResponse): boolean {
  if (response.code !== 404) return false
  const text = response.error || response.message || ''
  return /unknown method/i.test(text)
}

interface SaveResponse {
  success?: boolean
  saved?: string[]
  failed?: Array<{ package?: string; error?: string }>
  still_dirty_count?: number
  error?: string
}

export function createBlueprintLibraryApplyTool(): V2Tool {
  return defineV2Tool({
    description: `把蓝图库里的一段逻辑放进当前工程的一张空图里。

【先决条件】
- 目标图**必须已经存在，而且是空的**。这条命令不会建图。
  要新建函数图用 blueprint_create_function（**别给它声明参数和返回值**，
  声明了就不算空图了）；事件图只能用户自己在 UE 里建。
  新建蓝图自带的那几个灰色占位事件节点不算「不空」。
- 工程里的 UnrealAgentLink 插件必须够新。太旧会在写入前被拒绝并提示更新。

【第一版不做什么】
- 不追加到有内容的图（那会顶掉用户已有的连线）
- 不放老格式条目 —— 那种是手工粘进库的整张图，没扫过依赖，
  只能在库里打开、复制代码，去 UE 里自己粘

【做完了会怎样】
粘贴 → 编译 → 保存目标资产 → 确认它真的存下去了。
任何一步没确认上都报失败，不会说「成功」然后什么都没留下。`,

    inputSchema: ApplySchema,

    execute: async (input) => {
      const vault = requireVaultRoot()
      if ('error' in vault) return { success: false, error: vault.error }

      /**
       * 本次操作钉死的连接。
       *
       * 必须是一个**明确的 id**，不能是 undefined —— 传 undefined 下去，
       * 底层会在每一次请求时重新挑连接（`pickDefaultConnectionId`），
       * 于是能力探测挑中新版、写入挑中重连后的旧版，闸 1 白设。
       *
       * 解析不出来就直接拒绝，不留「让底层去猜」这条路。
       */
      const connection = resolveWriteConnection()
      if ('error' in connection) {
        return { success: false, error: connection.error }
      }
      const pinnedConnectionId = connection.connectionId

      // ── 闸 1：能力探测，失败即关。探的就是 pinnedConnectionId 那一条 ──
      const capability = await checkPluginCapability('blueprint_require_empty', pinnedConnectionId)
      if (!capability.supported) {
        return {
          success: false,
          error: capability.reason,
          plugin_version: capability.pluginVersion,
          hint: '这道保护在插件里，盒子这边发参数没用 —— 旧插件收到会直接忽略。'
        }
      }

      // ── 读条目 ──
      const found = await findEntryById(vault.vaultRoot, 'blueprint', input.entry_id)
      if (!found) {
        return { success: false, error: `蓝图库里没有 id 为 ${input.entry_id} 的条目。` }
      }

      const payload = readSnippetPayload(found.entry.manifest.payload)
      if (!payload) {
        return {
          success: false,
          error:
            `「${found.entry.manifest.name}」是手工粘进库的老条目，没有扫过依赖，放不进工程。` +
            '在库里打开它、复制代码，然后在 UE 的蓝图编辑器里粘贴。'
        }
      }

      const wsService = serviceManager.getWebSocketService()

      try {
        const resolvedBlueprint = await resolveBlueprintPathInput(input.blueprint_path)
        const resolved = resolvedBlueprint.blueprintPath
        if (!resolved) {
          return {
            success: false,
            error: resolvedBlueprint.wasPlaceholder
              ? '认不出「当前蓝图」是哪个。在 UE 里打开目标蓝图再试，或者直接给出路径。'
              : '缺少必填参数：blueprint_path'
          }
        }

        const graphName = input.graph_name || 'EventGraph'

        // ── 闸 2：引擎内保证 ──
        const response = await wsService.callRequest<ImportT3dResponse>(
          'blueprint.import_t3d',
          {
            blueprint_path: toPackagePath(resolved),
            graph_name: graphName,
            // 存进库的是哪段文本，发下去的就是哪段，盒子一个字都不改
            text: payload.t3d,
            // 真正拦住误伤的就是这一条
            require_empty: true,
            compile: true
          },
          pinnedConnectionId,
          60_000
        )

        if (!response) {
          return { success: false, error: '插件没有响应（blueprint.import_t3d）' }
        }

        if (!response.ok) {
          if (isUnknownCommand(response)) {
            return {
              success: false,
              error:
                '工程里的 UnrealAgentLink 插件太旧，还没有「放回片段」这条命令。' +
                '请在设置里更新插件后再试。',
              saved: false
            }
          }

          return {
            success: false,
            // 判空失败的具体原因（「函数已有局部变量」这类）在 error/message 上
            error: describeApplyFailure(response),
            saved: false
          }
        }

        /*
         * ── 闸 3：粘完核对 ──
         *
         * `ok: true` **只代表粘进去了**。两件事要单独查：
         *   - 编译过没过（插件先无条件置 ok，再跑 CompileBlueprint 把结果附上）
         *   - 有没有节点的自身引用断了（`self_context_unresolved`）——
         *     这种节点在编辑器里是红的，多数情况编译也会报错，但报的是
         *     「找不到函数」这类间接信息，不如插件这份清单直白
         */
        const unresolved = response.self_context_unresolved ?? []
        const compileErrors = response.compile_error_count ?? 0

        if (unresolved.length > 0 || compileErrors > 0) {
          const details = (response.diagnostics ?? [])
            .filter((item) => item.severity === 'error')
            .slice(0, 10)
            .map((item) => (item.node_id ? `[${item.node_id}] ${item.message}` : item.message))
            .filter(Boolean)

          const reason =
            unresolved.length > 0
              ? `粘进去了，但有 ${unresolved.length} 个节点引用了这个工程里没有的东西：\n` +
                unresolved.slice(0, 10).join('\n')
              : `图粘进去了，但**编译没过**（${compileErrors} 个错误）：\n` +
                (details.length > 0 ? details.join('\n') : '插件没有给出具体诊断')

          return {
            success: false,
            error: reason,
            ...(unresolved.length > 0 ? { self_context_unresolved: unresolved } : {}),
            ...(compileErrors > 0
              ? { compile_error_count: compileErrors, diagnostics: response.diagnostics }
              : {}),
            // 没确认干净就不保存 —— 别把一张带红节点的图落进用户的工程
            saved: false,
            hint:
              response.undoable === false
                ? '目标图里现在有这些节点，而且本次改动无法用 Ctrl+Z 撤销，得在 UE 里手动清掉。'
                : '目标图里现在有这些节点。在 UE 里撤销（Ctrl+Z）或手动清掉。'
          }
        }

        // ── 闸 4：落盘 + 核对 ──
        const targetPackage = toPackagePath(resolved)
        const save = await wsService.callRequest<SaveResponse>(
          'editor.save',
          { scope: 'list', assets: [targetPackage] },
          pinnedConnectionId,
          120_000
        )

        if (!save) {
          return {
            success: false,
            error: '图粘进去了，但保存没有响应 —— 改动可能只在内存里。请在 UE 里手动保存。'
          }
        }

        const failed = save.failed?.find((item) =>
          item.package ? containsAsset([item.package], targetPackage) : false
        )
        if (failed) {
          return {
            success: false,
            error: `图粘进去了，但保存失败：${failed.error ?? '未提供原因'}`,
            hint: '常见原因是资产只读或被源码管理签出。'
          }
        }

        // ue_save 的回执没有 still_dirty 列表，still_dirty_count 是**全工程**口径，
        // 判断不了目标资产。唯一可靠的判据是「目标出现在 saved 里」。
        if (!containsAsset(save.saved, targetPackage)) {
          return {
            success: false,
            error:
              `图粘进去了，但没确认上是否保存 —— 目标资产没有出现在保存回执里。` +
              '请在 UE 里手动保存一次确认。',
            saved_packages: save.saved
          }
        }

        const openPorts = payload.meta.openPorts
        const removedGhosts = response.removed_ghost_events ?? []

        return {
          success: true,
          entry_name: found.entry.manifest.name,
          blueprint_path: targetPackage,
          graph_name: response.graph_name || graphName,
          node_count: response.imported_count ?? payload.meta.nodeCount,
          ...(response.undoable === false ? { undoable: false } : {}),
          // 编译警告不拦，但要如实带出来 —— 用户有权知道图不是干干净净进去的
          ...(response.compile_warning_count
            ? { compile_warning_count: response.compile_warning_count }
            : {}),
          ...(removedGhosts.length > 0
            ? {
                removed_ghost_events: removedGhosts,
                removed_ghost_events_note:
                  '这些是目标蓝图新建时引擎自己铺的灰色占位事件节点，被粘进来的同名事件顶掉了。' +
                  '编辑器自己的粘贴也是这么做的，用户自己放的事件节点一个都没动。'
              }
            : {}),
          ...(openPorts.length > 0
            ? {
                open_ports: openPorts.map((port) => `${port.nodeId}.${port.pinName}`),
                open_port_note: '这些引脚在片段里是断的，需要在 UE 里手动接上。'
              }
            : {}),
          summary:
            `已把「${found.entry.manifest.name}」放进 ${targetPackage} 的 ${graphName}，` +
            `编译通过并已保存。` +
            (openPorts.length > 0 ? ` 有 ${openPorts.length} 个悬空端口要手动接。` : '') +
            (response.undoable === false ? ' 注意：本次改动无法用 Ctrl+Z 撤销。' : '')
        }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  })
}
