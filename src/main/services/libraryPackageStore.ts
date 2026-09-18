/**
 * 蓝图包 / 材质包在磁盘上的读写。
 *
 * 这一层不认识 Electron、不认识 VaultManager，只认「一个保管库根目录」。
 * 这样它能拿真实临时目录跑测试 —— 而这些函数里有 `rm -rf` 和 `rename`，
 * 正是最需要被真实测过的那类代码。
 *
 * ## 三道闸
 *
 * 每一个会动磁盘的入口都必须过：
 *   1. 路径落在保管库根目录**里面**（`isInsideDirectory`，不是裸 `startsWith`）；
 *   2. 目标不是保管库根目录本身；
 *   3. 目标目录名是**包名**（`xxx.ueblueprint` / `xxx.uematerial`）。
 *
 * 第 3 条是这里独有的护栏：路径从渲染进程传过来，算错或被构造出来的时候，
 * 它至少不可能指向一个普通目录。`rm -rf` 只可能落在包上。
 *
 * 教训来自 commit eb974c9 —— 那次路径塌缩成只剩一节，`rm -rf` 差点落到
 * 网络库根目录下的同名目录上。规则一样：**宁可不删，也不能删错。**
 */

import { constants, type Dirent } from 'fs'
import { access, mkdir, readdir, readFile, rename, rm, writeFile } from 'fs/promises'
import { basename, dirname, join, relative } from 'path'

import { isInsideDirectory } from '../utils/pathContainment'
import {
  MANIFEST_FORMAT_VERSION,
  getFormatTag,
  getManifestFileName,
  isSafeInPackagePath,
  parseManifest,
  parsePackageDirName,
  serializeManifest,
  uniquePackageDirName,
  type LibraryKind,
  type LibraryPackageManifest
} from '../utils/libraryPackage'

/**
 * 扫描时不进去的目录。
 *
 * `.thumbnails` / `.migration-backups` 是保管库自己的东西，
 * 点开头的其余目录（`.git`、`.svn`…）是用户放进来的，都不该被当成内容。
 */
const SKIPPED_DIR_PREFIX = '.'

/** 递归深度上限。防的是符号链接成环 —— 走不完的目录树会把主进程挂住。 */
const MAX_SCAN_DEPTH = 32

/**
 * 库级元信息的文件名：分组列表、迁移标记这类**不属于任何单个条目**的东西。
 *
 * 点开头，所以扫描器不会把它当资产索引，但它就在保管库目录里 ——
 * 用户拷走整个文件夹时它跟着走，分组不会丢。
 */
const META_FILE_NAME = '.library-meta.json'

/** 磁盘上找到的一个包 */
export interface LibraryPackageEntry {
  /** 包目录的绝对路径 */
  dirPath: string
  /** 相对保管库根目录的路径，用正斜杠。跨机器稳定，适合存进索引。 */
  relPath: string
  library: LibraryKind
  manifest: LibraryPackageManifest
}

/** 扫到了但读不了的包。不能默默跳过 —— 用户得知道哪个包坏了。 */
export interface LibraryPackageProblem {
  dirPath: string
  relPath: string
  reason: 'manifest-missing' | 'manifest-unreadable' | 'manifest-invalid'
}

export interface ScanResult {
  entries: LibraryPackageEntry[]
  problems: LibraryPackageProblem[]
}

/** 一律用正斜杠，免得同一个包在 Windows 和索引里长成两个样 */
function toRelPath(vaultRoot: string, target: string): string {
  return relative(vaultRoot, target).replace(/\\/g, '/')
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 三道闸。返回 null 表示不通过，调用方必须据此**跳过文件系统操作**。
 *
 * 故意返回 null 而不是抛：调用方大多在批处理里，一个坏路径不该掀翻整批。
 */
function resolveSafePackageDir(
  vaultRoot: string,
  dirPath: string
): { dirPath: string; library: LibraryKind } | null {
  if (!vaultRoot || !dirPath) return null
  if (!isInsideDirectory(dirPath, vaultRoot)) return null
  // 落在根目录里面 ✓，但它自己就是根目录 ✗ —— 那是整个保管库
  if (isInsideDirectory(vaultRoot, dirPath)) return null

  const parsed = parsePackageDirName(basename(dirPath))
  if (!parsed) return null

  return { dirPath, library: parsed.library }
}

/**
 * 走一遍保管库，把所有包找出来。
 *
 * 这就是「删掉数据库、重新扫一遍、用户的库完整回来」的那个实现 ——
 * 磁盘是唯一真相源，这个函数是从真相源重建索引的唯一入口。
 */
export async function scanPackages(vaultRoot: string): Promise<ScanResult> {
  const entries: LibraryPackageEntry[] = []
  const problems: LibraryPackageProblem[] = []
  if (!vaultRoot || !(await exists(vaultRoot))) return { entries, problems }

  const queue: Array<{ path: string; depth: number }> = [{ path: vaultRoot, depth: 0 }]

  while (queue.length > 0) {
    const { path: currentPath, depth } = queue.shift()!
    if (depth > MAX_SCAN_DEPTH) continue

    let items: Dirent[]
    try {
      items = await readdir(currentPath, { withFileTypes: true })
    } catch (error) {
      // 权限不足、目录正被占用 —— 跳过这一枝，别掀翻整次扫描
      console.warn(`[LibraryPackage] 目录读不了，跳过: ${currentPath}`, error)
      continue
    }

    for (const item of items) {
      if (!item.isDirectory()) continue
      if (item.name.startsWith(SKIPPED_DIR_PREFIX)) continue

      const fullPath = join(currentPath, item.name)
      const parsed = parsePackageDirName(item.name)

      if (!parsed) {
        // 普通目录，继续往下找
        queue.push({ path: fullPath, depth: depth + 1 })
        continue
      }

      // 是包 —— 读它的清单，**不再往里递归**。
      // 包里的 cover.png / textures/ 属于这个包，不是独立内容。
      const outcome = await readPackageAt(vaultRoot, fullPath, parsed.library)
      if ('reason' in outcome) problems.push(outcome)
      else entries.push(outcome)
    }
  }

  return { entries, problems }
}

/** 读一个已知路径的包。内部用，路径已经确认过是包。 */
async function readPackageAt(
  vaultRoot: string,
  dirPath: string,
  library: LibraryKind
): Promise<LibraryPackageEntry | LibraryPackageProblem> {
  const relPath = toRelPath(vaultRoot, dirPath)
  const manifestPath = join(dirPath, getManifestFileName(library))

  let text: string
  try {
    text = await readFile(manifestPath, 'utf-8')
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException)?.code === 'ENOENT'
    return { dirPath, relPath, reason: missing ? 'manifest-missing' : 'manifest-unreadable' }
  }

  const manifest = parseManifest(text, library)
  if (!manifest) return { dirPath, relPath, reason: 'manifest-invalid' }

  return { dirPath, relPath, library, manifest }
}

/** 读一个包。路径过不了三道闸就返回 null。 */
export async function readPackage(
  vaultRoot: string,
  dirPath: string
): Promise<LibraryPackageEntry | LibraryPackageProblem | null> {
  const safe = resolveSafePackageDir(vaultRoot, dirPath)
  if (!safe) return null
  return readPackageAt(vaultRoot, safe.dirPath, safe.library)
}

/**
 * 原子写清单：先写同目录下的临时文件，再 rename 盖上去。
 *
 * 清单现在是唯一真相源。直接 `writeFile` 的话，写到一半崩溃 / 断电就留下
 * 半截 JSON —— 那不是「这次没存上」，是「这个条目没了」。
 * rename 在同一分区上是原子的，读到的要么是旧的完整清单，要么是新的。
 */
async function writeManifestAtomic(
  dirPath: string,
  library: LibraryKind,
  manifest: LibraryPackageManifest
): Promise<void> {
  const target = join(dirPath, getManifestFileName(library))
  const temp = `${target}.tmp`
  await writeFile(temp, serializeManifest(manifest), 'utf-8')
  await rename(temp, target)
}

export interface CreatePackageOptions {
  library: LibraryKind
  /** 条目 ID，调用方生成，改名不变 */
  id: string
  /** 显示名。目录名由它洗出来，重名时自动加 `(2)`。 */
  name: string
  /** 领域数据，这一层不解释 */
  payload: unknown
  /** 当前时间戳，由调用方传入（这一层不读时钟，方便测） */
  now: number
  /** 放在保管库里的哪个子目录；不传就放根目录 */
  parentRelPath?: string
}

/**
 * 新建一个包。
 *
 * @returns 建好的包；父目录越界时返回 null
 */
export async function createPackage(
  vaultRoot: string,
  options: CreatePackageOptions
): Promise<LibraryPackageEntry | null> {
  const parentDir = options.parentRelPath ? join(vaultRoot, options.parentRelPath) : vaultRoot
  // 父目录也是渲染进程传来的，同样不能越界
  if (!isInsideDirectory(parentDir, vaultRoot)) return null

  await mkdir(parentDir, { recursive: true })

  let taken: string[] = []
  try {
    taken = (await readdir(parentDir, { withFileTypes: true }))
      .filter((item) => item.isDirectory())
      .map((item) => item.name)
  } catch {
    // 目录刚建出来还读不到就当空的：顶多是名字没加上 (2)，下面 mkdir 会失败兜住
  }

  const dirName = uniquePackageDirName(options.library, options.name, taken)
  const dirPath = join(parentDir, dirName)
  await mkdir(dirPath)

  const manifest: LibraryPackageManifest = {
    format: getFormatTag(options.library),
    formatVersion: MANIFEST_FORMAT_VERSION,
    id: options.id,
    name: options.name,
    createdAt: options.now,
    updatedAt: options.now,
    cover: '',
    payload: options.payload
  }

  await writeManifestAtomic(dirPath, options.library, manifest)

  return { dirPath, relPath: toRelPath(vaultRoot, dirPath), library: options.library, manifest }
}

/**
 * 覆盖一个包的清单。
 *
 * 不动目录名 —— 改名是 {@link renamePackage} 的事，两件事分开做，
 * 免得一次操作里既要改内容又要移动目录，中间崩了留下对不上的状态。
 *
 * @returns 成功返回更新后的清单；路径过不了闸返回 null
 */
export async function updatePackage(
  vaultRoot: string,
  dirPath: string,
  patch: { name?: string; payload?: unknown; cover?: string; now: number }
): Promise<LibraryPackageEntry | null> {
  const safe = resolveSafePackageDir(vaultRoot, dirPath)
  if (!safe) return null

  const current = await readPackageAt(vaultRoot, safe.dirPath, safe.library)
  if ('reason' in current) return null

  if (patch.cover !== undefined && patch.cover !== '' && !isSafeInPackagePath(patch.cover)) {
    return null
  }

  const manifest: LibraryPackageManifest = {
    ...current.manifest,
    name: patch.name?.trim() || current.manifest.name,
    payload: patch.payload !== undefined ? patch.payload : current.manifest.payload,
    cover: patch.cover !== undefined ? patch.cover : current.manifest.cover,
    updatedAt: patch.now
  }

  await writeManifestAtomic(safe.dirPath, safe.library, manifest)

  return { dirPath: safe.dirPath, relPath: current.relPath, library: safe.library, manifest }
}

/**
 * 改名 = 移动目录 + 改清单里的 name。
 *
 * @returns 改完的包；过不了闸、或新名字已被占用时返回 null
 */
export async function renamePackage(
  vaultRoot: string,
  dirPath: string,
  newName: string,
  now: number
): Promise<LibraryPackageEntry | null> {
  const safe = resolveSafePackageDir(vaultRoot, dirPath)
  if (!safe) return null
  if (!(await exists(safe.dirPath))) return null

  const parentDir = dirname(safe.dirPath)
  const currentDirName = basename(safe.dirPath)

  let siblings: string[] = []
  try {
    siblings = (await readdir(parentDir, { withFileTypes: true }))
      .filter((item) => item.isDirectory() && item.name !== currentDirName)
      .map((item) => item.name)
  } catch {
    return null
  }

  const nextDirName = uniquePackageDirName(safe.library, newName, siblings)
  const nextPath = join(parentDir, nextDirName)

  if (nextDirName !== currentDirName) {
    // 纵深防御：拼出来的新路径也得在保管库里
    if (!isInsideDirectory(nextPath, vaultRoot)) return null
    await rename(safe.dirPath, nextPath)
  }

  return updatePackage(vaultRoot, nextPath, { name: newName, now })
}

/**
 * 删一个包（递归删目录）。
 *
 * 三道闸都过了才动手，所以这里的 `rm -rf` 只可能落在一个包目录上：
 * 落在保管库里面、不是保管库本身、目录名是 `xxx.ueblueprint` / `xxx.uematerial`。
 *
 * @returns 真的删了返回 true；过不了闸或本来就不存在返回 false
 */
export async function deletePackage(vaultRoot: string, dirPath: string): Promise<boolean> {
  const safe = resolveSafePackageDir(vaultRoot, dirPath)
  if (!safe) {
    console.warn(`[LibraryPackage] 路径过不了安全检查，拒绝删除: ${dirPath}`)
    return false
  }
  if (!(await exists(safe.dirPath))) return false

  await rm(safe.dirPath, { recursive: true, force: true })
  return true
}

/**
 * 往包里写一个文件（封面、贴图…）。
 *
 * @param relPath 包内相对路径，如 `cover.png`、`textures/moss.png`
 * @returns 写成功返回 true
 */
export async function writePackageFile(
  vaultRoot: string,
  dirPath: string,
  relPath: string,
  data: Buffer
): Promise<boolean> {
  const safe = resolveSafePackageDir(vaultRoot, dirPath)
  if (!safe) return false
  if (!isSafeInPackagePath(relPath)) return false

  const target = join(safe.dirPath, relPath)
  // 纵深防御：`isSafeInPackagePath` 已经拦过，拼完再确认一次落点还在包里
  if (!isInsideDirectory(target, safe.dirPath)) return false

  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, data)
  return true
}

/**
 * 读库级元信息（分组列表、迁移标记）。没有这份文件时返回 null。
 *
 * 返回原始文本，不解析 —— 它的结构归渲染层的持久化层管，这里只负责搬字节。
 */
export async function readLibraryMeta(vaultRoot: string): Promise<string | null> {
  if (!vaultRoot) return null
  try {
    return await readFile(join(vaultRoot, META_FILE_NAME), 'utf-8')
  } catch {
    return null
  }
}

/**
 * 写库级元信息。同样先写临时文件再 rename —— 分组列表整份被覆盖，
 * 写到一半崩溃就是「所有分组没了」。
 */
export async function writeLibraryMeta(vaultRoot: string, text: string): Promise<boolean> {
  if (!vaultRoot) return false
  const target = join(vaultRoot, META_FILE_NAME)
  const temp = `${target}.tmp`
  await mkdir(vaultRoot, { recursive: true })
  await writeFile(temp, text, 'utf-8')
  await rename(temp, target)
  return true
}

/** 读包里的一个文件。过不了闸或不存在返回 null。 */
export async function readPackageFile(
  vaultRoot: string,
  dirPath: string,
  relPath: string
): Promise<Buffer | null> {
  const safe = resolveSafePackageDir(vaultRoot, dirPath)
  if (!safe) return null
  if (!isSafeInPackagePath(relPath)) return null

  const target = join(safe.dirPath, relPath)
  if (!isInsideDirectory(target, safe.dirPath)) return null

  try {
    return await readFile(target)
  } catch {
    return null
  }
}
