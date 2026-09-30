import { describe, expect, it } from 'vitest'

import { patternCovered } from './admission'
import {
  parseExperienceFile,
  serializeExperienceFile,
  type ExperienceEntry
} from './experienceFile'
import { digestArgs } from './trail'

const entry: ExperienceEntry = {
  id: 'e-1',
  title: 't',
  tool: 'ue_run_python_script',
  errorPattern: "object has no attribute 'is_hidden'",
  advice: 'a',
  expect: { param: 'script' },
  source: '',
  status: 'trial'
}

describe('代码审查修复的回归', () => {
  it('长脚本的参数摘要仍是合法 JSON；只改了尾部的两段脚本摘要不同', () => {
    const head = 'x'.repeat(2000)
    const a = digestArgs({ script: `${head}\nactor.is_hidden` })
    const b = digestArgs({ script: `${head}\nactor.is_hidden_ed()` })
    expect(() => JSON.parse(a)).not.toThrow()
    expect((JSON.parse(a) as { script: string }).script).not.toBe(
      (JSON.parse(b) as { script: string }).script
    )
  })

  it('片段里的双引号原样写回，读出来还是原报错里的那一段', () => {
    const quoted = {
      ...entry,
      tool: 'ue_set_property',
      errorPattern: 'property "foo" not found on actor'
    }
    const text = serializeExperienceFile('ue_set_property', [quoted])
    expect(parseExperienceFile(text)[0].errorPattern).toBe('property "foo" not found on actor')
  })

  it('上帝工具的片段也能查出重复', () => {
    expect(patternCovered([entry], entry.tool, "object has no attribute 'is_hidden'")).toBe(true)
    expect(patternCovered([entry], entry.tool, "object has no attribute 'get_actor_label'")).toBe(
      false
    )
  })
})
