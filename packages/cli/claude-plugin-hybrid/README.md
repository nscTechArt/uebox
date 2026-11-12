# uebox-hybrid —— 在 Claude Code 里当 虚幻盒子 混合团队的制作人

制作人在 Claude Code 里（你自己登录的那个），队员是 虚幻盒子 里跑的模型，验收员是 Claude Code 里的
`uebox-acceptor` 子 Agent。设计稿：仓库里的 `docs/混合团队设计-2026-10-24.md`。

和同目录的 `claude-plugin`（uebox-team，队员也是 Claude Code 子 Agent）是两回事，**不要一起装**；
也不要同时装 `claude-plugin-mcp`：多一条完整的盒子连接，制作人手上就有了全套写工具。

## 准备

1. 虚幻盒子 开着，对外 MCP 服务开着、允许写操作（设置 → MCP → 共享引擎能力）。
2. 设置 → AI 里配好要招的队员模型。
3. `uebox` 命令行在 PATH 上（`uebox --version` 能跑）。三个 hook 都靠它。
4. 环境变量，两个都要设（`uebox` 命令行只给一个会报配置错误）：
   - `UEBOX_TOKEN`：对外服务的令牌（同一个设置页里复制）。
   - `UEBOX_URL`：`http://127.0.0.1:17861/`，端口改过就换成改过的。

## 启动

在一个空的工作目录里：

```bash
claude --plugin-dir <这个目录的路径> --permission-mode bypassPermissions --disallowedTools "Write Edit MultiEdit NotebookEdit"
```

`bypassPermissions` 让盒子工具不停下来问；hook 在这个模式下照样生效，守卫照拦。
进去后 `/mcp` 里只有 `uebox-producer` 一条盒子连接，16 个工具：`team_*`（含 `team_approve`）、`project_manage`、`project_list`、`ue_session_health`。

## 插件里有什么

| 部分 | 作用 |
| --- | --- |
| `.mcp.json` | 制作人的盒子连接：请求头 `X-Unreal-Box-Profile: producer` 选精简工具集；`timeout` 660 秒，`team_wait` 才等得住 |
| `agents/uebox-acceptor.md` | 验收员。自己开一条普通连接，以 `acceptor` 进门，只读，记下 PASS / FAIL / BLOCKED |
| `hooks` · PreToolUse | `uebox team guard --hook`：不许改文件；Bash 只许单条 `uebox …`；子 Agent 只许 `uebox-acceptor`；不许用别的盒子连接 |
| `hooks` · Stop | `uebox team gate --hook`：队员还在干活或有话没看时让制作人 `team_wait`；没过验收提醒两次；放行时盒子把制作人标成收工 |
| `hooks` · UserPromptSubmit | `uebox team round --hook`：新一轮清零，把你这句话交给盒子（给验收员看），任务板上没动的旧账加进上下文 |

## 用

跟制作人说要做什么。它会 `team_open` 开团队，跑一次 `uebox team use <团队 id>`（hook 靠它找团队），
`project_manage` 开或建工程，`team_hire` 招人，`team_send` 派活、`team_wait` 等结果，最后起
`uebox-acceptor` 验收。进度、模型、用量在盒子的「外部团队」页上看。队员默认全放行，
盒子不弹框；开团队时 `approval_mode: producer` 则改为把不可逆的操作发给制作人用 `team_approve` 批。

想一次等满 10 分钟，再设 `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=660000`（Claude Code 对 HTTP 的 MCP 调用
5 分钟没动静就掐）；不设的话 `team_wait` 默认每次等 280 秒，照样能用。
