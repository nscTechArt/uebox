/**
 * 由 decl-list.txt + 人工分类表生成 issue 13 的审查清单。
 * 运行：pnpm exec node .scratch/chat-terminology/scripts/build-checklist.mjs
 * 输出：.scratch/chat-terminology/13-sessionid-audit.md
 *
 * 分类口径（issue 13）：
 *   对话→改名        用户可见那条会话的 id，14 里改叫 chatSid
 *   内核             agent 内核会话 id（agentSessionId），保持 sessionId 不动
 *   导入             网络库导入的 import session id，与对话无关，不动
 *   对话·过IPC→保留   对话 id，但字段过 IPC/持久化边界，名字保留
 *   流id·过IPC→保留   既非对话也非内核：ai.chatStream 单次调用的流关联 id，过 IPC，保留
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRATCH = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const LIST = path.join(SCRATCH, 'decl-list.txt')

const C = {
  CHAT: '对话→改名',
  KERNEL: '内核',
  IMPORT: '导入',
  CHAT_IPC: '对话·过IPC→保留',
  STREAM_IPC: '流id·过IPC→保留'
}

// per-file: [defaultClass, evidence, overrides {line: [class, note]}]
const M = {
  'src/renderer\\src\\api\\agentV3.ts': [
    C.KERNEL,
    '`window.api.agentV3.*` 的渲染层封装。`sessionId` 全部是内核会话 id（`setApprovalMode` 注释明示 `chatStore.getAgentSessionId`）→ 原样进 IPC 载荷到主进程 agent-v3。'
  ],
  'src/renderer\\src\\api\\agentBrowser.ts': [
    C.KERNEL,
    'Agent 浏览器面板的 IPC 封装，按内核会话寻址 → 主进程浏览器宿主。'
  ],
  'src/renderer\\src\\api\\ai.ts': [
    C.KERNEL,
    '',
    {
      282: [
        C.KERNEL,
        '`AgentExecuteParams.sessionId` → `executeAgent` → `agentV3.execute` 内核 id；下一行已显式并列 `chatSid`。'
      ],
      690: [
        C.STREAM_IPC,
        '本地生成 `chat-text-…`，是 `ai.chatStream` 单次调用的请求关联 id → IPC 载荷字段；不是对话 id 也不是内核 id。'
      ],
      729: [C.STREAM_IPC, '把上面的流 id 装进 `chatStream` IPC 载荷。'],
      1006: [C.KERNEL, '`params.sessionId`（内核）→ `stop`/`execute` IPC。'],
      1020: [C.KERNEL, '`stop({ sessionId })` 载荷 = 内核 id。'],
      1034: [C.KERNEL, '`execute({ sessionId })` 载荷 = 内核 id。']
    }
  ],
  'src/renderer\\src\\api\\ai.chatText.test.ts': [
    C.STREAM_IPC,
    '`chatStream` 请求/事件里 `sessionId` 的测试字面量，镜像 ai.ts 的流关联 id。'
  ],
  'src/renderer\\src\\api\\ai.executeAgent.test.ts': [
    C.KERNEL,
    '`executeAgent` IPC 载荷断言，内核 id。'
  ],
  'src/renderer\\src\\api\\editorSnapshotIpcPayload.test.ts': [
    C.KERNEL,
    "`executeAgent` IPC 载荷断言 `sessionId: 'agent-1'`，内核 id。"
  ],
  'src/renderer\\src\\common\\chatRoute.ts': [
    C.CHAT,
    '`isSessionTab` 把参数和标签页 `?sid=` 比较 → 对话 id。'
  ],
  'src/renderer\\src\\components\\ImportProgressWidget.vue': [
    C.IMPORT,
    '注释「V2 会话 ID」= 网络库 v2 导入 session id，与对话无关。'
  ],
  'src/renderer\\src\\components\\SensitiveActionConfirm.test.ts': [
    C.KERNEL,
    '`PendingApproval.sessionId` fixture，镜像 pendingApprovals.ts 的内核字段。'
  ],
  'src/renderer\\src\\components\\useApprovalDisplay.test.ts': [
    C.KERNEL,
    '`PendingApproval.sessionId` fixture，镜像 pendingApprovals.ts 的内核字段。'
  ],
  'src/renderer\\src\\composables\\deleteChatSession.test.ts': [
    C.CHAT,
    "`deps.sessionId`/`targets[].sessionId` fixture 用 `'chat-N'`（对话 id），与 `agentSessionId: 'agent-N'` 并列。"
  ],
  'src/renderer\\src\\composables\\deleteChatSession.ts': [
    C.CHAT,
    '`DeleteChatSessionDeps.sessionId`/`ChatSessionDeleteTarget.sessionId` = 界面会话 id（同接口里 `agentSessionId` 是内核）；`dropMessages`/`removeSession`/`{sessionId: deps.sessionId}` 都按界面 id 走 store。'
  ],
  'src/renderer\\src\\composables\\sessionRetitle.ts': [
    C.CHAT,
    '`retitleSession(sessionId)` → `inFlight`/`applyTitle`，调用方（ChatSessionList.smartName）传 `renamingId` = 对话 id。'
  ],
  'src/renderer\\src\\i18n\\locales\\en-US.ts': [C.KERNEL, '同 zh-CN，英文版。'],
  'src/renderer\\src\\i18n\\locales\\zh-CN.ts': [
    C.KERNEL,
    '`agentV3Debug.sessionId` 文案键，标的是调试面板的内核会话 id。'
  ],
  'src/renderer\\src\\layout\\components\\ChatSessionList.vue': [
    C.CHAT,
    '侧边栏会话列表：`open` emit 载荷、`isSessionRunning`、拖拽、右键菜单、`deleteChatSessions` target、`smartName`、归属工程，全部按界面会话 id。',
    {
      670: [C.KERNEL, '`deleteSession({ sessionId: agentSessionId })` IPC 载荷字段，值是内核 id。']
    }
  ],
  'src/renderer\\src\\layout\\composables\\notificationActivation.test.ts': [
    C.KERNEL,
    '`NotificationActivatePayload.sessionId` fixture = 内核（主进程通知激活载荷）。'
  ],
  'src/renderer\\src\\layout\\composables\\notificationActivation.ts': [
    C.KERNEL,
    '解构 `payload.sessionId` → `chatStore.sessionByAgentSessionId(sessionId)` 反查对话，是内核 id。'
  ],
  'src/renderer\\src\\layout\\composables\\trayBridge.test.ts': [
    C.CHAT_IPC,
    "`{ type: 'open-session', sessionId: 'chat-7' }` 是 `TrayAction` IPC 载荷字面量：值是对话 id，但字段名是 shared/trayActions.ts 的 IPC 契约 → 保留。"
  ],
  'src/renderer\\src\\store\\modules\\agentStream.ts': [
    C.KERNEL,
    '`agentProcess` 条目 `data.sessionId` = 形参 `agentSessionId`（反问卡片的答案要拿它 resolveQuestion 回内核）。'
  ],
  'src/renderer\\src\\store\\modules\\chatMessages.test.ts': [
    C.KERNEL,
    '`agent-resume` 按钮 `data.sessionId` fixture，镜像 agentControlHandlers.ts 的内核 id。'
  ],
  'src/renderer\\src\\store\\modules\\chatSessions.ts': [
    C.KERNEL,
    '',
    {
      477: [C.KERNEL, '`setSessionProject` IPC 载荷字段，值 = `session.agentSessionId`。'],
      553: [
        C.KERNEL,
        '`setAgentSessionId(id, sessionId)` 的 `sessionId` 写进 `session.agentSessionId` = 内核 id。'
      ]
    }
  ],
  'src/renderer\\src\\store\\modules\\chatSessions.test.ts': [
    C.KERNEL,
    "`setSessionProject` 载荷断言 `sessionId: 'kernel-a'` = 内核 id。"
  ],
  'src/renderer\\src\\store\\modules\\importTasks.ts': [
    C.IMPORT,
    '注释「V2 Import Session ID」= 网络库导入 session id。'
  ],
  'src/renderer\\src\\store\\modules\\pendingApprovals.test.ts': [
    C.KERNEL,
    '`PendingApproval` fixture。'
  ],
  'src/renderer\\src\\store\\modules\\pendingApprovals.ts': [
    C.KERNEL,
    '注释：字段就是主进程 `approvalChannel.ts` 发来的原样 = 内核 id。'
  ],
  'src/renderer\\src\\views\\AssetManagement\\index.vue': [
    C.IMPORT,
    '文件夹导入阶段/恢复 IPC 载荷与 `ImportRecoverySummary` 里的 `sessionId` = 网络库 v2 导入 session id。'
  ],
  'src/renderer\\src\\views\\Assistant\\AgentBrowserWindow.vue': [
    C.KERNEL,
    '路由 `?sessionId=` → `useSessionBrowser` → `agentBrowserAPI.getState` = 内核 id。'
  ],
  'src/renderer\\src\\views\\Assistant\\Welcome.vue': [
    C.CHAT,
    '',
    {
      484: [
        C.CHAT,
        '`props.sessionId` → `sid.value` → 路由 `?sid=`/`ensureSession` = 对话 id。**已知改名点**（Welcome 自身 prop → `chatSid`）。'
      ],
      1858: [
        C.KERNEL,
        '气泡 `actionButton.data.sessionId` ← agentControlHandlers.ts:320 写进的内核 id（`agent-resume` 载荷）。'
      ],
      1875: [C.KERNEL, '解出的 `data.sessionId` → `resumeAgent` = 内核 id。']
    }
  ],
  'src/renderer\\src\\views\\Assistant\\components\\AIBubble.actions.test.ts': [
    C.KERNEL,
    '`agent-resume` 按钮 `data.sessionId` fixture = 内核 id。'
  ],
  'src/renderer\\src\\views\\Assistant\\components\\AgentBrowserPane.test.ts': [
    C.KERNEL,
    'prop fixture，镜像内核 prop。'
  ],
  'src/renderer\\src\\views\\Assistant\\components\\AgentBrowserPane.vue': [
    C.KERNEL,
    '面板 prop = 内核会话 id → `useSessionBrowser`/`agentBrowserAPI`。**已知保留点**：`:session-id` 不动。'
  ],
  'src/renderer\\src\\views\\Assistant\\components\\AskUserCard.test.ts': [
    C.KERNEL,
    '`AgentQuestionItem.sessionId` fixture = 内核 id。'
  ],
  'src/renderer\\src\\views\\Assistant\\components\\EditorStatusMonitor.test.ts': [
    C.CHAT,
    '`mountMonitor(sessionId)`/`props:{sessionId}` fixture，镜像组件 prop（对话 id）。'
  ],
  'src/renderer\\src\\views\\Assistant\\components\\EditorStatusMonitor.vue': [
    C.CHAT,
    '`sessionId?` prop → `chatStore.sessionById(props.sessionId)` = 界面 id。**已知改名点**（→ `chatSid`）。'
  ],
  'src/renderer\\src\\views\\Assistant\\components\\InputComposer.vue': [
    C.KERNEL,
    '`const sessionId = getAgentSessionId(chatSid)` → `agentV3.compact({ sessionId })` = 内核 id。'
  ],
  'src/renderer\\src\\views\\Assistant\\components\\SessionProjectChip.test.ts': [
    C.CHAT,
    '`mountChip(sessionId)`/`props:{sessionId}` fixture = 对话 id。'
  ],
  'src/renderer\\src\\views\\Assistant\\components\\SessionProjectChip.vue': [
    C.CHAT,
    '`sessionId?` prop 注释「当前会话 ID」→ `sessionById` = 界面 id。**已知改名点**（→ `chatSid`）。'
  ],
  'src/renderer\\src\\views\\Assistant\\components\\TopNav.vue': [
    C.CHAT,
    '`sessionId?` prop 注释「当前会话 ID」→ 转给 SessionProjectChip/EditorStatusMonitor = 对话 id。**已知改名点**（→ `chatSid`）。'
  ],
  'src/renderer\\src\\views\\Assistant\\composables\\agentControlHandlers.ts': [
    C.KERNEL,
    '`data.sessionId`（ErrorEvent 内核 id）写进报错气泡的 `agent-resume` 按钮 data。'
  ],
  'src/renderer\\src\\views\\Assistant\\composables\\agentEventDispatcher.test.ts': [
    C.KERNEL,
    '`agent-v3:*` 事件载荷与 `registerAgentHandler({ sessionId: SID, chatSid: CHAT })` fixture —— `sessionId` 一律内核（与 `chatSid` 显式并列）。'
  ],
  'src/renderer\\src\\views\\Assistant\\composables\\agentEventDispatcher.ts': [
    C.KERNEL,
    '全局分发器按内核 `sessionId` 路由 `agent-v3:*` 事件；`registerAgentHandler` 的 `sessionId`（内核）与 `chatSid`（对话）显式并列。'
  ],
  'src/renderer\\src\\views\\Assistant\\composables\\agentHandlerShared.ts': [
    C.KERNEL,
    '事件类型字段（ToolCall/ToolResult/Notify/Step/Done/Stopped/Error）的 `sessionId` = 内核 id；`clearWikiRagState`/`getWikiRagCitations` 以 `agentSessionId` 键控（调用方传的都是 `agentSessionId`）；`resolveTargetChatSid(…, sessionId)` 喂 `getChatSidByAgentSession`。'
  ],
  'src/renderer\\src\\views\\Assistant\\composables\\agentSessionIsolation.test.ts': [
    C.KERNEL,
    '`{ sessionId: ctx.sessionA }` fixture —— `initStream(chatA, sessionA)` 里 `sessionA` 是内核 id。'
  ],
  'src/renderer\\src\\views\\Assistant\\composables\\agentStreamHandlers.ts': [
    C.KERNEL,
    '`appendProcessItem(…, sessionId)` → `addAgentProcess`（按内核 id 键控）；`handleAgentText` 的 `data.sessionId` 对 `currentSessionId`（内核）。'
  ],
  'src/renderer\\src\\views\\Assistant\\composables\\agentTimeline.test.ts': [
    C.KERNEL,
    '`user-steer` 条目 `data.sessionId` fixture = 内核 id（撤回要用）。'
  ],
  'src/renderer\\src\\views\\Assistant\\composables\\agentTimeline.ts': [
    C.KERNEL,
    '`AgentTimelineSteerBlock.sessionId` 注释「撤回这条要用的号和会话」→ `cancelSteer` 需要内核 id；从事件 `data.sessionId` 原样搬。'
  ],
  'src/renderer\\src\\views\\Assistant\\composables\\approvalModeSync.ts': [
    C.KERNEL,
    '解构遍历 `modeByAgentSession` 的键 = `agentSessionId` → `agentV3API.setApprovalMode`。'
  ],
  'src/renderer\\src\\views\\Assistant\\composables\\chatBranch.test.ts': [
    C.KERNEL,
    "`forkTranscript` mock 返回 `sessionId: 'agent-branch'` = 内核 id。"
  ],
  'src/renderer\\src\\views\\Assistant\\composables\\chatBranch.ts': [
    C.KERNEL,
    '`ForkTranscriptResult.sessionId` 注释「内核复制 session 的结果」= fork 出的新 agentSessionId。'
  ],
  'src/renderer\\src\\views\\Assistant\\composables\\chatSendPrimitives.ts': [
    C.CHAT,
    '`EnsureSessionDeps.chatStore` 五个方法的 `sessionId` 参数、`ensureSessionWithTitle(sessionId)`、`stampSessionProject` 的 `sessionId` 字段 —— 全是界面会话 id（经 `ensureSession`/`sessionById`/`setProject`）。'
  ],
  'src/renderer\\src\\views\\Assistant\\composables\\creatorPlanChatError.test.ts': [
    C.KERNEL,
    '`handleAgentError(…, { sessionId: SESSION })` fixture = ErrorEvent 内核 id。'
  ],
  'src/renderer\\src\\views\\Assistant\\composables\\followUpDelivery.test.ts': [
    C.KERNEL,
    '`agent-v3:released` 载荷 `{ sessionId }` fixture = 内核 id。'
  ],
  'src/renderer\\src\\views\\Assistant\\composables\\followUpDelivery.ts': [
    C.KERNEL,
    '`agent-v3:released` 事件载荷 `{ sessionId? }` = 内核 id → `sessionByAgentSessionId` 查对话。'
  ],
  'src/renderer\\src\\views\\Assistant\\composables\\sessionAutoTitle.ts': [
    C.CHAT,
    '`getTitle`/`applyTitle` 回调与 `autoNameSession(sessionId)` 都按界面会话 id 读写标题。'
  ],
  'src/renderer\\src\\views\\Assistant\\composables\\sessionProjectBinding.test.ts': [
    C.CHAT,
    '`deps.sessionId` fixture = `session?.id`（对话 id）。'
  ],
  'src/renderer\\src\\views\\Assistant\\composables\\sessionProjectBinding.ts': [
    C.CHAT,
    '`StampSessionProjectDeps.sessionId` → `getSession(sessionId)`/`setProject(sessionId)` 按界面 id；`{ sessionId }` 解构同一字段。'
  ],
  'src/renderer\\src\\views\\Assistant\\composables\\sessionProjectSync.test.ts': [
    C.KERNEL,
    "`SessionProjectEvent` fixture `'agent-*'` = 内核 id。"
  ],
  'src/renderer\\src\\views\\Assistant\\composables\\sessionProjectSync.ts': [
    C.KERNEL,
    '`SessionProjectEvent.sessionId` 注释明示「内核会话 id，不是界面 id」→ `sessionByAgentSessionId` 反查。'
  ],
  'src/renderer\\src\\views\\Assistant\\composables\\sessionTaskDone.ts': [
    C.CHAT,
    '`isSessionOnScreen`/`shouldMarkTaskDone` 的 `sessionId` 与路由 `?sid=` 比较 = 对话 id。'
  ],
  'src/renderer\\src\\views\\Assistant\\composables\\sideQuestion.test.ts': [
    C.KERNEL,
    "`fork` mock 返回 `sessionId: 'agent-side'` = 内核 id。"
  ],
  'src/renderer\\src\\views\\Assistant\\composables\\sideQuestion.ts': [
    C.KERNEL,
    '`SideQuestionForkResult.sessionId` = `forkForSideQuestion` 返回的新 agentSessionId（deps 注释明示）。'
  ],
  'src/renderer\\src\\views\\Assistant\\composables\\transcriptRewind.ts': [
    C.KERNEL,
    '`truncate: (sessionId) => …` 回调被调时拿的是 `agentSessionId`（截内核 transcript）。'
  ],
  'src/renderer\\src\\views\\Assistant\\composables\\useAgentMode.ts': [
    C.KERNEL,
    'wiki RAG 状态按 `agentSessionId` 键控（setWikiRagState 调用点 773/781 传 `agentSessionId`）；`const sessionId = getAgentSessionId(sid.value)`（397/411/1027/1054）与各 IPC 载荷字段 `sessionId: agentSessionId`（442/466/475/550/845/970/983/984/1260）全是内核 id。'
  ],
  'src/renderer\\src\\views\\Assistant\\composables\\useChatFlow.ts': [
    C.CHAT,
    '`ensureSessionWithTitle(sessionId)` 包装层透传对话 id 到 chatSendPrimitives。'
  ],
  'src/renderer\\src\\views\\Assistant\\composables\\useRealtimeVoice.ts': [
    C.KERNEL,
    '`dispatchTask`/`resolveTarget` 的 `sessionId` 是模型报来的「会话号」→ 按 `item.agentSessionId` 比对 = 内核 id。'
  ],
  'src/renderer\\src\\views\\Assistant\\composables\\useSessionBrowser.test.ts': [
    C.KERNEL,
    '`sessionId` ref 与广播载荷 fixture = 内核 id。'
  ],
  'src/renderer\\src\\views\\Assistant\\composables\\useSessionBrowser.ts': [
    C.KERNEL,
    '`useSessionBrowser(sessionId)` → `agentBrowserAPI.getState(id)`；广播 `state.sessionId` 同内核 id。'
  ],
  'src/renderer\\src\\views\\Assistant\\composables\\useSessionGoal.ts': [
    C.KERNEL,
    '`const sessionId = agentSessionId.value` → `goalState`/`goalEnd`；`goal-state` 事件载荷同内核。'
  ],
  'src/renderer\\src\\views\\Assistant\\composables\\useTeamBoard.ts': [
    C.KERNEL,
    '`const sessionId = agentSessionId.value` → `teamState`/`teamTaskReopen`/`teamEnd`；`team-board`/`released` 事件载荷同内核。'
  ],
  'src/renderer\\src\\views\\BlueprintLibrary\\BlueprintEditor.test.ts': [
    C.CHAT,
    '`LibraryAIPanel` stub 的 `sessionId` prop 镜像被 mock 组件的对话 prop → 跟随组件改名。'
  ],
  'src/renderer\\src\\views\\BlueprintLibrary\\SnippetDetail.aiContext.test.ts': [
    C.CHAT,
    '`LibraryAIPanel` stub 的 `sessionId` prop 镜像被 mock 组件的对话 prop → 跟随组件改名。'
  ],
  'src/renderer\\src\\views\\MaterialLibrary\\MaterialEditor.test.ts': [
    C.CHAT,
    '`LibraryAIPanel` stub 的 `sessionId` prop 镜像被 mock 组件的对话 prop → 跟随组件改名。'
  ],
  'src/renderer\\src\\views\\System\\Preferences\\panels\\AgentV3Debug\\AgentV3DebugPanel.vue': [
    C.KERNEL,
    "`const sessionId = ref('debug-…')` → `agentV3API.subscribe`/`execute` = 内核 id。"
  ],
  'src/renderer\\src\\views\\System\\Preferences\\panels\\ArchivedChatsModal.test.ts': [
    C.KERNEL,
    "`deleteSession` IPC 断言 `{ sessionId: 'agent-new' }` = 内核 id。"
  ],
  'src/renderer\\src\\views\\System\\Preferences\\panels\\ArchivedChatsModal.vue': [
    C.CHAT,
    '',
    {
      100: [C.CHAT, '`deleteChatSession({ sessionId: session.id })` deps 字段 = 对话 id。'],
      102: [
        C.KERNEL,
        '`deleteTranscript: (sessionId) => …deleteSession({ sessionId })` —— 参数与 IPC 载荷字段都是内核 id（两行同处一行，共 2 个声明）。'
      ]
    }
  ],
  'src/renderer\\src\\views\\library-common\\components\\LibraryAIPanel.vue': [
    C.CHAT,
    '`sessionId` prop 注释「用 `library-chat-` 打头」→ 透传给内嵌 `<Welcome>` = 对话 id。'
  ],
  'src/shared\\agentNotificationActivation.ts': [
    C.KERNEL,
    '`NotificationActivatePayload.sessionId` 注释明示「内核会话 id，不是界面会话 id」。'
  ],
  'src/shared\\agentQuestion.ts': [
    C.KERNEL,
    '`AgentQuestionItem.sessionId` 注释：卡片要带它把答案 `resolveQuestion` 送回内核。'
  ],
  'src/shared\\trayActions.ts': [
    C.CHAT_IPC,
    "`TrayAction 'open-session'` 载荷 `sessionId` = 对话路由 id，但它是 main→renderer 的 IPC 契约字段 → 名字保留。"
  ],
  'src/shared\\voiceTaskSession.ts': [
    C.CHAT,
    '`isVoiceTaskSessionId`/`voiceTaskOwnerSid`/`belongsToChat` 的 `sessionId` 参数 = 对话 id（`voice-tasks-<chatSid>::<灶>` 派生 id 本身就当 `ChatSession.id` 用）。'
  ]
}

const lines = fs.readFileSync(LIST, 'utf8').split(/\r?\n/).filter(Boolean)
const rows = lines.map((l) => {
  const [file, ln, why, ...rest] = l.split('|')
  return { file, ln: +ln, why, text: rest.join('|') }
})

// 校验每个文件都有分类
const files = [...new Set(rows.map((r) => r.file))]
const missing = files.filter((f) => !M[f])
if (missing.length) {
  console.error('MISSING MAP for:', missing)
  process.exit(1)
}

// 汇总
const tally = {}
for (const r of rows) {
  const ov = M[r.file][2]?.[r.ln]
  const cls = ov ? ov[0] : M[r.file][0]
  r.cls = cls
  r.note = ov ? ov[1] : ''
  tally[cls] = (tally[cls] || 0) + 1
}
const total = rows.length

let md = ''
md += `# 13 · 渲染层与 shared 的 \`sessionId\` 声明清单\n\n`
md += `> 审计对象：**声明**（变量、参数、字段、prop、emit 载荷、事件载荷字段、测试字面量），不是每个使用点。\n`
md += `> 范围：\`src/renderer\` 与 \`src/shared\`。每一行回答「这个 \`sessionId\` 指哪种 id」。\n\n`

md += `## 1. 搜索\n\n`
md += '```sh\n'
md += `rg -o --multiline --count-matches \\
  '(^|[^.\\w$?])sessionId\\??\\s*:|\\b(?:const|let|var)\\s+(?:\\{[^{}\\n]*|\\[[^\\]\\n]*)?sessionId\\b|(^|[^$])\\{\\s*sessionId\\s*[,}=]|(^|[^$])\\{[^{}\\n]*,\\s*sessionId\\s*[,}=]|(^|[^$])\\{\\s*\\n\\s*sessionId\\s*[,}]|\\bsessionId\\s*=>|\\(\\s*sessionId\\s*\\)\\s*=>|[(,{]\\s*sessionId\\s*=[^=>]' \\
  src/renderer src/shared\n`
md += '```\n\n'
md += `- 全仓 \`sessionId\` 原文命中：**787 行**（含使用点、注释、成员访问、\`sessionIds\` 复数）。\n`
md += `- 上面的声明形态过滤后：**${total} 个声明命中**，与人工分类器（scripts/classify.mjs，逐行判定声明/使用）结果一一对应。\n`
md += `- \`--count-matches\` 按「匹配事件」计数；逐行打印会让多行匹配的开括号行多出来，不能用行数。\n\n`

md += `## 2. 分类口径与汇总\n\n`
md += `| 类别 | 含义 | 14 的动作 | 行数 |\n|---|---|---|---|\n`
md += `| 对话→改名 | 用户可见会话的 id | 改叫 \`chatSid\`（prop 连模板绑定一起） | ${tally[C.CHAT] || 0} |\n`
md += `| 内核 | agent 内核会话 id（= \`agentSessionId\`） | 不动 | ${tally[C.KERNEL] || 0} |\n`
md += `| 导入 | 网络库 v2 导入 session id | 不动 | ${tally[C.IMPORT] || 0} |\n`
md += `| 对话·过IPC→保留 | 对话 id，但字段是 IPC 契约 | 不动（载荷字段名保留） | ${tally[C.CHAT_IPC] || 0} |\n`
md += `| 流id·过IPC→保留 | \`ai.chatStream\` 单次调用的请求关联 id | 不动（既非对话也非内核） | ${tally[C.STREAM_IPC] || 0} |\n`
md += `| **合计** | | | **${total}** |\n\n`

md += `## 3. 判定方法\n\n`
md += `1. 逐文件读源码：每个声明的**来源**（谁写进这个变量/字段）与**去向**（它喂给哪个 API / store / IPC / 比较）标在各行。\n`
md += `2. 品牌类型实验（spec 第 3 步）：临时给 \`ChatSession.id\` 打上 \`ChatSid\`、\`ChatSession.agentSessionId\` 与 \`sessionByAgentSessionId\`/\`getAgentSessionId\`/\`setAgentSessionId\`/\`sessionById\` 打上 \`AgentSessionId\`/\`ChatSid\`，并把 \`api/agentV3.ts\`（23 处）、\`api/agentBrowser.ts\`（4 处）的 \`sessionId\` 参数打上 \`AgentSessionId\`，跑 \`pnpm typecheck:web\`：\n`
md += `   - 228 个错误**全部**是 \`string → 品牌\` 的边界噪声（未品牌化的持有方：\`Ref<string>\`、路由参数、测试字面量、结构收窄的 deps 接口）；\n`
md += `   - **跨品牌错配 0 个** —— 没有任何 \`ChatSid\` 值被塞进 \`AgentSessionId\` 位置，反之亦然。两类 id 之间只经 \`getAgentSessionId\`/\`sessionByAgentSessionId\` 两个转换口流动，与逐行读码结论一致。\n`
md += `   - 品牌已全部撤除，\`git status -- src/\` 干净。\n`
md += `3. 结论：没有「拿不准到必须靠品牌才能分」的行遗留；分类依据逐行给出，可直接审。\n\n`

md += `## 4. 清单（按文件分组，${total} 行）\n\n`
md += `类别列含义见上表。「同文件依据」= 该行类别与证据均见本小节说明。\n\n`

let cur = null
for (const r of rows) {
  if (r.file !== cur) {
    cur = r.file
    const meta = M[cur]
    const inFile = rows.filter((x) => x.file === cur)
    const classes = [...new Set(inFile.map((x) => M[cur][2]?.[x.ln]?.[0] || meta[0]))]
    md += `### \`${cur.replace(/\\/g, '/')}\` — ${inFile.length} 处 · ${classes.join(' + ')}\n\n`
    if (meta[1]) md += `**依据**：${meta[1]}\n\n`
    md += `| 行 | 声明片段 | 类别 |\n|---:|---|---|\n`
    const dup = {}
    for (const x of inFile) dup[x.ln] = (dup[x.ln] || 0) + 1
    const seq = {}
    for (const x of inFile) {
      seq[x.ln] = (seq[x.ln] || 0) + 1
      const lnCell = dup[x.ln] > 1 ? `${x.ln}（同行 ${seq[x.ln]}/${dup[x.ln]}）` : `${x.ln}`
      const raw = x.text.replace(/\|/g, '\\|').slice(0, 110)
      const snip = raw.includes('`') ? `\`\` ${raw} \`\`` : `\`${raw}\``
      const note = x.note ? ` — ${x.note}` : ''
      md += `| ${lnCell} | ${snip} | ${x.cls}${note} |\n`
    }
    md += `\n`
  }
}

md += `## 5. 「已知会改」核对（spec §6 组）\n\n`
md += `| 点 | 现状 | 清单判定 |\n|---|---|---|\n`
md += `| \`TopNav\` 的 \`sessionId\` prop | TopNav.vue:67 | 对话→改名 |\n`
md += `| \`SessionProjectChip\` 的 \`sessionId\` prop | SessionProjectChip.vue:23 | 对话→改名 |\n`
md += `| \`EditorStatusMonitor\` 的 \`sessionId\` prop | EditorStatusMonitor.vue:32 | 对话→改名 |\n`
md += `| \`Welcome.vue\` 自身 \`sessionId\` prop | Welcome.vue:484 | 对话→改名（值进 \`sid.value\` = 路由 \`?sid=\`） |\n`
md += `| \`AgentBrowserPane\` 的 \`sessionId\` prop | AgentBrowserPane.vue:213 | **内核 → 保留**（\`:session-id\` 不动） |\n\n`

md += `## 6. 附注（不在 ${total} 行内，但 14 必须知道）\n\n`
md += `1. **\`:session-id\` 模板绑定**（prop 改名时要同步改，不在声明搜索里）：\n`
md += `   - 对话类（→ \`:chat-sid\`）：Welcome.vue:15（TopNav）、:87（SessionProjectChip）、TopNav.vue:15（EditorStatusMonitor）、:18（SessionProjectChip）、LibraryAIPanel.vue:449（内嵌 Welcome）、ChatWindow.vue:108（Welcome）、NotebookDetail.vue:2547（Welcome）、SnippetDetail.vue:165 / BlueprintEditor.vue:1610 / MaterialEditor.vue:819（LibraryAIPanel）。\n`
md += `   - 内核类（保留）：Welcome.vue:262 与 AgentBrowserWindow.vue:3（AgentBrowserPane）。\n`
md += `2. **同名邻居**（\`sessionId\` 搜索匹配不到，但同类歧义）：\`activeSessionId\`（ChatSessionList/SideMenu prop + 测试 = 对话；useAgentMode 里的 = 内核）、\`selectedSessionIds\`/\`contextMenuSessionId\`/\`draggingSessionId\`/\`visibleSessionIds\`（ChatSessionList = 对话）。\`currentSessionId\`/\`runningSessionId\`/\`browserSessionId\`/\`elsewhereSessionId\`/\`targetSessionId\`/\`staleSessionId\`/\`processSessionId\`/\`submittedSessionId\` 全是内核，\`agentSessionId\`/\`sessionByAgentSessionId\`/\`getAgentSessionId\`/\`setAgentSessionId\` 保留不动。\n`
md += `3. **复数形**：\`chatWindowSync.ts\` 的 \`resendApprovals(sessionIds)\`/\`onRunsElsewhere(sessionIds)\` 是内核 id 数组过 IPC，不动。\n`
md += `4. **函数名带 SessionId**：\`voiceTaskSessionId\`/\`isVoiceTaskSessionId\`（派生对话 id 工具）、\`generateChatSessionId\`（造对话 id）—— 参数已按清单判，函数名是否改由 14 定。\n`
md += `5. \`ChatSessionList\` 的 \`(e:'open', sessionId)\` emit 载荷名：对父组件只是位置参数，改名安全；连同内部函数参数一起改。\n\n`

md += `## 7. 复现\n\n`
md += `- 原文命中：\`rg -n sessionId src/renderer src/shared\`（787 行，存 \`sessionid-hits-raw.txt\`）。\n`
md += `- 声明过滤：\`scripts/classify.mjs\`（逐行判定 → \`decl-list.txt\`/\`use-list.txt\`）；等价单条 rg 命令见 §1（\`declpat.txt\` 存有图案，\`rgmatches.txt\` 存 \`-o\` 输出）。\n`
md += `- 本表生成：\`scripts/build-checklist.mjs\`（分类表 + decl-list → 本文件）。\n`

fs.writeFileSync(path.join(SCRATCH, '13-sessionid-audit.md'), md)
console.log('written. tally:', JSON.stringify(tally), 'total:', total)
