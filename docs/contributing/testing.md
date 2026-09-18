# 测试指南

> **English TL;DR** — Vitest 3 + happy-dom. Tests live either in `tests/**` or next to the source
> as `*.test.ts`; both are collected. Run `pnpm verify:changed` when a task is done, the full
> `pnpm verify` once before the batch is published, or `npx vitest run <file>` while iterating.
> Coverage thresholds (80%) apply to `src/renderer/**` only. The `better-sqlite3`
> native binding is no longer switched back and forth — both ABIs are cached side by side, so
> **you can run the tests while the app is open**.

---

## 1. 跑测试

| 命令 | 什么时候用 |
|---|---|
| `pnpm verify:changed` | **单个任务收工时**。约 30 秒，只查你改的 |
| `pnpm verify` | **整批发出去之前**（push / 开 PR）。约 3.5 分钟的完整门禁，整批只跑一次，见 [AGENTS.md](../../AGENTS.md) 第 3 节 |
| `pnpm verify:fast` | 完整门禁，只是测试步骤跳过原生 ABI 预检 |
| `npx vitest run <文件路径>` | 调单个测试文件，最快 |
| `pnpm test:watch` | 盯着一个模块反复改 |
| `pnpm test:coverage` | 想看自己新写的代码覆盖到没有 |

> 💡 **开着应用也能跑测试。** better-sqlite3 的 Node 与 Electron 两套 ABI 产物各缓存一份，
> 测试读缓存、应用读 `node_modules`，两边互不写入。以前那套「跑测试前编成 Node、
> 跑应用前编回 Electron」已经没有了。
> 看缓存状态：`node scripts/better-sqlite3-abi.mjs status`。

## 2. 测试放哪、怎么命名

两种位置都会被收集（见 `vitest.config.ts` 的 `include`）：

- **贴着源码放**：`src/main/security.test.ts`、`src/main/sqliteDataBase/models/assetData.test.ts`
  —— 适合单个模块的纯逻辑测试，改代码时一眼能看到测试在旁边。
- **放 `tests/` 下**：`tests/components/HelloWorld.test.ts`、`tests/manual/eval-case-integrity.test.ts`
  —— 适合跨模块、跨层的集成型测试。

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

**优先测纯函数。** 把校验、格式化、状态推导抽成不依赖 Vue / Electron 的函数再测，
比挂载组件稳定得多，也快一个数量级。

```ts
// 好：可以直接测
export function isValidHexColor(value: string): boolean { ... }

// 难测：逻辑埋在 <script setup> 里，只能靠 mount 整个 a-modal
```

**每个新功能至少覆盖三件事：**

1. **正常路径** —— 给对的输入，出对的结果；
2. **边界** —— 空值、`null`、超长、越界、重复；
3. **错误路径** —— 依赖抛错时，用户看到的是提示还是白屏。

第 3 条最容易被跳过，也最容易在用户机器上炸。

**主进程 / 数据库相关的测试**：`src/main/**` 不计入覆盖率统计，但一样要写。
涉及 SQLite 的测试请用内存库或临时文件，测完清理，不要写到用户的真实保管库路径。

## 5. 覆盖率

`vitest.config.ts` 里的阈值是 **80%**（branches / functions / lines / statements），
**只统计 `src/renderer/**`**，`src/main/**`、`src/preload/**`、`*.config.*`、`index.ts` 都被排除。

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
但新代码请自觉两边都加。

## 7. 不允许的「过关方式」

以下做法会让 PR 被直接打回：

- `it.skip` / `describe.skip` / 注释掉断言，只为了让门禁绿；
- 删掉挡路的测试而不说明理由；
- 调低 `vitest.config.ts` 的覆盖率阈值；
- 往 `eslint.config.mjs` 的 `ignores` 里加自己的新文件；
- 在新文件顶部写 `/* eslint-disable */`。

如果你**确信**某条门禁本身有问题，在 PR 描述里写清楚为什么，让人来判断。
诚实地说「这块我没搞定」，永远好过一个绕过去的绿灯。

---

相关文档：
[AGENTS.md](../../AGENTS.md) ·
[垂直切片](vertical-slice.md) ·
[验收清单](definition-of-done.zh-CN.md)
