import { describe, expect, it } from 'vitest'

import { countSkillsBySource, filterSkills, type SkillEntry } from './skillFilter'

const SKILLS: SkillEntry[] = [
  {
    name: 'ue-greybox-blockout',
    description: '搭一个能认出形状的灰盒场景',
    source: 'builtin',
    enabled: true
  },
  { name: 'ue-fog-card-placement', description: '摆体积雾卡片', source: 'user', enabled: true },
  {
    name: 'Blender-UE-Pipeline',
    description: 'Round-trip meshes through Blender',
    source: 'builtin',
    // 关掉的那条：筛选不该因此把它藏起来，藏了就没法再打开
    enabled: false
  },
  { name: 'vendor-tool', description: '第三方插件带来的', source: 'plugin', enabled: true }
]

describe('filterSkills', () => {
  it('不给条件就原样返回，且保持输入顺序', () => {
    const result = filterSkills(SKILLS, { query: '', source: 'all' })
    expect(result.map((s) => s.name)).toEqual([
      'ue-greybox-blockout',
      'ue-fog-card-placement',
      'Blender-UE-Pipeline',
      'vendor-tool'
    ])
  })

  it('按来源筛', () => {
    expect(filterSkills(SKILLS, { query: '', source: 'user' }).map((s) => s.name)).toEqual([
      'ue-fog-card-placement'
    ])
    expect(filterSkills(SKILLS, { query: '', source: 'plugin' }).map((s) => s.name)).toEqual([
      'vendor-tool'
    ])
  })

  it('关键词匹配说明，不只是名字', () => {
    // 技能名都是英文 kebab-case，中文用户记得住的是说明里那句话
    const result = filterSkills(SKILLS, { query: '灰盒', source: 'all' })
    expect(result.map((s) => s.name)).toEqual(['ue-greybox-blockout'])
  })

  it('关键词不区分大小写', () => {
    expect(filterSkills(SKILLS, { query: 'blender', source: 'all' }).map((s) => s.name)).toEqual([
      'Blender-UE-Pipeline'
    ])
  })

  it('只有空白的关键词等于不筛', () => {
    expect(filterSkills(SKILLS, { query: '   ', source: 'all' })).toHaveLength(SKILLS.length)
  })

  it('关掉的技能照样列出来 —— 藏起来就没法再打开了', () => {
    const result = filterSkills(SKILLS, { query: 'blender', source: 'all' })
    expect(result.map((s) => s.name)).toEqual(['Blender-UE-Pipeline'])
    expect(result[0].enabled).toBe(false)
  })

  it('两个条件是且的关系', () => {
    // ue- 两条都匹配，但只有一条是自己的
    expect(filterSkills(SKILLS, { query: 'ue-', source: 'user' }).map((s) => s.name)).toEqual([
      'ue-fog-card-placement'
    ])
    expect(filterSkills(SKILLS, { query: '灰盒', source: 'user' })).toEqual([])
  })
})

describe('countSkillsBySource', () => {
  it('三个来源都给出来', () => {
    expect(countSkillsBySource(SKILLS)).toEqual({ builtin: 2, plugin: 1, user: 1 })
  })

  it('没有的来源是 0 而不是 undefined —— 标签上要显示这个数', () => {
    expect(countSkillsBySource([])).toEqual({ builtin: 0, plugin: 0, user: 0 })
  })
})
