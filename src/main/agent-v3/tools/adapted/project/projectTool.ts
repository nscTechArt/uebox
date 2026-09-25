/**
 * 项目管理工具：创建项目和列出项目/模板
 */
import { defineV2Tool, type V2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import { app, shell } from 'electron'
import path from 'path'
import { promises as fs } from 'fs'
import * as http from 'http'
import * as https from 'https'
import * as nodeFs from 'fs'

import AdmZip from 'adm-zip'
import { getPublicDatabase, getDatabaseManager } from '../../../../sqliteDataBase'
import { readUeJsonFile } from '../../../../utils/ueTextFile'
import { getAllProjects, type ProjectRecord } from '../../../../sqliteDataBase/models/project'
import {
  getAllProjectCollections,
  getCollectionKeysOfProject
} from '../../../../sqliteDataBase/models/projectCollection'
import { appSettingsManager } from '../../../../appSettingsManager'
import {
  ensureUnrealAgentLinkPlugin,
  registerProjectByUproject
} from '../../../../sqliteDataBase/ipc/project'
import {
  instantiateEngineTemplate,
  listEngineTemplates,
  validateProjectName,
  type EngineTemplate
} from '../../../../services/project/engineTemplates'
import UnrealPathManagerUtil from '../../../../utils/UnrealPathManager'
import {
  importExternalFilesToProject,
  importUAssetsBatchToProject,
  type ProjectImportProjectRecord
} from '../../../../ipc/projectImport'
import type {
  ImportFailureReason,
  MissingDependencyState
} from '../../../../../shared/projectImport'
import { serviceManager } from '../../../../services'
import UnrealProcessDetector from '../../../../utils/UnrealProcessDetector'
import { projectManager } from '../../../../services/project'
import { getAssetDataByKey, type AssetData } from '../../../../sqliteDataBase/models/assetData'
import { VaultType } from '../../../../sqliteDataBase/VaultManager'
import { vaultAccessKeyHeadersFromUrl } from '../../../../networkV2/vaultAccessKeys'

import { selectFolderAssetKeys } from '../asset/folderAssets'
import { resolveFolder } from '../asset/folderLookup'
import { explainVaultMiss, explainVaultMissBatch } from '../asset/vaultScope'
// 拷完 .uasset 之后要让引擎重扫注册表，走的是插件的 content.registry_scan
import { callUe } from '../../defineUeTool'

import {
  getSessionProjectPath,
  getTargetConnectionId,
  isOutOfSessionScope,
  runWithTargetConnectionId
} from '../../../core/projectTargetContext'
import { runEditorPython } from '../../../core/editorPython'
import { isSameProjectPath } from '../../../core/projectPathKey'
import { awaitProjectLive, DEFAULT_WAIT_MS, MAX_WAIT_MS } from './awaitProjectLive'

/**
 * 按文件夹导入时，一次最多导多少个。
 *
 * 导入是一个一个跟引擎打交道的慢操作（.uasset 要拷贝并解析依赖，外部文件要走
 * 一趟 WebSocket），几百个一口气跑完会把一次工具调用拖到十几分钟。所以按批来，
 * 并把 hasMore / nextFolderOffset 回给调用方接着调。
 */
const MAX_IMPORT_BATCH = 200

interface FormattedTemplate {
  /** 给人看的名字。引擎模板用 TemplateDefs.ini 里的中文名（「空白」「第三人称游戏」）*/
  name: string
  /**
   * 选模板时报这个值给 `create_project`。
   *
   * 引擎模板形如 `5.5/TP_BlankBP` —— 同一个模板在装了的每个引擎版本里都有一份，
   * 光给「空白」选不出是哪个版本的。
   */
  templateKey: string
  /** `engine` = 引擎自带；`pack` = 用户放在盒子模板目录里的 zip 包 */
  source: 'engine' | 'pack'
  path: string
  category?: string
  engineVersion?: string
  description?: string
  /** 有 C++ 源码，建出来第一次打开要编译 */
  needsCode?: boolean
  /** 依赖的共享内容包（第三人称的小白人之类），建工程时会一起拷 */
  sharedContentPacks?: string[]
}

interface FormattedProject {
  name: string
  projectKey: string
  engineVersion?: string
  path?: string
  /** 所在合集的名字，可能有多个；没分组就是空数组 */
  collections: string[]
  /** 置顶的工程在首页排最前面 */
  pinned: boolean
}

/** 工程库里的一个合集，给 `project_organize` 当输入用 */
interface FormattedCollection {
  collectionKey: string
  name: string
  pinned: boolean
  projectCount: number
}

interface ScenePlacementOptions {
  layout?: 'line' | 'grid'
  origin?: { x?: number; y?: number; z?: number }
  rotation?: { pitch?: number; yaw?: number; roll?: number }
  scale?: { x?: number; y?: number; z?: number }
  spacing?: number
  columns?: number
  snapToFloor?: boolean
}

interface ImportedAssetSummary {
  assetKey: string
  assetName: string
  assetClass: string
  uePath?: string
  sourceType: 'uasset' | 'external'
  imported: boolean
  alreadyExists?: boolean
  spawnable: boolean
  reference?: string
}

interface ProjectImportResult {
  success: boolean
  error?: string
  imported_count?: number
  requested_asset_count?: number
  resolved_asset_count?: number
  placed_count?: number
  details?: string[]
  imported_assets?: ImportedAssetSummary[]
  spawn_candidates?: ImportedAssetSummary[]
  placed_actors?: Array<Record<string, unknown>>
  /** 按文件夹导入时，这一批取的是哪些 —— 还有没有下一批全在这里说清楚 */
  folder_selection?: {
    folder: string
    folderKey?: string
    total: number
    offset: number
    batch_count: number
    hasMore: boolean
    nextFolderOffset?: number
  }
  output?: {
    importedAssets: ImportedAssetSummary[]
    spawnCandidates: ImportedAssetSummary[]
    placedActors: Array<Record<string, unknown>>
  }
}

interface SequenceSetupResult {
  success: boolean
  error?: string
  details?: string[]
  sequence_path?: string
  sequence_created?: boolean
  actor_path?: string
  actor_created?: boolean
  actor_binding_added?: boolean
  animation_path?: string
  animation_applied?: boolean
  output?: {
    sequencePath?: string
    actorPath?: string
    animationPath?: string
  }
}

interface SequenceSetupOptions {
  sequenceName: string
  sequenceFolderPath?: string
  openSequence?: boolean
  actorAssetPath?: string
  actorAssetClass?: string
  existingActorPath?: string
  actorLabel?: string
  animationAssetPath?: string
  sequenceLengthSeconds?: number
  spawnTransform?: {
    location?: { x?: number; y?: number; z?: number }
    rotation?: { pitch?: number; yaw?: number; roll?: number }
    scale?: { x?: number; y?: number; z?: number }
  }
}

const Vector3Schema = z.object({
  x: z.number().optional(),
  y: z.number().optional(),
  z: z.number().optional()
})

const RotatorSchema = z.object({
  pitch: z.number().optional(),
  yaw: z.number().optional(),
  roll: z.number().optional()
})

const ScenePlacementSchema = z.object({
  layout: z.enum(['line', 'grid']).optional(),
  origin: Vector3Schema.optional(),
  rotation: RotatorSchema.optional(),
  scale: Vector3Schema.optional(),
  spacing: z.number().positive().optional(),
  columns: z.number().int().min(1).max(20).optional(),
  snapToFloor: z.boolean().optional()
})

const SpawnTransformSchema = z.object({
  location: Vector3Schema.optional(),
  rotation: RotatorSchema.optional(),
  scale: Vector3Schema.optional()
})

/**
 * 用户自己放进盒子模板目录的 zip 包。
 *
 * 安装包里不带模板，下载来的和自己打的包都落在这个目录，所以它**默认是空的**。
 * 这曾经是唯一的模板来源 —— 于是「建一个 UE5.5 空白工程」走工具是一条死路，
 * 模型只能绕开工具自己去拷引擎目录，绕过风险确认和入库登记。
 * 现在引擎自带模板是主来源，这里是补充。
 */
async function listPackTemplates(): Promise<FormattedTemplate[]> {
  const userDir = path.join(app.getPath('userData'), 'templates')

  const templates: FormattedTemplate[] = []
  try {
    const files = await fs.readdir(userDir)
    for (const file of files) {
      if (file.toLowerCase().endsWith('.zip')) {
        const name = path.basename(file, '.zip')
        templates.push({
          name,
          templateKey: name,
          source: 'pack',
          path: path.join(userDir, file),
          category: 'all'
        })
      }
    }
  } catch {
    // 目录不存在（一个模板都还没有）
  }
  return templates
}

/** 已装引擎自带的模板。缓存一次 —— 扫模板目录要读几十个 ini，同一次会话里不会变 */
let engineTemplateCache: Promise<EngineTemplate[]> | undefined

function getEngineTemplates(): Promise<EngineTemplate[]> {
  if (!engineTemplateCache) {
    engineTemplateCache = (async () => {
      const engines = await UnrealPathManagerUtil.findUnrealEnginePaths()
      return listEngineTemplates(
        engines.map((engine) => ({ version: engine.version, rootPath: engine.rootPath }))
      )
    })().catch((error) => {
      console.warn('[ProjectTool] 扫描引擎自带模板失败:', error)
      engineTemplateCache = undefined
      return []
    })
  }
  return engineTemplateCache
}

/** 仅供测试：清掉引擎模板缓存 */
export function __resetEngineTemplateCache(): void {
  engineTemplateCache = undefined
}

/**
 * 列出可用模板：引擎自带的排前面，用户自己的 zip 包排后面。
 */
async function listTemplates(): Promise<FormattedTemplate[]> {
  const [engineTemplates, packTemplates] = await Promise.all([
    getEngineTemplates(),
    listPackTemplates()
  ])

  const formattedEngine: FormattedTemplate[] = engineTemplates.map((template) => ({
    name: template.displayName,
    templateKey: template.key,
    source: 'engine',
    path: template.dir,
    category: template.isBlank ? 'blank' : 'all',
    engineVersion: template.engineVersion,
    description: template.description,
    needsCode: template.needsCode,
    sharedContentPacks: template.sharedContentPacks
  }))

  return [...formattedEngine, ...packTemplates]
}

/**
 * 把用户/模型给的一个说法对到具体某个引擎模板上。
 *
 * 允许四种写法，因为模型手里的信息不一定齐：完整 key（`5.5/TP_BlankBP`）、
 * 目录名（`TP_BlankBP`）、中文显示名（`空白`）、以及模糊包含。
 * `engineVersion` 给了就先按版本收窄 —— 不收窄的话「空白」会命中八个引擎里的八份。
 */
export function matchEngineTemplate(
  templates: EngineTemplate[],
  wanted: string,
  engineVersion?: string
): EngineTemplate | undefined {
  const needle = wanted.trim().toLowerCase()
  const pool = engineVersion
    ? templates.filter((template) => template.engineVersion === engineVersion)
    : templates

  const exact = (value: string): boolean => value.toLowerCase() === needle
  const loose = (value: string): boolean => value.toLowerCase().includes(needle)

  return (
    pool.find((template) => exact(template.key)) ??
    pool.find((template) => exact(template.templateName)) ??
    pool.find((template) => exact(template.displayName)) ??
    pool.find((template) => loose(template.templateName)) ??
    pool.find((template) => loose(template.displayName))
  )
}

/**
 * 列出已有项目
 */
export function listProjects(): {
  projects: FormattedProject[]
  collections: FormattedCollection[]
} {
  const db = getPublicDatabase()

  /*
   * 分组和置顶一起报。
   *
   * 少了这两项，模型看到的工程库是一张没有结构的平表 —— 用户说「按引擎版本
   * 分个组」，它无从知道哪些工程已经分好了，只能把整库重搬一遍；`project_organize`
   * 也没有合集名可用。空合集（界面上看不见）同样要报：模型得知道那个名字
   * 已经被占了，否则会建出第二个同名合集，然后在重名解析上卡住。
   */
  const collections = getAllProjectCollections(db)
  const nameByKey = new Map(
    collections.map((c) => [c.collectionKey, (c.name ?? '').trim() || c.collectionKey])
  )
  const counts = new Map<string, number>()

  const projects = getAllProjects(db).map((p: ProjectRecord) => {
    const keys = getCollectionKeysOfProject(db, p.projectKey)
    for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1)
    return {
      name: p.projectName || '',
      projectKey: p.projectKey || '',
      engineVersion: p.EngineAssociation || '',
      path: p.projectPath || '',
      collections: keys.map((key) => nameByKey.get(key) ?? key),
      pinned: Number(p.isPinned ?? 0) === 1
    }
  })

  return {
    projects,
    collections: collections.map((c) => ({
      collectionKey: c.collectionKey,
      name: (c.name ?? '').trim() || c.collectionKey,
      pinned: Number(c.isPinned ?? 0) === 1,
      projectCount: counts.get(c.collectionKey) ?? 0
    }))
  }
}

/** 从 zip 模板包解包出一个工程。返回新工程的 .uproject 路径 */
async function createFromPackTemplate(
  packPath: string,
  projectName: string,
  targetDir: string
): Promise<string> {
  await fs.mkdir(targetDir, { recursive: true })
  const tempDir = path.join(targetDir, `.temp_${Date.now()}`)
  await fs.mkdir(tempDir, { recursive: true })

  try {
    const zip = new AdmZip(packPath)
    zip.extractAllTo(tempDir, true)

    const findUproject = async (dir: string): Promise<string | null> => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isFile() && entry.name.endsWith('.uproject')) return full
        if (entry.isDirectory()) {
          const found = await findUproject(full)
          if (found) return found
        }
      }
      return null
    }

    const uprojectPath = await findUproject(tempDir)
    if (!uprojectPath) {
      throw new Error('模板包里没有 .uproject 文件，这不是一个工程模板。')
    }

    const uprojectDir = path.dirname(uprojectPath)
    const targetProjectDir = path.join(targetDir, projectName)

    const copyDir = async (src: string, dest: string): Promise<void> => {
      await fs.mkdir(dest, { recursive: true })
      for (const entry of await fs.readdir(src, { withFileTypes: true })) {
        const s = path.join(src, entry.name)
        const d = path.join(dest, entry.name)
        if (entry.isDirectory()) await copyDir(s, d)
        else await fs.copyFile(s, d)
      }
    }
    await copyDir(uprojectDir, targetProjectDir)

    const orig = path.basename(uprojectPath)
    const newUprojectPath = path.join(targetProjectDir, `${projectName}.uproject`)
    if (orig !== `${projectName}.uproject`) {
      await fs.rename(path.join(targetProjectDir, orig), newUprojectPath)
    }

    return newUprojectPath
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }
}

interface CreateProjectResult {
  success: boolean
  error?: string
  projectPath?: string
  uprojectPath?: string
  projectKey?: string
  engineVersion?: string
  registered?: boolean
  details?: string[]
}

/**
 * 从模板创建工程。
 *
 * 这是**建工程唯一该走的路**。用文件工具或 shell 去拷一份引擎模板也能建出工程，
 * 但那样会绕过风险确认、绕过入库登记、绕过插件安装，EngineAssociation 还是模板里
 * 那个空字符串 —— 用户回到首页会发现「我的项目」里什么都没多出来。
 *
 * @param templateName 模板的 key / 目录名 / 显示名
 * @param projectName 新工程名（英文字母数字下划线）
 * @param targetDir 工程的父目录
 * @param engineVersion 可选，指定用哪个引擎版本的模板
 */
async function createProjectFromTemplate(
  templateName: string,
  projectName: string,
  targetDir: string,
  engineVersion?: string
): Promise<CreateProjectResult> {
  const nameError = validateProjectName(projectName)
  if (nameError) return { success: false, error: nameError }

  const details: string[] = []
  let uprojectPath: string
  let projectDir: string

  const engineTemplates = await getEngineTemplates()
  const engineTemplate = matchEngineTemplate(engineTemplates, templateName, engineVersion)

  if (engineTemplate) {
    const result = await instantiateEngineTemplate({
      template: engineTemplate,
      projectName,
      targetDir
    })
    uprojectPath = result.uprojectPath
    projectDir = result.projectDir
    details.push(
      `✅ 已用 UE ${engineTemplate.engineVersion} 的「${engineTemplate.displayName}」模板建好工程`
    )
    for (const pack of result.sharedPacks) details.push(`📦 已带入共享内容包: ${pack}`)
    for (const warning of result.warnings) details.push(`⚠️ ${warning}`)
  } else {
    const packTemplate = (await listPackTemplates()).find((template) =>
      template.name.toLowerCase().includes(templateName.toLowerCase())
    )
    if (!packTemplate) {
      const available = engineTemplates
        .map((template) => `${template.key}（${template.displayName}）`)
        .slice(0, 12)
      return {
        success: false,
        error:
          `未找到模板 "${templateName}"${engineVersion ? `（引擎版本 ${engineVersion}）` : ''}。` +
          (available.length > 0
            ? `可用的引擎自带模板有：${available.join('、')}${engineTemplates.length > available.length ? ' 等' : ''}。先用 project_list(action="list_templates") 看全清单。`
            : '这台机器上没扫到任何引擎自带模板，先用 engine_inventory 确认引擎装没装。')
      }
    }
    uprojectPath = await createFromPackTemplate(packTemplate.path, projectName, targetDir)
    projectDir = path.dirname(uprojectPath)
    details.push(`✅ 已用模板包「${packTemplate.name}」建好工程`)
  }

  // 登记进项目库。走的是和用户在首页手动导入完全相同的那条路 ——
  // 封面、projectKey 的来源、插件安装全都一致，否则 agent 建的工程在首页
  // 会是一张和别人不一样的空白卡片
  const registered = await registerProjectByUproject(uprojectPath)
  if (registered.success) {
    details.push('📁 已登记到「我的项目」')
  } else if (registered.alreadyRegistered) {
    details.push('📁 这个目录本来就在「我的项目」里了')
  } else {
    // 工程确实建出来了，只是没进库。不能报 success 掩盖这件事 ——
    // 用户回首页找不到工程时得知道去哪儿看
    details.push(`⚠️ 工程已建好，但登记到项目库失败：${registered.error ?? '未知原因'}`)
  }

  return {
    success: true,
    projectPath: projectDir,
    uprojectPath,
    projectKey: registered.data?.projectKey,
    engineVersion: engineTemplate?.engineVersion ?? registered.data?.EngineAssociation ?? undefined,
    registered: registered.success || registered.alreadyRegistered === true,
    details
  }
}

/**
 * 在指定目录中查找 .uproject 文件
 * @param dirPath - 目录路径
 * @returns 找到的 .uproject 文件路径，未找到返回 null
 */
async function findUprojectInDirectory(dirPath: string): Promise<string | null> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.uproject')) {
        return path.join(dirPath, entry.name)
      }
    }
    return null
  } catch {
    return null
  }
}

/**
 * 打开项目（启动 .uproject 文件）
 * @param projectKey - 项目唯一标识
 * @returns 打开结果，包含详细的成功/失败信息
 */
async function openProject(projectKey: string): Promise<OpenProjectResult> {
  console.log(`[ProjectTool] open_project 开始, projectKey: ${projectKey}`)

  const db = getPublicDatabase()
  const projects = getAllProjects(db)
  const project = projects.find((p: ProjectRecord) => p.projectKey === projectKey)

  if (!project) {
    console.error(`[ProjectTool] 未找到项目, projectKey: ${projectKey}`)
    return {
      success: false,
      error: `数据库中未找到 projectKey 为 "${projectKey}" 的项目。请用 project_list(action="list_projects") 获取正确的项目列表。`
    }
  }

  console.log(`[ProjectTool] 找到项目:`, {
    projectName: project.projectName,
    originPath: project.originPath,
    projectPath: project.projectPath
  })

  let uprojectPath: string | null = null
  const candidatePaths = [project.originPath, project.projectPath].filter(Boolean) as string[]

  // 遍历候选路径，尝试找到有效的 .uproject 文件
  for (const candidatePath of candidatePaths) {
    console.log(`[ProjectTool] 检查候选路径: ${candidatePath}`)

    try {
      const stat = await fs.stat(candidatePath)

      if (stat.isFile() && candidatePath.endsWith('.uproject')) {
        // 直接是 .uproject 文件
        uprojectPath = candidatePath
        console.log(`[ProjectTool] 找到 .uproject 文件: ${uprojectPath}`)
        break
      } else if (stat.isDirectory()) {
        // 是目录，自动扫描查找 .uproject 文件
        console.log(`[ProjectTool] 路径是目录，扫描查找 .uproject 文件...`)
        const foundPath = await findUprojectInDirectory(candidatePath)
        if (foundPath) {
          uprojectPath = foundPath
          console.log(`[ProjectTool] 在目录中找到 .uproject 文件: ${uprojectPath}`)
          break
        } else {
          console.log(`[ProjectTool] 目录中未找到 .uproject 文件: ${candidatePath}`)
        }
      } else {
        console.log(`[ProjectTool] 路径既不是文件也不是目录: ${candidatePath}`)
      }
    } catch (statErr) {
      console.log(`[ProjectTool] 路径不存在或访问失败: ${candidatePath}`, statErr)
    }
  }

  // 如果仍未找到，返回详细的错误信息
  if (!uprojectPath) {
    const triedPaths =
      candidatePaths.length > 0 ? candidatePaths.map((p) => `"${p}"`).join(', ') : '无可用路径'
    return {
      success: false,
      error: `无法找到项目 "${project.projectName}" 的 .uproject 文件。已尝试的路径: ${triedPaths}。请确认项目路径是否正确，或项目是否已被移动/删除。`
    }
  }

  // 最终检查文件是否存在
  try {
    await fs.access(uprojectPath)
  } catch {
    return {
      success: false,
      error: `项目文件不存在: "${uprojectPath}"。该文件可能已被移动或删除。`
    }
  }

  const running = await alreadyRunning(uprojectPath)
  if (running === 'stuck') return stuckEditorResult(uprojectPath)
  if (running === 'yes') {
    console.log(`[ProjectTool] ${project.projectName} 已经开着，不再启动一次`)
    return {
      success: true,
      projectName: project.projectName ?? undefined,
      openedPath: uprojectPath,
      details: ['♻️ 这个工程本来就开着']
    }
  }

  console.log(`[ProjectTool] 即将打开: ${uprojectPath}`)

  // 如果启用了自动启用 UnrealAgentLink 插件设置，则在打开前确保插件被启用
  //
  // 装不上要**说给模型听**：它不抛异常，只在返回值里写原因。丢掉的话，工程照常打开，
  // 然后模型对着一个没插件的编辑器反复调 ue.* 工具，每次都是「引擎未连接」，
  // 而真正的原因（这个引擎版本没有随包插件）从头到尾没人提过。
  let pluginFailure: string | null = null
  if (appSettingsManager.getAutoEnableUnrealAgentLink()) {
    try {
      pluginFailure = (await ensureUnrealAgentLinkPlugin(uprojectPath)).pluginFailure
    } catch (pluginError) {
      pluginFailure = pluginError instanceof Error ? pluginError.message : String(pluginError)
      console.warn('[ProjectTool] 自动启用 UnrealAgentLink 插件失败:', pluginError)
    }
  }
  const pluginDetails = pluginFailure
    ? [
        `⚠️ UnrealAgentLink 插件没装上（${pluginFailure}）—— 这个工程连不上盒子，` +
          'ue.* 那些工具都用不了。让用户在工程卡片右键里手动安装一次。'
      ]
    : []

  // 使用 shell.openPath 打开 .uproject 文件
  const err = await shell.openPath(uprojectPath)
  if (err) {
    console.error(`[ProjectTool] shell.openPath 失败: ${err}`)
    return {
      success: false,
      error: `系统无法打开项目文件: ${err}。请检查 Unreal Engine 是否正确安装，以及 .uproject 文件关联是否正确。`
    }
  }

  console.log(`[ProjectTool] 已成功启动项目: ${project.projectName}`)
  return {
    success: true,
    projectName: project.projectName ?? undefined,
    openedPath: uprojectPath,
    ...(pluginDetails.length > 0 ? { details: pluginDetails } : {})
  }
}

/**
 * 通过路径打开项目（支持目录或 .uproject 文件路径）
 * @param projectPath - 项目目录路径或 .uproject 文件路径
 * @returns 打开结果，包含详细的成功/失败信息
 */
async function openProjectByPath(projectPath: string): Promise<OpenProjectResult> {
  console.log(`[ProjectTool] openProjectByPath 开始, projectPath: ${projectPath}`)

  let uprojectPath: string | null = null

  try {
    const stat = await fs.stat(projectPath)

    if (stat.isFile() && projectPath.endsWith('.uproject')) {
      // 直接是 .uproject 文件
      uprojectPath = projectPath
      console.log(`[ProjectTool] 路径是 .uproject 文件: ${uprojectPath}`)
    } else if (stat.isDirectory()) {
      // 是目录，扫描查找 .uproject 文件
      console.log(`[ProjectTool] 路径是目录，扫描查找 .uproject 文件...`)
      uprojectPath = await findUprojectInDirectory(projectPath)
      if (uprojectPath) {
        console.log(`[ProjectTool] 在目录中找到 .uproject 文件: ${uprojectPath}`)
      } else {
        return {
          success: false,
          error: `目录 "${projectPath}" 中未找到 .uproject 文件。请确认这是一个有效的虚幻引擎项目目录。`
        }
      }
    } else {
      return {
        success: false,
        error: `路径 "${projectPath}" 既不是 .uproject 文件也不是有效目录。`
      }
    }
  } catch {
    return {
      success: false,
      error: `路径不存在或无法访问: "${projectPath}"。请检查路径是否正确。`
    }
  }

  // 最终检查文件是否存在
  try {
    await fs.access(uprojectPath)
  } catch {
    return {
      success: false,
      error: `项目文件不存在: "${uprojectPath}"。该文件可能已被移动或删除。`
    }
  }

  const runningByPath = await alreadyRunning(uprojectPath)
  if (runningByPath === 'stuck') return stuckEditorResult(uprojectPath)
  if (runningByPath === 'yes') {
    console.log(`[ProjectTool] ${uprojectPath} 已经开着，不再启动一次`)
    return { success: true, openedPath: uprojectPath, details: ['♻️ 这个工程本来就开着'] }
  }

  console.log(`[ProjectTool] 即将打开: ${uprojectPath}`)

  // 如果启用了自动启用 UnrealAgentLink 插件设置，则在打开前确保插件被启用
  //
  // 装不上要**说给模型听**：它不抛异常，只在返回值里写原因。丢掉的话，工程照常打开，
  // 然后模型对着一个没插件的编辑器反复调 ue.* 工具，每次都是「引擎未连接」，
  // 而真正的原因（这个引擎版本没有随包插件）从头到尾没人提过。
  let pluginFailure: string | null = null
  if (appSettingsManager.getAutoEnableUnrealAgentLink()) {
    try {
      pluginFailure = (await ensureUnrealAgentLinkPlugin(uprojectPath)).pluginFailure
    } catch (pluginError) {
      pluginFailure = pluginError instanceof Error ? pluginError.message : String(pluginError)
      console.warn('[ProjectTool] 自动启用 UnrealAgentLink 插件失败:', pluginError)
    }
  }
  const pluginDetails = pluginFailure
    ? [
        `⚠️ UnrealAgentLink 插件没装上（${pluginFailure}）—— 这个工程连不上盒子，` +
          'ue.* 那些工具都用不了。让用户在工程卡片右键里手动安装一次。'
      ]
    : []

  // 使用 shell.openPath 打开 .uproject 文件
  const err = await shell.openPath(uprojectPath)
  if (err) {
    console.error(`[ProjectTool] shell.openPath 失败: ${err}`)
    return {
      success: false,
      error: `系统无法打开项目文件: ${err}。请检查 Unreal Engine 是否正确安装，以及 .uproject 文件关联是否正确。`
    }
  }

  console.log(`[ProjectTool] 已成功启动项目: ${uprojectPath}`)
  return {
    success: true,
    openedPath: uprojectPath,
    ...(pluginDetails.length > 0 ? { details: pluginDetails } : {})
  }
}

/**
 * 已经开着的工程不要再 `shell.openPath` 一次。
 *
 * 两条真实路径都会走到这儿：模型不知道工程已经开着就调了 `open_project`；
 * 以及会话归属挡下第一次切换、模型换完归属再调一次 —— 那时编辑器已经在启动了。
 * 再交给系统打开一次，Windows 会按文件关联再拉一个 UnrealEditor 进程，
 * 用户面前多出一个「工程已被占用」的弹窗，或者干脆开出第二个编辑器。
 *
 * 已经开着时直接跳过启动那一步：后面的等待和切目标照常做，
 * 于是「这个工程本来就开着」和「我刚把它打开」对调用方是同一种结果。
 */
/**
 * 这个工程是不是已经开着：连接表里有它，还得**真的答话**。
 *
 * 2026-09-26 真机反馈：编辑器崩了、进程都没了，连接表里还挂着一条僵尸记录，
 * 这里信了它，回「本来就开着」不肯启动。现在：
 * - 连着且答话（或者正忙着处理别的请求）→ `yes`
 * - 连接不答话、进程也没了 → 把僵尸连接断掉，当没开（`no`），照常启动
 * - 连接不答话、进程还在 → `stuck`：多半卡在崩溃处理或弹窗上。这时再启动一个
 *   就是两个编辑器抢同一个工程（反馈里正好出现过），宁可停下来说清楚
 */
async function alreadyRunning(uprojectPath: string): Promise<'yes' | 'no' | 'stuck'> {
  // `isSameProject` 自己会削掉 `.uproject` 并抹平大小写和斜杠方向，原样传进去就行
  const connectionId = findLiveConnection(uprojectPath)
  if (!connectionId) return 'no'
  const ws = serviceManager.getWebSocketService()
  if ((await ws.probeConnection(connectionId)) !== 'dead') return 'yes'
  ws.dropConnection(connectionId, 'open_project 探活不通')
  const process = await UnrealProcessDetector.findRunningProjectByPath(uprojectPath).catch(
    () => null
  )
  return process ? 'stuck' : 'no'
}

async function stuckEditorResult(uprojectPath: string): Promise<OpenProjectResult> {
  const process = await UnrealProcessDetector.findRunningProjectByPath(uprojectPath).catch(
    () => null
  )
  return {
    success: false,
    openedPath: uprojectPath,
    error:
      `这个工程的编辑器进程还在${process ? `（PID ${process.pid}）` : ''}，但不答话 —— ` +
      '多半卡在崩溃处理或弹窗上。再启动一个会变成两个编辑器抢同一个工程，所以没有启动。' +
      '请用户看一眼编辑器窗口（关掉崩溃报告或弹窗），或者结束那个进程后再打开。'
  }
}

/** `open_project` 的返回形状。多出来的几个字段全是「打开之后怎么样了」 */
interface OpenProjectResult {
  success: boolean
  error?: string
  projectName?: string
  openedPath?: string
  /** 那个工程已经连上盒子、并且回过一条只读命令 */
  connected?: boolean
  /** 这一轮剩下的引擎命令已经改发给新打开的工程了 */
  switched_target?: boolean
  waited_seconds?: number
  details?: string[]
}

/**
 * 打开之后的交接：等它连上，把这一轮切过去，把结果说成人话。
 *
 * ## 为什么这段必须在工具里做，不能让模型或用户去做
 *
 * 这一轮的目标工程是**收到用户消息那一刻**算好、定死在执行流上的
 * （`ipc/agentV3.ts` 的 `resolveTargetProject`）。`open_project` 从前打开完就
 * 立刻返回，于是新编辑器起来之后，这一轮剩下的每条引擎命令还是发往旧工程。
 * 模型只能停下来让用户去界面上切工程、或者再发一条消息 —— 而工具手里
 * 什么都不缺：是它打开的工程，路径是它自己给的。这就是自己该收的尾。
 *
 * ## 三种结局都要说清楚
 *
 * - **切过去了**：告诉模型可以接着干，别再自己去核连接。
 * - **会话被钉住**：用户把这条会话归到别的工程下了，切过去等于越界
 *   （见 `core/sessionScope.ts`）。这一条挡得对，但必须让模型把原因转告用户，
 *   而不是自己憋着重试。
 * - **没等到**：工程可能编译很久，也可能插件没装。不谎报 —— 说清楚等了多久、
 *   最后卡在哪，让模型和用户各自知道下一步。
 */
export async function handOffToOpenedProject(
  openedPath: string,
  options: { waitSeconds?: number; signal?: AbortSignal }
): Promise<{
  connected: boolean
  switched_target: boolean
  waited_seconds: number
  details: string[]
}> {
  const projectDir = path.dirname(openedPath)
  const projectName = path.basename(openedPath, '.uproject')
  const timeoutMs =
    typeof options.waitSeconds === 'number'
      ? Math.min(Math.max(options.waitSeconds, 0) * 1000, MAX_WAIT_MS)
      : DEFAULT_WAIT_MS

  const result = await awaitProjectLive({
    projectPath: projectDir,
    timeoutMs,
    ...(options.signal ? { signal: options.signal } : {})
  })

  const seconds = Math.round(result.waitedMs / 1000)
  const details: string[] = []

  if (result.live) {
    details.push(`✅ ${projectName} 已连上盒子（等了 ${seconds} 秒），引擎命令验证可用`)
    if (result.retargeted) {
      details.push(
        `🎯 这一轮剩下的引擎命令已经改发给 ${projectName} —— 直接接着干，` +
          '不用让用户去界面上切工程，也不用等下一条消息。'
      )
    }
  } else if (result.retargetBlocked === 'session-scoped') {
    details.push(
      `⚠️ ${projectName} 已启动，但这条对话归属的是另一个工程` +
        `${result.sessionProjectPath ? `（${result.sessionProjectPath}）` : ''}，` +
        '所以引擎命令仍然发往归属的那个工程。' +
        `接下来的活如果就在 ${projectName} 里做，用 set_session_project 把这条对话` +
        '改挂过来，然后重新调一次 open_project —— 不要请用户去界面上改。' +
        '拿不准用户是不是真要换工程，就用 ask_user 问一句。'
    )
  } else if (result.connectionSeen && !result.probeFailed) {
    /*
     * 连上了、而且**一次都没探过** —— 和「压根没连上」是两码事，不能报同一句话。
     *
     * `waitSeconds: 0`（schema 上写着「立刻返回」）在一个本来就开着的工程上就会
     * 走到这里：目标已经切过去了，命令实打实发得出去，而「还没连上盒子」那句
     * 会和同一个返回值里的 `switched_target: true` 自相矛盾，模型只能猜。
     *
     * **探过并且失败了不走这条**（下面那条）。那种情况编辑器多半卡在编译着色器上，
     * 说「只是没验」等于劝模型对着一个死掉的游戏线程接着发命令。
     */
    details.push(
      `ℹ️ ${projectName} 已经连着盒子，但这次没做回读校验` +
        `${result.lastError ? `（${result.lastError}）` : ''}。` +
        (result.retargeted ? '这一轮的引擎命令已经发往它；' : '') +
        '请对同一工程用 open_project、waitSeconds: 5 做就绪校验，connected=true 后再执行引擎命令。'
    )
  } else if (result.connectionSeen) {
    // 连着，但回读命令发出去就是不回。等了多久要说出来，别缩成「只是没验」
    details.push(
      `⚠️ ${projectName} 连上了盒子，但等了 ${seconds} 秒都不回话` +
        `${result.lastError ? `（${result.lastError}）` : ''}。` +
        '多半是编辑器还在编译着色器 / 加载资产，游戏线程腾不出手。' +
        '别当它已经能用 —— 用 ue_session_health 确认过再发引擎命令。'
    )
  } else if (timeoutMs === 0 && !options.signal?.aborted) {
    details.push(
      `ℹ️ ${projectName} 已启动，正在加载，本次不等待编辑器就绪。` +
        '这不是打开失败，不要重复启动工程。用 ue_session_health 查询连接列表，' +
        '确认目标工程路径已连接后，对同一工程用 open_project、waitSeconds: 5 校验就绪并切换目标；' +
        'connected=true 后再执行引擎命令。'
    )
  } else {
    details.push(
      `⚠️ ${projectName} 已启动，但等了 ${seconds} 秒还没连上盒子` +
        `${result.lastError ? `（${result.lastError}）` : ''}。` +
        '大工程首次打开要编译，可能还得再等；也可能是 UnrealAgentLink 插件没启用。' +
        '用 ue_session_health 复查，别当它已经能用。'
    )
  }

  return {
    connected: result.live,
    switched_target: result.retargeted,
    waited_seconds: seconds,
    details
  }
}

/**
 * 判断文件是否为 UE 原生资产（.uasset / .umap）
 */
function isUAssetFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase()
  return ext === '.uasset' || ext === '.umap'
}

/**
 * 是否为可直接放入场景的资产类型
 */
function isSpawnableAssetClass(assetClass: string): boolean {
  const normalized = String(assetClass || '').toLowerCase()
  return (
    normalized.includes('staticmesh') ||
    normalized.includes('skeletalmesh') ||
    normalized.includes('blueprint')
  )
}

function resolveImportedAssetClass(args: {
  assetClass?: string
  className?: string
  assetName?: string
  softPath?: string
}): string {
  const candidates = [args.className, args.assetClass]
    .map((value) => String(value || '').trim())
    .filter(Boolean)

  for (const candidate of candidates) {
    const normalized = candidate.toLowerCase()
    if (
      normalized.includes('staticmesh') ||
      normalized.includes('skeletalmesh') ||
      normalized.includes('blueprint')
    ) {
      return candidate
    }
  }

  const identity = `${String(args.assetName || '')} ${String(args.softPath || '')}`.toLowerCase()
  if (/(^|[/\s])sm_/.test(identity)) {
    return 'StaticMesh'
  }
  if (/(^|[/\s])(sk_|skeletalmesh)/.test(identity)) {
    return 'SkeletalMesh'
  }
  if (/(^|[/\s])(bp_|abp_)/.test(identity)) {
    return 'Blueprint'
  }

  const fallback = candidates.find(
    (candidate) => !['uasset', 'umap'].includes(candidate.toLowerCase())
  )
  return fallback || String(args.className || args.assetClass || '')
}

/** 结算给出的失败原因翻成一句话。模型读到的必须是「怎么办」，不是一个枚举值 */
function describeImportFailure(reason: ImportFailureReason | undefined): string {
  switch (reason) {
    case 'missing-dependency':
      return '依赖不完整，缺的东西列在下面'
    case 'file-not-written':
      return '文件没能写进工程'
    case 'unconfirmed':
      return '依赖太多，没能确认是否导全'
    default:
      return '导入失败'
  }
}

/** 一条依赖找不到，究竟是哪种找不到 —— 三种的下一步完全不同 */
function describeMissingState(state: MissingDependencyState): string {
  switch (state) {
    case 'source-missing':
      return '保管库里有记录，但源文件丢了'
    case 'unresolved':
      return '保管库里有、源文件也在，但这次没能定位到'
    default:
      return '保管库里没有这个资产'
  }
}

/**
 * 将 Content 目录下的物理文件路径转换为 UE /Game 资源路径
 */
function filePathToUePath(filePath: string, contentBase: string): string | undefined {
  const resolvedContentBase = path.resolve(contentBase)
  const resolvedFilePath = path.resolve(filePath)
  const relativePath = path.relative(resolvedContentBase, resolvedFilePath)

  if (!relativePath || relativePath.startsWith('..')) {
    return undefined
  }

  const normalizedRelative = relativePath.replace(/\\/g, '/')
  const ueRelative = normalizedRelative.replace(/\.(uasset|umap|uexp|ubulk|uptnl)$/i, '')
  return `/Game/${ueRelative}`.replace(/\/+/g, '/')
}

/**
 * 从 /Game 路径构造 actor.spawn 更稳定的引用形式
 */
function buildSpawnReference(uePath: string, assetClass: string): string {
  const normalizedPath = String(uePath || '').trim()
  if (!normalizedPath.startsWith('/Game/')) {
    return normalizedPath
  }

  if (normalizedPath.includes('.')) {
    return normalizedPath
  }

  const leaf = normalizedPath.split('/').pop() || 'Asset'
  if (
    String(assetClass || '')
      .toLowerCase()
      .includes('blueprint')
  ) {
    return `${normalizedPath}.${leaf}_C`
  }

  return `${normalizedPath}.${leaf}`
}

/**
 * 计算批量摆放位置
 */
function buildPlacementLocation(
  index: number,
  placement?: ScenePlacementOptions
): {
  x: number
  y: number
  z: number
} {
  const layout = placement?.layout || 'line'
  const spacing = placement?.spacing ?? 300
  const columns = placement?.columns ?? 5
  const origin = placement?.origin || {}
  const baseX = origin.x ?? 0
  const baseY = origin.y ?? 0
  const baseZ = origin.z ?? 0

  if (layout === 'grid') {
    const col = index % columns
    const row = Math.floor(index / columns)
    return {
      x: baseX + col * spacing,
      y: baseY + row * spacing,
      z: baseZ
    }
  }

  return {
    x: baseX + index * spacing,
    y: baseY,
    z: baseZ
  }
}

function toPythonJsonLiteral(value: unknown): string {
  return JSON.stringify(JSON.stringify(value))
}

/* 这里原来有一份和 core/editorPython.ts 一模一样的「临时文件 + 轮询」实现。
   已收敛到 runEditorPython —— 调用点直接用它。 */

function normalizeSequenceFolderPath(folderPath?: string): string {
  const raw = String(folderPath || '/Game/Cinematics').trim()
  if (!raw) return '/Game/Cinematics'
  const normalized = raw.replace(/\\/g, '/').replace(/\/+/g, '/')
  return normalized.startsWith('/Game/') ? normalized.replace(/\/$/, '') : '/Game/Cinematics'
}

function inferActorAssetClass(assetPath?: string, assetClassHint?: string): string {
  const normalizedHint = String(assetClassHint || '').trim()
  if (normalizedHint) {
    return normalizedHint
  }

  return resolveImportedAssetClass({
    assetClass: '',
    className: normalizedHint,
    assetName:
      String(assetPath || '')
        .split('/')
        .pop() || '',
    softPath: assetPath
  })
}

async function spawnActorForSequence(options: SequenceSetupOptions): Promise<{
  success: boolean
  error?: string
  actorPath?: string
  details: string[]
}> {
  const assetPath = String(options.actorAssetPath || '').trim()
  if (!assetPath) {
    return { success: false, error: '缺少 actorAssetPath', details: [] }
  }

  const assetClass = inferActorAssetClass(assetPath, options.actorAssetClass)
  const reference =
    assetPath.startsWith('/Game/') && !assetPath.includes('.')
      ? buildSpawnReference(assetPath, assetClass)
      : assetPath

  const wsService = serviceManager.getWebSocketService()
  const payload = {
    ver: '2.0' as const,
    instances: [
      {
        asset_id: reference,
        name: options.actorLabel || undefined,
        transform: {
          location: options.spawnTransform?.location,
          rotation: options.spawnTransform?.rotation,
          scale: options.spawnTransform?.scale
        }
      }
    ]
  }

  const response = await wsService.callRequest<{
    ok?: boolean
    success?: boolean
    count?: number
    created?: Array<Record<string, unknown> | null>
    error?: string
  }>('actor.spawn', payload, getTargetConnectionId(), 60000)

  const createdActors = Array.isArray(response?.created)
    ? response.created.filter(
        (item): item is Record<string, unknown> => item !== null && item !== undefined
      )
    : []

  const createdActor = createdActors[0]
  const actorPath =
    createdActor && typeof createdActor.path === 'string' ? String(createdActor.path) : undefined

  if (!actorPath) {
    return {
      success: false,
      error: response?.error || 'actor.spawn did not return an actor path',
      details: []
    }
  }

  return {
    success: true,
    actorPath,
    details: [`🎭 已在关卡生成角色 Actor: ${String(createdActor.name || actorPath)}`]
  }
}

async function setupLevelSequence(options: SequenceSetupOptions): Promise<SequenceSetupResult> {
  const sequenceName = String(options.sequenceName || '').trim()
  if (!sequenceName) {
    return { success: false, error: '需要 sequenceName 参数' }
  }

  if (options.animationAssetPath && !options.actorAssetPath && !options.existingActorPath) {
    return {
      success: false,
      error: '设置动画时需要 actorAssetPath 或 existingActorPath 作为绑定对象'
    }
  }

  const details: string[] = []
  let actorPath = String(options.existingActorPath || '').trim()
  let actorCreated = false

  if (!actorPath && options.actorAssetPath) {
    const spawnResult = await spawnActorForSequence(options)
    if (!spawnResult.success) {
      return { success: false, error: spawnResult.error || '角色生成失败', details }
    }
    actorPath = String(spawnResult.actorPath || '')
    actorCreated = true
    details.push(...spawnResult.details)
  }

  const sequenceFolderPath = normalizeSequenceFolderPath(options.sequenceFolderPath)
  const pythonConfig = {
    sequence_name: sequenceName,
    sequence_folder_path: sequenceFolderPath,
    open_sequence: options.openSequence !== false,
    actor_path: actorPath || '',
    animation_asset_path: String(options.animationAssetPath || '').trim(),
    sequence_length_seconds:
      typeof options.sequenceLengthSeconds === 'number' ? options.sequenceLengthSeconds : null
  }

  const pythonScript = `
import json
import unreal

config = json.loads(${toPythonJsonLiteral(pythonConfig)})

def _load_asset(asset_path):
    if not asset_path:
        return None
    asset = unreal.EditorAssetLibrary.load_asset(asset_path)
    if asset:
        return asset
    raise RuntimeError(f"Failed to load asset: {asset_path}")

def _find_actor(actor_path):
    if not actor_path:
        return None
    actor_subsystem = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
    for actor in actor_subsystem.get_all_level_actors():
        if actor.get_path_name() == actor_path:
            return actor
    raise RuntimeError(f"Failed to find actor in level: {actor_path}")

def _get_anim_length_seconds(animation_asset):
    getter = getattr(animation_asset, "get_play_length", None)
    if callable(getter):
        try:
            return float(getter())
        except Exception:
            pass
    for prop_name in ("sequence_length", "play_length"):
        try:
            value = animation_asset.get_editor_property(prop_name)
            if value is not None:
                return float(value)
        except Exception:
            pass
    return None

def _get_sequence_fps(sequence):
    display_rate = sequence.get_display_rate()
    numerator = float(getattr(display_rate, "numerator", 30.0) or 30.0)
    denominator = float(getattr(display_rate, "denominator", 1.0) or 1.0)
    return numerator / denominator if denominator else 30.0

def _set_sequence_playback_range(sequence, duration_seconds):
    if not duration_seconds:
        return
    fps = _get_sequence_fps(sequence)
    end_frame = max(1, int(round(float(duration_seconds) * fps)))
    if hasattr(sequence, "set_playback_start"):
        sequence.set_playback_start(0)
        sequence.set_playback_end(end_frame)
        return
    if hasattr(sequence, "set_playback_start_seconds"):
        sequence.set_playback_start_seconds(0.0)
        sequence.set_playback_end_seconds(float(duration_seconds))

def _set_section_range(section, duration_seconds, fps):
    if not duration_seconds:
        return
    end_frame = max(1, int(round(float(duration_seconds) * fps)))
    if hasattr(section, "set_range"):
        section.set_range(0, end_frame)
        return
    if hasattr(section, "set_start_frame_bounded"):
        section.set_start_frame_bounded(0)
    if hasattr(section, "set_end_frame_bounded"):
        section.set_end_frame_bounded(end_frame)

with unreal.ScopedEditorTransaction("Agent Setup Level Sequence"):
    sequence_folder_path = str(config.get("sequence_folder_path") or "/Game/Cinematics").rstrip("/")
    sequence_name = str(config.get("sequence_name") or "").strip()
    if not sequence_name:
        raise RuntimeError("sequence_name is required")

    sequence_asset_path = f"{sequence_folder_path}/{sequence_name}"
    sequence_created = False

    if unreal.EditorAssetLibrary.does_asset_exist(sequence_asset_path):
        sequence = _load_asset(sequence_asset_path)
    else:
        asset_tools = unreal.AssetToolsHelpers.get_asset_tools()
        factory = unreal.LevelSequenceFactoryNew()
        sequence = asset_tools.create_asset(
            asset_name=sequence_name,
            package_path=sequence_folder_path,
            asset_class=unreal.LevelSequence,
            factory=factory
        )
        if not sequence:
            raise RuntimeError(f"Failed to create LevelSequence: {sequence_asset_path}")
        sequence_created = True

    if bool(config.get("open_sequence")):
        try:
            unreal.LevelSequenceEditorBlueprintLibrary.open_level_sequence(sequence)
        except Exception:
            asset_editor = unreal.get_editor_subsystem(unreal.AssetEditorSubsystem)
            asset_editor.open_editor_for_assets([sequence])

    actor_path = str(config.get("actor_path") or "").strip()
    animation_asset_path = str(config.get("animation_asset_path") or "").strip()
    actor_binding_added = False
    animation_applied = False

    if actor_path:
        actor = _find_actor(actor_path)
        level_sequence_subsystem = unreal.get_editor_subsystem(unreal.LevelSequenceEditorSubsystem)
        bindings = level_sequence_subsystem.add_actors([actor])
        if not bindings:
            raise RuntimeError(f"Failed to add actor to sequence: {actor_path}")
        actor_binding_added = True

        if animation_asset_path:
            animation_asset = _load_asset(animation_asset_path)
            binding = bindings[0]
            animation_track = binding.add_track(unreal.MovieSceneSkeletalAnimationTrack)
            if not animation_track:
                raise RuntimeError("Failed to create skeletal animation track")
            animation_section = animation_track.add_section()
            if not animation_section:
                raise RuntimeError("Failed to create skeletal animation section")

            params = animation_section.get_editor_property("params")
            try:
                params.set_editor_property("animation", animation_asset)
            except Exception:
                params.set_editor_property("animation_asset", animation_asset)
            animation_section.set_editor_property("params", params)

            duration_seconds = config.get("sequence_length_seconds")
            if duration_seconds is None:
                duration_seconds = _get_anim_length_seconds(animation_asset)

            _set_section_range(animation_section, duration_seconds, _get_sequence_fps(sequence))
            _set_sequence_playback_range(sequence, duration_seconds)
            animation_applied = True

    unreal.EditorAssetLibrary.save_loaded_asset(sequence)

output_data = {
    "sequence_path": sequence_asset_path,
    "sequence_created": sequence_created,
    "actor_path": actor_path,
    "actor_binding_added": actor_binding_added,
    "animation_path": animation_asset_path,
    "animation_applied": animation_applied
}
`

  const pythonResult = await runEditorPython(
    pythonScript,
    `setting up level sequence ${sequenceName}`
  )

  if (!pythonResult.success) {
    return {
      success: false,
      error: pythonResult.error || 'Level Sequence setup failed',
      details
    }
  }

  const output = pythonResult.output || {}
  const sequencePath = String(output.sequence_path || '')
  const animationPath = String(output.animation_path || '')
  const actorBindingAdded = output.actor_binding_added === true
  const animationApplied = output.animation_applied === true
  const sequenceCreated = output.sequence_created === true

  details.push(
    `${sequenceCreated ? '✅' : '♻️'} 定序器: ${sequencePath || `${sequenceFolderPath}/${sequenceName}`}`
  )
  if (actorPath) {
    details.push(`${actorBindingAdded ? '✅' : '⚠️'} 已绑定角色到 Sequencer: ${actorPath}`)
  }
  if (animationPath) {
    details.push(`${animationApplied ? '✅' : '⚠️'} 已添加动画轨: ${animationPath}`)
  }

  return {
    success: true,
    details,
    sequence_path: sequencePath || `${sequenceFolderPath}/${sequenceName}`,
    sequence_created: sequenceCreated,
    actor_path: actorPath || undefined,
    actor_created: actorCreated,
    actor_binding_added: actorBindingAdded,
    animation_path: animationPath || undefined,
    animation_applied: animationApplied,
    output: {
      sequencePath: sequencePath || `${sequenceFolderPath}/${sequenceName}`,
      actorPath: actorPath || undefined,
      animationPath: animationPath || undefined
    }
  }
}

/**
 * 一次导入的目标工程。
 *
 * `connected` 是这里的关键：它把「工程有没有开着」从**一道总闸**降级成一个属性。
 * .uasset 导入是纯文件拷贝（拷进 `<工程>/Content/` 再解析依赖），全程不碰引擎，
 * 工程关着照样导得了。真正需要活编辑器的只有两件事 —— 走引擎导入 API 的外部
 * 文件（FBX/PNG/OBJ…），和把资产放进当前关卡。原先这道闸横在函数开头一刀切，
 * 于是「导 88 个 .uasset 动画」也被逼着先把工程打开。
 */
interface ImportTarget {
  record: ProjectImportProjectRecord
  /** 这个工程此刻有交互式编辑器连着 */
  connected: boolean
  /** 连着时的连接 id。发引擎命令要显式带上它，别让底层去猜是哪个工程 */
  connectionId?: string
}

/**
 * 两个路径指的是不是同一个工程。
 *
 * 大小写、斜杠方向、结尾斜杠、带不带 `.uproject` 后缀都可能不一致：
 * 插件报上来的是工程目录，项目库里存的可能是 `.uproject` 文件。
 * 比不出来的后果不是报错而是**认不出工程正开着**，于是外部文件导入被误挡。
 */
export function isSameProject(a: string | null | undefined, b: string | null | undefined): boolean {
  // 用全仓库唯一那把尺子。这里以前是自己写的 `dirOf`，它的
  // `raw.slice(0, raw.lastIndexOf('/'))` 在没有分隔符时会把
  // `'MyGame.uproject'` 啃成 `'mygame.uprojec'` —— 非空、过得了空值闸、
  // 和谁都比不上。而 `open_project` 的 projectPath 是允许给裸名字的
  return isSameProjectPath(a, b)
}

/** 读 `.uproject` 里的 EngineAssociation。可能是 `5.5`，也可能是自编译引擎的 GUID */
async function readEngineAssociation(uprojectPath: string): Promise<string | undefined> {
  try {
    const parsed = await readUeJsonFile<{ EngineAssociation?: unknown }>(uprojectPath)
    return String(parsed?.EngineAssociation ?? '').trim() || undefined
  } catch {
    return undefined
  }
}

/** 把一个目录或 `.uproject` 路径整理成导入记录；找不到 `.uproject` 就返回 null */
async function buildImportRecord(
  rawPath: string | null | undefined,
  known?: { projectName?: string; engineVersion?: string | null }
): Promise<ProjectImportProjectRecord | null> {
  const value = String(rawPath || '').trim()
  if (!value) return null

  const originPath = value.toLowerCase().endsWith('.uproject')
    ? value
    : await findUprojectInDirectory(value)
  if (!originPath) return null

  // 工程关着时没有连接可问引擎版本，只能读 `.uproject` 自己写的 EngineAssociation。
  // 版本闸（高版本资产不许进低版本工程，见 `importUAssetsToProject`）就挂在这个
  // 字段上 —— 缺了它闸门会静默失效，用户拿到一个打不开的工程。自编译引擎写的是
  // GUID，`resolveProjectEngineVersion` 认得，原样传下去即可。
  const engineVersion = known?.engineVersion || (await readEngineAssociation(originPath))

  return {
    projectName: known?.projectName || path.basename(originPath, '.uproject'),
    projectPath: path.dirname(originPath),
    originPath,
    EngineAssociation: engineVersion ?? null
  }
}

/** 这个工程此刻连着的那个交互式编辑器 */
function findLiveConnection(projectPath: string | null | undefined): string | undefined {
  try {
    return projectManager
      .getInteractiveProjects()
      .find((project) => isSameProject(project.projectPath, projectPath))?.connectionId
  } catch {
    return undefined
  }
}

/**
 * 定这次导入的目标工程。
 *
 * 点名了 projectKey / projectPath 就按点名的来 —— 项目库里存着每个工程的路径，
 * 工程开不开都查得到，这就是「不打开也能导」的依据。没点名则沿用老行为：
 * 跟着这一轮绑定的连接走。
 */
async function resolveImportTarget(ref?: {
  projectKey?: string
  projectPath?: string
}): Promise<{ target?: ImportTarget; error?: string }> {
  let record: ProjectImportProjectRecord | null = null

  if (ref?.projectKey) {
    const project = getAllProjects(getPublicDatabase()).find(
      (item: ProjectRecord) => item.projectKey === ref.projectKey
    )
    if (!project) {
      return {
        error: `项目库里没有 projectKey 为 "${ref.projectKey}" 的工程。用 project_list(action="list_projects") 拿正确的 projectKey。`
      }
    }
    const known = {
      projectName: project.projectName ?? undefined,
      engineVersion: project.EngineAssociation
    }
    record =
      (await buildImportRecord(project.originPath, known)) ??
      (await buildImportRecord(project.projectPath, known))
    if (!record) {
      return {
        error:
          `工程 "${project.projectName ?? ref.projectKey}" 的 .uproject 找不到了` +
          `（记录的路径：${project.originPath || project.projectPath || '空'}），可能已被移动或删除。`
      }
    }
  } else if (ref?.projectPath) {
    record = await buildImportRecord(ref.projectPath)
    if (!record) {
      return { error: `"${ref.projectPath}" 既不是工程目录也不是 .uproject 文件，找不到工程。` }
    }
  } else {
    const targetConnectionId = getTargetConnectionId()
    const connectedProject = targetConnectionId
      ? projectManager.getProject(targetConnectionId)
      : projectManager.getCurrentProject()
    if (!connectedProject?.projectPath) {
      return {
        error:
          '没说要导进哪个工程：用 projectKey（project_list(action="list_projects") 里查）或 projectPath 点名一个，' +
          '或者先把工程打开。.uasset 资产不需要工程开着，点名就能导。'
      }
    }
    record = await buildImportRecord(connectedProject.projectPath, {
      projectName: connectedProject.projectName,
      engineVersion: connectedProject.engineVersion
    })
    if (!record) {
      return { error: `无法解析工程 "${connectedProject.projectName}" 的 .uproject 路径` }
    }
  }

  /*
   * 「项目对项目」在这条路上的落点。
   *
   * 这里是**唯一**一个按参数点名工程、还会往里写东西的入口：导入动作是
   * `project` 命名空间，不受「归属工程没连着就不给 ue.* 工具」那道过滤影响，
   * 而且下面放场景那一步会自己开一个嵌套的执行流上下文，压根不读外面那个
   * store。所以一条挂在 A 下面的对话曾经可以把资产拷进 B、把 Actor 生成到 B
   * 的关卡里，全程没有任何拦截。挡在这里，前面所有分支都要过它。
   */
  if (isOutOfSessionScope(record.projectPath)) {
    return {
      error:
        `这条对话归属的是「${getSessionProjectPath()}」，不能往「${record.projectPath}」里导东西。` +
        '真要换工程干活，先用 set_session_project 把这条对话改挂过去；' +
        '拿不准用户是不是想换，用 ask_user 问一句。'
    }
  }

  const connectionId = findLiveConnection(record.projectPath)
  return {
    target: { record, connected: Boolean(connectionId), ...(connectionId ? { connectionId } : {}) }
  }
}

/**
 * 一个资产该走哪条路进工程。
 *
 * - `copy`：`.uasset` / `.umap`，拷进 `<工程>/Content/` 并解析依赖，不碰引擎，
 *   **工程开不开都能导**。
 * - `engine`：FBX / PNG / OBJ 这类外部文件，必须过引擎的导入 API 才能变成资产。
 * - `needs-editor`：同上，但目标工程此刻没连着编辑器，这一个这次做不了。
 */
export function routeAssetImport(args: {
  filePath: string
  softPath?: string
  editorConnected: boolean
}): 'copy' | 'engine' | 'needs-editor' {
  if (isUAssetFile(args.filePath) || String(args.softPath || '').startsWith('/Game/')) {
    return 'copy'
  }
  return args.editorConnected ? 'engine' : 'needs-editor'
}

/**
 * 获取目标项目 Content 目录
 */
function getProjectContentBase(project: ProjectImportProjectRecord): string {
  const uprojectPath = String(project.originPath || project.projectPath || '')
  const projectDir = uprojectPath.endsWith('.uproject') ? path.dirname(uprojectPath) : uprojectPath
  return path.join(projectDir, 'Content')
}

/**
 * 下载远程 HTTP 资产库文件到本地临时目录
 */
async function downloadRemoteVaultFile(
  serverBaseUrl: string,
  vaultId: string,
  relativeFilePath: string,
  tempDir: string
): Promise<string> {
  const encodedPath = relativeFilePath
    .replace(/\\/g, '/')
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
  const fileUrl = `${serverBaseUrl}/api/vaults/${encodeURIComponent(vaultId)}/files/${encodedPath}`
  const tempFilePath = path.join(tempDir, `${Date.now()}_${path.basename(relativeFilePath)}`)

  return new Promise((resolve, reject) => {
    const client = fileUrl.startsWith('https') ? https : http
    // 服务端对文件下载也鉴权，不带码会 401
    const req = client.get(
      fileUrl,
      { timeout: 60000, headers: vaultAccessKeyHeadersFromUrl(fileUrl) },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume()
          reject(new Error(`下载文件失败: HTTP ${res.statusCode} (${fileUrl})`))
          return
        }

        const writeStream = nodeFs.createWriteStream(tempFilePath)
        res.pipe(writeStream)

        writeStream.on('finish', () => {
          writeStream.close(() => resolve(tempFilePath))
        })

        writeStream.on('error', (error) => {
          try {
            nodeFs.unlinkSync(tempFilePath)
          } catch {
            // Ignore cleanup failures.
          }
          reject(error)
        })
      }
    )

    req.on('error', (error) => reject(error))
    req.on('timeout', () => {
      req.destroy()
      reject(new Error(`下载文件超时: ${fileUrl}`))
    })
  })
}

/**
 * 解析外部文件在当前 vault 中的真实本地路径
 */
async function resolveExternalAssetPath(asset: AssetData, tempDir: string): Promise<string> {
  const currentVault = getDatabaseManager().getVaultManager().getCurrentVault()
  if (!currentVault) {
    throw new Error('当前保管库不存在')
  }

  if (
    currentVault.vaultType === VaultType.NETWORK &&
    currentVault.networkPath &&
    (currentVault.networkPath.startsWith('http://') ||
      currentVault.networkPath.startsWith('https://'))
  ) {
    const urlObj = new URL(currentVault.networkPath)
    const serverBaseUrl = `${urlObj.protocol}//${urlObj.host}`
    const vaultId = urlObj.pathname.replace(/^\//, '')
    let relativePath = String(asset.filePath || asset.originPath || '')

    const isAbsoluteWindows = /^[A-Za-z]:[\\/]/.test(relativePath)
    const isAbsoluteUnix = relativePath.startsWith('/') && !relativePath.startsWith('/Game/')
    if (!relativePath || isAbsoluteWindows || isAbsoluteUnix) {
      relativePath = path.basename(
        relativePath || String(asset.originPath || asset.assetName || '')
      )
    }

    return downloadRemoteVaultFile(serverBaseUrl, vaultId, relativePath, tempDir)
  }

  // filePath（保管库里的那一份）排在 originPath（当初从哪儿导入的）前面。
  //
  // 反过来排会在最常见的场景里当场翻车：备份类型的库把文件复制进了库，
  // 用户把导入用的那个源目录一删（解压的临时目录尤其如此），originPath 就成了
  // 死路径 —— 而库里的副本一直好好的。
  //
  // 而且这里以前是 `await fs.access(candidate)` 裸调用：源文件不在时它直接抛出去，
  // 循环根本走不到下一个候选，库里的副本连试都没试过。
  const candidates = [asset.filePath, asset.originPath]
    .map((value) => String(value || '').trim())
    .filter(Boolean)

  for (const candidate of candidates) {
    if (path.isAbsolute(candidate)) {
      try {
        await fs.access(candidate)
        return candidate
      } catch {
        continue
      }
    }

    const baseDirs = [
      currentVault.vaultType === VaultType.NETWORK &&
      currentVault.networkPath &&
      !currentVault.networkPath.startsWith('http')
        ? currentVault.networkPath
        : '',
      currentVault.path
    ].filter(Boolean)

    for (const baseDir of baseDirs) {
      const fullPath = path.join(baseDir, candidate)
      try {
        await fs.access(fullPath)
        return fullPath
      } catch {
        // Try next candidate.
      }
    }
  }

  throw new Error(`文件不存在或不可访问: ${asset.assetName || asset.assetKey || 'unknown asset'}`)
}

/**
 * 根据导入结果构造统一的资产摘要
 */
function buildImportedAssetSummary(args: {
  assetKey: string
  assetName: string
  assetClass: string
  className?: string
  softPath?: string
  uePath?: string
  sourceType: 'uasset' | 'external'
  imported: boolean
  alreadyExists?: boolean
}): ImportedAssetSummary {
  const resolvedAssetClass = resolveImportedAssetClass({
    assetClass: args.assetClass,
    className: args.className,
    assetName: args.assetName,
    softPath: args.softPath || args.uePath
  })
  const spawnable = isSpawnableAssetClass(resolvedAssetClass)
  return {
    ...args,
    assetClass: resolvedAssetClass,
    spawnable,
    reference:
      args.uePath && spawnable ? buildSpawnReference(args.uePath, resolvedAssetClass) : undefined
  }
}

/**
 * 在场景中放置已导入的可实例化资产
 */
async function placeImportedAssetsInScene(
  spawnCandidates: ImportedAssetSummary[],
  placement?: ScenePlacementOptions
): Promise<{
  placedActors: Array<Record<string, unknown>>
  placedCount: number
  details: string[]
}> {
  const details: string[] = []
  if (spawnCandidates.length === 0) {
    return { placedActors: [], placedCount: 0, details }
  }

  const wsService = serviceManager.getWebSocketService()
  const placedActors: Array<Record<string, unknown>> = []
  let placedCount = 0

  for (let offset = 0; offset < spawnCandidates.length; offset += 100) {
    const chunk = spawnCandidates.slice(offset, offset + 100)
    const instances = chunk.map((asset, index) => ({
      asset_id: asset.reference,
      name: asset.assetName || undefined,
      transform: {
        location: buildPlacementLocation(offset + index, placement),
        rotation: placement?.rotation,
        scale: placement?.scale
      }
    }))

    const response = await wsService.callRequest<{
      ok?: boolean
      success?: boolean
      count?: number
      created?: Array<Record<string, unknown> | null>
      error?: string
    }>('actor.spawn', { ver: '2.0', instances }, getTargetConnectionId(), 60000)

    if (!(response?.ok || response?.success || (response?.count ?? 0) > 0)) {
      throw new Error(response?.error || 'actor.spawn 未返回成功结果')
    }

    const createdActors = Array.isArray(response.created)
      ? response.created.filter(
          (item): item is Record<string, unknown> => item !== null && item !== undefined
        )
      : []

    placedActors.push(...createdActors)
    placedCount += response?.count ?? createdActors.length

    for (const actor of createdActors) {
      details.push(`🎬 放置 Actor: ${String(actor.name || actor.path || 'Unknown')}`)
    }

    if (placement?.snapToFloor) {
      const actorPaths = createdActors
        .map((actor) => String(actor.path || ''))
        .filter((value) => value.length > 0)

      if (actorPaths.length > 0) {
        try {
          await wsService.callRequest(
            'actor.set_transform',
            {
              targets: { paths: actorPaths },
              operation: { snap_to_floor: true }
            },
            getTargetConnectionId(),
            60000
          )
          details.push(`📐 已对 ${actorPaths.length} 个 Actor 执行贴地`)
        } catch (error) {
          details.push(`⚠️ 贴地失败: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
  }

  return { placedActors, placedCount, details }
}

/**
 * 从资产库导入资产到 UE 项目，并可选择直接放入场景
 */
async function importAssetsToProject(
  assetKeys: string[],
  destinationPath: string,
  options?: {
    placeInScene?: boolean
    scenePlacement?: ScenePlacementOptions
    /** 素材库里的文件夹：folderKey、完整路径（/ALL/角色）或文件夹名 */
    folder?: string
    includeSubfolders?: boolean
    folderOffset?: number
    /** 点名导进哪个工程。不给就跟着这一轮绑定的连接走（老行为） */
    target?: { projectKey?: string; projectPath?: string }
    /** 外部 FBX 按动画导入到这个骨架 */
    skeleton?: string
    fbxImportAs?: string
    animFrameRate?: number
    /** 覆盖同名资产（仅外部格式文件） */
    overwrite?: boolean
    /** assetKey → 导入后的资产名 */
    assetNames?: Record<string, string>
  }
): Promise<ProjectImportResult> {
  const placeInScene = options?.placeInScene === true
  console.log(
    `[ProjectTool] ${placeInScene ? 'import_assets_to_scene' : 'import_assets'} 开始, assetKeys: ${assetKeys.join(', ')}${options?.folder ? `, folder: ${options.folder}` : ''}`
  )

  const resolved = await resolveImportTarget(options?.target)
  if (!resolved.target) {
    return { success: false, error: resolved.error ?? '无法确定导入目标工程' }
  }
  const { record: projectRecord, connected, connectionId } = resolved.target

  // 放进场景是往活着的编辑器里塞 Actor，工程关着就没有关卡可放。拦在最前面，
  // 别让用户等完一整轮拷贝才发现放不进去
  if (placeInScene && !connected) {
    return {
      success: false,
      error:
        `「${projectRecord.projectName}」现在没连着编辑器，放不进场景。先打开工程，` +
        `或者改用 import_assets 只把资产导进去 —— .uasset 不需要工程开着。`
    }
  }

  const databaseManager = getDatabaseManager()
  const vaultInfo = databaseManager.getVaultManager().getCurrentVault()
  if (!vaultInfo) {
    return { success: false, error: '当前保管库不存在，无法查找资产' }
  }

  const vaultDbPath = path.join(vaultInfo.path, 'vault-data.db')
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- 懒加载：静态 import 会在模块加载期就拉起原生模块
  const Database = require('better-sqlite3')
  const db = new Database(vaultDbPath)
  const contentBase = getProjectContentBase(projectRecord)
  const details: string[] = []
  const importedAssets: ImportedAssetSummary[] = []
  const tempDir = path.join(app.getPath('temp'), `uebox-import-${Date.now()}`)
  let handledCount = 0

  try {
    await fs.mkdir(tempDir, { recursive: true })

    // 文件夹展开成 assetKey。用户说的是「把 SoStylized 导进去」，
    // 不该逼着模型先把里面几百个资产一页页翻出来再拼成数组。
    let folderSelection: ProjectImportResult['folder_selection']
    let keys = assetKeys
    if (options?.folder) {
      const selection = selectFolderAssetKeys(db, options.folder, {
        includeSubfolders: options.includeSubfolders,
        limit: MAX_IMPORT_BATCH,
        offset: options.folderOffset
      })
      if (selection.error || !selection.assetKeys) {
        // 导入这条链路整条绑在活跃库上（importUAssetsToProject 自己也要
        // getVaultDatabase），跨库导不了 —— 那是故意的，切库是用户的动作。
        // 但话要说准：别让「你得先切个库」变成「你没有这个素材」。
        return {
          success: false,
          error: await explainVaultMiss(selection.error ?? '文件夹解析失败', (other) =>
            Boolean(resolveFolder(other, options.folder as string).folderKey)
          )
        }
      }

      const total = selection.total ?? 0
      const offset = selection.offset ?? 0
      const batch = selection.assetKeys
      folderSelection = {
        folder: selection.folderLabel || options.folder,
        folderKey: selection.folderKey,
        total,
        offset,
        batch_count: batch.length,
        hasMore: selection.hasMore === true,
        ...(selection.nextOffset !== undefined ? { nextFolderOffset: selection.nextOffset } : {})
      }

      if (total === 0) {
        return {
          success: false,
          error: `「${folderSelection.folder}」里没有资产（连子文件夹一起算）。先用 search_assets 确认这个文件夹的内容。`,
          folder_selection: folderSelection
        }
      }

      // 一次只导一批。**明说**这是第几批，别让调用方以为整个文件夹都进去了。
      details.push(
        `📁 「${folderSelection.folder}」共 ${total} 个资产，这次导第 ${offset + 1}~${offset + batch.length} 个` +
          (folderSelection.hasMore
            ? `，剩下的用同样参数加 folderOffset=${folderSelection.nextFolderOffset} 再调一次`
            : '')
      )

      // 显式给的 assetKeys 和文件夹展开的结果合并去重 —— 两个都给时谁也不吞掉
      keys = Array.from(new Set([...assetKeys, ...batch]))
    }

    if (keys.length === 0) {
      return {
        success: false,
        error: '没有要导入的资产：assetKeys 和 folder 至少给一个。',
        ...(folderSelection ? { folder_selection: folderSelection } : {})
      }
    }

    /*
     * 动手之前先核一次库。
     *
     * 导入这条链路整个绑在**活跃保管库**上，而 search_assets 默认**跨库搜**——
     * 所以「搜到的东西导不进去」是一种必然会撞上的组合，不是意外。
     * 撞上之后的出路只有一条：切库重来。
     *
     * 以前这件事是在下面的循环里逐个 key 发现的：51 个资产就是 51 行同样的长文案，
     * 而且是在已经开工之后。收到 assetKeys 的这一刻就能判断它们属于哪个库，
     * 所以挪到这里，一次说清楚。
     *
     * 一个都不在活跃库里 = 这一批根本没法做，直接返回；部分不在的话照常往下走，
     * 能导的先导进去，那几个的去向写在 details 里（少数几个而已，不会刷屏）。
     */
    const vaultMiss = await explainVaultMissBatch(keys, (vaultDb, key) =>
      Boolean(getAssetDataByKey(vaultDb, key))
    )
    if (vaultMiss.missing.length === keys.length && vaultMiss.message) {
      return {
        success: false,
        error: vaultMiss.message,
        ...(folderSelection ? { folder_selection: folderSelection } : {})
      }
    }
    if (vaultMiss.missing.length > 0 && vaultMiss.message) {
      details.push(`⚠️ ${vaultMiss.message}`)
    }

    // 先分路，再整批导。
    //
    // 这里原来是「一个 assetKey 一次 importUAssetsToProject」的 for 循环，等于绕开了
    // 批量会话：500 个动画共用的那副骨骼会被解析、拷贝 500 遍。.uasset 这一路现在
    // 一次性交给批量入口，整批共用一份依赖解析状态和一个并发拷贝队列。
    // 外部文件仍得逐个过引擎的导入 API —— 那条路没有批量接口。
    type RoutedAsset = { assetKey: string; asset: AssetData; assetName: string; assetClass: string }
    const copyAssets: RoutedAsset[] = []
    const externalAssets: RoutedAsset[] = []

    for (const assetKey of keys) {
      const asset: AssetData | undefined = getAssetDataByKey(db, assetKey)
      if (!asset) {
        // 去向已经由上面的整批预检说过了，这里只记一行「这个没导」，不再重复长文案
        details.push(`❌ ${assetKey}: 当前保管库「${vaultInfo.name}」里没有，跳过`)
        continue
      }

      const rawPath = String(asset.filePath || asset.originPath || '')
      const assetName = String(asset.assetName || assetKey)
      const assetClass = String(asset.className || asset.classKey || asset.assetClass || '')
      const routed: RoutedAsset = { assetKey, asset, assetName, assetClass }

      const route = routeAssetImport({
        filePath: rawPath,
        softPath: String(asset.softPath || ''),
        editorConnected: connected
      })

      // 外部文件必须过引擎的导入 API 才能变成资产，工程关着就是做不了。
      // 这道闸只挡这一个资产，不挡整批 —— 同一批里的 .uasset 照常拷进去
      if (route === 'needs-editor') {
        details.push(
          `⏭️ ${assetName}: 这是外部文件（${path.extname(rawPath) || '非 .uasset'}），` +
            `要由引擎导入，而「${projectRecord.projectName}」现在没开着。打开工程后再导它。`
        )
        continue
      }

      if (route === 'copy') copyAssets.push(routed)
      else externalAssets.push(routed)
    }

    if (copyAssets.length > 0) {
      const batchResult = await importUAssetsBatchToProject(
        projectRecord,
        copyAssets.map((item) => ({ assetKey: item.assetKey, assetName: item.assetName }))
      )
      const settledByKey = new Map(batchResult.assets.map((item) => [item.assetKey, item]))

      /*
       * 整批就没起来的情况（工程路径无效、Content 目录建不了）里
       * `assets` 是空的。不先把 `batchResult.error` 说出来的话，每个资产
       * 都会拿到一句注定没信息量的「导入失败」，模型只能原样再试一次。
       */
      if (batchResult.error) {
        details.push(`❌ ${batchResult.error}`)
      }

      for (const { assetKey, asset, assetName, assetClass } of copyAssets) {
        const settled = settledByKey.get(assetKey)
        if (!settled || settled.status === 'failed') {
          details.push(
            `❌ ${assetName}: ${settled?.error || batchResult.error || describeImportFailure(settled?.reason)}`
          )
          continue
        }

        const alreadyExists = settled.status === 'existing'
        const softPath = String(asset.softPath || '')
        const uePath = softPath || settled.primaryTarget?.replace(/\\/g, '/')
        const resolvedUePath =
          uePath && uePath.startsWith('/Game/')
            ? uePath
            : settled.primaryTarget
              ? filePathToUePath(settled.primaryTarget, contentBase)
              : undefined

        importedAssets.push(
          buildImportedAssetSummary({
            assetKey,
            assetName,
            assetClass,
            className: String(asset.className || ''),
            softPath,
            uePath: resolvedUePath,
            sourceType: 'uasset',
            imported: true,
            alreadyExists
          })
        )
        handledCount += 1
        details.push(
          `${alreadyExists ? '♻️' : '✅'} ${assetName}: ${resolvedUePath || '已导入到项目'}`
        )
      }

      // 缺了哪个依赖、影响了谁 —— 一条依赖一行，不是每个资产重复一遍
      for (const missing of batchResult.report.missingDependencies) {
        details.push(
          `⚠️ 缺依赖 ${missing.name}（${missing.softPath}）：${describeMissingState(missing.state)}，` +
            `${missing.affectedCount} 个资产用到它`
        )
      }
      if (batchResult.report.truncated.missingDependencies > 0) {
        details.push(
          `⚠️ 另有 ${batchResult.report.truncated.missingDependencies} 条缺依赖没列出来（清单封顶了）`
        )
      }
      for (const failure of batchResult.report.fileFailures) {
        details.push(`⚠️ 没能写进工程 ${failure.name}：${failure.error}`)
      }
      if (batchResult.report.truncated.fileFailures > 0) {
        details.push(
          `⚠️ 另有 ${batchResult.report.truncated.fileFailures} 个没写进去的文件没列出来`
        )
      }
      /*
       * 目标路径冲突必须说 —— 这是唯一一种「报了成功、字节却是别人的」。
       * 两个资产映到同一个软路径时，后到的那个被静默丢弃，而它的结算仍是
       * imported。不报的话模型会告诉用户两个都进去了。
       */
      for (const conflict of batchResult.report.conflicts) {
        details.push(
          `⚠️ 目标路径冲突 ${conflict.name}：只保留了先到的那个，` +
            `另一个来源 ${conflict.rejectedSource} 被丢弃`
        )
      }
      if (batchResult.report.orphanFileFailures > 0) {
        details.push(
          `⚠️ 另有 ${batchResult.report.orphanFileFailures} 个依赖文件没能写进工程，相关资产在引擎里可能不完整`
        )
      }
    }

    for (const { assetKey, asset, assetName, assetClass } of externalAssets) {
      {
        let sourcePath: string
        try {
          sourcePath = await resolveExternalAssetPath(asset, tempDir)
        } catch (error) {
          details.push(`❌ ${assetName}: ${error instanceof Error ? error.message : String(error)}`)
          continue
        }

        const wantedName = options?.assetNames?.[assetKey]
        const result = await importExternalFilesToProject({
          files: [sourcePath],
          destinationPath,
          overwrite: options?.overwrite === true,
          skeleton: options?.skeleton,
          fbxImportAs: options?.fbxImportAs,
          animFrameRate: options?.animFrameRate,
          ...(wantedName ? { nameOverrides: { [path.basename(sourcePath)]: wantedName } } : {}),
          // 显式带上目标工程那条连接：点名导入时环境里绑的可能是**另一个**工程，
          // 让底层去猜就是「静默导进别人的工程」
          targetConnectionId: connectionId
        })

        if (!result.success || !result.imported || result.imported.length === 0) {
          details.push(`❌ ${assetName}: ${result.error || '外部文件导入失败'}`)
          if (Array.isArray(result.warnings)) {
            details.push(...result.warnings.map((item) => `⚠️ ${item}`))
          }
          continue
        }

        const imported = result.imported[0]
        importedAssets.push(
          buildImportedAssetSummary({
            assetKey,
            assetName,
            assetClass: String(imported.class || assetClass),
            className: String(asset.className || ''),
            softPath: String(asset.softPath || ''),
            uePath: String(imported.path || ''),
            sourceType: 'external',
            imported: true
          })
        )
        handledCount += 1
        details.push(`✅ ${assetName}: ${String(imported.path || destinationPath)}`)
      }
    }

    /*
     * 拷完文件之后，让引擎把这几个目录重新扫进资产注册表。
     *
     * .uasset 这条路是**把文件直接拷进 Content 目录**的，没有经过引擎的导入 API。
     * 编辑器开着的时候，这批文件在注册表里可能一条都没有 —— 真机上就撞见过：
     * ue_content_search 回「找到 0 个 Material（这就是全部）」，同目录连
     * Materials 文件夹都没有，而 ue_content_describe 明明列着依赖里有那个材质，
     * 磁盘上文件也在，场景渲染也正常。三处口径互相打架，调用方只能绕开注册表
     * 去数磁盘文件，还差点把「材质没导进来」写进给用户的清单。
     *
     * 扫不动不算导入失败：文件已经在工程里了，重启编辑器一样能看见。
     * 所以这里只在 details 里说一句，不动 success。
     */
    if (connected && importedAssets.length > 0) {
      const scanPaths = Array.from(
        new Set(
          importedAssets
            .map((item) => (typeof item.uePath === 'string' ? item.uePath : ''))
            .filter((uePath) => uePath.startsWith('/Game/'))
            .map((uePath) => uePath.slice(0, uePath.lastIndexOf('/')))
            .filter((dir) => dir.length > '/Game'.length)
        )
      )
      if (scanPaths.length > 0) {
        try {
          const scan = await runWithTargetConnectionId(
            { connectionId, projectPath: projectRecord.projectPath ?? undefined },
            () =>
              callUe<{ total_assets?: number; scanned_paths?: number }>(
                'content.registry_scan',
                { paths: scanPaths },
                { timeoutMs: 60_000 }
              )
          )
          details.push(
            `🔄 已让引擎重扫 ${scanPaths.length} 个目录的资产注册表` +
              (typeof scan?.total_assets === 'number'
                ? `，现在这些目录下共 ${scan.total_assets} 个已登记资产`
                : '')
          )
        } catch (error) {
          // 老插件没有这条命令，用户的工程里装的就是老插件 —— 这不是错误，
          // 但要说出来：不说的话，注册表滞后会以「搜不到刚导入的资产」的形式
          // 出现在下一步，而那时已经看不出是这一步没扫
          details.push(
            `⚠️ 没能让引擎重扫资产注册表（${error instanceof Error ? error.message : String(error)}）。` +
              '文件已经在工程里了，但 ue_content_search 可能暂时搜不到它们 —— ' +
              '按路径直接用（ue_content_describe / 生成 Actor）是可以的，' +
              '要走搜索就等编辑器自己扫到，或者重启编辑器。'
          )
        }
      }
    }

    const spawnCandidates = importedAssets.filter((asset) => asset.spawnable && asset.reference)
    let placedActors: Array<Record<string, unknown>> = []
    let placedCount = 0

    if (placeInScene && spawnCandidates.length > 0) {
      try {
        // 放场景那条链路（actor.spawn / run_python）读的是执行流上的目标，不是参数。
        // 点名导入时那个目标可能指着另一个工程 —— 在这里把它按到本次的目标上，
        // 否则资产进了 A 工程、Actor 落在 B 工程的关卡里
        const placementResult = await runWithTargetConnectionId(
          { connectionId, projectPath: projectRecord.projectPath ?? undefined },
          () => placeImportedAssetsInScene(spawnCandidates, options?.scenePlacement)
        )
        placedActors = placementResult.placedActors
        placedCount = placementResult.placedCount
        details.push(...placementResult.details)
      } catch (error) {
        details.push(`❌ 场景放置失败: ${error instanceof Error ? error.message : String(error)}`)
      }
    } else if (placeInScene) {
      details.push('⚠️ 导入成功，但没有可直接实例化到场景的资产类型')
    }

    return {
      success:
        handledCount > 0 && (!placeInScene || spawnCandidates.length === 0 || placedCount > 0),
      imported_count: handledCount,
      requested_asset_count: keys.length,
      resolved_asset_count: importedAssets.length,
      placed_count: placedCount,
      details,
      ...(folderSelection ? { folder_selection: folderSelection } : {}),
      imported_assets: importedAssets,
      spawn_candidates: spawnCandidates,
      placed_actors: placedActors,
      output: {
        importedAssets,
        spawnCandidates,
        placedActors
      }
    }
  } finally {
    db.close()
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * 创建项目管理工具
 * @returns 项目管理工具实例
 */
export function createProjectTool(): V2Tool {
  return defineV2Tool({
    description: `项目管理工具。
必须指定 action 参数来选择操作类型：
- list_templates: 列出所有可用的 UE 项目模板（无需其他参数）
  - 包含**已装引擎自带的模板**（空白 / 第三人称 / 第一人称…，每个引擎版本各一套）
    和用户放在盒子模板目录里的 zip 模板包
- list_projects: 列出所有已注册的 UE 项目（无需其他参数）
  - 每个工程带 collections（在哪几个合集里，可以同时在多个）和 pinned（有没有置顶），
    并另外返回 collections 清单（含空合集）—— 整理工程库前先看这一份，
    动手改分组和置顶用 project_organize
- create_project: 从模板创建新项目（需要 templateName, projectName, targetDir，建议给 engineVersion）
  - **建工程只能走这里。** 不要用 write_local_file / run_shell_command 自己去拷引擎的
    Templates 目录 —— 那样建出来的工程不会进用户的「我的项目」、不会装 UnrealAgentLink、
    EngineAssociation 还是空的，用户在盒子里根本看不到它
  - 会自动：填对引擎版本、带上模板依赖的共享内容包、拷好工程封面、登记进项目库
- open_project: 打开指定的 UE 项目（需要 projectKey 或 projectPath）
  - **打开完会等它真连上，并把这一轮的引擎命令改发给它。** 返回里的
    connected=true 就是「验证过能干活」，switched_target=true 就是「已经切过去了」——
    这时直接接着干，不要让用户去界面上切工程、也不要请他再发一条消息
  - 等待默认 ${DEFAULT_WAIT_MS / 1000} 秒，用 waitSeconds 调整
  - 会话被用户归到别的工程下时不会切（那是越界），details 里会说明，照实转告用户
- import_assets: 将资产库中的资产导入 UE 项目（需要 assetKeys **或** folder，可选 destinationPath）
  - **工程不用打开。** .uasset/.umap 是把文件拷进 <工程>/Content/ 并解析依赖，不经过引擎，
    所以别为了导资产先去 open_project —— 那会白等一趟编辑器启动。用 projectKey
    （list_projects 里查）或 projectPath 点名导进哪个工程；不点名才退回到当前打开的那个
  - **只有外部文件（FBX/PNG/OBJ…）需要工程开着**，它们必须过引擎的导入 API。
    整批里混了外部文件而工程没开时，.uasset 照常导，外部那几个会在 details 里
    单独标出来，打开工程后再补
  - **整个文件夹用 folder 一次搞定**：folder: "SoStylized" 就是把这个文件夹（默认连
    子文件夹）里的资产全导进去，不用先 search_assets 把几百个 assetKey 翻出来
  - folder 一次最多导 ${MAX_IMPORT_BATCH} 个：返回的 folder_selection 里 hasMore 为 true 时，
    用同样参数加上 folderOffset=nextFolderOffset 再调一次，接着导下一批
  - 返回结构化 imported_assets / spawn_candidates 结果，供后续自动化步骤复用
- import_assets_to_scene: 将资产库中的资产导入 UE 项目，并自动将可实例化资产放入当前场景
  - **这个要工程开着**：往关卡里放 Actor 得有一个活着的编辑器。只想把资产导进去用 import_assets
  - 同样支持 folder
  - .uasset/.umap 文件会直接复制到项目 Content 目录（按原始目录结构），并自动解析和导入依赖资产
  - 外部文件（FBX/PNG/OBJ 等）会自动经过 UE 导入 API，再尝试放入场景
  - 仅 StaticMesh / SkeletalMesh / Blueprint 类资产会尝试放入场景；贴图、材质、音频等会保留为已导入资产
 - setup_level_sequence: 在当前项目中创建或复用 Level Sequence，并可选生成角色 Actor、绑定到 Sequencer、添加动画轨

示例调用：
1. 列出模板: { "action": "list_templates" }
2. 列出项目: { "action": "list_projects" }
3. 创建项目: { "action": "create_project", "templateName": "TP_BlankBP", "projectName": "MyGame", "targetDir": "D:/Projects", "engineVersion": "5.5" }
4. 用 projectKey 打开项目: { "action": "open_project", "projectKey": "xxx-xxx" }
5. 用路径打开项目: { "action": "open_project", "projectPath": "D:/Projects/MyGame" }
6. 导入资产: { "action": "import_assets", "assetKeys": ["asset-key-1", "asset-key-2"], "destinationPath": "/Game/Imported" }
6b. 导入整个文件夹: { "action": "import_assets", "folder": "SoStylized", "destinationPath": "/Game/Imported" }
7. 导入并放场景: { "action": "import_assets_to_scene", "assetKeys": ["asset-key-1"], "scenePlacement": { "layout": "grid", "origin": { "x": 0, "y": 0, "z": 0 }, "spacing": 300 } }
8. 创建定序器并挂角色动画: { "action": "setup_level_sequence", "sequenceName": "LS_TestShot", "sequenceFolderPath": "/Game/Cinematics/Test", "actorAssetPath": "/Game/Characters/BP_Hero", "animationAssetPath": "/Game/Characters/Anims/AM_Walk" }`,
    inputSchema: z.object({
      action: z
        .enum([
          'list_templates',
          'create_project',
          'list_projects',
          'open_project',
          'import_assets',
          'import_assets_to_scene',
          'setup_level_sequence'
        ])
        .describe(
          '【必填】操作类型：list_templates（列出模板）、create_project（创建项目）、list_projects（列出项目）、open_project（打开项目）、import_assets（导入资产到 UE 项目）、import_assets_to_scene（导入并放入场景）、setup_level_sequence（创建定序器并可选绑定角色和动画）'
        ),
      templateName: z
        .string()
        .optional()
        .describe(
          '模板标识（仅 create_project 时需要）。用 list_templates 返回的 templateKey 最准确' +
            '（如 "5.5/TP_BlankBP"），也接受目录名 "TP_BlankBP" 或中文显示名 "空白"'
        ),
      projectName: z
        .string()
        .optional()
        .describe(
          '新项目名称（仅 create_project 时需要）。UE 的限制：只能用英文字母、数字、下划线，' +
            '不能以数字开头，不要超过 20 个字符'
        ),
      targetDir: z
        .string()
        .optional()
        .describe(
          '项目保存的**父目录**（仅 create_project 时需要）。工程会建在 <targetDir>/<projectName>'
        ),
      engineVersion: z
        .string()
        .optional()
        .describe(
          '用哪个引擎版本的自带模板，如 "5.5"（仅 create_project 时可用）。' +
            '不给的话在所有已装引擎里找第一个匹配的 —— 用户说了版本就一定要带上'
        ),
      projectKey: z
        .string()
        .optional()
        .describe(
          '项目唯一标识（来自 list_projects），优先于 projectPath。' +
            'open_project 需要它；import_assets / import_assets_to_scene 用它点名导进哪个工程，' +
            '**不给才退回到当前打开的工程**'
        ),
      projectPath: z
        .string()
        .optional()
        .describe(
          '项目的目录路径或 .uproject 文件路径（没有 projectKey 时用它）。' +
            'open_project 和两个 import 动作都认'
        ),
      waitSeconds: z
        .number()
        .min(0)
        .max(MAX_WAIT_MS / 1000)
        .optional()
        .describe(
          `仅 open_project：最多等这个工程连上盒子多少秒，默认 ${DEFAULT_WAIT_MS / 1000}。` +
            '连上之后这一轮的引擎命令会自动改发给它，不需要用户去界面上切工程。' +
            '默认 0：启动后立即返回，connected=false 表示尚未验证就绪，不是打开失败。' +
            '先用 ue_session_health 查询目标工程连接，再对同一工程传 5 做就绪校验。' +
            '显式等待必须短于调用方超时；大工程加载期间不要重复启动'
        ),
      assetKeys: z
        .array(z.string())
        .optional()
        .describe(
          '要导入的资产 key 列表（import_assets / import_assets_to_scene 用；来自 search_assets 的结果）。整个文件夹用 folder 更省事。'
        ),
      folder: z
        .string()
        .optional()
        .describe(
          '按素材库文件夹导入（import_assets / import_assets_to_scene 用）：文件夹名（SoStylized）、' +
            '完整路径（/ALL/SoStylized）或 folderKey 都行。和 assetKeys 至少给一个，两个都给会合并去重。'
        ),
      includeSubfolders: z
        .boolean()
        .optional()
        .describe('按 folder 导入时是否连子文件夹一起导，默认 true'),
      folderOffset: z
        .number()
        .optional()
        .describe(
          `按 folder 导入时跳过前几个。一次最多 ${MAX_IMPORT_BATCH} 个，接着导下一批就填上一次返回的 folder_selection.nextFolderOffset。`
        ),
      destinationPath: z
        .string()
        .optional()
        .default('/Game/Imported')
        .describe(
          'UE 内部目标路径（对外部文件导入生效；.uasset 文件按原始路径复制；默认 /Game/Imported）'
        ),
      skeleton: z
        .string()
        .optional()
        .describe(
          '仅 import_assets：素材库里的 FBX 按**动画**导入到这个骨架（资产路径，如 .../Body/metahuman_base_skel）。' +
            '导动作/动画 FBX 时必填，不给引擎什么都导不出来；导模型时别填'
        ),
      fbxImportAs: z
        .enum(['auto', 'static_mesh', 'skeletal_mesh', 'animation'])
        .optional()
        .describe(
          '仅 import_assets 的外部 FBX，正常不填：给了 skeleton 默认 animation，否则 auto。' +
            '网格绑到现有骨架填 skeletal_mesh（配 skeleton）'
        ),
      animFrameRate: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('仅 import_assets 的外部 FBX 动画：按这个帧率重采样（如 30/60）。不给用引擎默认'),
      overwrite: z
        .boolean()
        .optional()
        .describe(
          '仅 import_assets 的外部格式文件：同名资产就地替换（引用不断）。' +
            '「用素材库新动画替换项目里现有的」= overwrite:true + assetNames 指向现有资产名 + destinationPath 指向它所在目录'
        ),
      assetNames: z
        .record(z.string(), z.string())
        .optional()
        .describe(
          '仅 import_assets 的外部格式文件：{ assetKey: 导入后的资产名 }，盖过自动规范化的名字。只写名字不带路径'
        ),
      scenePlacement: ScenePlacementSchema.optional().describe(
        '导入后自动放入场景时的布局参数（仅 import_assets_to_scene 时使用）'
      ),
      sequenceName: z
        .string()
        .optional()
        .describe('Level Sequence 资源名称（仅 setup_level_sequence 时需要）'),
      sequenceFolderPath: z
        .string()
        .optional()
        .describe('Level Sequence 保存目录，必须是 /Game/... 路径，默认 /Game/Cinematics'),
      openSequence: z
        .boolean()
        .optional()
        .describe('创建或复用定序器后是否自动在 Sequencer 中打开，默认 true'),
      actorAssetPath: z
        .string()
        .optional()
        .describe(
          '可选。要生成到当前关卡并绑定到 Sequencer 的角色资产路径，如 /Game/Characters/BP_Hero'
        ),
      actorAssetClass: z
        .string()
        .optional()
        .describe('可选。角色资产类型提示，如 Blueprint 或 SkeletalMesh，用于生成 Actor'),
      existingActorPath: z
        .string()
        .optional()
        .describe(
          '可选。当前关卡中已有 Actor 的完整路径；提供后将直接绑定到 Sequencer，不再生成新 Actor'
        ),
      actorLabel: z.string().optional().describe('可选。生成到关卡中的 Actor 名称或标签'),
      animationAssetPath: z
        .string()
        .optional()
        .describe('可选。要添加到角色轨道上的动画资源路径，如 /Game/Characters/Anims/AM_Walk'),
      sequenceLengthSeconds: z
        .number()
        .positive()
        .optional()
        .describe('可选。定序器和动画 section 的时长；未提供时会尝试读取动画长度'),
      spawnTransform: SpawnTransformSchema.optional().describe(
        '可选。生成角色 Actor 时使用的 Transform（仅 actorAssetPath 生效）'
      )
    }),
    execute: async (input, options) => {
      console.log('[ProjectTool] 收到请求:', JSON.stringify(input, null, 2))
      try {
        switch (input.action) {
          case 'list_templates': {
            console.log('[ProjectTool] 执行 list_templates')
            const templates = await listTemplates()
            console.log('[ProjectTool] 找到模板数量:', templates.length)
            return { success: true, templates }
          }
          case 'list_projects': {
            console.log('[ProjectTool] 执行 list_projects')
            const { projects, collections } = listProjects()
            return { success: true, projects, collections }
          }
          case 'create_project': {
            console.log('[ProjectTool] 执行 create_project')
            if (!input.templateName || !input.projectName || !input.targetDir) {
              return { success: false, error: '需要 templateName, projectName, targetDir' }
            }
            return createProjectFromTemplate(
              input.templateName,
              input.projectName,
              input.targetDir,
              input.engineVersion
            )
          }
          case 'open_project': {
            console.log('[ProjectTool] 执行 open_project')
            if (!input.projectKey && !input.projectPath) {
              return { success: false, error: '需要 projectKey 或 projectPath 参数' }
            }

            const opened = input.projectKey
              ? await openProject(input.projectKey)
              : await openProjectByPath(input.projectPath as string)

            // 启动都没启动起来就没有交接可做，原样把错误报上去
            if (!opened.success || !opened.openedPath) return opened

            /*
             * 打开之后必须把这一轮交接过去，否则新编辑器起来了，命令还发往旧工程。
             * 全部来龙去脉在 `handOffToOpenedProject` 的注释里。
             *
             * **谁不想等，谁自己说。**
             *
             * 这里试过两次靠猜来分辨调用方：先看 `options` 在不在（不行，
             * `adaptV2Tool` 无论如何都传一个对象），再看中止信号在不在（也不行，
             * MCP server 那条路同样没有信号，于是所有第三方客户端的 `waitSeconds`
             * 被静默改成 0）。两次都猜错，因为「能不能取消」和「想不想等」
             * 本来就是两件事。
             *
             * 所以不猜了：想立刻返回的调用方在参数里写 `waitSeconds: 0`。
             * 调试端点自己传（见 `services/http/server.ts`），模型也可以传。
             */
            const handOff = await handOffToOpenedProject(opened.openedPath, {
              ...(typeof input.waitSeconds === 'number' ? { waitSeconds: input.waitSeconds } : {}),
              ...(options?.abortSignal ? { signal: options.abortSignal } : {})
            })

            return {
              ...opened,
              connected: handOff.connected,
              switched_target: handOff.switched_target,
              waited_seconds: handOff.waited_seconds,
              details: [...(opened.details ?? []), ...handOff.details]
            }
          }
          case 'import_assets': {
            console.log('[ProjectTool] 执行 import_assets')
            if ((!input.assetKeys || input.assetKeys.length === 0) && !input.folder) {
              return {
                success: false,
                error: '需要 assetKeys（资产 key 列表）或 folder（素材库文件夹）其中之一'
              }
            }
            return importAssetsToProject(
              input.assetKeys ?? [],
              input.destinationPath || '/Game/Imported',
              {
                folder: input.folder,
                includeSubfolders: input.includeSubfolders,
                folderOffset: input.folderOffset,
                target: { projectKey: input.projectKey, projectPath: input.projectPath },
                skeleton: input.skeleton,
                fbxImportAs: input.fbxImportAs,
                animFrameRate: input.animFrameRate,
                overwrite: input.overwrite,
                assetNames: input.assetNames
              }
            )
          }
          case 'import_assets_to_scene': {
            console.log('[ProjectTool] 执行 import_assets_to_scene')
            if ((!input.assetKeys || input.assetKeys.length === 0) && !input.folder) {
              return {
                success: false,
                error: '需要 assetKeys（资产 key 列表）或 folder（素材库文件夹）其中之一'
              }
            }
            return importAssetsToProject(
              input.assetKeys ?? [],
              input.destinationPath || '/Game/Imported',
              {
                placeInScene: true,
                scenePlacement: input.scenePlacement,
                folder: input.folder,
                includeSubfolders: input.includeSubfolders,
                folderOffset: input.folderOffset,
                target: { projectKey: input.projectKey, projectPath: input.projectPath }
              }
            )
          }
          case 'setup_level_sequence': {
            console.log('[ProjectTool] 执行 setup_level_sequence')
            if (!input.sequenceName || !String(input.sequenceName).trim()) {
              return { success: false, error: '需要 sequenceName 参数（定序器名称）' }
            }
            return setupLevelSequence({
              sequenceName: input.sequenceName,
              sequenceFolderPath: input.sequenceFolderPath,
              openSequence: input.openSequence,
              actorAssetPath: input.actorAssetPath,
              actorAssetClass: input.actorAssetClass,
              existingActorPath: input.existingActorPath,
              actorLabel: input.actorLabel,
              animationAssetPath: input.animationAssetPath,
              sequenceLengthSeconds: input.sequenceLengthSeconds,
              spawnTransform: input.spawnTransform
            })
          }
          default:
            console.error(
              '[ProjectTool] 收到未知操作:',
              input.action,
              '有效操作: list_templates, create_project, list_projects, open_project, import_assets, import_assets_to_scene, setup_level_sequence'
            )
            return {
              success: false,
              error: `未知操作: ${input.action}。有效操作: list_templates, create_project, list_projects, open_project, import_assets, import_assets_to_scene, setup_level_sequence`
            }
        }
      } catch (err) {
        return { success: false, error: String(err instanceof Error ? err.message : err) }
      }
    }
  })
}
