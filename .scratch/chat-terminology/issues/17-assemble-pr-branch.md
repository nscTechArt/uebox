# 17: 组装 PR 分支

Status: done（分支已组装、门禁全绿；剩最后一步：待人批准后推送）
Blocked by: 09、10、11、12、13、14、15、16、18
组：全部 8 组

依据：`../spec.md`「执行方式」「提交 PR」；AGENTS.md §3、§6、§10。

**What to build:** 一条可以交给上游审阅的本地 PR 分支：8 组提交，每组单独可审、单独是绿的，PR 描述按 spec 起草好。
不 push、不开 PR，等人批准。

- [x] 分支从 `upstream/main` 切出；按 spec「提交 PR」的组表，每组用 `cherry-pick -n` 叠加已有提交与该组的新提交，每组提交一次
- [x] 不挑 `.scratch/` 提交与 fork 专属提交；09 存的行为修复补丁不进本分支
- [x] 语言包相邻冲突手动解决；每组提交后跑 `pnpm verify:changed`（`VERIFY_BASE` 指向上一组），每组单独是绿的
- [x] 上游新增的含禁用词字符串（`generate_speech` 一处）在引入该词的第 7 组里改掉
- [x] 8 组叠完后在本分支上跑一次完整 `pnpm verify`，全绿
- [x] PR 描述按 spec 起草，存于 `../pr-description.md`
- [ ] 推送、开 PR（待人批准）
