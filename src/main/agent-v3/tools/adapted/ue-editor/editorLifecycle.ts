/**
 * 编辑器生命周期：重启、垃圾回收、清理重定向器。
 *
 * 这三件事此前一件都做不了。装完插件、跑完一轮批量导入、移动完一批资产之后，
 * agent 没有任何办法收尾 —— 只能让用户自己去编辑器里点。
 */

import { defineV2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import { serviceManager } from '../../../../services'
import { callUeRawWhenRegistryReady, UE_NOT_CONNECTED_MESSAGE } from '../../defineUeTool'
import { checkoutLines } from '../../ue-content/summaries'
import type { CheckoutPreflight } from '../../ue-content/types'
import { describeToolError } from '../../engineErrors'

import { getTargetConnectionId, setTargetConnectionId } from '../../../core/projectTargetContext'
import { projectManager } from '../../../../services/project'
import { describeUnsavedRefusal } from '../unsavedRefusal'

function requireConnection(): { success: false; error: string } | null {
  if (serviceManager.getWebSocketService().getConnectionCount() === 0) {
    return {
      success: false,
      error: UE_NOT_CONNECTED_MESSAGE
    }
  }
  return null
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * socket 接上之后，再给多少时间等「真的能干活」（握手 + 回读校验跑通）。
 *
 * 单独一份预算、不跟 `timeout_seconds` 共用：那个是留给「编辑器起得慢」的，
 * 而这一段是 socket 已经通了之后的事。共用的话，编辑器在第 299 秒才回来时
 * 这一步刚好一点时间都不剩。
 *
 * 给到 60 秒是因为回来之后编辑器往往还在加载关卡，游戏线程被占着，
 * 探针可能要等上几十秒才轮得到执行。宁可多等，也不要把一次健康的重启
 * 判成「没确认上」。
 */
const LIVE_CHECK_GRACE_MS = 60_000

/**
 * 回读校验用的只读命令。
 *
 * 选它是因为：插件一定实现了（`system.get_project_info`，握手报工程信息就是这套），
 * 只读、不改任何东西，而且它跑通恰好证明了后续命令需要的每一环 ——
 * socket 通、连接 id 对得上、插件的命令分发在转、游戏线程能响应。
 */
const PROBE_METHOD = 'system.get_project_info'
const PROBE_TIMEOUT_MS = 15_000
const PROBE_RETRY_MS = 1_000

/**
 * 等编辑器的 socket 回来。
 *
 * 分两段等，缺一不可：
 *
 *   1. **先等它真的断开。** 重启是异步的（插件先回响应、下一帧才退进程），
 *      不等断开就去等重连，会立刻看到重启**之前**那条还活着的连接，
 *      于是马上报「已恢复」—— 而编辑器一秒后才开始退。那是个假成功。
 *   2. 再等新连接建立。
 *
 * 注意这里只管到 socket 层。**socket 回来 ≠ 能干活**，那要靠 `waitUntilLive`
 * 真发一条命令去确认。
 */
async function waitForSocketBack(timeoutMs: number): Promise<{
  socketBack: boolean
  /** 有值 = 确实看到过断开，也就是重启确实发生了 */
  droppedMs?: number
}> {
  const ws = serviceManager.getWebSocketService()
  const started = Date.now()

  let droppedAt: number | undefined
  while (Date.now() - started < timeoutMs) {
    if (ws.getConnectionCount() === 0) {
      droppedAt = Date.now()
      break
    }
    await sleep(250)
  }

  // 一直没断开：可能重启压根没发生（插件版本旧、没有这个命令），
  // 也可能编辑器起得比我们轮询还快。两种都不能报成功。
  if (droppedAt === undefined) {
    return { socketBack: false }
  }

  while (Date.now() - started < timeoutMs) {
    if (ws.getConnectionCount() > 0) {
      return { socketBack: true, droppedMs: droppedAt - started }
    }
    await sleep(500)
  }

  return { socketBack: false, droppedMs: droppedAt - started }
}

interface LiveCheck {
  /** 真发过一条只读命令并且收到了响应 —— 到这一步才敢说「可以继续干活了」 */
  live: boolean
  /** 探针最后一次失败的原因，报给用户时带上，省得他自己猜 */
  lastError?: string
}

/**
 * 确认「真的能继续发命令了」，而不是「看起来连上了」。
 *
 * 做两件事，循环到超时为止：
 *
 *   1. **认回工程、换掉目标连接。** 每轮开始时 `resolveTargetProject()` 把
 *      connectionId 算出来定死在执行流上，而重启把那条连接掐了 —— 断开时
 *      `deleteProject()` 会**整条删掉**旧记录，编辑器回来时是一个全新的 uuid。
 *      不换的话，同一轮里后面每条引擎命令都发往那个死 id，全部回
 *      「客户端不存在或已断开」，看着像编辑器没起来。
 *      认工程靠 `projectPath` —— 必须在发重启命令**之前**抓，那时旧记录还在。
 *   2. **回读校验。** 拿到新 id 之后再真发一条只读命令，收到响应才算数。
 *
 * 第 2 步是这个工具出过事的地方：以前只看连接数和记录在不在，就报
 * `reconnected: true`。这两样都只说明「有个 socket 连着」，不说明这条连接
 * 能把命令送到插件手里。现场表现是重启报成功、紧接着每一条引擎命令都回
 * 「客户端不存在或已断开」—— 而失败信息指的还不是根因。
 *
 * **不回读校验的「成功」等于没有成功。**
 */
async function waitUntilLive(
  previousProjectPath: string | undefined,
  deadline: number
): Promise<LiveCheck> {
  let lastError: string | undefined

  for (;;) {
    const rebound = previousProjectPath
      ? projectManager.getConnectionIdByPath(previousProjectPath)
      : undefined
    if (rebound) setTargetConnectionId(rebound)

    // 还没认回工程时不发探针：目标还指着那个死 id，发出去必然失败，
    // 白等一轮不说，lastError 还会是个误导人的「客户端不存在」。
    //
    // `previousProjectPath` 本来就没有时是另一回事：那说明这一轮压根没绑定
    // 目标工程（纯对话会话），`getTargetConnectionId()` 是 undefined，
    // callRequest 会自己挑 —— 而且只在恰好一个连接时才挑，多连接一律拒绝。
    if (rebound || !previousProjectPath) {
      try {
        const probe = await serviceManager
          .getWebSocketService()
          .callRequest<unknown>(PROBE_METHOD, {}, getTargetConnectionId(), PROBE_TIMEOUT_MS)
        if (probe) return { live: true }
        lastError = `${PROBE_METHOD} 没有返回内容`
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      }
    } else {
      lastError = '插件还没把工程信息报回来，拿不到重启后的新连接'
    }

    if (Date.now() >= deadline) {
      return { live: false, ...(lastError ? { lastError } : {}) }
    }
    await sleep(PROBE_RETRY_MS)
  }
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createRestartEditorTool() {
  return defineV2Tool({
    description: `重启虚幻编辑器，并等它回来。

什么时候需要：装了或改了插件、改了引擎级配置、编辑器状态明显不对劲。

**会丢弃所有未保存的改动。** 有未保存的东西时这个调用会被拒绝并列出是哪些
—— 那时候应该先 ue_save，而不是直接加 force 重试。

重启期间连接会断开，这个工具会一直等到编辑器重新连上、并且**真的跑通了一次
只读命令**（最多 5 分钟）再返回，同时自动切到新的连接上。所以
**返回 success 就是真的可以继续发引擎命令了**，不需要再自己等或者试探。

失败时看两个字段：\`restarted\` 是编辑器有没有真的重启，\`reconnected\` 是盒子
有没有重新连上它。\`restarted: true, reconnected: false\` 的意思是编辑器起来了、
但盒子这边没接上 —— 这时候**不要重启第二次**，也**不要让用户去界面上点连接**：
连接是插件主动连过来的，断了每 5 秒自己重试，界面上根本没有「连接」按钮。
正确做法是用 \`ue_session_health\` 带 wait_seconds 等它 —— 大工程要先把工程加载完
插件才起来，30–90 秒是常态。等过还是连不上，才是去查插件装没装。

大工程重启要几分钟。如果超时了，不代表重启失败 —— 可能只是还没起完，
用 ue_get_current_level 之类的命令确认一下。

**重启后打开的可能是工程的默认关卡，而不是重启前那个。** 后续操作依赖具体关卡时，
先用 ue_get_current_level 确认，必要时用 ue_open_level 把原来的关卡重新打开。`,

    inputSchema: z.object({
      force: z
        .boolean()
        .optional()
        .describe('丢弃未保存的改动强行重启。只有用户明确要求丢弃时才用，不可撤销'),
      timeout_seconds: z
        .number()
        .int()
        .optional()
        .describe('最多等多久，默认 300 秒。大工程可以给更长')
    }),

    execute: async (input) => {
      const notConnected = requireConnection()
      if (notConnected) return notConnected

      try {
        const params: Record<string, unknown> = {}
        if (input.force !== undefined) params.force = input.force

        // 在掐断连接**之前**记下这一轮操作的是哪个工程 ——
        // 断开时旧记录会被整条删掉，之后就问不出来了。见 rebindTarget。
        const previousId = getTargetConnectionId()
        const projectPath = previousId
          ? projectManager.getProject(previousId)?.projectPath
          : undefined

        // 插件会先回响应再重启，所以这个请求本身不该等太久。
        // 真正的等待在后面 waitForRestart 里。
        const response = await serviceManager.getWebSocketService().callRequest<{
          ok: boolean
          restarting?: boolean
        }>('editor.restart', params, getTargetConnectionId(), 30000)

        const refusal = describeUnsavedRefusal(response, '重启编辑器')
        if (refusal) return { success: false, error: refusal, needs_save_first: true }

        if (!response || !response.ok) {
          const message = (response as unknown as { error?: string })?.error || '重启命令没有被接受'
          return { success: false, restarted: false, reconnected: false, error: message }
        }

        const startedAt = Date.now()
        const timeoutMs = (input.timeout_seconds ?? 300) * 1000
        const outcome = await waitForSocketBack(timeoutMs)

        if (!outcome.socketBack) {
          // 超时**不等于**失败：大工程起得慢。措辞必须留出这个可能，
          // 否则模型会以为重启没成功，然后再重启一次 —— 那才是真的坏事。
          const neverDropped = outcome.droppedMs === undefined
          return {
            success: false,
            // 连接一直没断 = 大概率压根没重启；断了没回来 = 重启确实发生了
            restarted: !neverDropped,
            reconnected: false,
            timed_out: true,
            error: neverDropped
              ? '发出了重启命令，但连接一直没有断开 —— 编辑器可能没有真的重启（插件版本过旧？）。'
              : `编辑器已经关闭，但在超时前没有重新连上。这不一定是失败 —— 大工程启动就是慢。` +
                `过一会用 ue_get_current_level 确认一下它是否已经回来。`
          }
        }

        // socket 回来了 ≠ 能干活。认回工程换掉目标连接，再真发一条只读命令
        // 确认这条连接能把命令送到插件手里 —— 不回读校验的成功等于没有成功。
        const check = await waitUntilLive(projectPath, Date.now() + LIVE_CHECK_GRACE_MS)

        if (!check.live) {
          return {
            success: false,
            restarted: true,
            reconnected: false,
            timed_out: true,
            needs_manual_reconnect: true,
            error:
              `编辑器已经重启，但盒子还没重新连上它 —— 现在发任何引擎命令都会失败。\n` +
              (check.lastError ? `最后一次试探的失败原因：${check.lastError}\n` : '') +
              `请用户在盒子界面里重新连接项目；重连之后就能继续了。\n` +
              `**不要重复重启** —— 编辑器本身是好的，问题在连接上。`
          }
        }

        const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000)
        return {
          success: true,
          restarted: true,
          reconnected: true,
          elapsed_seconds: elapsedSeconds,
          summary:
            `编辑器已重启并重新连上，用了约 ${elapsedSeconds} 秒` +
            `（已回读校验：在新连接上跑通了一次 ${PROBE_METHOD}）。可以继续发引擎命令了。\n\n` +
            `注意：现在打开的可能是工程的默认关卡，而不是重启前那个。` +
            `接下来要操作具体关卡的话，先用 ue_get_current_level 确认，` +
            `必要时用 ue_open_level 重新打开原来的关卡。`
        }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  })
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createCollectGarbageTool() {
  return defineV2Tool({
    description: `强制一次垃圾回收，回收编辑器占着不放的内存。

批量导入、批量编译、反复加载卸载资产之后内存会涨上去而且不自动回落 ——
大工程里跑一轮 blueprint_compile_all 常见涨几个 GB。

返回里有回收前后的对象数和内存占用。**看 objects_freed**：内存数受其他线程
影响，可能不降反升，而对象数是这次回收实打实干掉的东西。

回收期间编辑器会卡住一下，大工程可能几秒。不要反复调 —— 连着调第二次
基本回收不到任何东西。`,

    inputSchema: z.object({
      full_purge: z.boolean().optional().describe('完整清理（默认 true）。false 更快但回收得少')
    }),

    execute: async (input) => {
      const notConnected = requireConnection()
      if (notConnected) return notConnected

      try {
        const params: Record<string, unknown> = {}
        if (input.full_purge !== undefined) params.full_purge = input.full_purge

        const response = await serviceManager.getWebSocketService().callRequest<{
          ok: boolean
          objects_before: number
          objects_after: number
          objects_freed: number
          mb_before: number
          mb_after: number
          mb_freed: number
          elapsed_ms: number
        }>('editor.collect_garbage', params, getTargetConnectionId(), 180000)

        if (!response || !response.ok) {
          return { success: false, error: '垃圾回收失败' }
        }

        return {
          success: true,
          objects_before: response.objects_before,
          objects_after: response.objects_after,
          objects_freed: response.objects_freed,
          mb_before: response.mb_before,
          mb_after: response.mb_after,
          mb_freed: response.mb_freed,
          elapsed_ms: response.elapsed_ms,
          summary:
            `回收了 ${response.objects_freed} 个对象` +
            (response.mb_freed > 0
              ? `，释放约 ${response.mb_freed} MB`
              : '（内存占用没有明显下降）') +
            `，耗时 ${response.elapsed_ms}ms`
        }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  })
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createFixupRedirectorsTool() {
  return defineV2Tool({
    description: `清理移动或重命名资产后留下的重定向器。

移动/改名一个资产时，原路径会留下一个重定向器把旧引用转发到新位置。它让旧
引用继续能用，但会一直堆积：引用多绕一跳、Content Browser 里一堆看不见的
垃圾、迁移工程时整条链都被拖着走。

这个工具把引用者改成直接指向新资产，然后删掉重定向器。

**这一步会在编辑器里弹一个「重定向器更新报告」窗口，要有人点一下才继续。**
引擎的清理接口在 UE 5.4+ 无条件弹这个模态框；框弹不出来（脚本模式、没渲染器）时
会被自动取消，5.5+ 引擎接着去读一个没设置的返回值，**编辑器当场崩**（真机撞过三次）。所以：
- 编辑器弹不出这个框（脚本模式 / 无渲染器）→ 插件直接拒绝（409），不会去冒险；
- 「用户不在电脑前」插件**检测不到**：框会一直等到有人点，10 分钟后这边超时、结果不明。
  所以要跑就先跟用户说一声「等下编辑器会弹个框，麻烦点一下确定」；
- 框里默认聚焦的是「Keep Redirectors」，按回车等于保留 —— 提醒用户点「Delete」那个。

**它会把引用者原样落盘。** 引用者里有用户改到一半没存的，也一起存了 ——
返回里的 dirty_referencers 会点名，预演就看得到；不想存就先让用户存或撤销。

**移动过资产之后不是必须跑。** 重定向器留着是安全的：引擎跟着它转发，工程照常能用，
打包也不受影响。它只是会堆积（多绕一跳、迁移时被拖着走），有空再清。
ue_content_move **不会**帮你清（它是无人值守跑的，清了就崩），所以这里管的是它留下的
和历史遗留的全部。先用 dry_run=true 看看有多少、都是哪些、各指向哪 —— dry_run 不弹框。

只想清某几个：paths 给重定向器的包路径或目录，不扫整个 path。

dry_run 的 details 里每条带 target（指向哪）和 broken（目标已经不存在）。列表最多 200 条，
超出时 listed_note 会说明只列了一部分。
坏掉的修不了，默认原地不动；delete_broken=true 才删 —— 删了之后引用它的资产会
从「跟着断链走」变成「找不到对象」，要先确认没人用。只删预演和加载都判定坏的；
加载后才发现坏的（broken_after_load）不删，只报。

引擎在删重定向器前就把改过的引用者存了，正常跑完不会留下未保存的包。返回里的
dirty_after 只数这条命令新弄脏、引擎又没存成的包，有才需要接着调 ue_save。`,

    inputSchema: z.object({
      path: z.string().optional().describe('搜索根路径，默认 /Game。给了 paths 时忽略'),
      paths: z
        .array(z.string().trim().min(1))
        .min(1)
        .optional()
        .describe('只处理这些：重定向器的包路径（/Game/Old/SM_Rock）或目录（/Game/Old/）'),
      dry_run: z
        .boolean()
        .optional()
        .describe('只列出有哪些重定向器、各指向哪、哪些坏了，不做任何改动。第一次跑建议先用它看看'),
      delete_broken: z
        .boolean()
        .optional()
        .describe('目标已不存在的重定向器修不了；true 则把它们删掉，默认 false 原地不动')
    }),

    // 预演不改任何东西，按 safe 问；真正的那次照 destructive 问，而且预演上点的
    // 「本次会话都允许」放不过来（审批门按实际风险分开记）
    riskFor: (args) =>
      (args as { dry_run?: unknown } | null)?.dry_run === true ? 'safe' : 'destructive',

    execute: async (input, { abortSignal } = {}) => {
      try {
        const params: Record<string, unknown> = {}
        if (input.path) params.path = input.path
        // 空数组在 schema 那一层就被拒了；插件那边也把给了但为空的 paths 当「一个都不处理」
        if (input.paths) params.paths = input.paths
        if (input.dry_run !== undefined) params.dry_run = input.dry_run
        if (input.delete_broken !== undefined) params.delete_broken = input.delete_broken

        // 全工程扫描 + 逐个加载重定向器，大工程里要几分钟。
        // 注册表还在扫的时候插件会回 registry_not_ready，这里等它扫完再发；
        // V2 适配件拿不到 report()，所以没有进度行 —— 但中止信号必须带上：
        // 用户按了停止，等注册表的轮询要退出，更不能等完之后把这条破坏性命令再发一遍。
        const response = await callUeRawWhenRegistryReady<{
          ok: boolean
          path: string
          found: number
          broken_count?: number
          /** 执行后仍留在原地的坏重定向器（含加载后才发现坏的） */
          broken_left?: number
          fixed: number
          remaining?: number
          deleted_broken?: number
          dry_run: boolean
          dirty_after?: number
          redirectors: string[]
          details?: { path: string; target?: string; broken?: boolean }[]
          /** redirectors / details 最多列 200 条，超出时插件在这里说明 */
          listed_note?: string
          not_redirectors?: string[]
          /** 加载失败、跳过没处理的重定向器包 */
          load_failed?: string[]
          /** 预演说好、加载后目标却为空的：不删，只报 */
          broken_after_load?: string[]
          /** 引用者里用户改到一半没存的：预演 = 执行时会被原样落盘；执行后 = 还没存的 */
          dirty_referencers?: string[]
          /** 执行后：原本有未保存改动、被引擎原样落盘了的引用者 */
          saved_referencers?: string[]
          /** 注册表里没了但文件还在的重定向器（SCC / 只读拒了删除），已算回 remaining */
          left_on_disk?: string[]
          /** 上面这些名字清单最多列 200 条，超出时插件另给 <字段名>_total 报总数 */
          not_redirectors_total?: number
          load_failed_total?: number
          broken_after_load_total?: number
          dirty_referencers_total?: number
          saved_referencers_total?: number
          left_on_disk_total?: number
          note?: string
          error?: string
          code?: string | number
          /** 引用者与重定向器自身的签出预检（安全网 §2.3）：谁签出着、哪些只读，改之前就知道 */
          checkout?: CheckoutPreflight
          /** FixupReferencers 期间引擎的 Warning 及以上行（EditorErrors / SourceControl 等） */
          engine_log?: string[]
        }>('content.fixup_redirectors', params, {
          timeoutMs: 600000,
          ctx: { report: () => {}, ...(abortSignal ? { signal: abortSignal } : {}) }
        })

        if (!response) {
          return { success: false, error: '插件没有响应（content.fixup_redirectors）' }
        }
        if (!response.ok) {
          // 409 的 details.how_to（右键菜单那条路）、503 的扫描进度都在 details 里，
          // 适配层会把 code 和 details 拼进给模型的那句话，别在这里丢掉。
          // 但 ws 层给每条响应都塞 code（200 也塞），而插件「一个都加载不了」那条是
          // 200 + ok:false，details 里躺着的是 200 条清单 —— 只转错误码和对象形状的 details。
          // 404 也不转：这条命令自己从不回 404，那只会是老插件的「Unknown method」，
          // 转过去会被适配层当成「查无此物」（ENGINE_NOT_FOUND），而它其实是失败
          const failure = response as unknown as { details?: unknown }
          const code =
            typeof response.code === 'number' && (response.code < 400 || response.code === 404)
              ? undefined
              : response.code
          const details =
            failure.details !== undefined && !Array.isArray(failure.details)
              ? failure.details
              : undefined
          return {
            success: false,
            error: response.error ?? '清理重定向器失败',
            ...(code !== undefined ? { code } : {}),
            ...(details !== undefined ? { details } : {})
          }
        }

        const broken = response.broken_count ?? 0
        // 老插件没有 broken_left：按「断链数减去删掉的」估
        const brokenLeft =
          response.broken_left ?? Math.max(0, broken - (response.deleted_broken ?? 0))
        // 看插件报的范围，不看这边发了什么
        const scopeLabel = response.path === '(paths)' ? '指定的路径' : `${response.path} 下`
        // 这条命令没有闸：引用者被别人签出着，FixupReferencers 改不了它，那条重定向器
        // 就留在 remaining 里，其余照常清理 —— 预演和执行都按「部分」的口吻说
        const checkout = checkoutLines(response.checkout, 'partial')
        const dirtyRefs = response.dirty_referencers ?? []
        const savedRefs = response.saved_referencers ?? []
        // 清单被插件截到 200 条时，条数按 _total 报
        const dirtyCount = response.dirty_referencers_total ?? dirtyRefs.length
        const savedCount = response.saved_referencers_total ?? savedRefs.length
        const loadFailedCount = response.load_failed_total ?? response.load_failed?.length ?? 0
        const leftOnDiskCount = response.left_on_disk_total ?? response.left_on_disk?.length ?? 0
        const sample = (names: string[]): string =>
          `${names.slice(0, 5).join('、')}${names.length > 5 ? ' 等' : ''}`
        return {
          success: true,
          path: response.path,
          found: response.found,
          ...(response.broken_count !== undefined ? { broken_count: response.broken_count } : {}),
          ...(response.broken_left !== undefined ? { broken_left: response.broken_left } : {}),
          fixed: response.fixed,
          ...(response.remaining !== undefined ? { remaining: response.remaining } : {}),
          ...(response.deleted_broken !== undefined
            ? { deleted_broken: response.deleted_broken }
            : {}),
          dry_run: response.dry_run,
          ...(response.dirty_after !== undefined ? { dirty_after: response.dirty_after } : {}),
          redirectors: response.redirectors,
          ...(response.details ? { details: response.details } : {}),
          ...(response.listed_note ? { listed_note: response.listed_note } : {}),
          ...(response.not_redirectors ? { not_redirectors: response.not_redirectors } : {}),
          ...(response.load_failed ? { load_failed: response.load_failed } : {}),
          ...(response.broken_after_load ? { broken_after_load: response.broken_after_load } : {}),
          ...(dirtyRefs.length > 0 ? { dirty_referencers: dirtyRefs } : {}),
          ...(savedRefs.length > 0 ? { saved_referencers: savedRefs } : {}),
          ...(response.left_on_disk ? { left_on_disk: response.left_on_disk } : {}),
          // 清单被截到 200 条时的总数，原样带给模型，别让它把截断的清单当成全部
          ...Object.fromEntries(
            Object.entries(response).filter(
              ([key, value]) => key.endsWith('_total') && typeof value === 'number'
            )
          ),
          ...(response.note ? { note: response.note } : {}),
          ...(response.checkout ? { checkout: response.checkout } : {}),
          ...(response.engine_log && response.engine_log.length > 0
            ? { engine_log: response.engine_log }
            : {}),
          summary:
            (response.dry_run
              ? `${scopeLabel}有 ${response.found} 个重定向器` +
                (broken > 0 ? `，其中 ${broken} 个已断链（目标不存在）` : '') +
                '（本次没有改动任何东西）'
              : `清理了 ${response.fixed}/${response.found} 个重定向器` +
                (response.deleted_broken ? `，删除断链的 ${response.deleted_broken} 个` : '') +
                (brokenLeft > 0 ? `，${brokenLeft} 个断链的原地未动` : '') +
                (loadFailedCount > 0 ? `，${loadFailedCount} 个加载失败没处理` : '') +
                (response.dirty_after ? `，${response.dirty_after} 个包待保存` : '')) +
            (response.listed_note ? `\n只列了一部分：${response.listed_note}` : '') +
            (leftOnDiskCount > 0
              ? `\n⚠ ${leftOnDiskCount} 个重定向器文件还在磁盘上（源码管理或只读拒了删除），已算回未清理`
              : '') +
            // 预演：会被存；执行后：存了的和还没存的分开说，别把跑之前的预测当成已经发生
            (response.dry_run && dirtyRefs.length > 0
              ? `\n⚠ ${dirtyCount} 个引用者有未保存的改动，执行时会被原样落盘：${sample(dirtyRefs)}`
              : '') +
            (!response.dry_run && savedRefs.length > 0
              ? `\n⚠ ${savedCount} 个引用者原有未保存的改动，刚才被原样落盘了：${sample(savedRefs)}`
              : '') +
            (!response.dry_run && dirtyRefs.length > 0
              ? `\n${dirtyCount} 个引用者的未保存改动没有被写盘（它们的重定向器没交给引擎，或保存失败）：${sample(dirtyRefs)}`
              : '') +
            (checkout.length > 0 ? `\n${checkout.join('\n')}` : '')
        }
      } catch (error) {
        // 超时要保住「超时」这个事实：报告框等人点的时候这条 RPC 就是会超时，
        // 引擎那边多半还会做完，不能报成「确定失败」让调用方重发
        return describeToolError(error)
      }
    }
  })
}
