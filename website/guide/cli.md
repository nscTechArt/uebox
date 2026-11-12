# 命令行 uebox

从终端或脚本操作虚幻引擎，供自动化流程和外部 Agent 使用。

前提：

- 虚幻盒子正在运行，并且 设置 → MCP 里的「开放给外部客户端」开着（默认开）。
- 引擎类命令还要求目标 UE 编辑器已打开并完成插件握手。`tools list` 和 `--help` 不要求。

命令只有七条：`ask`、`doctor`、`projects list`、`tools list`、`tools show`、`tools call`、`viewport screenshot`。早期版本的 `setup`、`actors`、`selection` 命令已删除，改用 `tools call`。

## 安装

随 Windows 和 macOS 安装包分发，不需要单独安装，也不需要配置。它每次运行时读取盒子自己的配置文件，不复制令牌，盒子里重置令牌后无需改动。

**设置 → 命令行** 显示程序位置，可以复制路径或在文件夹中显示。旁边有「**加入 PATH**」，开启后新开的终端可以直接敲 `uebox`。这一项只影响当前用户，随时可以关掉。

![设置 → 命令行](/shots/settings-cli.png)

Linux 包不带命令行工具。

## 先跑一条

```bash
uebox doctor
```

逐层检查：连接 → 接口契约 → 工具范围 → 工程注册，并指出卡在哪一层，每条失败附带下一步。加 `--project <path>` 可同时确认指定工程是否可作为目标。

`doctor` 是一次体检，不用在每条命令前运行。

## 两种用法

| 用法                      | 适合                                 |
| ------------------------- | ------------------------------------ |
| `uebox ask "<要做的事>"`  | 一句话交给盒子的 Agent，由它决定步骤 |
| `uebox tools call <工具>` | 你知道要调哪个工具，自己控制每一步   |

## ask：交给盒子的 Agent

```bash
uebox ask "列出当前关卡里所有点光源和它们的强度"
uebox ask "把所有点光源的强度调低一半" --allow-write
```

| 规则        | 说明                                                                                                |
| ----------- | --------------------------------------------------------------------------------------------------- |
| 默认只读    | 子任务的工具清单里没有写工具。加 `--allow-write` 才放开改动                                         |
| 范围固定    | 只碰引擎、素材库和工程库。shell、本地文件、浏览器、第三方 MCP 不提供，加了 `--allow-write` 也不提供 |
| 模型与费用  | 默认用盒子里配置的模型；盒子里配了多个模型时，可用 `--model <id>` 指定，费用记在实际用的模型上      |
| 进度与结论  | 进度输出到 stderr；结论在 `data.answer`，末尾一行写操作清单由盒子按实际调用记录生成                 |
| `--timeout` | 按**多久没有任何进度**计算，不是总时长。持续汇报进度的长任务不会超时                                |
| 无历史对话  | 每次 `ask` 从零开始，不记得上一次的内容                                                             |

`tools call task` 会被拒绝，派子任务请用 `ask`。

## tools：调用单个工具

```bash
uebox projects list                   # 已注册且在线的工程
uebox tools list                      # 可调用的工具
uebox tools list --search material    # 按名字或描述筛
uebox tools list --allow-write        # 连写工具一起列
uebox tools show <name>               # 某个工具的完整描述和参数定义
uebox tools call ue_get_selection     # 编辑器当前选中/打开的内容
uebox tools call search_assets --args-file args.json
```

判定规则：**应用内 AI 助手可用的工具，在 CLI 中加 `--allow-write` 均可调用。** 素材库搜索、工程库管理、将素材库资产导入工程都在内。两类除外：要求逐次人工审批的工具（目前是 `browser_interact`、`connect_mcp_server`），以及派子任务的 `task`（请用 `ask`）。

工具名也可以用 `--name <tool>` 传入，位置参数不方便传时使用。

`--args` 中直接写 JSON 需要按所在 shell 转义，未转义的引号会被 shell 去掉：

```bash
# PowerShell
uebox tools call ue_get_actor --args '{\"name\":\"Floor\"}'
```

```bash
# cmd
uebox tools call ue_get_actor --args "{""name"":""Floor""}"
```

也可以使用 `--args-file <文件>`，或 `--args-file -` 从标准输入读取。

## 截图

```bash
uebox viewport screenshot --output shot.png
```

| 选项                   | 说明                                          |
| ---------------------- | --------------------------------------------- |
| `--output <path>`      | **必填**，只接受 `.png`，相对路径按当前目录算 |
| `--world auto\|editor` | 默认 `auto`，PIE 在跑就拍游戏世界             |
| `--overwrite`          | 允许覆盖已存在的文件                          |

文件落地前核验 PNG 格式与尺寸，核验不通过则以非零码退出。

**明暗只有在场景锁定手动曝光时才可信**（`data.exposure` 为 `manual`）。自动曝光下，截图、视口、游戏各自收敛亮度，要判断过曝或欠曝，先锁定曝光。物体是否存在、位置、材质颜色、灯是否亮着，任何时候都可信。

## 安装共享技能

```bash
uebox skills add ue-level-organize
uebox skills add uebox.ai/s/ue-level-organize
```

从官网共享库安装技能。盒子会弹出确认框显示全文，点「安装」后才写入；命令一直等到你做出选择，最长 10 分钟。取消不算失败：退出码为 0，`data.installed` 为 `false`。详见[共享技能](./tools-and-skills#共享技能)。

## 改东西

写操作都要加 `--allow-write`。

命令行没有审批弹窗，`--allow-write` 相当于那一下确认。

另外，设置 → MCP 里「外部客户端的权限」默认是可写。如果被改成只读，写工具不会出现在工具清单里，`uebox doctor` 会指出这一点。

核实以工具自己的返回值为准：盒子的工具报告成功之前会回读引擎。生成 Actor 时名字被占用，回执会写明改用了哪个名字。

::: warning 超时不要直接重发
请求可能已经生效。先用只读工具（`ue_get_actor`、`ue_content_search`）查清楚，再决定要不要重发。
:::

### 撤销

```bash
uebox tools call ue_undo --args '{"steps":1}' --allow-write
```

**一定带 `steps`。** 不带会撤销整条 agent 撤销栈，包括盒子里 AI 做的改动。

CLI 的写入落在独立的 agent 撤销栈上，编辑器里按 `Ctrl+Z` 撤销的是你自己手动做的上一步，**撤不掉 CLI 做的这一步**。

- 撤销只改编辑器内存里的内容，需要在编辑器里保存才落盘。
- 这条栈由盒子里的 AI 和 CLI 共用，中间有别的写入时，撤掉的可能不是你那一步。`uebox tools call ue_undo_history` 是只读的，可以先查看。

## 目标工程怎么定

按这个顺序：

1. `--project` 指定的
2. 从当前目录逐层往上找到的最近的 `.uproject`
3. 前两步都没有时，**恰好只有一个工程在线**才用它

前两步定出来的工程如果没连着，命令直接失败，**不会改发给别的在线工程**。同时开着多个工程时，每条命令都带 `--project`。`ask` 在没有任何工程连着时也能运行，只是碰不到引擎。

## 公共选项

| 选项                  | 说明                                                               |
| --------------------- | ------------------------------------------------------------------ |
| `--json`              | stdout 只输出一个 JSON 对象，诊断走 stderr                         |
| `--project <path>`    | 目标工程，`.uproject` 文件或其所在目录                             |
| `--allow-write`       | 允许这条命令改动工程                                               |
| `--model <id>`        | `ask` 用哪个模型，盒子里配了多个模型时才能选                       |
| `--timeout <秒>`      | 整条命令的期限，默认 **120**；`ask` 算的是多久没有进度             |
| `--lang zh-CN\|en-US` | 帮助与提示的语言                                                   |
| `--config <path>`     | 盒子装在非常规位置时，指定它的配置文件；也可设 `UEBOX_HOST_CONFIG` |
| `-h, --help`          | 完整帮助                                                           |
| `-v, --version`       | 版本号                                                             |

公共选项写在子命令前面或后面都行。

## 退出码

脚本靠它决定下一步：

| 码    | 含义                                                 |
| ----- | ---------------------------------------------------- |
| `0`   | 成功                                                 |
| `2`   | 参数或输出位置要改                                   |
| `3`   | 配置或认证                                           |
| `4`   | 应用不可达，或版本不支持                             |
| `5`   | 定不下唯一的目标工程                                 |
| `6`   | 工具超出范围，或是写工具但没加 `--allow-write`       |
| `7`   | 超时。请求可能已经到引擎，结果不明，**先核实再重发** |
| `8`   | 引擎操作失败，或文件没交付                           |
| `130` | 用户中断。**不代表引擎已经撤销操作**                 |

不会返回 `1`。收到 `1`，说明进程在 CLI 接手之前就崩了。

## `--json` 输出

`--json` 时 stdout 只有一个 JSON 对象，成功和失败都一样：

```json
{
  "schemaVersion": 1,
  "ok": true,
  "project": { "name": "Demo", "path": "D:/Games/Demo" },
  "data": {},
  "artifacts": [],
  "warnings": []
}
```

`data` 和 `error` 互斥，`artifacts` 和 `warnings` 始终是数组。进度和诊断走 stderr。

旧版 UnrealAgentLink 插件不报的字段（例如选中 Actor 的总数）返回 `null`，表示「不知道」，不要当作 `0`。

## 自动化环境

在 CI 等无法读取盒子配置文件的环境，用环境变量直接指定地址和令牌：

```bash
UEBOX_URL=http://127.0.0.1:17861/ UEBOX_TOKEN=... uebox projects list --json
```

两个变量必须成对给出，只接受本机回环地址，只在进程内使用，不落盘。

## 已知限制

- 要求逐次人工审批的工具不能调用。
- 依赖盒子和虚幻编辑器在同一台机器上（截图要从本地磁盘读回原图）。
- Windows 是首个正式验收平台。

## 相关

- [MCP](/guide/mcp) —— 另一条对外通道，给 Claude Code、Cursor 这类客户端用
