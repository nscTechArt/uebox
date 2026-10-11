# 09: 第 5 组拆出行为修复

Status: done
Blocked by: None (can start immediately)
组：第 5 组（用户可见的错误改走错误码）

依据：`../spec.md`「用户可见的错误改走错误码（第 5 组）」中「拆出两处行为修复」与 `console.error` 那一段；术语见根目录 `CONTEXT.md`。

**What to build:** 第 5 组只剩术语所需的改动：续跑、插话被拒时照样按错误码给出新提示，但续跑判忙和「接着跑」按钮的行为回到改前。
两处行为修复连同测试存成补丁，留给术语 PR 之后的 fix PR，不丢。

- [x] 续跑判忙由 `isBusy` 回退为 `isStreaming`，那一行上方的注释一并回退；同一函数里的错误码与文案改动保留
- [x] 点「接着跑」时先查 `isBusy` 的那段整段移除
- [x] `useAgentMode.resumeSteer.test.ts` 里测这两处的用例移走（「摘按钮之前先查 isBusy」一段，及断言续跑按 `isBusy` 拦截的用例）；
  错误码、按码选文案、插话按入口提示的用例不改断言
- [x] `2a288ba` 改成英文的那条 `console.error` 改回 `'[Agent模式] 续跑失败:'`
- [x] 拆出的代码与测试存成补丁放在 `.scratch/chat-terminology/` 下，能在术语 PR 之上干净应用；补丁另起提交（`.scratch/` 提交）
- [x] 留下的错误码相关测试通过；实现提交信息标明「第 5 组」，只含第 5 组的改动

补丁：`../group5-resume-busy-behavior-fixes.patch`（在回退后的代码上 `git apply --check` 通过，打上后全部用例绿）。
