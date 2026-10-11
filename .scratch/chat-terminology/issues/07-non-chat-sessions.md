# 07: 不是对话的「会话」

Status: done
Blocked by: 06

依据：`../spec.md` 的「文案替换规则」第 2 条、「文案表 · 07」「中断回复的标记」；术语见根目录 `CONTEXT.md`。

**What to build:** 那些也叫「会话」、却不是对话的地方换成准确的说法：开发者在调试台看到不翻译的 "session"（它指内核）；
用户删除对话后看到他能理解的后果；登录过期说「登录状态 / sign-in」；网络库导入说「这次导入 / this import」；
没做完就被中断的回复标为「回复已中断 / Reply interrupted」。

- [x] 文案表 · 07 的每个 key，两侧值都等于目标值
- [x] 「中断回复的标记」一节落地，满足节内的完成标准
- [x] 词表加入完整词表中标为 07 的行，守卫零命中
- [x] 测试通过：术语守卫、`usedKeyCoverage.test.ts`、`criticalPathCoverage.test.ts`、`chatMessages.test.ts`（按 spec 改写）、`agentReattach.test.ts`
- [x] 渲染层类型检查通过
