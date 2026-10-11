# 04: 网络库导入的 401 提示与整包上传失败的外框

Status: needs-triage
Blocked by: 02（共用它的 `errorKey` 解析与 `importErrorText.ts`）。不进 `chat-terminology` 的 PR。

依据：`01-scope-terminology-beyond-locales.md` ①「核实中发现的事实」末两条。行号是 `f263072` 时的快照，按文字搜索为准。
两条都是首次开源（`1a8cb6a`）就有的，不是 `chat-terminology` 带进来的。

## 问题

**401 说成了「登录」。** `src/main/services/asset/importFeatureFlag.ts:162`：导入体检时服务器回 401，返回
`userMessage: '登录状态已过期，请重新登录后再导入'`（`errorCode` 缺省为 `NAS_AUTH_REQUIRED`）。HTTP 资产库靠访问码鉴权，
这个页面上的登录弹窗（`CatalogSignInModal`）属于另一种库「服务器库」，用户照着提示找不到可以登录的地方。这句也只有中文。

**整包上传失败套了「文件夹导入失败」。** 工程整包上传失败经 `asset:folderImportError` 送到 `AssetManagement/index.vue` 的
`handleFolderImportError`，统一用 `assetLib.import.failed`「文件夹导入失败: {message}」显示。整包上传在界面上叫「工程整包上传」
（`assetManagement.import.importProjectArchive`），外框说错了导入类型。

## 要定的

- 401 的准确说法：访问码失效还是不对，客户端能否区分（看 `NAS_AUTH_REQUIRED` 之外服务器还回什么码）；
  对确实是「服务器库」登录失效的情形是否也走这条路。
- `asset:folderImportError` 由文件夹导入和整包上传共用：payload 里能否区分来源，不能的话加什么字段。
- 401 提示改走 02 的 `errorKey` 机制；`userMessage` 原文是否还有模型侧读者（`box_manage` 等），有就保留。

## 完成标准

- [ ] 401 提示在中英文界面都给出正确的原因和可执行的下一步
- [ ] 整包上传失败显示整包上传自己的外框，文件夹导入失败照旧
- [ ] 对应测试；`VERIFY_BASE=HEAD pnpm verify:changed` 通过
