# 08: 收口

Status: done
Blocked by: 07

依据：`../spec.md` 的「范围」「术语守卫」完整词表中标为 08 的行与「术语守卫 · 白名单」；术语见根目录 `CONTEXT.md`。

**What to build:** 整个术语统一的承诺在这里兑现：三份文案来源里，中文「会话」零处，英文指对话的 session / conversation 零处，
并由守卫锁死——以后有人写回「新会话」或 "New session"，测试直接变红并给出替换建议。

- [x] 守卫白名单按 spec「术语守卫 · 白名单」填入
- [x] 词表加入完整词表中标为 08 的行，守卫零命中。守卫报出的每一处（多半是 02–07 之后别处新增的字符串）按文案替换规则在本张改完
- [x] 三份文案来源里的注释按 spec「范围」改完
- [x] `CONTEXT.md`：开头说明补一句「新增或修改 _Avoid_ 时，同步考虑术语守卫的禁用词表」；
  各词条注明代码名——分支 `chatBranch`、侧边问一句 `sideQuestion`、语音通话 `voiceAssistant` 与绑定对话的 `voiceChatSid`
- [x] 测试通过：术语守卫、`criticalPathCoverage.test.ts`（完整 `pnpm verify` 在 PR 分支上跑，见 spec「提交 PR」）

## Comments

- 复核登记（例外）：第 4 组提交 `be52795` 顺手改了 spec「范围」改名清单（四处）之外的一处——
  `MiniChatWindow.vue` 的 `handleResetSession` 改名 `handleResetChat`，并更新两条 `[MiniChat]`
  console.log 措辞（「会话」→「对话」）。日志改动本属 spec 明文排除的类别（「日志不是界面文案，改它不属于本 PR」），
  此处按同节先例登记为例外：工单 03 在 `handleBubbleBranch` 里把日志标签 `[会话分支]` 改为 `[分支]`、随函数改名保留。
  判定理由：方向与词汇表分层一致（界面层说 chat / 对话，preload `onResetSession` 属内核层保持原名），
  消除的是上游存量不一致（`1a8cb6a` 首发即带入），无副作用（局部函数、文件内引用、无 IPC/持久化牵连）。
  同文件其余「会话」注释由第 8 组清理，不属本组欠账。撰写 `pr-description.md` 时在第 4 组说明中复述本条。
