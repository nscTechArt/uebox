#!/usr/bin/env node
/**
 * Skill 规范守卫 / Skill standard guard.
 *
 * 校验 resources/skills/ 下每个 skill 是否符合 resources/skills/SKILL_STANDARD.md。
 *
 * ## 为什么需要这道门禁
 *
 * skill 的失效方式和代码不一样：它不会报错，只会**悄悄不触发**，或者触发了但
 * Claude 只读到半个文件。这两种情况在开发机上都看不见 —— 用户那边表现为
 * 「这个功能好像时灵时不灵」。所以规则必须由脚本守，不能靠 review 记性。
 *
 * ## 规则来自哪里
 *
 * 硬限制（名字长度、字符集、description 上限）来自官方 Agent Skills 规范：
 *   https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices
 * 目录白名单来自我们自己的加载器 src/main/agent-v3/capabilities/skillsService/SkillsService.ts
 * —— 它只服务 references/ scripts/ assets/ 三个根目录，放别处的文件运行时读不到。
 *
 * 用法：
 *   node scripts/check-skills.mjs          校验
 *   node scripts/check-skills.mjs --list   只列出统计，不判定
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 默认扫全仓的 skill 根目录；SKILLS_DIR 只是为了能拿临时目录做负例自测。
 *
 * 两个根目录服务两批完全不同的读者：
 *   - `resources/skills`  —— 盒子自己的 agent 加载的，它手上直接有那些工具；
 *   - `packages/cli/skills` —— 随 uebox CLI 发出去的，教**外部** agent 怎么用命令行。
 *
 * 后者不能放进前者：盒子的 agent 已经能直接调工具，再教它去 shell 里敲 `uebox`
 * 是绕远路，还会占它的上下文。但规范是同一份 —— skill 坏掉的方式（悄悄不触发、
 * 只被读到一半）与它服务谁无关，所以两边一起守。
 */
const SKILL_ROOTS = process.env.SKILLS_DIR
  ? [process.env.SKILLS_DIR]
  : ['resources/skills', 'packages/cli/skills']

/** 加载器只会服务这三个根目录（SkillsService.ts 的 allowedRoots）。放别处运行时读不到。 */
const ALLOWED_SUBDIRS = new Set(['references', 'scripts', 'assets'])

/** 官方硬限制 */
const NAME_MAX = 64
const DESCRIPTION_MAX = 1024
/** 官方保留词：name 里不能出现 */
const RESERVED_WORDS = ['anthropic', 'claude']

/** 正文行数上限。超过就该按渐进式加载拆到 references/。 */
const BODY_MAX_LINES = 500
/** reference 文件超过这个行数就要加目录 —— Claude 半读（head -100）时才看得到全貌。 */
const TOC_REQUIRED_LINES = 100

/** description 必须说明「什么时候用」 */
const TRIGGER_MARKERS = [/\buse when\b/i, /当用户/, /使用时机/]
/** description 必须说明「什么时候不要用」 */
const BOUNDARY_MARKERS = [/\bdo not use\b/i, /\bnot for\b/i, /不适用于/, /不要用于/]
/** 官方要求第三人称，第一/第二人称会影响触发判断 */
const PERSON_MARKERS = [
  /^(i|we)\s/i,
  /\bi can help\b/i,
  /\byou can use this\b/i,
  /我可以帮/,
  /你可以用它/
]

const problems = []
const summary = []

function fail(skill, message) {
  problems.push(`${skill}: ${message}`)
}

function listDir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function countLines(text) {
  return text.split('\n').length
}

/** 收集一个目录下所有文件的相对路径（相对 skill 根） */
function walkFiles(dir, prefix, out) {
  for (const entry of listDir(dir)) {
    const full = join(dir, entry.name)
    const rel = `${prefix}/${entry.name}`
    if (entry.isDirectory()) walkFiles(full, rel, out)
    else out.push(rel)
  }
}

function parseFrontmatter(raw, skill) {
  // 官方规则：`---` 必须是文件第一行，否则整个文件都会被当成正文
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  if (!match || match.index !== 0) {
    fail(skill, 'SKILL.md 开头没有 frontmatter（`---` 必须是第一行，前面不能有空行或 BOM）')
    return null
  }
  const yaml = match[1]
  const name = /^name:\s*(.+)$/m.exec(yaml)?.[1]?.trim()
  const description = /^description:\s*(.+)$/m.exec(yaml)?.[1]?.trim()
  return { name, description, body: raw.slice(match[0].length) }
}

function checkName(skill, name) {
  if (!name) return fail(skill, 'frontmatter 缺 `name`')
  if (name !== skill)
    fail(skill, `\`name: ${name}\` 与目录名不一致（加载器按 name 查找，改名要一起改）`)
  if (name.length > NAME_MAX) fail(skill, `name 超过 ${NAME_MAX} 字符（现在 ${name.length}）`)
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name))
    fail(skill, `name 只能用小写字母、数字和连字符：\`${name}\``)
  for (const word of RESERVED_WORDS) {
    if (name.includes(word)) fail(skill, `name 不能包含保留词 "${word}"`)
  }
}

function checkDescription(skill, description) {
  if (!description) return fail(skill, 'frontmatter 缺 `description`（它决定 skill 会不会被触发）')
  if (description.length > DESCRIPTION_MAX) {
    fail(skill, `description 超过 ${DESCRIPTION_MAX} 字符（现在 ${description.length}）`)
  }
  if (/[<>]/.test(description)) fail(skill, 'description 不能包含尖括号（会被当成 XML 标签转义）')
  if (!TRIGGER_MARKERS.some((re) => re.test(description))) {
    fail(skill, 'description 没写触发条件（"Use when …" 或「当用户…」）')
  }
  if (!BOUNDARY_MARKERS.some((re) => re.test(description))) {
    fail(skill, 'description 没写负向边界（"Do not use for …" 或「不适用于…」）')
  }
  if (PERSON_MARKERS.some((re) => re.test(description))) {
    fail(skill, 'description 必须用第三人称（不要写「我可以帮你…」「你可以用它…」）')
  }
}

/** 正文里出现的 markdown 链接目标 */
function extractLinks(text) {
  return [...text.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1])
}

/** 正文里以裸路径提到的资源文件，例如 `references/wiring.md` */
function extractMentions(text) {
  return [...text.matchAll(/(?:references|scripts|assets)\/[A-Za-z0-9._-]+/g)].map((m) => m[0])
}

function checkSkill(dir, skill) {
  const skillFile = join(dir, 'SKILL.md')
  let buffer
  try {
    buffer = readFileSync(skillFile)
  } catch {
    return fail(skill, '缺少 SKILL.md')
  }

  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    fail(skill, 'SKILL.md 带 UTF-8 BOM，frontmatter 会解析失败（另存为无 BOM 的 UTF-8）')
  }

  const raw = buffer.toString('utf8').replace(/^\uFEFF/, '')
  const parsed = parseFrontmatter(raw, skill)
  if (!parsed) return

  checkName(skill, parsed.name)
  checkDescription(skill, parsed.description)

  const bodyLines = countLines(parsed.body)
  if (bodyLines > BODY_MAX_LINES) {
    fail(skill, `正文 ${bodyLines} 行，超过 ${BODY_MAX_LINES} 行上限 —— 按主题拆到 references/`)
  }

  // 目录白名单：加载器读不到的目录只是死重量
  const extraDirs = listDir(dir)
    .filter((e) => e.isDirectory() && !ALLOWED_SUBDIRS.has(e.name))
    .map((e) => e.name)
  for (const name of extraDirs) {
    fail(
      skill,
      `目录 ${name}/ 不在加载器白名单里（只支持 references/ scripts/ assets/），运行时读不到`
    )
  }

  // 收集实际存在的资源文件
  const resources = []
  for (const sub of ALLOWED_SUBDIRS) {
    const subDir = join(dir, sub)
    try {
      if (statSync(subDir).isDirectory()) walkFiles(subDir, sub, resources)
    } catch {
      /* 没有这个目录，正常 */
    }
  }

  const referenced = new Set([...extractLinks(parsed.body), ...extractMentions(parsed.body)])

  // 1. 正文引用的资源必须真的存在
  for (const link of referenced) {
    if (!/^(references|scripts|assets)\//.test(link)) continue
    if (!resources.includes(link)) fail(skill, `SKILL.md 引用了不存在的文件：${link}`)
  }

  // 2. 存在的资源必须被正文引用，否则 Claude 永远不会读到它
  for (const resource of resources) {
    if (!referenced.has(resource)) {
      fail(skill, `${resource} 没有被 SKILL.md 提到 —— Claude 不会去读它`)
    }
  }

  // 3. 反斜杠路径在非 Windows 上直接失效
  if (/(references|scripts|assets)\\[A-Za-z0-9._-]/.test(parsed.body)) {
    fail(skill, 'skill 内部文件引用要用正斜杠（`references/a.md`），反斜杠在非 Windows 上失效')
  }

  // 4. reference 之间不能再套一层：嵌套引用会被 Claude 半读，信息不全
  for (const resource of resources) {
    if (!resource.endsWith('.md')) continue
    const text = readFileSync(join(dir, resource), 'utf8')
    for (const link of extractLinks(text)) {
      if (/^(https?:|#)/.test(link)) continue
      if (link.endsWith('.md')) {
        fail(skill, `${resource} 又链到了 ${link} —— 引用只能一层深，全部从 SKILL.md 直接链`)
      }
    }
    const lines = countLines(text)
    if (lines > TOC_REQUIRED_LINES) {
      const head = text.split('\n').slice(0, 20).join('\n')
      if (!/^##\s*(目录|Contents)\s*$/im.test(head)) {
        fail(
          skill,
          `${resource} 有 ${lines} 行，超过 ${TOC_REQUIRED_LINES} 行就要在开头加「## 目录」——` +
            ' Claude 可能只读前 100 行，没有目录就看不到后面有什么'
        )
      }
    }
  }

  summary.push(
    `  ${skill.padEnd(28)} 正文 ${String(bodyLines).padStart(3)} 行 · description ${String(
      parsed.description?.length ?? 0
    ).padStart(4)} 字符 · 资源 ${resources.length} 个`
  )
}

function main() {
  let total = 0

  for (const root of SKILL_ROOTS) {
    const entries = listDir(root).filter((e) => e.isDirectory())

    // 第一个根目录（盒子自己的 skill）空了一定是出事了；后面的可以为空 ——
    // 显式给了 SKILLS_DIR 做负例自测时也走这条判断
    if (entries.length === 0) {
      if (root === SKILL_ROOTS[0]) {
        console.error(`✖ check-skills 失败：${root} 下没有找到任何 skill 目录。`)
        process.exit(1)
      }
      continue
    }

    total += entries.length

    for (const entry of entries) {
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(entry.name)) {
        fail(entry.name, '目录名必须是 kebab-case（小写字母、数字、连字符）')
      }
      checkSkill(join(root, entry.name), entry.name)
    }

    if (process.argv.includes('--list')) {
      console.log(`\n${root}（${entries.length} 个 skill）\n`)
      console.log(summary.splice(0).join('\n'))
      console.log()
    }
  }

  if (problems.length === 0) {
    console.log(`✓ verify:skills — ${total} 个 skill 符合 SKILL_STANDARD.md。`)
    process.exit(0)
  }

  console.error('✖ verify:skills 失败：\n')
  for (const problem of problems) console.error(`  · ${problem}`)
  console.error('\n规范全文：resources/skills/SKILL_STANDARD.md')
  console.error(
    'skill 出问题不会报错，只会悄悄不触发或只被读到一半 —— 所以这些规则由脚本守，不靠 review。'
  )
  process.exit(1)
}

main()
