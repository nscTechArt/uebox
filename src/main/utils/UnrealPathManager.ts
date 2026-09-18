import * as path from 'path'
import * as fs from 'fs'
import * as fse from 'fs-extra'
import AdmZip from 'adm-zip'
import { app } from 'electron'
import { exec } from 'child_process'
import { registeredMacEngineRoots, resolveMacEngineAssociation } from './macEngineInstallations'
import { readUeJsonFile, readUeTextFile } from './ueTextFile'
import { getPublicDatabase } from '../sqliteDataBase'
import {
  discoverMacEngineRoots,
  normalizeEngineRoot,
  readEngineBuildVersion,
  resolveEngineExecutable
} from './unrealEnginePlatform'
import {
  addCustomEngine,
  getAllCustomEngines,
  removeCustomEngine
} from '../sqliteDataBase/models/customEngine'

//缓存engines
interface EngineInfo {
  name: string
  rootPath: string
  appVersion: string
  version: string
  pluginPath: string
  enginePath: string
}

interface InvalidCustomEngineInfo {
  name: string
  rootPath: string
  version: string
}

interface EnginePluginCleanupFailure {
  engineName: string
  engineRootPath: string
  error: string
}

interface EnginePluginCleanupSummary {
  scannedEngineCount: number
  cleanedEngineCount: number
  skippedEngineCount: number
  failedEngines: EnginePluginCleanupFailure[]
}

let cacheEngines: EngineInfo[] = []

/** 插件包里的源码指纹标记，由 `scripts/build-plugin.mjs` 写入 */
const PLUGIN_STAMP_FILE = '.ual-build'

/** 随包 zip 的指纹在应用生命周期内不会变，读一次就够（zip 有 ~2MB） */
const bundledFingerprintCache = new Map<string, string | null>()

/**
 * Epic Launcher 的两份安装记录。
 *
 * `LauncherInstalled.dat` 是一份汇总文件，只在启动器认为「该重写了」的时候整体重写；
 * `Data/Manifests/*.item` 是每个安装项各自一份，装完当场就落盘。
 *
 * 只读汇总文件会漏掉刚装好的引擎 —— 实际踩过：UE 5.8 在 11:59 装完，
 * 而汇总文件停在 11:51，界面上刷新多少次都出不来 5.8，但 manifest 里早有了。
 * 所以两份都读，manifest 优先。
 */
const LAUNCHER_INSTALLED_DAT = path.join(
  'C:',
  'ProgramData',
  'Epic',
  'UnrealEngineLauncher',
  'LauncherInstalled.dat'
)
const LAUNCHER_MANIFEST_DIR = path.join(
  'C:',
  'ProgramData',
  'Epic',
  'EpicGamesLauncher',
  'Data',
  'Manifests'
)

/** 引擎本体的条目名，形如 UE_5.8；插件、Twinmotion 等同目录条目不匹配 */
const ENGINE_APP_NAME = /^UE_\d+\.\d+$/

/**
 * 这条路径是不是一条符号链接 / 目录联接？是就返回它指向的位置，否则返回 null。
 *
 * Windows 的 junction 在 Node 里同样报 `isSymbolicLink() === true`（`isDirectory()` 是 false）。
 *
 * **为什么每个会删、会盖插件目录的地方都得先过这一关**：开发机上宿主工程的
 * `Plugins/UnrealAgentLink` 一般是指向本仓库的目录联接（`plugin/UnrealAgentLink/DEVELOPING.md`
 * 就是这么教的）。`fse.emptyDir` 会**顺着联接进到目标目录**去清空 —— 实测触发过两次，
 * 两次都把仓库里 `plugin/UnrealAgentLink/` 的一百多个文件连同未提交的改动一起删光。
 * （`fse.remove` 实测只摘链接、不进目标，但摘掉联接本身同样会毁掉开发机的接线。）
 */
async function readLinkTarget(targetPath: string): Promise<string | null> {
  try {
    const stats = await fs.promises.lstat(targetPath)
    if (!stats.isSymbolicLink()) return null
    return await fs.promises.readlink(targetPath).catch(() => targetPath)
  } catch {
    // 不存在、读不了：不是联接，交给后面的流程照常处理
    return null
  }
}

function toEngineInfo(appName: string, installLocation: string, appVersion: string): EngineInfo {
  return {
    name: appName,
    rootPath: installLocation,
    appVersion,
    version: appName.replace('UE_', ''),
    pluginPath: path.join(installLocation, 'Engine', 'Plugins'),
    enginePath: path.join(
      installLocation,
      'Engine',
      'Binaries',
      'Win64',
      appName.startsWith('UE_5.') ? 'UnrealEditor.exe' : 'UE4Editor.exe'
    )
  }
}

/**
 * 解析 LauncherInstalled.dat 的内容。
 *
 * 这里按 `ArtifactId` 过滤而不是 `AppName`：同一份清单里 `QuixelBridge_5.5`
 * 之类的插件条目 InstallLocation 指向的也是引擎目录，只看路径会重复。
 */
export function parseLauncherInstalledDat(raw: string): EngineInfo[] {
  const parsed = JSON.parse(raw) as {
    InstallationList?: Array<{
      ArtifactId?: string
      AppName?: string
      AppVersion?: string
      InstallLocation?: string
    }>
  }
  const engines: EngineInfo[] = []
  for (const install of parsed.InstallationList ?? []) {
    if (!ENGINE_APP_NAME.test(install.ArtifactId ?? '')) continue
    if (!install.AppName || !install.InstallLocation) continue
    engines.push(toEngineInfo(install.AppName, install.InstallLocation, install.AppVersion ?? ''))
  }
  return engines
}

/**
 * 解析单个 `Data/Manifests/*.item`。
 *
 * 不是引擎本体、装了一半（`bIsIncompleteInstall`）的条目返回 null —— 装了一半的
 * 目录里可执行文件可能已经存在，光靠后面的文件存在性检查挡不住。
 */
export function parseEngineManifest(raw: string): EngineInfo | null {
  const parsed = JSON.parse(raw) as {
    AppName?: string
    AppVersionString?: string
    InstallLocation?: string
    bIsIncompleteInstall?: boolean
  }
  if (!ENGINE_APP_NAME.test(parsed.AppName ?? '')) return null
  if (!parsed.InstallLocation) return null
  if (parsed.bIsIncompleteInstall === true) return null
  return toEngineInfo(parsed.AppName!, parsed.InstallLocation, parsed.AppVersionString ?? '')
}

/** 同一个引擎会同时出现在两份记录里，按安装路径去重，靠前的优先 */
function engineRootKey(root: string, platform: NodeJS.Platform): string {
  if (platform !== 'darwin') return root.toLowerCase()
  try {
    // 必须是 .native：JS 版只解软链接，大小写照抄调用方写的，
    // 同一个引擎写成 /users/shared/... 和 /Users/Shared/... 就会各算一份。
    return fs.realpathSync.native(root)
  } catch {
    return path.normalize(root)
  }
}

export function dedupeEnginesByRootPath(
  engines: EngineInfo[],
  platform: NodeJS.Platform = process.platform
): EngineInfo[] {
  const seen = new Set<string>()
  const unique: EngineInfo[] = []
  for (const engine of engines) {
    const key = engineRootKey(engine.rootPath, platform)
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(engine)
  }
  return unique
}

/**
 * 一个来源读回来的东西，外加**这次读成没读成**。
 *
 * 「读成了，一个都没有」和「压根没读到」必须分开：前者是用户真的没装引擎，
 * 后者只是这一趟没成。以前两种都落成 `[]`，于是界面对着装了四个引擎的用户
 * 说「没有找到已安装的虚幻引擎」，Agent 更是直接告诉模型这台机器没有引擎。
 */
type SourceRead = { engines: EngineInfo[]; ok: boolean }

/** 文件/目录不存在 = 没装启动器，这是「真的没有」，不算读失败 */
function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT'
}

async function readEnginesFromInstalledDat(): Promise<SourceRead> {
  try {
    const raw = await readUeTextFile(LAUNCHER_INSTALLED_DAT)
    return { engines: parseLauncherInstalledDat(raw), ok: true }
  } catch (err) {
    console.warn('[UnrealPathManager] 读取 LauncherInstalled.dat 失败:', err)
    return { engines: [], ok: isMissing(err) }
  }
}

async function readEnginesFromManifests(): Promise<SourceRead> {
  let entries: string[]
  try {
    entries = await fs.promises.readdir(LAUNCHER_MANIFEST_DIR)
  } catch (err) {
    console.warn('[UnrealPathManager] 读取 Epic manifest 目录失败:', err)
    return { engines: [], ok: isMissing(err) }
  }

  const engines: EngineInfo[] = []
  let ok = true
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith('.item')) continue
    try {
      const raw = await readUeTextFile(path.join(LAUNCHER_MANIFEST_DIR, entry))
      const engine = parseEngineManifest(raw)
      if (engine) engines.push(engine)
    } catch (err) {
      // 单个 manifest 读不了不该让整次扫描失败，跳过继续 —— 但它可能正是某个
      // 引擎的那一份，所以这一趟不能再自称「读全了」
      console.warn(`[UnrealPathManager] 读取 manifest ${entry} 失败:`, err)
      ok = false
    }
  }
  return { engines, ok }
}

async function readMacEngines(): Promise<EngineInfo[]> {
  const engines: EngineInfo[] = []
  const [registered, shared] = await Promise.all([
    registeredMacEngineRoots(app.getPath('home')),
    discoverMacEngineRoots()
  ])
  for (const rootPath of new Set([...registered, ...shared])) {
    const appVersion = await readEngineBuildVersion(rootPath)
    if (!appVersion) continue
    // Launcher associations use major.minor; keep the patch in appVersion.
    const version = appVersion.split('.').slice(0, 2).join('.')
    const enginePath = await resolveEngineExecutable(rootPath)
    if (!enginePath) continue
    engines.push({
      name: `UE_${version}`,
      rootPath,
      version,
      appVersion,
      pluginPath: path.join(rootPath, 'Engine', 'Plugins'),
      enginePath
    })
  }
  return engines
}

async function filterExistingEngines(engines: EngineInfo[]): Promise<EngineInfo[]> {
  const valid: EngineInfo[] = []
  for (const engine of engines) {
    const enginePath = await resolveEngineExecutable(engine.rootPath)
    if (!enginePath) {
      console.warn(
        `[UnrealPathManager] Skip missing engine executable: ${engine.name || engine.rootPath}`
      )
      continue
    }
    valid.push({ ...engine, enginePath })
  }
  return valid
}

const UnrealPathManagerUtil = {
  async findUnrealEnginePaths(): Promise<EngineInfo[]> {
    return (await this.scanEngines()).engines
  },

  /**
   * 扫描引擎，并**如实说出这次读成没读成**。
   *
   * `degraded: true` = 这一趟有来源没读到，`engines` 是能给多少给多少（通常是
   * 上一次的缓存）。调用方据此把「真的一个都没装」和「这次没读出来」分开说 ——
   * 前者该引导用户去装，后者只该说读失败：首页曾经对着装了四个引擎的用户说
   * 「没有找到已安装的虚幻引擎」，还顺手删掉他存的默认引擎。
   *
   * **降级判定来自各个来源自己**（`SourceRead.ok`），不是靠捕获异常 ——
   * 那两个读函数早就把自己的异常吞掉了，等在这里 catch 是等不到的。
   */
  async scanEngines(): Promise<{ engines: EngineInfo[]; degraded: boolean }> {
    try {
      return await this.collectEngines()
    } catch (err) {
      console.error('读取或处理虚幻引擎安装信息时发生错误:', err)
      const fallback = await filterExistingEngines(cacheEngines)
      cacheEngines = fallback
      return { engines: fallback, degraded: true }
    }
  },

  /** 真正干活的那段。不吞自己的异常 —— 吞不吞由 `scanEngines()` 决定 */
  async collectEngines(): Promise<{ engines: EngineInfo[]; degraded: boolean }> {
    // manifest 排在前面：它落盘更早，同一个引擎两边都有时以它为准
    const [manifest, dat] =
      process.platform === 'darwin'
        ? // ponytail: macOS 那条路的几个 helper 也各自吞异常，报不出 degraded。
          // 要补就得改 macEngineInstallations / unrealEnginePlatform，另开一批。
          [
            { engines: await readMacEngines(), ok: true },
            { engines: [], ok: true }
          ]
        : await Promise.all([readEnginesFromManifests(), readEnginesFromInstalledDat()])

    const degraded = !manifest.ok || !dat.ok
    const discovered = dedupeEnginesByRootPath([...manifest.engines, ...dat.engines])

    const existingEngines = await filterExistingEngines(discovered)

    // 合并数据库中持久化的自定义引擎
    const allEngines = await this.mergeCustomEngines(existingEngines)

    // 按版本号从新到旧排。用 compareVersions 而不是字符串比较：
    // localeCompare 会把 5.9 排在 5.10 前面
    allEngines.sort((a, b) => this.compareVersions(b.version, a.version))

    if (allEngines.length === 0 && cacheEngines.length > 0) {
      // 一个都没读出来但缓存里有：保留上次结果，别把界面上已有的引擎清空
      const fallback = await filterExistingEngines(cacheEngines)
      cacheEngines = fallback
      return { engines: fallback, degraded }
    }

    cacheEngines = allEngines
    return { engines: allEngines, degraded }
  },
  /**
   * 通过自定义路径添加 Unreal 引擎信息
   * @param customPath 自定义引擎根路径或路径数组（取第一个）
   * @returns 解析后的引擎信息，未找到则返回 null
   */
  async addCustomPath(customPath: string | string[]): Promise<EngineInfo | null> {
    // 解析路径参数，支持数组类型
    const resolvedPath = normalizeEngineRoot(
      (Array.isArray(customPath) ? customPath[0] : customPath) || ''
    )

    // 自动发现和手动添加使用相同的平台路径校验。
    const enginePath = await resolveEngineExecutable(resolvedPath)

    if (!enginePath) {
      console.error(`未找到虚幻引擎启动程序，搜索根目录：${resolvedPath}`)
      return null
    }

    try {
      // 优先从 Build.version 文件读取版本号（无外部命令依赖，最可靠）
      let version = await readEngineBuildVersion(resolvedPath)

      // 回退：通过可执行文件获取版本号
      if (!version && process.platform === 'win32') {
        version = await this.getExeVersion(enginePath)
        version = version.split('.').slice(0, 3).join('.')
      }
      if (!version) return null

      const engineInfo: EngineInfo = {
        name: `UE_${version}`,
        rootPath: resolvedPath,
        appVersion: version,
        version,
        pluginPath: path.join(resolvedPath, 'Engine', 'Plugins'),
        enginePath
      }

      // 持久化到数据库
      try {
        const db = getPublicDatabase()
        addCustomEngine(db, {
          rootPath: resolvedPath,
          name: engineInfo.name,
          version: engineInfo.version
        })
        console.log(`[UnrealPathManager] 自定义引擎已保存到数据库: ${resolvedPath}`)
      } catch (dbErr) {
        console.warn('[UnrealPathManager] 保存自定义引擎到数据库失败:', dbErr)
      }

      return engineInfo
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      console.error(`版本信息获取失败 [${enginePath}]: ${msg}`)
      return null
    }
  },
  /**
   * 从数据库中合并自定义引擎到引擎列表
   * @param epicEngines Epic Launcher 扫描到的引擎列表
   * @returns 合并后的完整引擎列表
   */
  async mergeCustomEngines(epicEngines: EngineInfo[]): Promise<EngineInfo[]> {
    try {
      const db = getPublicDatabase()
      const customRecords = getAllCustomEngines(db)

      if (customRecords.length === 0) return epicEngines

      const merged = [...epicEngines]
      const existingPaths = new Set(
        epicEngines.map((e) => engineRootKey(e.rootPath, process.platform))
      )

      for (const record of customRecords) {
        // 避免与 Epic Launcher 引擎重复
        const key = engineRootKey(record.rootPath, process.platform)
        if (existingPaths.has(key)) continue

        // 验证引擎可执行文件是否仍存在
        const enginePath = await resolveEngineExecutable(record.rootPath)
        if (!enginePath) {
          console.warn(`[UnrealPathManager] 自定义引擎路径已失效，跳过: ${record.rootPath}`)
          continue
        }

        merged.push({
          name: record.name,
          rootPath: record.rootPath,
          appVersion: record.version,
          version: record.version,
          pluginPath: path.join(record.rootPath, 'Engine', 'Plugins'),
          enginePath
        })
        existingPaths.add(key)
      }

      return merged
    } catch (err) {
      console.warn('[UnrealPathManager] 合并自定义引擎失败:', err)
      return epicEngines
    }
  },
  /**
   * Inspect persisted custom engine records and return entries whose executables no longer exist.
   */
  async inspectInvalidCustomEngines(): Promise<InvalidCustomEngineInfo[]> {
    try {
      const db = getPublicDatabase()
      const customRecords = getAllCustomEngines(db)
      const invalidRecords: InvalidCustomEngineInfo[] = []

      for (const record of customRecords) {
        const enginePath = await resolveEngineExecutable(record.rootPath)
        if (enginePath) continue

        invalidRecords.push({
          name: record.name,
          rootPath: record.rootPath,
          version: record.version
        })
      }

      return invalidRecords
    } catch (err) {
      console.warn('[UnrealPathManager] 检查失效自定义引擎失败:', err)
      return []
    }
  },
  /**
   * 从数据库中移除自定义引擎记录
   * @param rootPath 引擎根路径
   * @returns 是否成功移除
   */
  removeCustomPath(rootPath: string): boolean {
    try {
      const db = getPublicDatabase()
      removeCustomEngine(db, rootPath)
      console.log(`[UnrealPathManager] 已从数据库删除自定义引擎: ${rootPath}`)
      return true
    } catch (err) {
      console.warn('[UnrealPathManager] 删除自定义引擎失败:', err)
      return false
    }
  },
  /**
   * 读取可执行文件的版本号（Windows）
   * 优先使用 PowerShell（兼容 Windows 11+），wmic 已在新版 Windows 中被弃用/移除
   * @param filePath 可执行文件绝对路径
   * @returns 版本号字符串
   */
  getExeVersion(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      // 优先使用 PowerShell 获取版本号（兼容 Windows 11+ 无 wmic 的情况）
      const psCommand = `powershell -NoProfile -Command "(Get-Item '${filePath.replace(/'/g, "''")}').VersionInfo.FileVersion"`
      exec(psCommand, (psError, psStdout) => {
        if (!psError && psStdout.trim()) {
          resolve(psStdout.trim())
          return
        }
        // PowerShell 失败时回退到 wmic（兼容旧版 Windows）
        exec(
          `wmic datafile where name="${filePath.replace(/\\/g, '\\\\')}" get Version /value`,
          (wmicError, wmicStdout) => {
            if (wmicError) {
              reject(
                new Error(
                  `版本号获取失败（PowerShell 和 wmic 均失败）: PS=${psError?.message || 'unknown'}, WMIC=${wmicError.message}`
                )
              )
              return
            }
            const versionMatch = wmicStdout.match(/Version=(.*)/)
            if (versionMatch) {
              resolve(versionMatch[1].trim())
            } else {
              reject(new Error('Version not found in wmic output'))
            }
          }
        )
      })
    })
  },
  /**
   * 版本号比较工具函数
   * @param a 版本 A（字符串或数字）
   * @param b 版本 B（字符串或数字）
   * @returns -1 表示 a<b；0 表示相等；1 表示 a>b
   */
  compareVersions(a: string | number, b: string | number): number {
    // 清理非数字前缀（如"v1.0" -> "1.0"）
    const normalize = (v) => String(v).replace(/^[^\d]*/, '')

    const aParts = normalize(a).split('.').map(Number)
    const bParts = normalize(b).split('.').map(Number)

    const maxLength = Math.max(aParts.length, bParts.length)
    for (let i = 0; i < maxLength; i++) {
      const aVal = aParts[i] || 0
      const bVal = bParts[i] || 0
      if (aVal < bVal) return -1
      if (aVal > bVal) return 1
    }
    return 0
  },
  /**
   * 将 UALink 插件安装到项目的 Plugins 目录（项目级安装）
   * 与引擎级安装不同，项目级安装不会触发 UE5Rules.dll 缓存问题
   * 因为项目级模块规则每次构建都会重新编译
   * @param projectDir 项目根目录（.uproject 所在目录）
   * @param engineVersion 引擎版本（如 5.4）
   * @returns 安装结果
   */
  async installPluginToProject(
    projectDir: string,
    engineVersion: string
  ): Promise<{ success: boolean; code?: string }> {
    console.log('[UALink] 项目级安装开始:', projectDir, engineVersion)
    let targetPath = ''

    try {
      if (!projectDir || !engineVersion) throw new Error('INVALID_PARAMETERS')

      const pluginZip = this.getBundledPluginZipPath(engineVersion)

      // 支持哪些版本 = 我们随包发了哪几个 zip。
      // 这里原本还另有一份写死的版本白名单，结果 UE 5.8 出来时白名单没跟上，
      // 明明 zip 已经发了却报「不支持的版本」。一处判断就不会再漂
      //
      // 2026-09-03 起 zip 不再进 git（派生产物，见根目录 .gitignore），
      // 所以「包不存在」多了一种成因：**开发时没出过包**。
      // 安装包里缺包是发版事故，开发机上缺包只是少跑一条命令 ——
      // 两者给同一句「插件包不存在」，开发者会去查一个不存在的事故。
      if (!(await fse.pathExists(pluginZip))) {
        const hint = app.isPackaged
          ? '插件包不存在（安装包内缺少该引擎版本的插件，请反馈给我们）'
          : `插件包不存在：${pluginZip}。开发环境需要先出包：pnpm plugin:build --engine ${engineVersion}`
        console.error('[UALink]', hint)
        return { success: false, code: hint }
      }

      // 目标：项目目录/Plugins/UnrealAgentLink
      const pluginsDir = path.join(projectDir, 'Plugins')
      targetPath = path.join(pluginsDir, 'UnrealAgentLink')

      // 目标是开发用联接时**在这里就返回**，一步也别往下走。
      // 下面 emptyDir 会穿过联接清空仓库源码，copy 又会把联接换成真实目录 ——
      // 这道门放在最前面，后面新加的写操作也就不用各自记得防一次（见 readLinkTarget）
      const devLinkTarget = await readLinkTarget(targetPath)
      if (devLinkTarget) {
        console.log(`[UALink] ${targetPath} 是开发用目录联接，指向 ${devLinkTarget}，跳过覆盖安装`)
        return { success: true, code: 'DEV_SYMLINK_SKIPPED' }
      }

      // 检查是否已安装且和随包的那一份一致
      const upluginPath = path.join(targetPath, 'UnrealAgentLink.uplugin')
      if (await fse.pathExists(upluginPath)) {
        if (await this.isProjectPluginUpToDate(targetPath, engineVersion)) {
          console.log('[UALink] 项目级插件已是最新版本，跳过安装')
          return { success: true, code: 'ALREADY_INSTALLED' }
        }
      }

      /**
       * 铺新的，再换掉旧的 —— 顺序不能反。
       *
       * 这里原本是「先 emptyDir 清空目标目录，再打开 zip 解压」。旧插件在新插件连打开
       * 都还没打开的时候就已经没了，于是任何一步失败都让用户的工程失去插件：
       * 编辑器开着（DLL 被占用，删一半剩个空壳）、zip 损坏、磁盘写满、解压中途断电。
       * 而 `.uproject` 里的引用还在，下次打开工程就是
       * `Unable to find plugin 'UnrealAgentLink'`，C++ 工程连解决方案都生成不了。
       *
       * 现在的顺序：解压到暂存目录 → 校验 `.uplugin` 在不在 → 把旧目录改名让开
       * → 暂存目录改名到位 → 收尾删旧的。前三步任意一步失败，旧插件原封不动。
       *
       * 「改名让开」这一步在 Windows 上还顺带兜住了编辑器开着的情况：目录里有被加载的
       * DLL 时改名会失败，于是我们停在这里、旧插件完好，而不是把它删成半截。
       *
       * ## 暂存和退休目录都必须在 `Plugins/` **之外**
       *
       * 它们内部各有一份完整的 `UnrealAgentLink.uplugin`。留在 `Plugins/` 下面的话，
       * 引擎扫描时会在同一个工程里发现两个同名插件 —— `FPluginManager::CreatePluginObject`
       * 打一条 `Plugin 'X' exists at 'A' and 'B' - second location will be ignored`，
       * 两份都是 `EPluginType::Project`，**谁先扫到谁生效，顺序不保证**。
       * 于是清理失败（编辑器占着 DLL，正是下面 finally 预期的情况）或者进程崩在
       * 解压与改名之间时，用户升级完可能仍在跑旧插件，而盒子这边判定「已是最新」
       * 不再重装 —— 一个不会报错、也不会自愈的状态。
       *
       * 放 `Intermediate/`：和 `Plugins/` 同一个卷（`fse.move` 才是改名而不是复制），
       * 引擎不扫这里，而且它本来就是可删的派生物目录。
       */
      const scratchDir = path.join(projectDir, 'Intermediate', 'UnrealBox')
      const stagingPath = path.join(scratchDir, `_ualink_staging_${process.pid}`)
      const retiredPath = path.join(scratchDir, `_ualink_old_${Date.now()}`)
      let retired = false

      try {
        await fse.ensureDir(scratchDir)
        // `Plugins/` 以前是被 staging 顺带建出来的；staging 搬走之后要自己建，
        // 否则第一次装插件的工程在最后那次 move 之前没有落脚点
        await fse.ensureDir(pluginsDir)
        await fse.remove(stagingPath).catch(() => {})
        await fse.ensureDir(stagingPath)

        // 解压到暂存目录。zip 打不开、内容不全，都在这一步暴露，此时旧插件还没动过
        new AdmZip(pluginZip).extractAllTo(stagingPath, true)

        // zip 里可能多包一层同名目录，两种形态都认
        const nestedPath = path.join(stagingPath, 'UnrealAgentLink')
        const newPluginRoot = (await fse.pathExists(
          path.join(nestedPath, 'UnrealAgentLink.uplugin')
        ))
          ? nestedPath
          : stagingPath

        // 校验：新的这份是完整的吗。不完整就当这次升级没发生过
        await fse.access(path.join(newPluginRoot, 'UnrealAgentLink.uplugin'), fs.constants.R_OK)

        // 旧目录改名让开。改不动（编辑器占着）就停在这里，旧插件完好
        if (await fse.pathExists(targetPath)) {
          try {
            await fse.move(targetPath, retiredPath)
            retired = true
          } catch (moveErr) {
            const reason = moveErr instanceof Error ? moveErr.message : String(moveErr)
            console.warn('[UALink] 旧插件目录腾不开，保留原样不升级:', targetPath, reason)
            return { success: false, code: `PLUGIN_DIR_BUSY: ${reason}` }
          }
        }

        try {
          await fse.move(newPluginRoot, targetPath)
        } catch (moveErr) {
          // 新的没搬进去，把旧的搬回来 —— 宁可停在旧版本，也不能留下一个空位置
          if (retired) {
            await fse.move(retiredPath, targetPath).catch((restoreErr) => {
              console.error('[UALink] 回滚失败，旧插件留在:', retiredPath, restoreErr)
            })
            retired = false
          }
          throw moveErr
        }

        console.log('[UALink] 项目级安装成功:', targetPath)
        return { success: true }
      } finally {
        await fse.remove(stagingPath).catch(() => {})
        if (retired) {
          // 旧的已经被新的顶替掉了。删不掉也只是在 `Intermediate/` 里留点垃圾 ——
          // 引擎不扫那里，所以不会和新装的那份撞成「两个同名插件」（正是把这两个
          // 目录挪出 `Plugins/` 的原因）。下次升级的 remove 或者用户清 Intermediate
          // 都会带走它
          await fse.remove(retiredPath).catch((err) => {
            console.warn('[UALink] 旧插件目录清理失败（不影响使用）:', retiredPath, err)
          })
        }
      }
    } catch (error) {
      // 到这里说明新插件没能就位。**不删 targetPath** —— 上面的流程保证它要么是完好的
      // 旧版本、要么根本不存在，删它只会把「升级失败」变成「插件没了」
      console.error('[UALink] 项目级安装失败:', error)
      return { success: false, code: error instanceof Error ? error.message : String(error) }
    }
  },
  /**
   * 随包插件 zip 的绝对路径。版本格式 5.4 → `UnrealAgentLink54.zip`
   */
  getBundledPluginZipPath(engineVersion: string): string {
    const mainVersion = String(engineVersion).split('.').slice(0, 2).join('')
    const suffix = process.platform === 'darwin' ? '-Mac' : ''
    return path.join(
      app.getAppPath(),
      'resources',
      'plugins',
      `UnrealAgentLink${mainVersion}${suffix}.zip`
    )
  },
  /**
   * 随包 zip 里的源码指纹（`.ual-build` 由 `scripts/build-plugin.mjs` 写入）。
   *
   * 读不到就返回 null —— 老包没有这个标记，调用方要能退回到只比版本号。
   */
  readBundledPluginFingerprint(engineVersion: string): string | null {
    const zipPath = this.getBundledPluginZipPath(engineVersion)
    const cached = bundledFingerprintCache.get(zipPath)
    if (cached !== undefined) return cached

    let fingerprint: string | null = null
    try {
      const entry = new AdmZip(zipPath).getEntry(PLUGIN_STAMP_FILE)
      if (entry) {
        const stamp = JSON.parse(entry.getData().toString('utf8')) as { fingerprint?: string }
        fingerprint = stamp.fingerprint || null
      }
    } catch {
      fingerprint = null
    }
    bundledFingerprintCache.set(zipPath, fingerprint)
    return fingerprint
  },
  /**
   * 已装到项目里的那一份的源码指纹，读不到返回 null
   */
  async readInstalledPluginFingerprint(pluginDir: string): Promise<string | null> {
    try {
      const raw = await fse.readFile(path.join(pluginDir, PLUGIN_STAMP_FILE), 'utf8')
      const stamp = JSON.parse(raw) as { fingerprint?: string }
      return stamp.fingerprint || null
    } catch {
      return null
    }
  },
  /**
   * 项目里已装的插件是不是就是随包的那一份。
   *
   * **不能只比 VersionName。** 插件源码改了但 `.uplugin` 的版本号没跟着动
   * 是常态（一次发版里可能改十几遍），只比版本号的话，已经装过 1.2.8 的用户
   * 永远拿不到后来重编的 1.2.8 —— 修好的东西发不出去，这是闭环上真实的断点。
   * 所以再比一层 `.ual-build` 里的源码指纹，那才是「同一份构建」的判据。
   *
   * 随包 zip 里没有指纹（老包）时退回到只比版本号，不至于每次启动都重装。
   *
   * @param pluginDir 项目里的 `Plugins/UnrealAgentLink` 目录
   * @param engineVersion 引擎版本（如 5.4），用来定位随包 zip
   */
  async isProjectPluginUpToDate(pluginDir: string, engineVersion: string): Promise<boolean> {
    // 定位不到随包 zip（自编译引擎的 GUID、或者我们还没出包的引擎版本）就没法判断，
    // 一律当作「不是最新」交给完整的安装流程去解析，别在这里替它下结论
    if (!fs.existsSync(this.getBundledPluginZipPath(engineVersion))) return false

    try {
      const { bundledVersion } = this.loadUALinkConfig()
      if (!(await this.checkPluginVersionAtPath(pluginDir, bundledVersion))) return false
    } catch {
      // 版本读不出来（文件损坏 / 缺失）就当作需要重装
      return false
    }

    const bundledFingerprint = this.readBundledPluginFingerprint(engineVersion)
    if (!bundledFingerprint) return true

    return (await this.readInstalledPluginFingerprint(pluginDir)) === bundledFingerprint
  },
  /**
   * 读取 UALink 配置
   */
  loadUALinkConfig(): { bundledVersion: string } {
    try {
      const configPath = path.join(app.getAppPath(), 'resources', 'plugins', 'ualink-config.json')
      if (fs.existsSync(configPath)) {
        const content = fs.readFileSync(configPath, 'utf-8')
        const config = JSON.parse(content)
        return { bundledVersion: config.bundledVersion || '0.0.0' }
      }
    } catch {}
    return { bundledVersion: '0.0.0' }
  },
  /**
   * 检查指定路径下的插件版本是否满足要求
   */
  async checkPluginVersionAtPath(pluginDir: string, requiredVersion: string): Promise<boolean> {
    const upPath = path.join(pluginDir, 'UnrealAgentLink.uplugin')
    const info = await readUeJsonFile<{ VersionName?: string }>(upPath)
    const currentVersion = info.VersionName
    if (!currentVersion) return false
    return this.compareVersions(currentVersion, requiredVersion) >= 0
  },
  getUNTLinkInstallPaths(enginePath: string): string[] {
    return [
      path.join(enginePath, 'Marketplace', 'UnrealAgentLink'),
      path.join(enginePath, 'Engine', 'Plugins', 'Marketplace', 'UnrealAgentLink'),
      path.join(enginePath, 'Engine', 'Plugins', 'UnrealAgentLink')
    ]
  },
  async repairUnrealAgentLinkEngineResidue(): Promise<EnginePluginCleanupSummary> {
    const engines = await this.findUnrealEnginePaths()
    const failedEngines: EnginePluginCleanupFailure[] = []
    let cleanedEngineCount = 0
    let skippedEngineCount = 0

    for (const engine of engines) {
      const existingPluginPaths = await Promise.all(
        this.getUNTLinkInstallPaths(engine.rootPath).map((pluginPath) => fse.pathExists(pluginPath))
      )

      if (!existingPluginPaths.some(Boolean)) {
        skippedEngineCount++
        continue
      }

      const uninstallResult = await this.uninstallUNTLink(engine.rootPath)
      if (uninstallResult.success) {
        cleanedEngineCount++
        continue
      }

      failedEngines.push({
        engineName: engine.name,
        engineRootPath: engine.rootPath,
        error:
          uninstallResult.error instanceof Error
            ? uninstallResult.error.message
            : String(uninstallResult.error || 'UNKNOWN_ERROR')
      })
    }

    return {
      scannedEngineCount: engines.length,
      cleanedEngineCount,
      skippedEngineCount,
      failedEngines
    }
  },
  /**
   * 卸载 UNTLink 插件
   * @param enginePath 引擎根路径
   * @returns 执行结果
   */
  uninstallUNTLink: async (enginePath: string): Promise<{ success: boolean; error?: unknown }> => {
    try {
      // 删除所有可能的安装位置
      for (const targetPath of UnrealPathManagerUtil.getUNTLinkInstallPaths(enginePath)) {
        // 这里不用像安装那样跳过：清引擎残留是用户自己按的按钮，删掉这条路径正是他要的。
        // `fse.remove` 实测只摘链接、不进目标，联接指向的源码不会被动到 ——
        // 但联接没了开发者得知道，否则下次编译找不到源码会一头雾水
        const linkTarget = await readLinkTarget(targetPath)
        if (linkTarget) {
          console.log(
            `[UALink] 引擎级路径 ${targetPath} 是目录联接（指向 ${linkTarget}），只摘联接，不动目标内容`
          )
        }
        await fse.remove(targetPath)
      }
    } catch (e) {
      return { success: false, error: e }
    }
    return { success: true }
  },

  /**
   * 判断 EngineAssociation 是否为自编译引擎的 GUID 格式
   * 自编译引擎在 .uproject 中使用 {XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX} 格式
   */
  isSourceBuildGUID(engineAssociation: string): boolean {
    return (
      /^\{[A-Fa-f0-9-]+\}$/.test(engineAssociation) ||
      /^[A-Fa-f0-9]{8}(?:-[A-Fa-f0-9]{4}){3}-[A-Fa-f0-9]{12}$/.test(engineAssociation)
    )
  },

  /**
   * 将自编译引擎 GUID 解析为真实引擎版本号
   * 自编译引擎在 Windows 注册表 HKCU\SOFTWARE\Epic Games\Unreal Engine\Builds 中
   * 以 GUID 为键名、引擎根目录为值存储映射关系
   *
   * @param guid .uproject 中的 EngineAssociation GUID
   * @returns 解析结果（版本号 + 引擎根路径），无法解析时返回 null
   */
  async resolveEngineVersionFromGUID(
    guid: string
  ): Promise<{ version: string; engineRootPath: string } | null> {
    console.log(`[UALink] 尝试解析自编译引擎 GUID: ${guid}`)

    if (process.platform === 'darwin') {
      return resolveMacEngineAssociation(guid, app.getPath('home'))
    }
    if (process.platform !== 'win32') return null

    // 方法 1：从 Windows 注册表读取 GUID → 引擎路径映射
    try {
      const psCommand = [
        'powershell -NoProfile -Command',
        '"Get-ItemProperty -Path',
        "'HKCU:\\SOFTWARE\\Epic Games\\Unreal Engine\\Builds'",
        '-ErrorAction SilentlyContinue | ConvertTo-Json -Compress"'
      ].join(' ')
      const { stdout } = await new Promise<{ stdout: string; stderr: string }>(
        (resolve, reject) => {
          exec(psCommand, { encoding: 'utf8', timeout: 5000 }, (err, stdout, stderr) => {
            if (err) reject(err)
            else resolve({ stdout, stderr })
          })
        }
      )

      if (stdout && stdout.trim()) {
        const builds = JSON.parse(stdout.trim())
        // 注册表中 GUID 键名可能带或不带花括号
        const engineRootPath = builds[guid] || builds[guid.replace(/[{}]/g, '')]
        if (engineRootPath && typeof engineRootPath === 'string') {
          const version = await this.readVersionFromBuildFile(engineRootPath)
          if (version) {
            console.log(
              `[UALink] 注册表解析成功: GUID=${guid} → path=${engineRootPath}, version=${version}`
            )
            return { version, engineRootPath }
          }
        }
      }
    } catch (e) {
      console.warn('[UALink] 注册表读取失败:', e)
    }

    console.warn(`[UALink] 无法解析 GUID: ${guid}`)
    return null
  },

  /**
   * 从引擎目录的 Engine/Build/Build.version 文件读取版本号
   * @param engineRootPath 引擎根路径
   * @returns 版本号如 "5.3"，读取失败返回 null
   */
  async readVersionFromBuildFile(engineRootPath: string): Promise<string | null> {
    try {
      const buildVersionPath = path.join(engineRootPath, 'Engine', 'Build', 'Build.version')
      const buildInfo = await readUeJsonFile<{
        MajorVersion?: number
        MinorVersion?: number
        PatchVersion?: number
      }>(buildVersionPath)
      if (buildInfo.MajorVersion != null && buildInfo.MinorVersion != null) {
        return `${buildInfo.MajorVersion}.${buildInfo.MinorVersion}`
      }
    } catch {
      // Build.version 不存在或解析失败
    }
    return null
  }
}
export default UnrealPathManagerUtil
