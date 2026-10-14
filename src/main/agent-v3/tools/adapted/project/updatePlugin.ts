/**
 * `project_update_plugin` —— 把随包的 UnrealAgentLink 装进 / 更新到工程里，并安全地重启编辑器。
 *
 * ## 它替掉的是哪句话
 *
 * 十来个工具碰到「插件太旧」「插件没装上」时，原来都说「请用户在盒子设置里更新插件后
 * 重启编辑器」「让用户在工程卡片右键里手动安装一次」。可插件装在哪、该装哪个引擎版本的包、
 * 编辑器开着时 DLL 被占着换不掉 —— 这些盒子全知道，用户不该替我们记。
 * 装插件的函数（`ensureUnrealAgentLinkPlugin`）一直都在，只是模型够不着：
 * 只有 `open_project` 和团队快照回滚会调它。
 *
 * ## 四步，和 `cpp_full_rebuild` 同一套
 *
 * 1. **先看要不要动**：磁盘上已经是随包那一份、编辑器也连着（或者没开），就什么都不做 ——
 *    这个工具要关用户的编辑器，白关一次是实打实的打扰。
 * 2. **关编辑器**：`closeEditorForProject`，有未保存的改动先拒绝。必须先关：
 *    编辑器开着时插件 DLL 被占用，换不掉（安装那一步会原样保留旧插件）。
 * 3. **装插件**：`installUnrealAgentLinkPlugin`（工程卡片右键「安装」同一个函数），装完回读磁盘。
 * 4. **重开、等连回来**：原来开着才重开（`awaitProjectLive`）。原来没开就不替用户开。
 *
 * 用户在这个工程上点过「移除 UnrealAgentLink」的，默认不装回去 —— 那是用户的决定。
 */

import { shell } from 'electron'
import { basename, dirname, join } from 'path'
import { z } from 'zod'

import UnrealProcessDetector from '../../../../utils/UnrealProcessDetector'
import { readUeJsonFile } from '../../../../utils/ueTextFile'
import { getTargetProjectPath } from '../../../core/projectTargetContext'
import { defineTool, type UnrealAgentTool } from '../../defineTool'
import { findUproject } from '../../builtin/projectPackage'
import { awaitProjectLive } from './awaitProjectLive'
import { closeEditorForProject, connectionFor } from './closeEditor'

/** 编辑器重新打开、插件连回来的上限（同 cpp_full_rebuild） */
const REOPEN_WAIT_MS = 8 * 60_000

/** 装插件那几个函数按需加载：它们的模块一加载就连数据库、读设置（同 cpp_full_rebuild） */
const pluginLib = (): Promise<typeof import('../../../../sqliteDataBase/ipc/project')> =>
  import('../../../../sqliteDataBase/ipc/project')

/**
 * 装不上的原因码翻成人话。`ensureUnrealAgentLinkPlugin` 回的有的是码、有的已经是句子，
 * 认不出的原样带回 —— 原因不能消失。
 */
export function describeInstallFailure(reason: string | undefined): string {
  if (!reason) return '原因不明'
  const known: Record<string, string> = {
    UPROJECT_UNREADABLE: '.uproject 文件读不出来（可能损坏了）',
    NO_ENGINE_ASSOCIATION:
      '.uproject 里没写用哪个引擎（EngineAssociation），不知道该装哪个版本的插件',
    PLUGIN_FILES_MISSING: '插件文件没能落到工程的 Plugins 目录里'
  }
  const code = reason.replace(/^插件文件安装到项目失败：/, '').trim()
  return known[code] ?? reason
}

/** 磁盘上的插件是不是随包那一份（版本号 + 构建指纹）。判断不了就当不是，交给完整安装去处理 */
async function pluginFilesFresh(uproject: string): Promise<boolean> {
  try {
    const { default: UnrealPathManagerUtil } = await import('../../../../utils/UnrealPathManager')
    let version = String(
      (await readUeJsonFile<{ EngineAssociation?: unknown }>(uproject)).EngineAssociation ?? ''
    )
    if (!version) return false
    if (UnrealPathManagerUtil.isSourceBuildGUID(version)) {
      const resolved = await UnrealPathManagerUtil.resolveEngineVersionFromGUID(version)
      if (!resolved) return false
      version = resolved.version
    }
    return await UnrealPathManagerUtil.isProjectPluginUpToDate(
      join(dirname(uproject), 'Plugins', 'UnrealAgentLink'),
      version
    )
  } catch {
    return false
  }
}

const InputSchema = z.object({
  project_path: z
    .string()
    .optional()
    .describe('工程目录（含 .uproject 的那一层）。省略 = 这一轮正在干的工程'),
  discard_unsaved: z
    .boolean()
    .optional()
    .describe(
      '编辑器里有未保存的改动时，丢掉它们强行关闭。**只有用户明确说可以丢时才用**，不可撤销。' +
        '正常做法是先 ue_save 再调'
    ),
  reinstall_removed: z
    .boolean()
    .optional()
    .describe(
      '用户之前在这个工程上主动移除过插件时，默认不装回去。**只有用户明确要求装回来时才设 true**'
    )
})

export interface UpdatePluginResult {
  /** 这次是否真的装 / 换了插件文件 */
  updated: boolean
  closedEditor: boolean
  reopened: boolean
  live: boolean
  /** 装完之后从磁盘读回来的版本号，读不到是 null */
  version: string | null
  previousVersion: string | null
}

export function createProjectUpdatePluginTool(): UnrealAgentTool<UpdatePluginResult> {
  return defineTool<typeof InputSchema, UpdatePluginResult>({
    name: 'project_update_plugin',
    namespace: 'project',
    // 要关掉再重开用户的编辑器 —— 始终要用户点头
    risk: 'destructive',
    concurrency: 'sequential',
    input: InputSchema,
    description:
      '把盒子自带的 UnrealAgentLink 插件装进 / 更新到工程里：关掉编辑器 → 装插件 → 重新打开工程并等插件连回来。' +
      '整套由盒子完成，**不要让用户自己去更新插件、重启编辑器**。\n\n' +
      '【什么时候用】别的工具报「插件太旧」「没有这条命令」「插件没装上」，' +
      '或者编辑器开着但盒子一直连不上、ue_session_health 说插件没加载时。\n' +
      '【已经是最新就什么都不做】不会白关一次编辑器。\n' +
      '【先存盘】编辑器里有未保存的改动会被拒绝并列出清单，先 ue_save 再调。\n' +
      '【编辑器原来没开】只装插件，不替用户打开；要用引擎再 open_project。\n' +
      '【返回 live=true 就是已经连回来了】可以直接接着发引擎命令。',
    execute: async ({ project_path, discard_unsaved, reinstall_removed }, ctx) => {
      const given = project_path ?? getTargetProjectPath()
      if (!given) throw new Error('不知道给哪个工程装：这一轮没有连着的工程，请给 project_path')
      const projectDir = given.toLowerCase().endsWith('.uproject') ? dirname(given) : given
      const uproject = await findUproject(projectDir)
      const projectName = basename(uproject, '.uproject')
      const lib = await pluginLib()

      const before = await lib.getUnrealAgentLinkStatus(uproject)
      if (before.optedOut && !reinstall_removed) {
        throw new Error(
          `用户之前在 ${projectName} 上主动移除过 UnrealAgentLink，盒子不会自己装回去。` +
            '先问用户要不要装回来；用户同意了再带 reinstall_removed=true 调一次。'
        )
      }

      const result: UpdatePluginResult = {
        updated: false,
        closedEditor: false,
        reopened: false,
        live: false,
        version: before.version,
        previousVersion: before.version
      }

      // ── 1. 要不要动 ──
      const fresh =
        before.installed && before.enabledInUproject && (await pluginFilesFresh(uproject))
      const running = await UnrealProcessDetector.findRunningProjectByPath(uproject)
      const connected = Boolean(connectionFor(projectDir))
      if (fresh && (!running || connected)) {
        result.live = Boolean(running && connected)
        return {
          text:
            `✓ ${projectName} 里的 UnrealAgentLink 已经是盒子自带的最新一份` +
            `${before.version ? `（${before.version}）` : ''}，不用更新，编辑器没动。` +
            (running ? '' : '编辑器没开；要用引擎就 open_project。'),
          details: result
        }
      }
      // 磁盘上已是新的、编辑器开着却没连上：插件是编辑器启动之后才装的，重启一次就能加载

      // ── 2. 关编辑器 ──
      result.closedEditor = await closeEditorForProject({
        projectDir,
        uproject,
        discardUnsaved: discard_unsaved,
        purpose: '更新插件',
        report: (text) => ctx.report({ text }),
        signal: ctx.signal
      })
      ctx.signal?.throwIfAborted()

      // ── 3. 装 ──
      ctx.report({ text: '安装 UnrealAgentLink…' })
      const install = await lib.installUnrealAgentLinkPlugin(uproject)
      const after = await lib.getUnrealAgentLinkStatus(uproject)
      result.version = after.version
      result.updated = install.success

      const lines: string[] = []
      if (install.success) {
        lines.push(
          `✓ UnrealAgentLink 已装到 ${projectName}` +
            (before.installed && before.version !== after.version
              ? `（${before.version ?? '版本不明'} → ${after.version ?? '版本不明'}）。`
              : `${after.version ? `（${after.version}）` : ''}。`)
        )
      } else {
        lines.push(`✗ UnrealAgentLink 没装上：${describeInstallFailure(install.error)}。`)
        lines.push('工程里原来的插件没有被动过。把原因如实告诉用户，不要让用户去手动安装。')
      }
      if (result.closedEditor) lines.push('（安装前已关闭编辑器。）')

      // ── 4. 重开、等连回来 ──
      if (result.closedEditor) {
        // 装没装上都要把编辑器还给用户：是我们关的
        ctx.report({ text: '重新打开工程…' })
        const openError = await shell.openPath(uproject)
        if (openError) {
          lines.push(`✗ 重新打开工程失败：${openError}`)
        } else {
          result.reopened = true
          const live = await awaitProjectLive({
            projectPath: projectDir,
            timeoutMs: REOPEN_WAIT_MS,
            signal: ctx.signal
          })
          result.live = live.live && live.retargeted
          lines.push(
            result.live
              ? '✓ 编辑器已重新打开并连上，这一轮的引擎命令已经发往它，可以接着干活。'
              : '编辑器已经在启动，但还没连上（大工程首次加载要编着色器，几分钟是常态）。' +
                  '用 ue_session_health 带 wait_seconds 等它，**不要再调一次这个工具**。'
          )
        }
      } else if (install.success) {
        lines.push('编辑器原来没开，下次打开工程时生效；要用引擎就 open_project。')
      }

      const text = lines.join('\n')
      if (!install.success) throw new Error(text)
      return { text, details: result }
    }
  })
}
