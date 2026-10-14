# 测试指南

> **English TL;DR** — Vitest 5 + happy-dom. Tests live in `tests/**`, next to the source as
> `*.test.ts`, or in `packages/*/src` (the `uebox` CLI); all are collected. Run
> `pnpm exec vitest run <file>` while iterating, `pnpm verify:changed` when a feature is done, and
> the full `pnpm verify` once before the batch is published. Coverage thresholds (80%) apply to
> `src/renderer/**` only. Both `better-sqlite3` ABIs are cached side by side, so you can run the
> tests while the app is open.

---

## 1. 跑测试

| 命令                              | 什么时候用                                                                                                       |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `pnpm verify:changed`             | **功能做完、每次提交时**。约 30 秒，只查你改的                                                                   |
| `pnpm verify`                     | **整批发出去之前**（push / 开 PR）。约 3.5 分钟的完整门禁，整批只跑一次，见 [AGENTS.md](../../AGENTS.md) 第 3 节 |
| `pnpm verify:fast`                | 完整门禁，只是测试步骤跳过原生 ABI 预检                                                                          |
| `pnpm exec vitest run <文件路径>` | 调单个测试文件，最快                                                                                             |
| `pnpm test:watch`                 | 盯着一个模块反复改                                                                                               |
| `pnpm test:coverage`              | 想看自己新写的代码覆盖到没有                                                                                     |

开着应用也能跑测试。better-sqlite3 的 Node 与 Electron 两套 ABI 产物各缓存一份，
测试读缓存、应用读 `node_modules`，两边互不写入，不需要来回重编。
看缓存状态：`node scripts/better-sqlite3-abi.mjs status`。

## 2. 测试放哪、怎么命名

两种位置都会被收集（见 `vitest.config.ts` 的 `include`）：

- **贴着源码放**：`src/main/security.test.ts`、`src/main/sqliteDataBase/models/assetData.test.ts`
  —— 适合单个模块的纯逻辑测试，改代码时一眼能看到测试在旁边。
- **放 `tests/` 下**：`tests/components/HelloWorld.test.ts`、`tests/manual/eval-case-integrity.test.ts`
  —— 适合跨模块、跨层的集成型测试。
- **`packages/*/src` 下**：`uebox` 命令行（`packages/cli`）的测试，同样会被收集。

文件名一律 `<被测对象>.test.ts`。新功能优先贴着源码放。

## 3. 环境里已经准备好了什么

`tests/setup.ts` 是全局 setup，已经帮你 mock 好：

- `window.electron.ipcRenderer`（`invoke` / `send` / `on` 都是 `vi.fn()`）
- `window.api`，含 `database.*` 等常用命名空间
- Pinia：每个测试前 `setActivePinia(createPinia())`
- vue-i18n：已注入 `zh-CN` 语言包

环境是 **happy-dom**，不是 jsdom。`globals: true`，所以 `describe` / `it` / `expect`
可以直接用，不 import 也行（但现有代码习惯显式 import，跟着来）。

路径别名可用：`@renderer` / `@` / `~` → `src/renderer/src`。

## 4. 写什么样的测试

优先测纯函数。把校验、格式化、状态推导抽成不依赖 Vue / Electron 的函数再测，
比挂载组件稳定，也快得多。

```ts
// 好：可以直接测
export function isValidHexColor(value: string): boolean { ... }

// 难测：逻辑埋在 <script setup> 里，只能靠 mount 整个 a-modal
```

**每个新功能至少覆盖三件事：**

1. **正常路径** —— 给对的输入，出对的结果；
2. **边界** —— 空值、`null`、超长、越界、重复；
3. **错误路径** —— 依赖抛错时，用户看到的是提示还是白屏。

第 3 条最常被跳过，用户机器上出的问题也多在这一条。

写入类 Agent 工具（`src/main/agent-v3/tools/`）另有两条用例要求，见 [AGENTS.md](../../AGENTS.md)
第 5 节第 14 条：一条「引擎回的值和入参不同」，断言回执跟着引擎走；有批量语义的再加一条「部分失败」。

**主进程 / 数据库相关的测试**：`src/main/**` 不计入覆盖率统计，但一样要写。
涉及 SQLite 的测试请用内存库或临时文件，测完清理，不要写到用户的真实保管库路径。

## 5. 覆盖率

`vitest.config.ts` 里的阈值是 **80%**（branches / functions / lines / statements），
**只统计 `src/renderer/**`**，`src/main/**`、`src/preload/**`、`_.config._`、`index.ts` 都被排除。

```bash
pnpm test:coverage
```

不要为了凑数字写没有断言的测试。也**不要**为了让门禁变绿去改 `vitest.config.ts` 的阈值 ——
这在 review 里会被直接打回。

## 6. i18n 的测试守卫

`src/renderer/src/i18n/criticalPathCoverage.test.ts` 守着一份「海外用户必经路径」的 key 清单，
保证这些 key 在 `zh-CN` 和 `en-US` 里都存在。缺一边 CI 就红。

如果你新加的文案属于登录 / 订阅 / 付款 / 授权这类必经路径，
**把 key 加进那个文件的 `CRITICAL_KEYS` 数组**，让遗漏在 CI 暴露，而不是上线后被用户发现。

其他普通文案目前没有全量守卫（仓库里还有大量 `.vue` 硬编码中文），
新代码请两边都加。

`src/renderer/src/i18n/terminologyGuard.test.ts` 是术语守卫。它扫两份语言包和主进程文案
（`MAIN_STRINGS`），任何字符串命中禁用词（例如「会话」「聊天」「回合」「MiniChat」）就失败，
并逐条给出 key、命中的词和替换写法，零容忍，没有基线文件。词表来自 [CONTEXT.md](../../CONTEXT.md)
的 _Avoid_，改词表时两处一起改。确有改写不了的正当用法（引擎界面名、外部协议名）时，
加进测试里的白名单，并在条目旁写明理由。

`src/renderer/src/i18n/retiredKeys.test.ts` 登记改过名的 i18n key，断言旧 key 在两份语言包里都已删除。
给 key 改名时，把旧路径加进去。

## 7. 不允许的「过关方式」

以下做法会让 PR 被直接打回：

- `it.skip` / `describe.skip` / 注释掉断言，只为了让门禁绿；
- 删掉挡路的测试而不说明理由；
- 调低 `vitest.config.ts` 的覆盖率阈值；
- 往 `eslint.config.mjs` 的 `ignores` 里加自己的新文件；
- 在新文件顶部写 `/* eslint-disable */`。

认为某条门禁本身有问题时，在 PR 描述里写清楚原因，由维护者判断。
没做完的部分在 PR 里直接写明，不要绕过去换一个绿灯。

---

相关文档：
[AGENTS.md](../../AGENTS.md) ·
[垂直切片](vertical-slice.md) ·
[验收清单](definition-of-done.zh-CN.md)
