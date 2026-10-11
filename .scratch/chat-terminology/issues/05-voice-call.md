# 05: 语音通话

Status: done
Blocked by: 04

依据：`../spec.md` 的「文案表 · 05」「i18n key 改名」；术语见根目录 `CONTEXT.md`。

**What to build:** 用户和语音助手的实时语音交流统一叫「语音通话 / Voice call」，和「开始」「挂断」「最长 30 分钟」「结束通话」
是一套说法；通话绑定在哪条对话上时显示「语音通话：{对话标题}」。「通话」「挂断」与「语音助手 / Voice assistant」保持原样；
给实时语音模型的「当前语音对话」标记也保持原样（spec「Out of Scope」）。

- [x] 文案表 · 05 的每个 key，两侧值都等于目标值
- [x] `assistantInputComposer.voice.boundConversation` 满足 spec 的引用清零与定义清零（写入 `retiredKeys.test.ts`）
- [x] 词表加入完整词表中标为 05 的行，守卫零命中
- [x] 测试通过：术语守卫、`usedKeyCoverage.test.ts`、`criticalPathCoverage.test.ts`、`retiredKeys.test.ts`
