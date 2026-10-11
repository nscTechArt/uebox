# 03: 分支

Status: done
Blocked by: 02b

依据：`../spec.md` 的「文案表 · 03」「代码改名：分支」；术语见根目录 `CONTEXT.md`。

**What to build:** 用户从某条回复分支时，提示只用「分支 / Branch」一个词；在不能分支的对话（如知识库里那条）上，
看到的是用户能懂的「这条对话不能分支」。代码里界面那层的分支叫 branch，内核复制 session 的那一步仍叫 fork，
名字本身就说明它在哪一层。

- [x] 文案表 · 03 的每个 key，两侧值都等于目标值
- [x] 「代码改名：分支」表的每一行都已改完，满足表下的完成标准（零命中清单与 `forkSession` 的保留范围）
- [x] 点名了被改名字的代码注释（如 `transcriptRewind.ts` 的 `sessionFork.ts`、`chatMessages.test.ts` 的 `forkSession`）随之更新
- [x] 词表加入完整词表中标为 03 的行，守卫零命中
- [x] 测试通过：术语守卫、`chatBranch.test.ts`、`AIBubble.actions.test.ts`，
  以及按 spec「事件连线测试」新建的 `ChatLog.branch.test.ts` 与 `Welcome.events.test.ts`（本张只含 `@branch` 一条）
- [x] 渲染层类型检查通过
