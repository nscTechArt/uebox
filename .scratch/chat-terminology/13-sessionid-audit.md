# 13 · 渲染层与 shared 的 `sessionId` 声明清单

> 审计对象：**声明**（变量、参数、字段、prop、emit 载荷、事件载荷字段、测试字面量），不是每个使用点。
> 范围：`src/renderer` 与 `src/shared`。每一行回答「这个 `sessionId` 指哪种 id」。

## 1. 搜索

```sh
rg -o --multiline --count-matches \
  '(^|[^.\w$?])sessionId\??\s*:|\b(?:const|let|var)\s+(?:\{[^{}\n]*|\[[^\]\n]*)?sessionId\b|(^|[^$])\{\s*sessionId\s*[,}=]|(^|[^$])\{[^{}\n]*,\s*sessionId\s*[,}=]|(^|[^$])\{\s*\n\s*sessionId\s*[,}]|\bsessionId\s*=>|\(\s*sessionId\s*\)\s*=>|[(,{]\s*sessionId\s*=[^=>]' \
  src/renderer src/shared
```

- 全仓 `sessionId` 原文命中：**787 行**（含使用点、注释、成员访问、`sessionIds` 复数）。
- 上面的声明形态过滤后：**403 个声明命中**，与人工分类器（scripts/classify.mjs，逐行判定声明/使用）结果一一对应。
- `--count-matches` 按「匹配事件」计数；逐行打印会让多行匹配的开括号行多出来，不能用行数。

## 2. 分类口径与汇总

| 类别 | 含义 | 14 的动作 | 行数 |
|---|---|---|---|
| 对话→改名 | 用户可见会话的 id | 改叫 `chatSid`（prop 连模板绑定一起） | 62 |
| 内核 | agent 内核会话 id（= `agentSessionId`） | 不动 | 313 |
| 导入 | 网络库 v2 导入 session id | 不动 | 11 |
| 对话·过IPC→保留 | 对话 id，但字段是 IPC 契约 | 不动（载荷字段名保留） | 7 |
| 流id·过IPC→保留 | `ai.chatStream` 单次调用的请求关联 id | 不动（既非对话也非内核） | 10 |
| **合计** | | | **403** |

## 3. 判定方法

1. 逐文件读源码：每个声明的**来源**（谁写进这个变量/字段）与**去向**（它喂给哪个 API / store / IPC / 比较）标在各行。
2. 品牌类型实验（spec 第 3 步）：临时给 `ChatSession.id` 打上 `ChatSid`、`ChatSession.agentSessionId` 与 `sessionByAgentSessionId`/`getAgentSessionId`/`setAgentSessionId`/`sessionById` 打上 `AgentSessionId`/`ChatSid`，并把 `api/agentV3.ts`（23 处）、`api/agentBrowser.ts`（4 处）的 `sessionId` 参数打上 `AgentSessionId`，跑 `pnpm typecheck:web`：
   - 228 个错误**全部**是 `string → 品牌` 的边界噪声（未品牌化的持有方：`Ref<string>`、路由参数、测试字面量、结构收窄的 deps 接口）；
   - **跨品牌错配 0 个** —— 没有任何 `ChatSid` 值被塞进 `AgentSessionId` 位置，反之亦然。两类 id 之间只经 `getAgentSessionId`/`sessionByAgentSessionId` 两个转换口流动，与逐行读码结论一致。
   - 品牌已全部撤除，`git status -- src/` 干净。
3. 结论：没有「拿不准到必须靠品牌才能分」的行遗留；分类依据逐行给出，可直接审。

## 4. 清单（按文件分组，403 行）

类别列含义见上表。「同文件依据」= 该行类别与证据均见本小节说明。

### `src/shared/agentQuestion.ts` — 1 处 · 内核

**依据**：`AgentQuestionItem.sessionId` 注释：卡片要带它把答案 `resolveQuestion` 送回内核。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 46 | `sessionId?: string` | 内核 |

### `src/shared/agentNotificationActivation.ts` — 1 处 · 内核

**依据**：`NotificationActivatePayload.sessionId` 注释明示「内核会话 id，不是界面会话 id」。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 51 | `sessionId: string` | 内核 |

### `src/renderer/src/i18n/locales/zh-CN.ts` — 1 处 · 内核

**依据**：`agentV3Debug.sessionId` 文案键，标的是调试面板的内核会话 id。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 161 | `sessionId: 'Session ID',` | 内核 |

### `src/renderer/src/i18n/locales/en-US.ts` — 1 处 · 内核

**依据**：同 zh-CN，英文版。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 161 | `sessionId: 'Session ID',` | 内核 |

### `src/renderer/src/composables/sessionRetitle.ts` — 1 处 · 对话→改名

**依据**：`retitleSession(sessionId)` → `inFlight`/`applyTitle`，调用方（ChatSessionList.smartName）传 `renamingId` = 对话 id。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 120 | `sessionId: string,` | 对话→改名 |

### `src/renderer/src/composables/deleteChatSession.test.ts` — 7 处 · 对话→改名

**依据**：`deps.sessionId`/`targets[].sessionId` fixture 用 `'chat-N'`（对话 id），与 `agentSessionId: 'agent-N'` 并列。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 39 | `sessionId: 'chat-1',` | 对话→改名 |
| 140 | `const { deps, calls } = makeDeps({ sessionId: '' })` | 对话→改名 |
| 170 | `{ sessionId: 'chat-1', agentSessionId: 'agent-1' },` | 对话→改名 |
| 171 | `{ sessionId: 'chat-2', agentSessionId: 'agent-2' }` | 对话→改名 |
| 201（同行 1/2） | `targets: [{ sessionId: 'chat-1', agentSessionId: 'agent-1' }, { sessionId: 'chat-2' }]` | 对话→改名 |
| 201（同行 2/2） | `targets: [{ sessionId: 'chat-1', agentSessionId: 'agent-1' }, { sessionId: 'chat-2' }]` | 对话→改名 |
| 243 | `const { deps, calls } = makeBatchDeps({ targets: [{ sessionId: '' }] })` | 对话→改名 |

### `src/renderer/src/composables/deleteChatSession.ts` — 5 处 · 对话→改名

**依据**：`DeleteChatSessionDeps.sessionId`/`ChatSessionDeleteTarget.sessionId` = 界面会话 id（同接口里 `agentSessionId` 是内核）；`dropMessages`/`removeSession`/`{sessionId: deps.sessionId}` 都按界面 id 走 store。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 37 | `sessionId: string` | 对话→改名 |
| 41 | `dropMessages: (sessionId: string) => void` | 对话→改名 |
| 42 | `removeSession: (sessionId: string) => void` | 对话→改名 |
| 49 | `sessionId: string` | 对话→改名 |
| 138 | `targets: [{ sessionId: deps.sessionId, agentSessionId: deps.agentSessionId }],` | 对话→改名 |

### `src/renderer/src/layout/components/ChatSessionList.vue` — 13 处 · 对话→改名 + 内核

**依据**：侧边栏会话列表：`open` emit 载荷、`isSessionRunning`、拖拽、右键菜单、`deleteChatSessions` target、`smartName`、归属工程，全部按界面会话 id。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 76 | `(e: 'open', sessionId: string): void` | 对话→改名 |
| 251 | `function isSessionRunning(sessionId: string): boolean {` | 对话→改名 |
| 472 | `function handleSessionDragStart(sessionId: string, event: DragEvent): void {` | 对话→改名 |
| 480 | `const sessionId = draggingSessionId` | 对话→改名 |
| 487 | `function openInNewWindow(sessionId: string): void {` | 对话→改名 |
| 549 | `async function openSessionContextMenu(sessionId: string, event: MouseEvent): Promise<void> {` | 对话→改名 |
| 557 | `function syncSessionContextMenuOpen(sessionId: string, open: boolean): void {` | 对话→改名 |
| 666 | `sessionId: session.id,` | 对话→改名 |
| 670 | `window.api.agentV3.deleteSession({ sessionId: agentSessionId }),` | 内核 — `deleteSession({ sessionId: agentSessionId })` IPC 载荷字段，值是内核 id。 |
| 731 | `const sessionId = renamingId.value` | 对话→改名 |
| 756 | `function assignProject(sessionId: string, project: ConnectedProjectRef): void {` | 对话→改名 |
| 765 | `function clearProject(sessionId: string): void {` | 对话→改名 |
| 778 | `for (const sessionId of projectTargetIds.value) {` | 对话→改名 |

### `src/shared/voiceTaskSession.ts` — 3 处 · 对话→改名

**依据**：`isVoiceTaskSessionId`/`voiceTaskOwnerSid`/`belongsToChat` 的 `sessionId` 参数 = 对话 id（`voice-tasks-<chatSid>::<灶>` 派生 id 本身就当 `ChatSession.id` 用）。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 30 | `export function isVoiceTaskSessionId(sessionId: string): boolean {` | 对话→改名 |
| 35 | `export function voiceTaskOwnerSid(sessionId: string): string {` | 对话→改名 |
| 43 | `export function belongsToChat(sessionId: string, chatSid: string): boolean {` | 对话→改名 |

### `src/renderer/src/layout/composables/notificationActivation.ts` — 1 处 · 内核

**依据**：解构 `payload.sessionId` → `chatStore.sessionByAgentSessionId(sessionId)` 反查对话，是内核 id。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 69 | `function activate({ notificationKey, sessionId, toolCallId }: NotificationActivatePayload): void {` | 内核 |

### `src/shared/trayActions.ts` — 1 处 · 对话·过IPC→保留

**依据**：`TrayAction 'open-session'` 载荷 `sessionId` = 对话路由 id，但它是 main→renderer 的 IPC 契约字段 → 名字保留。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 49 | `\| { type: 'open-session'; sessionId: string }` | 对话·过IPC→保留 |

### `src/renderer/src/layout/composables/notificationActivation.test.ts` — 14 处 · 内核

**依据**：`NotificationActivatePayload.sessionId` fixture = 内核（主进程通知激活载荷）。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 57 | `sessionId?: string` | 内核 |
| 62 | `let pendingPayload: { notificationKey: string; sessionId: string; toolCallId?: string } \| null =` | 内核 |
| 131 | `fireActivate({ notificationKey: 'turn:agent-session-7', sessionId: 'agent-session-7' })` | 内核 |
| 142 | `fireActivate({ notificationKey: 'turn:agent-session-7', sessionId: 'agent-session-7' })` | 内核 |
| 149 | `fireActivate({ notificationKey: 'turn:agent-session-7', sessionId: 'agent-session-unknown' })` | 内核 |
| 160 | `sessionId: 'agent-session-7',` | 内核 |
| 171 | `fireActivate({ notificationKey: 'turn:agent-session-7', sessionId: 'agent-session-nb' })` | 内核 |
| 178 | `pendingPayload = { notificationKey: 'turn:agent-session-7', sessionId: 'agent-session-7' }` | 内核 |
| 195 | `fireActivate({ notificationKey: 'turn:agent-session-7', sessionId: 'agent-session-7' })` | 内核 |
| 214 | `fireActivate({ notificationKey: 'turn:agent-session-7', sessionId: 'agent-session-7' })` | 内核 |
| 227 | `fireActivate({ notificationKey: 'turn:agent-session-7', sessionId: 'agent-session-7' })` | 内核 |
| 240 | `fireActivate({ notificationKey: 'turn:agent-session-7', sessionId: 'agent-session-7' })` | 内核 |
| 249 | `fireActivate({ notificationKey: 'turn:agent-session-7', sessionId: 'agent-session-unknown' })` | 内核 |
| 261 | `fireActivate({ notificationKey: 'turn:agent-session-7', sessionId: 'agent-session-7' })` | 内核 |

### `src/renderer/src/layout/composables/trayBridge.test.ts` — 6 处 · 对话·过IPC→保留

**依据**：`{ type: 'open-session', sessionId: 'chat-7' }` 是 `TrayAction` IPC 载荷字面量：值是对话 id，但字段名是 shared/trayActions.ts 的 IPC 契约 → 保留。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 231 | `pendingAction = { type: 'open-session', sessionId: 'chat-7' }` | 对话·过IPC→保留 |
| 247 | `pendingAction = { type: 'open-session', sessionId: 'chat-7' }` | 对话·过IPC→保留 |
| 257 | `pendingAction = { type: 'open-session', sessionId: 'nope' }` | 对话·过IPC→保留 |
| 377 | `pendingAction = { type: 'open-session', sessionId: 'chat-7' }` | 对话·过IPC→保留 |
| 396 | `pendingAction = { type: 'open-session', sessionId: 'chat-7' }` | 对话·过IPC→保留 |
| 415 | `pendingAction = { type: 'open-session', sessionId: 'chat-7' }` | 对话·过IPC→保留 |

### `src/renderer/src/views/System/Preferences/panels/ArchivedChatsModal.vue` — 3 处 · 对话→改名 + 内核

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 100 | `sessionId: session.id,` | 对话→改名 — `deleteChatSession({ sessionId: session.id })` deps 字段 = 对话 id。 |
| 102（同行 1/2） | `deleteTranscript: (sessionId) => window.api.agentV3.deleteSession({ sessionId }),` | 内核 — `deleteTranscript: (sessionId) => …deleteSession({ sessionId })` —— 参数与 IPC 载荷字段都是内核 id（两行同处一行，共 2 个声明）。 |
| 102（同行 2/2） | `deleteTranscript: (sessionId) => window.api.agentV3.deleteSession({ sessionId }),` | 内核 — `deleteTranscript: (sessionId) => …deleteSession({ sessionId })` —— 参数与 IPC 载荷字段都是内核 id（两行同处一行，共 2 个声明）。 |

### `src/renderer/src/views/System/Preferences/panels/ArchivedChatsModal.test.ts` — 1 处 · 内核

**依据**：`deleteSession` IPC 断言 `{ sessionId: 'agent-new' }` = 内核 id。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 128 | `expect(deleteSession).toHaveBeenCalledWith({ sessionId: 'agent-new' })` | 内核 |

### `src/renderer/src/common/chatRoute.ts` — 1 处 · 对话→改名

**依据**：`isSessionTab` 把参数和标签页 `?sid=` 比较 → 对话 id。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 12 | `export function isSessionTab(path: string, sessionId: string): boolean {` | 对话→改名 |

### `src/renderer/src/views/BlueprintLibrary/SnippetDetail.aiContext.test.ts` — 1 处 · 对话→改名

**依据**：`LibraryAIPanel` stub 的 `sessionId` prop 镜像被 mock 组件的对话 prop → 跟随组件改名。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 16 | `sessionId: { type: String, default: '' },` | 对话→改名 |

### `src/renderer/src/components/SensitiveActionConfirm.test.ts` — 1 处 · 内核

**依据**：`PendingApproval.sessionId` fixture，镜像 pendingApprovals.ts 的内核字段。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 43 | `sessionId: 's1',` | 内核 |

### `src/renderer/src/components/ImportProgressWidget.vue` — 1 处 · 导入

**依据**：注释「V2 会话 ID」= 网络库 v2 导入 session id，与对话无关。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 137 | `sessionId?: string` | 导入 |

### `src/renderer/src/components/useApprovalDisplay.test.ts` — 1 处 · 内核

**依据**：`PendingApproval.sessionId` fixture，镜像 pendingApprovals.ts 的内核字段。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 37 | `sessionId: 's1',` | 内核 |

### `src/renderer/src/views/BlueprintLibrary/BlueprintEditor.test.ts` — 1 处 · 对话→改名

**依据**：`LibraryAIPanel` stub 的 `sessionId` prop 镜像被 mock 组件的对话 prop → 跟随组件改名。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 63 | `sessionId: { type: String, default: '' },` | 对话→改名 |

### `src/renderer/src/views/Assistant/Welcome.vue` — 3 处 · 对话→改名 + 内核

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 484 | `sessionId: {` | 对话→改名 — `props.sessionId` → `sid.value` → 路由 `?sid=`/`ensureSession` = 对话 id。**已知改名点**（Welcome 自身 prop → `chatSid`）。 |
| 1858 | `data?: { sessionId?: string } & Partial<SelfCheckInput>` | 内核 — 气泡 `actionButton.data.sessionId` ← agentControlHandlers.ts:320 写进的内核 id（`agent-resume` 载荷）。 |
| 1875 | `const sessionId = payload.data?.sessionId` | 内核 — 解出的 `data.sessionId` → `resumeAgent` = 内核 id。 |

### `src/renderer/src/views/System/Preferences/panels/AgentV3Debug/AgentV3DebugPanel.vue` — 2 处 · 内核

**依据**：`const sessionId = ref('debug-…')` → `agentV3API.subscribe`/`execute` = 内核 id。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 25 | `` const sessionId = ref(`debug-${Date.now()}`) `` | 内核 |
| 113 | `sessionId: sessionId.value,` | 内核 |

### `src/renderer/src/api/ai.ts` — 6 处 · 内核 + 流id·过IPC→保留

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 282 | `sessionId?: string` | 内核 — `AgentExecuteParams.sessionId` → `executeAgent` → `agentV3.execute` 内核 id；下一行已显式并列 `chatSid`。 |
| 690 | `` const sessionId = `chat-text-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` `` | 流id·过IPC→保留 — 本地生成 `chat-text-…`，是 `ai.chatStream` 单次调用的请求关联 id → IPC 载荷字段；不是对话 id 也不是内核 id。 |
| 729 | `sessionId,` | 流id·过IPC→保留 — 把上面的流 id 装进 `chatStream` IPC 载荷。 |
| 1006 | `const sessionId = params.sessionId \|\| ''` | 内核 — `params.sessionId`（内核）→ `stop`/`execute` IPC。 |
| 1020 | `const result = await window.api.agentV3.stop({ sessionId })` | 内核 — `stop({ sessionId })` 载荷 = 内核 id。 |
| 1034 | `sessionId,` | 内核 — `execute({ sessionId })` 载荷 = 内核 id。 |

### `src/renderer/src/api/ai.executeAgent.test.ts` — 3 处 · 内核

**依据**：`executeAgent` IPC 载荷断言，内核 id。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 49 | `sessionId: 'session-a'` | 内核 |
| 78 | `expect.objectContaining({ sessionId: 'session-a', prompt: '造一艘船', mode: 'agent' })` | 内核 |
| 220 | `expect(agentV3.stop).toHaveBeenCalledWith({ sessionId: 'session-a' })` | 内核 |

### `src/renderer/src/api/ai.chatText.test.ts` — 8 处 · 流id·过IPC→保留

**依据**：`chatStream` 请求/事件里 `sessionId` 的测试字面量，镜像 ai.ts 的流关联 id。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 11 | `type ChunkHandler = (payload: { sessionId: string; delta: string }) => void` | 流id·过IPC→保留 |
| 12 | `type DoneHandler = (payload: { sessionId: string; text: string; aborted: boolean }) => void` | 流id·过IPC→保留 |
| 13 | `type ErrorHandler = (payload: { sessionId: string; message: string }) => void` | 流id·过IPC→保留 |
| 34 | `let sessionId = ''` | 流id·过IPC→保留 |
| 43 | `const chatStream = vi.fn(async (args: { sessionId: string }) => {` | 流id·过IPC→保留 |
| 72 | `emitChunk: (delta) => chunkHandlers.forEach((h) => h({ sessionId, delta })),` | 流id·过IPC→保留 |
| 74 | `doneHandlers.forEach((h) => h({ sessionId, text, aborted })),` | 流id·过IPC→保留 |
| 75 | `emitError: (message) => errorHandlers.forEach((h) => h({ sessionId, message })),` | 流id·过IPC→保留 |

### `src/renderer/src/api/editorSnapshotIpcPayload.test.ts` — 3 处 · 内核

**依据**：`executeAgent` IPC 载荷断言 `sessionId: 'agent-1'`，内核 id。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 132 | `sessionId: 'agent-1',` | 内核 |
| 151 | `await aiAPI.executeAgent({ sessionId: 'a', prompt: 'hi', editorSnapshot: null }, {})` | 内核 |
| 155 | `await aiAPI.executeAgent({ sessionId: 'a', prompt: 'hi' }, {})` | 内核 |

### `src/renderer/src/api/agentV3.ts` — 41 处 · 内核

**依据**：`window.api.agentV3.*` 的渲染层封装。`sessionId` 全部是内核会话 id（`setApprovalMode` 注释明示 `chatStore.getAgentSessionId`）→ 原样进 IPC 载荷到主进程 agent-v3。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 86 | `sessionId?: string` | 内核 |
| 117 | `sessionId: string` | 内核 |
| 178 | `sessionId: string` | 内核 |
| 183 | `sessionId: args.sessionId,` | 内核 |
| 198 | `sessionModel(sessionId: string) {` | 内核 |
| 199 | `return window.api.agentV3.sessionModel({ sessionId })` | 内核 |
| 213 | `sessionId: string,` | 内核 |
| 219 | `sessionId,` | 内核 |
| 234 | `setApprovalMode(sessionId: string, approvalMode: AgentV3ApprovalMode, mode?: 'agent' \| 'ask') {` | 内核 |
| 235 | `return window.api.agentV3.setApprovalMode({ sessionId, approvalMode, mode })` | 内核 |
| 238 | `steer(sessionId: string, message: string) {` | 内核 |
| 239 | `return window.api.agentV3.steer({ sessionId, message })` | 内核 |
| 249 | `cancelSteer(sessionId: string, steerId: string) {` | 内核 |
| 250 | `return window.api.agentV3.cancelSteer({ sessionId, steerId })` | 内核 |
| 253 | `stop(sessionId: string) {` | 内核 |
| 254 | `return window.api.agentV3.stop({ sessionId })` | 内核 |
| 268 | `compact(sessionId: string): Promise<AgentV3CompactResult> {` | 内核 |
| 269 | `return window.api.agentV3.compact({ sessionId }) as Promise<AgentV3CompactResult>` | 内核 |
| 378 | `loadSession(sessionId: string): Promise<{ messages: unknown[] }> {` | 内核 |
| 379 | `return window.api.agentV3.loadSession({ sessionId })` | 内核 |
| 382 | `deleteSession(sessionId: string) {` | 内核 |
| 383 | `return window.api.agentV3.deleteSession({ sessionId })` | 内核 |
| 399 | `sessionId: string,` | 内核 |
| 403 | `sessionId?: string` | 内核 |
| 408 | `return window.api.agentV3.forkSession({ sessionId, keepUserTurns })` | 内核 |
| 418 | `sessionId: string,` | 内核 |
| 427 | `return window.api.agentV3.truncateSession({ sessionId, keepUserTurns })` | 内核 |
| 437 | `forkForSideQuestion(sessionId: string): Promise<{` | 内核 |
| 439 | `sessionId?: string` | 内核 |
| 445 | `return window.api.agentV3.forkForSideQuestion({ sessionId })` | 内核 |
| 459 | `async goalState(sessionId: string): Promise<{ objective: string; settled: boolean } \| null> {` | 内核 |
| 460 | `const result = await window.api.agentV3.goalState({ sessionId })` | 内核 |
| 465 | `goalEnd(sessionId: string): Promise<{ success: boolean; error?: string; errorKey?: 'running' }> {` | 内核 |
| 466 | `return window.api.agentV3.goalEnd({ sessionId })` | 内核 |
| 470 | `async teamState(sessionId: string): Promise<TeamStateView \| null> {` | 内核 |
| 471 | `const result = await window.api.agentV3.teamState({ sessionId })` | 内核 |
| 481 | `teamTaskReopen(sessionId: string, taskId: string): Promise<{ success: boolean; error?: string }> {` | 内核 |
| 482 | `return window.api.agentV3.teamTaskReopen({ sessionId, taskId })` | 内核 |
| 485 | `teamEnd(sessionId: string): Promise<{ success: boolean; error?: string; errorKey?: 'running' }> {` | 内核 |
| 486 | `return window.api.agentV3.teamEnd({ sessionId })` | 内核 |
| 515 | `subscribe(sessionId: string, handler: (event: AgentV3Event) => void): () => void {` | 内核 |

### `src/renderer/src/api/agentBrowser.ts` — 4 处 · 内核

**依据**：Agent 浏览器面板的 IPC 封装，按内核会话寻址 → 主进程浏览器宿主。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 17 | `async tab(sessionId: string, command: BrowserTabCommand): Promise<void> {` | 内核 |
| 20 | `async toolbar(sessionId: string, action: BrowserToolbarAction): Promise<void> {` | 内核 |
| 23 | `async openUrl(sessionId: string, address: string): Promise<{ url: string }> {` | 内核 |
| 26 | `async getState(sessionId: string, restore: boolean): Promise<AgentBrowserState> {` | 内核 |

### `src/renderer/src/store/modules/agentStream.ts` — 2 处 · 内核

**依据**：`agentProcess` 条目 `data.sessionId` = 形参 `agentSessionId`（反问卡片的答案要拿它 resolveQuestion 回内核）。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 384 | `sessionId: agentSessionId,` | 内核 |
| 459 | `data: { ...item, sessionId: agentSessionId },` | 内核 |

### `src/renderer/src/views/AssetManagement/index.vue` — 9 处 · 导入

**依据**：文件夹导入阶段/恢复 IPC 载荷与 `ImportRecoverySummary` 里的 `sessionId` = 网络库 v2 导入 session id。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 2128 | `sessionId?: string` | 导入 |
| 2169 | `sessionId: payload.sessionId \|\| undefined,` | 导入 |
| 2198 | `sessionId?: string` | 导入 |
| 2266 | `sessionId?: string` | 导入 |
| 2284 | `sessionId: string` | 导入 |
| 2300 | `sessionId?: string` | 导入 |
| 2463 | `sessionId: getStringField(data.sessionId) \|\| getStringField(firstIssue.sessionId),` | 导入 |
| 2584 | `const sessionId = payload.sessionId \|\| '-'` | 导入 |
| 2783 | `sessionId: latest.sessionId,` | 导入 |

### `src/renderer/src/store/modules/chatSessions.ts` — 2 处 · 内核

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 477 | `.setSessionProject({ sessionId: agentSessionId, project: session.project })` | 内核 — `setSessionProject` IPC 载荷字段，值 = `session.agentSessionId`。 |
| 553 | `function setAgentSessionId(id: string, sessionId: string): void {` | 内核 — `setAgentSessionId(id, sessionId)` 的 `sessionId` 写进 `session.agentSessionId` = 内核 id。 |

### `src/renderer/src/store/modules/importTasks.ts` — 1 处 · 导入

**依据**：注释「V2 Import Session ID」= 网络库导入 session id。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 40 | `sessionId?: string` | 导入 |

### `src/renderer/src/views/Assistant/composables/agentHandlerShared.ts` — 10 处 · 内核

**依据**：事件类型字段（ToolCall/ToolResult/Notify/Step/Done/Stopped/Error）的 `sessionId` = 内核 id；`clearWikiRagState`/`getWikiRagCitations` 以 `agentSessionId` 键控（调用方传的都是 `agentSessionId`）；`resolveTargetChatSid(…, sessionId)` 喂 `getChatSidByAgentSession`。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 12 | `sessionId?: string` | 内核 |
| 25 | `sessionId?: string` | 内核 |
| 31 | `sessionId?: string` | 内核 |
| 45 | `sessionId?: string` | 内核 |
| 50 | `sessionId?: string` | 内核 |
| 62 | `sessionId?: string` | 内核 |
| 95 | `sessionId?: string` | 内核 |
| 118 | `clearWikiRagState: (sessionId?: string) => void` | 内核 |
| 119 | `getWikiRagCitations: (sessionId?: string) => NotebookRagCitation[]` | 内核 |
| 141 | `sessionId?: string` | 内核 |

### `src/renderer/src/store/modules/chatSessions.test.ts` — 3 处 · 内核

**依据**：`setSessionProject` 载荷断言 `sessionId: 'kernel-a'` = 内核 id。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 477 | `sessionId: 'kernel-a',` | 内核 |
| 483 | `sessionId: 'kernel-a',` | 内核 |
| 488 | `expect(pushed.calls.at(-1)).toMatchObject({ sessionId: 'kernel-a', project: null })` | 内核 |

### `src/renderer/src/store/modules/pendingApprovals.test.ts` — 1 处 · 内核

**依据**：`PendingApproval` fixture。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 16 | `sessionId: 'session-1',` | 内核 |

### `src/renderer/src/store/modules/chatMessages.test.ts` — 1 处 · 内核

**依据**：`agent-resume` 按钮 `data.sessionId` fixture，镜像 agentControlHandlers.ts 的内核 id。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 283 | `const resumeButton = [{ label: '继续尝试', action: 'agent-resume', data: { sessionId: 's1' } }]` | 内核 |

### `src/renderer/src/views/Assistant/composables/agentEventDispatcher.ts` — 42 处 · 内核

**依据**：全局分发器按内核 `sessionId` 路由 `agent-v3:*` 事件；`registerAgentHandler` 的 `sessionId`（内核）与 `chatSid`（对话）显式并列。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 62 | `sessionId: string` | 内核 |
| 92 | `sessionId?: string` | 内核 |
| 101 | `sessionId?: string` | 内核 |
| 107 | `sessionId?: string` | 内核 |
| 111 | `sessionId?: string` | 内核 |
| 115 | `sessionId?: string` | 内核 |
| 194 | `function paintStreamingMessage(sessionId: string): void {` | 内核 |
| 229 | `function scheduleRepaint(sessionId: string): void {` | 内核 |
| 241 | `function cancelRepaint(sessionId: string): void {` | 内核 |
| 248 | `export function finalizeSessionCompletionForUI(sessionId: string): void {` | 内核 |
| 306 | `function handlerFor(sessionId?: string): RegisteredHandler \| undefined {` | 内核 |
| 317 | `sessionId: string,` | 内核 |
| 329 | `sessionId,` | 内核 |
| 359 | `on('agent-v3:text', (data: { sessionId: string; text: string }) => {` | 内核 |
| 367 | `on('agent-v3:thinking', (data: { sessionId: string; text: string }) => {` | 内核 |
| 376 | `(data: { sessionId: string; toolCallId: string; toolName: string; args: unknown }) => {` | 内核 |
| 383 | `sessionId: data.sessionId,` | 内核 |
| 401 | `(data: { sessionId: string; toolCallId?: string; toolName: string; partial: unknown }) => {` | 内核 |
| 415 | `sessionId: string` | 内核 |
| 426 | `sessionId: data.sessionId,` | 内核 |
| 437 | `on('agent-v3:step', (data: { sessionId: string }) => {` | 内核 |
| 441 | `handlerFor(data.sessionId)?.onStep?.({ sessionId: data.sessionId, step })` | 内核 |
| 448 | `on('agent-v3:user-message', (data: { sessionId: string; text: string }) => {` | 内核 |
| 465 | `(data: { sessionId: string; toolCallId: string; questions: AgentQuestion[] }) => {` | 内核 |
| 494 | `sessionId: string` | 内核 |
| 506 | `sessionId: data.sessionId,` | 内核 |
| 530 | `sessionId?: string` | 内核 |
| 546 | `(data: { sessionId: string; tokens: number; contextWindow: number }) => {` | 内核 |
| 564 | `on('agent-v3:turn-usage', (data: { sessionId: string } & AgentTurnUsage) => {` | 内核 |
| 578 | `on('agent-v3:compacting', (data: { sessionId: string }) => {` | 内核 |
| 586 | `on('agent-v3:goal', (data: { sessionId: string; message: string; level: string }) => {` | 内核 |
| 594 | `on('agent-v3:notice', (data: { sessionId: string; message: string; level: string }) => {` | 内核 |
| 606 | `sessionId: string` | 内核 |
| 634 | `on('agent-v3:model-retry', (data: { sessionId: string; model: string; reason: string }) => {` | 内核 |
| 647 | `on('agent-v3:done', (data: { sessionId: string }) => {` | 内核 |
| 654 | `on('agent-v3:stopped', (data: { sessionId: string }) => {` | 内核 |
| 663 | `sessionId: string` | 内核 |
| 694 | `sessionId: string,` | 内核 |
| 798 | `export function isCurrentRun(sessionId: string, runId?: number): boolean {` | 内核 |
| 803 | `export function unregisterAgentHandler(sessionId: string, runId?: number): void {` | 内核 |
| 825 | `export function hasActiveHandler(sessionId: string): boolean {` | 内核 |
| 830 | `for (const [sessionId, handler] of handlers) {` | 内核 |

### `src/renderer/src/views/Assistant/AgentBrowserWindow.vue` — 1 处 · 内核

**依据**：路由 `?sessionId=` → `useSessionBrowser` → `agentBrowserAPI.getState` = 内核 id。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 23 | `const sessionId = computed(() =>` | 内核 |

### `src/renderer/src/store/modules/pendingApprovals.ts` — 1 处 · 内核

**依据**：注释：字段就是主进程 `approvalChannel.ts` 发来的原样 = 内核 id。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 14 | `sessionId: string` | 内核 |

### `src/renderer/src/views/Assistant/composables/agentEventDispatcher.test.ts` — 85 处 · 内核

**依据**：`agent-v3:*` 事件载荷与 `registerAgentHandler({ sessionId: SID, chatSid: CHAT })` fixture —— `sessionId` 一律内核（与 `chatSid` 显式并列）。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 121 | `bus.emit('agent-v3:text', { sessionId: SID, text: '已创建材质' })` | 内核 |
| 129 | `bus.emit('agent-v3:thinking', { sessionId: SID, text: '先看看图表' })` | 内核 |
| 130 | `bus.emit('agent-v3:text', { sessionId: SID, text: '正文' })` | 内核 |
| 152 | `sessionId: SID,` | 内核 |
| 169 | `bus.emit('agent-v3:thinking', { sessionId: SID, text: '先确认工程连上了没有' })` | 内核 |
| 188 | `` bus.emit('agent-v3:text', { sessionId: SID, text: `第 ${i} 段增量文本内容。` }) `` | 内核 |
| 203 | `registerAgentHandler({ sessionId: SID, chatSid: CHAT, onStreamPaint })` | 内核 |
| 206 | `` bus.emit('agent-v3:text', { sessionId: SID, text: `第 ${i} 段增量文本内容。` }) `` | 内核 |
| 221 | `registerAgentHandler({ sessionId: SID, chatSid: CHAT, onStreamPaint })` | 内核 |
| 223 | `bus.emit('agent-v3:thinking', { sessionId: SID, text: '先分析问题。' })` | 内核 |
| 227 | `bus.emit('agent-v3:thinking', { sessionId: SID, text: '再检查工程。' })` | 内核 |
| 241 | `registerAgentHandler({ sessionId: SID, chatSid: CHAT, onToolCall })` | 内核 |
| 244 | `sessionId: SID,` | 内核 |
| 251 | `sessionId: SID,` | 内核 |
| 268 | `registerAgentHandler({ sessionId: SID, chatSid: CHAT, onToolResult })` | 内核 |
| 271 | `sessionId: SID,` | 内核 |
| 284 | `sessionId: SID,` | 内核 |
| 302 | `registerAgentHandler({ sessionId: SID, chatSid: CHAT, onToolCall })` | 内核 |
| 305 | `sessionId: 'session-b',` | 内核 |
| 317 | `registerAgentHandler({ sessionId: SID, chatSid: CHAT, onToolCall })` | 内核 |
| 321 | `sessionId: SID,` | 内核 |
| 342 | `const firstRun = registerAgentHandler({ sessionId: SID, chatSid: CHAT })` | 内核 |
| 347 | `const secondRun = registerAgentHandler({ sessionId: SID, chatSid: CHAT, onToolCall })` | 内核 |
| 354 | `sessionId: SID,` | 内核 |
| 369 | `registerAgentHandler({ sessionId: SID, chatSid: CHAT })` | 内核 |
| 381 | `registerAgentHandler({ sessionId: SID, chatSid: CHAT, onStep })` | 内核 |
| 383 | `bus.emit('agent-v3:step', { sessionId: SID })` | 内核 |
| 384 | `bus.emit('agent-v3:step', { sessionId: SID })` | 内核 |
| 392 | `expect(onStep).toHaveBeenLastCalledWith({ sessionId: SID, step: 2 })` | 内核 |
| 398 | `registerAgentHandler({ sessionId: SID, chatSid: CHAT, onStep })` | 内核 |
| 399 | `bus.emit('agent-v3:step', { sessionId: SID })` | 内核 |
| 402 | `registerAgentHandler({ sessionId: SID, chatSid: CHAT, onStep })` | 内核 |
| 403 | `bus.emit('agent-v3:step', { sessionId: SID })` | 内核 |
| 419 | `registerAgentHandler({ sessionId: SID, chatSid: CHAT, onDone })` | 内核 |
| 421 | `bus.emit('agent-v3:text', { sessionId: SID, text: '做完了' })` | 内核 |
| 422 | `bus.emit('agent-v3:done', { sessionId: SID })` | 内核 |
| 434 | `registerAgentHandler({ sessionId: SID, chatSid: CHAT, onStopped, onError })` | 内核 |
| 436 | `bus.emit('agent-v3:stopped', { sessionId: SID })` | 内核 |
| 445 | `registerAgentHandler({ sessionId: SID, chatSid: CHAT, onError })` | 内核 |
| 447 | `bus.emit('agent-v3:error', { sessionId: SID, message: '模型未配置' })` | 内核 |
| 462 | `registerAgentHandler({ sessionId: SID, chatSid: CHAT, onError })` | 内核 |
| 465 | `sessionId: SID,` | 内核 |
| 484 | `registerAgentHandler({ sessionId: SID, chatSid: CHAT, onError })` | 内核 |
| 487 | `sessionId: SID,` | 内核 |
| 498 | `bus.emit('agent-v3:error', { sessionId: SID, message: 'x', statusCode: 402 })` | 内核 |
| 516 | `bus.emit('agent-v3:text', { sessionId: SID, text: '，刷新后接着说完' })` | 内核 |
| 517 | `bus.emit('agent-v3:done', { sessionId: SID })` | 内核 |
| 533 | `sessionId: SID,` | 内核 |
| 545 | `bus.emit('agent-v3:text', { sessionId: SID, text: reply })` | 内核 |
| 546 | `bus.emit('agent-v3:goal', { sessionId: SID, message: '正在复核', level: 'info' })` | 内核 |
| 547 | `bus.emit('agent-v3:done', { sessionId: SID })` | 内核 |
| 558 | `registerAgentHandler({ sessionId: SID, chatSid: CHAT, onNotifyUsers })` | 内核 |
| 560 | `bus.emit('agent-v3:compacting', { sessionId: SID })` | 内核 |
| 572 | `registerAgentHandler({ sessionId: SID, chatSid: CHAT, onNotifyUsers, onError })` | 内核 |
| 575 | `sessionId: SID,` | 内核 |
| 594 | `registerAgentHandler({ sessionId: SID, chatSid: CHAT, onNotifyUsers })` | 内核 |
| 598 | `sessionId: SID,` | 内核 |
| 615 | `registerAgentHandler({ sessionId: SID, chatSid: CHAT, onNotifyUsers })` | 内核 |
| 618 | `sessionId: SID,` | 内核 |
| 634 | `registerAgentHandler({ sessionId: SID, chatSid: CHAT, onNotifyUsers })` | 内核 |
| 637 | `sessionId: SID,` | 内核 |
| 654 | `registerAgentHandler({ sessionId: SID, chatSid: CHAT, onNotifyUsers })` | 内核 |
| 657 | `sessionId: SID,` | 内核 |
| 674 | `registerAgentHandler({ sessionId: SID, chatSid: CHAT, onNotifyUsers })` | 内核 |
| 677 | `sessionId: SID,` | 内核 |
| 691 | `registerAgentHandler({ sessionId: SID, chatSid: CHAT, onNotifyUsers })` | 内核 |
| 693 | `bus.emit('agent-v3:tool-progress', { sessionId: SID, toolName: 'x', partial: {} })` | 内核 |
| 700 | `bus.emit('agent-v3:compacting', { sessionId: SID })` | 内核 |
| 723 | `bus.emit('agent-v3:context-usage', { sessionId: SID, tokens: 12_000, contextWindow: 128_000 })` | 内核 |
| 740 | `bus.emit('agent-v3:context-usage', { sessionId: SID, tokens: 900, contextWindow: 8_000 })` | 内核 |
| 753 | `bus.emit('agent-v3:context-usage', { sessionId: SID, tokens: 900, contextWindow: 8_000 })` | 内核 |
| 760 | `sessionId: 'unknown-session',` | 内核 |
| 784 | `): { sessionId: string } & AgentTurnUsage => ({` | 内核 |
| 785 | `sessionId: SID,` | 内核 |
| 812 | `bus.emit('agent-v3:turn-usage', { ...usage(10, 10, 0), sessionId: 'unknown-session' })` | 内核 |
| 837 | `bus.emit('agent-v3:question-required', { sessionId: SID, toolCallId, questions: QUESTIONS })` | 内核 |
| 849 | `expect(questionItems()[0].data).toMatchObject({ toolCallId: 'q1', sessionId: SID })` | 内核 |
| 909 | `sessionId: 'no-such-session',` | 内核 |
| 922 | `bus.emit('agent-v3:question-required', { sessionId: SID, questions: QUESTIONS })` | 内核 |
| 943 | `bus.emit('agent-v3:done', { sessionId: SID })` | 内核 |
| 955 | `bus.emit('agent-v3:done', { sessionId: SID })` | 内核 |
| 970 | `sessionId: SID,` | 内核 |
| 984 | `sessionId: SID,` | 内核 |
| 1000 | `sessionId: SID,` | 内核 |
| 1093 | `expect(bus.cancelSteer).toHaveBeenCalledWith({ sessionId: SID_S, steerId: 'steer-1' })` | 内核 |

### `src/renderer/src/views/Assistant/composables/agentControlHandlers.ts` — 1 处 · 内核

**依据**：`data.sessionId`（ErrorEvent 内核 id）写进报错气泡的 `agent-resume` 按钮 data。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 320 | `sessionId: data.sessionId,` | 内核 |

### `src/renderer/src/views/Assistant/composables/chatSendPrimitives.ts` — 7 处 · 对话→改名

**依据**：`EnsureSessionDeps.chatStore` 五个方法的 `sessionId` 参数、`ensureSessionWithTitle(sessionId)`、`stampSessionProject` 的 `sessionId` 字段 —— 全是界面会话 id（经 `ensureSession`/`sessionById`/`setProject`）。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 44 | `ensureSession: (sessionId: string, title: string) => void` | 对话→改名 |
| 45 | `sessionById: (sessionId: string) => ChatSession \| null` | 对话→改名 |
| 46 | `updateTitle: (sessionId: string, title: string) => void` | 对话→改名 |
| 47 | `appendMessage: (sessionId: string, text: string) => void` | 对话→改名 |
| 48 | `setProject: (sessionId: string, project: ChatSessionProject \| null) => void` | 对话→改名 |
| 67 | `sessionId: string,` | 对话→改名 |
| 100 | `sessionId,` | 对话→改名 |

### `src/renderer/src/views/Assistant/composables/chatBranch.ts` — 1 处 · 内核

**依据**：`ForkTranscriptResult.sessionId` 注释「内核复制 session 的结果」= fork 出的新 agentSessionId。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 36 | `sessionId?: string` | 内核 |

### `src/renderer/src/views/Assistant/components/AgentBrowserPane.vue` — 1 处 · 内核

**依据**：面板 prop = 内核会话 id → `useSessionBrowser`/`agentBrowserAPI`。**已知保留点**：`:session-id` 不动。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 213 | `sessionId: string` | 内核 |

### `src/renderer/src/views/Assistant/composables/chatBranch.test.ts` — 1 处 · 内核

**依据**：`forkTranscript` mock 返回 `sessionId: 'agent-branch'` = 内核 id。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 20 | `forkTranscript: vi.fn().mockResolvedValue({ success: true, sessionId: 'agent-branch' }),` | 内核 |

### `src/renderer/src/views/Assistant/components/AgentBrowserPane.test.ts` — 1 处 · 内核

**依据**：prop fixture，镜像内核 prop。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 70 | `props: { sessionId: 'session-a', open: true, visible: true },` | 内核 |

### `src/renderer/src/views/Assistant/components/AIBubble.actions.test.ts` — 3 处 · 内核

**依据**：`agent-resume` 按钮 `data.sessionId` fixture = 内核 id。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 20 | `data: Record<string, unknown> = { sessionId: 'session-1' }` | 内核 |
| 110 | `sessionId: 'session-1',` | 内核 |
| 130 | `sessionId: 'session-1',` | 内核 |

### `src/renderer/src/views/Assistant/composables/approvalModeSync.ts` — 1 处 · 内核

**依据**：解构遍历 `modeByAgentSession` 的键 = `agentSessionId` → `agentV3API.setApprovalMode`。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 63 | `for (const [sessionId, mode] of Object.entries(next)) {` | 内核 |

### `src/renderer/src/views/Assistant/composables/agentTimeline.ts` — 3 处 · 内核

**依据**：`AgentTimelineSteerBlock.sessionId` 注释「撤回这条要用的号和会话」→ `cancelSteer` 需要内核 id；从事件 `data.sessionId` 原样搬。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 55 | `sessionId?: string` | 内核 |
| 152 | `sessionId?: unknown` | 内核 |
| 174 | `...(typeof data?.sessionId === 'string' ? { sessionId: data.sessionId } : {}),` | 内核 |

### `src/renderer/src/views/Assistant/composables/agentTimeline.test.ts` — 3 处 · 内核

**依据**：`user-steer` 条目 `data.sessionId` fixture = 内核 id（撤回要用）。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 132 | `data: { text: '算了', applied: false, cancelled: true, steerId: 's-1', sessionId: 'a-1' },` | 内核 |
| 141 | `sessionId: 'a-1'` | 内核 |
| 401 | `sessionId: 's1',` | 内核 |

### `src/renderer/src/views/Assistant/composables/agentStreamHandlers.ts` — 2 处 · 内核

**依据**：`appendProcessItem(…, sessionId)` → `addAgentProcess`（按内核 id 键控）；`handleAgentText` 的 `data.sessionId` 对 `currentSessionId`（内核）。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 60 | `sessionId?: string` | 内核 |
| 111 | `function handleAgentText(_event: unknown, data: { delta: string; sessionId?: string }): void {` | 内核 |

### `src/renderer/src/views/Assistant/components/AskUserCard.test.ts` — 1 处 · 内核

**依据**：`AgentQuestionItem.sessionId` fixture = 内核 id。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 14 | `sessionId: 's1',` | 内核 |

### `src/renderer/src/views/Assistant/composables/agentSessionIsolation.test.ts` — 12 处 · 内核

**依据**：`{ sessionId: ctx.sessionA }` fixture —— `initStream(chatA, sessionA)` 里 `sessionA` 是内核 id。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 147 | `sessionId: ctx.sessionA,` | 内核 |
| 180 | `handlers.handleAgentStopped(null, { sessionId: ctx.sessionA })` | 内核 |
| 197 | `vi.mocked(unregisterAgentHandler).mockImplementation((sessionId: string) => {` | 内核 |
| 227 | `const finalText = await handlers.handleAgentDone(null, { sessionId: ctx.sessionA })` | 内核 |
| 259 | `vi.mocked(unregisterAgentHandler).mockImplementation((sessionId: string) => {` | 内核 |
| 273 | `sessionId: ctx.sessionA,` | 内核 |
| 285 | `vi.mocked(unregisterAgentHandler).mockImplementation((sessionId: string) => {` | 内核 |
| 298 | `await handlers.handleAgentDone(null, { sessionId: ctx.sessionA })` | 内核 |
| 319 | `vi.mocked(unregisterAgentHandler).mockImplementation((sessionId: string) => {` | 内核 |
| 335 | `await handlers.handleAgentDone(null, { sessionId: ctx.sessionA, runId: 1 })` | 内核 |
| 349 | `vi.mocked(unregisterAgentHandler).mockImplementation((sessionId: string) => {` | 内核 |
| 373 | `sessionId: ctx.sessionA,` | 内核 |

### `src/renderer/src/views/Assistant/composables/sessionAutoTitle.ts` — 3 处 · 对话→改名

**依据**：`getTitle`/`applyTitle` 回调与 `autoNameSession(sessionId)` 都按界面会话 id 读写标题。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 16 | `getTitle: (sessionId: string) => string \| undefined` | 对话→改名 |
| 18 | `applyTitle: (sessionId: string, title: string) => void` | 对话→改名 |
| 28 | `sessionId: string,` | 对话→改名 |

### `src/renderer/src/views/Assistant/components/EditorStatusMonitor.test.ts` — 2 处 · 对话→改名

**依据**：`mountMonitor(sessionId)`/`props:{sessionId}` fixture，镜像组件 prop（对话 id）。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 50 | `async function mountMonitor(sessionId = 'sid'): Promise<ReturnType<typeof mount>> {` | 对话→改名 |
| 55 | `props: { sessionId },` | 对话→改名 |

### `src/renderer/src/views/Assistant/components/EditorStatusMonitor.vue` — 2 处 · 对话→改名

**依据**：`sessionId?` prop → `chatStore.sessionById(props.sessionId)` = 界面 id。**已知改名点**（→ `chatSid`）。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 32 | `sessionId?: string` | 对话→改名 |
| 36 | `{ sessionId: '', pendingProjectName: '' }` | 对话→改名 |

### `src/renderer/src/views/Assistant/composables/followUpDelivery.test.ts` — 2 处 · 内核

**依据**：`agent-v3:released` 载荷 `{ sessionId }` fixture = 内核 id。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 70 | `let fireReleased: (payload?: { sessionId?: string }) => void = () => {}` | 内核 |
| 192 | `fireReleased({ sessionId: 'agent-session-1' })` | 内核 |

### `src/renderer/src/views/Assistant/composables/followUpDelivery.ts` — 1 处 · 内核

**依据**：`agent-v3:released` 事件载荷 `{ sessionId? }` = 内核 id → `sessionByAgentSessionId` 查对话。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 160 | `const payload = args[0] as { sessionId?: string } \| undefined` | 内核 |

### `src/renderer/src/views/Assistant/composables/creatorPlanChatError.test.ts` — 4 处 · 内核

**依据**：`handleAgentError(…, { sessionId: SESSION })` fixture = ErrorEvent 内核 id。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 160 | `sessionId: SESSION,` | 内核 |
| 176 | `sessionId: SESSION,` | 内核 |
| 190 | `sessionId: SESSION,` | 内核 |
| 206 | `sessionId: SESSION,` | 内核 |

### `src/renderer/src/views/Assistant/composables/sessionTaskDone.ts` — 2 处 · 对话→改名

**依据**：`isSessionOnScreen`/`shouldMarkTaskDone` 的 `sessionId` 与路由 `?sid=` 比较 = 对话 id。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 11 | `sessionId: string` | 对话→改名 |
| 27 | `sessionId: string` | 对话→改名 |

### `src/renderer/src/views/Assistant/composables/sessionProjectSync.ts` — 1 处 · 内核

**依据**：`SessionProjectEvent.sessionId` 注释明示「内核会话 id，不是界面 id」→ `sessionByAgentSessionId` 反查。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 34 | `sessionId: string` | 内核 |

### `src/renderer/src/views/Assistant/composables/sessionProjectBinding.ts` — 2 处 · 对话→改名

**依据**：`StampSessionProjectDeps.sessionId` → `getSession(sessionId)`/`setProject(sessionId)` 按界面 id；`{ sessionId }` 解构同一字段。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 4 | `sessionId: string` | 对话→改名 |
| 76 | `const { sessionId, getSession, setProject } = deps` | 对话→改名 |

### `src/renderer/src/views/Assistant/composables/sideQuestion.test.ts` — 2 处 · 内核

**依据**：`fork` mock 返回 `sessionId: 'agent-side'` = 内核 id。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 12 | `.mockResolvedValue({ success: true, sessionId: 'agent-side', messageCount: 12, live: true }),` | 内核 |
| 84 | `fork: vi.fn().mockResolvedValue({ success: true, sessionId: 'agent-side', messageCount: 3 })` | 内核 |

### `src/renderer/src/views/Assistant/composables/sessionProjectSync.test.ts` — 5 处 · 内核

**依据**：`SessionProjectEvent` fixture `'agent-*'` = 内核 id。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 42 | `sessionId: 'agent-1',` | 内核 |
| 58 | `applySessionProjectEvent({ sessionId: 'agent-1', project: null }, store)` | 内核 |
| 68 | `applySessionProjectEvent({ sessionId: 'agent-1', project: { projectName: '  ' } }, store)` | 内核 |
| 76 | `applySessionProjectEvent({ sessionId: 'agent-somewhere-else', project: null }, store)` | 内核 |
| 85 | `applySessionProjectEvent({ sessionId: '  ', project: null }, store)` | 内核 |

### `src/renderer/src/views/Assistant/composables/sideQuestion.ts` — 1 处 · 内核

**依据**：`SideQuestionForkResult.sessionId` = `forkForSideQuestion` 返回的新 agentSessionId（deps 注释明示）。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 26 | `sessionId?: string` | 内核 |

### `src/renderer/src/views/Assistant/composables/sessionProjectBinding.test.ts` — 3 处 · 对话→改名

**依据**：`deps.sessionId` fixture = `session?.id`（对话 id）。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 23 | `sessionId: string` | 对话→改名 |
| 33 | `sessionId: session?.id \|\| 'sid-1',` | 对话→改名 |
| 97 | `stampSessionProject({ ...deps, sessionId: '', preferredProjectName: 'ArchViz' })` | 对话→改名 |

### `src/renderer/src/views/Assistant/components/InputComposer.vue` — 2 处 · 内核

**依据**：`const sessionId = getAgentSessionId(chatSid)` → `agentV3.compact({ sessionId })` = 内核 id。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 1467 | `const sessionId = chatSessionsStore.getAgentSessionId(chatSid)` | 内核 |
| 1475 | `const result = await window.api.agentV3.compact({ sessionId })` | 内核 |

### `src/renderer/src/views/MaterialLibrary/MaterialEditor.test.ts` — 1 处 · 对话→改名

**依据**：`LibraryAIPanel` stub 的 `sessionId` prop 镜像被 mock 组件的对话 prop → 跟随组件改名。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 24 | `sessionId: { type: String, default: '' },` | 对话→改名 |

### `src/renderer/src/views/Assistant/composables/useAgentMode.ts` — 17 处 · 内核

**依据**：wiki RAG 状态按 `agentSessionId` 键控（setWikiRagState 调用点 773/781 传 `agentSessionId`）；`const sessionId = getAgentSessionId(sid.value)`（397/411/1027/1054）与各 IPC 载荷字段 `sessionId: agentSessionId`（442/466/475/550/845/970/983/984/1260）全是内核 id。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 147 | `sessionId: string,` | 内核 |
| 172 | `const getWikiRagCitations = (sessionId?: string): NotebookRagCitation[] => {` | 内核 |
| 178 | `sessionId?: string` | 内核 |
| 184 | `const clearWikiRagState = (sessionId?: string): void => {` | 内核 |
| 397 | `const sessionId = chatStore.getAgentSessionId(sid.value)` | 内核 |
| 411 | `const sessionId = chatStore.getAgentSessionId(sid.value)` | 内核 |
| 442 | `sessionId: agentSessionId,` | 内核 |
| 466 | `handleAgentStopped(null, { sessionId: agentSessionId, runId })` | 内核 |
| 475 | `sessionId: agentSessionId,` | 内核 |
| 550 | `sessionId: agentSessionId,` | 内核 |
| 845 | `sessionId: agentSessionId,` | 内核 |
| 970 | `const result = await window.api.agentV3.stop({ sessionId: elsewhereSessionId })` | 内核 |
| 983 | `const result = await window.api.agentV3.stop({ sessionId: currentSessionId.value })` | 内核 |
| 984 | `handleAgentStopped(null, { sessionId: currentSessionId.value })` | 内核 |
| 1027 | `const sessionId = targetSessionId \|\| currentSessionId.value` | 内核 |
| 1054 | `sessionId,` | 内核 |
| 1260 | `.deleteSession({ sessionId: staleSessionId })` | 内核 |

### `src/renderer/src/views/library-common/components/LibraryAIPanel.vue` — 1 处 · 对话→改名

**依据**：`sessionId` prop 注释「用 `library-chat-` 打头」→ 透传给内嵌 `<Welcome>` = 对话 id。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 43 | `sessionId: string` | 对话→改名 |

### `src/renderer/src/views/Assistant/composables/useTeamBoard.ts` — 4 处 · 内核

**依据**：`const sessionId = agentSessionId.value` → `teamState`/`teamTaskReopen`/`teamEnd`；`team-board`/`released` 事件载荷同内核。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 46 | `const sessionId = agentSessionId.value` | 内核 |
| 61 | `const payload = args[0] as { sessionId?: string } \| undefined` | 内核 |
| 77 | `const sessionId = agentSessionId.value` | 内核 |
| 84 | `const sessionId = agentSessionId.value` | 内核 |

### `src/renderer/src/views/Assistant/composables/useRealtimeVoice.ts` — 2 处 · 内核

**依据**：`dispatchTask`/`resolveTarget` 的 `sessionId` 是模型报来的「会话号」→ 按 `item.agentSessionId` 比对 = 内核 id。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 1146 | `sessionId: string,` | 内核 |
| 1240 | `function resolveTarget(sessionId: string): VoiceSessionRef \| undefined {` | 内核 |

### `src/renderer/src/views/Assistant/composables/useSessionGoal.ts` — 3 处 · 内核

**依据**：`const sessionId = agentSessionId.value` → `goalState`/`goalEnd`；`goal-state` 事件载荷同内核。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 32 | `const sessionId = agentSessionId.value` | 内核 |
| 47 | `const payload = args[0] as { sessionId?: string } \| undefined` | 内核 |
| 61 | `const sessionId = agentSessionId.value` | 内核 |

### `src/renderer/src/views/Assistant/composables/transcriptRewind.ts` — 1 处 · 内核

**依据**：`truncate: (sessionId) => …` 回调被调时拿的是 `agentSessionId`（截内核 transcript）。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 56 | `truncate: (sessionId: string, keepUserTurns: number) => Promise<TruncateTranscriptResult>` | 内核 |

### `src/renderer/src/views/Assistant/composables/useSessionBrowser.ts` — 2 处 · 内核

**依据**：`useSessionBrowser(sessionId)` → `agentBrowserAPI.getState(id)`；广播 `state.sessionId` 同内核 id。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 7 | `sessionId: Readonly<Ref<string>>,` | 内核 |
| 68 | `sessionId?: string` | 内核 |

### `src/renderer/src/views/Assistant/components/SessionProjectChip.test.ts` — 2 处 · 对话→改名

**依据**：`mountChip(sessionId)`/`props:{sessionId}` fixture = 对话 id。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 31 | `function mountChip(sessionId: string, pendingProjectName = ''): ReturnType<typeof mount> {` | 对话→改名 |
| 33 | `props: { sessionId, pendingProjectName },` | 对话→改名 |

### `src/renderer/src/views/Assistant/composables/useSessionBrowser.test.ts` — 4 处 · 内核

**依据**：`sessionId` ref 与广播载荷 fixture = 内核 id。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 27 | `const sessionId = ref(id)` | 内核 |
| 93 | `listener({ sessionId: 'a', ...opened })` | 内核 |
| 96 | `listener({ sessionId: 'b', ...opened })` | 内核 |
| 109 | `listener({ sessionId: 'a', open: false, mode: 'embedded' })` | 内核 |

### `src/renderer/src/views/Assistant/composables/useChatFlow.ts` — 1 处 · 对话→改名

**依据**：`ensureSessionWithTitle(sessionId)` 包装层透传对话 id 到 chatSendPrimitives。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 120 | `function ensureSessionWithTitle(sessionId: string, messageText: string): void {` | 对话→改名 |

### `src/renderer/src/views/Assistant/components/SessionProjectChip.vue` — 2 处 · 对话→改名

**依据**：`sessionId?` prop 注释「当前会话 ID」→ `sessionById` = 界面 id。**已知改名点**（→ `chatSid`）。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 23 | `sessionId?: string` | 对话→改名 |
| 37 | `sessionId: '',` | 对话→改名 |

### `src/renderer/src/views/Assistant/components/TopNav.vue` — 1 处 · 对话→改名

**依据**：`sessionId?` prop 注释「当前会话 ID」→ 转给 SessionProjectChip/EditorStatusMonitor = 对话 id。**已知改名点**（→ `chatSid`）。

| 行 | 声明片段 | 类别 |
|---:|---|---|
| 67 | `sessionId?: string` | 对话→改名 |

## 5. 「已知会改」核对（spec §6 组）

| 点 | 现状 | 清单判定 |
|---|---|---|
| `TopNav` 的 `sessionId` prop | TopNav.vue:67 | 对话→改名 |
| `SessionProjectChip` 的 `sessionId` prop | SessionProjectChip.vue:23 | 对话→改名 |
| `EditorStatusMonitor` 的 `sessionId` prop | EditorStatusMonitor.vue:32 | 对话→改名 |
| `Welcome.vue` 自身 `sessionId` prop | Welcome.vue:484 | 对话→改名（值进 `sid.value` = 路由 `?sid=`） |
| `AgentBrowserPane` 的 `sessionId` prop | AgentBrowserPane.vue:213 | **内核 → 保留**（`:session-id` 不动） |

## 6. 附注（不在 403 行内，但 14 必须知道）

1. **`:session-id` 模板绑定**（prop 改名时要同步改，不在声明搜索里）：
   - 对话类（→ `:chat-sid`）：Welcome.vue:15（TopNav）、:87（SessionProjectChip）、TopNav.vue:15（EditorStatusMonitor）、:18（SessionProjectChip）、LibraryAIPanel.vue:449（内嵌 Welcome）、ChatWindow.vue:108（Welcome）、NotebookDetail.vue:2547（Welcome）、SnippetDetail.vue:165 / BlueprintEditor.vue:1610 / MaterialEditor.vue:819（LibraryAIPanel）。
   - 内核类（保留）：Welcome.vue:262 与 AgentBrowserWindow.vue:3（AgentBrowserPane）。
2. **同名邻居**（`sessionId` 搜索匹配不到，但同类歧义）：`activeSessionId`（ChatSessionList/SideMenu prop + 测试 = 对话；useAgentMode 里的 = 内核）、`selectedSessionIds`/`contextMenuSessionId`/`draggingSessionId`/`visibleSessionIds`（ChatSessionList = 对话）。`currentSessionId`/`runningSessionId`/`browserSessionId`/`elsewhereSessionId`/`targetSessionId`/`staleSessionId`/`processSessionId`/`submittedSessionId` 全是内核，`agentSessionId`/`sessionByAgentSessionId`/`getAgentSessionId`/`setAgentSessionId` 保留不动。
3. **复数形**：`chatWindowSync.ts` 的 `resendApprovals(sessionIds)`/`onRunsElsewhere(sessionIds)` 是内核 id 数组过 IPC，不动。
4. **函数名带 SessionId**：`voiceTaskSessionId`/`isVoiceTaskSessionId`（派生对话 id 工具）、`generateChatSessionId`（造对话 id）—— 参数已按清单判，函数名是否改由 14 定。
5. `ChatSessionList` 的 `(e:'open', sessionId)` emit 载荷名：对父组件只是位置参数，改名安全；连同内部函数参数一起改。

## 7. 复现

- 原文命中：`rg -n sessionId src/renderer src/shared`（787 行，存 `sessionid-hits-raw.txt`）。
- 声明过滤：`scripts/classify.mjs`（逐行判定 → `decl-list.txt`/`use-list.txt`）；等价单条 rg 命令见 §1（`declpat.txt` 存有图案，`rgmatches.txt` 存 `-o` 输出）。
- 本表生成：`scripts/build-checklist.mjs`（分类表 + decl-list → 本文件）。

## 8. 复合名补充审计（第三轮复审追加）

名字里带 `SessionId`、声明形态过滤搜不到的复合名，另跑一次检索逐个追值的来源：

```sh
rg -o -i "[A-Za-z0-9_\$-]*session[_-]?ids?[A-Za-z0-9_\$-]*" src/renderer src/shared
```

31 个不同的名字；去掉 §1 已归类的 `sessionId`，剩 **30 个**，归类如下（改名在 `16aa812` 完成）。

### 改名（11）——名字带 `SessionId`、值是对话 id

| 现名 | 新名 | 位置 |
|---|---|---|
| `activeSessionId`（prop） | `activeChatSid` | `layout/components/ChatSessionList.vue` |
| `activeSessionId`（computed）、`:active-session-id` | `activeChatSid`、`:active-chat-sid` | `layout/components/SideMenu.vue` |
| `draggingSessionId` | `draggingChatSid` | `ChatSessionList.vue` |
| `selectedSessionIds` | `selectedChatSids` | `ChatSessionList.vue` |
| `contextMenuSessionId` | `contextMenuChatSid` | `ChatSessionList.vue` |
| `visibleSessionIds` | `visibleChatSids` | `ChatSessionList.vue` |
| `sessionIdOfTab` | `chatSidOfTab` | `common/chatRoute.ts`、`layout/components/TabsHeader.vue` |
| `voiceTaskSessionId` | `voiceTaskChatSid` | `shared/voiceTaskSession.ts`、`voiceSessions.ts`、`voiceAssistant.ts` |
| `isVoiceTaskSessionId` | `isVoiceTaskChatSid` | 同上 |
| `SESSION_ID`（Ref）、`submittedSessionId` | `sid`、`chatSid` | `views/MiniChat/MiniChatWindow.vue` |
| `generateSessionId`（小窗内） | `generateMiniChatSid` | `MiniChatWindow.vue` |

### 内核（保留）

`agentSessionId` 一族（含 `get`/`set`、`sessionByAgentSessionId`、`agentSessionIdOf`）、`currentSessionId`、`runningSessionId`、
`browserSessionId`、`processSessionId`、`elsewhereSessionId`、`targetSessionId`、`staleSessionId`、
`sessionIdByChat`（以对话 id 为键、存内核 id 的 Map）、`sessionIds`（`reattach`、`resendApprovals`、`onRunsElsewhere`）、
`useAgentMode.ts` 里的局部 `activeSessionId`（`findActiveSessionByChatSid` 的返回值，指内核）、测试里的 `_sessionId`。

### `ChatSession` 一族（保留，spec 第 113–114、619–620 行）

`generateChatSessionId`、`VOICE_CHAT_SESSION_ID`（只在测试里断言它不存在）。

### 其他领域（保留）

`ImportProgressWidget.vue` 的 CSS 类 `session-id`（导入）；`AgentBrowserPane`/`AgentBrowserWindow` 的 `:session-id`
（内核，spec 第 423–424 行）。

改名后重跑同一条检索：上表 11 个旧名零命中（`useAgentMode.ts` 的局部 `activeSessionId` 除外），
剩下的都属于内核、`ChatSession` 一族或其他领域。
