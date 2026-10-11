# 02b: 未命名对话

Status: done
Blocked by: 02

依据：`../spec.md` 的「文案表 · 02b」「i18n key 改名」「旧默认标题仍算未命名」；术语见根目录 `CONTEXT.md`。

**What to build:** 还没起名的对话统一叫「未命名对话 / Untitled chat」，不和「新对话」按钮混淆，从小窗存进来的也一样。
默认标题换了之后，老用户存下的空对话照样会在第一条消息后自动起名。

- [x] 文案表 · 02b 的每个 key，两侧值都等于目标值
- [x] key 改名表中标为 02b 的旧 key 满足 spec 的引用清零与定义清零（写入 `retiredKeys.test.ts`）
- [x] 「旧默认标题仍算未命名」一节的每一条都已落地，与上两条在同一次提交里
- [x] 测试通过：术语守卫、`untitledChat.test.ts`（新增）、`chatSessions.test.ts`（新增「快速对话」那条）、`retiredKeys.test.ts`、
  `usedKeyCoverage.test.ts`、`criticalPathCoverage.test.ts`、`SessionProjectChip.test.ts` 与 `agentSessionIsolation.test.ts`（按 spec 改写）、
  `voiceAssistant.test.ts`，以及其余引用了被改 key 的测试文件
- [x] 渲染层类型检查通过
