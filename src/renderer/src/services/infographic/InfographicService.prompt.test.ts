import { describe, expect, it } from 'vitest'
import { composeInfographicPrompt } from './InfographicService'
import { DEFAULT_INFOGRAPHIC_CONFIG } from './types'

describe('composeInfographicPrompt', () => {
  it('将标题和内容填入用户自定义模板的所有占位符', () => {
    const prompt = composeInfographicPrompt(
      {
        ...DEFAULT_INFOGRAPHIC_CONFIG,
        prompt: '{title}：{content}\n再次强调 {title}'
      },
      '引擎架构',
      '三个关键模块'
    )

    expect(prompt).toBe('引擎架构：三个关键模块\n再次强调 引擎架构')
  })

  it('自定义 Prompt 为空白时回退到默认模板', () => {
    const prompt = composeInfographicPrompt(
      { ...DEFAULT_INFOGRAPHIC_CONFIG, prompt: '   ' },
      '知识库标题',
      '知识内容摘要'
    )

    expect(prompt).toContain('知识库标题')
    expect(prompt).toContain('知识内容摘要')
    expect(prompt).not.toContain('{title}')
    expect(prompt).not.toContain('{content}')
  })
})
