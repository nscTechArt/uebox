/**
 * 蓝图包 / 材质包穿过 IPC 的那几个类型。
 *
 * 放 `src/shared/` 是因为主进程和渲染进程都要用它 —— 各写一份迟早会漂，
 * 而漂掉的那一刻 typecheck 是绿的，错在运行时才出现。
 *
 * 磁盘上的读写规则见 `src/main/services/libraryPackageStore.ts`，
 * 包的格式与命名见 `src/main/utils/libraryPackage.ts`。
 */

/** 哪个库 */
export type LibraryKind = 'blueprint' | 'material'

/** 包里那份清单：元信息在外层，领域数据整个塞在 `payload` 里 */
export interface LibraryPackageManifest {
  format: string
  formatVersion: number
  /** 条目 ID。跨机器稳定，改名不变。 */
  id: string
  /** 显示名。跟目录名可能不一致（目录名被洗过），以这里为准。 */
  name: string
  createdAt: number
  updatedAt: number
  /** 包内的封面文件名，如 `cover.png`；没有封面时为空 */
  cover: string
  /** 领域数据。IPC 这一层不解释它。 */
  payload: unknown
}

/** 一个包。`dirPath` 是绝对路径，删除和改名拿它当句柄。 */
export interface LibraryPackageDto {
  dirPath: string
  /** 相对保管库根目录，用正斜杠。跨机器稳定，适合存进索引。 */
  relPath: string
  library: LibraryKind
  manifest: LibraryPackageManifest
}

/** 扫到了但读不了的包。不能默默跳过 —— 用户得知道哪个包坏了。 */
export interface LibraryPackageProblemDto {
  dirPath: string
  relPath: string
  reason: 'manifest-missing' | 'manifest-unreadable' | 'manifest-invalid'
}

export interface LibraryPackageScanDto {
  entries: LibraryPackageDto[]
  problems: LibraryPackageProblemDto[]
}
