/**
 * 服务端资产库（新后端 asset-catalog）的 IPC。
 *
 * 每个处理器回 `{ success, data?, error?, errorCode? }`：渲染层的 api/catalogLibrary.ts
 * 读取类用 unwrapResult 抛错，用户动作类自己看 errorCode 决定怎么说。
 * 令牌从不出主进程：登录、刷新、调 lore.exe 都在这边。
 */
import { dialog, ipcMain, BrowserWindow } from 'electron'
import type {
  CatalogConnectInput,
  CatalogFacetField,
  CatalogListQuery
} from '../../shared/catalogLibrary'
import { getCatalogService } from '../libraryV3'
import { CatalogServiceError } from '../libraryV3/catalogService'

type Result<T> = { success: true; data: T } | { success: false; error: string; errorCode: string }

async function run<T>(work: () => Promise<T>): Promise<Result<T>> {
  try {
    return { success: true, data: await work() }
  } catch (error) {
    const code = error instanceof CatalogServiceError ? error.code : 'unknown'
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      errorCode: code
    }
  }
}

function asQuery(value: unknown): CatalogListQuery {
  const raw = (value ?? {}) as Partial<CatalogListQuery>
  const list = (items: unknown): string[] | undefined =>
    Array.isArray(items)
      ? items.filter((item): item is string => typeof item === 'string').slice(0, 50)
      : undefined
  return {
    dir: Number.isInteger(raw.dir) ? (raw.dir as number) : 0,
    recursive: raw.recursive === true,
    q: typeof raw.q === 'string' ? raw.q.slice(0, 200) : undefined,
    sort: raw.sort,
    order: raw.order === 'asc' || raw.order === 'desc' ? raw.order : undefined,
    class: list(raw.class),
    ext: list(raw.ext),
    engine: list(raw.engine),
    tag: list(raw.tag)
  }
}

export function registerCatalogLibraryIPC(): void {
  const service = (): ReturnType<typeof getCatalogService> => getCatalogService()

  ipcMain.handle('catalogLibrary:list', () => run(() => service().listLibraries()))
  ipcMain.handle('catalogLibrary:servers', () => run(() => service().listServers()))
  ipcMain.handle(
    'catalogLibrary:probe',
    (_event, address: string, caFingerprint?: string | null, caPem?: string | null) =>
      run(async () => {
        // 固定的 CA 原文不回渲染层（它不是秘密，但也用不着）
        const probe = await service().probe(address, caFingerprint, caPem)
        delete probe.trust
        delete probe.caPem
        return probe
      })
  )
  ipcMain.handle('catalogLibrary:connect', (_event, input: CatalogConnectInput) =>
    run(() => service().connect(input))
  )
  ipcMain.handle('catalogLibrary:remoteLibraries', (_event, serverId: string) =>
    run(() => service().remoteLibraries(serverId))
  )
  ipcMain.handle(
    'catalogLibrary:add',
    (_event, serverId: string, libraries: Array<{ id: string; name: string }>) =>
      run(() => service().addLibraries(serverId, libraries))
  )
  ipcMain.handle('catalogLibrary:remove', (_event, key: string) =>
    run(() => service().removeLibrary(key))
  )
  ipcMain.handle(
    'catalogLibrary:signIn',
    (
      _event,
      serverId: string,
      input: Parameters<ReturnType<typeof getCatalogService>['signIn']>[1]
    ) => run(() => service().signIn(serverId, input))
  )
  ipcMain.handle('catalogLibrary:signOut', (_event, serverId: string) =>
    run(() => service().signOut(serverId))
  )
  ipcMain.handle(
    'catalogLibrary:setLoreRemote',
    (_event, serverId: string, remote: string | null) =>
      run(() => service().setLoreRemote(serverId, remote))
  )
  ipcMain.handle('catalogLibrary:status', (_event, key: string) => run(() => service().status(key)))
  ipcMain.handle('catalogLibrary:watch', (_event, key: string) => run(() => service().watch(key)))
  ipcMain.handle('catalogLibrary:unwatch', (_event, key: string) =>
    run(() => service().unwatch(key))
  )
  ipcMain.handle('catalogLibrary:folders', (_event, key: string, parent: number) =>
    run(() => service().folders(key, Number.isInteger(parent) ? parent : 0))
  )
  ipcMain.handle('catalogLibrary:folderByPath', (_event, key: string, path: string) =>
    run(() => service().folderByPath(key, String(path ?? '')))
  )
  ipcMain.handle(
    'catalogLibrary:listWindow',
    (_event, key: string, query: unknown, start: number, limit: number) =>
      run(() =>
        service().listWindow(
          key,
          asQuery(query),
          Math.max(0, Math.floor(Number(start) || 0)),
          Number(limit) || 100
        )
      )
  )
  ipcMain.handle(
    'catalogLibrary:facets',
    (_event, key: string, query: unknown, fields?: CatalogFacetField[], limit?: number) =>
      run(() =>
        service().facets(
          key,
          asQuery(query),
          Array.isArray(fields) ? fields : undefined,
          Math.max(1, Math.min(Number(limit) || 50, 500))
        )
      )
  )
  ipcMain.handle('catalogLibrary:detail', (_event, key: string, id: number) =>
    run(() => service().detail(key, Number(id)))
  )
  ipcMain.handle('catalogLibrary:probeAnnotations', (_event, key: string) =>
    run(() => service().probeAnnotations(key))
  )
  ipcMain.handle(
    'catalogLibrary:editAnnotations',
    (
      _event,
      key: string,
      ops: Parameters<ReturnType<typeof getCatalogService>['editAnnotations']>[1]
    ) => run(() => service().editAnnotations(key, Array.isArray(ops) ? ops : []))
  )
  ipcMain.handle('catalogLibrary:listTags', (_event, key: string) =>
    run(() => service().listTags(key))
  )
  ipcMain.handle(
    'catalogLibrary:putTag',
    (_event, key: string, name: string, patch: { color?: string | null; group?: string | null }) =>
      run(() => {
        const clean: { color?: string | null; group?: string | null } = {}
        if (patch && 'color' in patch)
          clean.color = typeof patch.color === 'string' ? patch.color : null
        if (patch && 'group' in patch)
          clean.group = typeof patch.group === 'string' ? patch.group : null
        return service().putTag(key, String(name ?? ''), clean)
      })
  )
  ipcMain.handle('catalogLibrary:deleteTag', (_event, key: string, name: string) =>
    run(() => service().deleteTag(key, String(name ?? '')))
  )
  ipcMain.handle(
    'catalogLibrary:searchFolders',
    (_event, key: string, q: string, limit?: number, dir?: number) =>
      run(() =>
        service().searchFolders(
          key,
          String(q ?? ''),
          Number(limit) || 50,
          Number.isInteger(dir) ? (dir as number) : 0
        )
      )
  )
  ipcMain.handle('catalogLibrary:closure', (_event, key: string, id: number) =>
    run(() => service().closureOf(key, Number(id)))
  )
  ipcMain.handle('catalogLibrary:unclaimed', (_event, key: string) =>
    run(() => service().unclaimed(key))
  )
  ipcMain.handle('catalogLibrary:claim', (_event, key: string, from: string, to: string) =>
    run(() => service().claim(key, String(from ?? ''), String(to ?? '')))
  )
  ipcMain.handle('catalogLibrary:favorites', (_event, key: string) =>
    run(() => service().getFavorites(key))
  )
  ipcMain.handle(
    'catalogLibrary:setFavorite',
    (_event, key: string, kind: 'asset' | 'folder', id: number, on: boolean) =>
      run(() =>
        service().setFavorite(key, kind === 'folder' ? 'folder' : 'asset', Number(id), on === true)
      )
  )
  ipcMain.handle(
    'catalogLibrary:download',
    (
      _event,
      key: string,
      input: { ids: number[]; targetRoot: string; withDependencies: boolean }
    ) =>
      run(() =>
        service().startDownload(key, {
          ids: Array.isArray(input?.ids)
            ? input.ids.filter((id) => Number.isInteger(id)).slice(0, 2000)
            : [],
          targetRoot: String(input?.targetRoot ?? ''),
          withDependencies: input?.withDependencies !== false
        })
      )
  )
  ipcMain.handle(
    'catalogLibrary:resolveRepository',
    (_event, key: string, folder: { dirId: number; path: string }) =>
      run(() =>
        service().resolveRepository(key, {
          dirId: Number(folder?.dirId) || 0,
          path: String(folder?.path ?? '')
        })
      )
  )
  ipcMain.handle(
    'catalogLibrary:import',
    (
      _event,
      key: string,
      input: { files: string[]; folderPath: string; repositoryId: string; message?: string | null }
    ) =>
      run(() =>
        service().startImport(key, {
          files: Array.isArray(input?.files)
            ? input.files.filter((file) => typeof file === 'string')
            : [],
          folderPath: String(input?.folderPath ?? ''),
          repositoryId: String(input?.repositoryId ?? ''),
          message: input?.message ?? null
        })
      )
  )
  ipcMain.handle('catalogLibrary:cancelJob', (_event, jobId: string) =>
    run(async () => service().cancelJob(jobId))
  )
  ipcMain.handle('catalogLibrary:getActive', () => run(() => service().getActive()))
  ipcMain.handle('catalogLibrary:setActive', (_event, key: string | null) =>
    run(() => service().setActive(typeof key === 'string' ? key : null))
  )
  ipcMain.handle('catalogLibrary:clearCache', (_event, key?: string | null) =>
    run(() => service().clearCache(key))
  )
  ipcMain.handle('catalogLibrary:pickFiles', (event) =>
    run(async () => {
      const window = BrowserWindow.fromWebContents(event.sender) ?? undefined
      const options = {
        properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>
      }
      const result = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options)
      return result.canceled ? [] : result.filePaths
    })
  )
  ipcMain.handle('catalogLibrary:pickFolder', (event) =>
    run(async () => {
      const window = BrowserWindow.fromWebContents(event.sender) ?? undefined
      const options = {
        properties: ['openDirectory', 'createDirectory'] as Array<
          'openDirectory' | 'createDirectory'
        >
      }
      const result = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options)
      return result.canceled ? null : (result.filePaths[0] ?? null)
    })
  )
  ipcMain.handle('catalogLibrary:pickCaFile', (event) =>
    run(async () => {
      const window = BrowserWindow.fromWebContents(event.sender) ?? undefined
      const options = {
        properties: ['openFile'] as Array<'openFile'>,
        filters: [{ name: 'CA certificate', extensions: ['pem', 'crt', 'cer'] }]
      }
      const result = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options)
      if (result.canceled || !result.filePaths[0]) return null
      const { readFile } = await import('node:fs/promises')
      const text = await readFile(result.filePaths[0], 'utf8')
      if (!text.includes('BEGIN CERTIFICATE'))
        throw new CatalogServiceError('ca-file-not-pem', 'Not a PEM certificate')
      return text
    })
  )
}
