/**
 * 资产导入失败的可枚举原因。主进程在 `error`（给模型和日志的原文）之外附带这个码，
 * 渲染层拿它去语言包查译文 —— 界面文案从此归界面管，主进程只管事实。
 * 值与 `assetManagement.import.errors.*` 一一对应，对应表在
 * `src/renderer/src/views/AssetManagement/importErrorText.ts`。
 */
export type ImportErrorKey =
  | 'reportMissingImportId' // 报告里没有 sessionId，定位不到服务器上的那次导入
  | 'notResumable' // 服务器上这次导入的状态已经不能续传
  | 'cancelNotConfirmed' // 放弃导入时回读到的状态不是 cancelled
  | 'serverImportFailed' // 整包上传时服务器没给 errorMessage / errorCode 的兜底

/** 主进程导入失败结果里和界面文案有关的那几个字段 */
export interface ImportErrorDetails {
  error?: string
  /** 渲染层拿它去语言包查译文；error 仍是给模型和日志的原文 */
  errorKey?: ImportErrorKey
  errorParams?: { status?: string }
}
