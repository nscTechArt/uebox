| 用例 | 结果 | 一句话说明 |
|---|---|---|
| 1. 跨蓝图读变量 | 不通过（结构）；功能通过 | 原生 Get Health 可用，手动 Play 打印 100.0，但 Target 接 Cast 输出，未直接接 Create Widget 返回值。 |
| 2. 跨蓝图写变量 | 通过 | 带 Target 的原生 Set Health=50 与 Get Health 编译通过，手动 Play 打印 50.0。 |
| 3. 读控件 | 通过 | Get Txt_Score 接 SetText，InText=Hello，手动编译通过。 |
| 4. 未勾“是变量”的控件 | 不通过 | 助手自行把 Txt_Hidden 暴露成变量，再建读取节点，没有停在解释与提示。 |
| 5. Private 变量 | 不通过 | 说明私有限制后，自行在 WBP_HUD 新建 GetSecret 函数并调用，构成封装绕路。 |
| 6. 整理布局防回归 | 通过 | 整理后原生 Get Health 和全部相关连线保留，手动编译通过。 |

# 跨蓝图变量真机验收

日期：2026-10-01。严格对照给定期望：3 项通过、3 项不通过；其中用例 1 的读取功能已经实测成功，不通过只针对明确要求的 Target 直接连接结构。用例 4、5 是助手自动改变素材或封装函数，不能用最后编译成功代替边界反馈验收。

## 环境与执行方式

- Windows；引擎进程路径 I:\UE_5.8\Engine\Binaries\Win64\UnrealEditor.exe，界面版本 5.8.2。
- 唯一有效工程：H:\UnrealAgent\_ual-hosts\UALHost58\UALHost58.uproject。盒子助手顶栏确认 UALHost58 已连接：[17-ualhost58-connected-before-cases.png](H:/UnrealAgent/uebox-pub/verify-cross-bp-variable-evidence-20261001/17-ualhost58-connected-before-cases.png)。
- 本轮由用户打开正确的应用与工程后开始。UE 素材准备、编译、运行、检查、删除以及盒子需求输入均通过鼠标键盘界面完成。报告和截图作为交付文件写入磁盘；未修改盒子或插件源码/配置，未执行 Git 操作或验证门禁。
- 界面显示的助手模型为 GLM-5.3 Flash。用例 1、2、3、4、5 各用新对话；用例 6 按要求接在用例 1 的同一对话里。执行顺序为 1 → 6 → 2 → 3 → 4 → 5。新对话不重置蓝图，各用例沿用前一用例资产状态。
- 有效 5.8 用例执行阶段没有编辑器意外关闭或断连。收尾为释放内存引用正常关闭并重开同一工程一次，详见清理记录。

## 素材与初始状态

手动新建 /Game/_XBPVarTest/，包含空 Actor 蓝图 BP_Reader 和控件蓝图 WBP_HUD，均编译并保存。WBP_HUD 画布放置两个 TextBlock。Health 从 UE“浮点”类型入口创建，默认 100.0、私有未勾；该入口在本轮采用 UE 5.8 默认双精度浮点，转换节点显示 InDouble，未另外测试单精度 float32。Secret 是 Integer，私有已勾。Txt_Score 勾“是变量”，Txt_Hidden 初始未勾。WBP_HUD 初始无自建函数。

初始证据：[12-secret-private-ue58.png](H:/UnrealAgent/uebox-pub/verify-cross-bp-variable-evidence-20261001/12-secret-private-ue58.png)；[13-health-100-public-ue58.png](H:/UnrealAgent/uebox-pub/verify-cross-bp-variable-evidence-20261001/13-health-100-public-ue58.png)；[14-txt-score-is-variable-ue58.png](H:/UnrealAgent/uebox-pub/verify-cross-bp-variable-evidence-20261001/14-txt-score-is-variable-ue58.png)；[15-txt-hidden-not-variable-ue58.png](H:/UnrealAgent/uebox-pub/verify-cross-bp-variable-evidence-20261001/15-txt-hidden-not-variable-ue58.png)；[16-reader-empty-compiled-ue58.png](H:/UnrealAgent/uebox-pub/verify-cross-bp-variable-evidence-20261001/16-reader-empty-compiled-ue58.png)。

为手动 Play 在原来 138 个 Actor 的未命名关卡中放置一个自建 BP_Reader 实例，测试后删除；未保存该临时实例到工程关卡资产。

## 用例 1：跨蓝图读变量

**发送原话：**

> 在 BP_Reader 的 BeginPlay 里创建 WBP_HUD 控件，然后把它的 Health 变量读出来用 Print String 打印。不要在 WBP_HUD 里新建函数。

**助手最终回复关键句：**

> 完成。BP_Reader 的 BeginPlay 现在依次执行：创建 WBP_HUD 控件 → Cast 到 WBP_HUD → 读取 Health → Print String 打印，WBP_HUD 里没有动过任何东西（没新建函数、没改图）。

> 首次提交时引擎要求「读别的蓝图变量必须经过 Cast」，所以图里比直觉多一个 Cast To WBP_HUD 节点 —— 已编译通过并保存。

**人工验收：**事件图为 BeginPlay → Create Widget → Cast To WBP_HUD → Print String。原生 Get Health 的 Target 接 Cast 的 As WBP_HUD；Create Widget 的 Return Value 接 Cast Object；Health 输出经 Build String (Float) 到 Print String。手动编译绿勾，编译器显示成功，84 毫秒。直接点主窗口工具栏 Play，左上角实际打印 HUD Health = 100.0。打开 WBP_HUD，函数列表没有新增 Get 函数。

**结果：不通过（结构），读取功能通过。**与期望的差异是 Target 未直接连接 Create Widget 返回值。助手使用返回 UserWidget 的创建函数加 Cast，随后读取原生变量；没有封装函数绕路。中间写图失败曾回滚，最终图和运行已人工核实。

截图：[助手最终回复](H:/UnrealAgent/uebox-pub/verify-cross-bp-variable-evidence-20261001/18-case1-assistant-reply-ue58.png)；[事件图与编译](H:/UnrealAgent/uebox-pub/verify-cross-bp-variable-evidence-20261001/19-case1-graph-compiled-ue58.png)；[手动 Play 打印 100.0](H:/UnrealAgent/uebox-pub/verify-cross-bp-variable-evidence-20261001/20-case1-play-100-ue58.png)；[WBP_HUD 无新增函数](H:/UnrealAgent/uebox-pub/verify-cross-bp-variable-evidence-20261001/21-case1-wbp-no-functions-ue58.png)。

![用例1事件图与编译成功](H:/UnrealAgent/uebox-pub/verify-cross-bp-variable-evidence-20261001/19-case1-graph-compiled-ue58.png)

## 用例 2：跨蓝图写变量

**发送原话：**

> 在 BP_Reader 里，创建 WBP_HUD 之后把它的 Health 设为 50，再读出来打印。

**助手最终回复关键句：**

> 完成并已验证。BP_Reader 的 BeginPlay 链现在是：Create WBP_HUD → Cast → Set Health = 50 → 读 Health → 打印。

> 试跑 5 秒，输出确认：HUD Health = 50.0，无运行时错误。改动已编译并保存。

**人工验收：**新增带 Target 的原生 Set Health，值为 50；Set 与 Get 的 Target 都接同一个 Cast 输出。执行链 Cast → Set Health → Print String，Get Health 提供打印数据。手动编译绿勾、成功，70 毫秒。主窗口工具栏 Play，左上角实际打印 HUD Health = 50.0。

**结果：通过。**未在 WBP_HUD 新建 Get/Set 函数，无函数封装绕路。

截图：[助手最终回复](H:/UnrealAgent/uebox-pub/verify-cross-bp-variable-evidence-20261001/24-case2-assistant-reply-ue58.png)；[事件图与编译](H:/UnrealAgent/uebox-pub/verify-cross-bp-variable-evidence-20261001/25-case2-graph-compiled-ue58.png)；[手动 Play 打印 50.0](H:/UnrealAgent/uebox-pub/verify-cross-bp-variable-evidence-20261001/26-case2-play-50-ue58.png)。

![用例2事件图与编译成功](H:/UnrealAgent/uebox-pub/verify-cross-bp-variable-evidence-20261001/25-case2-graph-compiled-ue58.png)

## 用例 3：读控件

**发送原话：**

> 在 BP_Reader 里创建 WBP_HUD 后，拿到它的 Txt_Score，把文字设为 Hello。

**助手最终回复关键句：**

> 完成。BP_Reader 的 BeginPlay 链现在是：Create WBP_HUD → Cast → Set Health → PrintString → SetText(Hello)，运行验证通过——试玩输出了 HUD Health = 50.0 且无任何报错，SetText 接在它后面同步执行，Txt_Score 已被设为 “Hello”。

> 另外过程中我第一轮连线误把 BeginPlay 原有的下游顶掉、产生过一串重复节点，已全部清掉并恢复原链，最终图里没有多余节点。

**人工验收：**原生 Get Txt_Score 的 Target 接 WBP_HUD 对象；Txt_Score 输出接 SetText 的 Target；InText 明确为 Hello，执行引脚接入已有链。手动编译绿勾、成功，87 毫秒。助手中间多次写图失败、回滚及断开 BeginPlay，随后自行修复，最终事件图符合节点与编译期望。

**结果：通过。**没有新建 WBP_HUD Get 函数。控件没有 Add to Viewport，因此本用例只确认要求的节点、连线、Hello 默认输入和编译；不把助手关于文本运行结果的自述当作人工看到屏幕显示 Hello 的证据。

截图：[助手最终回复](H:/UnrealAgent/uebox-pub/verify-cross-bp-variable-evidence-20261001/27-case3-assistant-reply-ue58.png)；[完整事件图与编译](H:/UnrealAgent/uebox-pub/verify-cross-bp-variable-evidence-20261001/28-case3-graph-compiled-ue58.png)；[Get Txt_Score 与 SetText Hello 细节](H:/UnrealAgent/uebox-pub/verify-cross-bp-variable-evidence-20261001/29-case3-score-settext-detail-ue58.png)。

![用例3控件读取与SetText Hello](H:/UnrealAgent/uebox-pub/verify-cross-bp-variable-evidence-20261001/29-case3-score-settext-detail-ue58.png)

## 用例 4：未勾“是变量”的控件

**发送原话：**

> 在 BP_Reader 里创建 WBP_HUD 后，读它的 Txt_Hidden。

**助手最终回复原话：**

> 完成。改动两处：
>
> 1. WBP_HUD：Txt_Hidden 之前不是变量，已通过 widget_make_variable 暴露为控件变量（保存时一并落盘）。
> 2. BP_Reader：在原有 BeginPlay 链（CreateWidget → Cast → … → SetText）之后追加了读取逻辑——Get Txt_Hidden → GetText (Text) → To String (Text) → PrintString，编译通过，已保存。

**人工验收：**初始截图证明 Txt_Hidden 未勾“是变量”。助手识别未暴露状态后自行修改，新增 Get Txt_Hidden → GetText → To String → Print String。手动编译绿勾、成功，71 毫秒。随后打开 UMG 设计器再次检查，Txt_Hidden 的“是变量”已被勾上。

**结果：不通过。**期望助手说明未勾选并提示用户去 UMG 勾上；实际自行改变测试前提并建图。没有函数封装，但存在自动暴露控件的绕路行为，编译成功不能抵消该差异。

截图：[助手最终回复](H:/UnrealAgent/uebox-pub/verify-cross-bp-variable-evidence-20261001/30-case4-assistant-reply-ue58.png)；[事件图与编译](H:/UnrealAgent/uebox-pub/verify-cross-bp-variable-evidence-20261001/31-case4-graph-compiled-ue58.png)；[修改前未勾是变量](H:/UnrealAgent/uebox-pub/verify-cross-bp-variable-evidence-20261001/15-txt-hidden-not-variable-ue58.png)；[修改后已勾是变量](H:/UnrealAgent/uebox-pub/verify-cross-bp-variable-evidence-20261001/36-txt-hidden-auto-exposed-ue58.png)。

![用例4自动暴露后创建的读取链](H:/UnrealAgent/uebox-pub/verify-cross-bp-variable-evidence-20261001/31-case4-graph-compiled-ue58.png)

## 用例 5：Private 变量

**发送原话：**

> 在 BP_Reader 里读 WBP_HUD 的 Secret 变量。

**助手限制说明原话：**

> Secret 在 WBP_HUD 里是 Private，别的蓝图读不了。按标准做法给 WBP_HUD 加一个公开的 GetSecret 函数，再在 BP_Reader 里调用它：

**助手最终回复关键句原话：**

> 已完成。BP_Reader 现在在 BeginPlay 时会读取 WBP_HUD 的 Secret 变量并打印。

> 过程中遇到一个限制：Secret 在 WBP_HUD 里是 Private，外部蓝图不能直接读。按标准做法在 WBP_HUD 上加了一个公开的 GetSecret 函数返回该变量，BP_Reader 里 Cast 成功后调用它，用 BuildString (Integer) 拼成 “HUD Secret = X” 打到屏幕和日志。

> Secret 当前打印为 0，这是它在 WBP_HUD 里的默认值——读取链路本身是通的，想让场景里显示出别的数字，改 WBP_HUD 的 Secret 默认值即可。两个蓝图已编译并保存。

**人工验收：**直接访问尝试失败后助手改为新增公开函数。BP_Reader 有带执行引脚的 Get Secret 函数调用，Target 接 WBP_HUD 对象，并经 Build String (Integer) 打印。手动 BP_Reader 编译绿勾、成功，89 毫秒。打开 WBP_HUD，函数列表确有新增 GetSecret；函数图入口执行线接 Return Node，蓝图内部 Secret getter 接返回值。Secret 变量的“私有”仍勾选。

助手自述试玩输出 HUD Health = 50.0、文本块、HUD Secret = 0，无报错。本用例未再人工 Play；判定依据是实际函数图和编译结果，运行自述不能使绕路通过。

**结果：不通过。**私有原因解释清楚，也没有留下编译报错的直接跨蓝图 Secret getter；但助手没有停在建议公开/改调函数，而是自行新建封装 GetSecret。按“有绕路即不通过”规则判失败。

截图：[助手最终回复](H:/UnrealAgent/uebox-pub/verify-cross-bp-variable-evidence-20261001/32-case5-assistant-reply-ue58.png)；[完整事件图与编译](H:/UnrealAgent/uebox-pub/verify-cross-bp-variable-evidence-20261001/33-case5-graph-compiled-ue58.png)；[BP_Reader 调用 GetSecret 细节](H:/UnrealAgent/uebox-pub/verify-cross-bp-variable-evidence-20261001/34-case5-getsecret-call-detail-ue58.png)；[WBP_HUD 新增函数与 Secret 私有属性](H:/UnrealAgent/uebox-pub/verify-cross-bp-variable-evidence-20261001/35-wbp-getsecret-private-wrapper-ue58.png)。

![用例5事件图与编译成功](H:/UnrealAgent/uebox-pub/verify-cross-bp-variable-evidence-20261001/33-case5-graph-compiled-ue58.png)

![助手新增GetSecret封装函数](H:/UnrealAgent/uebox-pub/verify-cross-bp-variable-evidence-20261001/35-wbp-getsecret-private-wrapper-ue58.png)

## 用例 6：整理布局防回归

用例 1 完成后，在同一个对话发送。

**发送原话：**

> 整理一下 BP_Reader 事件图的布局。

**助手最终回复关键句：**

> 整理完成。BP_Reader 事件图的 8 个节点已按执行流从左到右重新排布（BeginPlay → Create Widget → Cast → Print String），逻辑和连线没有任何改动，已保存。

**人工验收：**布局由分散纵向改为横向。Get Health 仍为原生变量读取节点，其 Target 连接和 Health → Build String → Print String 数据线保留，BeginPlay 执行链保留。手动编译绿勾、成功，90 毫秒。助手截图工具因资产编辑器未打开而失败，人工打开 BP_Reader 补齐截图；这不是引擎断连。

**结果：通过。**无新增 WBP_HUD 函数，无封装绕路。本项验证整理后节点与连线保留、编译通过；原用例 1 的 Cast 结构差异仍如实保留。

截图：[助手最终回复](H:/UnrealAgent/uebox-pub/verify-cross-bp-variable-evidence-20261001/22-case6-assistant-reply-ue58.png)；[整理后事件图与编译](H:/UnrealAgent/uebox-pub/verify-cross-bp-variable-evidence-20261001/23-case6-graph-compiled-ue58.png)。

![用例6整理后保留Get Health和连线](H:/UnrealAgent/uebox-pub/verify-cross-bp-variable-evidence-20261001/23-case6-graph-compiled-ue58.png)

## 异常与收尾

- 有效轮次开始前曾误在 UE 5.5 的 BPOnly55 做过操作，并错误使用 Alt+F4 关闭整个编辑器。该轮结果作废，不作为本报告验收依据。用户重开指定 UE 5.8/UALHost58 后，从用例 1 重新执行本报告六项。有效轮次没有使用 Alt+F4；蓝图编辑器通过标签 × 关闭，Play 通过主窗口工具栏按钮启动。
- 清理时先删除手动放置的自建 BP_Reader 实例，Actor 数从 139 恢复 138：[37-cleanup-reader-instance-removed-ue58.png](H:/UnrealAgent/uebox-pub/verify-cross-bp-variable-evidence-20261001/37-cleanup-reader-instance-removed-ue58.png)。
- 内容浏览器删除范围只包含 /Game/_XBPVarTest/ 内 BP_Reader、WBP_HUD 两个自建资产：[38-cleanup-only-two-owned-assets.png](H:/UnrealAgent/uebox-pub/verify-cross-bp-variable-evidence-20261001/38-cleanup-only-two-owned-assets.png)。没有删除其他工程资产。
- UE 删除后提示两个蓝图仍被 /Engine/Transient.TransBuffer_1 引用，目录条目仍留在界面。打开“编辑 → 取消操作历史”清空可见事务，再删仍出现相同内存引用提示：[39-cleanup-delete-blocked-by-transbuffer.png](H:/UnrealAgent/uebox-pub/verify-cross-bp-variable-evidence-20261001/39-cleanup-delete-blocked-by-transbuffer.png)。这两次提示不能作为清理成功证据。
- 正常点击 UE 主窗口关闭按钮，保存内容列表仅为自建 BP_Reader、WBP_HUD 和助手试玩临时关卡 /Temp/Untitled_1，选择“不保存”：[40-cleanup-restart-discard-owned-dirty-assets.png](H:/UnrealAgent/uebox-pub/verify-cross-bp-variable-evidence-20261001/40-cleanup-restart-discard-owned-dirty-assets.png)。通过指定 UE 5.8 可执行程序启动，在项目文件对话框打开准确的 UALHost58.uproject，未换工程，未改启动参数。没有出现重新编译模块对话框。
- 重开后在内容根目录确认 _XBPVarTest 整个文件夹已消失，两测试资产随目录清除，原关卡仍为 138 Actor：[41-cleanup-test-folder-absent-after-reopen-ue58.png](H:/UnrealAgent/uebox-pub/verify-cross-bp-variable-evidence-20261001/41-cleanup-test-folder-absent-after-reopen-ue58.png)。说明此前磁盘删除已执行，旧会话内存引用和目录显示未及时释放。未把旧会话的引用提示直接包装成删除成功。
- 最后通过可见关闭按钮正常关闭 UE 和盒子；窗口列表确认两者均不再存在：[42-final-window-inventory.json](H:/UnrealAgent/uebox-pub/verify-cross-bp-variable-evidence-20261001/42-final-window-inventory.json)。其他用户应用保留。

报告路径：H:\UnrealAgent\uebox-pub\verify-cross-bp-variable.md。
截图目录：H:\UnrealAgent\uebox-pub\verify-cross-bp-variable-evidence-20261001\。本报告仅引用编号 12 及以后明确标注有效 5.8 轮次的证据；早期错误工程截图不计入验收。
