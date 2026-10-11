# 02: 「对话」主体

Status: done
Blocked by: 01

依据：`../spec.md` 的「文案表 · 02」「i18n key 改名」「点名审批按钮的文字」；术语见根目录 `CONTEXT.md`。

**What to build:** 用户在 AI 助手里看到的「那一条」处处都叫「对话 / Chat」，中英一一对应，覆盖文案表 · 02 的每一处。
默认标题不在本张，见 02b。

- [x] 文案表 · 02 的每个 key，两侧值都等于目标值
- [x] key 改名表中标为 02 的每个 key 满足 spec 的引用清零与定义清零（`retiredKeys.test.ts` 在本张新建）
- [x] 「点名审批按钮的文字」一节落地，满足节内的完成标准
- [x] 词表加入完整词表中标为 02 的行，守卫零命中
- [x] 测试通过：术语守卫、`retiredKeys.test.ts`（新增）、`usedKeyCoverage.test.ts`、`criticalPathCoverage.test.ts`、`src/main/i18n.test.ts`、
  `vaultScope.test.ts`（按 spec 改写），以及其余引用了被改 key 的测试文件
- [x] 渲染层类型检查通过
