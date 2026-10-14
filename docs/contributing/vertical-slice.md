# 垂直切片：一个功能要穿过哪几层

> **English TL;DR** — Almost every feature in this app crosses seven layers: SQLite model → IPC
> handler → preload bridge → preload types → renderer API → Pinia store → Vue view. Skipping a
> layer is the #1 cause of "it typechecks but nothing happens". This document walks the whole
> path with an illustrative example (custom tag colors). Agent tools are a separate path: see
> AGENTS.md section 4. Commands and file paths are the same in both languages; the prose is Chinese.

本文是给贡献者和 AI Agent 的施工地图。规范总纲在 [AGENTS.md](../../AGENTS.md)，
这里讲具体怎么落地。

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

不是每个功能都要动七层，按改动类型判断：

| 你的改动                                       | 要动的层                                                                                                                                      |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 纯 UI 调整（文案、布局、交互）                 | 7（+ i18n）                                                                                                                                   |
| 用已有数据做新的展示 / 筛选                    | 5–7                                                                                                                                           |
| 已有表里已有字段，但界面没暴露                 | 5–7（**下面的示例就是这类**）                                                                                                                 |
| 已有表要加字段                                 | 1–7 全部                                                                                                                                      |
| 全新的数据域                                   | 1–7 全部，外加新建 model / ipc 文件并在 `index.ts` 注册                                                                                       |
| 不碰数据库的主进程能力（文件、窗口、外部进程） | `src/main/ipc/<能力>.ts` → 3 → 4 → 5 → 7                                                                                                      |
| 给盒子内置 Agent 加工具                        | 不走七层。在 `src/main/agent-v3/tools/` 用 `defineTool` / `defineUeTool` 定义，在 `registry.ts` 注册，见 [AGENTS.md](../../AGENTS.md) 第 4 节 |

---

## 二、示例：给资产库标签加自定义颜色

下面是一个假设的需求，用来演示「先读再写」。**文件和行号会随代码变动，动手前以当前代码为准。**

### 先读现状

读完这条链路，你会发现数据层已经支持颜色：

| 层                                      | 现状                                                 |
| --------------------------------------- | ---------------------------------------------------- |
| `src/main/sqliteDataBase/models/tag.ts` | `tags` 表有 `color TEXT DEFAULT '#1890ff'`           |
| 同文件 `updateTag`                      | 支持 `updates.color`，拼进 `SET color = ?`           |
| `src/preload/index.ts` / `index.d.ts`   | `tag.create` / `tag.update` 透传整个对象             |
| `src/renderer/src/api/tag.ts`           | `tagAPI.update(id, updates)` 的入参是 `Partial<Tag>` |
| `TagManagement/types.ts`                | `Tag` 有 `color?: string`，`TagForm` 没有            |
| `TagManagement/TagDisplay.vue`          | 按 `tag.color` 渲染                                  |

结论：只缺界面上的取色入口。这次不需要建表、迁移或改 preload，只动第 7 层，外加类型、i18n 和测试。
不先读这一圈，很容易直接去加数据库字段，白写代码还多出一次没必要的 schema 变更。

### 要改什么

1. **类型**：给 `TagForm` 加 `color?: string`。
2. **标签的创建 / 编辑界面**：
   - 加一个颜色选择项，用项目已有的 `ant-design-vue@4` 组件，不手写取色器，不引新依赖；
   - 创建时用选中的颜色，没选就用默认色 `#1890ff`（与 `models/tag.ts` 一致）；
   - 编辑时回填已有颜色，保存时把 `color` 带进 `update` 的入参；
   - 校验：只接受 `#RRGGBB` / `#RGB`，非法值不提交，并给出 i18n 提示。
3. **i18n**：`zh-CN.ts` 和 `en-US.ts` 同时加 key。只加一边，海外用户会看到中文。
4. **测试**：
   - 合法色值通过校验，非法色值（`red`、`#12345`、空串、`javascript:`）被拒绝；
   - 未选颜色时回落到默认色；
   - 编辑已有标签时颜色被正确回填。

   把颜色校验抽成纯函数再测，比挂载整个弹窗稳定，也快。

### 颜色和主题

`docs/UI-Design-Standards.md` 禁止组件里硬编码 HEX，针对的是样式。标签颜色是用户数据，存在
数据库里，本来就是 HEX，不冲突。用户选的颜色可能在深色主题下看不清，至少给文字或描边加对比度兜底。

### 收工

```bash
pnpm verify:changed
```

功能做完只跑这个（约 30 秒，只查你改的）。完整的 `pnpm verify` 整批只跑一次，
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

| 症状                                                 | 原因                                                                                                                                                                    |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 界面点了没反应，也不报错                             | 漏了第 3 层，`window.api.xxx` 是 `undefined`                                                                                                                            |
| typecheck 报 `Property 'xxx' does not exist on type` | 改了 `preload/index.ts` 忘了改 `index.d.ts`                                                                                                                             |
| 报错信息在控制台但界面没提示                         | 没走 `unwrapResult()`，错误被吞了                                                                                                                                       |
| 老用户升级后功能报「no such column」                 | 只改了 `CREATE TABLE`，没写迁移                                                                                                                                         |
| 深色主题下看不见新加的元素                           | 写死了 HEX，没用 `theme.css` 的 CSS 变量                                                                                                                                |
| 海外用户看到中文                                     | 只加了 `zh-CN.ts`                                                                                                                                                       |
| 测试或 `pnpm dev` 报 NODE_MODULE_VERSION             | 两套 `better-sqlite3` ABI 各存一份，不再互相覆盖。测试报错是 Node 版缓存缺失：`node scripts/better-sqlite3-abi.mjs ensure node`；应用报错才需要 `pnpm rebuild:electron` |

---

相关文档：
[AGENTS.md](../../AGENTS.md) ·
[测试指南](testing.md) ·
[验收清单](definition-of-done.zh-CN.md) ·
[UI 设计标准](../UI-Design-Standards.md)
