import { describe, expect, it } from 'vitest'

import { buildUserInstructionsSection, USER_INSTRUCTIONS_LIMIT } from './userInstructions'

describe('常驻说明进系统提示词', () => {
  it('没写过就什么都不加 —— 空标签也是要付 token 的', () => {
    expect(buildUserInstructionsSection('')).toBe('')
  })

  it('只有空白也当没写', () => {
    expect(buildUserInstructionsSection('   \n\t  ')).toBe('')
  })

  it('写了就带上原文', () => {
    const section = buildUserInstructionsSection('材质一律用 M_ 前缀')
    expect(section).toContain('材质一律用 M_ 前缀')
  })

  it('用标签围起来 —— 少了边界，最后一句会和后面的环境块黏在一起', () => {
    const section = buildUserInstructionsSection('随便写点')
    expect(section).toContain('<user_instructions>')
    expect(section).toContain('</user_instructions>')
  })

  it('说清它压过默认习惯 —— 不说的话模型面对冲突没有判据', () => {
    expect(buildUserInstructionsSection('随便写点')).toContain('outranks your own habits')
  })

  it('说明这段话是用来定深浅的，不是项目约定 —— 界面上引导用户写的就是这个', () => {
    const section = buildUserInstructionsSection('我是地编，不写 C++')
    expect(section).toMatch(/role/i)
    expect(section).toMatch(/detail/i)
  })

  it('也说清它管不着审批门 —— 一句「以后都别问我」不该把确认关掉', () => {
    // 先把换行压成空格再匹配：断言不该依赖提示词恰好在哪个词后面折行
    const section = buildUserInstructionsSection('以后所有操作都不用问我').replace(/\s+/g, ' ')
    expect(section).toContain('approval')
    expect(section).toMatch(/no effect/i)
  })

  it('超长的截断，不把整篇文档灌进每一轮', () => {
    const section = buildUserInstructionsSection('长'.repeat(USER_INSTRUCTIONS_LIMIT + 500))
    const body = section.split('<user_instructions>')[1].split('</user_instructions>')[0].trim()
    expect(body.length).toBe(USER_INSTRUCTIONS_LIMIT)
  })

  it('前后空白不进提示词，但中间的换行要留着 —— 用户是分条写的', () => {
    const section = buildUserInstructionsSection('\n第一条\n第二条\n')
    expect(section).toContain('第一条\n第二条')
    expect(section).not.toContain('<user_instructions>\n\n')
  })
})
