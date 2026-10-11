# 19: 对话截断标题规则收口

Status: open
Blocked by: None（术语 PR 落地后即可开工）；动手前先要一个格式裁决（见下）

依据：评审 02b（`1c1a706`）时发现的存量债，非该组改动引入；术语见根目录 `CONTEXT.md`。

**What to build:** 「对话标题 = 首条用户消息前 20 字」这条规则目前散在 4 处、还是两种写法。
先裁决统一成哪种格式，再把 4 处收进一个公共函数，免得哪天改长度或风格时漏改一处、
同一条对话在不同入口被起成不同名字。

现状两份变体：

- **A 变体**（空白归一 + 截 20 字、无省略号）：`chatSendPrimitives.ts` `ensureSessionWithTitle`、
  `agentCompletionHandlers.ts` 后台对话起名、`voiceAssistant.ts` `nameVoiceSession`
  （上限是具名常量 `VOICE_TITLE_MAX_CHARS`，值同为 20）。
- **B 变体**（不规一空白 + 截 20 字 + `...` 后缀）：`MiniChatWindow.vue` 存进侧边栏时的兜底标题。
  同一条消息，从小窗存的标题带 `...`、空白不规一，主窗口发的都没有 —— 同一实体、不同入口的不一致。

不算这条规则的拷贝：`useSpotlightAction.ts` 里给**笔记**取标题的 `slice(0,20)+'...'`（不同域，不动）。

- [ ] 格式裁决先行：建议统一为 A（主路径与既有测试断言都是它，B 的省略号与不规一空白按 drift 处理）；
  若 B 的 `...` 是小窗紧凑显示的有意设计，写明理由后再统一
- [ ] 抽公共函数（如 `src/renderer/src/utils/` 下的 `deriveChatTitle`，连同截断长度常量），4 处改为调用它；
  `voiceAssistant.ts` 的 `VOICE_TITLE_MAX_CHARS` 由该常量取代
- [ ] 裁决若统一为 A：`MiniChatWindow` 存库标题随之不带 `...`，相关断言同步更新；统一为 B 则反向
- [ ] 行为变化（无论哪种统一方向都是一处有意的标题格式变化）写进提交说明，不进术语 PR
