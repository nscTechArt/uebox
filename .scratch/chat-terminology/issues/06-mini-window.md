# 06: 小窗

Status: done
Blocked by: 05

依据：`../spec.md` 的「文案表 · 06」「i18n key 改名」；术语见根目录 `CONTEXT.md`。

**What to build:** 浮动小窗口对用户叫「小窗 / Mini window」。它的设置区目前被隐藏，但文案现在就改好，将来重新开放时
用户看到的是「小窗」。设置文案的 key 也叫 mini window；代码名 MiniChat 与 `miniChatWindow` 等组件命名空间保持原样。

- [x] 文案表 · 06 的每个 key，两侧值都等于目标值
- [x] `profile.menu.miniChat` 与旧命名空间 `profile.miniChat` 满足 spec 的引用清零与定义清零（写入 `retiredKeys.test.ts`）
- [x] `miniChatPreferences.test.ts` 按 spec 改写
- [x] 词表加入完整词表中标为 06 的行，守卫零命中
- [x] 测试通过：术语守卫、`usedKeyCoverage.test.ts`、`criticalPathCoverage.test.ts`、`retiredKeys.test.ts`、`miniChatPreferences.test.ts`、`settingsCopy.test.ts`、`routeTitles.test.ts`
- [x] 渲染层类型检查通过
