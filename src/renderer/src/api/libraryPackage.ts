/**
 * 蓝图包 / 材质包的渲染层封装。
 *
 * 磁盘上的读写和全部安全判断在主进程（`src/main/services/libraryPackageStore.ts`），
 * 这里只做通道收口和错误拆包，不含任何业务判断。
 */
import { unwrapResult } from '@renderer/common/utils'
import type {
  LibraryKind,
  LibraryPackageDto,
  LibraryPackageScanDto
} from '../../../shared/libraryPackage'

export type {
  LibraryKind,
  LibraryPackageDto,
  LibraryPackageManifest,
  LibraryPackageProblemDto,
  LibraryPackageScanDto
} from '../../../shared/libraryPackage'

/**
 * 把要发给主进程的条目内容拍成纯对象。
 *
 * 条目是从 `ref<Entry[]>` 里取出来的，读出来就是深响应式代理。Proxy 过不了
 * Electron IPC 的结构化克隆 —— `ipcRenderer.invoke` 直接 reject，错误原文是
 * `An object could not be cloned.`。落盘那一层把它当「这一条写失败」接住，
 * 于是用户看到的是「有 N 项没能存进保管库」，而真正的原因跟保管库无关。
 *
 * 这些 payload 本来就是要写进清单 JSON 的，JSON 往返不丢信息。
 */
function toPlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export const libraryPackageAPI = {
  /**
   * 有没有 preload。浏览器调试和单元测试里没有，调用方据此退回只读的空库，
   * 而不是让整个 store 的初始化抛在半路。
   */
  isAvailable(): boolean {
    return typeof window !== 'undefined' && !!window.api?.libraryPackage
  },

  /**
   * 走一遍磁盘，把当前保管库里的所有包找出来。
   *
   * 这是「删掉数据库、重新扫一遍、库完整回来」的入口 —— 磁盘是唯一真相源。
   */
  async scan(): Promise<LibraryPackageScanDto> {
    const res = await window.api.libraryPackage.scan()
    return unwrapResult<LibraryPackageScanDto>(res, '扫描蓝图/材质包失败')
  },

  async read(dirPath: string): Promise<LibraryPackageDto | null> {
    const res = await window.api.libraryPackage.read(dirPath)
    return unwrapResult<LibraryPackageDto | null>(res, '读取包失败')
  },

  async create(payload: {
    library: LibraryKind
    id: string
    name: string
    payload: unknown
    parentRelPath?: string
  }): Promise<LibraryPackageDto | null> {
    const res = await window.api.libraryPackage.create(toPlain(payload))
    return unwrapResult<LibraryPackageDto | null>(res, '新建包失败')
  },

  async update(
    dirPath: string,
    patch: { name?: string; payload?: unknown; cover?: string }
  ): Promise<LibraryPackageDto | null> {
    const res = await window.api.libraryPackage.update(dirPath, toPlain(patch))
    return unwrapResult<LibraryPackageDto | null>(res, '保存包失败')
  },

  /** 改名会移动目录 —— 之后必须用返回的新 `dirPath`，旧的已经失效 */
  async rename(dirPath: string, newName: string): Promise<LibraryPackageDto | null> {
    const res = await window.api.libraryPackage.rename(dirPath, newName)
    return unwrapResult<LibraryPackageDto | null>(res, '重命名失败')
  },

  async delete(dirPath: string): Promise<boolean> {
    const res = await window.api.libraryPackage.delete(dirPath)
    return unwrapResult<boolean>(res, '删除包失败')
  },

  /** 分组列表、迁移标记这类库级元信息。返回 null 表示还没写过。 */
  async readMeta(): Promise<string | null> {
    const res = await window.api.libraryPackage.readMeta()
    return unwrapResult<string | null>(res, '读取库元信息失败')
  },

  async writeMeta(text: string): Promise<boolean> {
    const res = await window.api.libraryPackage.writeMeta(text)
    return unwrapResult<boolean>(res, '写入库元信息失败')
  },

  /** 往包里写封面、贴图。`relPath` 是包内相对路径，如 `cover.png` */
  async writeFile(dirPath: string, relPath: string, data: Uint8Array): Promise<boolean> {
    const res = await window.api.libraryPackage.writeFile(dirPath, relPath, data)
    return unwrapResult<boolean>(res, '写入包内文件失败')
  },

  async readFile(dirPath: string, relPath: string): Promise<Uint8Array | null> {
    const res = await window.api.libraryPackage.readFile(dirPath, relPath)
    return unwrapResult<Uint8Array | null>(res, '读取包内文件失败')
  }
}

export default libraryPackageAPI
