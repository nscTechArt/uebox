/**
 * 外部客户端（Codex、Claude Code、CLI）连进来时，给它配一份和盒子助手一样的工具与说明。
 *
 * ## 为什么走盒子助手那条装配路
 *
 * 目标是「在盒子里和在 Codex 里做同一件事，效果一致」—— 能拿来对比，前提是两边
 * 手上是同一套工具、读的是同一份规矩。以前对外那份清单是 `buildAllTools()` 再
 * 按命名空间砍一刀，和盒子助手实际拿到的（技能、task、浏览器、第三方 MCP、
 * ask_user……）差一截，而且每加一类工具都要记得两边各改一次。
 *
 * 现在直接调 `resolveAgentTools()` 和 `buildSystemPrompt()`：盒子助手每轮怎么装，
 * 这里就怎么装。以后那边多一个工具，这边自动跟上。
 *
 * ## 和盒子里那一轮不一样的地方
 *
 *   - **审批交给客户端**。盒子的审批门只在自己的 agent 循环里跑；这里给的
 *     `requestApproval` 只是一个「有人管审批」的标记，让依赖它的工具（浏览器）
 *     照常注册。真正拦不拦由客户端按工具注解决定（见 `McpServerHost`）。
 *   - **`ask_user` 走 MCP elicitation**，客户端声明支持才给。
 *   - **`task` 没有父对话可继承**：外部客户端的对话不在盒子里，子任务只拿到 prompt。
 *     默认用盒子里配置的模型；配了不止一个时多一个 `model` 参数，调用方可以点名
 *     （名单和工作室招人那份是同一份）。
 *   - **没有 `set_session_project` / `voice_report`**：前者改的是盒子侧边栏里
 *     某条对话的归属，外部会话没有那条对话；后者要有人在听语音。
 *   - **工具搜索不折叠**：MCP 的工具清单一次给全，等同盒子的全量模式。
 *   - **知识库是全盒子范围**：外部会话不在哪个知识库页面里，检索默认搜全部、可按标题点一个；
 *     存来源按标题存进已有知识库，而不是每存一条新建一个。
 */

import { basename } from 'path'

import type { WebContents } from 'electron'

import { appSettingsManager } from '../../../appSettingsManager'
import { findMainWindow, sendToAppWindows } from '../../../appWindows'
import { createApprovalRequester } from '../../host/approvalChannel'
import type { ApprovalDeps } from '../../core/approval'
import { currentMainLanguage } from '../../../i18n'
import { projectManager } from '../../../services/project/projectManager'
import {
  buildSystemPrompt,
  createTeamRunners,
  resolveAgentTools,
  runSubAgent,
  type SessionContext
} from '../../core/createAgent'
import {
  EDITOR_SCREENSHOT_DEFAULT,
  runWithEditorScreenshotScope
} from '../../core/editorScreenshotScope'
import {
  getTargetProjectPath,
  runWithTargetConnectionId,
  type TargetProjectRef
} from '../../core/projectTargetContext'
import {
  createRuntimeScopeId,
  formatLocalNow,
  runWithRuntimeScope,
  type RuntimeEnvelope
} from '../../core/runtimeEnvelope'
import { runWithEditorKey } from '../../core/team/editorKey'
import {
  sharedExternalTeamRegistry,
  type ExternalTeamRecord,
  type ExternalTeamRegistry
} from '../../core/team/externalTeam'
import { createExternalTeamSession } from '../../core/team/externalTeamTools'
import {
  createHybridTeamHost,
  hybridParentContext,
  hybridTeamHost,
  runningHybridTeam,
  type HybridEnvironment,
  type HybridTeamHost
} from '../../core/team/hybridTeam'
import {
  createHybridProducerTools,
  hybridHireCatalog,
  openedProjectPath,
  withProducerMailbox
} from '../../core/team/hybridTeamTools'
import { buildProducerBrief } from '../../core/team/teamPrompt'
import { producerTools } from '../../core/team/teamTools'
import { teamDirsFor } from '../../core/team/teamSession'
import { createTeamStore } from '../../core/team/teamStore'
import {
  canChooseModels,
  describeCandidates,
  loadTeamModels,
  pickModel
} from '../../core/team/teamModels'
import { isShellAvailable } from '../../tools/builtin/localShell'
import { createTaskTool } from '../../tools/builtin/task'
import type { UnrealAgentTool } from '../../tools/defineTool'
import { applySkillLearningMode, discoverEnabledSkills } from '../skills'
import { readUserInstructions } from '../userInstructions'
import { createTeamSnapshots } from '../../../ipc/teamSnapshots'
import { experienceHomeContext } from '../../experience/scheduler'
import { elicitQuestions } from './elicitQuestions'
import { ExternalTargetError, normalizeProjectPath, resolveExternalTarget } from './externalTarget'
import { ensureConnected } from './index'
import type { McpSessionRequest, McpSessionSetup } from './McpServerHost'

/** 混合团队制作人的工具集（`X-Unreal-Box-Profile: producer`） */
export const PRODUCER_PROFILE = 'producer'

/**
 * 笔记、知识库那几个工具要一个 `sender` 给界面发「变了，刷新一下」。
 *
 * 外部会话没有发起它的窗口，就广播给所有应用窗口 —— 用户在盒子里开着笔记页
 * 的话能立刻看到 Codex 刚写的那条。只实现那两个工具真正用到的方法。
 */
const broadcastSender = {
  send: (channel: string, ...args: unknown[]) => sendToAppWindows(channel, ...args),
  isDestroyed: () => false
} as unknown as WebContents

/** 握手说明的开头：告诉客户端下面那一大段是什么、哪些地方要换个读法 */
const PREFACE = [
  '# Unreal Box',
  '',
  "You are connected to Unreal Box over MCP. Everything below is the system prompt Unreal Box gives its own built-in assistant, and it applies to you as written: the working rules, the skills (load one with `load_skill` before working in its area), and the guidance on each tool. Tool names are Unreal Box's own; your client may show them with a prefix.",
  'The <environment> block at the end was captured when you connected. Engine connections come and go — call `ue_session_health` before relying on it.',
  '',
  '---',
  ''
].join('\n')

/** 此刻连着的工程。只有一个时才写进环境块 —— 多个时该由调用方点名 */
function connectedProject(): SessionContext['project'] {
  const projects = projectManager.getInteractiveProjects()
  if (projects.length !== 1) return undefined
  const [project] = projects
  return {
    name: project.projectName,
    ...(project.engineVersion ? { engineVersion: project.engineVersion } : {}),
    ...(project.projectPath ? { path: project.projectPath } : {})
  }
}

/**
 * 外部团队的工程 → 执行流上的目标。
 *
 * 编辑器连着就认那条连接。没连着也不能留空：留空的话「恰好一个连接就回退」那条路会把
 * 编辑器命令发进旁边另一个连着的工程。给一个认不出来的 id 加上工程路径，编辑器连上时
 * `getTargetConnectionId()` 会按路径认回来，连不上时报「不存在或已断开」—— 看得见的失败。
 */
function externalTeamTarget(projectPath: string): TargetProjectRef {
  try {
    return resolveExternalTarget({ projectPath }) ?? { projectPath }
  } catch (error) {
    if (!(error instanceof ExternalTargetError)) throw error
    return { connectionId: `offline:${projectPath}`, projectPath }
  }
}

/**
 * 装配一条外部会话。
 *
 * 每条 MCP 会话调一次（握手时），之后这条会话的工具清单就定了 —— 和盒子助手
 * 一轮之内工具不变是同一个道理：浏览器、ask_user 这些现造的工具带着自己的状态。
 */
export async function setupMcpSession(request: McpSessionRequest): Promise<McpSessionSetup> {
  if (request.profile !== undefined) {
    // 认错了就说出来：一个拼错的头悄悄换成完整工具集，制作人手上就多了全套写工具
    if (request.profile.toLowerCase() !== PRODUCER_PROFILE) {
      throw new Error(
        `不认识的工具集 "${request.profile}"（X-Unreal-Box-Profile），可用：${PRODUCER_PROFILE}`
      )
    }
    return setupProducerSession()
  }
  const settings = appSettingsManager.getSettings()
  const [shellAvailable, userInstructions, mcp, models] = await Promise.all([
    isShellAvailable(),
    readUserInstructions(),
    ensureConnected(),
    loadTeamModels()
  ])
  const skillLearning = 'ask'
  const skills = applySkillLearningMode(await discoverEnabledSkills(), skillLearning)
  const project = connectedProject()

  const ctx: SessionContext = {
    sessionId: request.sessionId,
    // 子任务（task）照盒子助手用 agent 那一档。不写的话按默认角色落到对话模型上 ——
    // 真机上外部派的子任务一直跑在对话模型上，那家额度用完就整路 429
    modelRequest: { role: 'agent', agentType: 'agent-v3' },
    // 工具一律按「引擎连着」装：外部调用每次都可以点名工程，连没连上要到调用时才知道
    ueConnected: true,
    shellAvailable,
    mode: request.readOnly ? 'ask' : 'agent',
    toolSearchEnabled: false,
    disabledToolNames: settings.agentDisabledTools,
    editorScreenshotEnabled: EDITOR_SCREENSHOT_DEFAULT,
    skillLearning,
    skills,
    userInstructions,
    uiLanguage: currentMainLanguage(),
    ...(project ? { project } : {}),
    // 审批由客户端管，见文件头。这个函数只在子任务（task）里会被调到 ——
    // 客户端批准了派子任务，就等于批准了子任务要做的事（task 对外标成破坏性）
    requestApproval: async () => 'approve',
    ...(request.elicit ? { requestQuestion: elicitQuestions(request.elicit) } : {}),
    externalClient: true,
    sender: broadcastSender,
    notebook: 'all',
    mcp
  }

  const taskTool = createTaskTool({
    // 外部客户端的对话不在盒子里，没有可继承的上下文
    getParentMessages: () => [],
    runSubAgent: async (input) => runSubAgent(ctx, input),
    ...(canChooseModels(models)
      ? {
          models: {
            catalog: describeCandidates(models),
            resolve: (key: string) => pickModel(models, key)
          }
        }
      : {})
  }) as unknown as UnrealAgentTool<never>

  const boxTools = resolveAgentTools(ctx, skills, taskTool)

  // 外部团队（Claude Code 当大脑、盒子当工作室）：这条连接调了 team_open / team_join
  // 才生效，之前原样透传。见 core/team/externalTeamTools.ts
  const team = createExternalTeamSession({
    registry: sharedExternalTeamRegistry(),
    storeFor: (id) =>
      createTeamStore(teamDirsFor(id), Date.now, () =>
        sendToAppWindows('agent-v3:team-board', { sessionId: id })
      ),
    snapshots: createTeamSnapshots(),
    namespaces: [...new Set(boxTools.map((tool) => tool.unrealBox.namespace))]
      .filter((ns) => ns !== 'core')
      .sort(),
    resolveTarget: externalTeamTarget,
    hybrid: HYBRID_GATE
  })
  const tools = team.guard([...boxTools, ...team.tools])

  // 说明按真实连接状态写：工具可以先给全，但环境块不能说一句假话
  const instructions =
    PREFACE +
    buildSystemPrompt(
      { ...ctx, ueConnected: projectManager.getInteractiveProjects().length > 0 },
      skills
    )

  return { tools, instructions, dispose: team.dispose }
}

// ── 混合团队：制作人在客户端，队员在盒子里 ─────────────────────────────

/** 交付闸、收工问混合团队的宿主。宿主没起来（盒子刚重启、没人派过活）就没有在跑的活 */
const HYBRID_GATE = {
  facts: async (teamId: string) => runningHybridTeam(teamId)?.gateFacts(),
  stop: async (teamId: string) => {
    await runningHybridTeam(teamId)?.pause()
  },
  update: (record: ExternalTeamRecord) => runningHybridTeam(record.id)?.update(record)
}

/**
 * 队员的审批弹在盒子主窗口上（应用级的确认卡，哪个页面都看得到）。主窗口没开就没人能批，按拒绝
 */
const requestHybridApproval: ApprovalDeps['request'] = (req, signal) => {
  const main = findMainWindow()
  return main && !main.isDestroyed()
    ? createApprovalRequester(main.webContents)(req, signal)
    : Promise.resolve('reject')
}

/** 看护团队工程的编辑器。按需加载：看护要拉起 WebSocket 服务，单测里不该被连带 */
function watchHybridEditor(
  isOurs: (projectDir: string) => boolean,
  onEvent: Parameters<
    typeof import('../../../ipc/teamEditorWatch').startTeamEditorWatch
  >[1]['onEvent']
): () => void {
  let stop: (() => void) | undefined
  let stopped = false
  void import('../../../ipc/teamEditorWatch')
    .then(({ startTeamEditorWatch }) => {
      if (!stopped) stop = startTeamEditorWatch(isOurs, { onEvent })
    })
    .catch((error: unknown) => console.warn('[AgentV3][HybridTeam] 编辑器看护没起来:', error))
  return () => {
    stopped = true
    stop?.()
  }
}

/**
 * 制作人手上的工程工具：建工程、开工程、列工程和模板，外加查引擎连没连上。
 * 没有 `ue_session_health` 的话，制作人只能反复 `open_project` 去问「开好没」—— 编辑器还在加载、
 * 进程检测又认不出来时，每问一次就多开一个编辑器（2026-10-24 联调时一口气开了三个）
 */
const PRODUCER_PROJECT_TOOLS: ReadonlySet<string> = new Set([
  'project_manage',
  'project_list',
  'ue_session_health'
])

/** 制作人连接的握手说明。工具说明和 `team_open` 回的须知里已经写全，这里只指路 */
const PRODUCER_INSTRUCTIONS = [
  '# Unreal Box — producer',
  '',
  'You are connected to Unreal Box as the producer of a hybrid team: you plan and coordinate here, and your teammates are models that run inside Unreal Box.',
  'Start with `team_open` (a new objective, or `team_id` to continue). It returns your brief and your team_seat.'
].join('\n')

type HybridEngine = Pick<
  HybridEnvironment,
  'ueConnected' | 'project' | 'sessionProject' | 'outOfScopeProjects' | 'runtime'
> & { target?: TargetProjectRef }

/** 团队的工程此刻在不在：队员的引擎工具、环境块和运行信息都按它来 */
function hybridEngine(record: ExternalTeamRecord): HybridEngine {
  const connected = projectManager.getInteractiveProjects()
  const wanted = record.projectPath ? normalizeProjectPath(record.projectPath) : undefined
  // 记着工程就只认它；没记着、恰好连着一个，就是那一个（同普通外部会话）
  const match = wanted
    ? connected.find((p) => normalizeProjectPath(p.projectPath) === wanted)
    : connected.length === 1
      ? connected[0]
      : undefined
  const project = match
    ? {
        name: match.projectName,
        ...(match.engineVersion ? { engineVersion: match.engineVersion } : {}),
        ...(match.projectPath ? { path: match.projectPath } : {})
      }
    : undefined
  const sessionProject = record.projectPath
    ? {
        name: project?.name ?? basename(record.projectPath),
        ...(project?.engineVersion ? { engineVersion: project.engineVersion } : {}),
        path: record.projectPath,
        connected: Boolean(match)
      }
    : undefined
  const others = sessionProject && !match ? connected.map((p) => p.projectName).filter(Boolean) : []
  const runtime: RuntimeEnvelope = {
    runtimeScopeId: createRuntimeScopeId(),
    observedAt: formatLocalNow(),
    engineLink: match ? 'target' : connected.length ? 'other_project' : 'none',
    ...(project
      ? {
          targetProject: {
            name: project.name,
            ...(project.engineVersion ? { engineVersion: project.engineVersion } : {}),
            ...(project.path ? { pathOnRecord: project.path } : {})
          }
        }
      : {}),
    ...(sessionProject
      ? { sessionProject: { name: sessionProject.name, pathOnRecord: sessionProject.path } }
      : {}),
    ...(others.length ? { outOfScopeProjects: others } : {})
  }
  return {
    ueConnected: Boolean(match),
    ...(project ? { project } : {}),
    ...(sessionProject ? { sessionProject } : {}),
    ...(others.length ? { outOfScopeProjects: others } : {}),
    runtime,
    ...(record.projectPath ? { target: externalTeamTarget(record.projectPath) } : {})
  }
}

/** 拉起一个混合团队的宿主。队员的父上下文对着盒子里 `/team` 那一轮的 ctx 写（`hybridParentContext`） */
async function startHybridHost(
  record: ExternalTeamRecord,
  registry: ExternalTeamRegistry,
  namespaces: string[]
): Promise<HybridTeamHost> {
  const id = record.id
  const changed = (): void => sendToAppWindows('agent-v3:team-board', { sessionId: id })
  return createHybridTeamHost(record, {
    store: createTeamStore(teamDirsFor(id), Date.now, changed),
    snapshots: createTeamSnapshots(),
    // 制作人不在盒子里，没有「制作人的模型」：招人一律给模型、过体检
    models: await loadTeamModels(),
    namespaces,
    jobScope: async (current) => {
      const [shellAvailable, userInstructions, mcp] = await Promise.all([
        isShellAvailable(),
        readUserInstructions(),
        ensureConnected()
      ])
      const { target, ...engine } = hybridEngine(current)
      return {
        parent: hybridParentContext({
          shellAvailable,
          userInstructions,
          uiLanguage: currentMainLanguage(),
          ...experienceHomeContext(),
          mcp,
          sender: broadcastSender,
          editorScreenshotEnabled: EDITOR_SCREENSHOT_DEFAULT,
          ...engine
        }),
        run: (fn) =>
          runWithRuntimeScope(engine.runtime.runtimeScopeId, () =>
            target ? runWithTargetConnectionId(target, fn) : fn()
          )
      }
    },
    runTool: (current, fn) =>
      runWithEditorScreenshotScope(EDITOR_SCREENSHOT_DEFAULT, () =>
        runWithEditorKey(() =>
          current.projectPath && !getTargetProjectPath()
            ? runWithTargetConnectionId(externalTeamTarget(current.projectPath), fn)
            : fn()
        )
      ),
    runners: createTeamRunners,
    requestApproval: requestHybridApproval,
    watchEditor: watchHybridEditor,
    noteWrite: (teamId) => registry.noteWrite(teamId),
    onChange: changed,
    onActivity: (activity) =>
      sendToAppWindows('agent-v3:team-activity', { sessionId: id, ...activity })
  })
}

/**
 * 混合团队制作人的一条连接：只有团队工具，没有盒子的读写工具（制作人用客户端自己的读文件、联网）。
 * 进门、认人、交付闸照旧走外部团队那道门（`createExternalTeamSession`）
 */
async function setupProducerSession(): Promise<McpSessionSetup> {
  const [shellAvailable, models] = await Promise.all([isShellAvailable(), loadTeamModels()])
  const skills = applySkillLearningMode(await discoverEnabledSkills(), 'ask')
  // 招人能选的命名空间：队员手上那一池，同盒子里制作人招人时看到的那份
  const pool = resolveAgentTools(
    { sessionId: 'hybrid-namespaces', ueConnected: true, shellAvailable, sender: broadcastSender },
    skills
  )
  const namespaces = [...new Set(pool.map((tool) => tool.unrealBox.namespace))]
    .filter((ns) => ns !== 'core')
    .sort()

  const registry = sharedExternalTeamRegistry()
  const hostOf = (teamId: string): Promise<HybridTeamHost> =>
    hybridTeamHost(teamId, async () => {
      const record = await registry.get(teamId)
      if (!record || record.members !== 'box') throw new Error(`${teamId} 不是混合团队`)
      return startHybridHost(record, registry, namespaces)
    })

  const team = createExternalTeamSession({
    registry,
    storeFor: (id) =>
      createTeamStore(teamDirsFor(id), Date.now, () =>
        sendToAppWindows('agent-v3:team-board', { sessionId: id })
      ),
    snapshots: createTeamSnapshots(),
    namespaces,
    resolveTarget: externalTeamTarget,
    hybrid: HYBRID_GATE,
    hosted: {
      brief: async (record) => {
        ;(await hostOf(record.id)).update(record)
        return (
          buildProducerBrief({
            objective: record.objective,
            workspaceDir: registry.dirsFor(record.id).workspaceDir,
            hybrid: { teamId: record.id }
          }).trimStart() + hybridHireCatalog(models)
        )
      }
    }
  })
  const fromGate = new Set(['team_open', 'team_inbox', 'team_list', 'team_gate'])
  // 建工程、开工程（同盒子里制作人的 `producerTools`：只认 create / open）和列工程、列模板。
  // 开了哪个工程就记成团队的工程：队员的引擎工具、快照、编辑器看护都跟过去
  const projectTools = producerTools(pool)
    .filter((tool) => PRODUCER_PROJECT_TOOLS.has(tool.name))
    .map((tool) => {
      if (tool.name !== 'project_manage') return tool
      const inner = tool.execute.bind(tool)
      return {
        ...tool,
        execute: async (...args: Parameters<typeof inner>) => {
          const result = await inner(...args)
          const teamId = team.producerTeam()
          const opened = openedProjectPath(args[1], result.details)
          if (teamId && opened) {
            const record = await registry.update(teamId, (r) =>
              r.projectPath === opened ? null : { ...r, projectPath: opened }
            )
            runningHybridTeam(teamId)?.update(record)
          }
          return result
        }
      } as UnrealAgentTool<never>
    })
  const tools = team.guard(
    withProducerMailbox(
      [
        ...team.tools.filter((tool) => fromGate.has(tool.name)),
        ...projectTools,
        ...createHybridProducerTools({
          teamOf: team.producerTeam,
          hostOf,
          namespaces,
          ...(models ? { models } : {}),
          snapshots: true
        })
      ],
      { teamOf: team.producerTeam, running: runningHybridTeam }
    )
  )
  return { tools, instructions: PRODUCER_INSTRUCTIONS, dispose: team.dispose }
}
