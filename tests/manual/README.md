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
