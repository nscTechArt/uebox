/**
 * 服务端资产库（新后端 asset-catalog）的渲染层封装。
 *
 * 两种返回风格（AGENTS.md 硬规则 5）：
 *
 * - **读取类**（列表、文件夹、详情、分面……）用 `unwrapResult`：拿不到数据界面也没法往下画，
 *   抛出去由调用方统一显示。抛出的 Error 带 `code`（主进程给的错误码），界面据此选文案。
 * - **用户动作类**（连接服务器、登录、导入、下载、改注释）回 `{ success, data?, error?, errorCode? }`：
 *   每个对话框报错的方式不一样，调用方自己看 errorCode。
 */
import type {
  CatalogAssetDetail,
  CatalogConnectInput,
  CatalogConnectResult,
  CatalogFacetField,
  CatalogFacets,
  CatalogFolder,
  CatalogLibraryEvent,
  CatalogLibraryStatus,
  CatalogLibraryView,
  CatalogListQuery,
  CatalogProbeResult,
  CatalogRemoteLibrary,
  CatalogServerView,
  CatalogWindow,
  CatalogTagDef,
  CatalogFavorites,
  CatalogClosure,
  CatalogUnclaimed
} from '@core/shared/catalogLibrary'

export interface CatalogActionResult<T> {
  success: boolean
  data?: T
  error?: string
  errorCode?: string
}

export class CatalogApiError extends Error {
  readonly code: string
  constructor(message: string, code: string) {
    super(message)
    this.name = 'CatalogApiError'
    this.code = code
  }
}

type Raw<T> = { success: boolean; data?: T; error?: string; errorCode?: string }

function bridge(): NonNullable<typeof window.api.catalogLibrary> {
  const api = window.api?.catalogLibrary
  if (!api) throw new CatalogApiError('catalogLibrary bridge is not available', 'no-bridge')
  return api
}

function unwrap<T>(result: Raw<T>): T {
  if (!result || result.success !== true) {
    throw new CatalogApiError(result?.error || 'Request failed', result?.errorCode || 'unknown')
  }
  return result.data as T
}

async function action<T>(call: () => Promise<Raw<T>>): Promise<CatalogActionResult<T>> {
  try {
    const result = await call()
    return result.success
      ? { success: true, data: result.data }
      : { success: false, error: result.error, errorCode: result.errorCode || 'unknown' }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      errorCode: error instanceof CatalogApiError ? error.code : 'no-bridge'
    }
  }
}

export const catalogLibraryAPI = {
  // ---- 读取
  async list(): Promise<CatalogLibraryView[]> {
    return unwrap(await bridge().list())
  },
  async servers(): Promise<CatalogServerView[]> {
    return unwrap(await bridge().servers())
  },
  async status(key: string): Promise<CatalogLibraryStatus> {
    return unwrap(await bridge().status(key))
  },
  async watch(key: string): Promise<CatalogLibraryStatus> {
    return unwrap(await bridge().watch(key))
  },
  async unwatch(key: string): Promise<void> {
    unwrap(await bridge().unwatch(key))
  },
  async folders(
    key: string,
    parent: number
  ): Promise<{ folder: CatalogFolder | null; items: CatalogFolder[]; stale: boolean }> {
    return unwrap(await bridge().folders(key, parent))
  },
  async folderByPath(key: string, path: string): Promise<CatalogFolder> {
    return unwrap(await bridge().folderByPath(key, path))
  },
  async listWindow(
    key: string,
    query: CatalogListQuery,
    start: number,
    limit: number
  ): Promise<CatalogWindow> {
    // IPC 结构化克隆不认 Vue 的响应式代理：先拍平
    return unwrap(await bridge().listWindow(key, plain(query), start, limit))
  },
  async facets(
    key: string,
    query: CatalogListQuery,
    fields?: CatalogFacetField[],
    limit?: number
  ): Promise<CatalogFacets> {
    return unwrap(await bridge().facets(key, plain(query), fields ? [...fields] : undefined, limit))
  },
  async detail(key: string, id: number): Promise<CatalogAssetDetail> {
    return unwrap(await bridge().detail(key, id))
  },
  async probeAnnotations(key: string): Promise<boolean> {
    return unwrap(await bridge().probeAnnotations(key))
  },
  async resolveRepository(
    key: string,
    folder: { dirId: number; path: string }
  ): Promise<{
    repositoryId: string | null
    candidates: string[]
    names: Record<string, string>
  }> {
    return unwrap(await bridge().resolveRepository(key, { dirId: folder.dirId, path: folder.path }))
  },

  // ---- 用户动作
  probe(
    address: string,
    caFingerprint?: string | null,
    caPem?: string | null
  ): Promise<CatalogActionResult<CatalogProbeResult>> {
    return action(() => bridge().probe(address, caFingerprint ?? null, caPem ?? null))
  },
  connect(input: CatalogConnectInput): Promise<CatalogActionResult<CatalogConnectResult>> {
    return action(() => bridge().connect(plain(input)))
  },
  remoteLibraries(serverId: string): Promise<CatalogActionResult<CatalogRemoteLibrary[]>> {
    return action(() => bridge().remoteLibraries(serverId))
  },
  add(
    serverId: string,
    libraries: Array<{ id: string; name: string }>
  ): Promise<CatalogActionResult<CatalogLibraryView[]>> {
    return action(() => bridge().add(serverId, plain(libraries)))
  },
  remove(key: string): Promise<CatalogActionResult<void>> {
    return action(() => bridge().remove(key))
  },
  signIn(
    serverId: string,
    input: {
      member?: string | null
      password?: string | null
      inviteCode?: string | null
      identityToken?: string | null
    }
  ): Promise<CatalogActionResult<CatalogServerView>> {
    return action(() => bridge().signIn(serverId, plain(input)))
  },
  signOut(serverId: string): Promise<CatalogActionResult<void>> {
    return action(() => bridge().signOut(serverId))
  },
  setLoreRemote(serverId: string, remote: string | null): Promise<CatalogActionResult<void>> {
    return action(() => bridge().setLoreRemote(serverId, remote))
  },
  editAnnotations(
    key: string,
    ops: Array<{
      path?: string
      folderPath?: string
      set?: Record<string, unknown>
      addTags?: string[]
      removeTags?: string[]
    }>
  ): Promise<CatalogActionResult<{ accepted: number; journalSeq: number | null }>> {
    return action(() => bridge().editAnnotations(key, plain(ops)))
  },
  async listTags(key: string): Promise<CatalogTagDef[]> {
    return unwrap(await bridge().listTags(key))
  },
  putTag(
    key: string,
    name: string,
    patch: { color?: string | null; group?: string | null }
  ): Promise<CatalogActionResult<void>> {
    return action(() => bridge().putTag(key, name, plain(patch)))
  },
  deleteTag(key: string, name: string): Promise<CatalogActionResult<void>> {
    return action(() => bridge().deleteTag(key, name))
  },
  /** null = 服务器还没有按文件夹名搜索 */
  async searchFolders(
    key: string,
    q: string,
    limit?: number,
    dir?: number
  ): Promise<CatalogFolder[] | null> {
    return unwrap(await bridge().searchFolders(key, q, limit, dir))
  },
  /** null = 服务端还不会算闭包 */
  async closure(key: string, id: number): Promise<CatalogClosure | null> {
    return unwrap(await bridge().closure(key, id))
  },
  /** null = 服务端没有待认领注释这条路由，或你没权限看 */
  async unclaimed(key: string): Promise<CatalogUnclaimed[] | null> {
    return unwrap(await bridge().unclaimed(key))
  },
  claim(key: string, from: string, to: string): Promise<CatalogActionResult<void>> {
    return action(() => bridge().claim(key, from, to))
  },
  async favorites(key: string): Promise<CatalogFavorites> {
    return unwrap(await bridge().favorites(key))
  },
  async setFavorite(
    key: string,
    kind: 'asset' | 'folder',
    id: number,
    on: boolean
  ): Promise<CatalogFavorites> {
    return unwrap(await bridge().setFavorite(key, kind, id, on))
  },
  download(
    key: string,
    input: { ids: number[]; targetRoot: string; withDependencies: boolean }
  ): Promise<CatalogActionResult<string>> {
    return action(() => bridge().download(key, plain(input)))
  },
  importFiles(
    key: string,
    input: { files: string[]; folderPath: string; repositoryId: string; message?: string | null }
  ): Promise<CatalogActionResult<string>> {
    return action(() => bridge().import(key, plain(input)))
  },
  cancelJob(jobId: string): Promise<CatalogActionResult<void>> {
    return action(() => bridge().cancelJob(jobId))
  },
  async getActive(): Promise<string | null> {
    return unwrap(await bridge().getActive())
  },
  setActive(key: string | null): Promise<CatalogActionResult<void>> {
    return action(() => bridge().setActive(key))
  },
  clearCache(key?: string | null): Promise<CatalogActionResult<void>> {
    return action(() => bridge().clearCache(key ?? null))
  },
  pickFiles(): Promise<CatalogActionResult<string[]>> {
    return action(() => bridge().pickFiles())
  },
  pickFolder(): Promise<CatalogActionResult<string | null>> {
    return action(() => bridge().pickFolder())
  },
  pickCaFile(): Promise<CatalogActionResult<string | null>> {
    return action(() => bridge().pickCaFile())
  },

  // ---- 事件
  onEvent(listener: (event: CatalogLibraryEvent) => void): () => void {
    const api = window.api?.catalogLibrary
    if (!api) return () => undefined
    return api.onEvent(listener)
  }
}

/** 去掉响应式代理，保证能过 IPC 的结构化克隆 */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
