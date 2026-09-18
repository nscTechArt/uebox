/**
 * 工具注册表诊断。
 *
 * 与 `smoke.ts` 分开：那个要能在裸 node 进程里被 `require()`（ESM→CJS 回归护栏），
 * 所以不能碰工具树 —— 工具树会拉进 electron / @aws-sdk / sharp。
 * 这里没有那个约束，可以自由 import。
 */

import { buildAllTools } from './tools/registry'
import { discoverEnabledSkills, skillDirectories } from './capabilities/skills'

export interface ToolDiagnostics {
  ok: boolean
  /** 注册表里的工具总数 */
  toolCount: number
  /** 未连接引擎时可用的工具数 —— 应当只剩不依赖引擎的本地能力 */
  toolCountWithoutUe: number
  /** 按命名空间分组，用于确认没有整组漏注册 */
  toolsByNamespace: Record<string, number>
  /** 按风险分组，用于确认审批策略覆盖到位 */
  toolsByRisk: Record<string, number>
  /** 发现的 skill 数量。打包后 resources/skills 路径解析是常见翻车点 */
  skillCount: number
  /** 实际搜索过的 skill 目录，路径不对时一眼能看出来 */
  skillDirs: string[]
  error?: string
}

export async function collectToolDiagnostics(): Promise<ToolDiagnostics> {
  // 带上插件贡献的目录 —— 报告里的路径要和实际搜索路径一致，
  // 否则「skillCount 变了但 skillDirs 没变」会让人以为是 bug
  let skillDirs = skillDirectories()
  let skillCount = 0
  try {
    const { enabledPluginSkillDirs } = await import('./capabilities/plugins/registry')
    skillDirs = skillDirectories(await enabledPluginSkillDirs().catch(() => []))
    skillCount = (await discoverEnabledSkills()).length
  } catch {
    // discoverEnabledSkills 自己已经吞了异常，这里只是双保险
  }

  try {
    const tools = buildAllTools()
    const toolsByNamespace: Record<string, number> = {}
    const toolsByRisk: Record<string, number> = {}

    for (const tool of tools) {
      const { namespace, risk } = tool.unrealBox
      toolsByNamespace[namespace] = (toolsByNamespace[namespace] ?? 0) + 1
      toolsByRisk[risk] = (toolsByRisk[risk] ?? 0) + 1
    }

    return {
      ok: true,
      toolCount: tools.length,
      toolCountWithoutUe: tools.filter((t) => !t.unrealBox.namespace.startsWith('ue.')).length,
      toolsByNamespace,
      toolsByRisk,
      skillCount,
      skillDirs
    }
  } catch (error) {
    return {
      ok: false,
      toolCount: 0,
      toolCountWithoutUe: 0,
      toolsByNamespace: {},
      toolsByRisk: {},
      skillCount,
      skillDirs,
      error: (error as Error).message
    }
  }
}
