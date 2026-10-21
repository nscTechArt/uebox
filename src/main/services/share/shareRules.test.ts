import { describe, expect, it } from 'vitest'

import { checkBundle, isShareablePath, parseShareRef } from './shareRules'

const skillMd = (name: string, description = 'Renames assets. Use when tidying folders.'): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# Steps\n`

describe('parseShareRef', () => {
  it.each([
    ['ue-level-organize', 'ue-level-organize'],
    ['uebox.ai/s/ue-level-organize', 'ue-level-organize'],
    ['https://uebox.ai/s/ue-level-organize/', 'ue-level-organize'],
    ['https://www.uebox.ai/en/s/ue-level-organize', 'ue-level-organize'],
    ['unrealbox://install-skill?id=ue-level-organize', 'ue-level-organize'],
    ['  ue-level-organize  ', 'ue-level-organize']
  ])('认得 %s', (raw, id) => {
    expect(parseShareRef(raw)).toBe(id)
  })

  it.each([
    'https://evil.example.com/s/ue-level-organize',
    'uebox.ai/s/../secrets',
    'unrealbox://install-skill?id=../x',
    'unrealbox://join?server=x',
    'Has Upper',
    ''
  ])('认不出 %s 时返回 null，不去猜', (raw) => {
    expect(parseShareRef(raw)).toBeNull()
  })
})

describe('isShareablePath', () => {
  it.each(['SKILL.md', 'references/a.md', 'assets/example.json', 'references/b.YAML'])(
    '收 %s',
    (p) => expect(isShareablePath(p)).toBe(true)
  )
  it.each([
    'scripts/run.py',
    'references/deep/a.md',
    'references/.hidden.md',
    'assets/tool.exe',
    'notes.md',
    '../SKILL.md'
  ])('不收 %s', (p) => expect(isShareablePath(p)).toBe(false))
})

describe('checkBundle', () => {
  it('合规的包通过，并读出名字和描述', () => {
    const check = checkBundle([
      { path: 'SKILL.md', content: skillMd('rename-assets') },
      { path: 'references/naming.md', content: 'SM_ for static meshes' }
    ])
    expect(check).toEqual({
      ok: true,
      name: 'rename-assets',
      description: 'Renames assets. Use when tidying folders.'
    })
  })

  it('带脚本的包被拒', () => {
    const check = checkBundle([
      { path: 'SKILL.md', content: skillMd('rename-assets') },
      { path: 'scripts/run.py', content: 'import os' }
    ])
    expect(check.ok).toBe(false)
  })

  it('缺 SKILL.md、带 BOM、名字不合规、描述有尖括号都被拒', () => {
    expect(checkBundle([{ path: 'references/a.md', content: 'x' }]).ok).toBe(false)
    expect(checkBundle([{ path: 'SKILL.md', content: `\uFEFF${skillMd('a-b')}` }]).ok).toBe(false)
    expect(checkBundle([{ path: 'SKILL.md', content: skillMd('Bad_Name') }]).ok).toBe(false)
    expect(checkBundle([{ path: 'SKILL.md', content: skillMd('my-claude-helper') }]).ok).toBe(false)
    expect(checkBundle([{ path: 'SKILL.md', content: skillMd('a-b', 'Use <tag>') }]).ok).toBe(false)
  })

  it('超过 256 KB 被拒', () => {
    const big = 'x'.repeat(256 * 1024)
    const check = checkBundle([
      { path: 'SKILL.md', content: skillMd('a-b') },
      { path: 'references/big.md', content: big }
    ])
    expect(check.ok).toBe(false)
  })
})
