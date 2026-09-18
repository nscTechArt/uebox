# 垂直切片：一个功能要穿过哪几层

> **English TL;DR** — Almost every feature in this app crosses seven layers: SQLite model → IPC
> handler → preload bridge → preload types → renderer API → Pinia store → Vue view. Skipping a
> layer is the #1 cause of "it typechecks but nothing happens". This document walks the whole
> path with a real, currently-unimplemented example (custom tag colors). Commands and file paths
> are the same in both languages; the prose is Chinese.

本文是给贡献者和 AI Agent 的**施工地图**。规范总纲在 [AGENTS.md](../../AGENTS.md)，
这里讲的是「具体怎么落地」。

---

## 一、七层地图

```
┌─ 主进程 (Node) ─────────────────────────────────────────┐
│ 1. 数据模型   src/main/sqliteDataBase/models/<域>.ts     │  建表 DDL、SQL 语句
│ 2. IPC 处理   src/main/sqliteDataBase/ipc/<域>.ts        │  ipcMain.handle('db:xxx:yyy')
└──────────────────────────────────────────────────────────┘
                          ↕ Electron IPC
┌─ 预加载 (隔离层) ───────────────────────────────────────┐
│ 3. 桥接       src/preload/index.ts                       │  contextBridge → window.api.*
│ 4. 类型声明   src/preload/index.d.ts                     │  ← 必须和 3 一起改
└──────────────────────────────────────────────────────────┘
                          ↕ window.api
┌─ 渲染进程 (Vue) ────────────────────────────────────────┐
│ 5. API 封装   src/renderer/src/api/<域>.ts               │  unwrapResult() 统一拆包
│ 6. 状态       src/renderer/src/store/modules/*           │  Pinia，仅当状态跨组件共享
│ 7. 界面       src/renderer/src/views/**                  │  Vue 组件
└──────────────────────────────────────────────────────────┘
```

**不是每个功能都要动七层。** 判断方法很简单：

| 你的改动 | 要动的层 |
|---|---|
| 纯 UI 调整（文案、布局、交互） | 7（+ i18n） |
| 用已有数据做新的展示 / 筛选 | 5–7 |
| 已有表里已有字段，但界面没暴露 | 5–7（**下面的示例就是这类**） |
| 已有表要加字段 | 1–7 全部 |
| 全新的数据域 | 1–7 全部，外加新建 model / ipc 文件并在 `index.ts` 注册 |
| 不碰数据库的主进程能力（文件、窗口、外部进程） | `src/main/ipc/<能力>.ts` → 3 → 4 → 5 → 7 |

---

## 二、走一遍真实的例子：给资产库标签加自定义颜色

这是一个**当前真实存在的缺口**，很适合当第一个 PR。

### 先搞清楚现状（这一步不能跳）

动手前先把这条链路读一遍，你会发现一个关键事实：

| 层 | 现状 |
|---|---|
| `src/main/sqliteDataBase/models/tag.ts:25` | `tags` 表**已经有** `color TEXT DEFAULT '#1890ff'` |
| 同文件 `updateTag` | **已经支持** `updates.color`，会拼进 `SET color = ?` |
| `src/preload/index.ts` / `index.d.ts` | `tag.create` / `tag.update` 透传整个对象，**无需改动** |
| `src/renderer/src/api/tag.ts` | `tagAPI.update(id, updates)` 已是 `Partial<Tag>`，**无需改动** |
| `TagManagement/types.ts` | `Tag` 有 `color?: string`，但 `TagForm` **没有** |
| `TagManagement/TagModal.vue:173` | 创建标签时**写死** `color: '#52c41a'` |
| `TagModal.vue` 的编辑分支 | `update` 调用里**根本没传** `color` |
| `TagManagement/TagDisplay.vue` | 已经按 `tag.color` 渲染 |

**结论：数据层全通，缺的只是界面上没有取色入口。** 所以这次不需要建表、不需要迁移、
不需要碰 preload —— 只动第 7 层（+ 类型 + i18n + 测试）。

> 这就是「先读再写」的价值。如果不读这一圈，很容易一上来就去加数据库字段，
> 白写一堆代码还引入一次没必要的 schema 变更。

### 要改的文件

1. **`TagManagement/types.ts`** — 给 `TagForm` 加 `color?: string`。
2. **`TagModal.vue`**
   - 表单里加一个颜色选择项。**用 ant-design-vue 现有组件**（这个项目已经全量依赖 `ant-design-vue@4`），
     不要自己手写取色器，也不要引新依赖。
   - `form` 的初始值加 `color`；`watch(props.editingTag)` 里回填 `tag.color`；
     关闭重置时也要复位。
   - 创建分支：把写死的 `color: '#52c41a'` 换成 `form.value.color`，
     并保留一个默认色兜底（沿用 `models/tag.ts` 的 `#1890ff`）。
   - 编辑分支：`update` 的入参里补上 `color: form.value.color`。
   - **校验**：只接受 `#RRGGBB` / `#RGB`，非法值不提交，给出 i18n 提示。
3. **i18n** — `zh-CN.ts` 和 `en-US.ts` 里同时加 `tagManagementModal.form.colorLabel`、
   `colorPlaceholder`、`messages.invalidColor` 之类的 key。**只加一边 CI 不会报，
   但海外用户会看到中文** —— 参考 `src/renderer/src/i18n/criticalPathCoverage.test.ts` 的做法。
4. **测试** — 新建 `src/renderer/src/views/AssetManagement/TagManagement/tagColor.test.ts`（或放 `tests/`）：
   - 合法色值通过校验，非法色值（`red`、`#12345`、空串、`javascript:`）被拒绝；
   - 未选颜色时回落到默认色；
   - 编辑已有标签时颜色被正确回填。

   把颜色校验抽成一个纯函数再测，比挂载整个 `a-modal` 稳定得多，也更快。

### 关于颜色和主题的注意事项

`docs/UI-Design-Standards.md` 要求「组件内禁止硬编码 HEX」，指的是**样式**。
标签颜色是**用户数据**，存在数据库里，本来就是 HEX，不冲突。
但要注意：用户可能选一个在深色主题下完全看不清的颜色。至少保证文字/描边有对比度兜底，
可选的加分项是在取色器里提供一组符合主题的预设色。

### 收工

```bash
pnpm verify:changed
```

单个任务收工只跑这个（约 30 秒，只查你改的）。完整的 `pnpm verify` 整批只跑一次，
在 push / 开 PR 之前，理由见 [AGENTS.md](../../AGENTS.md) 第 3 节。绿了就提交：

```
feat: 支持自定义资产库标签颜色
```

---

## 三、如果你**确实**需要加字段或建表

`src/main/sqliteDataBase/models/*.ts` 用的是 `CREATE TABLE IF NOT EXISTS`，
**这对老用户的已有数据库不生效** —— 表已经存在，新列不会凭空出现。

所以加列时必须：

1. 在建表 SQL 里加上新列（新用户直接就有）；
2. 另外写一段幂等的迁移：读 `PRAGMA table_info(<表>)`，发现缺列就 `ALTER TABLE ... ADD COLUMN`；
3. 新列必须**可空或带默认值**，否则老数据插不进去；
4. 为迁移逻辑写测试 —— 「在旧 schema 上跑一次迁移，再跑第二次不应报错」。

改动数据库结构的 PR 请在描述里明确写出：**老用户升级后会发生什么**。

---

## 四、常见翻车点

| 症状 | 原因 |
|---|---|
| 界面点了没反应，也不报错 | 漏了第 3 层，`window.api.xxx` 是 `undefined` |
| typecheck 报 `Property 'xxx' does not exist on type` | 改了 `preload/index.ts` 忘了改 `index.d.ts` |
| 报错信息在控制台但界面没提示 | 没走 `unwrapResult()`，错误被吞了 |
| 老用户升级后功能报「no such column」 | 只改了 `CREATE TABLE`，没写迁移 |
| 深色主题下看不见新加的元素 | 写死了 HEX，没用 `theme.css` 的 CSS 变量 |
| 海外用户看到中文 | 只加了 `zh-CN.ts` |
| 测试或 `pnpm dev` 报 NODE_MODULE_VERSION | 两套 `better-sqlite3` ABI 各存一份，不再互相覆盖。测试报错是 Node 版缓存缺失：`node scripts/better-sqlite3-abi.mjs ensure node`；应用报错才需要 `pnpm rebuild:electron` |

---

相关文档：
[AGENTS.md](../../AGENTS.md) ·
[测试指南](testing.md) ·
[验收清单](definition-of-done.zh-CN.md) ·
[UI 设计标准](../UI-Design-Standards.md) ·
[资产库避坑指南](../资产库避坑指南.md)
