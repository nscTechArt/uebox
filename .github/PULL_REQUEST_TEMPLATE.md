<!--
感谢参与共创！/ Thanks for contributing!
完整验收清单：docs/contributing/definition-of-done.zh-CN.md
Full checklist:  docs/contributing/definition-of-done.md
-->

## 这个 PR 做了什么 / What this does

<!-- 一两句话说清楚。是新功能就描述用户能看到什么变化，是修复就描述原来什么坏了。 -->

关联 Issue / Closes: #

## 怎么验证 / How to verify

<!-- 让 reviewer 能照着点一遍。例如：打开资产库 → 标签管理 → 新建标签 → 选颜色 → 确认列表里显示对了 -->

1.
2.

## 截图 / Screenshots

<!-- 有 UI 变化就贴。深色和浅色主题各来一张更好。 -->

---

## 验收自查 / Self-check

**门禁 / Gates**

- [ ] `pnpm verify` 全绿 / passes fully green
- [ ] 没有用 skip 测试、删测试、改覆盖率阈值、扩大 ESLint ignore 的方式过关
      / No skipped or deleted tests, no lowered thresholds, no widened ignores

**功能 / Feature**

- [ ] `pnpm dev` 里人工点过，功能真的能用 / Manually clicked through in `pnpm dev`
- [ ] 边界和错误路径有处理 / Edge cases and error paths handled
- [ ] 深色 / 浅色主题都看过 / Checked in both dark and light themes

**代码 / Code**

- [ ] 新逻辑有测试 / New logic has tests
- [ ] 新增的用户可见文案在 `zh-CN.ts` 和 `en-US.ts` 都加了 / New user-facing strings added to both locales
- [ ] 没有硬编码颜色（用了 `theme.css` 的 CSS 变量）/ No hard-coded colors
- [ ] 改动只碰了该碰的文件，没有顺手格式化无关代码 / No unrelated files reformatted

**影响面 / Impact**

- [ ] 新增了依赖 / Adds a dependency — <!-- 是的话在这里说明为什么 / if yes, justify here -->
- [ ] 新增了网络请求或遥测 / Adds network calls or telemetry — <!-- 社区版默认完全离线，务必说明 -->
- [ ] 改动了数据库结构 / Changes the database schema —
      <!-- 是的话请说明老用户升级后会发生什么 / if yes, describe what happens to existing users on upgrade -->
- [ ] 破坏性变更 / Breaking change

**协作 / Collaboration**

- [ ] 这个 PR 有 AI 参与完成 / AI-assisted
      <!-- 欢迎勾选，不减分。我们看的是 diff 和门禁，不是谁敲的键盘。
           Welcome to tick this — it costs you nothing. We review the diff and the gate, not who typed it. -->

---

## 未完成 / 需要帮助 / Unfinished, need help

<!--
没做完就写在这里，不用假装做完。
写清楚：哪一条没做到、你试过什么、卡在哪（贴报错原文）。这样的 PR 我们会接着帮你做完。

Didn't finish? Say so here instead of faking it.
State which item you couldn't meet, what you tried, and the exact error. We'll help you finish it.
-->
