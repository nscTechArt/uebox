import { promises as fs } from 'fs'
import path from 'path'
import { runEditorPython } from './editorPython'
import {
  contentPathToDiskPath,
  snapshotPathFor,
  DEFAULT_MAX_SNAPSHOT_BYTES,
  type AssetSnapshotEntry,
  type SnapshotOutcome
} from './assetSnapshotPaths'

export {
  contentPathToDiskPath,
  snapshotPathFor,
  snapshotRootFor,
  DEFAULT_MAX_SNAPSHOT_BYTES
} from './assetSnapshotPaths'
export type { AssetSnapshotEntry, SnapshotOutcome, SnapshotSkipReason } from './assetSnapshotPaths'

/**
 * 资产快照 —— 「本轮改动」能撤回的前提。
 *
 * ## 为什么不能直接拷 .uasset 了事
 *
 * 编辑器把资产放在内存里，磁盘上的 `.uasset` 只有保存时才变。所以：
 *   1. **快照前必须先让引擎保存**，否则存下来的是更早的版本，
 *      回滚会把用户自己没保存的工作一起抹掉 —— 比不回滚更糟；
 *   2. **回滚后必须让引擎重新加载**，否则内存里那份还是新的，
 *      界面上什么都不会变，用户下次保存又把回滚结果覆盖掉。
 *
 * ## 为什么不用引擎自带的 AutoSave
 *
 * AutoSave 存的是「改**之后**」的脏包（防丢失），时机是十分钟一次的定时器，
 * 包名还带 `_Auto1` 后缀。回滚要的是「改**之前**的那一瞬间」，两者不是一回事。
 * 但它的**存放位置**值得抄：工程的 `Saved/` 目录不进版本控制、跟着工程走，
 * 比系统临时目录合适 —— 所以快照也落在 `Saved/UnrealBox/Snapshots/` 下。
 *
 * ## 当前状态：原型
 *
 * 只做「单个资产 → 保存 → 拷贝 → 还原 → 重载」这一条链，用来在真机上确认
 * 三件事：重载 API 在 5.5 上叫什么、资产开着时会不会出问题、save_asset 耗时。
 * 结论出来之前不要在这上面建界面。
 */

/** 让引擎把这个资产存到磁盘，并回报它当时脏不脏、是不是开着 */
async function saveAssetInEditor(contentPath: string): Promise<{
  ok: boolean
  exists: boolean
  wasDirty: boolean
  error?: string
}> {
  const script = `
asset_path = ${JSON.stringify(contentPath)}
exists = unreal.EditorAssetLibrary.does_asset_exist(asset_path)
was_dirty = False
saved = False

if exists:
    try:
        loaded = unreal.EditorAssetLibrary.load_asset(asset_path)
        pkg = loaded.get_outer() if loaded else None
        was_dirty = bool(pkg.is_dirty()) if pkg and hasattr(pkg, "is_dirty") else False
    except Exception:
        was_dirty = False
    saved = unreal.EditorAssetLibrary.save_asset(asset_path, only_if_is_dirty=False)

output_data = {"exists": exists, "saved": saved, "was_dirty": was_dirty}
`

  const result = await runEditorPython(script, `保存 ${contentPath}`)
  if (!result.success) {
    return { ok: false, exists: false, wasDirty: false, error: result.error }
  }

  const output = result.output || {}
  const exists = output.exists === true
  return {
    ok: !exists || output.saved === true,
    exists,
    wasDirty: output.was_dirty === true
  }
}

/**
 * 让引擎重新从磁盘加载这个包。
 *
 * 各版本的 API 名字不一样，这里逐个探：脚本会把**试过哪些、哪个成功**带回来，
 * 真机跑一次就知道 5.5 上该用哪个，不用靠猜。
 */
export async function reloadAssetInEditor(contentPath: string): Promise<{
  ok: boolean
  tried: string[]
  error?: string
}> {
  const script = `
asset_path = ${JSON.stringify(contentPath)}
tried = []
ok = False

if hasattr(unreal.EditorAssetLibrary, "reload_asset"):
    try:
        unreal.EditorAssetLibrary.reload_asset(asset_path)
        tried.append("EditorAssetLibrary.reload_asset:ok")
        ok = True
    except Exception as e:
        tried.append("EditorAssetLibrary.reload_asset:" + str(e))

if not ok and hasattr(unreal, "EditorLoadingAndSavingUtils"):
    try:
        pkg = unreal.load_package(asset_path)
        if pkg:
            unreal.EditorLoadingAndSavingUtils.reload_packages([pkg])
            tried.append("EditorLoadingAndSavingUtils.reload_packages:ok")
            ok = True
        else:
            tried.append("EditorLoadingAndSavingUtils.reload_packages:package-not-found")
    except Exception as e:
        tried.append("EditorLoadingAndSavingUtils.reload_packages:" + str(e))

output_data = {"ok": ok, "tried": tried}
`

  const result = await runEditorPython(script, `重载 ${contentPath}`)
  if (!result.success) {
    return { ok: false, tried: [], error: result.error }
  }

  const output = result.output || {}
  return {
    ok: output.ok === true,
    tried: Array.isArray(output.tried) ? (output.tried as string[]) : []
  }
}

/** 动手改之前，先把这个资产的当前状态存一份 */
export async function snapshotAsset(params: {
  projectDir: string
  sessionId: string
  contentPath: string
  maxBytes?: number
}): Promise<SnapshotOutcome> {
  const { projectDir, sessionId, contentPath } = params
  const maxBytes = params.maxBytes ?? DEFAULT_MAX_SNAPSHOT_BYTES

  const diskPath = contentPathToDiskPath(projectDir, contentPath)
  const stamp = Date.now()
  const snapshotPath = snapshotPathFor(projectDir, sessionId, contentPath, stamp)
  if (!diskPath || !snapshotPath) {
    return { ok: false, skipped: 'not-a-game-path', detail: contentPath }
  }

  // 先让引擎落盘，否则拷到的是更早的版本
  const saved = await saveAssetInEditor(contentPath)
  if (!saved.ok) {
    return { ok: false, skipped: 'save-failed', detail: saved.error }
  }

  if (!saved.exists) {
    // 资产还不存在：这一步是「新建」，回滚就是把新建出来的删掉
    return {
      ok: true,
      entry: {
        contentPath,
        diskPath,
        snapshotPath,
        kind: 'created',
        bytes: 0,
        at: stamp
      }
    }
  }

  try {
    const stat = await fs.stat(diskPath)
    if (stat.size > maxBytes) {
      return { ok: false, skipped: 'too-large', detail: `${stat.size} bytes` }
    }

    await fs.mkdir(path.dirname(snapshotPath), { recursive: true })
    await fs.copyFile(diskPath, snapshotPath)

    return {
      ok: true,
      entry: {
        contentPath,
        diskPath,
        snapshotPath,
        kind: 'modified',
        bytes: stat.size,
        at: stamp
      }
    }
  } catch (error) {
    return { ok: false, skipped: 'copy-failed', detail: String(error) }
  }
}

/** 把资产还原成快照时的样子，并让编辑器重新加载 */
export async function restoreAssetSnapshot(entry: AssetSnapshotEntry): Promise<{
  ok: boolean
  reloaded: boolean
  tried: string[]
  error?: string
}> {
  try {
    if (entry.kind === 'created') {
      await fs.rm(entry.diskPath, { force: true })
    } else {
      await fs.mkdir(path.dirname(entry.diskPath), { recursive: true })
      await fs.copyFile(entry.snapshotPath, entry.diskPath)
    }
  } catch (error) {
    return { ok: false, reloaded: false, tried: [], error: String(error) }
  }

  const reload = await reloadAssetInEditor(entry.contentPath)
  return { ok: true, reloaded: reload.ok, tried: reload.tried, error: reload.error }
}
