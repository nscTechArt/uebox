# 04: 侧边问一句

Status: done
Blocked by: 03

依据：`../spec.md` 的「文案表 · 04」「i18n key 改名」「代码改名：侧边问一句」；术语见根目录 `CONTEXT.md`。

**What to build:** 「侧边问一句 / Side question」在按钮、报错、横幅里都被说成一次性的提问；英文用户看到的是 "Side question"。
横幅里被借上下文的那条中英统一叫「主对话 / main chat」。代码里它也叫 side question，从 IPC 通道到组件事件只有一个名字。

- [x] 文案表 · 04 的每个 key，两侧值都等于目标值；`assistant.sideQuestion.open` 保持现值
- [x] 旧命名空间 `assistant.sideChat` 满足 spec 的引用清零与定义清零（写入 `retiredKeys.test.ts`）
- [x] 「代码改名：侧边问一句」表的每一行都已改完，满足表下的完成标准
- [x] 词表加入完整词表中标为 04 的行，守卫零命中
- [x] 测试通过：术语守卫、`usedKeyCoverage.test.ts`、`criticalPathCoverage.test.ts`、`retiredKeys.test.ts`、`sideQuestion.test.ts`，
  以及按 spec「事件连线测试」新增的 `TopNav.test.ts` 那条与 `Welcome.events.test.ts` 的 `@side-question` 一条
- [x] 主进程与渲染层类型检查通过（`tsconfig.node.json`、`tsconfig.web.json`）
