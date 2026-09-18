import { ipcMain } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { getPublicDatabase } from '../index'
import {
  createProject,
  getProjectByKey,
  getProjectById,
  getAllProjects,
  updateProject,
  deleteProjectByKey,
  projectExists,
  searchProjects,
  getProjectByPath,
  type ProjectRecord
} from '../models/project'
import { getAppWindows } from '../../appWindows'
import { UnrealAssetProcessor } from '../../utils/fileProcessor/UnrealAssetProcessor'
import ThumbnailManager from '../../utils/ThumbnailManager'
import { appSettingsManager } from '../../appSettingsManager'
import UnrealPathManagerUtil from '../../utils/UnrealPathManager'
import UnrealProcessDetector from '../../utils/UnrealProcessDetector'
import { ensurePluginIgnored } from '../../utils/pluginVcsIgnore'
import { toNativeProjectPath } from '../../utils/projectPath'
import { readUeJsonFile } from '../../utils/ueTextFile'

/**
 * 确保项目中安装并启用了 UnrealAgentLink 插件（项目级安装）
 *
 * 三种情况：
 * 1. 插件文件未安装，.uproject 中无引用 → 安装插件文件 + 添加并启用引用
 * 2. 插件文件已安装，.uproject 中有引用但未启用 → 自动启用
 * 3. 插件文件已安装且已启用 → 不操作
 *
 * @param uprojectPath - .uproject 文件的绝对路径
 */
export async function ensureUnrealAgentLinkPlugin(
  uprojectPath: string
): Promise<{ pluginFailure: string | null }> {
  const PLUGIN_NAME = 'UnrealAgentLink'
  const projectDir = path.dirname(uprojectPath)

  // 用户在这个项目上点过「移除 UnrealAgentLink」就别再装回去。
  // 少了这一步，用户手删插件、下次从盒子打开项目又原样出现 —— 这是真实收到过的投诉。
  if (appSettingsManager.isUALinkOptedOut(uprojectPath)) {
    console.log(`[ensureUnrealAgentLinkPlugin] 该项目已选择不安装，跳过: ${uprojectPath}`)
    return { pluginFailure: null }
  }

  /**
   * 读取 .uproject 文件获取引擎版本。
   *
   * 编码交给 readUeJsonFile —— 中文工程会被引擎存成 UTF-16，按 utf-8 硬读会抛
   * `Unexpected token '�'`（2026-09-17 的真实事故）。
   *
   * 读不出来要**返回原因码，不能让异常裸奔**：异常会被调用方原样当成 reason 显示给
   * 用户，而 `Unexpected token '�', "��{...` 这种话用户一个字也看不懂，
   * 更看不出下一步该干什么。
   */
  let projectData: {
    EngineAssociation?: string
    Plugins?: Array<{ Name: string; Enabled?: boolean }>
  }
  try {
    projectData = await readUeJsonFile(uprojectPath)
  } catch (readErr) {
    console.warn(`[ensureUnrealAgentLinkPlugin] .uproject 读不出来: ${uprojectPath}`, readErr)
    return { pluginFailure: 'UPROJECT_UNREADABLE' }
  }

  const engineAssociation = projectData.EngineAssociation as string | undefined
  if (!engineAssociation) {
    console.warn(`[ensureUnrealAgentLinkPlugin] 无法获取引擎版本: ${uprojectPath}`)
    return { pluginFailure: 'NO_ENGINE_ASSOCIATION' }
  }

  // 自编译引擎在 .uproject 中使用 GUID 格式的 EngineAssociation
  // 需要解析为真实版本号才能正确选择插件包
  let resolvedVersion = engineAssociation
  let resolvedEngineRootPath: string | undefined
  if (UnrealPathManagerUtil.isSourceBuildGUID(engineAssociation)) {
    console.log(`[ensureUnrealAgentLinkPlugin] 检测到自编译引擎 GUID: ${engineAssociation}`)
    try {
      const resolved = await UnrealPathManagerUtil.resolveEngineVersionFromGUID(engineAssociation)
      if (resolved) {
        resolvedVersion = resolved.version
        resolvedEngineRootPath = resolved.engineRootPath
        console.log(
          `[ensureUnrealAgentLinkPlugin] GUID 解析成功: ${engineAssociation} → ${resolvedVersion}`
        )
      } else {
        console.warn(
          `[ensureUnrealAgentLinkPlugin] 无法解析自编译引擎 GUID: ${engineAssociation}，将跳过插件文件安装`
        )
      }
    } catch (resolveErr) {
      console.warn('[ensureUnrealAgentLinkPlugin] GUID 解析异常:', resolveErr)
    }
  }

  /**
   * 装不上的原因。调用方据此告诉用户，而不是让它烂在日志里。
   *
   * 这里以前全程 console.warn：引擎版本没有随包插件、自编译引擎 GUID 解析不出来、
   * 目录被占，用户看到的都是「导入成功」，然后 AI 死活连不上引擎，他不知道该查什么。
   */
  let pluginFailure: string | null = null

  // 1. 项目级安装插件文件到 projectDir/Plugins/UnrealAgentLink
  try {
    const result = await UnrealPathManagerUtil.installPluginToProject(projectDir, resolvedVersion)
    if (result.success) {
      console.log(`[ensureUnrealAgentLinkPlugin] 插件文件就绪: ${result.code || 'installed'}`)
      // 插件落在用户工作区里，顺手挡在版本库外面，免得跟着 git add . 一起提交
      const ignored = await ensurePluginIgnored(projectDir)
      console.log(
        `[ensureUnrealAgentLinkPlugin] 忽略规则: .gitignore=${ignored.gitignore}, .p4ignore=${ignored.p4ignore}`
      )
    } else {
      console.warn(`[ensureUnrealAgentLinkPlugin] 插件文件安装失败: ${result.code}`)
      pluginFailure = result.code || 'UNKNOWN'
    }
  } catch (installErr) {
    console.warn('[ensureUnrealAgentLinkPlugin] 插件安装异常:', installErr)
    pluginFailure = installErr instanceof Error ? installErr.message : String(installErr)
  }

  // 插件文件没落到磁盘上就到此为止 —— 后面两步都不能做。
  //
  // 这里以前是「安装失败也继续写 .uproject」。后果是 UE 打开工程时看到一个
  // 指向不存在插件的条目，弹「Plugin 'UnrealAgentLink' failed to load / 是否禁用」，
  // 用户什么都没干却先撞上一个报错框 —— 对没装过对应引擎包的版本（比如我们
  // 还没出包的引擎）、自编译引擎 GUID 解析失败的项目，这是必现的。
  // 装不上就当没发生过，比留个坏条目好。
  const upluginPath = path.join(projectDir, 'Plugins', PLUGIN_NAME, `${PLUGIN_NAME}.uplugin`)
  if (!fs.existsSync(upluginPath)) {
    console.warn(
      `[ensureUnrealAgentLinkPlugin] 插件文件不在磁盘上，不写 .uproject 条目: ${uprojectPath}`
    )
    return { pluginFailure: pluginFailure ?? 'PLUGIN_FILES_MISSING' }
  }

  // 1.5 清除引擎级旧插件（避免与项目级冲突，也解决 UE5Rules.dll 缓存问题）
  try {
    const engines = await UnrealPathManagerUtil.findUnrealEnginePaths()
    // 对于自编译引擎使用已解析的根路径匹配，普通引擎使用版本号匹配
    const engine = resolvedEngineRootPath
      ? engines.find((e) => e.rootPath.toLowerCase() === resolvedEngineRootPath!.toLowerCase())
      : engines.find((e) => e.version === engineAssociation || e.name === `UE_${engineAssociation}`)
    if (engine) {
      const result = await UnrealPathManagerUtil.uninstallUNTLink(engine.rootPath)
      if (result.success) {
        console.log(`[ensureUnrealAgentLinkPlugin] 已清除引擎级插件: ${engine.rootPath}`)
      }
    }
  } catch (cleanupErr) {
    console.warn(
      '[ensureUnrealAgentLinkPlugin] 清除引擎级插件失败（不影响项目级安装）:',
      cleanupErr
    )
  }

  // 2. 确保 .uproject 中的插件引用（三种情况处理）
  if (!Array.isArray(projectData.Plugins)) {
    projectData.Plugins = []
  }

  const existingPluginIndex = projectData.Plugins.findIndex(
    (plugin: { Name: string }) => plugin.Name === PLUGIN_NAME
  )

  if (existingPluginIndex === -1) {
    // 情况 1：插件引用不存在 → 添加并启用
    projectData.Plugins.push({
      Name: PLUGIN_NAME,
      Enabled: true
    })
    await fs.promises.writeFile(uprojectPath, JSON.stringify(projectData, null, '\t'), 'utf-8')
    console.log(`[ensureUnrealAgentLinkPlugin] 已添加并启用 ${PLUGIN_NAME}: ${uprojectPath}`)
  } else {
    const existingPlugin = projectData.Plugins[existingPluginIndex]
    if (existingPlugin.Enabled !== true) {
      // 情况 2：插件引用存在但未启用 → 启用
      existingPlugin.Enabled = true
      await fs.promises.writeFile(uprojectPath, JSON.stringify(projectData, null, '\t'), 'utf-8')
      console.log(`[ensureUnrealAgentLinkPlugin] 已启用 ${PLUGIN_NAME}: ${uprojectPath}`)
    } else {
      // 情况 3：已启用 → 不操作
      console.log(`[ensureUnrealAgentLinkPlugin] ${PLUGIN_NAME} 已启用，无需操作: ${uprojectPath}`)
    }
  }

  return { pluginFailure }
}

/** 项目里 UnrealAgentLink 的当前状态 */
export interface UnrealAgentLinkStatus {
  /** 插件目录是否存在且有 .uplugin */
  installed: boolean
  /** 已安装的版本号，读不到就是 null */
  version: string | null
  /** 随应用分发的版本号 */
  bundledVersion: string
  /** 用户是否明确拒绝过这个项目 */
  optedOut: boolean
  /** .uproject 里是否已启用 */
  enabledInUproject: boolean
}

/**
 * 查询某个项目的 UnrealAgentLink 状态。
 *
 * 界面上要靠它决定右键菜单显示「安装」还是「移除」。
 *
 * @param uprojectPath .uproject 文件的绝对路径
 */
export async function getUnrealAgentLinkStatus(
  uprojectPath: string
): Promise<UnrealAgentLinkStatus> {
  const { bundledVersion } = UnrealPathManagerUtil.loadUALinkConfig()
  const pluginDir = path.join(path.dirname(uprojectPath), 'Plugins', 'UnrealAgentLink')
  const upluginPath = path.join(pluginDir, 'UnrealAgentLink.uplugin')

  const installed = fs.existsSync(upluginPath)

  let version: string | null = null
  if (installed) {
    try {
      // checkPluginVersionAtPath 只回答「够不够新」，这里要的是具体版本号，
      // 所以直接读一遍描述文件（它可能是 UTF-16，交给同一套解码逻辑）
      version = await readUpluginVersion(upluginPath)
    } catch {
      version = null
    }
  }

  let enabledInUproject = false
  try {
    const projectData = await readUeJsonFile<{
      Plugins?: Array<{ Name: string; Enabled: boolean }>
    }>(uprojectPath)
    enabledInUproject = (projectData.Plugins || []).some(
      (plugin) => plugin.Name === 'UnrealAgentLink' && plugin.Enabled === true
    )
  } catch {
    enabledInUproject = false
  }

  return {
    installed,
    version,
    bundledVersion,
    optedOut: appSettingsManager.isUALinkOptedOut(uprojectPath),
    enabledInUproject
  }
}

/** 读 .uplugin 里的 VersionName（.uplugin 和 .uproject 一样可能是 UTF-16） */
async function readUpluginVersion(upluginPath: string): Promise<string | null> {
  const info = await readUeJsonFile<{ VersionName?: string }>(upluginPath)
  return info.VersionName || null
}

/**
 * 从项目里彻底移除 UnrealAgentLink，并记住「这个项目不要再装」。
 *
 * 三件事缺一不可 —— 只删文件不记黑名单，下次打开项目就白删了；
 * 只记黑名单不清 .uproject，UE 会报「找不到插件」。
 *
 * @param uprojectPath .uproject 文件的绝对路径
 */
export async function removeUnrealAgentLinkPlugin(
  uprojectPath: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const projectDir = path.dirname(uprojectPath)
    const pluginDir = path.join(projectDir, 'Plugins', 'UnrealAgentLink')

    // 1. 删插件目录
    await fs.promises.rm(pluginDir, { recursive: true, force: true })

    // 2. 从 .uproject 的 Plugins 数组里摘掉条目
    try {
      const projectData = await readUeJsonFile<{ Plugins?: Array<{ Name: string }> }>(uprojectPath)
      if (Array.isArray(projectData.Plugins)) {
        const kept = projectData.Plugins.filter((plugin) => plugin.Name !== 'UnrealAgentLink')
        if (kept.length !== projectData.Plugins.length) {
          projectData.Plugins = kept
          await fs.promises.writeFile(
            uprojectPath,
            JSON.stringify(projectData, null, '\t'),
            'utf-8'
          )
        }
      }
    } catch (uprojectErr) {
      // .uproject 读写失败不该让「删掉了插件文件」这件事回滚
      console.warn('[removeUnrealAgentLinkPlugin] 清理 .uproject 条目失败:', uprojectErr)
    }

    // 3. 记住用户的决定
    appSettingsManager.setUALinkOptOut(uprojectPath, true)

    console.log(`[removeUnrealAgentLinkPlugin] 已移除并加入黑名单: ${uprojectPath}`)
    return { success: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[removeUnrealAgentLinkPlugin] 移除失败:', message)
    return { success: false, error: message }
  }
}

/**
 * 手动把 UnrealAgentLink 装回某个项目（撤销之前的「不要装」）。
 *
 * @param uprojectPath .uproject 文件的绝对路径
 */
export async function installUnrealAgentLinkPlugin(
  uprojectPath: string
): Promise<{ success: boolean; error?: string }> {
  try {
    appSettingsManager.setUALinkOptOut(uprojectPath, false)
    const outcome = await ensureUnrealAgentLinkPlugin(uprojectPath)

    // 回读一次再报成功：它不抛异常（要容忍启动时批量调用），装不上只体现在返回的
    // pluginFailure 上。不回读就会给用户弹「安装成功」而磁盘上什么都没有 ——
    // 用户只会以为盒子坏了。
    const upluginPath = path.join(
      path.dirname(uprojectPath),
      'Plugins',
      'UnrealAgentLink',
      'UnrealAgentLink.uplugin'
    )
    if (!fs.existsSync(upluginPath)) {
      // 装不上又把项目留在「不再自动安装」名单外面，下次打开项目还会再试一次，
      // 这是对的：多半是引擎版本我们还没出包，出了包就自动补上
      return {
        success: false,
        // 带上具体原因：它比「请确认这个引擎版本有对应的随包插件」准得多 ——
        // 目录被占、没权限、.uproject 没写引擎版本，处理方式完全不同
        error: outcome.pluginFailure
          ? `插件文件没能装进项目：${outcome.pluginFailure}`
          : '插件文件没能装进项目，请确认这个引擎版本有对应的随包插件'
      }
    }
    return { success: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[installUnrealAgentLinkPlugin] 安装失败:', message)
    return { success: false, error: message }
  }
}

/**
 * App 启动时静默升级所有已导入项目的 UnrealAgentLink 插件
 * 遍历数据库中的所有项目，检查插件版本并在需要时升级
 * 非阻塞：在后台异步执行，不影响 App 启动速度
 */
export async function upgradeAllProjectPlugins(): Promise<void> {
  // 仅在用户启用了自动启用 UnrealAgentLink 时执行
  if (!appSettingsManager.getAutoEnableUnrealAgentLink()) {
    console.log('[UALink升级] 自动启用 UnrealAgentLink 未开启，跳过启动升级')
    return
  }

  try {
    const db = getPublicDatabase()
    const allProjects = getAllProjects(db)

    if (allProjects.length === 0) {
      console.log('[UALink升级] 无已导入项目，跳过')
      return
    }

    const config = UnrealPathManagerUtil.loadUALinkConfig()
    const bundledVersion = config.bundledVersion
    console.log(
      `[UALink升级] 开始检查 ${allProjects.length} 个项目，bundledVersion=${bundledVersion}`
    )

    let upgraded = 0
    let skipped = 0
    /**
     * 失败的工程名 + 原因 + 工程文件路径。
     *
     * 只计数不记名的话，界面上说不出是哪个工程出了事；不带路径的话，界面上那个
     * 「让 AI 看看」就只能把工程名丢给模型 —— 它拿名字找不到文件，第一步就卡住。
     */
    const failures: Array<{ project: string; reason: string; uprojectPath: string }> = []

    for (const project of allProjects) {
      try {
        // 需要 originPath（.uproject 文件路径）来执行安装
        const uprojectPath = project.originPath
        if (!uprojectPath || !fs.existsSync(uprojectPath)) {
          skipped++
          continue
        }

        // 用户明确不要的项目，启动升级也别去碰
        if (appSettingsManager.isUALinkOptedOut(uprojectPath)) {
          skipped++
          continue
        }

        const projectDir = path.dirname(uprojectPath)
        const pluginDir = path.join(projectDir, 'Plugins', 'UnrealAgentLink')
        const upluginPath = path.join(pluginDir, 'UnrealAgentLink.uplugin')

        // 如果插件根本没安装过，也执行安装
        if (!fs.existsSync(upluginPath)) {
          // 装不上时它不抛异常，只在返回值里说原因 —— 不看的话这里会把
          // 一次失败的安装记成 upgraded，日志上一片太平，而插件根本没装上
          const outcome = await ensureUnrealAgentLinkPlugin(uprojectPath)
          if (outcome.pluginFailure) {
            failures.push({
              project: project.projectName || projectDir,
              reason: outcome.pluginFailure,
              uprojectPath
            })
            console.warn(
              `[UALink升级] 安装失败（${outcome.pluginFailure}）: ${project.projectName || projectDir}`
            )
          } else {
            upgraded++
          }
          continue
        }

        // 已装的这一份是不是就是随包的那一份（比版本号，也比源码指纹）。
        // 引擎版本是 GUID（自编译）时定位不到随包 zip，会返回 false，
        // 交给 ensureUnrealAgentLinkPlugin 去解析 GUID 后再判一次
        const isUpToDate = await UnrealPathManagerUtil.isProjectPluginUpToDate(
          pluginDir,
          project.EngineAssociation || ''
        )
        if (isUpToDate) {
          skipped++
          continue
        }

        // 编辑器正开着这个工程就别升了。
        //
        // 插件目录里的 DLL 被加载着，替换必然失败（安装那头有原子换名兜底，旧插件不会
        // 坏，但每次启动白试一遍没有意义）。等他关掉编辑器，下次启动自然会升上去。
        const running = await UnrealProcessDetector.findRunningProjectByPath(uprojectPath)
        if (running) {
          skipped++
          console.log(
            `[UALink升级] 编辑器正开着，跳过本次升级（关闭后下次启动会自动更新）: ${
              project.projectName || projectDir
            }`
          )
          continue
        }

        // 和随包的那一份对不上，执行升级
        console.log(`[UALink升级] 升级项目: ${project.projectName || projectDir}`)
        const outcome = await ensureUnrealAgentLinkPlugin(uprojectPath)
        if (outcome.pluginFailure) {
          failures.push({
            project: project.projectName || projectDir,
            reason: outcome.pluginFailure,
            uprojectPath
          })
          console.warn(
            `[UALink升级] 升级失败（${outcome.pluginFailure}）: ${project.projectName || projectDir}`
          )
        } else {
          upgraded++
        }
      } catch (err) {
        failures.push({
          project: project.projectName || project.originPath || '(未知工程)',
          reason: err instanceof Error ? err.message : String(err),
          uprojectPath: project.originPath || ''
        })
        console.warn(`[UALink升级] 项目升级失败: ${project.projectName || project.originPath}`, err)
      }
    }

    console.log(`[UALink升级] 完成: 升级 ${upgraded}, 跳过 ${skipped}, 失败 ${failures.length}`)

    /*
     * 失败要说出来，不能只写 console。
     *
     * 这条启动遍历是插件升级**最主要**的触发路径：盒子一更新，随包插件版本一变，
     * 所有已导入工程同时判为过期，逐个进入替换流程。磁盘写满、目录被占时它们会
     * 一起失败 —— 而安装那头虽然有原子换名兜底（旧插件不会坏），用户仍然停在旧版本，
     * 而且完全不知道发生过这件事。他之后遇到的是「AI 连不上引擎」或者新功能用不了，
     * 那时早已想不起来跟某次开机有关。
     */
    if (failures.length > 0) notifyPluginUpgradeFailed(failures)
  } catch (err) {
    console.error('[UALink升级] 启动升级流程异常:', err)
  }
}

/**
 * 告诉界面「我的项目」变了，该重新读一遍。
 *
 * 为什么需要：项目库现在有三个入口会往里加东西 —— 用户在首页点导入、
 * agent 用 `project_manage` 建工程、UE 连上时补登记。后两个都发生在
 * **用户没在操作首页的时候**，不推一下的话，工程明明进库了，界面上还是空的，
 * 得切个页面或者重启才看得见。用户会认为「它说建好了但其实没有」。
 *
 * 已经有一个 `ws:projects-changed` 了，但那个说的是「哪些工程此刻连着盒子」
 * （卡片上的在线角标），和「库里有哪些工程」是两回事，不能复用。
 */
function notifyProjectLibraryChanged(): void {
  for (const win of getAppWindows()) {
    win.webContents.send('db:project:library-changed')
  }
}

/**
 * 启动时的插件升级有工程失败了。
 *
 * 和导入那条路（`RegisterProjectResult.pluginFailure`）分开发：那一条是对某次
 * 用户动作的回答，能跟在「导入成功」后面说；这一条**没有对应的用户动作** ——
 * 它发生在开机后的后台，只能由主进程主动推。
 *
 * 只带工程名和原因码，文案归渲染层（`usePluginInstallNotice`）。
 */
function notifyPluginUpgradeFailed(failures: Array<{ project: string; reason: string }>): void {
  for (const win of getAppWindows()) {
    win.webContents.send('db:project:plugin-upgrade-failed', failures)
  }
}

export interface RegisterProjectResult {
  success: boolean
  error?: string
  /** 库里本来就有这个工程（按目录判重），没有新建记录 */
  alreadyRegistered?: boolean
  /**
   * 工程进库了，但 UnrealAgentLink 没装上，以及为什么。
   *
   * 导入本身仍然算成功 —— 插件只是可选能力，为它把整次导入判失败不成比例。
   * 但必须说出来：不说的话，用户之后只会遇到「AI 连不上引擎」，而那时他已经
   * 想不起来这跟导入那一步有关系。
   */
  pluginFailure?: string
  data?: ProjectRecord
}

/**
 * `UnrealAssetProcessor.processUproject` 的返回形状里我们真正用到的那几个字段。
 *
 * 那个方法是 private 的，只能绕着类型访问；与其把整个结果当成
 * `Record<string, any>`（后面每一处取值都不再有任何检查），不如在这里
 * 把用到的字段写清楚 —— 哪天上游改了字段名，是这里报错，而不是用户
 * 拿到一张 `projectName` 是 "undefined" 的卡片。
 */
interface UprojectMeta {
  assetKey?: string
  name?: string
  engineAssociation?: string
  imgLocalPath?: string
  metadata?: { projectInfo?: unknown }
}

type UprojectProcessor = { processUproject(filePath: string): Promise<UprojectMeta> }

/**
 * 把一个 `.uproject` 登记进项目库。
 *
 * ## 为什么要抽出来
 *
 * 工程进库的入口不止「用户在首页点导入」一个：agent 用 `project_manage`
 * 建的工程要进库，UE 连上盒子时发现库里没有的工程也要补登记。这三条路
 * 各写一遍的结果是**同一个工程从不同入口进来长得不一样** —— 曾经的实际情况是
 * agent 那条路自己 `crypto.randomUUID()` 造 key、不抽封面、不装插件，
 * 于是首页上它是一张没有缩略图的空白卡片，用户一眼就看出「这个和别的不一样」。
 *
 * 抽成一个函数之后，「怎么算登记好了」只有一个定义。
 *
 * @param filePath `.uproject` 文件的绝对路径
 */
export async function registerProjectByUproject(filePath: string): Promise<RegisterProjectResult> {
  try {
    const db = getPublicDatabase()
    // 统一成本机写法再入库：UE 插件上报的是 `I:/UE Project/X.uproject`，
    // 文件对话框给的是 `I:\UE Project\X.uproject`，同一个工程两种写法
    const uprojectPath = toNativeProjectPath(filePath)
    const processor = new UnrealAssetProcessor() as unknown as UprojectProcessor
    const projectMeta = await processor.processUproject(uprojectPath)

    const record: ProjectRecord = {
      projectKey: String(projectMeta.assetKey),
      projectName: String(projectMeta.name || ''),
      EngineAssociation: String(projectMeta.engineAssociation || ''),
      projectData: JSON.stringify(projectMeta.metadata?.projectInfo ?? {}),
      projectPath: path.dirname(uprojectPath),
      originPath: uprojectPath,
      projectConfig: '',
      image: String(projectMeta.imgLocalPath || ''),
      note: ''
    }

    // 基于项目路径的唯一性：同一路径已存在就不再建第二条记录
    const existing = getProjectByPath(db, record.projectPath!)
    if (existing) {
      return {
        success: false,
        alreadyRegistered: true,
        error: '项目已存在',
        data: existing
      }
    }

    const id = createProject(db, record)
    const saved = getProjectById(db, id)
    notifyProjectLibraryChanged()

    // 根据设置决定是否自动添加 UnrealAgentLink 插件到 .uproject 文件
    let pluginFailure: string | undefined
    if (appSettingsManager.getAutoEnableUnrealAgentLink()) {
      try {
        const outcome = await ensureUnrealAgentLinkPlugin(uprojectPath)
        pluginFailure = outcome.pluginFailure ?? undefined
      } catch (pluginError) {
        console.warn('添加 UnrealAgentLink 插件失败:', pluginError)
        pluginFailure = pluginError instanceof Error ? pluginError.message : String(pluginError)
      }
    }

    return { success: true, data: saved, ...(pluginFailure ? { pluginFailure } : {}) }
  } catch (error) {
    console.error('导入项目失败:', error)
    return { success: false, error: (error as Error).message }
  }
}

/**
 * 注册项目数据相关的IPC处理函数（公共数据库）
 */
export const registerProjectIPC = (): void => {
  // 导入单个 .uproject 文件并写入数据库（存在则更新）
  ipcMain.handle('db:project:importByFilePath', async (_, filePath: string) => {
    void _
    const result = await registerProjectByUproject(filePath)
    // 渲染进程只认 success / error / data 这三个字段，alreadyRegistered 是
    // 给主进程内部调用方看的，不往外带
    return { success: result.success, error: result.error, data: result.data }
  })

  // 扫描目录中的 .uproject 文件（仅扫描，不导入）
  ipcMain.handle('db:project:scanDirectory', async (_, startPath: string) => {
    void _
    try {
      const processor = new UnrealAssetProcessor()
      const files = await processor.findAllUprojects(startPath)
      return { success: true, data: files }
    } catch (error) {
      console.error('目录扫描项目失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 扫描目录中的 .uproject 并批量导入
  ipcMain.handle('db:project:importByDirectory', async (_, startPath: string) => {
    void _
    try {
      const processor = new UnrealAssetProcessor()
      const files = await processor.findAllUprojects(startPath)

      // 逐个走 registerProjectByUproject，不在这里自己拼记录：判重、封面、
      // 插件安装这些「怎么算登记好了」的定义只能有一份，各写一遍必然漂
      const results: Array<{ filePath: string; id?: number; error?: string }> = []
      for (const filePath of files) {
        const result = await registerProjectByUproject(filePath)
        if (result.success) {
          results.push({ filePath, id: result.data?.id })
        } else {
          results.push({
            filePath,
            error: result.alreadyRegistered ? '项目已存在，跳过导入' : result.error
          })
        }
      }

      return { success: true, data: { total: files.length, results } }
    } catch (error) {
      console.error('目录导入项目失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // CRUD/查询
  ipcMain.handle('db:project:create', async (_, record: ProjectRecord) => {
    void _
    try {
      const db = getPublicDatabase()
      const id = createProject(db, record)
      return { success: true, data: id }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle(
    'db:project:update',
    async (_, projectKey: string, updates: Partial<ProjectRecord>) => {
      void _
      try {
        const db = getPublicDatabase()
        const ok = updateProject(db, projectKey, updates)
        return { success: true, data: ok }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )

  ipcMain.handle('db:project:getAll', async () => {
    try {
      const db = getPublicDatabase()
      const list = getAllProjects(db)
      return { success: true, data: list }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('db:project:getByKey', async (_, projectKey: string) => {
    void _
    try {
      const db = getPublicDatabase()
      const row = getProjectByKey(db, projectKey)
      return { success: true, data: row }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('db:project:delete', async (_, projectKey: string) => {
    void _
    try {
      const db = getPublicDatabase()
      // 先获取记录，以便清理缩略图（按文件名）
      const row = getProjectByKey(db, projectKey)
      if (row?.image) {
        await ThumbnailManager.deletePublicThumbnailByFilename(row.image)
      }
      const ok = deleteProjectByKey(db, projectKey)
      return { success: true, data: ok }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('db:project:exists', async (_, projectKey: string) => {
    void _
    try {
      const db = getPublicDatabase()
      const exists = projectExists(db, projectKey)
      return { success: true, data: exists }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('db:project:search', async (_, keyword: string) => {
    void _
    try {
      const db = getPublicDatabase()
      const list = searchProjects(db, keyword)
      return { success: true, data: list }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  // 查询某个项目的 UnrealAgentLink 状态（右键菜单靠它决定显示「安装」还是「移除」）
  ipcMain.handle('db:project:ualinkStatus', async (_, uprojectPath: string) => {
    void _
    try {
      if (!uprojectPath || !fs.existsSync(uprojectPath)) {
        return { success: false, error: '项目文件不存在' }
      }
      const data = await getUnrealAgentLinkStatus(uprojectPath)
      return { success: true, data }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  // 从项目里移除 UnrealAgentLink，并记住不再自动安装
  ipcMain.handle('db:project:ualinkRemove', async (_, uprojectPath: string) => {
    void _
    try {
      if (!uprojectPath) return { success: false, error: '缺少项目路径' }
      return await removeUnrealAgentLinkPlugin(uprojectPath)
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  // 把 UnrealAgentLink 装回项目（撤销之前的「不要装」）
  ipcMain.handle('db:project:ualinkInstall', async (_, uprojectPath: string) => {
    void _
    try {
      if (!uprojectPath || !fs.existsSync(uprojectPath)) {
        return { success: false, error: '项目文件不存在' }
      }
      return await installUnrealAgentLinkPlugin(uprojectPath)
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  /**
   * 检测项目目录下是否有 .sln 文件（判断是否为 C++ 工程）
   * C++ 项目通常会在工程目录下生成一个 .sln 文件
   * @param projectDir - 项目目录路径（.uproject 所在目录）
   * @returns 如果找到 .sln 文件，返回其完整路径；否则返回 null
   */
  ipcMain.handle('db:project:findSlnFile', async (_, projectDir: string) => {
    void _
    try {
      if (!projectDir || typeof projectDir !== 'string') {
        return { success: false, error: '无效的项目路径' }
      }

      // 检查目录是否存在
      try {
        await fs.promises.access(projectDir, fs.constants.R_OK)
      } catch {
        return { success: true, data: null }
      }

      // 读取目录内容，查找 .sln 文件
      const entries = await fs.promises.readdir(projectDir, { withFileTypes: true })
      const slnFile = entries.find(
        (entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.sln')
      )

      if (slnFile) {
        const slnPath = path.join(projectDir, slnFile.name)
        return { success: true, data: slnPath }
      }

      return { success: true, data: null }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })
}

export type { ProjectRecord }
