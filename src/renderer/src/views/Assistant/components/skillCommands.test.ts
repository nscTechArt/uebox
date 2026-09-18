import { describe, expect, it } from 'vitest'
import type { AgentV3SkillSummary } from '@/api/agentV3'
import { filterSkillCommands, parseSkillSlashQuery, skillMention } from './skillCommands'

const skills: AgentV3SkillSummary[] = [
  {
    name: 'ue-project-audit',
    description: '体检工程与关卡',
    source: 'builtin',
    enabled: true
  },
  {
    name: 'ui-layout-helper',
    description: '设计编辑器界面',
    source: 'user',
    enabled: true
  },
  {
    name: 'asset-organizer',
    description: '整理 UI 资产',
    source: 'plugin',
    enabled: true
  }
]

describe('skill slash commands', () => {
  it('识别 / 查询，把已经写成正文的内容留给原有流程', () => {
    expect(parseSkillSlashQuery('/')).toBe('')
    expect(parseSkillSlashQuery('/ui')).toBe('ui')
    expect(parseSkillSlashQuery('/ui 帮我设计')).toBeNull()
    expect(parseSkillSlashQuery('请使用 /ui')).toBeNull()
  })

  /**
   * 真命令要能被搜到 —— 这正是这次补的发现路径。
   *
   * 原来 `/goal` 落在保留字里返回 null，面板直接消失：一个真命令给出的反馈
   * 和一个拼错的词一模一样。
   */
  it('真命令照常开面板，让命令组把它列出来', () => {
    expect(parseSkillSlashQuery('/goa')).toBe('goa')
    expect(parseSkillSlashQuery('/goal')).toBe('goal')
    expect(parseSkillSlashQuery('/ask')).toBe('ask')
  })

  /** `/wiki` 打全了要把面板让给它自己那个知识库选择层，两个浮层同时开会打架 */
  it('自带界面的 /wiki 打全后交出面板，没打全时不拦', () => {
    expect(parseSkillSlashQuery('/wik')).toBe('wik')
    expect(parseSkillSlashQuery('/wiki')).toBeNull()
    expect(parseSkillSlashQuery('/WIKI')).toBeNull()
  })

  /**
   * V2 Router 时代的命令已经下线，不该再占着保留字。
   *
   * 占着的唯一效果是这些词既不触发命令、也不触发技能搜索 —— 打了掉进真空。
   */
  it('下线的 V2 命令不再吞掉技能搜索', () => {
    expect(parseSkillSlashQuery('/routing-stats')).toBe('routing-stats')
    expect(parseSkillSlashQuery('/bp')).toBe('bp')
    expect(parseSkillSlashQuery('/router')).toBe('router')
  })

  it('名称命中优先于描述命中，并保留稳定顺序', () => {
    expect(filterSkillCommands(skills, 'ui').map((skill) => skill.name)).toEqual([
      'ui-layout-helper',
      'asset-organizer'
    ])
    expect(filterSkillCommands(skills, 'missing')).toEqual([])
  })

  it('选择后写入模型可识别的显式技能标记', () => {
    expect(skillMention('ue-project-audit')).toBe('$ue-project-audit ')
  })
})
