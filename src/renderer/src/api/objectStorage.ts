/**
 * 对象存储的渲染层 API。
 *
 * 不走 `unwrapResult()`：这里全是用户点一下就发一次的动作（保存、测试、删除、清理），
 * 主进程回的就是 `{ success, error? }`，调用方要自己看成败、各报各的
 * （AGENTS.md 硬规则 5 允许的那种例外，参照 api/updater.ts）。
 */

import type {
  ObjectStorageConfigView,
  ObjectStorageEntry,
  ObjectStorageRemoveResult,
  ObjectStorageSaveInput
} from '../../../shared/objectStorage'

export type {
  ObjectStorageConfigView,
  ObjectStorageEntry,
  ObjectStorageRemoveResult,
  ObjectStorageSaveInput
}

export interface UploadProgressEvent {
  filePath: string
  percent: number
  note: string
}

export const objectStorageAPI = {
  get: (): Promise<ObjectStorageConfigView> => window.api.objectStorage.get(),

  save: (
    input: ObjectStorageSaveInput
  ): Promise<{ success: boolean; view?: ObjectStorageConfigView; error?: string }> =>
    window.api.objectStorage.save(input),

  /** 写一个小文件、用链接读回来、再删掉。三步都通才算通 */
  test: (input: ObjectStorageSaveInput): Promise<{ ok: boolean; message: string }> =>
    window.api.objectStorage.test(input),

  /** 开着且配完整了。输入框据此决定拖进来要不要开传 */
  ready: async (): Promise<boolean> => {
    // 可选链不是防御性编程：单测里挂载输入框时 window.api 只有被测到的那几块
    return (await window.api.objectStorage?.ready()) ?? false
  },

  list: (): Promise<{ success: boolean; objects?: ObjectStorageEntry[]; error?: string }> =>
    window.api.objectStorage.list(),

  remove: (keys: string[]): Promise<ObjectStorageRemoveResult> =>
    window.api.objectStorage.remove([...keys]),

  clean: (days: number): Promise<ObjectStorageRemoveResult> => window.api.objectStorage.clean(days),

  upload: (filePath: string): Promise<{ success: boolean; key?: string; error?: string }> =>
    window.api.objectStorage.upload(filePath),

  onUploadProgress: (callback: (event: UploadProgressEvent) => void): (() => void) | undefined =>
    window.api.objectStorage?.onUploadProgress(callback)
}
