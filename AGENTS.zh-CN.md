# AGENTS.zh-CN.md

给在本仓库里干活的 AI 编码 Agent 的说明。
English: [AGENTS.md](AGENTS.md)（两份必须同步更新，CI 会检查）

---

## 0. 本 fork —— 先读这节

本节只约束**本 fork** 中的工作方式，不是贡献内容：PR 分支从 `upstream/main` 切、
不从本地 `main` 切，这样本节和 `docs/agents/` 都不会进上游 PR。

- **验证按需进行。** 写代码、提交、交接；提交不带验证。仅当用户在本会话中明说，
  或所调用技能的说明要求时，才执行 `pnpm verify*`（任何变体）、`lint`、`typecheck`
  或 vitest 全量测试。检查真跑起来时，第 3 节的规则照样生效。
- **单个测试文件仍允许**在实现过程中跑 —— 是自查，不是门禁。
- **issue、spec 与 triage 标签** → `docs/agents/issue-tracker.md`（本地 markdown，放在
  `.scratch/<feature-slug>/` 下）和 `docs/agents/triage-labels.md`。**开始探索某块代码之前** →
  `docs/agents/domain.md`。

## 1. 这是什么项目

**虚幻盒子（Unreal Box）** —— 虚幻引擎的 agent harness：一套让 AI Agent 能够实际操作
虚幻工程的本地运行环境。技术栈 Electron + Vue 3 + TypeScript。

其余模块 —— 项目库、资产库、蓝图库与材质库、笔记与知识库 —— 服务于 Agent：
登记它的作用目标、给它供料、接住它的产出。判断一个功能该归到哪里时，按这个关系判断。

本仓库是完整的开源桌面应用。本地功能完全离线运行，不需要账号，没有区域门禁。
可选的 AI 和网络资产库功能使用用户主动配置的服务。

**绝对不要**给本地功能加遥测、远程请求或账号强制要求。

## 2. 环境准备

```bash
pnpm install
pnpm dev          # 启动应用（Electron）
```

主力平台是 Windows。项目在 `.npmrc` 中固定 Node 版本；直接执行 Node 命令时使用 `pnpm exec node`，
确保系统 Node 版本不同时仍使用项目运行环境。

## 3. 门禁分两档，你欠哪一档

> **本 fork 由第 0 节暂停下面的执行时刻表。**

**干活过程中：不跑门禁。** 先把功能做完。最多只跑你正在写的那一个测试文件
（`pnpm exec vitest run <文件>`）。

**功能做完、准备提交时：**

```bash
pnpm verify:changed     # 只查你改的东西；每次提交跑一次，不是每改一下跑一次
```

**这批活要发出去之前** —— 准备 `git push`、出包、或者把整批交出去：

```bash
pnpm verify             # 完整门禁
```

**每一档只在它的节点跑一次，不按每次改动跑。** 完整门禁几乎全是固定开销，而且是全仓范围的，
别的会话写到一半的文件会把**你的**门禁弄红（见 §5 第 11 条）。

门禁步骤只在 `scripts/verify.mjs` 一处定义（CI 在 PR 和向 `main` 的 push 上跑
`pnpm verify --ci`，但不跑插件包与原生检查，CI 绿灯不等于原生验收通过）；
任何一步失败都会告诉你该改什么。跑门禁时不用关应用。

`verify:changed` 跳过全量 lint 棘轮（新改的行仍由 `lint:changed` 把关），类型检查只查改动
涉及的那一侧，单测只跑相关的那些。它的比较基准是 `$VERIFY_BASE` → `origin/main` → `main`
→ `HEAD`，所以攒着没推的一批越大，它就越往整批扩。想严格只查眼前这一个任务，把基准钉死：
`VERIFY_BASE=HEAD pnpm verify:changed`。

改了主进程 / 构建配置 / 依赖 → 加 `--with-build`（本地也跑打包与离线启动）。

`verify:plugin` 只在改动碰到会进分发包的插件输入时才查包，而且只查 `VERIFY_PLUGIN_ENGINE`
选定的那个版本。**怎么选目标、没装 Unreal 时怎么办** →
[打包指南](docs/contributing/packaging.zh-CN.md#日常门禁)。
**出正式安装包、更新源、发版** →
[同一份指南](docs/contributing/packaging.zh-CN.md#正式安装包)。

**认为某条门禁本身有问题，就在 PR 里说出来**，检查原样保留。跳过测试、删测试、加 `.skip`、
扩大 ESLint ignore、降低覆盖率阈值，都是绕过门禁，不是修好它。

## 4. 代码写在哪 —— 垂直切片

几乎每个功能都要穿过同样的七层。漏掉其中一层是最常见的翻车方式。以标签为例：

| # | 层 | 路径 | 职责 |
|---|---|---|---|
| 1 | 数据模型 | `src/main/sqliteDataBase/models/tag.ts` | 建表 DDL + SQL |
| 2 | IPC 处理 | `src/main/sqliteDataBase/ipc/tag.ts` | `ipcMain.handle('db:tags:*')` |
| 3 | 预加载桥 | `src/preload/index.ts` | `contextBridge` → `window.api.database.tag.*` |
| 4 | 预加载类型 | `src/preload/index.d.ts` | `window.api.*` 的类型声明 |
| 5 | 渲染层 API | `src/renderer/src/api/tag.ts` | `tagAPI.*`，统一走 `unwrapResult()` |
| 6 | 状态 | `src/renderer/src/store/modules/*` | Pinia，只在状态需要共享时才加 |
| 7 | 界面 | `src/renderer/src/views/**` | Vue 组件 |

带真实示例的完整走查：[docs/contributing/vertical-slice.md](docs/contributing/vertical-slice.md)。

本项目的术语定义见 [CONTEXT.md](CONTEXT.md)。

其他入口：主进程 IPC 在 `src/main/ipc/`，AI Agent 在 `src/main/agent-v3/`。

模块地图：[docs/module-map.md](docs/module-map.md)——主进程里哪个模块拥有一项行为、模块之间的
接口。放置新的主进程代码之前先查它；当一次变更在模块间移动了职责、接口、状态归属或
依赖时，在同一次变更里更新它。

这七层之外还有四块地方，各自带一条额外义务，没做到就不算做完：

| 区域 | 路径 | 义务 |
|---|---|---|
| Agent 工具 | `src/main/agent-v3/tools/` | 用 `defineTool` / `defineUeTool` 定义，在 `registry.ts` 注册；注意第 7 节的 `appSettingsManager` 坑；多媒体输入和写入类工具的回执按第 5 节第 13–14 条办 |
| 运行时技能（盒子内置 Agent 和 CLI 加载的） | `resources/skills/**`、`packages/cli/skills/**` | 必须符合 `resources/skills/SKILL_STANDARD.md`，门禁步骤 `verify:skills` |
| UE 插件 | `plugin/UnrealAgentLink/` | 改了会进分发包的输入就要重编所选开发目标的 zip 并设置 `VERIFY_PLUGIN_ENGINE`，否则门禁步骤 `verify:plugin` 变红（见第 3 节） |
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
7. **不要新增依赖**，除非 Issue 里明确要求；网络请求和遥测按第 1 节办。
8. **diff 只包含本次任务改动的行。** 其他文件的格式保持原样；10 行功能带出 900 行 diff 的
   PR 不会被合并。
9. **动手前先读文档。** 先在 `docs/` 里找你要碰的那块有没有现成规范
   （`docs/ContextMenu组件使用规范.md`、`docs/router-meta.md` …）。
10. **用户创作的东西，唯一真相源是磁盘上的文件。** 数据库只是能删掉重建的索引，
   localStorage 只配存界面偏好和一次性标记。社区版承诺「数据在用户自己手里」——
   拷得走、备份得到、换台机器还在，靠的就是这一条。凭据同理：localStorage 是明文的，
   走主进程的安全存储。门禁见 `scripts/check-local-storage.mjs`，
   现存欠账登记在 `scripts/local-storage.baseline.json`，只准变少。

11. **这个仓库经常有好几个 Agent 会话同时在改。** 三条铁律：
    - **提交只按路径提你自己动过的文件。** `git add -A` / `git add .` / `git commit -a`
      会把别人还没提交的活一起收进你的 commit —— 代码不会丢，但历史脏了，
      出问题也没法回溯。
    - **别的会话的半成品把门禁弄红时，在交接说明里点名。** 不属于你这次任务的文件
      保持原样 —— 写清楚是谁的文件卡住了门禁，比替他改完更有用。全量 `pnpm verify`
      一次只有一个会话跑（时刻表见第 3 节）。
    - **四个棘轮基线文件是全仓共享的**（`scripts/` 下的 lint / colors /
      local-storage / official-endpoints）。它们天生只能一个会话一个会话地更新，
      同时改必冲突。要更新基线，先确认此刻只有你一个会话在收工。

12. **引擎写的文件（`.uproject` / `.uplugin` / 引擎 `ini`）一律经
    `src/main/utils/ueTextFile.ts` 读**（`readUeTextFile` / `readUeJsonFile` / `decodeUeText`）。
    内容里有一个非 ASCII 字符（中文工程名）UE 就整份存成 UTF-16LE，按 `'utf-8'` 硬读会让
    `JSON.parse` 抛错，用户看到的是插件装不上和一条看不懂的报错。写回去用不带 BOM 的 UTF-8。
    门禁见 `scripts/check-ue-file-reads.mjs`。

13. **多媒体进模型一律经 `src/main/agent-v3/core/promptMedia.ts`：** 先传对象存储给链接；
    只有存储没配、模型收不了这一类的链接、或这次上传失败，才逐个文件降级（图片走 base64，
    音视频给本地路径 + `analyze_video`），降级不打断这一轮。新的媒体类型接进这个文件。
    工具产出的图（编辑器截图）不走这条。

14. **写入类工具的回执只报引擎现在的样子，部分失败不许开口说成功。** 模型把回执当事实。
    描述结果的每个字段都在所有改动（含编译）完成后从引擎读回；读不回的写 `needs_compile` /
    `unknown`。有一件没办成，模型读到的第一句就是「N 成功 / M 失败」（C++ 侧：顶层
    `failed_count`）；全部失败按错误抛。新写或改动写入类工具时，测试里要有一条「引擎回的值
    和入参不同」的用例；有批量语义的再加一条「部分失败」用例。

## 6. 提交与 PR

- Conventional Commits + **中文**描述，和现有历史保持一致：
  `feat: 支持自定义标签颜色`、`fix: 修复打包产物无法启动的两个缺陷`、`feat!: 卸载工作流 Nexus`
- 分支名：`feat/<slug>`、`fix/<slug>`
- 如实填写 `.github/PULL_REQUEST_TEMPLATE.md`，包括 `pnpm verify` 是否真的全绿。
- **`git push` 和开 PR 之前必须停下来问人。** 本地提交可以自己做，
  但「发出去」是贡献者的决定，不是你的。
- 在 PR 里注明这是 AI 辅助的贡献。

## 7. 已知陷阱

- **`better-sqlite3` 报 `NODE_MODULE_VERSION`**，是 Node ABI 那份缓存没建好：跑
  `pnpm exec node scripts/better-sqlite3-abi.mjs ensure node` 补上即可，不碰 `node_modules`
  （那里始终是 Electron 那份，所以开着应用也能跑测试）。
- **`pnpm lint` 是棘轮，不是「全绿」。** 它对全仓跑 ESLint，但比对的是一份记录在案的存量
  （`scripts/lint.baseline.json`）。存量问题不是你的活，只要求不变多。
- **门禁提示存量变少了**，就跑 `pnpm lint:baseline:update` 并把更新后的基线一起提交。
  棘轮只能往一个方向转：`--update` 拒绝任何变大。
- **真正管住你代码的是 `pnpm lint:changed`。** 棘轮允许你在同一个文件里把 30 个存量问题
  换成另外 30 个，逐行门禁不允许。
- **80% 覆盖率阈值只统计 `src/renderer/**`。** 主进程和预加载不计入覆盖率，
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

任务范围保持原样，停下来汇报：你试过什么、门禁报了什么、需要谁来拍板。
一个诚实说明「哪块没做完」的 PR，比一个绕过了难点的绿灯 PR 有用得多。
