import { describe, expect, it } from 'vitest'

import { createSessionExperience, isLearnableMeta } from './session'
import { assertNotWritingExperience } from './writeGuard'

describe('isLearnableMeta', () => {
  it('只学引擎工具，破坏性的不学', () => {
    expect(isLearnableMeta({ namespace: 'ue.blueprint', risk: 'mutating' }, {})).toBe(true)
    expect(isLearnableMeta({ namespace: 'ue', risk: 'safe' }, {})).toBe(true)
    expect(isLearnableMeta({ namespace: 'local', risk: 'safe' }, {})).toBe(false)
    expect(isLearnableMeta({ namespace: 'ue.content', risk: 'destructive' }, {})).toBe(false)
    expect(isLearnableMeta(undefined, {})).toBe(false)
  })
})

describe('createSessionExperience', () => {
  it('沉淀开关关着、或者不知道是哪个工程，就不装', () => {
    const base = { sessionId: 's', tools: [] }
    expect(
      createSessionExperience({ ...base, projectRoot: 'H:/P/Game', skillLearning: 'off' })
    ).toBeUndefined()
    expect(createSessionExperience({ ...base, skillLearning: 'ask' })).toBeUndefined()
    expect(
      createSessionExperience({ ...base, projectRoot: 'H:/P/Game', skillLearning: 'ask' })
    ).toBeDefined()
  })
})

describe('assertNotWritingExperience', () => {
  it('挡住写经验目录，别的 .uebox 子目录照常', () => {
    expect(assertNotWritingExperience('H:\\P\\Game\\.uebox\\experience\\ue_save.md')).toBeDefined()
    expect(assertNotWritingExperience('H:/P/Game/.uebox/EXPERIENCE/.ledger.json')).toBeDefined()
    expect(assertNotWritingExperience('H:/P/Game/.uebox/skills/my/SKILL.md')).toBeUndefined()
    expect(assertNotWritingExperience('H:/P/Game/.uebox/experience-notes.md')).toBeUndefined()
  })
})
