# 验收清单（Definition of Done）

English: [definition-of-done.md](definition-of-done.md)

**开发阶段随便试，验收阶段一寸不让。** 这份清单是「做完了」的定义，
PR 模板与它逐条对应。AI Agent 在说「完成」之前必须自己走一遍。

---

## A. 门禁

这份清单是**发布**那一档的检查点，不是每个任务都要走的。做完单个任务只欠
`pnpm verify:changed`（约 30 秒）；完整门禁整批只跑一次，在发出去之前。见
[AGENTS.md](../../AGENTS.md) 第 3 节。

- [ ] 这批里每个任务收工时都过了 `pnpm verify:changed`
- [ ] `pnpm verify` 全绿，最后一行是 `✅ 门禁全绿，可以提交了。`
- [ ] 没有用 `.skip` / 删测试 / 注释断言 / 改覆盖率阈值 / 扩大 ESLint ignore /
      在新文件加 `/* eslint-disable */` 的方式过关
- [ ] 改了主进程、构建配置或依赖的话，额外跑过 `pnpm verify --with-build`

## B. 功能本身

- [ ] `pnpm dev` 起得来，功能被**人手点过**一遍，不是只有测试绿
- [ ] 正常路径可用
- [ ] 边界情况有处理（空值、`null`、超长输入、重复、越界）
- [ ] 出错时用户看得到提示，不是白屏或静默失败
- [ ] 没有把已有功能弄坏（相关的相邻功能顺手点一下）

## C. 代码

- [ ] 按[垂直切片](vertical-slice.md)的七层地图落位，没有跳层
- [ ] 改了 `src/preload/index.ts` 的话，`src/preload/index.d.ts` 同步改了
- [ ] 渲染进程没有直接调 `ipcRenderer`，走的是 `window.api.*` + `src/renderer/src/api/*` + `unwrapResult()`
- [ ] 样式没有硬编码 HEX / 像素魔数，用的是 `theme.css` 的 CSS 变量
- [ ] 深色 / 浅色主题下都看过，都能看清
- [ ] 没有新增依赖、网络请求、遥测（如果有，PR 里单独说明理由）
- [ ] 没有格式化无关文件 —— `git diff --stat` 里每个文件都是你有意要改的

## D. 测试

- [ ] 新逻辑有对应测试
- [ ] 覆盖了正常路径、边界、错误路径三类
- [ ] 测试放在 `tests/` 或与源码同目录的 `*.test.ts`
- [ ] 测试不依赖真实的用户数据目录 / 真实网络

## E. 文案与国际化

- [ ] 新增的用户可见文案在 `zh-CN.ts` 和 `en-US.ts` 里都加了
- [ ] 如果属于登录 / 订阅 / 付款 / 授权这类必经路径，key 加进了
      `src/renderer/src/i18n/criticalPathCoverage.test.ts` 的 `CRITICAL_KEYS`
- [ ] 新代码没有在 `.vue` 模板里写死中文

## F. 数据库（只在动了 schema 时适用）

- [ ] 建表 SQL 里加了新列
- [ ] 另外写了幂等迁移（`PRAGMA table_info` 检测 → `ALTER TABLE ADD COLUMN`）
- [ ] 新列可空或有默认值
- [ ] 迁移有测试，且「跑两次不报错」
- [ ] PR 描述里写清楚**老用户升级后会发生什么**

## G. 提交

- [ ] 分支名是 `feat/<slug>` 或 `fix/<slug>`
- [ ] 提交信息是 Conventional Commits + 中文描述，例如 `feat: 支持自定义标签颜色`
- [ ] 破坏性变更用了 `!`（如 `feat!: 卸载工作流 Nexus`）
- [ ] PR 模板逐条如实填写，包括「是否 AI 辅助完成」
- [ ] **push / 开 PR 之前问过人了**

---

## 没做完怎么办

不要为了凑齐这份清单而假装做完了。

在 PR 描述里开一节 `## 未完成 / 需要帮助`，写清楚：

- 哪一条没做到；
- 你试过什么；
- 卡在哪（贴报错原文）。

**这样的 PR 我们会接着帮你做完。** 一个绕过了难点的绿灯 PR，只会把问题推给下一个人。
