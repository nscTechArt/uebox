# uebox — 虚幻盒子命令行

从终端调用虚幻引擎能力。给外部 Agent（Codex、Claude Code 等）、自动化脚本和 CI 用。

English TL;DR: `uebox` is a standalone CLI that connects to a running Unreal Box over local
loopback. `uebox tools call` runs one of the box's tools; `uebox ask` hands a whole task to
the box's own agent. Read-only unless you pass `--allow-write`. No setup step. Exit codes
are meaningful; `--json` prints exactly one JSON object on stdout. Full help:
`uebox --help --lang en-US`.

## 它是什么

```
你 / Agent  →  uebox  →  虚幻盒子  →  UnrealAgentLink 插件  →  虚幻编辑器
```

`uebox` 自己不连引擎。它把命令交给正在运行的虚幻盒子，盒子再发给打开着的编辑器。
所以用它之前，盒子要开着。

两种用法：

- **`tools call`**：调盒子的某一个工具，零件照原样递过去。你知道每一步该调什么时用。
- **`ask`**：把一句话交给盒子自己的 Agent，它想步骤、做完、交回结论。给脚本和批处理用。

和 [MCP](../../website/guide/mcp.md) 的分工：MCP 把工具交给自己有大脑的客户端；CLI
多一个 `ask`，而且不用把一百多个工具的说明常驻在调用方的上下文里。

**默认只读。** 想改东西要在命令上显式加 `--allow-write`。命令行这一头没有审批弹窗，
一条命令下去就直接执行了，所以那个开关就是顶替弹窗的那一下。

## 前提

1. 虚幻盒子正在运行（对外服务默认开着，除非你在「MCP」设置里关过）；
2. 要执行引擎命令时：目标 UE 工程已打开，且 UnrealAgentLink 插件握手完成。

列工具、看帮助不需要引擎在线。

## 上手

```bash
uebox doctor
```

不用先配置。CLI 每次运行都去读盒子自己那份配置文件：装机版用自己所属的那个盒子；
开发环境里只装了一个就用它。它不复制令牌，盒子里重置令牌之后什么都不用改。

盒子装在非常规位置、或者开发版和正式版同时装着时，显式指定：

```bash
uebox doctor --config "C:\Users\你\AppData\Roaming\unreal-box\mcp-server.json"
```

或者设环境变量 `UEBOX_HOST_CONFIG`。

`doctor` 逐层检查连接、接口契约、工具范围、工程注册。卡在哪一层就报哪一层，每条失败
都带能照着做的下一步。**不要在每条命令前都跑它** —— 那是一次体检，不是 ping。

## ask

```bash
uebox ask "列出当前关卡里所有点光源和它们的强度"
uebox ask "把所有点光源的强度调低一半" --allow-write --json
```

背后是盒子的 `task` 工具，不带历史对话。四条规矩：

- **默认只读。** 不加 `--allow-write` 时，子任务的清单里根本没有写工具。
- **范围固定。** 只碰引擎、素材库、工程库。shell、本地文件、浏览器、第三方 MCP、
  盒子自身的管理一律不给 —— 外部会话里子任务每一步都是自动批准的，没人盯着的时候
  这些出了错没有回头路。
- **进度打在 stderr。** 结论在 `data.answer`，末尾那行写操作清单是记账记出来的。
- **`--timeout` 算的是多久没有进度**，不是总时长。一直在汇报的长任务不会被判超时。

用的是盒子里配置的模型，费用记在那个模型的账上。

`uebox tools call task` 会被拒绝：直接调不带上面的范围限制。

## tools

```bash
uebox projects list --json
uebox tools list --search blueprint --json
uebox tools show ue_get_actor --json
uebox tools call ue_get_selection --json
uebox tools call ue_get_actor --args-file ./query.json --json
uebox viewport screenshot --output ./artifacts/viewport.png --json
```

判据一句话：**盒子自己的 AI 助手能用的，这里加 `--allow-write` 都能调** —— 搜素材库
（`search_assets`）、把素材库资产导进工程（`project_manage`）、整理工程库
（`project_organize`）都在里面。

复杂参数写成 JSON 文件用 `--args-file`，可以躲开各家 shell 的引号差异；写 `-` 表示从
标准输入读。

非要在 `--args` 里直接写 JSON 的话，**裸 JSON 在 Windows 两个 shell 里都不成立** ——
引号会被吃掉，然后报一个「不是合法 JSON」的错，而你看着自己写的明明是合法 JSON。
实测可用的形式：

```powershell
uebox tools call ue_get_actor --args '{\"name\":\"Floor\"}'
```

```bat
uebox tools call ue_get_actor --args "{""name"":""Floor""}"
```

## 写操作

核实看工具自己的返回值：盒子的工具报成功之前会回读引擎（仓库的硬规矩）。生成 Actor
时名字被占用，回执会写明改用了哪个名字。

超时不报成功也不报失败，退出码 7、结局不明。**不要直接重发** —— 先用只读工具查清楚。

### 撤销

```bash
uebox tools call ue_undo --args '{"steps":1}' --allow-write
```

**一定带 `steps`。** 不带就是把整条 agent 撤销栈全撤 —— 连盒子里 AI 的改动一起。

**不要在编辑器里按 Ctrl+Z。** CLI 的写入落在一条**独立的 agent 撤销栈**上，事务一结束
编辑器就换回了它自己的栈 —— 所以 Ctrl+Z 撤的是**你自己上一步手动操作**，CLI 那一步纹丝
不动。

两件要知道的：**撤销只改编辑器内存里的内容**，要在编辑器里保存一次才落盘；这条栈是盒子
内的 AI 和 CLI 共用的，中间若有别的写入，撤掉的可能不是你那一步。
`uebox tools call ue_undo_history` 是只读的，先看一眼栈。

## 目标工程怎么定

1. 显式 `--project`（`.uproject` 文件或它所在目录都行）
2. 从当前目录逐层往上找最近的 `.uproject`
3. 都没有时，**只有恰好一个**工程在线才自动采用

前两种方式定出来的工程如果没连着，命令会失败，**不会改发给另一个在线的工程**。
静默发错工程的代价是你另一个项目的关卡被改了，而命令还报了成功。

同时开多个工程时，每条命令都带 `--project`。`ask` 在一个工程都没连着时照跑，
只是碰不到引擎。

## 输出与退出码

`--json` 时 stdout 只有一个 JSON 对象加一个换行，成功失败都一样：

```json
{
  "schemaVersion": 1,
  "ok": true,
  "project": { "name": "Demo", "path": "D:/Games/Demo" },
  "data": { "...": "..." },
  "artifacts": [],
  "warnings": []
}
```

`data` 和 `error` 互斥；`artifacts`、`warnings` 永远是数组。进度和诊断走 stderr。

| 退出码 | 含义                                                                                                                           |
| ------ | ------------------------------------------------------------------------------------------------------------------------------ |
| 0      | 完成。查询结果为空也算成功                                                                                                     |
| 2      | 命令、参数或输出位置要改                                                                                                       |
| 3      | 配置或认证不对（`CONFIG_MISSING` 找不到 / `CONFIG_UNREADABLE` 读不了 / `CONFIG_INVALID` 内容坏或有两个盒子 / `AUTH_FAILED` 令牌不对） |
| 4      | 盒子不可达，或版本太旧不支持 CLI 契约                                                                                          |
| 5      | 定不下唯一的目标工程                                                                                                           |
| 6      | 写工具但没加 `--allow-write`，或工具超出范围                                                                                   |
| 7      | 超时 —— **先核实现场，不要直接重发**                                                                                           |
| 8      | 引擎操作失败，或文件没交付                                                                                                     |
| 130    | 用户中断。**不代表引擎已经撤销了操作**                                                                                         |

## `null` 是「不知道」，不是「零」

旧版本的 UnrealAgentLink 插件不报某些字段（比如选中 Actor 的总数）。这些字段回来是
`null`。把 `null` 读成 `0`，等于把「我不知道」变成一个自信的错误结论。

## 自动化环境

```bash
UEBOX_URL=http://127.0.0.1:17861/ UEBOX_TOKEN=... uebox projects list --json
```

两个必须成对给（只给一个是配置错误，不会去文件里补另一半），只接受本机回环地址，
只在进程内使用、不落盘。

## 给 Agent 用的 Skill

`skills/uebox/` 下有一份可选安装的 Skill，教外部 Agent 使用流程：什么时候跑 `doctor`、
怎么定工程、什么时候用 `ask`、退出码怎么读、超时之后该干什么。它不是运行前提，CLI
可以独立使用。

**不要**把它装进虚幻盒子自己的 Agent —— 那个 Agent 手上直接有这些工具，教它绕到命令行
是绕远路，还会占它的上下文。

## 已知限制

- 盒子的「MCP」设置里没勾「同时开放写操作工具」时，写工具根本不在清单里 ——
  `uebox doctor` 会说破。
- 要求逐次人工审批的工具（目前是 `browser_interact`、`connect_mcp_server`）不给调。
- 只有一问一答，没有连续对话：`ask` 每次都从零开始，不记得上一次说过什么。
- 截图的明暗只有在场景**锁了手动曝光**时才可信（`data.exposure` 为 `manual`）；
  自动曝光下截图、视口、游戏各自收敛，先锁再判断过曝/欠曝。东西在不在、位置、
  材质颜色、灯亮没亮任何时候都准。
- 依赖盒子和虚幻编辑器在**同一台机器**上（截图要从本地磁盘读回原图）。
- Windows 是首个正式验收平台。
