# 对话术语统一：最终决定

**这是决策记录，不是实现依据。** 实现依据是同目录 `spec.md` 与根目录 `CONTEXT.md`；
两者与本文件不一致时，以它们为准。本文件只记每项决定的最终形态，被推翻的中间方案不保留；
需要沿革时查 git 历史。
文中的行号（如「zh L7127」）是 2026-10-04 的快照，改动后会对不上，按 key 查找。

来源：2026-10-04 的术语讨论（Q1–Q22）及后续复核。

## 目标

一个概念只能有一个名字，中英各自唯一且互相对应。

## 范围（Q1）

- 改用户可见文案（zh-CN + en-US）和 i18n key。文案有三处来源：渲染层两份 locale，
  以及主进程的 `src/main/i18n.ts`（`MAIN_STRINGS`）。
- 代码标识符按概念有选择地改（Q7、Q9 与「代码改名」），不做全面改名；词汇表注明代码名。
- `ChatSession` 不改：存储键 `'chat-sessions'` 下有用户数据。
- 内核层的 session 命名不碰。

## 逐条决定

- **Q2 对话**：中文只写「对话」，英文只写 Chat。「会话、聊天；Conversation、Session、Thread」不用。
  别的概念的英文名不得含 "Chat"。
- **Q3 session**：只出现在面向开发者的界面（调试台 `agentV3Debug.*`），中英都写不翻译的 "session"。
  用户文案里不出现：`deleteTranscriptFailed` 只说用户能懂的后果（「对话已移除，但部分历史没能清理」）；
  `assetLock.unknownSession` 改为「另一条对话 / another chat」（key 改 `unknownChat`）。
- **Q4 AI 助手以外的「会话」**：全部改掉，让 zh-CN 中「会话」为零处。
  | key | 中文 | 英文 |
  |---|---|---|
  | `sessionExpired` | 服务器上已经找不到这次导入了（可能超时被清理），需要重新导入 | The server no longer has this import (it may have timed out and been cleaned up). Import it again. |
  | `abandonConfirmContent` | 「这次会话」→「这次导入」 | "this session" → "this import" |
  | `resumeNotFoundContent` | 未找到可以继续的导入：{error} | No resumable import found: {error} |
  | `stages.createSession` | 开始导入 | Starting import |
  `sessionExpired` 是改正意思而不只是换词：它只在服务器报 `SESSION_NOT_FOUND`（这次导入已被清理）时出现，不是登录过期。
  不用「导入任务」：它已是本地资产库后台导入的名字。
  英文侧另有几处登录态的 session 一并改成 sign-in 说法：失效写 "You've been signed out"，恢复写
  "You're signed in again. Please try again."
- **Q5 分支**：分支出来的是普通对话；动作统一叫「分支」，「会话分支」「对话分支」不用。
  `branch.failed` →「分支失败 / Failed to branch」；`branch.success` →「已从这条回复分出一条新对话，之后的消息没有带过去 /
  Branched into a new chat from this reply. Later messages weren't copied.」；`branch.noAgentSession` →「这类对话不支持分支 /
  Branching isn't available for this kind of chat」（只有非 Agent 对话走到这里）。
- **Q6 侧边问一句不是对话**：关窗后存进侧边栏是 bug，与术语无关，本任务不处理（尚未建单）。
- **Q7 侧边问一句**：中文「侧边问一句」，英文 "Side question"（按钮仍为 "Ask on the side"）。
  `sideQuestion.failed` →「没能打开『侧边问一句』/ Could not open the side question」（功能名加引号）；
  `noContext` 英文 "This session" → "This chat"。
  i18n key `sideChat` → `sideQuestion`；代码一并改名（`sideChat.ts` → `sideQuestion.ts`、
  `SideChatContext` → `SideQuestionContext`、IPC 通道 side-chat → side-question 等，完整表见 spec）。
- **Q8 主对话**：保留「主对话 / main chat」；en `sideContext.empty` 里 "the main conversation" → "the main chat"。
- **Q9 fork**：按层区分。内核层的 fork 不动（`forkTranscript`、`agent-v3:fork-session`、`agentV3API.forkSession`）；
  对话层改成 branch（`sessionFork.ts` → `chatBranch.ts`、`forkSession()` → `branchChat()`、`@fork` → `@branch` 等）。
  `agent-v3:fork-for-side-chat` → `agent-v3:fork-for-side-question`。
- **Q10 AI 助手入口名**：`menu.aiAssistant` 中文「AI会话」→「AI 助手」，英文 "AI Assistant" 不变。
  `menu.aiChat` 保留：`tabs.ts` 的旧标签迁移表已把老用户的标签标题写成这串 key，存在用户本地，不删。
- **Q11 新建对话按钮**：中文统一「新对话」，英文统一 "New chat"（`menu.newChat`、`tabs.newChat`、
  `chatSidebar.newChat`、主进程 `tray.newChat`）。`chatSidebar.newChatInProject` →「在这个工程下新建对话 /
  New chat in this project」（「工程」不在本次范围）。
- **Q12 未命名对话**：四处默认标题统一为「未命名对话 / Untitled chat」，四个 key 合并为 `assistant.chatFlow.unnamedChat`。
  自动起名靠「标题等于默认标题」判断未命名，换默认标题会让老用户存下的空对话不再自动起名——新增
  `isUntitledChatTitle`，把旧默认标题（`AI会话`、`Unnamed Session`、`快速对话`、`Quick chat`）与空标题也认作未命名。
  有意的行为变化：已存下的旧默认标题不改写，回到那条对话发下一条消息时会以那条消息自动起名（见 spec「旧默认标题仍算『未命名』」一节）。
- **Q13 小窗**：对用户叫「小窗 / Mini window」，代码名 MiniChat 不改（用户配置里有 `miniChatPersistEnabled` 等持久化键）。
  被 `MINI_CHAT_SETTINGS_ENABLED` 隐藏的 4 条设置文案现在就改（`profile.menu.miniChat`、`profile.miniChat.title`、
  `profile.miniChat.persist`、`profile.miniChat.persistDesc`），key 改为 `miniWindow`。
- **Q14 消息与一轮**：一个气泡叫「消息 / Message」，一问一答叫「一轮 / Turn」。「对话内容」作普通说法，不算术语。
  `smartNameEmpty` →「这条对话还没有消息，起不了名」；统计页 →「轮次 / Turns」；标题生成提示词里的 "exchange" → "turn"。
- **Q16 嵌入页面的对话**：知识库、蓝图库、材质库里嵌的也都是「对话」；是否 Agent 驱动不是概念区别。
- **Q17 审批按钮**：`allowForSession` → `allowForChat`，文案「本对话内都允许 / Allow for this chat」。
  不写「始终」：放行名单是主进程内存里按内核 session 记的，重启、分支、切到 Ask 模式都会失效。
  调试台 `agentV3Debug.approveAlways` 按 Q3 写 session。
- **Q18 退出确认**：「AI 还有 {count} 项操作在进行，退出会中断它们。」/
  "The AI still has {count} operation(s) in progress — quitting will interrupt them."
  {count} 数的是正在运行的内核 session（含侧边问一句与调试台 session），所以不说「对话」；也不用「任务」，
  免得用户以为导入也算。
- **Q19 语音通话**：「语音通话 / Voice call」（如「开始语音通话」「语音通话：{name}」/ "Start voice call"）。
  「通话」「挂断」「语音助手 / Voice assistant」不变。给实时语音模型的「当前语音对话」标记原样保留——
  `voiceAssistant.ts` 交给 `listSessions` 的标签与 `frontDesk.ts` 的 `VOICE_INSTRUCTIONS` 靠这串字面量对上，
  是给模型的协议标记，四个文件成对不动。
- **Q20 守卫范围**：查三份文案来源的**所有字符串值**（含发给模型的提示词）；不查注释。
  白名单是 `Map<key, 放行的词[]>`，按精确 key 匹配、按禁用词条目比较（放行 "session" 条目时 "Session ID" 不命中）；
  只放调试台三个 key。
- **Q21 禁用词清单**：写在守卫测试里，每条带替换建议；顶部注明来源是 `CONTEXT.md` 的 _Avoid_、两处同步。
  不让守卫直接解析 `CONTEXT.md`。同步提醒只写在词表注释和 `CONTEXT.md` 开头，不进失败信息
  （失败信息的读者是刚写错文案的人）。
- **Q22 守卫类型**：零容忍、不加基线。形式是与语言包守卫同类的 vitest 测试
  （`src/renderer/src/i18n/terminologyGuard.test.ts`；`tests/` 下只有 `material-library/` 进渲染层类型检查，
  所以守卫放在 i18n 目录）。词表按工单逐步加入，任何时刻零命中。
  - 英文 `session` / `sessions` 保持整词零容忍：上游 2026-04..10-04 新增英文文案里含 session 的约 33 行，
    全是对话 / 登录 / 导入 / 语音 / 调试台用法，只禁固定搭配会漏掉约一半指对话的写法。
    替换建议按意思列全（对话 → chat；登录 → sign-in / signed out；网络库导入 → import）。
    确有正当用法时由提交者在 PR 里说明、维护者决定是否破例；白名单仍是调试台三个 key。

## 落地与切分（最终形态）

- **i18n key 改名收窄为明确清单**（见 spec 表）：只改以界面概念命名的 key；以组件命名的命名空间
  （`miniChatWindow`、`miniSensitiveConfirm`）不改。完成标准双清零：引用清零（旧 key 完整路径在 `src/` 零命中，
  `retiredKeys.test.ts` 不计；`labelKey`、`titleKey`、路由 `title` 等非 `t()` 引用由 `settingsCopy.test.ts`、
  `routeTitles.test.ts` 兜住）＋ 定义清零（`retiredKeys.test.ts` 断言两份语言包里取值为 `undefined`）。
- **02b 单独成组**：默认标题改值、四个 key 合并与 `isUntitledChatTitle` 必须同一次提交，分开会让老对话不再自动起名；
  它也是唯一改逻辑、带有意行为变化的一块，要能单独审、单独回退。
- **中断回复的标记**：`interruptedTypingContent` / `markTypingInterrupted` 加 `label` 参数，store 不引 i18n；
  文案由 `initAgentReattach` 传 `assistant.chat.replyInterrupted`「回复已中断 / Reply interrupted」——只陈述事实、
  不写原因（代码只知道生成已不在进行，写错的原因会永久留在历史里）。已存进历史消息的旧标记不改写。
- **界面层代码改名的取舍**：03/04 的改名保留——`Welcome.vue` 同一调用里并排着界面层与内核层两个 `forkSession`，
  `sideChat` 这个名字和「它不是一条对话」正相反。收益持续、代价一次性；类型检查兜住除模板事件以外的改名，
  兜不住的事件连线由新增的连线测试补（没开 `strictTemplates`）。
  顺带把两条界面层链路上指对话的注释一并改（范围按概念划：两个改名模块及测试、改名标识符的文档注释、
  点名新标识符的注释、`copySessionMessages`；内核层注释不在此列）。
- **对话 id 改名（第 6 组）**：渲染层与 shared 里**指对话的 `sessionId`**（变量、参数、字段、prop、事件载荷）
  改为 `chatSid`。不改：`sid`（一律指对话）、指内核的 `sessionId`（与 IPC 载荷一致）、网络库导入的 `sessionId`
  （领域隔离）、对象名（`ChatSession` 一族、`ReattachedSession`、`adoptRunningSession`、语音连接的局部 `session`）、
  持久化字段与 IPC 载荷字段。`CONTEXT.md` 写明命名规则与 IPC 例外。排查由临时品牌类型（`ChatSid` / `AgentSessionId`）
  辅助、类型检查给出接缝清单，品牌类型不进提交；留在代码里防传错另开 PR。
- **第 5 组拆分**：错误码与按码选文案留在本 PR；两处与术语无关的行为修复（续跑判忙 `isStreaming` → `isBusy`、
  点「接着跑」忙时保留按钮）拆出，连同测试存成补丁 `.scratch/chat-terminology/group5-resume-busy-behavior-fixes.patch`，另提 fix PR
  （基于术语 PR，`resumeAgent` 被第 5 组改写过）。
- **给模型读的文字（第 7 组）**：`agent-v3` 工具文字、`frontDesk` 语音指令、经 `{error}` 显示的报错、
  `resources/skills/**` 里指对话的「会话 / 聊天」改「对话」；逐句改、不全局替换，提到 `session` / `session_id`
  参数处写明取值来自哪个工具的返回（取值是内核 session id）。例外与做法见 spec。
- **边界注释（第 8 组）**：渲染层、preload、shared 的全部注释改同一套词；主进程不整体改写，`CONTEXT.md` 写约定
  （主进程注释里的「会话」指内核 session；`capabilities/mcp/` 下指 MCP 外部会话），指对话的改为「对话」。
- **文案复评**：本 PR 改过或新增的文案按「术语正确 > 准确（与代码行为一致）> 原生自然 > 改动最小」重评，
  结论即 spec「文案复评修正」表。
- **PR 切分（最终 8 组）**：1 = 01–02；2 = 02b；3 = 03–04；4 = 05–08；5 = 错误码；6 = id 改名；7 = 模型文字；
  8 = 边界注释。文案修正并入各自的组。分支从 `upstream/main` 切，`CONTEXT.md` 随各组带入；
  每组 `verify:changed`，分支上跑一次完整 `pnpm verify`。
  另提三个后续 PR：行为修复 fix PR（基于本 PR）、用户手册 `website/` PR（紧接本 PR，期间手册会指向已不存在的按钮）、
  品牌类型 PR（以后）。「给模型读的文字守卫」也另开 PR（第 7 组是一次性清理、会持续回退，实测约每周 4 行）。

## 未决

（无）

## 顺带记下、不在本任务范围

- 本地「导入任务」与网络库「这次导入」是不是同一个概念。
- 「项目」与「工程」混用：`CONTEXT.md` 定的是「项目 (Project)」，但对话侧边栏里同时有「项目」「UE 工程」
  「归入工程」「在这个工程下……」。
- 侧边问一句横幅改为显示来源对话标题（`SideQuestionContext.sourceTitle`）。
- 团队模式里的「一轮」（en "round"，制作人推进一次）与对话里的「一轮」(Turn) 同名。
- `CONTEXT.md` 里叫「笔记本 (Notebook)」，界面上叫「知识库」（如 `menu.notebooks`、「与知识库对话」）。
- 用户手册 `website/guide/` 跟着改（另开 spec）。原样引用界面文字、改完会指向不存在按钮的有：
  「本对话内都允许」之前的「本次会话都允许」（`agent-loop.md`、`capabilities.md` 两处、`tools-and-skills.md` 两处）、
  「开始 / 结束语音对话」（`voice.md` 两处）、「语音对话不可用」（`ai-setup.md`）、「归档聊天」（`interface.md` 两处）、
  功能名 MiniChat（`spotlight.md` 的标题与 `#minichat` 锚点、`settings.md`、`shortcuts.md`）。
  另有正文里指对话的「会话 / 聊天」（如 `assistant.md`）；改标题要同步站内锚点；截图（`website/public/shots/`）里是旧文字。
  2026-10-05 的快照，按文字搜索为准。
