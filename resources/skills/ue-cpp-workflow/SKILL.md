---
name: ue-cpp-workflow
description: Writes, adds and compiles C++ in an Unreal project, then hot-reloads it into the running editor. Use when the user asks for gameplay code, a new UCLASS/USTRUCT/UENUM, an Actor or Component or Subsystem class, a module dependency change, or says things like "写个 C++ 类"、"加个组件"、"这段代码编不过"、"帮我改下 Build.cs". Also covers editing the engine's own source under Engine/Source when the user asks for it. Do not use for Blueprint graph editing, for material graphs, or for Sequencer.
---

# UE C++ 工作流

## Quick Start

**动手写任何 C++ 之前，先 `cpp_probe`。** 它回答两个会改变做法的问题：
这个工程走哪条编译路、编不过时能不能拿到报错。

```
cpp_probe                    → 能怎么编、引擎源码在哪
cpp_list_modules             → 这个类该写进哪个模块
cpp_add_class                → 新建类（和编辑器「新建 C++ 类」逐字相同，只写文件不编译）
（写代码：read_local_file / edit_local_file）
cpp_compile                  → 编进正在跑的编辑器，不需要关编辑器
cpp_full_rebuild             → 编辑器补不上的改动：盒子关编辑器、完整编译、再打开并重连
```

整条链上**没有一步需要用户动手**。关编辑器这种事由 `cpp_full_rebuild` 做，用户只在审批框里点一次同意。

## Workflow

### 改一个已有的类

`read_local_file` 看清楚 → `edit_local_file` 改 → 编译 → 按下面「编过之后」验证。
编不过就读诊断、改、再编。

先看改的是哪一类，它决定用哪个编译工具：

| 改动 | 用 |
|---|---|
| `.cpp` 里的函数体（构造函数除外）、头文件里不带反射的内联代码 | `cpp_compile` |
| 已有类的结构：增删改 `UPROPERTY` / `UFUNCTION`、`USTRUCT` 字段、`UENUM` 项，加减成员变量或虚函数，换父类 | `cpp_full_rebuild` |
| 构造函数里改默认值 | `cpp_full_rebuild` |

后两类热补丁靠不住：可能报成功但旧的类布局、旧默认值还在，也可能过一会儿崩。
返回里的 `needs_full_rebuild` 只看 `.Build.cs` / `.uproject`。头文件另有 `reflected_headers_changed`：
上次编译后改过的反射头文件清单。它只说改了哪些文件，改的是不是上表那几类，要你对照自己的改动判断。
用户不想关编辑器时可以先 `cpp_compile`，但编过之后必须在 PIE 里确认，不对就 `cpp_full_rebuild`。

### 改签名、改名、删成员之前：先查谁在用

只编你改的那个文件，查不出别处被你改坏了。动 `UFUNCTION` / `UPROPERTY` / 类名之前：

- C++ 调用方：`grep_local_files` 在工程 `Source/` 下搜这个名字。
- 蓝图调用方：`blueprint_find_usages { query: "成员名" }`，就是编辑器的「在所有蓝图中查找」，
  不加载蓝图。动手前把命中的蓝图列给用户。它按名字匹配：同名的别的成员也会命中，看 `context` 甄别；
  回包说「结果可能不全」时，没索引的那些蓝图没被搜到，照实告诉用户。
- 查过也要编：改完、完整重编之后，对命中的蓝图逐个 `blueprint_compile`；结果不全时改跑
  `blueprint_compile_all`（`scope: "all"`，大工程用 `path` 收窄），编不过的就是被你改坏的。
- 改名而资产里存着它的值（关卡里的实例、蓝图子类、数据资产）：同时在 `Config/DefaultEngine.ini`
  的 `[CoreRedirects]` 里加一条，否则存过的值和蓝图节点会断。例：
  `+PropertyRedirects=(OldName="/Script/MyGame.MyActor.Health",NewName="/Script/MyGame.MyActor.HP")`。
  重定向在编辑器启动时读，正好跟 `cpp_full_rebuild` 一起生效。

### 新建一个类

`cpp_add_class`（名字不带前缀，父类如 `Actor` / `ActorComponent` / `Interface`）
→ `read_local_file` 看生成的两个文件 → 填实现 → `cpp_compile`。

- 它用的是引擎自己的类模板，`.generated.h`、`<MODULE>_API` 宏、老式 PCH、父类模块依赖都和编辑器建的一样。
  所以**不要自己 `write_local_file` 拼 `.h`/`.cpp` 来建类**，也**不要让用户去菜单里点** ——
  两样都比这个工具差。
- 报「已经存在」：多半是上一轮建过还没编进来。读那个文件接着改，别换名字重建。
- 一次要建好几个类：逐个调，全部建完、实现填完再 `cpp_compile` 一次。

### 纯蓝图工程的第一个类

`cpp_probe` 回 `has_code: false` 且没有声明模块时，照样调 `cpp_add_class`（`module` 留空）。
它会和编辑器一样先建好以工程名命名的主模块（`.Build.cs`、两个 `.Target.cs`、模块文件）。
**新模块正在跑的编辑器加载不了**，所以填完实现后调 `cpp_full_rebuild`，不是 `cpp_compile`。

工程名不是合法的 C++ 标识符（中文、带横杠、数字开头）时工具会拒绝 —— 引擎在这里也会失败，
如实告诉用户需要先给工程改个英文名。

### 改模块依赖（.Build.cs / .uproject）

`edit_local_file` 改 → `cpp_compile`。热重载路一般编得进来（实测给模块加 Slate 依赖、
调用新模块 API 都生效）。返回里 `needs_full_rebuild` 为真**且走的是 Live Coding** 时，
补丁式热更链不进新依赖，调 `cpp_full_rebuild`。

### 编过之后：在 PIE 里看行为

编过只说明语法和链接没问题。改的是行为，就用 `ue_playtest` 跑一次，看行为变没变：

- **埋打点**：在改动经过的路径上加 `UE_LOG(LogTemp, Warning, TEXT("..."))`，一次埋几处。
  `ue_playtest` 只收 PrintString、Warning 和 Error，`Log` / `Display` 级的收不到；
  非要看那些，跑完用 `grep_local_files` 搜 `Saved/Logs/<工程名>.log`。验证完把打点删掉。
- **改构造函数默认值**：已放置的实例、蓝图子类里在细节面板改过这个值的，保留各自的值，
  不跟着构造函数变。要看的是那个具体实例（`ue_inspect_components` / `ue_get_actor`），不是源码。
- **修 bug**：改之前先用同样的步骤复现一次（看到那条报错或错的打点），改完用同样的步骤再跑，
  那条报错不再出现才算修好。复现不了就如实说「改了，但没验证到」。
- 要多步操作才触发的用 `ue_playtest` 的 `events` 或 `ue_autoplay`；联机、特定硬件这类工具测不了的，
  告诉用户测什么、怎么测，不要报完成。

打点出现、报错消失、读回的值对，这些你来确认；手感和数值合不合适由用户判断。

## Constraints

**1. `cpp_full_rebuild` 会关掉用户的编辑器。** 只在 `cpp_compile` 做不到时用（上面列的几种情况，
加上 `cpp_compile` 报「没有可热重载的 UObject」）。有未保存的改动它会拒绝并列出清单：先 `ue_save`
再调；清单里有存不了的，问用户能不能丢，同意了才带 `discard_unsaved`。
编不过时编辑器保持关着，按报错改完直接再调一次。

`has_code: false` **但**列得出模块，是另一回事：那是个源码缺失的 C++ 工程
（`.uproject` 声明了模块但 `Source/` 不在），加新类解决不了，让用户检查工程完整性。

**2. Live Coding 路的报错从 UBT 日志读回。** 编辑器日志里只有一句「失败了」，`cpp_compile`
会去读 UnrealBuildTool 的 `Log.txt` 拿文件名和行号。偶尔读不到时它会明说 ——
**不要猜是哪一行错**，用 `cpp_full_rebuild` 完整编一次就能拿到全部报错。

**3. 不要凭记忆写 UE API。** UE 的 API 在 5.0–5.8 之间会变（函数改名、参数增减、
导出宏变化）。拿不准某个函数的签名，就用 `cpp_probe` 给的 `engine_source_dir` 去
`grep_local_files` 读用户这台机器上这个版本的头文件。编不过是好结果，
编过了但行为不对才是坏结果。

**4. 模块类型决定能 include 什么。** `cpp_list_modules` 的 `type` 字段：

| 类型 | 能 include | 典型坑 |
|---|---|---|
| `Runtime` | 只能用运行时模块 | include `UnrealEd`/`LevelEditor` 在编辑器里编得过，**打包成游戏时链接失败** |
| `Editor` | 编辑器模块随便用 | 里面的代码打包后不存在，别把游戏逻辑写这儿 |

这是最典型的「开发时全绿、打包时全红」。选模块时先看类型。

`cpp_compile` 和默认的 `cpp_full_rebuild` 只编编辑器目标，这类错它们查不出来。先自查（便宜）：
Runtime 模块的 `.Build.cs` 里有编辑器模块的，要包在 `if (Target.bBuildEditor)` 里；
代码里用到编辑器 API 的地方要包在 `#if WITH_EDITOR` 里。要实证就调
`cpp_full_rebuild({ game_target_only: true })`：只编游戏目标，不关编辑器、不烘焙，几分钟。
改过 Runtime 模块的 include 或编辑器相关代码，交付前跑一次。要验证打出来的包能不能跑，
才用 `project_package` + `project_smoke_test`（几十分钟、整机满载，跑之前告诉用户）。

**5. UHT 的反射规则**（编译期报错，措辞对不熟 UE 的人很难懂）：

| 现象 | 原因 |
|---|---|
| `Unrecognized type 'FMyStruct'` | 结构体没标 `USTRUCT()`，或者头文件没 include |
| `Missing '*' in Emitting class` | `UPROPERTY` 指向 UObject 派生类时必须用指针 |
| `Type 'TArray<FMyStruct>' is not supported by blueprint` | 元素类型没标 `BlueprintType` |
| `Superclass ... of class ... not found` | 父类头文件没 include，或者父类模块不在依赖里 |
| 改了 `UPROPERTY` 之后热重载崩溃 | 改反射结构本该一开始就走 `cpp_full_rebuild`，见「改一个已有的类」 |

`.generated.h` 必须是头文件里**最后一个** include。

## Failure Handling

**编不过时只修第一条错误，再编。** 后面的常是它连带出来的：少一个 include 能刷出几十条。
报错条数不是进度，修完第一条后一下少了一大半很正常。

链接错误（编译过了、链接时失败）：

| 现象 | 常见原因 |
|---|---|
| `LNK2019` / `LNK2001` 无法解析的外部符号 | ① 符号所在模块没加进 `.Build.cs` 依赖；② 符号在别的模块里但没导出（没有 `XXX_API`，或类是 `MinimalAPI` 只导出了一部分），引擎里没导出的换一个导出的 API；③ 声明了没实现，或实现的签名和声明对不上 |
| `LNK2005` 符号已定义 | 非 `inline` 的函数定义写在头文件里，被多个 `.cpp` 包含 |

| 情况 | 怎么办 |
|---|---|
| `cpp_compile` 回 `NoChanges` | 确认文件真的保存了，且改的是这个工程正在用的那份源码 |
| `cpp_compile` 回 `Timeout` | 说「不知道成没成」，请用户看一眼编辑器，**不要报成功** |
| `cpp_compile` 回 `NotStarted` | 前提条件没满足（见返回的原因），改代码解决不了；没有可热重载的 UObject 就 `cpp_full_rebuild` |
| 诊断里没有文件名行号 | 走的是 Live Coding 路，见 Constraints 2，不要猜 |
| 编译反复失败且原因不明 | `cpp_full_rebuild` 完整编一次，那条路的报错最全 |
| Live Coding 处于「关了没关干净」 | `cpp_compile` 会拒绝并说明；先 `ue_save` 再 `ue_restart_editor` |

## Escalation

需要用户点头才做的：

- 编辑器卡死、插件连不上时关不掉它 —— `cpp_full_rebuild` 会说明；用户同意丢弃未保存改动后，
  用 `run_shell_command` 跑 `taskkill` 结束进程
- 开启 / 关闭 Live Coding —— 那是用户的编辑器偏好，不主动改。他要改时用 `ue_set_config`
  （`EditorPerProjectUserSettings`，`/Script/LiveCoding.LiveCodingSettings`，`bEnabled`），
  然后 `ue_save` 再 `ue_restart_editor`
- 修改引擎自身源码（`Engine/Source`）—— 只在用户要求时改。先说清两件事：安装版引擎
  （Launcher / Fab 装的）改了源码也不会重新编译，只有源码版引擎才生效；源码版改完要整个
  引擎重编，可能几十分钟到几小时。他确认后再动手，改之前列出要改的文件

工具做不到、需要用户本人处理的：安装 Visual Studio / 编译工具链。

别的（建类、编译、关编辑器完整重编、重启编辑器）都有工具，**不要交给用户**。
用户明确授权你直接改文件时，照做就是 —— 这里没有「授权也解除不了」的限制。
