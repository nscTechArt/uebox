# 命令行 uebox

从终端或脚本操作虚幻引擎。给自动化流程和外部 Agent 用。

需要虚幻盒子正在运行。引擎类命令还要求目标 UE 编辑器已打开并完成插件握手（`tools list` 不要求）。

## 安装

随 Windows 和 macOS 安装包分发，不用单独装。

**设置 → 命令行** 显示程序位置，可以复制路径或在文件夹中显示。旁边有「**加入 PATH**」，开启后新开的终端可以直接敲 `uebox`。这一项只影响当前用户，随时可以关掉。

![设置 → 命令行](/shots/settings-cli.png)

Linux 包不带命令行工具。

## 先跑这两条

```bash
uebox setup
```

关联本机应用的配置并验证连接。没有 TTY 的环境（CI、脚本）要显式给 `--host-config <path>`。

```bash
uebox doctor
```

逐层检查：连接 → 接口契约 → 工具范围 → 工程注册，并指出中断的层级。加 `--project <path>` 可同时确认指定工程是否可作为目标。

## 读命令

```bash
uebox projects list                # 已注册且在线的工程
uebox tools list                   # 可调用的工具
uebox tools list --search material # 按名字或描述筛
uebox tools show <name>            # 某个工具的完整描述和参数定义
uebox selection get                # 编辑器当前选中/打开的内容
uebox actors list                  # 关卡里的 Actor
uebox viewport screenshot --output shot.png
```

### actors list

| 选项               | 说明                                 |
| ------------------ | ------------------------------------ |
| `--name <text>`    | 按 Name/Label 精确匹配，不填扫全关卡 |
| `--limit <n>`      | 返回上限，1–1000，默认 **50**        |
| `--include-system` | 连引擎的记账 Actor 一起算            |

位置单位是厘米，旋转是度，缩放是倍数。

### viewport screenshot

| 选项                   | 说明                                          |
| ---------------------- | --------------------------------------------- |
| `--output <path>`      | **必填**，只接受 `.png`，相对路径按当前目录算 |
| `--world auto\|editor` | 默认 `auto`，PIE 在跑就拍游戏世界             |
| `--overwrite`          | 允许覆盖已存在的文件                          |

## 写命令

写命令都要加 `--allow-write`：

```bash
uebox actors spawn --name Box1 --asset StaticMeshActor --allow-write
uebox actors move  --name MyCube --location z=200 --allow-write
uebox actors delete --name MyCube --allow-write
uebox actors undo --allow-write
```

| 选项               | 说明                                      |
| ------------------ | ----------------------------------------- |
| `--asset <text>`   | 生成什么：别名、`/Game/` 路径或类名       |
| `--location x,y,z` | 位置，厘米。也可以写 `z=200` 只设一个分量 |
| `--rotation p,y,r` | 旋转，度。也可以写 `yaw=90`               |
| `--scale x,y,z`    | 缩放倍数。也可以写 `x=2`                  |

### `--allow-write` 不是多余的

应用里那个「同时开放写操作工具」的开关，是给**带审批界面**的客户端用的。CLI 这头一个弹窗都没有，`--allow-write` 就是顶替那一下的确认。

应用那头没勾的话，写工具根本不在清单里 —— `uebox doctor` 会说破。

### 撤销要用 undo

```bash
uebox actors undo --allow-write
```

编辑器里按 `Ctrl+Z` **碰不到 CLI 做的这一步**。

## 调用任意工具

判定规则：**应用内 AI 助手可用的工具，在 CLI 中加 `--allow-write` 均可调用。**

命名空间不参与判断，素材库搜索、工程库管理、将素材库资产导入工程均包含在内。两类除外：要求逐次人工审批的工具，以及本机文件和 shell —— 应用侧未将这两类对外暴露。

```bash
uebox tools call search_assets --args-file args.json
```

`--args` 中直接写 JSON 需要按所在 shell 转义，未转义的引号会被 shell 去掉：

```bash
# PowerShell
uebox tools call get_actor --args '{\"name\":\"Floor\"}'
```

```bash
# cmd
uebox tools call get_actor --args "{""name"":""Floor""}"
```

也可以使用 `--args-file <文件>`，或 `--args-file -` 从标准输入读取。

## 两条路的核实强度不同

| 路径                            | 核实方式                             |
| ------------------------------- | ------------------------------------ |
| `actors spawn/move/delete/undo` | CLI 自己回读引擎核对，对不上就报失败 |
| `tools call <任意工具>`         | 原样转发，核实看工具自己的返回值     |

::: warning 超时不要直接重发
两条路径相同。`actors` 系列会给出一条可直接执行的回读命令；`tools call` 只提示核实位置。**确认执行结果后再决定是否重发。**
:::

## 目标工程怎么定

按这个顺序：

1. `--project` 指定的
2. 从当前目录逐层往上找到的最近的 `.uproject`
3. 前两步都没有时，**恰好只有一个工程在线**才用它

前两步定出来的工程如果没连着，命令直接失败，**不会改发给别的在线工程**。

## 读结果之前要知道的

**`actors list`** —— 引擎的记账 Actor（HLOD、导航网格、物理体积）默认不计入，有被滤掉时警告里给真实总数。被 `--limit` 截断时也有警告。`totalCount` 为 `null` 是「插件没报总数」，不是「没有更多」。

**`viewport screenshot`** —— 文件落地前核验 PNG 格式与尺寸，核验不过一律非零退出。这条路自己渲一帧，**曝光比编辑器视口偏暗约一档**，不要拿它判断过曝或欠曝。

## 公共选项

| 选项                  | 说明                                       |
| --------------------- | ------------------------------------------ |
| `--json`              | stdout 只输出一个 JSON 对象，诊断走 stderr |
| `--project <path>`    | 目标工程，`.uproject` 文件或其所在目录     |
| `--timeout <秒>`      | 整条命令的期限，默认 **120**               |
| `--lang zh-CN\|en-US` | 帮助与提示的语言                           |
| `--config <path>`     | 指定 CLI 自己的配置文件                    |
| `-h, --help`          | 加 `--all` 看完整帮助                      |
| `-v, --version`       | 版本号                                     |

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

不会返回 `1`。真收到 `1`，说明进程在 CLI 接手之前就崩了。

## 相关

- [MCP](/guide/mcp) —— 另一条对外通道，给 Claude Code、Cursor 这类客户端用
