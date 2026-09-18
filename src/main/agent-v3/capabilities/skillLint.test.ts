import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { formatSkillLint, isSkillFile, lintSkillFile } from './skillLint'

const root = mkdtempSync(join(tmpdir(), 'skill-lint-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** 一份够用的工具名清单，形状和真实注册表一致（前缀是判据的一半） */
const TOOLS = new Set([
  'ue_get_actor',
  'ue_save',
  'ue_save_level',
  'material_describe',
  'material_apply',
  'mesh_describe',
  'write_local_file',
  'create_note'
])

/** 写一个 skill，返回 SKILL.md 的路径 */
function writeSkill(dirName: string, content: string): string {
  const dir = join(root, dirName)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'SKILL.md')
  writeFileSync(path, content, 'utf8')
  return path
}

function frontmatter(name: string, description = '干点什么。Use when 用户说做这个。'): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n`
}

describe('isSkillFile', () => {
  it.each([
    'C:/x/skills/my-skill/SKILL.md',
    'C:\\x\\skills\\my-skill\\SKILL.md',
    '/home/me/skills/my-skill/skill.md'
  ])('认出 %s', (p) => expect(isSkillFile(p)).toBe(true))

  // 体检报告贴在写文件的返回值里，别的文件后面多出一段报告是纯噪音
  it.each(['C:/x/notes.md', 'C:/x/skills/my-skill/references/wiring.md', 'C:/x/SKILL.md.bak'])(
    '放过 %s',
    (p) => expect(isSkillFile(p)).toBe(false)
  )
})

/**
 * 这三种坏法的共同点：文件在盘上、编辑器打开一切正常，但 `discoverSkills`
 * 会直接跳过它 —— 用户以为沉淀成功了，清单里根本没有。
 */
describe('会导致 skill 加载不到的问题', () => {
  it('BOM 开头', async () => {
    const path = writeSkill('bom-skill', `\uFEFF${frontmatter('bom-skill')}# 正文\n`)
    const problems = await lintSkillFile(path, TOOLS)

    expect(problems.some((p) => p.severity === 'blocking' && /BOM/.test(p.message))).toBe(true)
  })

  it('根本没有 frontmatter', async () => {
    const path = writeSkill('no-fm', '# 直接就是正文\n')
    const problems = await lintSkillFile(path, TOOLS)

    expect(problems).toHaveLength(1)
    expect(problems[0]!.severity).toBe('blocking')
    expect(problems[0]!.message).toContain('frontmatter')
  })

  it('没有 name', async () => {
    const path = writeSkill('no-name', '---\ndescription: 有描述没名字。\n---\n\n# 正文\n')
    const problems = await lintSkillFile(path, TOOLS)

    expect(problems.some((p) => p.severity === 'blocking' && /name/.test(p.message))).toBe(true)
  })

  /**
   * 没有 description 不影响加载，但清单里就没有判据 —— 模型永远不会选它。
   * 「加载得到但永远不触发」和「加载不到」对用户是同一件事，所以同级。
   */
  it('没有 description 同样算硬伤', async () => {
    const path = writeSkill('no-desc', '---\nname: no-desc\n---\n\n# 正文\n')
    const problems = await lintSkillFile(path, TOOLS)

    expect(problems.some((p) => p.severity === 'blocking' && /description/.test(p.message))).toBe(
      true
    )
  })
})

/**
 * 引用一个不存在的工具，模型会照着调、拿一句「工具不存在」卡住，
 * 而且它不知道问题出在 skill 上，只会换个名字反复试。
 */
describe('工具名核对', () => {
  /**
   * 拿 15 个真实 skill 跑过：单靠「前缀撞上真工具」抓出来的 6 个**全是误报** ——
   * `blueprint_path`、`material_slots` 是工具返回的字段名，`list_projects`、
   * `create_project` 是 `project_manage` 的动作名。字符串层面分不开它们和真工具名，
   * 所以这类只合并成一句、交给模型自己认领，不下判断。
   */
  it('像工具名但差得远的，合并成一条建议项交给模型判断', async () => {
    const path = writeSkill(
      'bad-tool',
      `${frontmatter('bad-tool')}先用 \`ue_get_actor\` 拿到 actor，它返回 \`material_slots\`，` +
        '再用 `ue_hide_actor` 藏起来。\n'
    )
    const problems = await lintSkillFile(path, TOOLS)

    expect(problems).toHaveLength(1)
    expect(problems[0]!.severity).toBe('warn')
    expect(problems[0]!.message).toContain('ue_hide_actor')
    expect(problems[0]!.message).toContain('material_slots')
    // 存在的那个不能被顺带报进来
    expect(problems[0]!.message).not.toContain('ue_get_actor')
  })

  /**
   * 误报比漏报更贵：报错一多，模型就学会忽略整份体检报告。
   * 参数名、属性名、资产名到处都是，它们的前缀对不上任何工具，必须放过。
   */
  it('参数名 / 属性名 / 资产名不误报', async () => {
    const path = writeSkill(
      'no-false-positive',
      `${frontmatter('no-false-positive')}传 \`slot_index\` 和 \`blend_mode\`，读 \`StaticMesh\`，` +
        '目标写 `targets.names`，材质叫 `MI_OakLeaves_LOD1`，相邻技能是 `ue-material-authoring`。\n'
    )
    const problems = await lintSkillFile(path, TOOLS)

    expect(problems).toEqual([])
  })

  /**
   * 差一两个字符的另说 —— 那几乎只可能是手滑，而不是字段名。
   * 这一档要点名说错在哪，模型才不用回头猜正确的名字叫什么。
   */
  it('拼错一两个字母，点名说该写哪个', async () => {
    const path = writeSkill(
      'typo-tool',
      `${frontmatter('typo-tool')}用 \`material_aply\` 应用材质。\n`
    )
    const problems = await lintSkillFile(path, TOOLS)

    expect(problems).toHaveLength(1)
    expect(problems[0]!.severity).toBe('blocking')
    expect(problems[0]!.message).toContain('material_aply')
    expect(problems[0]!.message).toContain('material_apply')
  })
})

describe('一般问题', () => {
  it('name 和目录名不一致只是建议修', async () => {
    const path = writeSkill('dir-name', `${frontmatter('other-name')}# 正文\n`)
    const problems = await lintSkillFile(path, TOOLS)

    const hit = problems.find((p) => p.message.includes('目录名'))
    expect(hit?.severity).toBe('warn')
  })

  it('引用了还不存在的 references 文件', async () => {
    const path = writeSkill(
      'missing-ref',
      `${frontmatter('missing-ref')}细节见 \`references/wiring.md\`。\n`
    )
    const problems = await lintSkillFile(path, TOOLS)

    const hit = problems.find((p) => p.message.includes('references/wiring.md'))
    // 分几次写完是正常顺序，写 SKILL.md 的当下引用还不存在不该报硬伤
    expect(hit?.severity).toBe('warn')
  })

  it('资源存在时不报', async () => {
    const path = writeSkill(
      'has-ref',
      `${frontmatter('has-ref')}细节见 \`references/wiring.md\`。\n`
    )
    mkdirSync(join(root, 'has-ref', 'references'), { recursive: true })
    writeFileSync(join(root, 'has-ref', 'references', 'wiring.md'), '内容', 'utf8')

    expect(await lintSkillFile(path, TOOLS)).toEqual([])
  })

  it('description 超过 1024 字符提醒会被截断', async () => {
    const path = writeSkill(
      'long-desc',
      `${frontmatter('long-desc', '描述。'.repeat(400))}# 正文\n`
    )
    const problems = await lintSkillFile(path, TOOLS)

    expect(problems.some((p) => p.severity === 'warn' && /1024/.test(p.message))).toBe(true)
  })
})

/**
 * 报告是给模型看的。没问题时也要说一句 —— 沉默有歧义，模型分不清
 * 「查过了没事」和「根本没查」。
 */
describe('formatSkillLint', () => {
  it('全过时明确说过了', () => {
    expect(formatSkillLint([])).toContain('没问题')
  })

  it('有硬伤时说清后果，并要求回头改', () => {
    const text = formatSkillLint([
      { severity: 'blocking', message: '正文引用了不存在的工具 `ue_hide_actor`。' },
      { severity: 'warn', message: 'name 和目录名不一致。' }
    ])

    expect(text).toContain('必须修')
    expect(text).toContain('建议修')
    expect(text).toContain('现在还不能用')
  })

  // 只有建议修的时候不该说「不能用」—— 那会把模型逼进一轮无谓的返工
  it('只有建议项时不说「不能用」', () => {
    const text = formatSkillLint([{ severity: 'warn', message: 'name 和目录名不一致。' }])

    expect(text).toContain('建议修')
    expect(text).not.toContain('现在还不能用')
  })
})
