# 手动验证脚手架

这里的脚本**不进 `pnpm verify`**，因为它们都要真机条件：拉起真实
Electron、用用户自己配置的模型、或者强杀进程。跑一次几分钟到十几分钟。

改动 Agent V3 的以下部分时，值回票价：事件投影、IPC 契约、
transcript 持久化、通道白名单。

产物（日志、判定 JSON、隔离用的 userData）落在仓库根的 `.test/`，
那个目录已被 `.gitignore` 忽略 —— **里面会有从真实配置拷过来的
`ai-provider-secrets.bin`，绝对不能入库。**

## smoke-ui.mjs

```bash
node tests/manual/smoke-ui.mjs
```

拉起应用，逐条确认 `agent-v3:*` 事件通道订阅得起来、V2 的 `agent:*`
已经摘干净、界面正常挂载。

**为什么必须真机跑**：通道登记错集合（`GENERIC_EVENT_CHANNELS` 给
`window.api.on`，`RAW_EVENT_CHANNELS` 给 `window.electron.ipcRenderer.on`）
时，`assertChannelAllowed` 会抛异常把**整条订阅链路一起带挂**，
而界面只表现为「收不到任何事件」，控制台里也未必看得出跟 agent 有关。
这个坑真踩过一次，只有真机能发现。

## verify-crash-resume.mjs

```bash
node tests/manual/verify-crash-resume.mjs
```

塞一个只有这轮知道的批次号 → `taskkill /F /T` 整棵进程树 → 重启 →
问那个批次号。验的是「进程被强杀时最后一轮到底落没落盘」，
这是单测证明不了的。

注意必须杀**整棵树**：Windows 上只杀主进程的话，渲染/GPU 子进程还占着
Electron 的单实例互斥锁，第二个实例拿不到锁会直接 `app.quit()`，
表现成 `firstWindow()` 超时，看上去像恢复失败其实压根没启动。

## verify-real-model.mjs

```bash
node tests/manual/verify-real-model.mjs
```

用**你自己在设置里配好的模型**跑四条判定线：模型会不会自己先
`load_skill`、工具描述够不够选对、压缩后还记不记得早期结论、
失败工具会不会反复重试。

前置条件：在 设置 → 模型 里配好 provider 并绑定角色。脚本会把
`models.json`、`ai-provider-secrets.bin` 和 **`Local State`** 一起拷进隔离
的 userData —— 最后那个容易漏：Windows 上 Electron 的 `safeStorage` 用的是
Chromium os_crypt 的随机主密钥，它存在 `Local State` 里，不拷过去密钥就
解不开，而 `credentials.ts` 解不开时按空密钥库处理，链路会静默变成 401。

结果落在 `.test/real-model-verdict.json`。验不到的判定线记 `—` 而不是
`✅` —— 「没验到」不等于「通过」。

## verify-chat-ui.mjs

```bash
node tests/manual/verify-chat-ui.mjs
```

在 `/dev-assistant` 的输入框里真打字回车，跑通一整轮。

聊天页和调试台不是同一条链路（调试台走 preload 封装，聊天页走
Welcome.vue → useAgentMode → 全局分发器）。曾经聊天页直接
`ipcRenderer.invoke('agent-v3:execute')`，而那个通道不在白名单里，
一发消息就报「Blocked invoke channel」—— V3 在聊天页从来没通过，
而调试台一直是绿的。

## verify-chat-v3-features.mjs

```bash
node tests/manual/verify-chat-v3-features.mjs
```

验聊天页上这几样串起来还成立：**多轮记忆**（跨轮用同一个会话 ID，
第二轮答得出第一轮给的代号）、**真实上下文用量**（内核推的数，不是
渲染层估的）、**生成中的插话按钮**。

多轮记忆那条最重要：曾经每轮 `crypto.randomUUID()` 现开一个会话 ID，
而 V3 按 sessionId 恢复 transcript，等于每发一条消息就换一个全新的
agent；界面又只把最新一条用户消息发过去，于是模型完全不记得上一轮。
单测很难覆盖，只有真机连着问两句才看得出来。

## verify-preferences-panels.mjs

```bash
node tests/manual/verify-preferences-panels.mjs
```

点开「模型」「MCP 设置」「Agent V3 调试台」三个设置面板，确认切得过去、
切完还能切回来。

判据是**面板标题真的换成了那一项**，不是截图也不是 rAF：界面卡死时 DOM
还在、rAF 照样触发，光看那些分辨不出来；而 `.header-title` 是 Vue 根据当前
选中项渲染的，它跟着变才说明渲染队列还在推进。

起因是 `aiProvider.onOAuthDeviceCode` 只写在 preload 的 `.d.ts` 里、没有真的
实现。它在 `AIProviderSettings.vue` 的 `onMounted` 里被调用，抛出去中断了 Vue
的 post-flush 队列 —— 后果不是「这个面板打不开」，而是**整个应用界面不再
更新**，从「模型」页蔓延到旁边几个完全无关的设置页。

同类问题的静态防线在 `src/preload/apiSurface.test.ts`（进 `pnpm verify`）：
渲染层调的每个 `window.api.*` 方法，preload 里必须真的有实现。

## verify-chat-resume.mjs

```bash
node tests/manual/verify-chat-resume.mjs
```

验「报错后继续尝试」这条完整链路：先把 baseUrl 改成连不上的地址逼出一次
失败 → 确认报错气泡上出现「继续尝试」→ 改回去 → 点它 → 模型应该接着回答
**第一轮**的问题。

**这条必须真机验**：pi 在模型调用失败时会往 transcript 里压一条
`stopReason: 'error'` 的 assistant 消息，而 `agent.continue()` 明确拒绝从
assistant 续跑 —— 不摘掉它的话，「上一轮报错了，继续尝试」这个最主要的场景
必然失败。`planResume` 的单测锁住了摘除逻辑，但摘完 pi 认不认、
盘上的文件重写对不对，只有真机能证明。

改 baseUrl 走的是应用自己的保存通路（`aiProvider.saveProvider`）而不是直接
改 `models.json`：`readSettings()` 有内存缓存，只有 `writeSettings()` 更新它，
直接改盘上的文件运行中的主进程根本看不到。

## verify-asset-snapshot.mjs

```bash
node tests/manual/verify-asset-snapshot.mjs [/Game/你的材质路径]
```

验证资产快照/回滚这条链：保存 → 拷贝 → （人工改一下）→ 还原 → 重载。

**为什么必须真机跑**：重载 API 在不同引擎版本上叫什么、资产正开在编辑器
标签页里时重载会不会出问题、`save_asset` 在大工程里要多久 —— 这三件事
只有开着编辑器才知道。脚本会把探到的 API 名字原样打出来。

前置：编辑器开着、装了 UnrealAgentLink、盒子连得上。

## verify-ue-tools.mjs —— material-graph

```bash
node tests/manual/verify-ue-tools.mjs material-graph
```

验材质图的「往回收」与「复用」那一批工具：断线、清死节点、参数集合、
材质函数、反查引用。

**为什么必须真机跑**：这一批工具的失败形态全是「返回 200 但事情没做成」，
单测只能证明参数发对了。真正会出事的四处：

- **断线报了成功，图里的线还在** —— 一个什么都不做的实现也能返回成功。
  所以断完要回头 `material_get_graph` 确认线真的没了。
- **清死节点的 dry_run 默认值两边不一致** —— TS 侧默认 true、引擎侧默认 false
  的话，这个工具会在没人察觉的情况下真的删节点。
- **MPC / 材质函数的资产没挂上** —— 节点照样建出来（灰的、或者一个引脚都没有），
  只在响应体里埋一个 `collection_applied: false`。参数名拼错时尤其危险：
  材质编辑器里看不出来，编译才报 Missing Parameter Collection。
- **反查引用的路径归一化** —— 引用关系记在**包**上。`/Game/X.X` 这种带对象名的
  路径不剥掉后缀的话一条都查不到，而且不报错 —— 看起来就是「没人用」，
  然后用户照着这个结论把还在用的资产删了。

## verify-ue-tools.mjs —— material-pins

```bash
node tests/manual/verify-ue-tools.mjs material-pins
```

验引脚那一层：节点说明书、分量输出、遮罩通道。

**为什么必须真机跑**：三件事全在引擎那一侧，单测只能证明参数发对了。

- **`material_search_nodes` 读的是类默认对象** —— 编得过不等于读得到。
  `GetInputName` / `GetOutputs` 在 CDO 上有没有值只有真引擎能回答。
  断言落在具体的名字上：Lerp 要有 `A`/`B`/`Alpha`，TextureSample 的 UV 输入
  要叫 `Coordinates`（不是 `UVs`），Constant3Vector 的四个输出要报成
  `RGB`/`R`/`G`/`B` 而不是四个 `None`。
- **分量输出以前接不出去，而且不报错** —— `Constant3Vector` 的四个输出一个名字
  都没有，旧的引脚解析匹配不到就掉进「接 0 号」的兜底：写 `.G` 实际接上的是
  `RGB`，返回体照抄入参，看起来完全正确。所以断言是**回读 `from_pin`**，
  不是「连线没报错」。
- **`ComponentMask` 的四个通道位构造函数一个都不设**，默认全 0 编译出来恒为 0。
  不给通道要在建之前就被拒（建完再报警告的话，图里会留下一个必须手工清掉的
  废节点），给了要能回读出来。

前置：

```bash
pnpm dev:ue-verify      # 不是 pnpm dev
```

调试 HTTP 接口**默认关闭**（一组无鉴权的 debug 路由，不该在每台机器上无条件
监听），`pnpm dev` 起来的盒子没有 8766，脚本会连不上。`dev:ue-verify` 只多开
这个接口，**WS 端口不变**，UE 那边不会掉线。

不要用 `pnpm dev:smoke` —— 它把 `WS_PORT` 改成 8765，UE 会立刻断开。

另外要 UE 开着且 UnrealAgentLink 已连接，插件包是当前源码编出来的
（`node scripts/build-all-plugins.mjs`），否则新命令在引擎里不存在。

产物落在 `/Game/UAVerify/`，每轮开始会先清掉。

## game-studio/bench.mjs —— 一句话做游戏的题库

```bash
node tests/manual/game-studio/bench.mjs new tower-defense            # 默认 /team
node tests/manual/game-studio/bench.mjs new tower-defense --arm goal # 对照组
node tests/manual/game-studio/bench.mjs collect .test/game-studio/runs/<运行目录>
node tests/manual/game-studio/bench.mjs report
```

8 个题材、每题一句话，量「从一句话到可玩 MVP」能做到几成。题库、评分表、跑法见
[docs/AI游戏工作室-题库与评分表.md](../../docs/AI游戏工作室-题库与评分表.md)。

**题由人在盒子里发，不由脚本发。** 调试端点没有 `/team`、`/goal` 的循环，
审批还是评测专用的（本机磁盘一律拒绝）—— 做游戏要建工程、写 C++，拿它跑的就不是产品。
脚本只管前后两头：`new` 建记录并打印要粘贴的那一行，`collect` 从会话记录算过程指标、
回引擎做编译和 30 秒冒烟试玩，`report` 汇总。引擎那半要 `pnpm dev:ue-verify` 起的盒子。

**人工评分是主判据**，自动核验只是辅助 —— 「好不好玩、像不像样」没有脚本能判。

## judge-probe.mjs

```bash
node tests/manual/judge-probe.mjs
```

验结构化判定（`src/main/ai/judge.ts` 那一档）的**判据本身**站不站得住：
四种「把判断下沉到工具层」的形态各出几条用例，每条都配一条极易误判的邻域例。

前置只有一个：`TYPESAFE_API_KEY` 在环境变量里（设完要开新终端，`setx` 不影响
当前这个）。会真的发请求产生费用 —— 全量 14 条 × 2 臂大约不到一分钱。

**为什么不接进 `pnpm verify`**：要真密钥、要联网、而且模型不保证确定性，
同一条用例跑两次可能给两个数。它是做决策用的一次性探针，不是回归门禁。

默认跑**双臂**：state 完全相同，只差问题用英文写还是中文写。厂商明说 CJK
可靠性低于英文，而我们的 state 一定是中文（用户目标、资产名、审查结论），
能选的只有问题的语言 —— 这条臂差就把问题一律写成英文，零成本。

看结果时**别只看对错**：

- 「判对但不够笃定」那一列比判错的更值得看。noul 落在 0.35~0.65、choice
  confidence 低于 0.8 的，在真实调用里都会走回落，等于这条判据没起作用。
- `distill-door-graph` 一次问 6 个问题，拿它的 `input_tokens` 和单问题的用例
  比，验证「同一份 state 多问几个几乎不加钱」成不成立 —— 形态二整个建立在
  这条上。

筛选：`--form=3`（只跑前置闸）、`--case=wall-reworded`、`--lang=en`。
明细落 `.test/judge-verdict.json`。

## wall-replay.mjs —— 已跑完，结论是**不做**

```bash
node tests/manual/wall-replay.mjs             # 只扫描，不联网
node tests/manual/wall-replay.mjs --dry-run   # 看将要发送的内容
node tests/manual/wall-replay.mjs --run
```

验「用结构化判定（Jev）替换 `loopBreaker` 的精确匹配」到底成不成立。
**2026-09 在 2326 个真实会话（11025 次工具调用）上跑过，结论是不成立**，
脚本留着是因为那个结论比脚本本身值钱。

真值不靠人工标注：**上一次失败、下一次同工具调用成功了 → 按定义就不是
同一个尝试**。Jev 在这类对上判「是」就是一次确凿的误拦。

实测（200 条样本）：

| 阈值 | 误拦率（recovered） | 命中率（persisted，今天拦不住的那批） |
| ---- | ------------------- | ------------------------------------- |
| 0.50 | 10.8%               | 25.0%                                 |
| 0.85 | 2.5%（3 条）        | 1.7%（1 条）                          |
| 0.95 | 0%                  | 0%                                    |

两条曲线一起塌。更要命的是分布本身几乎重合 —— recovered 的
p10/p50/p90 是 0.06 / 0.14 / 0.68，persisted 是 0.08 / 0.17 / 0.82。
**不是阈值没调好，是这个判断里没有能分开两者的信号。**

原因是问题问错了。`loopBreaker` 想知道的不是「是不是同一个尝试」，
是「**这次会不会再失败一次**」。这两件事只有在失败是确定性的时候才重合，
而 UE 里大量失败是瞬时的（引擎断连、锁竞争、TTS 连接失败）——
被判成误拦的那批正是 `ue_save` / `ue_open_level` / `ue_get_actor` 这类
原样重试一次就好了的。`loopBreaker` 注释里「允许失败 2 次」处理的就是它们。

**留给后来人的教训**：同一批判据在我们自己写的合成用例上分离度是
0.97 / 0.05（见 `judge-cases.mjs` 的 `wall-*`），真实数据上塌成
0.14 / 0.17。合成用例**完全没有预测能力** —— 它们没有采样到真实分布，
只采样到了写用例的人心里那两个极端。任何判据接进去之前都得过这样一道
真实数据闸，合成用例只够用来发现「压根不work」。

## locate-replay.mjs —— 已跑完，结论是**前提不存在**

```bash
node tests/manual/locate-replay.mjs             # 只扫描，不联网
node tests/manual/locate-replay.mjs --run
```

验「探测折叠」：把 `ue_content_search` 从「返回一批候选让模型挑」改成
「工具内部直接定位到那一条」。

真值用 revealed preference：搜索返回 N 条候选 → agent 之后在某次工具调用的
参数里用上了其中一条 → 那条就是它自己选的答案。比 `wall-replay` 那次的真值
干净，因为问的就是本体（「它后来用了哪条」），不是代理。

**但这个闸一条都没跑到 Jev 就停了** —— 2326 个会话里的漏斗长这样：

|                                     | 次数       |
| ----------------------------------- | ---------- |
| 成功的资产搜索                      | 908        |
| 枚举型（`query: "*"`，把库列出来）  | 520（57%） |
| 返回 0 条结果                       | 368（40%） |
| 返回 1 条（无需选）                 | 15         |
| **真的出现「2~40 条候选里挑一个」** | **5**      |
| 其中之后恰好用上 1 条（可判）       | 2          |

**「候选太多要挑一个」这个局面，908 次搜索里发生了 5 次。** 探测折叠要优化
的场景实际上几乎不存在；真实的模式是枚举和搜不到。N=2 不值得花钱去问。

顺带挖出一个**跟 Jev 无关**的线索：368 次零结果里有 100 次带着真实查询词
（`Sphere`、`Wood`、`face`、`M_Wood*`、`wasteland`），只有 6% 含中文。
从 transcript 判断不了那些资产到底存不存在，所以这只是线索不是结论 ——
但如果其中相当一部分是「资产在但名字对不上」，那该上的是模糊/向量检索
（`embedding` 角色已经有了），不是判定模型。Jev 在零结果上帮不了任何忙：
没有候选就没有可判的东西，它不会检索。

## asset-search-miss.mjs —— 已跑完，把上面那条线索**证伪**了

```bash
node tests/manual/asset-search-miss.mjs   # 完全离线，不调模型
```

复核 `locate-replay.mjs` 挖出的「368 次零结果（40%）」到底是不是搜索实现的
问题。不用开引擎：枚举型搜索（`query: "*"`）自己把当时的资产清单存在
transcript 里了，拿它当「这个工程至少有这些」的名单。

**结论：不是 bug。** 不带通配符的零结果 32 条里，只有 2 条（6.3%）名单里
存在包含该词的资产 —— 也就是 94% 的情况下，**当时确实没有能匹配的东西**。
插件那边 `UAL_ContentBrowserCommands.cpp:531` 用的就是
`AssetName.Contains(Query, ESearchCase::IgnoreCase)`，子串、忽略大小写，
本来就是对的。

所以 40% 零结果不是检索坏了，是 **agent 在拿名字猜资产**（`Sphere`、`Wood`、
`face`、`crate`），猜不中就换一个词再猜。那是行为问题不是实现问题。

### 这个脚本第一版是错的，教训记在这儿

第一版把资产名单按**整个会话**攒，报出 25 条「确凿漏检」，样例看着还特别
有说服力（搜 `crate` 找不到，而工程里明明有 `SM_Prop_Crate_Ammo_01`）。

错在时序：agent 搜 `crate` → 没搜到 → **于是导入了** `SM_Prop_Crate_Ammo_01`
→ 之后枚举就看见了。按整个会话攒名单，那条后来才存在的资产被当成了
「当时就在却没搜到」。改成只用**这次搜索之前**见过的资产，25 条塌成 2 条。

**一个能自圆其说、样例还很漂亮的结论，可以整个是分析代码的 bug 造出来的。**
这一条和 `wall-replay` 那条（合成用例没有预测能力）是同一类病的两种表现。

## mcp-call.mjs —— 拿真引擎的传输层

```bash
node tests/manual/mcp-call.mjs --list [--grep=content]
node tests/manual/mcp-call.mjs --tool=ue_get_project_info --args='{}'
```

手动验证要真引擎，而 `/api/debug/agent` 那条路要 `pnpm dev:ue-verify`，会打断
用户正在跑的盒子。**盒子对外的 MCP 服务（17861）本来就是干这个的**：默认开、
端口和 token 都固定持久，163 个 UE 工具直接可调。token 从
`userData/mcp-server.json` 自己读，不打印、不进命令行。

也能当库用：`import { callTool } from './mcp-call.mjs'`。

## audit-probe.mjs —— P2 全工程体检，**结论是「只能当排序器，不能当判据」**

```bash
node tests/manual/audit-probe.mjs --scan      # 只看本机数据
node tests/manual/audit-probe.mjs --run --limit=60
```

先用 `mcp-call.mjs` 跑一段 Python 把资产清单拉成 `.test/bikeout-assets.json`
（路径、类型、引用数、依赖数、大小），再离线判。

**为什么这一条值得验**：它的基线坏得能量化 —— `ue_content_naming_audit` 在
19444 个资产上判违规 **16244 条（83.5%）**，还建议给 Epic 自带的 StarterContent
改名。而缺的那样东西（这资产是谁的）确定性办法只能覆盖 **3.1%**，因为 68% 的
资产堆在一个叫「导入模型文件」的目录里。

实测（BIKEOUT，19444 资产 / 11.14 GB，60 条样本，$0.0015，中位 359ms）：

| 判据                        | 结果                                                                                                      |
| --------------------------- | --------------------------------------------------------------------------------------------------------- |
| `disposable` 零引用能不能删 | 危险错判 **0**，但**系统性过度保守**                                                                      |
| `vendor` 是不是买来的内容   | 认出了目录名规则认不出的（SkyAtmoPro、SciFiAnimatedClocks），但 **4 条明显错判**、17% 落 0.35~0.65 模糊带 |

**`disposable` 输给了一条 6 行的确定性规则。** `refs === 0 && 类型不在入口表里`
同样是 0 危险错判，而且不漏报；Jev 把 SkyAtmoPro 里十几个零引用的 HDRI
（单个 20MB）全判成「别删」—— 而买来的包里没用上的资源恰恰是体检最该报的。
漏报会让清单变空，那样体检就没用了。

**`vendor` 有真信号但不能自动执行**：判对的只到 0.72~0.87，判错的到 0.67，
分布重叠。错判有明显规律 —— `MSPresets/Black`、`ArtTools/127grey`、
`Twinmotion/VegetationMaterialParameters` 这类名字不像商城内容的功能性小资产
一律判否。它看的是**名字风格**，不是来源，正是 jaggedness 里「读得字面」那条。

**能用的形态只有一个：排序，不是判定。** 体检报告是给人看的清单，而 16244 条
没法看。用 `vendor` 概率排序、只呈现高置信的，把清单压到几十条让人复核 ——
错判的代价只是排序不理想，不是删错东西。这也正好是 Codex 那份意见里唯一
认可的形态：批量初筛，不裁定对错。

## failure-census.mjs —— 工具失败普查，**把 18.8% 这个数证伪了**

```bash
node tests/manual/failure-census.mjs [--tool=xxx] [--top=25]
```

离线，不调模型。前五轮都是「先想题目再找证据」，这个脚本反过来：先看数据。

**结论：18.8% 的工具失败率是假的。**

|                                       | 次数     | 占比                  |
| ------------------------------------- | -------- | --------------------- |
| 工具调用                              | 11025    |                       |
| **用户按停止**（`Operation aborted`） | **1562** | 14.2% ← 不是失败      |
| 真的失败                              | 506      | 占非中断调用 **5.3%** |

失败之后发生了什么（这一刀最要紧）：

|                            | 次数   | 占比     |
| -------------------------- | ------ | -------- |
| 同名工具后来成功了（自愈） | 273    | 54.0%    |
| 换别的工具继续干（绕路）   | 206    | 40.7%    |
| 还在同一个工具上打转       | 9      | 1.8%     |
| **会话到此为止**           | **18** | **3.6%** |

**真正伤到用户的失败，2326 个会话里一共 18 次。** 5.3% 的失败率 + 94.7% 的
自愈/绕路率，这是个健康的数字，不是问题。

失败也不集中：184 种签名，最大的一种（模型写的 Python 报 Traceback）只占
14.8%，而那类模型自己读报错就能改。

### 顺带两件事

**一、中断被标成 `isError: true`。** `resume.ts` 的注释写得很清楚
「中止是意图达成，不是故障」，但 toolResult 上那一位仍然是 true。后果是
**任何按 isError 统计的东西都会被放大 3.4 倍** —— 我自己就先被骗了一轮。
查过 `loopBreaker`：它也按 isError 计数，但它在 `createUnrealAgent` 里建、
每条消息重建，而中断会结束整条消息，计数攒不起来，**不是 bug**。
界面上把用户主动停止显示成红色失败倒是有点冤。

**二、几个工具的失败率值得单独看**：`ue_content_delete` 12/15（80%）、
`blueprint_apply_graph` 23/91（25%）、`blueprint_compile` 10/33（30%）。
样本都小，但比平均值高一个数量级。
