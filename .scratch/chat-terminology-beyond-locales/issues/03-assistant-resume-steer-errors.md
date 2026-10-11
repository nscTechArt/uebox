# 03: 续跑、插话被拒时的提示

Status: done
Blocked by: None（随 `chat-terminology` 的 PR 提交，与 02 同在第 5 组，见其 spec「提交 PR」）

依据：`01-scope-terminology-beyond-locales.md` ① 的结论；术语见根目录 `CONTEXT.md`（对话、一轮）。
行号是 `f263072` 时的快照，按文字搜索为准。

## 问题

**续跑。** 某一轮报错后气泡上有「接着跑」。同一条对话又开始了新的一轮之后再点它：

- 新一轮在本窗口跑：`resumeAgent` 开头 `isStreaming` 判忙直接 return，而 `Welcome.vue` 的 `handleBubbleAction`
  在调用前已经 `clearActionButtons` —— 按钮消失，什么也不发生，之后也再续不了。
- 新一轮在别的窗口跑，或已 `done` 未 `released`：`isStreaming` 为假，请求发到主进程，
  `src/main/ipc/agentV3.ts:2307` 回 `会话 {id} 正在执行中`，**不带** `code`，原文进气泡「续跑失败：…」和 toast。
  `execute`（`:1807`）同样的拒绝带 `code: 'SESSION_BUSY'`，已映射为 `assistant.agentMode.sessionBusy`；
  `agentStream.ts` 的 `isBusy` 正是为这两个空档写的，发送和排队都用它，续跑漏了。
- `useAgentMode.ts` 的 `resumeAgent` 里「从断点继续执行…」「续跑失败：」写死中文，英文界面也显示中文。

**插话。** `agentV3.ts:3227`、`:3287` 在这一轮已结束时回 `没有正在执行的会话`，不带 `code`，`steerAgent` 原样塞进
`steerFailed`「插话失败：{reason}」。两个入口失败后的实际结果不同：

- 输入框插话（`Welcome.vue` 的 `handleComposerSteer`）：文字和附件放回输入框。提示大意对，用词不对。
- 排队消息点「立即发送」且这一轮在跑（`handleSteerQueuedFollowUp`）：消息留在队列，`released` 后被
  `followUpDelivery` 当作下一条发出。提示说「失败」，与实际相反。

`:3243` 是另一种拒绝：快照所在的工程和正在跑的这一轮不一致。原文是主进程拼好的中文（英文界面也显示中文），
结尾写死了「先让它跑完，这条会按原来的工程发出去」—— 只对排队那条路成立；输入框那条路内容是放回输入框，不会自动发。

## 做法

**续跑**

1. `agentV3.ts` 的 `agent-v3:continue` 忙碌分支改为与 `execute` 相同的形状：`{ success: false, code: 'SESSION_BUSY', error: … }`；
   `src/preload/index.d.ts` 里 `continue` 的返回类型加 `code?: string`。
2. `Welcome.vue` 的 `handleBubbleAction`：在 `clearActionButtons` **之前**用 `agentStreamStore.isBusy(sid.value)` 判忙；
   忙就 `message.info(t('assistant.agentMode.sessionBusy'))` 并 return，**按钮留着**。
3. `resumeAgent` 开头的判忙由 `isStreaming` 改为 `isBusy`（防线，调用方已拦）。返回 `success: false` 的分支用
   `describeStartupError({ message: result?.error, code: result?.code }, t, t('assistant.agentMode.agentExecFailed'))`
   得出 `reason`（它收的是 `{ message, code }`），不再直接用 `result.error`。
4. 两句写死的中文改走语言包（`assistant.agentMode` 下，新 key，加前先确认不重名）：

   | key | zh-CN | en-US |
   |---|---|---|
   | `resumeProgress` | 从断点继续执行… | Resuming from where it stopped… |
   | `resumeFailed` | 续跑失败：{reason} | Couldn't resume: {reason} |

**插话**

5. `agentV3.ts` 的 `agent-v3:steer`，`error` 原文都保留（调试台和日志读它）：
   - `:3227`、`:3287` 加 `code: 'NOT_RUNNING'`。
   - `:3243` 加 `code: 'PROJECT_MISMATCH'` 和 `errorParams: { snapshotProject, runProject }`，值是两个工程名的原值（可能为空串，
     不在主进程填「另一个工程」）。
   - `index.d.ts` 里 `steer` 的返回类型加 `code?: string`、`errorParams?: { snapshotProject: string; runProject: string }`。
6. `useAgentMode.ts` 的 `steerAgent` 加第 6 个参数，表示「被拒时调用方怎么处理这条话」：
   ```ts
   /** 'restored'：放回输入框；'queued'：留在队列，等这一轮释放后照常发出 */
   ifRejected: 'restored' | 'queued' = 'restored'
   ```
   `NOT_RUNNING`、`PROJECT_MISMATCH` 按 `code` × `ifRejected` 从下表四条里选一条（`message.info`），工程名为空时代入
   `steerOtherProject`；其余失败照旧走 `steerFailed`。返回值不变（仍是 `false`）。
   `handleSteerQueuedFollowUp` 传 `'queued'`，`handleComposerSteer` 用默认值；`editorSnapshotWiring.test.ts` 里断言
   `steerAgent(` 调用原文的那条随之更新。
7. 语言包（`assistantInputComposer` 下，挨着 `steerFailed`）：

   | key | zh-CN | en-US |
   |---|---|---|
   | `steerTurnEndedRestored` | 这一轮刚好结束了，插话没送进去，内容已放回输入框 | This turn just finished, so the message wasn't added. It's back in the input box. |
   | `steerTurnEndedQueued` | 这一轮刚好结束了，这条会作为下一条消息发出 | This turn just finished. This message will be sent as the next one. |
   | `steerProjectMismatchRestored` | 这条插话抓的是「{snapshotProject}」，正在跑的这一轮在「{runProject}」上，没有送进去，内容已放回输入框 | This message was captured in "{snapshotProject}", but the running turn is working in "{runProject}". It wasn't added and is back in the input box. |
   | `steerProjectMismatchQueued` | 这条插话抓的是「{snapshotProject}」，正在跑的这一轮在「{runProject}」上。这一轮结束后，它会按「{snapshotProject}」发出 | This message was captured in "{snapshotProject}", but the running turn is working in "{runProject}". It will be sent for "{snapshotProject}" after this turn finishes. |
   | `steerOtherProject` | 另一个工程 | another project |

## 不做

- 语音插话（`voiceAssistant.ts` 的 `onSteer`）：只看 `success`，不显示原文，不受影响。
- 调试台（`AgentV3DebugPanel.vue`）照旧打印原文。

## 完成标准

- [x] 主进程测试：`agent-v3:continue` 忙碌时返回 `code: 'SESSION_BUSY'`；`agent-v3:steer` 没有在跑的一轮时返回 `code: 'NOT_RUNNING'`（两处各一例；`:3287` 需在等待上传期间让这一轮结束）；工程对不上时返回 `code: 'PROJECT_MISMATCH'` 和两个工程名
- [x] `handleBubbleAction` / `resumeAgent`：`isBusy` 为真（含只在 `busyElsewhere`、只在 `awaitingRelease` 两种）时不调用 `agentV3.continue`、按钮仍在、提示 `sessionBusy`
- [x] `resumeAgent`：主进程回 `SESSION_BUSY` 时气泡与 toast 是 `sessionBusy` 文案，不含 sessionId
- [x] `steerAgent`：`NOT_RUNNING`、`PROJECT_MISMATCH` 各在 `'restored'` / `'queued'` 下出对应文案（四例），工程名为空时代入 `steerOtherProject`；其他失败仍是 `steerFailed`
- [x] 术语守卫、`usedKeyCoverage.test.ts` 通过；`useAgentMode.ts` 里不再有「从断点继续执行」「续跑失败」字面量
- [x] `VERIFY_BASE=HEAD pnpm verify:changed` 通过
