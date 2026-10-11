# 10: 审批按钮撤回「始终」

Status: done
Blocked by: None (can start immediately)
组：第 1 组（01–02）

依据：`../spec.md`「点名审批按钮的文字（02）」中的「复评修正」与「文案复评修正」表里 `allowForChat` 一行；术语见根目录 `CONTEXT.md`。

**What to build:** 审批确认框里放行这条对话的按钮，主窗口和小窗都写「本对话内都允许 / Allow for this chat」，不再承诺做不到的「始终」
（放行名单重启、分支、切到 Ask 模式都会失效）。模型照工具文字指引用户去点的，也是这个新名字。

- [x] 两个 `allowForChat` key 中英两侧等于新目标值
- [x] 点名这枚按钮的工具文字、断言它的 `vaultScope.test.ts`、描述现状的注释与测试标题同步改
- [x] `src/` 下 `本对话内始终允许`、`Always allow in this chat` 零命中
- [x] 放行名单的行为不变（不做持久化）
- [x] `vaultScope.test.ts` 与术语守卫通过；提交信息标明「第 1 组」，只含第 1 组的改动
