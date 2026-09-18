# uebox — 虚幻盒子命令行

从终端调用虚幻引擎能力。给外部 Agent（Codex、Claude Code 等）、开发者和自动化脚本用。

English TL;DR: `uebox` is a standalone CLI that connects to a running Unreal Box over local
loopback and drives the open Unreal Editor through it. One command, one process, one MCP
session. This version is read-only. Exit codes are meaningful; `--json` prints exactly one
JSON object on stdout. Full help: `uebox --help --lang en-US`.

## 它是什么

```
你 / Agent  →  uebox  →  虚幻盒子  →  UnrealAgentLink 插件  →  虚幻编辑器
```

`uebox` 自己不做任何模型推理，也不直接连引擎。它把命令交给正在运行的虚幻盒子，
盒子再发给打开着的编辑器。所以用它之前，盒子要开着。

**默认只读。** 想改东西要在命令上显式加 `--allow-write`。加了之后，**盒子自己的
AI 助手能用的工具这里都能调** —— 包括搜素材库、把素材库资产导进工程、整理工程库。
命令行这一头没有审批弹窗，一条命令下去就直接执行了，所以那个开关就是顶替弹窗的
那一下 —— 见下面「写操作」。

## 前提

1. 虚幻盒子正在运行（对外服务默认开着，除非你在「MCP」设置里关过）；
2. 要执行引擎命令时：目标 UE 工程已打开，且 UnrealAgentLink 插件握手完成。

列工具、看帮助不需要引擎在线。

## 上手

```bash
uebox --version
uebox setup
uebox doctor
```

`setup` 会在本机已知位置找盒子的配置文件，验证能连上，然后**只记住那个文件的路径**。

它不复制令牌：盒子里重置令牌之后，CLI 什么都不用改，下次运行会去读新的。找不到配置时
它会说找不到并让你显式指定，不会挑一个看着像的文件然后报成功：

```bash
uebox setup --host-config "C:\Users\你\AppData\Roaming\unreal-box\mcp-server.json"
```

`doctor` 逐层检查配置、认证、接口契约、工具范围、工程注册。卡在哪一层就报哪一层，
每条失败都带能照着做的下一步。**不要在每条命令前都跑它** —— 那是一次五层体检，不是 ping。

## 常用命令

```bash
uebox projects list --json
uebox selection get --json
uebox actors list --name Cube --json
uebox viewport screenshot --output ./artifacts/viewport.png --json
```

其他能力先找再用：

```bash
uebox tools list --search blueprint --json
uebox tools show ue_get_actor --json
uebox tools call ue_get_actor --args-file ./query.json --json
```

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

```bash
uebox actors spawn  --name Box1 --asset StaticMeshActor --location 0,0,50 --allow-write
uebox actors move   --name Box1 --location z=200 --allow-write
uebox actors delete --name Box1 --allow-write
```

`--location` 既接受 `x,y,z` 三个数，也接受 `z=200` 这种只设一个分量的写法（其余保持
原值）；`--rotation` 是度，`--scale` 是倍数。

**这三条加上下面的 `actors undo`，是加强档。** 其余工具走
`uebox tools call <name> --allow-write`：搜素材库
（`search_assets`）、把素材库资产导进工程（`project_manage`）、整理工程库
（`project_organize`）都在里面。判据一句话：**盒子自己的 AI 助手能用的，这里都能调**。
两条路的区别在核实：加强档由 CLI 自己回读核对，`tools call` 是原样转发，核实看
工具自己的返回值。

加强档的三条保证：

- **报成功之前一定回读。** 每条写命令返回前都会问一次引擎的当前状态，和请求逐项比对；
  对不上就报失败（退出码 8），哪怕工具那侧说它成功了。
- **超时不报成功也不报失败。** 超时是唯一会落到「结局不明」的路径。这时提示里会给一条
  能直接敲的回读命令，并说清楚查到/查不到各代表什么 —— 三条命令的读法不一样，
  删除是查不到才算成功。
- **生成前先查重名。** 引擎遇到重名会退让到 `Box1_1`，那样「Box1 在不在」就不再是有效
  判据。所以名字被占用时直接拒绝，不去生成。

### 撤销

```bash
uebox actors undo --allow-write
```

**不要在编辑器里按 Ctrl+Z。** CLI 的写入落在一条**独立的 agent 撤销栈**上，事务一结束
编辑器就换回了它自己的栈——所以 Ctrl+Z 撤的是**你自己上一步手动操作**，CLI 那一步纹丝
不动。按下去等于既没回退，还毁掉了自己的一次编辑。

`actors undo` 一次只撤一步，并且在撤销前后各读一次撤销栈：深度少一才算成功。只看深度不
够，所以栈顶标题也一并比对——这条栈是盒子内的 AI 和 CLI 共用的，中间若有别的写入，深度
差会骗人。

两件要知道的：**撤销只改编辑器内存里的内容**，磁盘上还是撤销前的样子，要在编辑器里保存
一次才落盘（返回里的 `affectedPackages` 就是待保存的那些）；用户自己手动做的操作不在这条
栈上，那些才该用 Ctrl+Z。

查栈不用开写：`uebox tools call ue_undo_history` 是只读工具。

## 目标工程怎么定

1. 显式 `--project`（`.uproject` 文件或它所在目录都行）
2. 从当前目录逐层往上找最近的 `.uproject`
3. 都没有时，**只有恰好一个**工程在线才自动采用

前两种方式定出来的工程如果没连着，命令会失败，**不会改发给另一个在线的工程**。
旁边有别的工程连着，不是把你的命令发给它的理由 —— 静默发错工程的代价是你另一个项目
的关卡被改了，而命令还报了成功。

同时开多个工程时，每条命令都带 `--project`。

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

| 退出码 | 含义                                                                                                                      |
| ------ | ------------------------------------------------------------------------------------------------------------------------- |
| 0      | 完成。查询结果为空也算成功                                                                                                |
| 2      | 命令、参数或输出位置要改                                                                                                  |
| 3      | 配置或认证不对（`CONFIG_MISSING` 没配过 / `CONFIG_UNREADABLE` 读不了 / `CONFIG_INVALID` 内容坏 / `AUTH_FAILED` 令牌不对） |
| 4      | 盒子不可达，或版本太旧不支持 CLI 契约                                                                                     |
| 5      | 定不下唯一的目标工程                                                                                                      |
| 6      | 工具超出本版范围                                                                                                          |
| 7      | 超时 —— **先核实现场，不要直接重发**                                                                                      |
| 8      | 引擎操作失败，或文件没交付                                                                                                |
| 130    | 用户中断。**不代表引擎已经撤销了操作**                                                                                    |

## `null` 是「不知道」，不是「零」

旧版本的 UnrealAgentLink 插件不报某些字段（比如选中 Actor 的总数）。这些字段回来是
`null`，命令还会附一条警告说明。把 `null` 读成 `0`，等于把「我不知道」变成一个自信的
错误结论。

`actors list` 同理：`returnedCount` / `totalCount` / `truncated` 三个数一起看。
`totalCount` 是 `null` 时无法判断有没有更多，**不要把返回条数当成总数**。

## 自动化环境

```bash
UEBOX_URL=http://127.0.0.1:17861/ UEBOX_TOKEN=... uebox projects list --json
```

两个必须成对给（只给一个是配置错误，不会去文件里补另一半），只接受本机回环地址，
只在进程内使用、不落盘。

## 给 Agent 用的 Skill

`skills/uebox/` 下有一份可选安装的 Skill，教外部 Agent 使用流程：什么时候跑 `doctor`、
怎么定工程、退出码怎么读、超时之后该干什么。它不是运行前提，CLI 可以独立使用。

**不要**把它装进虚幻盒子自己的 Agent —— 那个 Agent 手上直接有这些工具，教它绕到命令行
是绕远路，还会占它的上下文。

## 已知限制

- 用 `tools call` 写东西时 CLI 不替你核实：返回里没有 `verified` 字段，成败看工具自己
  报什么。要 CLI 替你回读就走 `actors` 那四条。
- 盒子的「MCP」设置里没勾「同时开放写操作工具」时，写工具根本不在清单里 ——
  `uebox doctor` 会说破。
- 要求逐次人工审批的工具（目前只有 `browser_interact`）和本机文件/shell 能力不给调。
- 截图这条路自己渲一帧，曝光比编辑器视口**偏暗一档**。可以判断东西在不在、位置、
  材质颜色、灯亮没亮；不要拿它判断整体过曝/欠曝。
- 依赖盒子和虚幻编辑器在**同一台机器**上（截图要从本地磁盘读回原图）。
- Windows 是首个正式验收平台。

