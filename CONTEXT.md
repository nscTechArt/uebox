# CONTEXT.md — 术语表

本文件只做一件事：**把这个项目里容易混淆的词定死**。

它不是设计文档，不写实现细节，不记录决策过程。写代码的规范在 [AGENTS.md](AGENTS.md)，
分层地图在 [docs/contributing/vertical-slice.md](docs/contributing/vertical-slice.md)。

用词跟这里不一致时，以这里为准；发现这里定义错了，改这里。
新增或修改 _Avoid_ 时，同步考虑术语守卫（`src/renderer/src/i18n/terminologyGuard.test.ts`）的禁用词表，两处一起改。

---

## 产品

**虚幻盒子 (Unreal Box)**
虚幻引擎的 agent harness —— 让 AI Agent 能够实际操作虚幻工程的本地运行环境。
产品的主体是 Agent，其余模块（项目库、资产库、蓝图库、材质库、笔记与知识库）服务于它。
本仓库提供完整的开源桌面应用，本地功能无需账号和网络连接。
AI 使用用户配置的模型服务；网络资产库使用用户自己的服务器。

**harness**
不译。指盒子围着 Agent 搭的那一整套东西：模型接入、工具集、技能、约束与核对。
不要写成「框架」或「外壳」—— 前者会和 Electron/Vue 这类技术栈混，后者暗示它只是个界面。

## 用户与数据

**保管库 (Vault)**
用户存放资产的一个独立仓库，对应磁盘上的一个目录加一份索引。一个用户可以有多个保管库并在其间切换。
「切换保管库」切换的是整个资产视图，不是筛选。

**资产 (Asset)**
保管库里被索引的一个文件（贴图、模型、音频、蓝图导出等），带缩略图、标签、收藏状态等元数据。
注意与**虚幻引擎里的 Asset（`.uasset`）**区分：后者属于用户的 UE 项目，不归保管库管。

**标签 (Tag)**
用户给资产打的分类标记，有名称与颜色，可归入**标签分组**。标签是用户数据，不是主题样式 ——
所以标签颜色允许是具体色值，不受「禁止硬编码颜色」那条规则约束。

**项目 (Project)** / **引擎 (Engine)**
项目 = 用户的一个 `.uproject` 及其目录；引擎 = 一个虚幻引擎安装（Epic Launcher 装的或源码编译的）。
两者是多对一：一个项目指定它需要的那个引擎版本。

## 功能模块

**资产库 / 蓝图库 / 材质库 (Asset / Blueprint / Material Library)**
三个收藏与复用的入口。**只有蓝图库和材质库共用「库浏览器」**，各自是一份不同的
**视图 (Scope)**：限定看哪些类型、显示哪些筛选字段、双击时打开哪个编辑器。
资产库目前是独立实现（`views/AssetManagement/`），没有走这个共用件 ——
「三个库同一套骨架」是目标，不是现状，别照着这句话去假设代码长什么样。

**库浏览器 (Library Browser)**
`src/renderer/src/views/library-common/browser/`。文件夹树 + 网格 + 筛选 + 标签 + 详情，
人人都要的那部分。它**不认识**蓝图节点、材质图、云盘 —— 需要在里面写
`if (kind === 'blueprint')` 的东西，都该做成模块。

**模块 (Browser Module，内部也叫「DLC」)**
库浏览器上可插拔的功能单元：百度云、WebDAV、网络协作库、依赖图……
声明式地挂到工具栏、侧栏、右键菜单、状态条几个插槽上，用户自己开关。

**笔记本 (Notebook)**
知识收集与研究模块：存网页、视频、文档，并在其上做检索、深度研究、生成脑图与报告。
与「笔记 (Note)」区分：笔记是笔记本里的一条内容。

**AI 助手 (Assistant)**
对话入口，背后是 `src/main/agent-v3/`：**一个** Agent 直接拿到全部工具，自己决定调哪个。
V2 那套「按问题类型路由到专家 Agent」已经废除，理由见 `agent-v3/core/createAgent.ts` 的注释。

**对话 (Chat)**
用户与 AI 之间的一条往来。AI 助手里的对话列在侧边栏；知识库、蓝图库、材质库的页面里各嵌着一条，不进侧边栏。
背后是不是 Agent 驱动不构成区别。代码里叫 `ChatSession`，它的 id 叫 `chatSid`（局部简写 `sid`）。
由 Agent 驱动的对话，在内核那一层对应一份 **session**，见该词条。
别的概念的英文名不得含 "Chat"。
_Avoid_：会话、聊天；Conversation、Session、Thread

**消息 (Message)**
对话里的一个气泡，用户发的或 AI 回的。

**一轮 (Turn)**
用户发出一条消息，加上 AI 为它做的全部回应（回复与工具调用）。
_Avoid_：回合、一问一答；Exchange、Conversation turn

**分支 (Branch)**
一个动作：从一条对话的某条回复处复制出一条新对话，之后两边互不影响。分支出来的仍是一条普通对话，不是另一种东西。
它靠内核复制一份 **session** 实现；内核把这个复制动作叫 fork，侧边问一句也用它。fork 只指内核那一步，不是分支的别名。
代码里界面这一层叫 `chatBranch`，内核复制那一步仍叫 fork。
_Avoid_：会话分支、对话分支；Session branch、Fork

**侧边问一句 (Side question)**
借一条对话的上下文，在小窗里只读地问一句；问完关掉，什么都不留下。它不是一条对话。
被借上下文的那条对话，在这个场景里叫它的**主对话 (main chat)**。代码里叫 `sideQuestion`。
_Avoid_：侧边对话、侧边聊天；Side chat

**语音通话 (Voice call)**
用户与语音助手之间的一次实时语音交流，绑定在一条对话上；有开始、有挂断，通话结束后对话还在。
代码里叫 `voiceAssistant`，通话绑定在哪条对话上记在 `voiceChatSid`。
_Avoid_：语音对话、语音会话；Voice conversation、Voice session

**小窗 (Mini window)**
AI 助手的浮动小窗口，不切回主窗口就能和 AI 对话；侧边问一句也在这里进行。代码里叫 MiniChat。
_Avoid_：MiniChat、Mini Chat、迷你对话

**session**
内核那一层的单元：Agent 实际读写的那份历史，代码里 `agentSessionId`。不翻译，中文界面也写 "session"；
只出现在面向开发者的界面（如调试台），面向用户的文案里不出现。
id 命名规则：渲染层与 shared 里 `sessionId` / `agentSessionId` 指内核 session，`sid` / `chatSid` 指对话；
网络库导入的 `sessionId` 属导入领域。
例外：过 IPC 的载荷字段沿用原名 —— `TrayAction` 的 `open-session` 里 `sessionId` 是对话 id，`ai.chatStream` 的 `sessionId` 是单次流 id。
_Avoid_：会话、内核记忆

**UnrealAgentLink**
装在用户 UE 项目里的插件，是虚幻盒子与引擎之间的通道。它连上之后，AI 才能"看见"当前关卡与选中资产，
并反过来在引擎里执行操作。装在**项目**的 `Plugins/` 下而不是引擎目录 ——

## 工程

**门禁 (Gate)**
一项自动检查。所有门禁的唯一定义在 `scripts/verify.mjs`，由 `pnpm verify` 执行，CI 只是跑同一条命令。
「门禁全绿」是贡献可被合并的前提。

**棘轮 (Ratchet)**
一种只能单向收紧的门禁：记录当前的残留数量作为基线，只允许变少。
用于逐步清理已有代码问题，并防止新增。

**垂直切片 (Vertical Slice)**
一个功能从数据库到界面所穿过的那一串层。本仓库共七层，漏掉任何一层都会导致"能编译但没反应"。

**验收清单 (Definition of Done)**
判断一份贡献是否算完成的可勾选清单，见 `docs/contributing/definition-of-done.zh-CN.md`。
它与 PR 模板逐条对应。
