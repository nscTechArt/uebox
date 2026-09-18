/**
 * 引擎清单 —— 这台机器上装了哪些虚幻引擎、插件在不在、此刻跑的是哪个。
 *
 * ## 为什么要有这个工具
 *
 * 首页那排引擎卡片（5.7 / 5.6 / … / 4.27）是主进程扫出来的：Epic Launcher 的
 * `LauncherInstalled.dat`，加上用户自己在「引擎版本 +」里添加的自定义路径。
 * 这份数据 agent 一直够不着 —— `ue_get_project_info` 要引擎连着才能问，
 * `project_list` 只给工程记录里的 EngineAssociation 字符串。
 *
 * 于是真机上出现过这一幕：用户让它准备一个 5.5 的工程，模型自己去 shell 里
 * reg query 注册表，翻出 4.27 和 5.7 两条就下结论「没有 5.5」—— 而界面上
 * 明明列着九个引擎，5.5 就在其中。注册表只登记一部分版本，盒子扫的来源更全，
 * 模型手里却只有前者。
 *
 * 装引擎、装插件、开工程是这个软件的主路径。读引擎不该靠模型自己写命令去猜。
 *
 * ## 为什么不放进 `ue.*`
 *
 * `ue.*` 的工具在引擎没连上时整批不注册（见 `resolveTools`）。而「有哪些引擎、
 * 插件装没装」恰恰是**没连上的时候**最需要问的一句话 —— 用户连不上，模型得先
 * 知道插件在不在那个引擎里，才能给出下一步。所以它和资产库、工程管理一样，
 * 是盒子的本地能力，独立命名空间、始终可用。
 */

import { access } from 'fs/promises'
import * as path from 'path'
import { z } from 'zod'

import UnrealPathManagerUtil from '../../../utils/UnrealPathManager'
import UnrealProcessDetector from '../../../utils/UnrealProcessDetector'
import { defineTool, type UnrealAgentTool } from '../defineTool'

const NAMESPACE = 'engine'

/**
 * UnrealAgentLink **在引擎目录里**的状态。
 *
 * 注意这只是插件的一种装法（首页引擎卡片 ⋮ →「校验安装」装的就是它）。
 * 现在的主路径是项目级：打开工程时 `ensureUnrealAgentLinkPlugin` 把插件装进
 * 「工程/Plugins」、在 .uproject 里启用，并**顺手删掉该引擎里的那一份**
 * （设置页还有一个「清理引擎残留」按钮做同样的事）。
 *
 * 所以 `missing` 是常态，不代表工程连不上盒子 —— 第一版把它写成
 * 「这个引擎开的工程连不上盒子」是错的，模型据此会给用户一堆无用的安装建议。
 */
export type PluginStatus = 'ok' | 'outdated' | 'missing'

export interface EngineEntry {
  /** 版本号，如 "5.5"、"4.27" */
  version: string
  /** 盒子里的显示名，通常是 "UE_5.5" */
  name: string
  /** 引擎根目录（Engine/ 的上一级） */
  rootPath: string
  /** 编辑器可执行文件，已确认存在 —— 扫描时就把找不到 exe 的记录滤掉了 */
  editorExecutable: string
  agentLink: PluginStatus
  /** 插件实际所在目录（三个历史安装位置之一） */
  agentLinkPath?: string
}

export interface RunningEntry {
  pid: number
  projectName: string
  projectPath: string
  /** `.uproject` 里原样写着的 EngineAssociation。自编译引擎是一串 GUID */
  engineAssociation?: string
  /** 解析后的版本号。GUID 会查注册表还原 */
  engineVersion?: string
  /** 对应的引擎根目录，能对上装好的引擎或注册表记录时才有 */
  engineRootPath?: string
}

export interface EngineInventory {
  engines: EngineEntry[]
  running: RunningEntry[]
  /**
   * 这一趟引擎清单没读全。
   *
   * `engines` 为空时**绝不能**说成「这台机器没装引擎」—— 模型会照着这句话
   * 让用户去装他已经装好的东西，还会明确拒绝再去找。
   */
  scanDegraded: boolean
  /** 盒子安装包里自带的插件版本，用来判断引擎里那份是不是旧的 */
  bundledPluginVersion: string
}

/** 插件的 .uplugin 文件名。三个候选安装目录里认的都是它 */
const PLUGIN_MANIFEST = 'UnrealAgentLink.uplugin'

/**
 * 读一个引擎里的插件状态。
 *
 * 版本读不出来时按「旧」报，不按「已装」报：让用户重装一次是安全的，
 * 而误报「已经是最新」会让他对着一个连不上的引擎干等。
 */
async function readPluginStatus(
  rootPath: string,
  bundledVersion: string
): Promise<Pick<EngineEntry, 'agentLink' | 'agentLinkPath'>> {
  for (const dir of UnrealPathManagerUtil.getUNTLinkInstallPaths(rootPath)) {
    try {
      await access(path.join(dir, PLUGIN_MANIFEST))
    } catch {
      continue
    }

    const upToDate = await UnrealPathManagerUtil.checkPluginVersionAtPath(
      dir,
      bundledVersion
    ).catch(() => false)
    return { agentLink: upToDate ? 'ok' : 'outdated', agentLinkPath: dir }
  }

  return { agentLink: 'missing' }
}

/** 装好的引擎 + 每个引擎里的插件状态 */
async function collectEngines(
  bundledVersion: string
): Promise<{ entries: EngineEntry[]; degraded: boolean }> {
  // 用 scanEngines 而不是 findUnrealEnginePaths：后者把「没读到」吞成空数组
  const { engines, degraded } = await UnrealPathManagerUtil.scanEngines()

  const entries = await Promise.all(
    engines.map(async (engine) => ({
      version: engine.version,
      name: engine.name,
      rootPath: engine.rootPath,
      editorExecutable: engine.enginePath,
      ...(await readPluginStatus(engine.rootPath, bundledVersion))
    }))
  )

  return { entries, degraded }
}

/**
 * 正在跑的编辑器，以及它们各自用的引擎。
 *
 * EngineAssociation 有两种写法：`"5.5"` 这样的版本号，和自编译引擎的
 * `{GUID}`。后者光看工程文件是什么都看不出来的，得回注册表查那张
 * GUID → 引擎目录的表 —— 这段解析盒子本来就有，这里直接复用。
 */
async function collectRunning(engines: EngineEntry[]): Promise<RunningEntry[]> {
  const processes = await UnrealProcessDetector.getRunningProjects()

  return Promise.all(
    processes.map(async (proc) => {
      const association = proc.engineVersion
      const entry: RunningEntry = {
        pid: proc.pid,
        projectName: proc.projectName,
        projectPath: proc.projectPath,
        ...(association ? { engineAssociation: association } : {})
      }

      if (!association) return entry

      if (UnrealPathManagerUtil.isSourceBuildGUID(association)) {
        const resolved = await UnrealPathManagerUtil.resolveEngineVersionFromGUID(association)
        if (!resolved) return entry
        return {
          ...entry,
          engineVersion: resolved.version,
          engineRootPath: resolved.engineRootPath
        }
      }

      const matched = engines.find((engine) => engine.version === association)
      return {
        ...entry,
        engineVersion: association,
        ...(matched ? { engineRootPath: matched.rootPath } : {})
      }
    })
  )
}

export async function readEngineInventory(): Promise<EngineInventory> {
  const { bundledVersion } = UnrealPathManagerUtil.loadUALinkConfig()
  const { entries, degraded } = await collectEngines(bundledVersion)
  const running = await collectRunning(entries)
  return {
    engines: entries,
    running,
    bundledPluginVersion: bundledVersion,
    scanDegraded: degraded
  }
}

function describePlugin(entry: EngineEntry, bundledVersion: string): string {
  if (entry.agentLink === 'ok') return '引擎里装着 UnrealAgentLink'
  if (entry.agentLink === 'outdated') {
    return `引擎里那份 UnrealAgentLink 比盒子自带的 ${bundledVersion} 旧`
  }
  return '引擎里没有 UnrealAgentLink'
}

/**
 * 插件那一列怎么读。
 *
 * 不写这句的话，一排 `missing` 会被当成故障：模型会去劝用户挨个装插件，
 * 而实际上盒子打开工程时就把插件装进工程里、并把引擎里那份删掉 ——
 * 引擎里空着才是设计好的样子。
 */
const PLUGIN_FOOTNOTE =
  '插件那一列说的是**引擎目录**里有没有。盒子打开工程时会把 UnrealAgentLink 装进' +
  '「工程/Plugins」并在 .uproject 里启用，同时删掉引擎里那份 —— 所以引擎里没有是常态，' +
  '不代表工程连不上。工程能不能连，看工程自己的 Plugins 目录和 .uproject。'

/**
 * 一个引擎都没扫到时的说法。
 *
 * 关键是最后一句：不写死的话，模型接着就会去 `find_local_files` 扫盘找
 * `UnrealEditor.exe`，几分钟起步且中途停不下来。
 */
const NO_ENGINE_TEXT = [
  '这台机器上没扫到任何虚幻引擎。',
  '盒子读取 Epic Launcher 安装记录（macOS 扫描常见共享安装目录），',
  '以及用户在首页「引擎版本 +」里手动添加的自定义路径。',
  '自编译引擎没添加过就不在这份清单里 —— 请用户去首页添加，不要扫盘去找。'
].join('\n')

const SCAN_FAILED_TEXT = [
  '这次没能读到引擎清单（Epic Launcher 的安装记录读失败，通常是权限或路径问题）。',
  '**这不代表用户没装引擎** —— 别让他去重装，也别让他重新添加。',
  '让他点首页引擎区右上角的刷新重试；还是不行就看盒子日志里 UnrealPathManager 那几行。'
].join('\n')

export function formatInventory(inventory: EngineInventory): string {
  const { engines, running, bundledPluginVersion, scanDegraded } = inventory
  const lines: string[] = []

  if (engines.length === 0 && scanDegraded) {
    // 读失败不等于没装。说成「没装」的话，模型会让用户去装他已经装好的引擎
    lines.push(SCAN_FAILED_TEXT)
  } else if (engines.length === 0) {
    lines.push(NO_ENGINE_TEXT)
  } else {
    lines.push(`装好的虚幻引擎（${engines.length} 个）：`)
    for (const engine of engines) {
      lines.push(
        `- UE ${engine.version} — ${engine.rootPath}｜${describePlugin(engine, bundledPluginVersion)}`
      )
    }
    lines.push(PLUGIN_FOOTNOTE)
  }

  lines.push('')

  if (running.length === 0) {
    lines.push(
      '当前没有识别到运行中的项目（Windows 检测 UnrealEditor.exe，macOS 检测 UnrealEditor / UE4Editor）。'
    )
    return lines.join('\n')
  }

  lines.push(`正在运行的编辑器（${running.length} 个）：`)
  for (const proc of running) {
    const engine = proc.engineVersion
      ? `引擎 ${proc.engineVersion}${proc.engineRootPath ? ` → ${proc.engineRootPath}` : ''}`
      : // GUID 解析不出来通常是自编译引擎没在注册表里登记过。说清楚是「查不到」，
        // 别让模型把它当成「用的是列表里第一个引擎」
        `引擎未知（EngineAssociation=${proc.engineAssociation ?? '空'}，查不到对应的引擎目录）`
    lines.push(`- ${proc.projectName}（PID ${proc.pid}）— ${proc.projectPath}｜${engine}`)
  }

  return lines.join('\n')
}

const listEnginesTool = defineTool({
  name: 'list_engines',
  namespace: NAMESPACE,
  risk: 'safe',
  description: `列出这台机器上装好的虚幻引擎，以及此刻正在运行的编辑器。

【返回什么】
- 每个引擎：版本号、安装根目录、编辑器可执行文件、UnrealAgentLink 插件装没装
- 正在跑的编辑器：进程 PID、打开的 .uproject、它用的引擎版本和引擎目录
  （自编译引擎的 EngineAssociation 是一串 GUID，这里会查注册表还原成版本号）

【什么时候用】
- 用户问「我这装了哪些引擎」「引擎装在哪」
- 要确认某个工程的 EngineAssociation 在这台机器上有没有对应的引擎
- 用户问某个引擎里有没有装插件、要不要清理引擎里的旧插件

【什么时候不用】**打开工程之前不用调这个**。open_project 是把 .uproject 交给
系统打开，用哪个引擎由 Windows 按 EngineAssociation 自己定，你既不需要也无法
指定 —— 先盘点一遍引擎既慢又改变不了结果。

【插件那一列怎么读】它说的是引擎目录里有没有。盒子打开工程时会把插件装进
「工程/Plugins」并删掉引擎里那份，所以引擎里没有是常态，不是故障。

【别自己去翻】这份清单来自 Epic Launcher 的安装记录加用户手动添加的路径，
比注册表全 —— 注册表里往往只登记了其中几个版本。不要用 shell 去 reg query，
也不要扫盘找 UnrealEditor.exe，那既慢又比这里少。

【无需参数】直接调用。`,
  input: z.object({}),
  execute: async () => {
    const inventory = await readEngineInventory()
    return { text: formatInventory(inventory), details: inventory }
  }
})

/** 引擎清单工具。V3 原生（带 risk 声明），不走 V2 适配层 */
export const engineTools: UnrealAgentTool<never>[] = [
  listEnginesTool as unknown as UnrealAgentTool<never>
]
