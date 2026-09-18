/**
 * 「工程打开了」和「工程能干活了」之间那段空白。
 *
 * ## 它修的是哪个 bug
 *
 * `open_project` 从前只做一件事：`shell.openPath(.uproject)`，然后立刻回
 * `success: true`。而这一轮的目标工程是在**收到用户消息那一刻**算好、定死在
 * 执行流上的（见 `ipc/agentV3.ts` 的 `resolveTargetProject`）。于是真机上出现
 * 这一幕 —— 模型建了个新工程、把它打开、界面上编辑器也确实跑起来了，
 * 可这一轮剩下的每条引擎命令仍然发往**旧工程**。
 *
 * 模型只能把这件事说给用户听，让他要么去界面上切工程，要么再发一条消息。
 * 两样都是盒子该自己做完的事：是谁打开的工程？是工具自己。路径是谁给的？
 * 也是工具自己。没有任何需要用户补充的信息。
 *
 * ## 所以这里做三件事
 *
 * 1. **等**。等到那个工程的插件真的连上来 —— UE 冷启动几十秒到几分钟。
 * 2. **回读校验**。连上不等于能干活：socket 在、握手完了，游戏线程也得能响应
 *    命令。发一条只读命令收到回应才算数（同 `ue-editor/editorLifecycle.ts`，
 *    那个工具就是在这里出过「报成功、下一条命令全失败」的事）。
 * 3. **把这一轮切过去**。`retargetToProject()`，边界在它自己那儿。
 */

import { serviceManager } from '../../../../services'
import { projectManager } from '../../../../services/project'
import { retargetToProject, type RetargetOutcome } from '../../../core/projectTargetContext'
import { projectPathKey } from '../../../core/projectPathKey'

/**
 * 回读校验用的只读命令。
 *
 * 和重启工具用的是同一条：插件一定实现了（握手报工程信息就是这套），只读，
 * 而且它跑通恰好证明了后续命令需要的每一环 —— socket 通、连接 id 对得上、
 * 插件的命令分发在转、游戏线程能响应。
 */
const PROBE_METHOD = 'system.get_project_info'
const PROBE_TIMEOUT_MS = 15_000
const POLL_INTERVAL_MS = 1_000

/** 默认不等待编辑器启动，避免 MCP 客户端在工程正常加载时超时。 */
export const DEFAULT_WAIT_MS = 0

/** 最多等多久。再长就该让模型先回话、之后用 `ue_session_health` 自己去看 */
export const MAX_WAIT_MS = 600_000

export interface ProjectLiveResult {
  /** 那个工程此刻连着、而且刚回过一条只读命令 */
  live: boolean
  connectionId?: string
  /**
   * 这一轮的引擎命令**现在发往这个工程**。
   *
   * 注意它问的不是「连接 id 变了没有」。本来就指着这个工程（模型不知道它开着、
   * 又调了一次 `open_project`）时也是 true —— 工具描述告诉模型
   * 「switched_target=true 就是已经切过去了，直接接着干」，
   * 按「变了没有」算的话，这种情况会回 false，模型照着描述反推出「没切过去」，
   * 然后去说那句这套机制专门要消灭的「请你在界面上把当前工程切过去」。
   */
  retargeted: boolean
  /** 那个工程此刻确实连着（不代表回读校验过 —— 那是 `live`） */
  connectionSeen: boolean
  /**
   * 回读命令**发出去过并且失败了**。
   *
   * 和 `connectionSeen` 分开是必须的：只看后者分不出「预算不够，一次都没探」
   * 和「探了一百七十次全超时」。前者可以说「连着，只是这次没验」，
   * 后者必须说「它没回话」—— 混成一句的话，一个卡死在编译着色器上的编辑器
   * 会被报成「连着，直接接着干」。
   */
  probeFailed: boolean
  /** 没切成的原因。`undefined` = 切成了，或者压根不需要切 */
  retargetBlocked?: Exclude<RetargetOutcome, { ok: true }>['reason']
  /** 被 `session-scoped` 挡下时，这条会话钉着的是哪个工程 */
  sessionProjectPath?: string
  waitedMs: number
  /** 探针最后一次失败的原因。等超时了报给用户，省得他自己猜 */
  lastError?: string
}

/**
 * 睡一会儿，但用户按停止时当场醒。
 *
 * 不接信号的话，一次轮询间隔就是停止按钮的最小延迟 —— 再加上探针那 15 秒，
 * 用户点完停止还要盯着转圈十几秒。
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}

/**
 * 这个工程此刻连着的那条连接。
 *
 * 不用 `projectManager.getConnectionIdByPath()`：那个是裸 `===` 比较，
 * 而插件报上来的是工程目录、模型给的往往是 `.uproject` 文件，斜杠方向也可能
 * 不一致。比不出来的后果不是报错，是**永远等不到**这个工程连上。
 */
function findLiveConnection(projectPath: string): string | undefined {
  const wanted = projectPathKey(projectPath)
  if (!wanted) return undefined
  try {
    return projectManager
      .getInteractiveProjects()
      .find((project) => projectPathKey(project.projectPath) === wanted)?.connectionId
  } catch {
    return undefined
  }
}

/**
 * 等一个刚打开的工程真正能接命令，然后把这一轮切过去。
 *
 * 会话被钉在别的工程上时**立刻返回**，不空等：那种情况下就算等到了也用不了它
 * （引擎工具这一轮是按钉住的那个工程注册的），让模型早点把原因说给用户听，
 * 比让他盯着一个转三分钟的工具调用强。
 *
 * @param projectPath 刚打开的工程根目录，或它的 `.uproject` 路径
 * @param timeoutMs 最多等多久，默认 {@link DEFAULT_WAIT_MS}
 * @param signal 本轮的中止信号。用户按停止时当场收手，不再空转
 */
export async function awaitProjectLive(args: {
  projectPath: string
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<ProjectLiveResult> {
  const started = Date.now()
  const budget = Math.min(Math.max(args.timeoutMs ?? DEFAULT_WAIT_MS, 0), MAX_WAIT_MS)
  const deadline = started + budget
  const waited = (): number => Date.now() - started

  let lastError: string | undefined
  /*
   * 切过去这件事一旦做了就是做了 —— `retargetToProject()` 当场改了执行流上的
   * store，后面探针失败也收不回来。收得回来也不该收：那一刻起，这一轮的引擎
   * 命令发的是**用户刚打开的那个工程**，发失败会当场报错；发回旧工程才是
   * 悄悄改错东西。所以记住它，如实回报，不要因为最后没探通就说没切。
   */
  let retargeted = false
  /** 见过连接就记下来。超时那条路要靠它把「还没起来」和「起来了但没验上」分开 */
  let connectionSeen = false
  /** 回读命令发出去过并且失败了。和「没连上」「没来得及探」都要分开 */
  let probeFailed = false

  for (;;) {
    if (args.signal?.aborted) {
      return {
        live: false,
        retargeted,
        connectionSeen,
        probeFailed,
        waitedMs: waited(),
        lastError: '已被中止'
      }
    }

    // 先问能不能切。会话钉在别的工程上时这一步就把话说死了，不用等下去
    const outcome = retargetToProject(args.projectPath)
    if (!outcome.ok && outcome.reason === 'session-scoped') {
      return {
        live: false,
        retargeted,
        connectionSeen,
        probeFailed,
        retargetBlocked: 'session-scoped',
        ...(outcome.sessionProjectPath ? { sessionProjectPath: outcome.sessionProjectPath } : {}),
        waitedMs: waited()
      }
    }

    // `retargetToProject` 在没绑目标的执行流里（外部 MCP 调用、无头跑）回
    // `no-context`。那不是错 —— 那些路径本来就没有「这一轮的目标」可切，
    // 底层会按「不指定」处理。照样等它连上，只是不报 retargeted
    const connectionId = outcome.ok ? outcome.connectionId : findLiveConnection(args.projectPath)
    // `outcome.changed` 问的是「id 变了没有」，而这个字段要回答的是
    // 「命令现在发往这个工程了吗」—— 本来就指着它的时候两者不同，见字段注释
    if (outcome.ok) retargeted = true
    if (connectionId) connectionSeen = true

    /*
     * 探针不能超出这次调用自己的预算。
     *
     * 以前只在一轮跑完之后才看 deadline，于是 `waitSeconds: 0`（schema 上写着
     * 「立刻返回」）照样会撞进一次 15 秒的探针；180 秒那档也会在第 179 秒发出
     * 一条探针、到第 194 秒才回来。剩余预算为零就干脆不探，直接走超时那条路。
     */
    const remaining = deadline - Date.now()
    const probeTimeout = Math.min(PROBE_TIMEOUT_MS, Math.max(remaining, 0))

    if (connectionId && probeTimeout > 0) {
      try {
        const probe = await serviceManager
          .getWebSocketService()
          .callRequest<unknown>(PROBE_METHOD, {}, connectionId, probeTimeout)
        if (probe) {
          return {
            live: true,
            connectionId,
            retargeted,
            connectionSeen: true,
            probeFailed,
            ...(outcome.ok ? {} : { retargetBlocked: outcome.reason }),
            waitedMs: waited()
          }
        }
        lastError = `${PROBE_METHOD} 没有返回内容`
        probeFailed = true
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        probeFailed = true
      }
    } else if (!connectionId) {
      lastError = '插件还没把工程信息报上来 —— 编辑器可能还在启动'
    } else if (!lastError) {
      // 预算用完那一轮不发探针。只有在此之前**一次都没探过**时才用这句话 ——
      // 探过并且失败过的话，那次的真实原因比「预算用完了」有用得多
      lastError = '连上了，但这次预算不够发一条回读命令，没做校验'
    }

    if (Date.now() >= deadline) {
      return {
        live: false,
        retargeted,
        connectionSeen,
        probeFailed,
        waitedMs: waited(),
        ...(lastError ? { lastError } : {})
      }
    }
    await sleep(POLL_INTERVAL_MS, args.signal)
  }
}
