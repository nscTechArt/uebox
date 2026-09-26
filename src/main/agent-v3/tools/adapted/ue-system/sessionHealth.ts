/**
 * 会话体检 —— 编辑器在不在跑、盒子连没连上、这一轮的命令发往哪条连接。
 *
 * ## 为什么要有这个工具
 *
 * 编辑器崩一次或重启一次，**所有** ue.* 工具就一律回「客户端不存在或已断开」。
 * 这一句话把三件下一步完全不同的事说成了同一件：
 *
 *   1. 编辑器压根没在跑          → 让用户打开工程
 *   2. 编辑器在跑，但盒子没连上   → 等插件自己重连上来
 *   3. 连着，只是这一轮盯的是重启前那条死连接 → 认回新连接就行
 *
 * 而模型手里没有任何一个工具能分辨。真机上它只能去 shell 里 `tasklist` 数
 * 进程，再拿 `ue_get_project_info` 反复试探 —— 试探本身还会因为没连接被拒。
 *
 * 第 3 种最坑：盒子界面上明明写着「已连接」，模型却咬定引擎没连上，
 * 让用户去连一个他早就连好的工程。那条自愈逻辑在
 * `core/projectTargetContext.ts` 里，这个工具负责把结果如实说出来。
 *
 * ## 连接的方向是反的，所以「让用户去点连接」是句错话
 *
 * 盒子是**被动的 WebSocket 服务端**，插件那边主动连过来，断了每 5 秒自己重试
 * （`plugin/.../UAL_NetworkManager.cpp` 的 `StartReconnectTimer`），连上后立刻
 * 补发一次 `project.info`（`UnrealAgentLink.cpp` 的 `HandleSocketConnected`）。
 * 首页工程卡片上只有一个「已连接」标识，**没有连接按钮**。
 *
 * 这里曾经在 `running_not_connected` 分支里写「请用户在盒子界面里重新连接这个
 * 工程（首页工程卡片 →「连接」）」。真机上的后果是：编辑器重启后还在加载工程
 * （大工程 30–90 秒），模型三秒内连探四次，然后把用户支去点一个不存在的按钮，
 * 自己收工 —— 而再等二十秒插件就自己连上了。**没有下一步可做时，等待本身
 * 必须是一个能说出口的下一步**，所以有了 `wait_seconds`。
 *
 * ## 为什么进程检测必须在盒子这一侧做
 *
 * 这个工具最该被调用的时刻，恰恰是**连接断了**的时刻。所以「编辑器在不在跑」
 * 一个字都不能走 RPC —— 走了就和别的工具一起失效，等于没有。
 * 这里扫的是本机的 UnrealEditor.exe 进程，和首页那排引擎卡片同一个数据源。
 *
 * 同样的理由，它进了 `createAgent.ts` 的 `OFFLINE_UE_TOOLS` 豁免名单：
 * 命名空间是 `ue.system`，但引擎没连上时**照样注册**。
 * `builtin/engines.ts` 干脆连命名空间都不放在 `ue.*` 下，是同一条道理。
 *
 * ## 为什么是 V3 原生工具而不是 `defineV2Tool`
 *
 * 只为了 `wait_seconds` 这一个参数：适配层给 execute 传的是个空对象，拿不到
 * `signal` 也拿不到 `report`。一个可能等两分钟的工具，两样缺一不可 ——
 * 用户按停止要能立刻停（否则那两分钟里停止按钮是坏的），界面也得看得见
 * 「还在等，已经 25 秒」而不是一个转了两分钟的圈。
 */

import { z } from 'zod'

import { defineTool, type UnrealAgentTool } from '../../defineTool'
import { serviceManager } from '../../../../services'
import { projectManager } from '../../../../services/project'
import { getTargetConnectionId, getTargetProjectPath } from '../../../core/projectTargetContext'
import {
  HEALTH_SCOPE_FIELD,
  SESSION_HEALTH_TOOL_NAME,
  getRuntimeScopeId
} from '../../../core/runtimeEnvelope'
import UnrealPathManagerUtil from '../../../../utils/UnrealPathManager'
import UnrealProcessDetector from '../../../../utils/UnrealProcessDetector'
import {
  describeRelaunch,
  recentEditorCrashes,
  relaunchCrashedEditor,
  type EditorCrash
} from '../../../../services/editorCrashWatch/watch'

/** 一个正在跑的编辑器进程（盒子扫出来的，不经过 RPC） */
interface EditorProcess {
  pid: number
  project_name: string
  project_path: string
  /** `.uproject` 里的 EngineAssociation，自编译引擎的 GUID 会查注册表还原 */
  engine_version?: string
  /** 这个进程有没有对应的盒子连接 */
  connected: boolean
}

/** 一条已建立、且插件已经握完手的连接 */
interface EditorConnection {
  /** 盒子里叫 connectionId。编辑器每重启一次就换一个 */
  connection_id: string
  project_name: string
  project_path: string
  engine_version: string
  /** 这一轮的引擎命令默认发往它 */
  is_current_target: boolean
}

type HealthState = 'not_running' | 'running_not_connected' | 'connected'

export interface SessionHealthReport {
  success: true
  state: HealthState
  editor_processes: EditorProcess[]
  connections: EditorConnection[]
  current_target_connection_id?: string
  session_project_not_connected?: string
  /** 实际等了多少秒（没要求等待时为 0） */
  waited_seconds: number
  /**
   * 这份观测属于哪一轮（见 `core/runtimeEnvelope.ts`）。
   *
   * 真机上这个工具最贵的一次代价不是它答错了，而是它**答对了然后被隔夜复用**：
   * 前一天回的 `not_running` 留在历史里，第二天引擎早就连上了，模型照着那条
   * 旧结论对用户说「编辑器现在没跑」，然后去扫磁盘。盖上作用域戳，模型才有
   * 判据分辨「这是这一轮的观测吗」。
   */
  runtime_scope_id?: string
  /** 最近十分钟里崩掉的编辑器（盒子的崩溃看门人认出来的），新的在前 */
  recent_crashes?: RecentCrash[]
  summary: string
}

interface RecentCrash {
  project_name: string
  project_path: string
  seconds_ago: number
  crash_type?: string
  error?: string
  /** 重开到了哪一步：not_requested（等你决定）/ relaunched / disabled / crash_loop / already_running / no_uproject / failed */
  relaunch: EditorCrash['relaunch']
  /** 未保存的自动存档备份到了哪（有才给） */
  autosave_backup?: string
}

/**
 * 等待上限。
 *
 * 180 秒够一个大工程从冷启动加载到插件握手（真机上 30–90 秒是常态）。
 * 再长就不该由一次工具调用扛着了 —— 那是「这一轮干不成」，该让用户重发一条。
 */
const MAX_WAIT_SECONDS = 180

/** 轮询间隔。只看内存里的连接池，便宜，可以问得勤一点 */
const POLL_INTERVAL_MS = 2_000

/** 路径大小写、斜杠方向、结尾斜杠都可能不一致，比之前先抹平（同 `core/sessionScope.ts`） */
function normalizePath(value: string | undefined): string {
  return (value || '').trim().toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '')
}

/**
 * 连接侧报的是**工程根目录**，进程侧扫出来的是 `.uproject` 文件本身 ——
 * 直接比会一条都对不上。两个形态都放进集合里再比。
 */
function pathKeys(projectPath: string, projectName: string): string[] {
  const dir = normalizePath(projectPath)
  if (!dir) return []
  return [dir, normalizePath(`${dir}/${projectName}.uproject`)]
}

/**
 * 进程列表。GUID 形式的 EngineAssociation 顺手还原成版本号 ——
 * 不还原的话模型只能向用户转述一串 GUID，那对排查没有任何帮助。
 */
async function collectProcesses(connectedPaths: Set<string>): Promise<EditorProcess[]> {
  const running = await UnrealProcessDetector.getRunningProjects()

  return Promise.all(
    running.map(async (proc) => {
      let version = proc.engineVersion
      if (version && UnrealPathManagerUtil.isSourceBuildGUID(version)) {
        const resolved = await UnrealPathManagerUtil.resolveEngineVersionFromGUID(version).catch(
          () => null
        )
        version = resolved?.version
      }

      return {
        pid: proc.pid,
        project_name: proc.projectName,
        project_path: proc.projectPath,
        ...(version ? { engine_version: version } : {}),
        connected: connectedPaths.has(normalizePath(proc.projectPath))
      }
    })
  )
}

function listProcesses(processes: EditorProcess[]): string[] {
  return processes.map(
    (proc) =>
      `- ${proc.project_name}（PID ${proc.pid}）— ${proc.project_path}` +
      `｜引擎 ${proc.engine_version ?? '未知'}｜${proc.connected ? '已连上盒子' : '**没连上盒子**'}`
  )
}

/**
 * 进程一个都没扫到时的说法。
 *
 * 未支持的平台上要说清楚是「没查」而不是「查过了没有」。
 */
function noProcessText(): string[] {
  if (process.platform === 'win32' || process.platform === 'darwin') return []
  return [
    `注意：进程检测只在 Windows 和 macOS 上实现（当前平台 ${process.platform}），` +
      '所以「没在跑」这条结论不可靠 —— 请以连接状态和界面为准。'
  ]
}

/**
 * 没连上时统一的收尾话。
 *
 * 两件事必须说：这一轮的工具清单不会补发（`resolveTools` 在每轮开始时定死），
 * 以及「等」是有工具支持的、不是干等。少了前一句，模型会在连上之后去调一个
 * 它手上根本没有的工具；少了后一句，它会把用户支去点按钮。
 */
function offlineTailText(waited: number): string[] {
  return [
    '',
    waited > 0
      ? `（已经等了 ${waited} 秒还没连上。可以再调一次本工具、把 wait_seconds 开大一点继续等。）`
      : '**先等，别急着下结论。** 再调一次本工具并传 `wait_seconds`（例如 60），' +
        '它会一直等到连上为止，连上就立刻返回。',
    '如果等满了仍然连不上，才去怀疑这个工程没启用 UnrealAgentLink 插件' +
      '（用 list_engines 确认插件装在哪，或让用户在「编辑 → 插件」里搜 UnrealAgentLink）。',
    '另外：这一轮的工具清单是**会话开始时**定下来的，中途连上不会补发。' +
      '所以连上之后如果你手上还是没有别的引擎工具，那不是没连上 —— ' +
      '告诉用户连接已经恢复、让他再发一条消息即可，不要在这一轮里反复重试。',
    SCOPE_NOTICE
  ]
}

/**
 * 这份结论的保质期。
 *
 * 真机上出过的事：前一天回的 `not_running` 留在历史里，第二天引擎早就连上了，
 * 模型照着那条隔夜结论对用户说「编辑器现在没跑」，然后去扫磁盘 ——
 * 它从头到尾没想过要复核一次。所以每一份结论都要自己声明只代表这一轮。
 */
const SCOPE_NOTICE =
  `**这份结论只代表 ${HEALTH_SCOPE_FIELD} 那一轮。** 到了下一轮（下一条用户消息），` +
  '当前状态以最后那个 `<runtime-status>` 信封为准；要复核就重新调一次本工具，' +
  '不要拿这条旧结论当作当前状态。'

function describe(
  state: HealthState,
  processes: EditorProcess[],
  connections: EditorConnection[],
  staleTargetPath: string | undefined,
  waited: number
): string {
  if (state === 'not_running') {
    return [
      '**编辑器没在跑，或尚未识别到它打开的项目。** 未检测到运行中的项目，也没有任何连接。',
      '',
      '下一步：请用户打开工程（或用 project_manage 打开）。在那之前所有引擎工具都用不了，',
      '不要反复重试别的引擎命令 —— 它们只会一条条回同样的「客户端不存在或已断开」。',
      ...noProcessText(),
      ...offlineTailText(waited)
    ].join('\n')
  }

  if (state === 'running_not_connected') {
    return [
      '**编辑器在跑，但盒子还没跟它握上手。** 引擎命令现在发不出去 —— ' +
        '这不是编辑器的问题，也不是用户漏点了什么。',
      '',
      '正在跑的编辑器：',
      ...listProcesses(processes),
      '',
      '**用户不需要做任何操作。** 连接是插件主动连过来的：断了它每 5 秒自己重试一次，' +
        '连上就会立刻把工程信息报上来。盒子界面上只有一个「已连接」标识，**没有连接按钮** ——',
      '让用户「去点一下连接」是一条做不到的指令，不要这么说。',
      '',
      '最常见的原因就一个：**编辑器刚重启，还在加载工程**，插件模块要等它加载完才起来。',
      '大工程 30–90 秒是常态。',
      '',
      '**不要重启编辑器** —— 编辑器本身是好的，重启只会让这段等待从头再来一遍，',
      '用户还可能丢掉未保存的改动。',
      ...offlineTailText(waited)
    ].join('\n')
  }

  const lines = [
    `**连着。** 盒子和 ${connections.length} 个工程有连接：`,
    ...connections.map(
      (conn) =>
        `- ${conn.project_name}｜引擎 ${conn.engine_version}｜${conn.project_path}` +
        `｜connection_id ${conn.connection_id}${conn.is_current_target ? '（← 这一轮发往它）' : ''}`
    )
  ]

  if (waited > 0) {
    lines.push('', `（等了 ${waited} 秒后连上的。）`)
  }

  const orphans = processes.filter((proc) => !proc.connected)
  if (orphans.length > 0) {
    lines.push(
      '',
      '另外这些编辑器在跑但没连上盒子（不属于这条会话，别去动它们）：',
      ...listProcesses(orphans)
    )
  }

  if (processes.length === 0) {
    // 连接是活的就说明编辑器活着。进程扫不到多半是它不叫 UnrealEditor.exe
    // （DebugGame 之类），这时候要以连接为准，不能反过来怀疑连接
    lines.push('', '（没识别到编辑器进程中的项目路径，但连接是通的 —— 以连接为准。）')
  }

  if (staleTargetPath) {
    lines.push(
      '',
      `注意：这一轮绑定的工程是 ${staleTargetPath}，它此刻**没有连接**。` +
        '上面那些连接属于别的工程，这条会话不该去动它们 —— ' +
        '请用户打开并连接这个工程，或者把会话移出该工程。'
    )
  }

  lines.push(
    '',
    '如果你手上现在没有别的引擎工具，那是因为这一轮开始时还没连上 —— ' +
      '工具清单是每轮开始时定下来的，中途连上不会补发。' +
      '告诉用户连接已经恢复、让他再发一条消息即可，不要在这一轮里反复重试。',
    SCOPE_NOTICE
  )

  return lines.join('\n')
}

/** 只看内存里的连接池和工程表，不扫进程 —— 这一份要在轮询里反复取 */
function snapshotConnections(): { connections: EditorConnection[]; target?: string } {
  const target = getTargetConnectionId()

  const live = new Set(
    serviceManager
      .getWebSocketService()
      .getConnectionManager()
      .getAllConnections()
      .map((conn) => conn.id)
  )

  // 以 WebSocket 连接池再过一遍：projectManager 里可能残留已标记离线
  // 但还没删掉的记录，照报会说成「连着」
  const connections = projectManager
    .getInteractiveProjects()
    .filter((project) => live.has(project.connectionId))
    .map((project) => ({
      connection_id: project.connectionId,
      project_name: project.projectName,
      project_path: project.projectPath,
      engine_version: project.engineVersion,
      is_current_target: project.connectionId === target
    }))

  return { connections, ...(target ? { target } : {}) }
}

/**
 * 这一轮盯的工程连上了没有。
 *
 * 绑了工程就只认那一个 —— 旁边别的工程连着不算数，等待要等的是**这条会话
 * 能干活**，不是「有任何连接」。没绑工程（纯对话）时任何一条连接都算连上。
 */
function isSatisfied(connections: EditorConnection[], targetPath: string | undefined): boolean {
  if (connections.length === 0) return false
  if (!targetPath) return true
  return connections.some((conn) => conn.is_current_target)
}

/**
 * 最近的崩溃。放在 summary 最前面：「编辑器在跑但没连上」和「编辑器刚崩完、盒子正在重开」
 * 下一步都是等，但后者模型必须知道 —— 连上之后不能拿同样的参数把刚才那一步再跑一遍。
 */
/** target 是这个工程目录本身或它下面的路径。按目录边界比，`Game2` 不算 `Game` 里的 */
function isInsideProject(target: string, projectDir: string): boolean {
  const dir = normalizePath(projectDir)
  return target === dir || target.startsWith(`${dir}/`)
}

function collectCrashes(targetPath: string | undefined): RecentCrash[] {
  const target = normalizePath(targetPath)
  const now = Date.now()
  return recentEditorCrashes()
    .filter((crash) => !target || isInsideProject(target, crash.editor.projectDir))
    .map((crash) => ({
      project_name: crash.editor.projectName,
      project_path: crash.editor.projectDir,
      seconds_ago: Math.max(0, Math.round((now - crash.at) / 1000)),
      ...(crash.report?.crashType ? { crash_type: crash.report.crashType } : {}),
      ...(crash.report?.errorMessage ? { error: crash.report.errorMessage } : {}),
      relaunch: crash.relaunch,
      ...(crash.restore ? { autosave_backup: crash.restore.backupDir } : {})
    }))
}

function describeCrashes(crashes: RecentCrash[]): string[] {
  if (crashes.length === 0) return []
  return [
    '**最近有编辑器崩溃：**',
    ...crashes.map(
      (crash) =>
        `- ${crash.project_name} ${crash.seconds_ago} 秒前崩了` +
        (crash.crash_type ? `（${crash.crash_type}）` : '') +
        (crash.error ? `：${crash.error}` : '') +
        `。${describeRelaunch({ relaunch: crash.relaunch, reporterClosed: false })}` +
        (crash.autosave_backup
          ? `未保存的自动存档备份在 ${crash.autosave_backup}，要告诉用户。`
          : '')
    ),
    '连上之后先查清崩溃前那一步做到了哪，**不要用同样的参数重试**。',
    ''
  ]
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export function createSessionHealthTool(): UnrealAgentTool<SessionHealthReport> {
  return defineTool({
    name: SESSION_HEALTH_TOOL_NAME,
    namespace: 'ue.system',
    risk: 'safe',
    description: `一次问清楚：编辑器在不在跑、盒子连没连上、这一轮的命令发往哪条连接。

【什么时候用】引擎命令回「引擎未连接」「客户端不存在或已断开」「没有连接的虚幻引擎项目」的时候，
**先调这个**。不要去 shell 里 tasklist 数进程，也不要拿 ue_get_project_info 反复试探
（没连接时它本来就会被拒，试探不出任何东西）。

【它在没连接时也能用】进程检测在盒子这一侧做，不走引擎 RPC —— 连接断了正是最
需要它的时候。

【返回什么】state 三取一，各自的下一步都写在 summary 里：
- not_running           编辑器没在跑 → 让用户打开工程
- running_not_connected 编辑器在跑但还没握上手 → **等**，别让用户去点什么，也别重启编辑器
- connected             连着 → 给出 connection_id、工程路径、引擎版本

【重启编辑器之后怎么办】传 wait_seconds 等它，别用几次空探来代替等待。
连接是插件主动连过来的，断了它每 5 秒自己重试；编辑器重启后要先把工程加载完
插件才起来，大工程 30–90 秒是常态。盒子界面上没有「连接」按钮，
所以「让用户去点连接」是一条做不到的指令。

【connection_id 是什么】盒子和编辑器之间那条 WebSocket 连接的 id，
**编辑器每重启一次就换一个**，旧的会被清掉。它不是聊天会话 id。
编辑器重启后盒子会自动认回同一个工程的新连接，所以看到 state=connected
就说明现在真的能干活了。`,
    input: z.object({
      wait_seconds: z
        .number()
        .int()
        .min(0)
        .max(MAX_WAIT_SECONDS)
        .optional()
        .describe(
          `等待连接建立的秒数（0-${MAX_WAIT_SECONDS}，省略=不等，问完当前状态就返回）。` +
            '连上就立刻返回。编辑器刚重启时给 60-120。'
        ),
      relaunch_crashed_editor: z.boolean().optional().describe('你弄崩了编辑器、要接着干时传 true')
    }),
    execute: async (
      { wait_seconds: waitSeconds = 0, relaunch_crashed_editor: relaunchCrashed },
      { signal, report }
    ) => {
      const startedAt = Date.now()
      const targetPath = getTargetProjectPath()

      let relaunchNote: string | undefined
      if (relaunchCrashed) {
        const pending = recentEditorCrashes().find(
          (c) =>
            (!targetPath || isInsideProject(normalizePath(targetPath), c.editor.projectDir)) &&
            c.relaunch !== 'relaunched' &&
            c.relaunch !== 'already_running'
        )
        const crash = pending ? await relaunchCrashedEditor(pending.editor.projectDir) : null
        relaunchNote = crash
          ? `重开 ${crash.editor.projectName}：${describeRelaunch(crash)}`
          : '重开：最近没有需要重开的崩溃编辑器，什么都没做。'
      }
      const deadline = startedAt + waitSeconds * 1000

      let { connections, target } = snapshotConnections()

      // 轮询只碰内存里的连接池 —— 进程扫描走 PowerShell，几百毫秒一次，
      // 每 2 秒扫一遍是在给一台正在加载工程的机器添堵。它只在收尾时扫一次。
      while (!isSatisfied(connections, targetPath) && Date.now() < deadline) {
        if (signal?.aborted) break
        report({ text: `等待编辑器连接…已等 ${Math.round((Date.now() - startedAt) / 1000)} 秒` })
        await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())))
        ;({ connections, target } = snapshotConnections())
      }

      const waited = Math.round((Date.now() - startedAt) / 1000)

      /*
       * 报 connected 之前真的探一下活。2026-09-26 真机反馈：编辑器崩在引擎断言里，
       * socket 和心跳还在，这里照报 connected、还给出崩溃前那个 connection_id，
       * 而每一条真正的请求都超时 —— 模型信了它，全队干等二十分钟。
       * 探不通的当场断开（看护会接着处理：真死了就重开，只是卡住会自己重连），
       * state 按断开之后的情况算；正在处理别的请求的不去插队，算忙。
       */
      const ws = serviceManager.getWebSocketService()
      const probes = await Promise.all(
        connections.map(async (conn) => ({
          conn,
          verdict: await ws.probeConnection(conn.connection_id)
        }))
      )
      const dead = probes.filter((p) => p.verdict === 'dead').map((p) => p.conn)
      const busy = probes.filter((p) => p.verdict === 'busy').map((p) => p.conn)
      for (const conn of dead) ws.dropConnection(conn.connection_id, '健康检查探活不通')
      if (dead.length > 0) ({ connections, target } = snapshotConnections())
      const probeNotes = [
        ...(dead.length
          ? [
              `探活：${dead.map((c) => c.project_name).join('、')} 的连接还在、但只读命令没有答话（多半是编辑器崩了或卡死），已经断开。上面的 state 是断开之后的情况。`
            ]
          : []),
        ...(busy.length
          ? [
              `探活：${busy.map((c) => c.project_name).join('、')} 正在处理别的请求，这次没去插队探它。`
            ]
          : [])
      ]

      const connectedPaths = new Set(
        connections.flatMap((conn) => pathKeys(conn.project_path, conn.project_name))
      )
      const processes = await collectProcesses(connectedPaths)

      const state: HealthState =
        connections.length > 0
          ? 'connected'
          : processes.length > 0
            ? 'running_not_connected'
            : 'not_running'

      // 这一轮绑了工程，而那个工程不在已连接的列表里 —— 说明连着的是别人。
      // 不点破的话模型会拿旁边那条连接的 id 去干活，那是「静默改错工程」。
      const staleTarget =
        targetPath && !connections.some((conn) => conn.is_current_target) ? targetPath : undefined

      const scopeId = getRuntimeScopeId()
      const crashes = collectCrashes(targetPath)

      const details: SessionHealthReport = {
        success: true,
        state,
        editor_processes: processes,
        connections,
        ...(target ? { current_target_connection_id: target } : {}),
        ...(staleTarget ? { session_project_not_connected: staleTarget } : {}),
        waited_seconds: waited,
        ...(scopeId ? { runtime_scope_id: scopeId } : {}),
        ...(crashes.length > 0 ? { recent_crashes: crashes } : {}),
        summary: [
          ...(relaunchNote ? [relaunchNote, ''] : []),
          ...describeCrashes(crashes),
          describe(state, processes, connections, staleTarget, waited)
        ].join('\n')
      }

      // state 和作用域戳各占一行：summary 是给人看的散文，模型要的那个三取一的值
      // 和「这是哪一轮的观测」都不能只藏在里面（details 不进上下文）。
      //
      // 没有作用域（调试入口、对外的 MCP server）时写 `none` 而不是省略这一行 ——
      // 省略的话模型分不清「这是旧格式」还是「这一轮没戳」，而 `none` 天然
      // 对不上任何信封，正好落在「不能当作当前状态」那一侧。
      return {
        text:
          `state=${state}\n${HEALTH_SCOPE_FIELD}=${scopeId ?? 'none'}\n\n${details.summary}` +
          (probeNotes.length ? `\n\n${probeNotes.join('\n')}` : ''),
        details
      }
    }
  })
}
