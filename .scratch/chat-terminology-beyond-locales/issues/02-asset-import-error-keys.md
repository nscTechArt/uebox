# 02: 资产导入四条错误改走 errorKey

Status: done
Blocked by: None（随 `chat-terminology` 的 PR 提交，与 03 同在第 5 组，见其 spec「提交 PR」）

依据：`01-scope-terminology-beyond-locales.md` ① 的结论与「核实中发现的事实」；术语见根目录 `CONTEXT.md`。
行号是 `f263072` 时的快照，按文字搜索为准。

## 问题

NAS（HTTP 资产服务器）导入失败时，下面四句由主进程拼成中文，原样塞进语言包外框的 `{error}`。两个毛病：
仍说「会话」，与外框的「这次导入」对不上；英文界面也显示这句中文。

| 出处 | 触发 | 显示在 |
|---|---|---|
| `src/main/services/asset/ResumeImportService.ts:140`「JSON 报告里缺少 sessionId，无法定位服务端导入会话」 | 选来续传的报告没有 sessionId，本机也没有恢复记录 | `resumeFailed` |
| 同文件 `:601`「该导入会话当前状态不支持续传: {status}」 | 服务器上这次导入已不可续传 | 恢复弹窗 `continueFailed`；JSON 续传 `resumeFailed` |
| 同文件 `:834`「服务端没有取消这次会话（当前状态：{status}）」 | 放弃导入时服务器回读状态不是 cancelled | `abandonStagingLeft` |
| `src/main/services/asset/projectArchiveUpload.ts:522`「服务端会话进入 {status} 状态」 | 整包上传时服务器会话失败、且没给 errorMessage / errorCode | `asset:folderImportError` → `assetLib.import.failed` |

## 做法

**主进程：加 `errorKey`，保留 `error`。** `error` 还要经 `box_manage` 和导入任务 `errorMessage` 给模型读，不能删。

1. 新建 `src/shared/importErrorKey.ts`：
   ```ts
   export type ImportErrorKey =
     | 'reportMissingImportId' // :140
     | 'notResumable'          // :601
     | 'cancelNotConfirmed'    // :834
     | 'serverImportFailed'    // :522
   ```
2. `ResumeImportResult`、`AbandonImportResult`、`ProjectArchiveUploadResult` 各加
   `errorKey?: ImportErrorKey` 与 `errorParams?: { status?: string }`，四个分支填上。`:522` 只在兜底分支填；
   服务器给了 errorMessage / errorCode 时照旧透传原文，不填 `errorKey`。
3. `src/main/ipc/projectArchiveUpload.ts` 失败时把 `errorKey` / `errorParams` 一并放进 `asset:folderImportError` 的 payload。
4. 四句 `error` 原文同时改掉「会话」（给模型和日志）：
   - `:140`「JSON 报告里缺少 sessionId，找不到服务器上的这次导入」
   - `:601`「这次导入在服务器上的状态是 {status}，不能继续」
   - `:834`「服务器没有取消这次导入（当前状态：{status}）」
   - `:522`「服务器上的这次导入进入了 {status} 状态」

**渲染层：一个查表函数，四处调用。**

5. 新建 `src/renderer/src/views/AssetManagement/importErrorText.ts`，形状照 `agentControlHandlers.ts` 的 `describeStartupError`：
   用**写全的 key 表**（`Record<ImportErrorKey, string>`，值是完整 i18n key，不拼字符串，搜得到也测得到；
   `usedKeyCoverage` 只扫 `t('字面量')`，扫不到这张表，所以表的完整性由下面的测试守），
   认识的 key 且 `t(key) !== key` 时返回 `t(key, errorParams)`，否则返回 `error`，再否则返回 `fallback`。
6. `AssetManagement/index.vue` 里取 `{error}` 的地方改为调用它：`resumeImportByReportRef`（`result.error`）、
   恢复弹窗 `onOk`（非 expired 分支）、`abandonImportSession`（`abandonFailed` 与 `abandonStagingLeft` 两处）、
   `handleFolderImportError`（toast 与结果面板的 `failures[].error`）。`handleFolderImportError` 也接普通文件夹导入，
   那些 payload 没有 `errorKey`，必须原样走回 `message`。
7. 两份语言包加 `assetManagement.import.errors.*`，`{status}` 是服务器原话，原样显示、不翻译：

   | key | zh-CN | en-US |
   |---|---|---|
   | `reportMissingImportId` | 这份报告里没有服务器上这次导入的编号，没法继续 | This report has no server import ID, so it can't be resumed. |
   | `notResumable` | 这次导入在服务器上已经不能继续（服务器状态：{status}） | This import can no longer be resumed on the server (server status: {status}). |
   | `cancelNotConfirmed` | 服务器没有确认取消这次导入（服务器状态：{status}） | The server did not confirm cancelling this import (server status: {status}). |
   | `serverImportFailed` | 服务器上的这次导入失败了（服务器状态：{status}） | This import failed on the server (server status: {status}). |

## 不做

- `index.vue:2525` 那条匹配 `:554` / `:171` 原文的正则，以及那两句本身。
- 资产导入里其余只有中文的错误（对账未通过、体检失败等）。
- 整包上传失败套用「文件夹导入失败」外框、`importFeatureFlag.ts:162` 把访问码失效说成「登录」：见 04。
- 给 `diagnostics:*` 补 preload 类型与 `api/*` 包装。

## 完成标准

- [x] `ResumeImportService.test.ts`：`:601`、`:834`（扩展已有的 committed 用例）、`:140`（report 无 sessionId 且无本地上下文）各断言 `errorKey`，前两者再断言 `errorParams.status`
- [x] `projectArchiveUpload.test.ts`：会话失败且无 errorMessage / errorCode → `errorKey: 'serverImportFailed'`；有 errorMessage → 无 `errorKey`、原文透传
- [x] `ipc/projectArchiveUpload.test.ts`：`asset:folderImportError` payload 带上 `errorKey`
- [x] `importErrorText.test.ts`：key 表里每个值在 zh-CN、en-US 都取得到字符串；认识的 key 出译文且带入 status；
      未知 key、语言包缺 key 都退回 `error`；两者都没有退回 `fallback`
- [x] 术语守卫通过；`src/main/services/asset` 下四句原文不再含「会话」
- [x] `VERIFY_BASE=HEAD pnpm verify:changed` 通过
