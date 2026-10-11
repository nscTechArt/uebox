# 14: 对话 id 改名

Status: done
Blocked by: 13（且清单已由人审过）
组：第 6 组（代码改名：对话 id）

依据：`../spec.md`「代码改名：对话 id（第 6 组）」与「新增工作的测试」中第 6 组一条；13 的排查清单；术语见根目录 `CONTEXT.md`。

**What to build:** 读代码的 agent 在渲染层里一看名字就知道是哪种 id：指对话的都叫 `chatSid`（或 `sid`），剩下的 `sessionId` 只指内核或导入。
`Welcome.vue` 传给子组件的对话 id 不再和内核 id 同叫 `session-id`。只改名，行为不变，持久化与 IPC 不变。

- [x] 清单里归为「对话 → 改名」的每一行改为 `chatSid`；归为内核、导入、保留的不动
- [x] `TopNav`、`SessionProjectChip`、`EditorStatusMonitor` 的 prop 改为 `chatSid`，父组件模板改为 `:chat-sid`；
  `AgentBrowserPane` 的 `:session-id`（内核）不动
- [x] 连线断言：`Welcome.events.test.ts` 断言 `<TopNav`、`<SessionProjectChip` 开标签含 `:chat-sid="sid"`、不含 `:session-id`，
  `<AgentBrowserPane` 仍含 `:session-id=`；`TopNav.test.ts` 加一条，断言两个子组件收到同一个 `chatSid`；
  清单里若有别的 prop 改名，按 spec 同样方式补断言
- [x] `SessionProjectChip.test.ts`、`EditorStatusMonitor.test.ts` 改用 `chatSid` 挂载，断言的行为不变；其余测试只跟着改名
- [x] `CONTEXT.md` 写入 spec 里的 id 命名规则
- [x] 改名后重跑 13 的同一检索，剩下的每处命中都是清单里归为内核、导入或保留的行
- [x] `src/` 下 `:session-id="sid"` 零命中；渲染层类型检查通过；相关测试通过
- [x] 提交信息标明「第 6 组」，只含第 6 组的改动
