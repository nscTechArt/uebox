# Spec：对话术语统一

Status: implemented

实现依据是本 spec 与根目录 `CONTEXT.md`（术语定义：对话、消息、一轮、分支、侧边问一句、语音通话、小窗、session）。
工单 01–18、02b 全部完成：实现落在本地 `main`，PR 分支 `feat/chat-terminology`（基于 `upstream/main`）按下方
「提交 PR」的 8 组组装完毕，每组 `verify:changed` 与整体 `pnpm verify` 全绿，PR 描述草稿在同目录 `pr-description.md`，
待人批准推送。工单 09–18 各自注明它依据的 spec 小节。
只在需要追溯某个决定的理由时读同目录 `decisions.md`；两者不一致时以本 spec 为准。

## Problem Statement

同一个概念在界面上有好几个名字，中英两边还各漂各的。打开 AI 助手的侧边栏，标题写「对话」，按钮写「新会话」，
右键菜单写「归档聊天」，设置里写「归档对话」；标签页标题是「AI会话」，英文却是 "AI Assistant"；
中文「新会话」对应的英文是 "New chat"，另一处「新对话」对应的却是 "New AI Chat"。

用户每看到一个新词，都要判断「这是不是另一种东西」。贡献者和读代码的 agent 也一样：写新文案时照着哪个抄都有可能，
漂移只会越来越多。更糟的是，有几处换词背后其实是不同的概念（内核 session、侧边问一句、语音通话、登录状态、
网络库导入），混用同一个词让用户也分不清它们。

代码这一侧是同一个问题。渲染层里 `sessionId` 一名三义：有时是对话 id，有时是内核 session id，有时是网络库导入的 id；
`Welcome.vue` 同一个模板里，两个子组件的 `:session-id` 一个传对话 id、一个传内核 id。读代码的 agent 只能逐处追到源头
才知道手上是哪种 id，传错了类型检查也不报（都是 string）。应用内模型读到的工具说明、语音指令里也还写着「会话」，
而模型会把这些说法原样转告用户。

## 核心诉求

同一套术语，让界面与代码都说得清。界面文案统一与必要的代码改动同为核心诉求、不分主次，二者共用 `CONTEXT.md` 一份词汇表、
相辅相成：界面上叫「对话」的东西，代码里也用对话的名字；代码里换了名字的边界，界面上也不再混用。

## Solution

一个概念只有一个名字，中英各自唯一、一一对应：

- 侧边栏里的一条（以及嵌在知识库、蓝图库、材质库页面里的那条）统一叫「对话 / Chat」。
- 相邻概念各有自己的名字，且英文名里都不含 "Chat"：侧边问一句 / Side question、语音通话 / Voice call、
  小窗 / Mini window；分支 / Branch 只是动作，分出来的仍是一条对话。
- 内核那一层叫 session，不翻译，只出现在面向开发者的调试台。
- 与「对话」无关的地方用准确的说法：登录状态、这次导入、AI 正在进行的操作。
- 每条改过或新增的文案按「术语正确 > 准确（与代码行为一致）> 原生自然 > 改动最小」评定，不只是换词。
- 主进程拼好、经错误码选文案显示给用户的报错，也不再夹带旧说法（第 5 组）。
- 侧边问一句和分支在代码里也改成同一个名字，让读代码的人不必再对照。
- 渲染层与 shared 里指对话的 `sessionId` 改叫 `chatSid`，名字本身说明它是哪一层的 id；`CONTEXT.md` 写明 id 的命名规则（第 6 组）。
- 应用内模型读的工具说明、语音指令、技能文本里指对话的「会话 / 聊天」改为「对话」（第 7 组）。
- 渲染层、preload、shared 的注释用同一套词；主进程注释写一条约定，指对话的一并改（第 8 组）。
- 一条零容忍的术语守卫：文案里一出现禁用词，测试变红，并给出该换成的词。

## User Stories

具体字符串只写在下面「文案表」里，这里只写需求。

1. 作为中文用户，我希望 AI 助手里所有指对话的地方都用同一个词，这样我不必猜「会话」「聊天」是不是别的东西。
2. 作为英文用户，我希望所有指对话的地方都写 chat，这样我不必猜 session、conversation 是不是别的东西。
3. 作为在中英文之间切换界面的用户，我希望同一处文案在两种语言里说的是同一件事，这样切换后我还能认出它。
4. 作为用户，我希望所有新建对话的入口写法一致，这样我知道它们做的是同一件事。
5. 作为用户，我希望还没起名的对话有一个不会和「新建」按钮混淆的默认标题，从小窗存进来的也一样，这样我不会以为那是另一种对话。
6. 作为用户，我希望 AI 助手的标签页标题和模块名、小窗标题一致。
7. 作为用户，我希望提示里只说我能理解的后果，不出现「内核」「Agent 会话」这类实现术语。
8. 作为用户，我希望分支相关的提示只用一个词，分出来的就是一条普通对话。
9. 作为用户，我希望侧边问一句的文案把它说成一次性的提问，英文名里也没有 chat，这样我明白它问完就没了；横幅对被借上下文的那条用同一个称呼。
10. 作为用户，我希望审批放行的按钮讲清放行范围就是这一条对话，且不承诺它做不到的「始终」（放行名单重启、分支、切到 Ask 模式都会失效），措辞和同一确认框里的其他按钮一样正式，主窗口和小窗写法相同。
11. 作为用户，我希望退出时的确认告诉我 AI 还有几项操作在进行、退出会中断它们；界面接不住、改用系统原生框时，看到的也是同一句话。
12. 作为用户，我希望和语音助手的实时语音交流与「开始」「挂断」「最长 30 分钟」是一套说法，不和「对话」混成一个词。
13. 作为用户，我希望登录过期、网络库导入的提示用准确的说法，不借用对话的词。
14. 作为用户，我希望统计页按「轮」计数，英文不出现 conversation。
15. 作为用户，我希望小窗设置将来重新开放时，叫的是「小窗」而不是带 Chat 的 MiniChat。
16. 作为开发者，我希望调试台里的内核概念写不翻译的 session，这样我知道它指内核，不是界面上的对话。
17. 作为贡献者，我希望写新文案时有一个测试告诉我哪些词不能用、该换成什么，这样我不用先读完整份词汇表。
18. 作为贡献者，我希望守卫的报错给出来源、key、命中词与替换建议；插值占位符不算命中；例外只限调试台那三个 key。
19. 作为贡献者，我希望以概念命名的 key（未命名、未知、放行范围、清空、侧边问一句、语音通话绑定、小窗设置）用词汇表里的英文名，这样照着 key 写的新文案不会把旧词带回来。
20. 作为读代码的 agent，我希望侧边问一句在代码里也叫 side question，这样我不用判断 side chat 和 side question 是不是同一个东西。
21. 作为读代码的 agent，我希望界面那层的分支在代码里叫 branch，内核复制 session 的那一步仍叫 fork，这样名字本身就说明了它在哪一层。
22. 作为读代码的 agent，我希望 `CONTEXT.md` 注明各概念的代码名，这样不改名的地方我也能对上号。
23. 作为维护者，我希望存储键和内核命名保持原样，已有用户存下的、还没起名的对话照样在第一条消息后自动起名。
24. 作为维护者，我希望守卫零容忍、不带基线，这样不会多一个需要多会话协调的共享基线文件。
25. 作为维护者，我希望改 `CONTEXT.md` 的 _Avoid_ 时有提示要同步守卫的禁用词表，这样两处不会慢慢脱节。
26. 作为模型（提示词的读者），我希望语言包里发给我的提示词和界面用同一套词。
27. 作为用户，我希望每条提示说的和实际发生的一致：分支说清分出的是一条新对话、之后的消息没带过去；插话被拒说清它去了哪里。
28. 作为英文用户，我希望英文提示读起来是地道的英文，而不是中文句式的直译（如登录失效写 "You've been signed out"）。
29. 作为用户，我希望 AI 转告我的话（工程健康检查、派活、语音指令）也说「对话」，不说「会话」，因为模型会照抄它读到的说法。
30. 作为用户，我希望续跑、插话被拒、资产导入失败时，看到的提示不夹带「会话 <uuid>」这类原始报错。
31. 作为读代码的 agent，我希望渲染层里一看名字就知道是哪种 id：`sid` / `chatSid` 是对话，`sessionId` / `agentSessionId` 是内核 session，网络库导入的 `sessionId` 属导入领域。
32. 作为读代码的 agent，我希望组件 prop 也按 id 的层级命名，这样 `Welcome.vue` 里传给两个子组件的不再都叫 `session-id`。
33. 作为读代码的 agent，我希望 `CONTEXT.md` 写明 id 的命名规则与主进程注释里「会话」的含义，这样不改名的地方我也能读对。
34. 作为读代码的 agent，我希望渲染层、preload、shared 的注释与代码名用同一套词，不在注释里再说「会话」。
35. 作为维护者，我希望 id 改名不改持久化字段、不改 IPC 载荷，这样升级后已存的数据和主进程照常工作。
36. 作为贡献者，我希望守卫报 `session` 时按意思给出替换写法（对话写 chat、登录写 sign-in / signed out、网络库导入写 import），而不是引导我去加白名单。
37. 作为维护者，我希望与术语无关的行为修复不混在术语 PR 里，这样两者各自能审、能退。
38. 作为维护者，我希望 PR 按组提交、每组单独可审，新增的改名、模型文字、注释各成一组。

## Implementation Decisions

### 范围

判断一项改动是否属于本 PR 的标准：它是让界面或代码的术语准确、一致所必需的，或是防止术语回退的。
改变与术语无关的行为的改动，另开 PR（见 Out of Scope）。

- 三处文案来源：渲染层 `src/renderer/src/i18n/locales/zh-CN.ts`、`en-US.ts`，主进程 `src/main/i18n.ts`（`MAIN_STRINGS`）。
  发给模型的提示词也在语言包里，一并改。三份来源之外：点名审批按钮的文字、中断回复的标记（02、07，见同名两节）；
  主进程返回给渲染层、原先原样显示的报错（第 5 组，见「用户可见的错误改走错误码」）；给应用内模型读的文字（第 7 组，见同名一节）。
- 三份文案来源里的注释，指对话的「会话 / 聊天」改为「对话」、指对话的 session / conversation 改为 chat（08）；
  解释历史的注释保留旧名（如「原来叫 side chat」）。
- 代码标识符按概念有选择地改，不做全面改名。改的有四处：侧边问一句（04）、界面层的分支（03）、
  审批按钮在界面层的处理函数与样式类（02，见「点名审批按钮的文字」）、渲染层与 shared 里指对话的 `sessionId`（第 6 组，见「代码改名：对话 id」）。
  代码注释里点名了被改标识符、文件或通道的，随改名一起改。
- 渲染层、preload、shared 的注释（第 8 组，见「边界文档注释」一节）。
- 分支、侧边问一句两条界面层链路上的注释（03、04）：两个改名模块及其测试、改名标识符的文档注释、点名新标识符的注释、
  分支直接调用的 `copySessionMessages`。其中指对话的「会话 / 聊天」改为「对话」，「会话分支 / 分叉会话」改为「分支」，
  指内核的写「内核 session」；测试数据里的标题照下文 Testing Decisions 保持原样。内核层（preload、`api/agentV3.ts`、
  `ipc/agentV3.ts`、`transcriptStore.ts` 等）与其余代码注释不在此列。
- 保持原样：`ChatSession` 及其 store（存储键下有用户数据）、MiniChat 代码名（用户配置里有持久化键）、
  内核层的 session 命名与内核复制动作 fork、退出确认的计数口径（`countActiveSessionOperations`，含侧边问一句与调试台的 session）；
  不做数据迁移。`ChatSession` 一族不改名为 `Chat`（约 5400 处，冲突面与审阅成本过高）；不引入 `chatId`（`src/` 下零处，`chatSid` 已有约 440 处）。

### 文案评定标准

本 PR 改过或新增的每条文案（三份来源、中英两侧，`ce37b91..HEAD` 约 160 条）按以下优先级评定，前一条不满足时不看后一条：

1. **术语正确**：用 `CONTEXT.md` 的词。
2. **准确**：说的与代码实际行为一致，不承诺做不到的事。
3. **原生自然**：中文、英文各自读起来是母语写法，不互相直译。
4. **改动最小**：前三条都满足时，尽量少改。

本 PR 没碰过的文案不在复评范围内。

### 文案复评修正

复评结论的唯一出处。每个 key 中英两侧等于本表目标值是完成标准；单元格写法同下文「文案表」。
本表的 key 已从文案表里移出；表外的条目经复评保持现值（`chatSidebar.initialFallback`「对 / C」、"Clear this chat?"、中文全角逗号是明确核过的）。

| 组 | key | 中文 | 英文 |
|---|---|---|---|
| 1 | `assistant.sensitiveAction.allowForChat`、`miniSensitiveConfirm.actions.allowForChat`（工单 10，见「点名审批按钮的文字」） | 本对话内都允许 | Allow for this chat |
| 1 | `mcp.epicSetup.readyHint` | — | The engine service is running; the box will connect automatically the next time you chat. |
| 1 | `assistant.topNav.exportImagePreparing` | — | Exporting chat as image… |
| 3 | `assistant.branch.success` | 已从这条回复分出一条新对话，之后的消息没有带过去 | Branched into a new chat from this reply. Later messages weren't copied. |
| 3 | `assistant.branch.noAgentSession`（只有非 Agent 对话走到这里） | 这类对话不支持分支 | Branching isn't available for this kind of chat |
| 3 | `assistant.sideQuestion.failed`（功能名加引号，不改名） | 没能打开「侧边问一句」 | Could not open the side question |
| 4 | `aiProvider.model.realtimeVoiceHint` | 保存后，下次开始语音通话时生效；当前正在进行的通话不会中途换音色。 | Takes effect the next time you start a voice call. A call already in progress keeps its current voice. |
| 4 | `catalogLibrary.errors.signed-out` | — | You've been signed out. Sign in again. |
| 4 | `catalogLibrary.view.signedOut` | — | You've been signed out of the server library. Sign in again to continue. |
| 4 | `assistant.agentMode.tokenRefreshedRetry`（登录已恢复） | — | You're signed in again. Please try again. |
| 5 | `assistantInputComposer.steerProjectMismatchRestored` | 这条插话是在「{snapshotProject}」下发的，正在进行的这一轮在「{runProject}」上，没有送进去，内容已放回输入框 | This message was sent from "{snapshotProject}", but the current turn is working in "{runProject}". It wasn't added and is back in the input box. |
| 5 | `assistantInputComposer.steerProjectMismatchQueued` | 这条插话是在「{snapshotProject}」下发的，正在进行的这一轮在「{runProject}」上。这一轮结束后，它会按「{snapshotProject}」发出 | This message was sent from "{snapshotProject}", but the current turn is working in "{runProject}". It will run on "{snapshotProject}" after this turn finishes. |
| 5 | `assistantInputComposer.steerTurnEndedQueued` | 这一轮刚好结束了，插话没送进去，会按排队顺序发出 | This turn just finished, so the message wasn't added. It will be sent in queue order. |
| 5 | `assistant.agentMode.resumeFailed` | 没能接着跑：{reason} | — |

「组」决定修正提交并入 PR 的哪一组（见「提交 PR」）：同组的修正放一个提交，不同组分开提交。

### 文案替换规则

写新文案、以及文案表没写到的新增字符串，照这两条：

1. **对话**：中文指对话写「对话」；英文写 chat。
2. **session（内核）**：只在调试台那三个 key 出现，中英都写不翻译的 "session"。

### 文案表

这张表就是 02–07 的完成标准：标为本张的每个 key，中英两侧的值都等于目标值。单元格只有三种写法：
完整的目标值；「—」，该侧保持现值；`替换：「A」 → 「B」`（英文格写 `替换："A" → "B"`），把现值里的每处 A 换成 B、
其余字符不动，多组用「；」隔开。引号只作分隔，不属于 A、B。
key 一律写改名后的路径，改名见下一节。表是对三份文案来源的完整盘点（2026-10-04 盘点，10-05 同步上游后复核）。
复评改过的 key 已移到「文案复评修正」表，本表不再列出。

**02 对话主体**

| key | 中文 | 英文 |
|---|---|---|
| `menu.aiAssistant` | AI 助手 | — |
| `chatWindow.windowTitle` | AI 对话 | — |
| `menu.newChat`、`tabs.newChat`、`chatSidebar.newChat`、主进程 `tray.newChat` | 新对话 | New chat |
| `chatSidebar.newChatInProject` | 在这个工程下新建对话 | — |
| `chatSidebar.archive`、`chatSidebar.archiveProjectChats` | 归档对话 | — |
| `chatSidebar.archiveProjectTitle` | 归档这个项目的对话 | — |
| `chatSidebar.sortBy` | 对话排序方式 | — |
| `chatSidebar.renameTitle` | 重命名对话 | — |
| `chatSidebar.renamePlaceholder` | 请输入新的对话名称 | — |
| `chatSidebar.smartNameEmpty`（还没有消息时的起名提示） | 这条对话还没有消息，起不了名 | — |
| `chatSidebar.deleteContent` | 确定要删除对话「{title}」吗？此操作不可撤销。 | — |
| `chatSidebar.batch.deleteContent` | 确定要删除选中的 {count} 条对话吗？此操作不可撤销。 | — |
| `chatSidebar.initialFallback` | 对 | — |
| `assetLock.unknownChat` | 另一条对话 | another chat |
| `assistant.topNav.clearChat` | 清空对话 | Clear chat |
| `assistant.chat.clearConfirmTitle` | 确认清空对话 | Clear this chat? |
| `assistant.chat.clearConfirmContent` | 该操作不可撤销，确定要清空当前对话的所有消息吗？ | This cannot be undone. Clear all messages in this chat? |
| `layout.trayQuitContent`、主进程 `tray.quitConfirm` | AI 还有 {count} 项操作在进行，退出会中断它们。 | The AI still has {count} operation(s) in progress — quitting will interrupt them. |
| `profile.usage.metric.turns`、`profile.usage.totalTurns`、`profile.usage.colTurns` | 轮次 | Turns |
| `profile.usage.changesPerTurnHint` | 每轮完成的平均改动数 | Average completed changes per turn |
| `ai.sessionTitleSystemPrompt` | 替换：「会话标题生成器」 → 「对话标题生成器」 | 替换："the conversation" → "the chat" |
| `ai.sessionRenameSystemPrompt` | 替换：「会话标题生成器」 → 「对话标题生成器」 | 替换："the last exchange of a conversation" → "the last turn of a chat"；"the conversation" → "the chat" |
| `ai.followUpUserPrompt` | — | 替换："the conversation above" → "the chat above" |
| `aiProvider.roles.chatDesc` | 助手与各处对话窗口的默认模型。 | — |
| `assistant.agentMode.sessionModelUnavailable` | 这条对话绑定的模型 {model} 已不可用，本轮改用默认模型 | — |
| `assistant.agentMode.sessionBusy` | — | This chat still has a run in progress. Wait for it to finish, or just type what you want changed. |
| `assistant.browserPane.restoreFailed` | 无法恢复浏览器页面，请检查网络后重新进入对话。 | Could not restore the browser page. Check your connection and reopen the chat. |
| `assistant.topNav.exportImageEmpty` | — | This chat has no content to export |
| `assistant.topNav.exportImageSuccess` | — | Chat image exported |
| `assistant.topNav.exportImageFailed` | — | Failed to export chat image. Please try again. |
| `assistantInputComposer.compactReason.busy`、`assistantInputComposer.toast.compactFailed.busy` | — | This chat is busy. Please try compacting again shortly |
| `assistantInputComposer.compactReason.cancelled`、`assistantInputComposer.toast.compactFailed.cancelled` | — | Compaction cancelled. Your chat has been preserved |
| `assistantInputComposer.toast.compactFailed.empty` | — | Nothing to compact yet in this chat |
| `assistantInputComposer.slashCommands.compact` | 压缩这条对话的历史，腾出上下文 | Compact this chat's history to free up context |
| `assistantInputComposer.wikiPopover.hint` | 输入 /wiki 过滤，点击绑定到当前对话 | Type /wiki to filter, click to bind to the current chat |
| `miniChatWindow.emptyState.agent` | 输入消息开始对话 | Type a message to start a chat |
| `notebook.studio.noContent` | — | Please add some sources or start a chat first |
| `profile.objectStorage.removeHint` | — | They are removed from the bucket and cannot be recovered. Chats that referenced them will no longer show them to the model. |
| `profile.personalization.instructionsDesc` | — | Persistent preferences applied to all chats. |
| `profile.voice.autoPlayDesc` | AI 回复生成结束后，自动朗读。 | Read replies aloud automatically when generation finishes. |

**02b 未命名对话**

| key | 中文 | 英文 |
|---|---|---|
| `assistant.chatFlow.unnamedChat` | 未命名对话 | Untitled chat |

**03 分支**

| key | 中文 | 英文 |
|---|---|---|
| `assistant.branch.failed` | 分支失败 | Failed to branch |
| `assistant.branch.missing` | — | This chat has no history to copy yet |

**04 侧边问一句**

| key | 中文 | 英文 |
|---|---|---|
| `assistant.sideQuestion.noContext` | — | This chat has no context to hand over yet |
| `miniChatWindow.sideContext.empty` | — | Ask away — it can see every step the main chat took |

`assistant.sideQuestion.open`（「侧边问一句（带上下文）/ Ask on the side (with context)」）保持现值。

**05 语音通话**

| key | 中文 | 英文 |
|---|---|---|
| `aiProvider.catalog.group.realtime` | 实时语音（语音通话） | — |
| `aiProvider.model.supportsRealtimeVoiceDesc` | 支持实时语音通话 | Supports real-time voice calls |
| `aiProvider.roles.realtimeDesc` | 选择实时语音模型，用于语音通话。 | Choose a real-time voice model for voice calls. |
| `aiProvider.roles.realtimeMissing` | 语音通话不可用 | Voice call unavailable |
| `assistantInputComposer.voice.start` | 开始语音通话 | Start voice call |
| `assistantInputComposer.voice.stop` | 结束语音通话（后台任务继续运行） | End voice call (background tasks continue) |
| `assistantInputComposer.voice.boundCall` | 语音通话：{name} | Voice call: {name} |

**06 小窗**

| key | 中文 | 英文 |
|---|---|---|
| `profile.menu.miniWindow`、`profile.miniWindow.title` | 小窗 | Mini window |
| `profile.miniWindow.persist` | 保存小窗里的对话 | Save chats from the mini window |
| `profile.miniWindow.persistDesc` | — | Saved to your chats when the mini window closes. |

**07 不是对话的「会话」**

| key | 中文 | 英文 |
|---|---|---|
| `agentV3Debug.sessionId` | Session ID | — |
| `agentV3Debug.approveAlways` | 本次 session 始终允许 | — |
| `agentV3Debug.newSession` | 新建 session | — |
| `chatSidebar.deleteTranscriptFailed` | 对话已移除，但部分历史没能清理 | Chat removed, but some of its history could not be cleaned up |
| `assetManagement.import.sessionExpired` | 服务器上已经找不到这次导入了（可能超时被清理），需要重新导入 | The server no longer has this import (it may have timed out and been cleaned up). Import it again. |
| `assetManagement.import.abandonConfirmContent` | 替换：「这次会话」 → 「这次导入」 | 替换："this session" → "this import" |
| `assetManagement.import.resumeNotFoundContent` | 未找到可以继续的导入：{error} | No resumable import found: {error} |
| `assetManagement.import.stages.createSession` | 开始导入 | Starting import |
| `assistant.chat.replyInterrupted`（新增，见「中断回复的标记」） | 回复已中断 | Reply interrupted |

网络库导入用「这次导入」：「导入任务」已经是本地资产库后台导入的名字。

### i18n key 改名

只改下表这些，其余 key 名保持原样：它们的值改对之后，key 名只是代码标识符。

| 工单 | 旧 key | 新 key |
|---|---|---|
| 02b | `assistant.chat.unnamedSession`、`assistant.chatFlow.unnamedSession`、`assistant.agentMode.unnamedSession`、`miniChatWindow.defaultSessionTitle` | 合并为一个 `assistant.chatFlow.unnamedChat`，四个旧 key 删除 |
| 02 | `assetLock.unknownSession` | `assetLock.unknownChat` |
| 02 | `assistant.sensitiveAction.allowForSession` | `assistant.sensitiveAction.allowForChat` |
| 02 | `miniSensitiveConfirm.actions.allowSession` | `miniSensitiveConfirm.actions.allowForChat` |
| 02 | `assistant.topNav.clearSession` | `assistant.topNav.clearChat` |
| 04 | 命名空间 `assistant.sideChat` | `assistant.sideQuestion` |
| 05 | `assistantInputComposer.voice.boundConversation` | `assistantInputComposer.voice.boundCall` |
| 06 | `profile.menu.miniChat` | `profile.menu.miniWindow` |
| 06 | 命名空间 `profile.miniChat`（含 `windowTitle`、`opacity` 等全部子 key） | `profile.miniWindow` |

- `menu.aiChat` 保留：`store/modules/tabs.ts` 的旧标签迁移表把老用户的标签标题写成了 `menu.aiChat`，这串已经存在用户本地。
- `miniChatWindow`、`miniSensitiveConfirm` 等以组件命名的命名空间保持原样，组件名 MiniChat 不改。
- 每改一个 key，中英两侧同步改，完成标准有两条：
  - **引用清零**：旧 key 的完整路径（命名空间改名则是旧前缀，如 `profile.miniChat.`）在 `src/` 下零命中，
    `retiredKeys.test.ts` 不计：它按完整路径列出旧 key，是下一条「定义清零」的断言本身。
    key 覆盖守卫只认 `t('…')` 字面量，看不到 `labelKey`、`titleKey`、路由 meta 的 `title`、迁移表和测试里的 key 字符串；
    其中 `labelKey`、`titleKey` 另由 `settingsCopy.test.ts`、路由 `title` 另由 `routeTitles.test.ts` 在两份语言包里取值兜住。
    已知的非 `t()` 引用：`PreferencesSidebar.vue` 的 `labelKey`、`Preferences/index.vue` 的 `titleKey`、
    `router/modules/index.ts` 的路由 `title`、`miniChatPreferences.test.ts`、`agentSessionIsolation.test.ts`。
  - **定义清零**：旧 key 与旧命名空间写进 `retiredKeys.test.ts`（见 Testing Decisions），两份语言包里取值都是 `undefined`。
    语言包是嵌套对象，完整路径的字符串不出现在里面，上一条查不到旧定义；两侧都留着旧项时 `criticalPathCoverage` 也不报。

### 旧默认标题仍算「未命名」（02b）

默认标题的改值、四个 key 的合并与本节的判断必须同一次提交：只换默认标题的那次提交会让老对话不再自动起名。

自动起名靠「标题等于默认标题」判断对话还没被命名。默认标题改了，老用户存下的空对话（标题是旧值）和切换过界面语言的对话
就会被当成已命名，首条消息不再触发自动起名。

- 新建 `src/renderer/src/utils/untitledChat.ts`，导出
  `isUntitledChatTitle(title: string | undefined, currentDefault?: string): boolean`。比对前对 `title` 归一化首尾
  空白；返回 true 的情形：空标题（含纯空白）；等于 `currentDefault`（调用方用自己的 `t` 取到的当前默认标题）；
  等于两份语言包里 `assistant.chatFlow.unnamedChat` 的值；等于旧默认标题 `AI会话`、`Unnamed Session`、`快速对话`、`Quick chat`。
  `currentDefault` 让注入或 mock 的 `t` 继续生效：测试里 `t` 原样返回 key，新对话的标题就是 key 本身。
  另导出 `UNTITLED_CHAT_FALLBACK`（取中文语言包的 `unnamedChat`）。
- 四处判断改用它，每处都把手上的当前默认标题作为 `currentDefault` 传入：
  `chatSendPrimitives.ts` 的 `session.title === unnamedTitle`、`agentCompletionHandlers.ts` 的 `session.title === t(…)`、
  `voiceAssistant.ts` `voiceTaskTitle` 的 `chatTitle === t(…)`、`voiceAssistant.ts` `nameVoiceSession` 的 `title !== placeholder`。
- `store/modules/chatSessions.ts` `createSession` 里写死的 `'AI会话'` 兜底改为 `UNTITLED_CHAT_FALLBACK`。
- **有意的行为变化**：旧默认标题与当前默认标题一视同仁，包括已经有消息的对话。现状里 `ensureSessionWithTitle`
  在消息文字为空时把标题留在当前默认值，下一条消息再以那一条起名；小窗存进侧边栏的对话，首条用户消息取不到文字时标题是「快速对话」
  （`MiniChatWindow.vue` 保存时的兜底）。改完后，这类「快速对话」在主窗口里再发一条就会以那一条消息自动起名，
  与「AI会话」的现有行为一致。用户故事 5 的统一默认标题只对新建的对话成立：已存下的旧默认标题不改写（见 Out of Scope）。

### 点名审批按钮的文字（02）

审批按钮（`allowForChat`）的文案在语言包之外还被点名：发给模型的工具文本
`src/main/agent-v3/tools/adapted/asset/` 下的 `vaultScope.ts`（两处）与 `switchVault.ts`，断言它的 `vaultScope.test.ts`，
以及二十余处描述现状的注释与测试标题。模型照工具文本指引用户去点这枚按钮，所以它们与按钮同步改成「本对话内都允许」。
完成标准：`src/` 下 `本次?会话.{0,2}允许` 只剩解释历史的注释（`ipc/agentV3.ts` 里「原来……按钮上写着」那段）；
放宽到 `.{0,2}` 是为了连 `McpClientManager.ts` 文件头那句「本次会话始终允许」一起抓到。

**不写「始终」**：放行名单是主进程内存里按内核 session 记的，重启、分支、切到 Ask 模式都会清空，
「始终 / Always」承诺了做不到的事。按钮、工具文本、`vaultScope.test.ts` 断言与点名它的注释统一为
「本对话内都允许 / Allow for this chat」。完成标准：`src/` 下 `本对话内始终允许`、`Always allow in this chat` 零命中。
不做放行名单持久化（改审批语义，超出范围）。

按钮在界面层的代码名与 key 同名：两个确认框组件（`SensitiveActionConfirm.vue`、`MiniSensitiveConfirm.vue`）的
`handleAllowForSession` 改为 `handleAllowForChat`，`SensitiveActionConfirm.vue` 的样式类 `.btn-allow-session` 改为 `.btn-allow-chat`。
它们只在组件内部，无持久化、不过 IPC。主进程按内核 session 记放行名单的 `sessionAlwaysAllowed` / `alwaysAllowedFor` 是内核层，保持原名。
完成标准：`src/` 下 `handleAllowForSession`、`btn-allow-session` 零命中。

### 中断回复的标记（07）

界面重新加载时，`views/Assistant/composables/agentReattach.ts` 把生成已不在进行的回复收尾，`store/modules/chatMessages.ts` 的
`interruptedTypingContent` 给它贴上写死的「会话已中断（页面刷新）」。主语错了（中断的是回复，对话还在），原因也常常不对
（最常见的是退出或崩溃，单纯刷新会被接回、不出这句），英文界面也显示中文。改为只陈述事实的 `assistant.chat.replyInterrupted`。

- `interruptedTypingContent(content, label)`、`markTypingInterrupted(sid, messageId, label)` 各加一个 `label: string` 参数，
  store 保持不引 i18n；格式不变：没输出过的整条换成 `label`，写了一半的末尾追加 `\n\n*[label]*`。
- `initAgentReattach` 的 `markInterrupted` 传入 `i18n.global.t('assistant.chat.replyInterrupted')`（`import i18n from '@renderer/i18n'`，
  同 `assetLibraryStore.ts`）。`ReconcileDeps.markInterrupted` 的签名不变。
- `chatMessages.ts` 里点名这句的注释（`markTypingInterrupted` 上方「叠两行」那段）随之改。
- 完成标准：`src/` 下 `会话已中断` 只剩解释历史的注释（`chatMessages.ts` 恢复缓存那段「以前这里直接把它改成……」、
  `agentReattach.ts` 文件头、`ipc/agentV3.ts` 讲 reattach 的那段）。已存进历史消息的旧标记不改写（见 Out of Scope）。

### 代码改名：分支（界面层 fork → branch，工单 03）

| 旧 | 新 |
|---|---|
| `views/Assistant/composables/sessionFork.ts`（及 `.test.ts`） | `chatBranch.ts`（及 `.test.ts`） |
| `forkSession()` | `branchChat()` |
| `SessionForkOutcome`、`SessionForkDeps` | `ChatBranchOutcome`、`ChatBranchDeps` |
| `ForkPoint`、`resolveForkPoint` | `BranchPoint`、`resolveBranchPoint` |
| `AIBubble.vue`、`ChatLog.vue` 的事件 `fork` | `branch` |
| `AIBubble.vue` 的 `emitFork` | `emitBranch` |
| `ChatLog.vue` 的 `handleFork`、`Welcome.vue` 的 `@fork="handleBubbleFork"` | `handleBranch`、`@branch="handleBubbleBranch"` |

保持 fork（内核复制 session 的那一步）：`ForkTranscriptResult`、`ChatBranchDeps.forkTranscript`、
IPC 通道 `agent-v3:fork-session`、`agentV3API.forkSession`、preload 的 `forkSession`（`index.ts` 与 `index.d.ts`）。
完成标准：`src/` 下 `sessionFork`、`SessionFork`、`ForkPoint`、`resolveForkPoint`、`emitFork`、`handleFork`、`handleBubbleFork`、
`emitted('fork')`、`@fork`、`emit('fork'`、`(e: 'fork'` 零命中；`forkSession` 只剩 `agentV3API.forkSession` 与 preload `forkSession` 的定义、对它们的调用、点名它们的注释。
事件的声明、发出、监听三处要一起改：`tsconfig.web.json` 没开 `strictTemplates`，监听一个子组件没声明的事件不报类型错误，
改漏一处只会表现为点「分支」没反应；零命中只证明旧名清干净，新名两头一致由「事件连线测试」证明（见 Testing Decisions）。
清单里写 `emit('fork'` 与 `(e: 'fork'` 而不是 `'fork'`：`updateFeed.test.ts` 的 `repo: 'fork'` 是正常用法。

### 代码改名：侧边问一句（side chat → side question，工单 04）

| 旧 | 新 |
|---|---|
| `src/shared/sideChat.ts`、`SideChatContext` | `src/shared/sideQuestion.ts`、`SideQuestionContext` |
| `views/Assistant/composables/sideChat.ts`（及 `.test.ts`） | `sideQuestion.ts`（及 `.test.ts`） |
| `openSideChat`、`SideChatDeps`、`SideChatOutcome`、`SideChatForkResult` | `openSideQuestion`、`SideQuestionDeps`、`SideQuestionOutcome`、`SideQuestionForkResult` |
| IPC 通道 `agent-v3:fork-for-side-chat` | `agent-v3:fork-for-side-question` |
| preload `forkForSideChat`（`index.ts` 与 `index.d.ts` 同改）、`agentV3API.forkForSideChat` | `forkForSideQuestion` |
| `TopNav.vue` 的事件 `side-chat`、`emitSideChat` | `side-question`、`emitSideQuestion` |
| `Welcome.vue` 的 `@side-chat="handleSideChat"` | `@side-question="handleSideQuestion"` |

保持 fork：`SideQuestionDeps.fork` 字段（它就是内核复制）。无持久化：主进程、preload、渲染层同版本发布。
完成标准：`src/` 下按 `(?i)side[ -]?chat` 搜索（一并覆盖 `sideChat`、`SideChat`、`side-chat`、"Side chat"），
只剩解释历史的注释、`retiredKeys.test.ts` 里的旧命名空间与 `terminologyGuard.test.ts` 里的禁用词条目。
`en-US.ts` 里 `sideChat` 块上方那段描述现状的注释在本张改写。

### 用户可见的错误改走错误码（第 5 组）

来自 `.scratch/chat-terminology-beyond-locales/` 工单 02、03：07 改了外框，主进程拼好的原文里还说「会话」，
同一句话两种说法，所以改走错误码、由渲染层按码选文案。

- 资产导入四条错误：主进程补 `errorKey`，`error` 原文保留给模型；渲染层按 `errorKey` 取文案。
- 续跑与插话被拒：主进程补 `SESSION_BUSY`、`NOT_RUNNING`、`PROJECT_MISMATCH` 码；渲染层按码与入口选文案。
  插话被拒按入口各有下文：从输入框发的放回输入框（`ifRejected: 'restored'`），从队列发的留在队列、本轮释放后照常发出（`'queued'`），
  这两种不是失败，用 info 提示；其余拒绝仍走 `steerFailed` 外框。

**拆出两处行为修复（工单 09）**。下面两处与术语无关、改变的是行为，移出本 PR，单独提 fix PR（见 Out of Scope）：

- 续跑判忙由 `agentStreamStore.isStreaming` 改为 `isBusy`（`useAgentMode` 的 `resumeAgent`）：回退为 `isStreaming`，那一行上方的注释一并回退；同一函数里的错误码与文案改动保留。
- 点「接着跑」时先查 `isBusy`、忙就提示 `sessionBusy` 并保留按钮（`Welcome.vue` 的 `handleBubbleAction`）：整段移除。
- `useAgentMode.resumeSteer.test.ts` 里测这两处的用例（「摘按钮之前先查 isBusy」一段，及断言续跑按 `isBusy` 拦截的用例）随之移走；
  错误码与按码选文案的用例留下。拆完后第 5 组单独是绿的。
- fix PR 基于术语 PR（`resumeAgent` 被第 5 组改写过），PR 描述注明依赖；拆出的代码与测试先存成补丁放在 `.scratch/` 里，不丢。

**拒绝码收进 shared 类型（工单 18）**。续跑与插话的码在主进程回码处和渲染层文案表里各写一遍字符串，彼此没有类型联系；
码对不上时渲染层退回显示主进程原文（「会话 <uuid> 正在执行中」「没有正在执行的会话」），第 7 组把这几条原文留给日志的前提随之失效。
照同组 `src/shared/importErrorKey.ts` 的做法收进 `src/shared/agentRunRejection.ts`，按通道分两个类型（启动与续跑 `SESSION_BUSY`；
插话 `NOT_RUNNING`、`PROJECT_MISMATCH`）；主进程回码处与 `agentControlHandlers.ts` 的两张文案表用 `satisfies` 约束。只改类型，行为不变。
preload `index.d.ts` 与 `api/ai.ts` 里的 `code?: string` 不收窄：preload 只是转发，那里的类型不核对主进程实际回的值，收窄只起文档作用，
且挑进第 5 组时会与第 8 组改过的注释相邻冲突。与「品牌类型 PR（以后）」的区别：规模小（主进程 5 处、文案表 2 张），且码大多是本 PR 新增的约定。

第 5 组的文案修正见「文案复评修正」表里组为 5 的行。另把 `2a288ba` 改成英文的那条 `console.error` 改回原样（`'[Agent模式] 续跑失败:'`）：日志不是界面文案，改它不属于本 PR。 例外：工单 03 在 `handleBubbleBranch` 里把日志标签 `[会话分支]` 改为 `[分支]`，随函数改名保留。

### 代码改名：对话 id（第 6 组）

渲染层与 shared 里，**指对话的 `sessionId`**（变量、参数、字段、prop）改名为 `chatSid`。只改这一件事，行为不变。

- 不改：
  - `sid`：一律指对话，读作 `ChatSession` 的 id，不误导。
  - 指内核 session 的 `sessionId`：与 IPC 载荷、`agentV3API` 一致。
  - 网络库导入的 `sessionId`：属导入领域。
  - 对象名：`ChatSession` 一族、`ReattachedSession`（字段已叫 `chatSid` / `agentSessionId`）、`adoptRunningSession`（参数已叫 `chatSid`）、
    语音连接的局部变量 `session` 等。
  - 主进程、preload 里的 `sessionId`（那一层只指内核）。
  - 持久化字段与 IPC 载荷的字段名：指对话但会写进存储或过 IPC 的，保持原名，在排查清单里注明理由。
- 已知要改的（非穷举，以排查清单为准）：`chatSendPrimitives` 里指对话的 `sessionId`；`deleteChatSession` 的参数；
  `TopNav`、`SessionProjectChip`、`EditorStatusMonitor` 的 prop `sessionId`（`Welcome.vue` 传给 `TopNav`、`SessionProjectChip` 的
  `:session-id="sid"`，以及 `TopNav` 转给 `SessionProjectChip`、`EditorStatusMonitor` 的 `:session-id="sessionId"`，都改为 `:chat-sid`）。
  `Welcome.vue` 传给 `AgentBrowserPane` 的 `:session-id="browserSessionId || ''"` 取自 `agentSessionId`、指内核，不改；
  `AgentBrowserPane`、`AgentBrowserWindow` 的 `sessionId` 同理。`Welcome.vue` 自身的 prop `sessionId` 按排查结果归类。
- **排查清单**（交付物，存在 `.scratch/chat-terminology/` 下，不进 PR）：
  - **行集**由一次检索决定：渲染层与 shared 下所有名为 `sessionId` 的声明（变量、参数、字段、prop、事件载荷），每个一行。
    检索命令与命中数写在清单开头。名字里带 `SessionId` 的复合名同样按值的来源归类。
  - 每行标明归类——对话 → 改名 / 内核 / 导入 / 对话但持久化或过 IPC → 保留——与依据（值从哪来、流到哪去）。
- **排查方法**：品牌类型只用来帮着归类。本地临时把 `ChatSession.id` 标成 `ChatSid`、`agentSessionId` 标成 `AgentSessionId`；
  对一行拿不准时，把它的声明试标成其中一种，跑渲染层类型检查，看报错落在哪种来源上。品牌类型不进任何提交，排查结束即撤掉。
- 事件载荷、emit 参数里指对话的 `sessionId` 同样改名；渲染层内部的事件，不过 IPC。
- `CONTEXT.md` 同组写入 id 命名规则：「渲染层里 `sessionId` / `agentSessionId` 指内核 session，`sid` / `chatSid` 指对话；
  网络库导入的 `sessionId` 属导入领域」。不写「渲染层的 session 对象即对话」（`ChatSession` 之外的 session 对象不全是对话）。 另写明例外：过 IPC 的载荷字段沿用原名（`TrayAction` 的 `open-session` 里 `sessionId` 是对话 id，`ai.chatStream` 的 `sessionId` 是单次流 id）。
- 完成标准：清单行数等于检索命中数；归为「对话 → 改名」的每一行在代码里已改；改名后重跑同一检索，剩下的命中都是清单里归为内核、导入或保留的行；
  `src/` 下 `:session-id="sid"` 零命中；类型检查通过。
  名字里带 `SessionId` 的复合名另跑 `rg -o -i "[A-Za-z0-9_\$-]*session[_-]?ids?[A-Za-z0-9_\$-]*" src/renderer src/shared`：31 个不同的名字、
  去掉 `sessionId` 后 30 个逐个归类；改名后重跑，剩下的都属于内核、`ChatSession` 一族或其他领域。

### 给应用内模型读的文字（第 7 组）

应用内模型读的文字里，指对话的「会话 / 聊天」改为「对话」。模型会把这些说法原样转告用户
（如工程健康检查「把会话移出该工程」、`box` 工具、`taskVideo` 工具），所以它们也是界面术语的一部分。

- 范围：`src/main/agent-v3/**` 的工具描述、参数说明、工具报错与回执；语音前台指令（`frontDesk`）、渲染层交给实时语音模型的文字（如 `voiceConversationHistory.ts`）；主进程经 `{error}` 显示给用户的报错；
  `resources/skills/**` 里指对话的几处。已知例子：`sessionHealth`、`box`、`addNotebookSource`、`taskVideo`、`writeGuard`、`editorScreenshotScope`。
- 做法：逐句改，不全局替换；只换词、不改句式。「聊天」指内容而非对话、且承担对照时，改成准确说法而不是硬换「对话」。 只换词会写出与代码不符的说法时（如工具清单按轮确定），按代码改成准确说法。
  提到工具参数 `session` / `session_id` 的地方，写明取值来自哪个工具的返回（`list_sessions`、`box` 的 `list`），不断言它是对话 id —— 两者的取值都是内核 session id。
- 例外（不改）：日志；MCP、引擎、编辑器、语音识别等其他领域的会话；「当前语音对话」协议标记一对（见 Out of Scope）；
  工具参数名 `session`、`session_id`（给模型的协议名）；指内核 transcript 的「会话记录」。
- 同提交改断言这些文字的测试（如 `frontDesk.test.ts`、`sessionHealth.test.ts`）。
- `CONTEXT.md` 同组注明：语音派活工具的参数 `session` 是给模型的协议名，不改；取值是 `list_sessions` 列出的内核 session id。
- 完成标准：一次性检索。上述范围内按 `会话|聊天` 搜索，每处命中都落在例外里，结果附在工单里；不加永久守卫。
  另在本机手动试两条：语音派活能接到已有对话；`sessionHealth` 的提示由模型转告给用户时说的是「对话」。

### 边界文档注释（第 8 组）

范围：渲染层、preload、shared 的全部注释，包括边界声明上的文档注释、函数体内的行注释与块注释、模板注释、CSS 注释。

- 写法：指对话写「对话」；指内核写「内核 session」（非语音文件里写成「agent 会话」的一并改，语音约定覆盖的文件按 `CONTEXT.md` `session` 词条的存量注释读法保留）；
  「聊天」照第 7 组的做法；其他领域（导入、浏览器、MCP、登录、语音连接、这次运行）不动，与本 PR 已改说法直接相关的运行期说法除外。
  讲历史、原样引用旧字符串的注释（旧标记、旧按钮文案、真机报错原文）保留原文，同「范围」一节「解释历史的注释保留旧名」。
- 主进程（约 262 处裸「会话」，抽样多指内核 session 或 MCP 外部会话）不整体改写，约定见 `CONTEXT.md` `session` 词条的存量注释读法；
  主进程注释里指对话的「会话」全部改为「对话」（作者已同意，实际 56 个文件、260 行）。另外，用了 `CONTEXT.md` _Avoid_ 里的词、
  且同一文件已有正确写法的主进程注释一并改（`transcriptStore.ts`、`resume.ts`、`ipc/agentV3.ts`、`eventBridge.ts`）。
- 只改注释，不改代码。
- 完成标准：一次性检索 `rg -n "会话|聊天" src/renderer src/shared src/preload --glob '!*.test.ts' --glob '!**/locales/**'`，
  剩下的每一行都归入保留的类别，归类结果写在工单 16 正文里。

### 术语守卫

- 位置：`src/renderer/src/i18n/terminologyGuard.test.ts`，导入 `./locales/zh-CN`、`./locales/en-US` 与
  `@core/main/i18n` 的 `MAIN_STRINGS`（渲染层测试引主进程模块都走 `@core/main/...` 别名）。
  `src/main/i18n.ts` 没有任何 import，可以进渲染层的类型检查项目；`tests/` 下只有 `material-library/` 进了类型检查，所以守卫放在这里。
- 输入：两份语言包的全部叶子字符串、`MAIN_STRINGS` 中英两侧的全部字符串。数组元素也是叶子，路径带下标，
  如 `assistant.contextChips.default[0]`；`criticalPathCoverage` 的 `collectLeafPaths` 把整个数组当一片叶子、再按非字符串跳过，照抄会漏掉数组。
- 匹配：先剥掉插值占位符（`{xxx}`）。按禁用词本身的写法决定方式，对所有来源一视同仁：含汉字的词按子串匹配；
  拉丁字母的词按单词边界、不区分大小写匹配（"mid-session" 命中，中文包里的 "MiniChat" 也命中）。
  汉字子串有已知的跨词误报（「社会话题」含「会话」，「撤回合并」含「回合」）：
  碰上时改写那句文案，白名单仍只放调试台三个 key。
- 禁用词表写在测试里，每条带替换建议；顶部注明「来源：`CONTEXT.md` 的 _Avoid_，是有意挑选的子集；改这张表时同步 `CONTEXT.md`」，
  并写明 Thread、Fork 只靠词汇表约束：留给 UE 与内核语境的正常用法（如 Game Thread、内核的 fork）；
  再写明上一条的汉字误报边界与处理方式。
- 白名单：`Map<key, 放行的词[]>`，按精确 key 匹配，只放行该 key 下列出的词；同一个 key 下出现别的禁用词照样命中。
  放行的词写禁用词表里的条目本身，按条目比较、不按命中原文：放行 "session" 条目，"Session ID" 里的 "Session" 也放行。
  08 放入 `agentV3Debug.sessionId`、`agentV3Debug.approveAlways`、`agentV3Debug.newSession`，各自只放行 "session"，两份语言包都适用；
  与 "session" 条目同张入表，放行的词始终是表里已有的条目。
- 零容忍：命中一处即失败；失败信息逐条列出来源（哪份文案）、key 路径、命中词、替换建议。
- **英文 `session` / `sessions` 保持整词零容忍（第 4 组，工单 12）**，不改成只禁固定搭配，也不移出词表。依据：上游 2026-04..10-04
  新增英文文案里含 session 的约 33 行，全是对话、登录、导入、语音、调试台用法，没有一条 UE 或 MCP 语境；只禁固定搭配会漏掉约一半指对话的写法。
  - 替换建议按意思列全：对话写 chat；登录写 sign-in / signed out；网络库导入写 import（调试台三个 key 除外）。
  - 失败信息只给替换写法。守卫顶部注释写明：确有改写不了的正当用法时，由提交者在 PR 里说明、维护者决定是否破例；
    白名单仍是调试台三个 key。

**完整词表（按工单逐步加入；01 时为空）**

| 加入的工单 | 禁用词 | 替换建议 |
|---|---|---|
| 02 | 聊天 | 对话 |
| 02 | 回合、一问一答；exchange | 一轮；turn |
| 03 | 会话分支、对话分支 | 分支 |
| 04 | 侧边对话；side chat | 侧边问一句；side question |
| 05 | 语音对话 | 语音通话 |
| 06 | MiniChat、Mini Chat、迷你对话 | 小窗；mini window |
| 07 | 内核记忆 | 只说用户能理解的后果 |
| 08 | 会话 | 对话（调试台写 session） |
| 08 | session、sessions | 对话写 chat；登录写 sign-in / signed out；网络库导入写 import（调试台除外） |
| 08 | conversation、conversations | chat |

### 执行方式（已按此完成）

- 01–08、02b 按链式顺序实现：每张清理完一个概念把它的词加入词表，守卫始终零命中。
- 09–18 作为新提交追加到本地 `main`，不改写已有提交；每个提交只改一个组的内容，提交信息标明所属组；
  文案修正按「文案复评修正」表的「组」列分开提交；`.scratch/` 的更新（工单状态、排查清单、行为修复补丁）单独提交。
- 每组以其工单的完成标准（测试 + 类型检查）为准；完整 `pnpm verify` 只在 PR 分支上跑（工单 17）。

### 提交 PR（分支已组装：本地 `feat/chat-terminology`，待人批准推送）

- 分支从 `upstream/main` 切出（AGENTS.md §10），按组用 `cherry-pick -n` 叠加已有提交与该组的新提交，每组提交一次，共 **8 组**：

| 组 | 内容 | 已有提交 | 新提交来自 |
|---|---|---|---|
| 1 | 01–02 守卫骨架与对话主体 | `604adf8`、`e218264` | 工单 10；工单 11 的第 1 组提交 |
| 2 | 02b 未命名对话 | `17135ca` | — |
| 3 | 03–04 分支、侧边问一句 | `f04d07b`、`7af3537` | 工单 11 的第 3 组提交 |
| 4 | 05–08 语音通话、小窗、非对话场景、收尾 | `81bcdcf`、`c0ccdff`、`6a409b2`、`f263072`、`3356c2e` | 工单 11 的第 4 组提交；工单 12 |
| 5 | 用户可见的错误改走错误码 | `b5363bc`、`2a288ba` | 工单 09；工单 11 的第 5 组提交；工单 18 |
| 6 | 代码改名：对话 id | — | 工单 14 |
| 7 | 给应用内模型读的文字 | — | 工单 15 |
| 8 | 边界文档注释 | — | 工单 16 |

- 02b 单独成组：它是唯一改逻辑、带有意行为变化的一块，要能单独审、单独回退；改名（03–04）不与文案混组。
  第 5 组改主进程返回形状与渲染层逻辑，理由同 02b。第 6 组基于含第 5 组的代码写成，所以排在第 5 组之后、单独成组。
  第 7、8 组只改文字和注释，放在最后，被要求撤掉时回退最干净。
- 新提交挑进前面的组时，语言包里可能与相邻行冲突：手动解决，保证每组单独是绿的。
- 第 5 组与上游新增的 `steerAgent` 参数 `restoreDraft`（`57a3740`）相邻冲突，已按预定解法合并：两个都留，`ifRejected` 在前、`restoreDraft` 在后；
  `Welcome.vue` 输入框那条调用传 `'restored', payload.restore`，`editorSnapshotWiring.test.ts` 引用这行源码的断言同步改。
- 不进 PR：`.scratch/` 与本 fork 专属提交（`75a3ec6`、`1fc29ad`、`fb00a4c`、`6f6f473`）。
- `CONTEXT.md`：上游没有「对话」这组术语。第 1 组带入 01 开工前本地 `main` 的整份 `CONTEXT.md`，08 的改动随第 4 组，
  id 规则随第 6 组，语音派活参数说明随第 7 组，主进程注释约定随第 8 组。
- 上游在同步之后又新增了含禁用词的字符串时，守卫会在 PR 分支上报出：在引入该词的那一组里改掉，保证每组单独是绿的。
- 完整 `pnpm verify` 在 PR 分支上跑一次，作为整批的最终门禁。
- PR 描述除模板（AGENTS.md §6）外写明：02b 的有意行为变化；第 5 组资产导入错误新增 `errorKey`（`error` 原文保留给模型）、
  续跑与插话被拒时补错误码，插话按入口（放回输入框 / 留在队列）给出各自的提示，两类码的类型都收在 `src/shared/`；第 6 组只改名、不改持久化与 IPC；
  第 4 组的 `assetManagement.import.sessionExpired` 是改正意思而不只是换词：旧文案说登录过期，实际只在服务器报 `SESSION_NOT_FOUND`（这次导入已被清理）时出现；
  第 7 组是一次性清理、没有守卫，附实测回退速度（首发后两周上游新写 8 行，约每周 4 行）并提出后续「给模型读的文字守卫 PR」（见 Out of Scope）；
  已存下的旧默认标题与旧中断标记不改写；续跑判忙与「接着跑」的行为修复见后续 fix PR；用户手册 `website/` 见后续 PR，在那之前手册会指向已不存在的按钮。

## Testing Decisions

- 测试只断言规则与外部可见的行为：字符串里没有禁用词、每个被调用的 key 两侧都存在、改名前后功能行为一致
  （唯一例外是「旧默认标题仍算未命名」里写明的有意变化）。整句措辞是文案选择，审阅 diff 时对照文案表检查。
- **新增：术语守卫测试。** 除了对真实文案断言零命中，用内联小样例和临时词表自证匹配规则：命中 "New session"、
  命中「新会话」、命中 "mid-session"；数组元素里的 "New session" 命中、报出带下标的路径；`{session}` 不命中；
  白名单 key 下放行的词不命中，大小写与条目不同的原文（放行 "session"、原文 "Session"）也不命中；
  同一个 key 下别的禁用词命中；同一个词换到别的 key 下命中。
- **新增：`src/renderer/src/i18n/retiredKeys.test.ts`（02 建，02b、04–06 往里加）。** 列出「i18n key 改名」表里的每个旧 key
  与旧命名空间，断言两份语言包里取值都是 `undefined`；取值方式同 `settingsCopy.test.ts` 的 `get`。
- **新增：`chatSessions.test.ts` 一条。** 已存在、标题为「快速对话」的对话，经 `ensureSessionWithTitle`
  （`unnamedTitle` 传新默认标题）后，标题变为这条消息的前 20 字。
- **新增：`untitledChat.test.ts`。** 两份语言包的当前默认标题、四个旧默认标题、空标题、等于 `currentDefault` 的标题返回 true；
  用户起的标题返回 false。
- **改写：`agentSessionIsolation.test.ts`** 里后台对话 `chatA` 的建档标题改为新 key 字符串 `assistant.chatFlow.unnamedChat`
  （注入的 `t` 原样返回 key），让它仍走自动起名那段，`updateTabTitleByPath` 没被调用的断言才有意义；
  并断言 `chatA` 已被自动起名（首条消息前 20 字），把这个前提钉住。
- **沿用：`voiceAssistant.test.ts`「用户的第一句话给这条新对话起名」** 不改断言，靠 `currentDefault` 保持通过。
- **改写：`SessionProjectChip.test.ts`** 最后一条断言预建对话的标题为新的默认标题（它测的就是默认标题，不是测试数据）。
- **改写：`vaultScope.test.ts`** 「切库要用户点头」那条断言工具文本含新按钮文案「本对话内都允许」（工单 10）。
- **改写：`chatMessages.test.ts`** 两条收尾用例给 `markTypingInterrupted` 传入 `zhCN.assistant.chat.replyInterrupted`，
  断言整条替换与末尾追加 `\n\n*[…]*` 的格式、重复收尾不叠加，均与改前一致。
- **新增：`src/renderer/src/i18n/trayQuitCopy.test.ts`（07）。** 托盘退出确认的正文有两份活拷贝：应用内确认框读
  `layout.trayQuitContent`，渲染层接不住时主进程退回系统原生框读 `tray.quitConfirm`，两份都删不掉。断言两者中英两侧逐字一致
  （用户故事 11）；文案表只在改的那一刻对得上，之后只改一份不会有别的测试报红。
- **改写：`miniChatPreferences.test.ts`** 断言侧边栏里没有 `profile.menu.miniWindow`，否则它会对着一个不存在的旧 key 永远通过。
- **新增：事件连线测试（03 建，04 往里加）。** `AIBubble.actions.test.ts` 只测到气泡发出事件，下面三处补齐其余各段，
  合起来覆盖「气泡 → 列表 → 页面」与「顶栏 → 页面」两条链（路径相对 `src/renderer/src/views/Assistant/`）：
  - `components/ChatLog.branch.test.ts`（03）：照 `ChatLog.scroll.test.ts` 挂载，`messages` 给一条 `role: 'assistant'` 的消息，
    `AIBubble` 换成点击即 `$emit('branch', { id })` 的桩；断言 `ChatLog` 向上发出 `branch`，载荷不变。
  - `components/TopNav.test.ts` 加一条（04）：沿用文件里的桩，点击文字等于 `zhCN.assistant.sideQuestion.open` 的菜单项，
    断言发出 `side-question`。
  - `Welcome.events.test.ts`（03 建，04 加一条）：照 `ChatLog.style.test.ts` 读源码、不挂载（`Welcome.vue` 近 3000 行）；
    断言 `<ChatLog` 开标签含 `@branch="handleBubbleBranch"`，`<TopNav` 开标签含 `@side-question="handleSideQuestion"`。
- **沿用：** key 覆盖守卫、语言包一致性守卫（`criticalPathCoverage.test.ts`）、主进程文案表守卫（`src/main/i18n.test.ts`）；
  侧边问一句、分支两组单测随模块改名，断言的行为不变（无 Agent session 时拒绝、忙时拒绝、按用户的一轮截取、复制失败的各类原因）；
  类型检查兜住 IPC 通道、preload 桥接与其类型声明、渲染层 API 封装的一致改名。
- 引用了 `fork` 事件或被改 key 的组件测试同步更新。测试数据里作为对话标题出现的「新会话」等字样保持原样。

**工单 09–18 的测试**：全部落在已有接缝上。

- **文案复评（第 1、3、4、5 组）**：术语守卫兜住「没有禁用词」；整句措辞对照「文案复评修正」表在 diff 里审，不为每条写断言。
  点名审批按钮的工具文字由 `vaultScope.test.ts` 兜住（见上）。
- **守卫自测加一条（第 4 组）**：对真实词表断言，`session`、`sessions` 两个条目的替换建议都同时含 `chat`、`sign-in`、`import`。
- **拆出行为修复（第 5 组）**：`useAgentMode.resumeSteer.test.ts` 里测 `isBusy` 拦截的用例随行为修复移出；留下的错误码、按码选文案、
  插话按入口提示的用例不改断言，拆完后照样通过。
- **拒绝码收进 shared 类型（第 5 组，工单 18）**：只改类型，不加测试，类型检查就是守卫。实现时做一次性反向验证：
  主进程回码处写错一个码、文案表删掉一项、文案表多加一项，三种情况类型检查都要报错。
- **对话 id 改名（第 6 组）**：
  - 类型检查兜住 TS 层的改名（变量、参数、字段、函数签名）。
  - Vue prop 改名类型检查看不到（没开 `strictTemplates`），用连线断言兜住：
    - `Welcome.events.test.ts` 加断言（照已有写法读源码、不挂载）：`<TopNav`、`<SessionProjectChip` 开标签含 `:chat-sid="sid"`、不含 `:session-id`；
      `<AgentBrowserPane` 开标签仍含 `:session-id=`（指内核，没被误改）。
    - `TopNav.test.ts` 加一条（照已有挂载与桩）：给 `TopNav` 传 `chatSid`，断言 `SessionProjectChip`、`EditorStatusMonitor` 两个子组件收到同一个 `chatSid`。
    - `SessionProjectChip.test.ts`、`EditorStatusMonitor.test.ts` 改用 `chatSid` 挂载，断言的行为不变。
    - 排查中若还有别的 prop 改名，按同样方式给它的父组件补一条：能挂载的用挂载断言子组件收到的 prop，`Welcome.vue` 这类太大的读源码。
  - 其余用到改名标识符的单测只跟着改名，断言的行为不变。
- **给模型读的文字（第 7 组）**：断言这些文字的已有测试（如 `frontDesk.test.ts`、`sessionHealth.test.ts`）随文字一起改；
  「当前语音对话」标记的断言不动。完成标准是一次性检索加两条本机手动验证（见同名一节），不加永久守卫。
- **边界文档注释（第 8 组）**：只改注释，不写测试；完成标准是一次性检索。

## Out of Scope

- 侧边问一句关窗后被存进侧边栏的 bug（尚未建单）。
- 另开 PR（不进本 PR）：
  - **行为修复 fix PR**：续跑判忙改用 `isBusy`、对话忙时「接着跑」不被摘掉，连同测试，从 `2a288ba` 拆出；基于本 PR，描述注明依赖。
  - **用户手册 PR**：`website/`（约 95 处 / 21 个文件，含原样引用的界面文字、`#minichat` 锚点、46 张截图），紧接本 PR 提出。
    在那之前手册会指向已不存在的按钮。
  - **品牌类型 PR（以后）**：把 `ChatSid` / `AgentSessionId` 留在代码里防传错 id，由上游决定；本 PR 只在排查时临时使用。
  - **给模型读的文字守卫 PR（以后）**：第 7 组只做了一次性清理，会持续回退——第 7 组改掉的约 66 行（不含测试）里，8 行是上游在首发（09-18）后两周内 3 个功能提交新写进来的（按改动前 `git blame` 归属，排除首发时已含旧词的行），约每周 4 行；10-08 上游又新写了一处（`generate_speech`）。
    守卫按 AST 提取 `src/main` 字符串字面量、按调用方排除日志（原型是 `.scratch/chat-terminology/scripts/g7-strings.mjs`），扫 `resources/skills/**`。
    由上游决定：约 10 处正当用法（工单 15 一次性检索归类的 MCP、PIE / 编辑器、引擎会话与会话记录、`toolSearch` 检索同义词）改写还是进白名单
    ——前者与第 7 组「例外：其他领域的会话不改」相冲，后者与用户故事 24「零容忍、不带基线」相冲；检查脚本是否迁进仓库。
  - **导入错误本地化 PR（以后）**：资产导入其余失败（`ResumeImportService.ts` 中没有 `errorKey` 的返回）仍显示主进程或服务器原文，英文界面可能出现中文；补全错误码另提。
- 守卫的覆盖面不扩：只扫三份文案来源；第 7 组一次性清理的文字（工具文字、语音指令、`resources/skills/**`、经 `{error}` 显示的报错）不进守卫。
- `packages/cli/skills/**` 的技能文本（CLI 的技能，不是应用内模型读的）。
- 主进程拼好、经 `{error}` 等占位符显示的报错，除第 5 组改走错误码的几条（资产导入四条、续跑与插话被拒）外，不改返回形状；
  里面指对话的「会话」由第 7 组换词。
- 开启 `strictTemplates`：影响整个渲染层，prop 与事件的连线由连线断言兜住。
- 代码改名之外的对象层改名（`ChatSession` → `Chat`、`ReattachedSession`、`adoptRunningSession`、语音连接的 `session` 变量）、改名 `sid`、
  引入 `chatId`、改内核与导入的 `sessionId`。
- 主进程注释里不指对话的「会话」不整体改写，靠 `CONTEXT.md` `session` 词条的存量注释读法读对；只在约定读不对的地方逐处写明（如「agent 会话」），
  以及用了 `CONTEXT.md` _Avoid_ 里的词、且同一文件已有正确写法的地方（如「会话分支」「侧边对话」「用户回合」）。
  测试文件里的注释和测试标题不改，点名被改标识符的、以及「范围」一节列出的两个改名模块的测试除外。
- 守卫的通用例外机制（UE / MCP 语境的 session 白名单）。
- 已存下的旧默认标题（`AI会话`、`快速对话`、`Unnamed Session`、`Quick chat`）不改写，显示时也不替换：
  回到这条对话发下一条消息时自动起名，不再使用的保持原样，直到被删除或归档。
- 已存进历史消息的「会话已中断（页面刷新）」不改写。
- 给实时语音模型的「当前语音对话」标记，四个文件成对保留原样：`voiceAssistant.ts` 交给 `listSessions` 的标签「【当前语音对话】」、
  `src/main/ai/realtime/frontDesk.ts` 的 `VOICE_INSTRUCTIONS`，以及断言它们的 `voiceAssistant.test.ts`、`frontDesk.test.ts`。
  模型靠这串字面量找到通话绑定的那条对话，只改一处它就找不到了。
- 「项目」与「工程」混用；`CONTEXT.md` 的「笔记本」与界面「知识库」不一致。
- 团队模式里的「一轮」（英文 round）与对话「一轮」同名。
- 本地「导入任务」与网络库「这次导入」是否同一概念。
- 英文默认名 "Untitled X" 与 "Unnamed X" 的全局不一致（本次只处理对话这一条）。
- 侧边问一句横幅改为显示主对话标题。
- 审批放行名单的持久化：放行名单重启、分支、切到 Ask 模式后失效，行为保持不变；按钮文案因此不写「始终」。
- 小窗设置区是否重新开放（本次只改它被隐藏的文案）。
- Spotlight 的命名。
- 团队模式资产锁报错「正被**队友**改着」没有被 `errorSignature.ts` 的环境类规则匹配（上游存量，与术语无关，另报）。

## Further Notes

- 01–08、02b 与第 5 组的已实现部分保留在本 spec 里，作为这些提交的验收依据，组装 PR 时解冲突也以它为准。
- 第 6 组的排查清单与第 7、8 组的检索结果是工单的交付物，放在 `.scratch/chat-terminology/` 下，供审阅时对照，不进 PR。
