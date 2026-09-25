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
 *     它用的是盒子里配置的模型。
 *   - **没有 `set_session_project` / `voice_report`**：前者改的是盒子侧边栏里
 *     某条对话的归属，外部会话没有那条对话；后者要有人在听语音。
 *   - **工具搜索不折叠**：MCP 的工具清单一次给全，等同盒子的全量模式。
 */

import type { WebContents } from 'electron'

import { appSettingsManager } from '../../../appSettingsManager'
import { sendToAppWindows } from '../../../appWindows'
import { currentMainLanguage } from '../../../i18n'
import { projectManager } from '../../../services/project/projectManager'
import {
  buildSystemPrompt,
  resolveAgentTools,
  runSubAgent,
  type SessionContext
} from '../../core/createAgent'
import { EDITOR_SCREENSHOT_DEFAULT } from '../../core/editorScreenshotScope'
import { isShellAvailable } from '../../tools/builtin/localShell'
import { createTaskTool } from '../../tools/builtin/task'
import type { UnrealAgentTool } from '../../tools/defineTool'
import { applySkillLearningMode, discoverEnabledSkills } from '../skills'
import { readUserInstructions } from '../userInstructions'
import { elicitQuestions } from './elicitQuestions'
import { ensureConnected } from './index'
import type { McpSessionRequest, McpSessionSetup } from './McpServerHost'

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
 * 装配一条外部会话。
 *
 * 每条 MCP 会话调一次（握手时），之后这条会话的工具清单就定了 —— 和盒子助手
 * 一轮之内工具不变是同一个道理：浏览器、ask_user 这些现造的工具带着自己的状态。
 */
export async function setupMcpSession(request: McpSessionRequest): Promise<McpSessionSetup> {
  const settings = appSettingsManager.getSettings()
  const [shellAvailable, userInstructions, mcp] = await Promise.all([
    isShellAvailable(),
    readUserInstructions(),
    ensureConnected()
  ])
  const skillLearning = 'ask'
  const skills = applySkillLearningMode(await discoverEnabledSkills(), skillLearning)
  const project = connectedProject()

  const ctx: SessionContext = {
    sessionId: request.sessionId,
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
    sender: broadcastSender,
    mcp
  }

  const taskTool = createTaskTool({
    // 外部客户端的对话不在盒子里，没有可继承的上下文
    getParentMessages: () => [],
    runSubAgent: async (input) => runSubAgent(ctx, input)
  }) as unknown as UnrealAgentTool<never>

  const tools = resolveAgentTools(ctx, skills, taskTool)

  // 说明按真实连接状态写：工具可以先给全，但环境块不能说一句假话
  const instructions =
    PREFACE +
    buildSystemPrompt(
      { ...ctx, ueConnected: projectManager.getInteractiveProjects().length > 0 },
      skills
    )

  return { tools, instructions }
}
