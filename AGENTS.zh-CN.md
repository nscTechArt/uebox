# AGENTS.zh-CN.md

给在本仓库里干活的 AI 编码 Agent 的说明。
English: [AGENTS.md](AGENTS.md)（两份必须同步更新，CI 会检查）

---

## 1. 这是什么项目

**虚幻盒子（Unreal Box）** —— 虚幻引擎的 agent harness：一套让 AI Agent 能够实际操作
虚幻工程的本地运行环境。技术栈 Electron + Vue 3 + TypeScript。

产品的主体是这个 Agent。围着它的 harness 由四部分构成：模型接入、虚幻引擎工具集、技能、
约束与核对；与编辑器之间的连接由随包的 UnrealAgentLink 插件承担。

其余模块 —— 项目库、资产库、蓝图库与材质库、笔记与知识库 —— 各自有完整的独立界面，
但在产品结构中它们服务于 Agent：登记它的作用目标、给它供料、接住它的产出。
判断一个功能该归到哪里时，按这个关系判断。

本仓库是完整的开源桌面应用。本地功能完全离线运行，不需要账号，没有区域门禁。
可选的 AI 和网络资产库功能使用用户主动配置的服务。

**绝对不要**给本地功能加遥测、远程请求或账号强制要求。

## 2. 环境准备

```bash
pnpm install
pnpm dev          # 启动应用（Electron）
```

主力平台是 Windows。pnpm 10.28.2，Node 24.21.0。
项目在 `.npmrc` 中固定 Node 版本；直接执行 Node 命令时使用 `pnpm exec node`，
确保系统 Node 版本不同时仍使用项目运行环境。

## 3. 门禁分两档，你欠哪一档

**做完一个任务：**

```bash
pnpm verify:changed     # 约 30 秒 —— 只查你改的东西
```

**这批活要发出去之前** —— 准备 `git push`、出包、或者把整批交出去：

```bash
pnpm verify             # 约 3.5 分钟 —— 完整门禁
```

**不要每做完一件小事就跑完整门禁。** 那 3.5 分钟几乎全是固定开销：全量 lint 棘轮 49 秒、
两侧类型检查 45 秒、全量单测 126 秒 —— 而那 126 秒里真正执行测试只有 43 秒，其余是
386 个测试文件各建一遍环境。按任务付这笔钱是这个仓库里最大的一处时间浪费。
多个会话同时干活时它还会**误导你**：门禁是全仓范围的，别的会话写到一半的文件会把
**你的**门禁弄红（见 §5 第 11 条）。

`verify:changed` 是快照不是替代品 —— 东西发出去之前，完整门禁仍然必须过一次。
敢把它推迟到最后，靠的是两件事：

- 每个任务都单独过了那 30 秒，所以完整门禁一旦红，你知道是**这批**里的问题，
  而不是三小时前某个已经想不起来的任务。
- **CI 是兜底的那张网。** `.github/workflows/quality.yml` 里除了 `pnpm verify --ci` 什么都没有，
  而且**每次 push 都跑** —— 完整门禁加上打包和离线启动检查。门禁只在
  `scripts/verify.mjs` 一处定义，本地和 CI 不可能漂。本地忘了跑，代价是 GitHub 上亮个红灯，
  不是让用户装到坏包。

任何一步失败都会告诉你**具体该改什么、敲什么命令**。
跑门禁时**不用关应用** —— 它已经不再碰 `better-sqlite3` 的原生产物。

| 步骤 | 检查什么 |
|---|---|
| `security:secrets` | 有没有把密钥提交进仓库 |
| `verify:official-endpoints` | 棘轮：社区版核心不许新增对官方服务端的调用 |
| `lint` | 棘轮：全仓 ESLint，逐文件不得超过 `scripts/lint.baseline.json` 的存量 |
| `lint:changed` | **对你改动的那些行跑全量 ESLint 规则** —— 零容忍 |
| `docs:check` | 成对的中英文档有没有一起改 |
| `verify:skills` | `resources/skills/**` 是否符合 `resources/skills/SKILL_STANDARD.md` |
| `verify:ue-file-reads` | 引擎写的文件（`.uproject` / `.uplugin` / 引擎 `ini`）不许按固定编码读 —— 见第 5 节 |
| `plugin:check` | 改了插件源码就必须重新出包 —— 这一步只查 UE 5.5 |
| `typecheck` | `tsconfig.node.json`（主进程）+ `tsconfig.web.json`（渲染进程）+ `tsconfig.cli.json`（`packages/cli`） |
| `test:run` | Vitest，跑全仓单测（数量不写在这里 —— 它每天都在变，写死只会变成又一个过期数字） |
| `audit:prod` | 仅 CI —— 生产依赖没有高危漏洞 |
| `build:unpack` | 仅 CI —— 生产构建 + 打包 + 打包依赖闭包检查 |
| `verify:offline-boot` | 仅 CI —— 启动打包产物逐页走一遍，社区版必须零官方服务端请求 |

按任务那一档具体做了什么：`verify:changed` 跳过全量 lint 棘轮（新代码仍由 `lint:changed`
零容忍把关），类型检查只查改动涉及的那一侧，单测只跑与改动相关的那些。
上表里其余的步骤照跑 —— 它们本来就便宜。

它的比较基准是 `$VERIFY_BASE` → `origin/main` → `main` → `HEAD`。所以攒着没推的一批越大，
`verify:changed` 就越往整批扩。想严格只查眼前这一个任务，把基准钉死：
`VERIFY_BASE=HEAD pnpm verify:changed`。

另外两个变体：`pnpm verify:fast`（完整门禁，但单测那一步跳过原生产物预检）、
`pnpm verify --with-build`（本地也跑打包与离线启动门禁，改了主进程 / 构建配置 / 依赖时用）。

插件分发包新鲜度分两档。`pnpm verify` 里的 `plugin:check` **只查 UE 5.5**（开发时编的那个），
出包：`pnpm plugin:build --engine 5.5 --project <uproject 路径>`。
严格的那一档是 `plugin:check:all`，挂在出正式安装包的脚本上
（`build:win` / `build:mac` / `build:linux`），要求 **5.0–5.8 每个版本都新鲜**
—— 发版时少一个版本，那个版本的用户就实实在在装到旧插件。出全套：`node scripts/build-all-plugins.mjs`。

出正式安装包就是 `pnpm build:win` 一条命令，没有渠道之分（原来的 personal / enterprise
双通道连同 `build:win:personal`、`sync:update-feed`、渠道标记文件一起删了）。更新源只有
一条线：**公开的 GitHub Releases**。把 `package.json` 的 `updateGithubRepo` 填成 `owner/repo`，
构建脚本才会注入 publish 并生成 `latest.yml`；留空打出的是不带更新源的纯净包 —— 开机
一次更新请求都不发，别人克隆这个仓库自己编也是这个形态。「检查更新」读的是那个仓库
Release 上的 `.exe`、`.blockmap`、`latest.yml`。运行期解析见 `src/main/services/updater/updateFeed.ts`。

**发版不只是发 GitHub Release**：官网下载按钮读的是 R2 镜像（`pnpm release:dl`），插件源码变了
还要单独发到插件仓库。完整清单见 [docs/发版流程.md](docs/发版流程.md)，一步不落地走完。

**不许**用跳过测试、删测试、加 `.skip`、扩大 ESLint ignore、降低覆盖率阈值的方式把门禁弄绿。
如果你认为某条门禁本身有问题，在 PR 里说出来，不要绕过去。

## 4. 代码写在哪 —— 垂直切片

几乎每个功能都要穿过同样的七层。漏掉其中一层是最常见的翻车方式。以标签为例：

| # | 层 | 路径 | 职责 |
|---|---|---|---|
| 1 | 数据模型 | `src/main/sqliteDataBase/models/tag.ts` | 建表 DDL + SQL |
| 2 | IPC 处理 | `src/main/sqliteDataBase/ipc/tag.ts` | `ipcMain.handle('db:tags:*')` |
| 3 | 预加载桥 | `src/preload/index.ts` | `contextBridge` → `window.api.database.tag.*` |
| 4 | 预加载类型 | `src/preload/index.d.ts` | **必须和 #3 一起改** |
| 5 | 渲染层 API | `src/renderer/src/api/tag.ts` | `tagAPI.*`，统一走 `unwrapResult()` |
| 6 | 状态 | `src/renderer/src/store/modules/*` | Pinia，只在状态需要共享时才加 |
| 7 | 界面 | `src/renderer/src/views/**` | Vue 组件 |

带真实示例的完整走查：[docs/contributing/vertical-slice.md](docs/contributing/vertical-slice.md)。

本项目的术语定义见 [CONTEXT.md](CONTEXT.md)。

其他入口：主进程 IPC 在 `src/main/ipc/`，AI Agent 在 `src/main/agent-v3/`
（`agent-v2/` 已删除，只在历史文档里出现），跨进程共享类型在 `src/shared/`。

这七层之外还有四块地方，各自带一条额外义务，没做到就不算做完：

| 区域 | 路径 | 义务 |
|---|---|---|
| Agent 工具 | `src/main/agent-v3/tools/` | 用 `defineTool` / `defineUeTool` 定义，在 `registry.ts` 注册；注意第 7 节的 `appSettingsManager` 坑 |
| 运行时技能（盒子内置 Agent 和 CLI 加载的） | `resources/skills/**`、`packages/cli/skills/**` | 必须符合 `resources/skills/SKILL_STANDARD.md`，门禁步骤 `verify:skills` |
| UE 插件 | `plugin/UnrealAgentLink/` | 改了源码就要重编 UE 5.5 的 zip，否则门禁步骤 `plugin:check` 变红（见第 3 节） |
| `uebox` 命令行 | `packages/cli/` | 门禁通过 `tsconfig.cli.json` 做类型检查；`pnpm verify:cli-package`（构建 + 发布包体检）不在门禁里，发包前自己跑 |

## 5. 硬规则

1. **不许硬编码颜色和间距。** 用 `src/renderer/src/assets/styles/theme.css` 里的 CSS 变量，
   规范见 [docs/UI-Design-Standards.md](docs/UI-Design-Standards.md)。
   应用有深色 / 浅色 / 高对比三套主题，写死一个 HEX 会直接毁掉其中两套。
2. **界面组件先看 [docs/ui-components.md](docs/ui-components.md)。** 渲染进程**故意**有两套组件来源：
   自建的 `App*.vue` 和剩下的 ant-design-vue。界线是「会被点击、会弹浮层的用自建的，
   表单输入类还在 antd」。写错了 ESLint 会拦你，并在报错信息里写出该用哪个。
   不要给已经替换过的 antd 组件再包一层。
3. **用户能看见的文案必须双语。** key 要同时加进
   `src/renderer/src/i18n/locales/zh-CN.ts` 和 `en-US.ts`。新代码不要在 `.vue` 模板里写死中文。
4. **`src/preload/index.ts` 和 `src/preload/index.d.ts` 必须一起改**，否则 typecheck 直接挂。
5. **渲染进程不许直接调 `ipcRenderer`。** 走 `window.api.*`，并在 `src/renderer/src/api/*` 里
   用 `unwrapResult()` 包一层，保证错误处理一致。
   **包一层是死规矩，`unwrapResult()` 是默认做法、不是唯一做法。** 它是**抛异常**的，
   适合「拿不到数据就没法往下走」的读取类调用。而调用方必须自己看失败、各报各的那种接口
   （用户点一下就发一次的动作），可以改成回 `{ success, error?, errorKey? }` ——
   前提是所有调用点仍旧走这一层，且理由写在模块文件头里。
   参考 `src/renderer/src/api/updater.ts`。
6. **新行为必须有测试。** 放 `tests/` 或与源码同目录的 `*.test.ts` 都行，两种都会被收集。
   见 [docs/contributing/testing.md](docs/contributing/testing.md)。
7. **不要新增依赖、网络请求、遥测**，除非 Issue 里明确要求。CI 会跑 `pnpm audit:prod`，
   新增的包会被重点审查。
8. **不要格式化你没改的文件。** 10 行功能带出 900 行 diff 的 PR 不会被合并。
9. **动手前先读文档。** 先在 `docs/` 里找你要碰的那块有没有现成规范
   （`docs/资产库避坑指南.md`、`docs/ContextMenu组件使用规范.md`、`docs/router-meta.md` …）。
10. **用户创作的东西，唯一真相源是磁盘上的文件。** 数据库只是能删掉重建的索引，
   localStorage 只配存界面偏好和一次性标记。社区版承诺「数据在用户自己手里」——
   拷得走、备份得到、换台机器还在，靠的就是这一条。凭据同理：localStorage 是明文的，
   走主进程的安全存储。门禁见 `scripts/check-local-storage.mjs`，
   现存欠账登记在 `scripts/local-storage.baseline.json`，只准变少。

11. **这个仓库经常有好几个 Agent 会话同时在改。** 三条铁律：
    - **提交只按路径提你自己动过的文件。** `git add -A` / `git add .` / `git commit -a`
      会把别人还没提交的活一起收进你的 commit —— 代码不会丢，但历史脏了，
      出问题也没法回溯。这几个命令已经在 `.claude/settings.json` 的 deny 列表里禁掉了。
    - **全量 `pnpm verify` 只在收工时跑，而且一次只有一个会话跑。** 干活中间用
      `pnpm verify:changed`。门禁是全仓的：别人写到一半的文件会让你的门禁变红，
      而那不是你能修的。**别去改不属于你这次任务的文件让门禁变绿** ——
      在交接说明里写清楚是谁的半成品卡住了，比替他改完更有用。
    - **四个棘轮基线文件是全仓共享的**（`scripts/` 下的 lint / colors /
      local-storage / official-endpoints）。它们天生只能一个会话一个会话地更新，
      同时改必冲突。要更新基线，先确认此刻只有你一个会话在收工。

12. **引擎写的文件不许按固定编码读。** UE 保存 `.uproject` / `.uplugin` 用的是
    `SaveStringToFile` 的 AutoDetect：内容里有一个非 ASCII 字符（中文工程名、中文描述）
    就整份存成 UTF-16LE。按 `'utf-8'` 硬读得到的是乱码，`JSON.parse` 当场抛
    `Unexpected token '�'` —— 用户那边表现为「插件装不上、AI 看不见引擎」，
    而报错信息他一个字也看不懂。读一律走 `src/main/utils/ueTextFile.ts`
    （`readUeTextFile` / `readUeJsonFile` / `decodeUeText`），写回去用不带 BOM 的 UTF-8
    （引擎没有 BOM 时按 UTF-8 解，5.0–5.8 一致）。门禁见 `scripts/check-ue-file-reads.mjs`。

13. **多媒体进模型：先走对象存储，走不通再退。** 图片、视频、音频 —— 凡是用户交给模型
    的多媒体，先传到用户自己配的对象存储（设置 → 对象存储），给模型一个链接。只有存储
    没配、模型收不了这一类的链接、或者这次上传失败，才退回旧路：图片走 base64，
    音视频只给本地路径、由 agent 用 `analyze_video` 去看。base64 跟着整条 transcript
    每轮重发，一大就撞请求预算（`requestBudget.ts` 从最大的开始丢），还会撞厂商的
    体积上限；链接只有几百字节。退的每一步都不许打断这一轮：判断出错、上传失败，
    只让那一个文件降级，消息照发。
    做决定的地方只有一处：`src/main/agent-v3/core/promptMedia.ts`
    （`preparePromptImages` / `preparePromptMedia`）；引用在发送时由 `streamFn.ts`
    改写成 `image_url` / `video_url` / `input_audio`。接新的媒体类型就接进这个文件，
    **不要另开一条上传路径**。
    工具产出的图（编辑器截图、联系表）**不走这条**：一轮工具循环里截图很多，每张都先
    上传会拖慢每一步，编辑器画面也不该默认进第三方存储（见 `screenshot.ts` 文件头）。

14. **写入类工具的回执只报引擎现在的样子，部分失败不许开口说成功。** 模型把回执当事实：
    看到「成功」就收工，没写的就当不存在。回执可以不全，但不能错。两条：
    - **状态字段改完再读。** 回执里描述结果的字段（值、类型、容器、引脚、连线、是否可编辑、
      是否编译成功）必须在所有改动（含编译）都完成之后从引擎读出来，不许把请求参数原样写回去，
      也不许用中途拍的快照。调用方传来当查找键的名字、路径可以原样带回。
      反例：`is_array` 回显入参而实际按 `container` 建成了数组；引脚在连线之前序列化；
      `bCompiled = true` 不看编译结果。改不了、查不到的，写 `needs_compile` / `unknown`，
      不要替引擎猜。
    - **有一件没办成，第一句就不许说成功。** C++ 侧有失败就在顶层给 `failed_count`；
      TS 侧给模型的文字第一句写「N 成功 / M 失败」，失败原因逐条跟在后面，不许先 ✅ 再在
      后面的数组里藏失败。全部失败按错误抛。
    新写或改动写入类工具时，测试里要有一条「引擎回的值和入参不同」的用例，断言回执跟着引擎走；
    有批量语义的再加一条「部分失败」用例。

## 6. 提交与 PR

- Conventional Commits + **中文**描述，和现有历史保持一致：
  `feat: 支持自定义标签颜色`、`fix: 修复打包产物无法启动的两个缺陷`、`feat!: 卸载工作流 Nexus`
- 分支名：`feat/<slug>`、`fix/<slug>`
- 如实填写 `.github/PULL_REQUEST_TEMPLATE.md`，包括 `pnpm verify` 是否真的全绿。
- **`git push` 和开 PR 之前必须停下来问人。** 本地提交可以自己做，
  但「发出去」是贡献者的决定，不是你的。
- 欢迎并鼓励 AI 辅助的贡献。在 PR 里勾上就行，不会因此减分。
  review 看的是 diff 和门禁，不是谁敲的键盘。

## 7. 已知陷阱

- **`better-sqlite3` 的 ABI —— 已经不是陷阱了。** Node 与 Electron 的 ABI 不同，
  但两份产物现在各缓存一份：测试经 vitest 别名读 Node 那份，`node_modules` 里始终是 Electron 那份。
  **开着应用也能跑测试。**
  万一看到 `NODE_MODULE_VERSION`，是缓存没建好，跑
  `node scripts/better-sqlite3-abi.mjs ensure node` 补上即可（不碰 `node_modules`）。
- **`pnpm lint` 是棘轮，不是「全绿」。** 它对全仓跑 ESLint，但比对的是一份记录在案的存量
  （`scripts/lint.baseline.json`：341 个文件 / 2435 errors / 3440 warnings）。
  存量问题不是你的活，只要求不变多。
- **门禁提示存量变少了**，就跑 `pnpm lint:baseline:update` 并把更新后的基线一起提交。
  棘轮只能往一个方向转：`--update` 拒绝任何变大。
- **真正管住你代码的是 `pnpm lint:changed`。** 棘轮允许你在同一个文件里把 30 个存量问题
  换成另外 30 个，逐行门禁不允许。
- **80% 覆盖率阈值只统计 `src/renderer/**`\*\*；主进程和预加载不计入覆盖率，
  但你新加的逻辑照样要有测试。
- **别在 Agent 工具里静态 import `appSettingsManager`。** 它顶上有
  `import { logger } from './services'`，那个模块会把 WebSocket 服务、任务执行器一路拉进来，
  最终连上 `better-sqlite3` 的原生模块。工具注册表是所有工具的入口，静态引它等于让**每一个**
  import 到注册表的测试都在 vitest 的 worker 线程里加载那个原生模块。后果不是「慢」，是
  **整个测试进程段错误退出**（Windows 上 0xC0000005，单测全绿但 `pnpm test:run` 直接崩）。
  要用就在函数里 `await import(...)` 懒加载。
- **scoped 样式里的 `:global(...)` 必须独占整条选择器。** 写成
  `:global([data-theme='dark']) .foo` 时，Vue 会把它后面的部分丢掉，编译出来是光秃秃的
  `[data-theme='dark']` —— 也就是 `<html>` 自己，样式会打到整个应用上（实际发生过：
  一条 `filter` 把整个偏好设置刷成白屏）。**祖先选择器直接写**，scoped 会给末段补
  `[data-v-xxx]`，本来就只命中本组件。门禁：`tests/unit/scoped-global-selector.test.ts`。

## 8. 卡住了怎么办

不要猜，也不要偷偷把任务缩小。把你试过什么、门禁报了什么、需要谁来拍板讲清楚。
一个诚实说明「哪块没做完」的 PR，比一个绕过了难点的绿灯 PR 有用得多。
