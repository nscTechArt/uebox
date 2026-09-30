/**
 * 给一个 agent 实例装上经验运行时。`createAgent` 只调这一个入口。
 *
 * 什么时候不装：
 * - 技能沉淀开关是 off —— 用户说了不学，那就既不记账也不出场；
 * - 不知道是哪个工程 —— 原始账和本工程经验都按工程存，没有工程就没有地方放。
 *
 * 不碰 electron：经验的「家」在哪由宿主给（`SessionContext.experienceHome`，
 * 即 `<userData>/experience`）。它本身就是通用层目录，原始账在它的 `.trail/` 下。
 * 没给（测试、无头跑）就只有本工程这一层，也不记原始账。
 */

import { createHash } from 'crypto'
import { join } from 'path'

import type { SkillLearningMode } from '../capabilities/skills'
import { effectiveRisk, type ToolMeta } from '../tools/defineTool'
import { engineMinor } from './experienceFile'
import { createExperienceRuntime, type ExperienceRuntime } from './runtime'
import { ExperienceStore, experienceDir } from './store'
import { TRAIL_SUBDIR, TrailWriter } from './trail'

export interface SessionExperienceOptions {
  sessionId: string
  projectRoot?: string
  engineVersion?: string
  skillLearning: SkillLearningMode
  uiLanguage?: 'zh-CN' | 'en-US'
  /** `<userData>/experience`：通用层目录，原始账在它下面 */
  home?: string
  tools: { name: string; unrealBox?: ToolMeta }[]
  /** 对照组抽签用的随机数。只有测试会给 */
  random?: () => number
}

/**
 * 引擎工具，且这一次不是破坏性操作。
 *
 * 删除这类操作不学：「删不掉就换个法子删」不是该沉淀的知识，
 * 而设计稿里「权限、删除、安全相关的规则永远不自动产生」正是这条的来由。
 */
export function isLearnableMeta(meta: ToolMeta | undefined, args: unknown): boolean {
  if (!meta) return false
  const ns = meta.namespace
  const engine = ns === 'ue' || ns.startsWith('ue.') || ns === 'ue-system'
  return engine && effectiveRisk(meta, args) !== 'destructive'
}

/** 工程的指纹：升级登记只需要分清是不是同一个工程，不需要知道它在哪 */
export function projectKeyOf(projectRoot: string): string {
  return createHash('sha1')
    .update(projectRoot.replace(/\\/g, '/').toLowerCase())
    .digest('hex')
    .slice(0, 12)
}

export function createSessionExperience(
  options: SessionExperienceOptions
): ExperienceRuntime | undefined {
  if (options.skillLearning === 'off') return undefined
  const dir = experienceDir(options.projectRoot)
  if (!dir || !options.projectRoot) return undefined

  const metaByName = new Map(options.tools.map((tool) => [tool.name, tool.unrealBox]))
  // 子任务（`<会话>:sub-1`）写进主会话那一份账：整理员在主会话结束时一起看
  const rootSession = options.sessionId.split(':')[0]
  const engine = engineMinor(options.engineVersion)

  return createExperienceRuntime({
    project: new ExperienceStore(dir),
    ...(options.home ? { global: new ExperienceStore(options.home) } : {}),
    projectKey: projectKeyOf(options.projectRoot),
    ...(engine ? { engine } : {}),
    agentId: options.sessionId,
    ...(options.random ? { random: options.random } : {}),
    isLearnableTool: (tool, args) => isLearnableMeta(metaByName.get(tool), args),
    ...(options.home
      ? {
          trail: new TrailWriter(join(options.home, TRAIL_SUBDIR), {
            sessionId: rootSession,
            projectRoot: options.projectRoot,
            ...(options.engineVersion ? { engineVersion: options.engineVersion } : {}),
            skillLearning: options.skillLearning,
            ...(options.uiLanguage ? { language: options.uiLanguage } : {})
          })
        }
      : {})
  })
}
