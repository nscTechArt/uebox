# 01: 术语守卫骨架

Status: done
Blocked by: None

依据：`../spec.md` 的「术语守卫」「Testing Decisions」；术语见根目录 `CONTEXT.md`。

**What to build:** 一个零容忍的术语守卫测试。它读遍三份文案里的全部字符串，发现禁用词就失败，并告诉贡献者在哪、命中了什么、该换成什么。
本张只搭机制，正式词表与白名单为空，测试是绿的；02–08 每张清理完一个概念就往表里加词。

- [x] 开工前完成 spec「执行方式」要求的同步上游与复核
- [x] `terminologyGuard.test.ts` 的位置、输入、匹配、失败信息符合 spec「术语守卫」
- [x] 禁用词表与白名单的机制就位、内容为空（白名单 08 填入）；词表顶部注释写齐 spec「术语守卫 · 禁用词表」要求的各项
- [x] 内联自证样例全部通过（spec「Testing Decisions · 新增：术语守卫测试」列出的每种情形）
- [x] 本测试文件与渲染层类型检查（`tsconfig.web.json`）通过
