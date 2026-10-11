# 01: 语言包之外的对话术语——要不要统一、统一到哪

Status: done（讨论已完结；落地状态见结论表）
Blocked by: None

## 结论

| 组 | 结论 | 去向 |
|---|---|---|
| ① 资产导入四条 | 做，改走 `errorKey` | 02 → 已落地，`chat-terminology` PR 第 5 组 |
| ① 续跑、插话被拒（含 3243） | 做，补错误码并改提示 | 03 → 已落地，第 5 组；其中两处行为修复（续跑判忙、保留按钮）拆出，另提 fix PR |
| ① `sessionExpired` 误读 | 做，只改两份语言包的值 | 已落地，`chat-terminology` PR 第 4 组 |
| ① 401 说成「登录」、整包上传外框 | 做，不进 PR | 04（needs-triage） |
| ① `voiceAssistant.ts:540` | 指内核 session id，不改 | — |
| ② ③ 面向模型的文字 | 做 | 应用内部分已随 `chat-terminology` PR 第 7 组落地（`agent-v3` 工具文字、`frontDesk`、`{error}` 报错、`resources/skills`）；其余条目（`packages/cli`、插件 E 类、② D 类以外遗留）另开「面向模型的文字」spec |
| ⑤ 带 session 的 key | 不做：都随内核层命名，按 spec 改名规则不在范围 | — |
| ⑥ 用户手册 | 按原定 | `chat-terminology` 合并后另开 spec |

术语见根目录 `CONTEXT.md`（对话、一轮、分支、侧边问一句、语音通话、小窗、session）。
前置工作：`.scratch/chat-terminology/spec.md`（其工单 01–18、02b 已全部实现）。

文中行号是 2026-10-06、`f263072` 时的快照，改动后会对不上，按文字搜索为准。

## 背景

`chat-terminology` 把「一个概念只有一个名字」落实到了**三份文案来源**：渲染层 `zh-CN.ts`、`en-US.ts` 与主进程 `src/main/i18n.ts`
的 `MAIN_STRINGS`，并用零容忍的术语守卫（`src/renderer/src/i18n/terminologyGuard.test.ts`）钉住。

它的范围是有意划窄的（spec「范围」与「Out of Scope」）：三份来源之外只改了审批按钮的点名文字、中断回复的标记，
以及分支、侧边问一句两条界面层链路上的注释。对那份 spec 做两轴评审时发现：按它的**核心诉求**（用户、模型、读代码的人
看到的都是同一套词），三份来源之外还有几处直接违背它。本工单负责决定这些要不要做、怎么做、分几步做。

## 要决定的问题

对下面每一组：做不做；做的话归入哪一份 spec（另起一份，还是并入 `website/` 手册那份后续 spec）；
是否赶在 `chat-terminology` 的 PR 之前。

## 盘点（按对核心诉求的影响排序）

### ① 主进程拼好、经 `{error}` 显示给用户的错误

最直接的矛盾：07 把网络库导入弹窗的外框从「这次会话」改成了「这次导入」，但 `{error}` 是主进程原样拼的。

**调用链核实**（`f263072`，逐条追到显示点；逐条明细已由 02、03 的正文接管，此处只留结论）：

- 到达界面的：资产导入四条（`ResumeImportService.ts` :140 / :601 / :834、`projectArchiveUpload.ts:522`）、
  `agent-v3:continue` 的 `会话 {id} 正在执行中`（`:2307`，当时不带 `code`）、`agent-v3:steer` 的
  「没有正在执行的会话」（`:3227`、`:3287`）。以上已由 02、03 落地。
- 不到达界面、不进本组的：`team-task-reopen` 的「这条会话不是团队模式」（唯一调用方只显示 `reopenFailed`）、
  `execute` 的 `SESSION_BUSY`（已映射为 `sessionBusy`）。
- `voiceAssistant.ts:540` 只进语音模型的工具结果，取值是内核 session id（`agentSessionId`），不改。
- 调试台（`AgentV3DebugPanel.vue`）把 execute / continue / steer 的原文直接打进日志；调试台按 spec Q3 本来就写 session，不在本组范围。

**核实中发现、影响方案选择的事实：**

- **主进程的字面量被渲染层当协议用。** `AssetManagement/index.vue:2525` 用正则 `/未找到可续传|没有找到这份 JSON 对应/` 匹配主进程错误原文，决定弹「无法继续导入」对话框还是 toast。它匹配的是 `ResumeImportService.ts:554`「未找到可续传…」和 `:171`「本机没有找到这份 JSON 对应…」，
  不含上表四条带「会话」的错误；但只要动这两句（包括整体改走 `errorKey`），就必须同步改正则，否则会悄悄走错分支，且没有测试会红。
- **英文界面显示的也是中文。** 上表到达界面的错误都只有中文，en-US 用户看到的是英文外框夹一句中文。这是 i18n 缺口，不是用词问题：只改字面量修不了，`errorKey` 能一起修。
- **资产导入的几个通道是登记过的直连。** `diagnostics:*` 在 `index.vue` 里直接 `window.electron.ipcRenderer.invoke`，靠的是 preload 的
  `RAW_REQUEST_CHANNELS` 白名单，没有类型和 `src/renderer/src/api/*` 包装（AGENTS.md §5 第 5 条的存量债）。加 `errorKey` 不必先补这几层：
  在现有返回形状上加字段即可，仓库里已有先例 `api/updater.ts` 与 `agent-v3:team-end`（`errorKey: 'running'`）。
- **同一句错误还要给模型。** `resume` / `abandon` 的 `error` 经 `box_manage` 原样进工具结果，522 经导入任务 `errorMessage` 进 `box` 的导入清单。
  改走 `errorKey` 是**加**一个字段给界面查语言包，`error` 仍要保留一句给模型读的话，不能直接换掉。
- **`sessionExpired` 说错了原因。** 续传返回 `status: 'expired'` 的唯一来源是 `isSessionNotFoundError`（`SESSION_NOT_FOUND` / "Session not found"），也就是服务端找不到这次**导入**的会话；界面却显示「登录状态已过期，请重新登录后再试」。07 把它从「登录会话已过期」改成「登录状态已过期」，坐实了这个误读，而重新登录救不回已被清掉的导入。
  复核：续传开头的 `checkV2ImportReadiness` 不走缓存地体检一次，401 在那里被单独接住、回 `failed`，所以出现 `expired` 时鉴权几秒前刚通过；
  `ImportSessionClient` 原样透传服务端 `errorCode`；对应测试标题即 "server session no longer exists"；HTTP 资产库靠访问码鉴权，没有「登录」可做。
  导入服务端源码不在本仓库，但结论不依赖它。
  **已落地（PR 第 4 组）**，只改两份语言包的值：
  中「服务器上已经找不到这次导入了（可能超时被清理），需要重新导入」；
  英 "The server no longer has this import (it may have timed out and been cleaned up). Import it again."
  同类（移交 04）：`importFeatureFlag.ts:162` 体检 401 的「登录状态已过期，请重新登录后再导入」对访问码库同样说成了「登录」。
- **外框也有错的。** 工程整包上传失败套的是 `assetLib.import.failed`「文件夹导入失败: {message}」（移交 04）。

**资产导入四条（140、601、834、522）已由 `02-asset-import-error-keys.md` 落地**，改走 `errorKey`，在 `chat-terminology` 的 PR 第 5 组。

**续跑（2307）与插话（3227、3243、3287）已由 `03-assistant-resume-steer-errors.md` 落地**，补错误码、改提示，与 02 同在第 5 组；
其中 `resumeAgent` 判忙改用 `isBusy` 与「接着跑」保留按钮两处行为修复与术语无关，拆出另提 fix PR（补丁在
`.scratch/chat-terminology/group5-resume-busy-behavior-fixes.patch`）。
3243 是插话工程对不上的拒绝，不含「会话」，但同一条链路、同样只有中文，并且提示写死了排队那条路的结局。

**`voiceAssistant.ts:540` 最终不改**：取值是内核 session id（`agentSessionId`），属指内核的用法。

### ② 语言包之外、发给模型的文字

**最终落地分两截**：`src/main`（agent-v3 工具文字、frontDesk、经 `{error}` 的报错等）、`src/shared`、
渲染层交给语音模型的文字与 `resources/skills/**` 里指对话的部分，已并入 `chat-terminology` PR 第 7 组（其工单 15，
一次性清理、不加守卫）。下表留作盘点底稿；**其余条目仍待「面向模型的文字」spec**：`packages/cli/src/tools.ts`、
E 类插件文案，以及第 7 组范围之外、`src/` 下给模型读的其他文字；⑥ 不与它合并。那份 spec 按 A / B / C 三类各开一张工单
（C 单独一张，写明改成「这一轮」）；E 类（插件）另开一张，等下次本来就要重打插件包时一起做。

用户故事 26 只管语言包里的提示词，但模型读到的大部分文字在工具定义与工具返回里；模型常把它们原样转述给用户。

复核方法：在 `src/main`、`src/shared`、渲染层语音组合式函数、`packages/cli/src`、`plugin/` 里取出全部含「会话 / 聊天」的非注释行，逐句读上下文。
**要用 `rg -a`**：`assetLock.ts` 含 NUL 字节，被当成二进制文件跳过，最初那份清单因此漏了它（表 A 的 `assetLock.ts`）。

按「这句话指什么、会不会到用户眼前」分五类，每类给出的是改法方向。

**A. 模型会转告用户（优先）**：注释或工具说明里写明要「照实转告」，或者这句话本来就是让用户照着做的。

| 位置 | 原文 | 改法方向 |
|---|---|---|
| `tools/adapted/project/projectTool.ts:2485`、`splitByRisk.ts:186` | 「会话被用户归到别的工程下…照实转告用户」 | 这条对话 |
| `tools/adapted/ue-system/sessionHealth.ts:311–312` | 「这条会话不该去动它们 —— 请用户…把会话移出该工程」 | 这条对话；「移出」要对上界面的实际操作名 |
| `core/editorScreenshotScope.ts:102` | 「这条会话里没有任何能拍编辑器画面的工具」 | 这条对话 |
| `core/assetLock.ts:448`（**新发现**） | 「以下资产正被**盒子里的另一条 AI 会话**修改中」 | 另一条对话。函数注释说明模型会把锁冲突原样转述给用户 |
| `packages/cli/src/tools.ts:215`（**新发现**） | 「那边有审批界面和会话上下文」 | 对话上下文。CLI 报错，人和外部 agent 都会看到 |

**B. 只给模型读，指的是对话**：模型偶尔会转述，但不是写给用户的。直接改成「对话」。

`taskVideo.ts:10,39,76,98`；`addNotebookSource.ts:106`；`box.ts:166,205`（「先 list 找到会话」「没有找到会话」）；`batchMove.ts:309`；
`sessionHealth.ts:296,438`（438「它不是聊天会话 id」为**新发现**）；`teamStatus.ts:115`；`deleteAssets.ts:382`（**新发现**）；
`setSessionProject.ts:83`（**新发现**）；`browser.ts:84,88,121,320`（**新发现**，浏览器页面跟着对话走）；`agentUndo.ts:104`（**新发现**「长会话」）；
`services/taskVideo/project.ts:83,95,96,158,178`；`ipc/realtimeVoice.ts:674`；`voiceConversationHistory.ts:46–47`；`voiceAssistant.ts:540`（自 ① 移来）；
`ai/realtime/frontDesk.ts:53,56,58,69,72,123,253,307,314,379,411,455,457`（共 13 行）。

**C. 实际指「一轮」，换成「对话」会说错**：锁在 `ipc/agentV3.ts` 每次执行的 `finally` 里释放；经验整理在 `released` 之后进行（`experience/scheduler.ts` 文件头）；
工具清单按轮现建（`createAgent.ts` 中「宿主每轮现建」）。这三处要改成「这一轮」，**不能替换成「对话」**：

| 位置 | 原文 | 应为 |
|---|---|---|
| `assetLock.ts:451` | 锁在那条会话结束时自动释放 | 那一轮结束时 |
| `experience/writeGuard.ts:24` | 会话结束后会自动整理 | 这一轮结束后 |
| `sessionHealth.ts:221` | 这一轮的工具清单是**会话开始时**定下来的 | 这一轮开始时 |

**D. 别的概念或标识符，保留**：`playtest.ts:455`、`ue-autoplay/autoplay.ts:149` 中「不接管别人的会话」（PIE 运行）；
`ue-cpp/probe.ts:133` 与插件 `UAL_CppCommands.cpp` 中的「编辑器会话」（一次编辑器进程）；`McpServerHost.ts`（MCP 协议的 session）；
`frontDesk.ts:123` 和 `box.ts:46` 中的参数名 `session` / `session_id`（周围句子可以改，参数名不动）；`toolSearch.ts:214,228`（检索同义词）；
`sessionModel.ts`、`createAgent.ts` 中的 `[AgentV3] 会话 …` 日志。
`addNotebookSource.ts:47`「外部会话里已有同名的就存进去」指外部 MCP 客户端的会话（`scope === 'all'`），保留。

**E. 用户可见，但在 UE 插件里（新发现，性质属 ①）**：`plugin/.../UAL_AssetLockState.cpp:69,74,225,433`，是锁定资产时编辑器里的提示和通知，
中文是「到盒子里停掉这条会话」，英文是 "stop the session in Unreal Box"。术语守卫管不到这里；改了要按 AGENTS.md §3 重打插件包（`verify:plugin`，发版时要求 5.0–5.8 全部是新包），成本和 ② 里其他几类不在一个量级。

**改动会牵连的测试与匹配**：
- `registry.test.ts`、`deleteAssets.test.ts`、`errorSignature.test.ts` 断言「另一条 AI 会话」；`assetLock.test.ts` 断言「不含」它。
- `experience/errorSignature.ts:34` 用正则 `/另一条 AI 会话|正被.*修改中/` 把锁冲突归为环境噪声，新句子必须仍能匹配。
- 其他断言原文的：`teamStatus.test.ts`（「别的会话占着」）、`frontDesk.test.ts`（5 处「聊天」）、`services/taskVideo/project.test.ts`（「不属于当前会话」）。

约束：

- `frontDesk.ts` 与 `voiceAssistant.ts` 里的「当前语音对话」是给实时语音模型的**协议标记**，四个文件成对保留
  （`chat-terminology` spec「Out of Scope」的「当前语音对话」一条）。只保留这个字面量，周围句子可以改。
- `src/main/agent-v3/tools/builtin/toolSearch.ts:214,228` 的「会话 / session」是**检索同义词**，用来让模型或用户说旧词时也能命中工具，**不该删**。
- 有些「会话」指的是内核 session（如 `box.ts` 读的是 transcript），要逐句判断：指对话写「对话」，指内核写 session。

### ③ 技能文本

`resources/skills/**` 9 个文件 17 处「会话 / 聊天」（spec「Out of Scope」的技能文本一条），`packages/cli/skills/**` 0 处。
理由同 ②：技能是模型的操作手册。改动须符合 `resources/skills/SKILL_STANDARD.md`（门禁 `verify:skills`）。分类同 ②：

- **A（会转告用户）**：`ue-skill-creator/SKILL.md:156`「不需要新建会话」、`:174`「如何在新会话触发」，两处都是告诉用户怎么操作 → 新对话。
- **B（指对话）**：`ue-skill-creator/SKILL.md:20,90`、`references/trigger-examples.md:55`；`task-to-video/SKILL.md:14,15,30,36,90` 与 `references/smoke-prompts.md:5`
  （「会话快照」要和 `taskVideo.ts` 的工具说明用同一个词）；`agent-complaint/SKILL.md:9`、`references/defect-types.md:97`；
  `ue-animation-retargeting/SKILL.md:18`、`references/measurement.md:17`（「会话中遇到的坑 / 会话教训」，指的是写技能时实测的那次对话）。
- **D（别的概念）**：`ue-skill-creator/SKILL.md:32`、`references/evaluation-and-debugging.md:14` 中的「引擎会话」（一次编辑器运行），保留，或改成「开一次引擎」。

### ④ 分支、侧边问一句两条界面层链路上的注释（已完成）

已并入 `chat-terminology` 工单 03（`f04d07b`），spec「范围」随之补上这一条。`src/` 下剩余的「会话分支」都在内核层
（preload、`api/agentV3.ts`、`ipc/agentV3.ts`、`transcriptStore.ts`），按 spec 保留内核层命名。本工单不再处理。

### ⑤ 以概念命名、仍带 session 的 i18n key

值已改对、名未改：`assistant.agentMode.sessionBusy`、`assistant.agentMode.sessionModelUnavailable`、`assistant.branch.noAgentSession`、
`ai.sessionTitleSystemPrompt`、`ai.sessionRenameSystemPrompt`。

复核：spec「i18n key 改名」已经定了规则 —— 只改以界面概念命名的 key（用户故事 19），其余 key 名是代码标识符。这五个都是跟着内核层命名起的：
`sessionBusy` 对应错误码 `SESSION_BUSY`（`agentControlHandlers.ts` 的映射表）；`sessionModelUnavailable` 对应会话绑定模型（`sessionModel.ts`）；
`noAgentSession` 说的是没有内核 session 所以不能分支；两个 prompt key 由 `requestSessionTitle` 读取。值都已经受守卫保护。

### ⑥ 用户手册 `website/`

21 个文件 88 处（`f263072` 复核；比原来多出的是截图清单 `website/public/shots/manifest.json` 的一条说明「AI 会话首屏」），
含原样引用、已指向不存在按钮的界面文字（清单见 `.scratch/chat-terminology/decisions.md` 末尾）。
`chat-terminology` 已定合并后另开 spec；本工单只需决定 ②③ 是否与它合并成一份。

## 明确不在讨论范围

- `src/` 下其余约 2500 处「会话」：不在用户、模型、改名模块任何一条路径上。
- 内核层命名与 `[AgentV3] 会话 ${sessionId}` 这类日志（要改也只是改成 session，另一件事）。
- 测试数据里的标题、已存下的旧默认标题、「当前语音对话」标记本身、`toolSearch` 同义词。
- 指别的概念的「会话」：`McpServerHost.ts` 回给外部 MCP 客户端的报错（MCP 协议的 session）、`ue-cpp/probe.ts` 的「编辑器会话」（一次编辑器进程）。
- 「项目 / 工程」混用等 `chat-terminology` Out of Scope 已列的其他术语问题。

## 讨论产出

- [x] ①②③⑤⑥ 每组的结论：做 / 不做 / 推迟，附理由
- [x] 要做的组归入哪份 spec，是否赶在 `chat-terminology` PR 之前
- [x] ① 逐条核实哪些错误真的到达界面（见 ① 的结论）
- [x] ① 定改字面量还是改 `errorKey`，以及核实中发现的 `sessionExpired` 误读、续跑判忙用错函数要不要一并处理
- [x] 若有组要做，写出 spec（或可执行工单）：02、03 已落地（`chat-terminology` PR 第 5 组），04 为 `needs-triage`；②③ 与 ⑥ 的 spec 待开
