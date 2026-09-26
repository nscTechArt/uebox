# 架构与验收门禁

本页是索引。规范的唯一真相源是仓库根目录的 [`AGENTS.md`](https://github.com/ueboxai/uebox/blob/main/AGENTS.md)（中文版 `AGENTS.zh-CN.md`），有出入以那份为准。

## 门禁两档

任务完成时：

```bash
pnpm verify:changed
```

约 30 秒，只检查改动部分。

整批交付前（push、出包、移交）：

```bash
pnpm verify
```

约 3.5 分钟，完整门禁。

这 3.5 分钟基本是固定开销。另外门禁是全仓范围的，多个会话并行时，其他会话未完成的文件会导致门禁失败。

`verify:changed` 不能替代完整门禁。CI（`.github/workflows/quality.yml`）中只有 `pnpm verify --ci`，在 PR 和向 `main` 的 push 上运行；仓库 CI 绿灯不代表插件包或原生验收通过。

跑门禁不需要关闭应用。

### 门禁步骤

| 步骤                        | 检查内容                                                              |
| --------------------------- | --------------------------------------------------------------------- |
| `security:secrets`          | 是否有密钥提交进仓库                                                  |
| `verify:official-endpoints` | 棘轮：社区版核心不新增对官方服务端的调用                              |
| `lint`                      | 棘轮：全仓 ESLint，逐文件不超过基线存量                               |
| `lint:changed`              | 对改动行跑全量规则，零容忍                                            |
| `docs:check`                | 成对的中英文档是否一起修改                                            |
| `verify:skills`             | 技能是否符合 `SKILL_STANDARD.md`                                      |
| `verify:ue-file-reads`      | 引擎存的文件（`.uproject` / `.uplugin` / 引擎 ini）不能用写死的编码读 |
| `verify:plugin`             | 仅本地：改了插件打包输入才检查所选开发包；CI 列为 NOT RUN             |
| `typecheck`                 | 主进程 + 渲染进程 + CLI                                               |
| `test:run`                  | Vitest 全仓单测                                                       |

CI 另外运行 `audit:prod`、`build:unpack`、`verify:offline-boot`（社区版必须零官方服务端请求）。

跳过测试、删测试、加 `.skip`、扩大 ESLint ignore、降低覆盖率阈值都不是让门禁通过的合法方式。认为某条门禁本身有问题时，在 PR 中提出。

## 代码分层

每个功能通常穿过七层：

| #   | 层         | 路径                                                |
| --- | ---------- | --------------------------------------------------- |
| 1   | 数据模型   | `src/main/sqliteDataBase/models/`                   |
| 2   | IPC 处理   | `src/main/sqliteDataBase/ipc/`                      |
| 3   | 预加载桥   | `src/preload/index.ts`                              |
| 4   | 预加载类型 | `src/preload/index.d.ts`（必须和 #3 一起改）        |
| 5   | 渲染层 API | `src/renderer/src/api/`                             |
| 6   | 状态       | `src/renderer/src/store/modules/`（仅在需要共享时） |
| 7   | 界面       | `src/renderer/src/views/`                           |

其他入口：主进程 IPC 在 `src/main/ipc/`，跨进程共享类型在 `src/shared/`。

四处带额外义务：

| 区域           | 路径                                        | 义务                                                         |
| -------------- | ------------------------------------------- | ------------------------------------------------------------ |
| Agent 工具     | `src/main/agent-v3/tools/`                  | 用 `defineTool` / `defineUeTool` 定义，在 `registry.ts` 注册 |
| 运行时技能     | `resources/skills/`、`packages/cli/skills/` | 符合 `SKILL_STANDARD.md`                                     |
| UE 插件        | `plugin/UnrealAgentLink/`                   | 打包输入改动需重编并检查显式选择的开发目标                   |
| `uebox` 命令行 | `packages/cli/`                             | 走 `tsconfig.cli.json` 类型检查                              |

### Agent 的五层

产品的主体是 Agent，它整个活在主进程的 `src/main/agent-v3/` 下，由下往上：

| 层  | 路径                    | 负责                                                            |
| --- | ----------------------- | --------------------------------------------------------------- |
| L4  | `host/`                 | IPC 注册、事件桥、会话管理、多窗口隔离、审批交互                |
| L3  | `capabilities/`         | 技能注册表、MCP 客户端、插件宿主、工具注册与动态过滤            |
| L2  | `tools/`                | `defineTool` / `defineUeTool`，各领域工具，以及内建的 `task` 等 |
| L1  | 内核（第三方）          | Agent 循环、插话、钩子、上下文压缩、会话落盘                    |
| L0  | `core/` + `src/main/ai` | 模型层：流式接入、模型目录、凭据存储、OAuth                     |

`core/` 下还有几件不属于任何一层但影响全局的东西，改之前先读各自的文件头注释：熔断（`loopBreaker.ts`）、上下文压缩（`compaction.ts`）、出口请求预算（`requestBudget.ts`）、资产锁（`assetLock.ts`）、审批门（`approval.ts`）、目标模式（`goalLoop.ts`）。

::: warning 三条容易踩反的

1. **工具失败只能靠抛异常表达。** 在返回值里设 `isError` 会被静默忽略，后果是失败被当成功报给模型，它基于错误前提继续往下做。
2. **前端只展示，不推进。** 助手页没有 keepAlive，切页面就卸载；要在后台发起 agent 就走应用级的入口，别借页面的执行函数。
3. **工具一次性全量注册。** 按需懒加载被 A/B 实测否决过，不要重提；能力边界真变了（比如引擎连上来）时重建一次是另一回事。

:::

## 硬规则摘录

完整清单在 `AGENTS.md` 第 5 节。

1. 不硬编码颜色和间距，使用 `theme.css` 中的 CSS 变量。应用有深色 / 浅色 / 高对比三套主题。
2. 界面组件先查 `docs/ui-components.md`。渲染进程有两套组件来源：会被点击、会弹浮层的用自建 `App*.vue`，表单输入类用 ant-design-vue。写错会被 ESLint 拦下。
3. 用户可见文案必须双语，`zh-CN.ts` 和 `en-US.ts` 同时添加。
4. 渲染进程不直接调 `ipcRenderer`，走 `window.api.*` 并用 `unwrapResult()` 包装。
5. 新行为必须有测试。
6. 不新增依赖、网络请求、遥测，除非 Issue 中明确要求。
7. 不格式化未改动的文件。
8. 用户创作内容的唯一真相源是磁盘上的文件，数据库只是可重建的索引。

## 多会话并行

仓库常有多个 AI 会话同时修改：

- 提交时按路径只提交自己改动的文件。`git add -A` / `git add .` / `git commit -a` 会把其他会话未提交的改动一并收入。
- 完整 `pnpm verify` 只在收工时运行，同一时间只有一个会话运行。
- `scripts/` 下的四个棘轮基线文件（lint / colors / local-storage / official-endpoints）全仓共享，并行修改会冲突。

## 打包与发版

```bash
pnpm build:win      # Windows
pnpm build:mac      # macOS
pnpm build:linux    # Linux
```

正式安装包要求 UE 5.0–5.8 共九份插件全部存在且与源码一致（`plugin:check:all`）。出全套：

```bash
node scripts/build-all-plugins.mjs
```

日常开发只出自己选的那一个版本，例如 `pnpm plugin:build --engine 5.7 --project <uproject-path>`。门禁怎么指定目标、没装 Unreal 时怎么办，见 [`docs/contributing/packaging.zh-CN.md`](https://github.com/ueboxai/uebox/blob/main/docs/contributing/packaging.zh-CN.md) 的「日常门禁」。发版完整集合不受开发目标影响。

上传是单独一步，更新源只有公开的 GitHub Releases：

```bash
pnpm release:app              # 演练：只打印要发什么，不发起网络请求
pnpm release:app --publish    # 实际发布
```

`updateGithubRepo` 留空时构建出的是不带更新源的包，启动时不发起更新请求。
