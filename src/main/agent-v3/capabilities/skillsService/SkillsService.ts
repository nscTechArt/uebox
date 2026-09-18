import { readdir, readFile } from 'fs/promises'
import { extname, join, resolve, sep } from 'path'

export type SkillSource = 'user' | 'plugin' | 'builtin'

export interface SkillMetadata {
  name: string
  description: string
  path: string
  source?: SkillSource
}

export interface LoadedSkill {
  name: string
  skillDirectory: string
  content: string
  source?: SkillSource
}

const LEGACY_SKILL_ALIASES: Record<string, string> = {
  'ue5-auto-assistant': 'ua-nav-feature-surface-guidance',
  'ua-unreal-compat-routing': 'ua-nav-feature-surface-guidance',
  'ue5-module-router': 'ua-unreal-module-routing',
  'ue5-blueprint-workflow': 'ue-blueprint-graph-wiring',
  'ue-blueprint-compat-workflow': 'ue-blueprint-graph-wiring',
  'ue5-architecture': 'ue-architecture-planning',
  'ue5-cpp-gameplay': 'ue-cpp-gameplay',
  'ue5-debug-validation': 'ue-qa-troubleshooting',
  'ue-debug-validation': 'ue-qa-troubleshooting',
  'ue5-pcg-building': 'ue-pcg-building',
  'ue5-performance-packaging': 'ue-performance-packaging',
  'ue5-save-load-replication': 'ue-save-load-replication',
  'ue5-ui-umg-slate': 'ue-widget-umg-layout',
  'ue-ui-umg-slate': 'ue-widget-umg-layout',
  'ue5-world-interaction': 'ue-world-interaction'
}

const READABLE_RESOURCE_EXTENSIONS = new Set([
  '.md',
  '.txt',
  '.csv',
  '.yaml',
  '.yml',
  '.json',
  '.py',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.sh',
  '.ps1',
  '.toml',
  '.ini',
  '.cfg',
  '.html',
  '.css',
  '.xml'
])

function parseFrontmatter(content: string): { name: string; description: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match?.[1]) throw new Error('No frontmatter found')

  const yaml = match[1]
  const nameMatch = yaml.match(/^name:\s*(.+)$/m)
  const descMatch = yaml.match(/^description:\s*(.+)$/m)

  if (!nameMatch?.[1]) throw new Error('Missing "name" in frontmatter')

  return {
    name: nameMatch[1].trim(),
    description: descMatch?.[1]?.trim() || ''
  }
}

function stripFrontmatter(content: string): string {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)
  return match ? content.slice(match[0].length).trim() : content.trim()
}

function resolveSkillName(name: string): string {
  return LEGACY_SKILL_ALIASES[name.toLowerCase()] || name
}

export async function discoverSkills(
  directories: string[],
  directorySources?: Array<SkillSource | undefined>
): Promise<SkillMetadata[]> {
  const skills: SkillMetadata[] = []
  const seenNames = new Set<string>()

  for (const [dirIndex, dir] of directories.entries()) {
    const inferredSource =
      directorySources?.[dirIndex] ??
      (directories.length >= 2 ? (dirIndex === 0 ? 'user' : 'builtin') : 'builtin')
    let entries: { name: string; isDirectory(): boolean }[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      console.log(`[Skills] Skip missing directory: ${dir}`)
      continue
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const skillDir = join(dir, entry.name)
      const skillFile = join(skillDir, 'SKILL.md')

      try {
        const content = await readFile(skillFile, 'utf-8')
        const frontmatter = parseFrontmatter(content)

        if (seenNames.has(frontmatter.name)) continue
        seenNames.add(frontmatter.name)

        skills.push({
          name: frontmatter.name,
          description: frontmatter.description,
          path: skillDir,
          source: inferredSource
        })
      } catch {
        continue
      }
    }
  }

  console.log(
    `[Skills] Discovered ${skills.length} skills:`,
    skills.map((s) => s.name)
  )
  return skills
}

export function buildSkillsPrompt(skills: SkillMetadata[]): string {
  if (skills.length === 0) return ''

  const skillsList = skills.map((s) => `- ${s.name}: ${s.description}`).join('\n')

  return `

## Skills

当用户的请求涉及以下技能领域时，使用 \`loadSkill\` 加载对应的专业指令；如果该技能正文引用了 \`references/\`、\`scripts/\` 或 \`assets/\` 中的具体文件，再使用 \`readSkillResource\` 读取这些子资源。
${skillsList}
`
}

export async function loadSkill(
  skills: SkillMetadata[],
  name: string
): Promise<LoadedSkill | null> {
  const resolvedName = resolveSkillName(name)
  const skill = skills.find((s) => s.name.toLowerCase() === resolvedName.toLowerCase())
  if (!skill) {
    console.warn(`[Skills] Skill not found: ${name}`)
    return null
  }

  try {
    const skillFile = join(skill.path, 'SKILL.md')
    const content = await readFile(skillFile, 'utf-8')
    const body = stripFrontmatter(content)

    console.log(`[Skills] Loaded skill: ${skill.name} (${body.length} chars)`)
    return {
      name: skill.name,
      skillDirectory: skill.path,
      content: body,
      source: skill.source
    }
  } catch (error) {
    console.error(`[Skills] Failed to load skill: ${name}`, error)
    return null
  }
}

async function collectBundledResources(skillDir: string): Promise<string[]> {
  const results: string[] = []
  const allowedRoots = ['references', 'scripts', 'assets']

  async function walk(currentDir: string, prefix: string): Promise<void> {
    let entries: { name: string; isDirectory(): boolean; isFile(): boolean }[]
    try {
      entries = await readdir(currentDir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const relativePath = `${prefix}/${entry.name}`
      const fullPath = join(currentDir, entry.name)
      if (entry.isDirectory()) {
        await walk(fullPath, relativePath)
      } else if (entry.isFile()) {
        results.push(relativePath.replace(/\\/g, '/'))
      }
    }
  }

  for (const root of allowedRoots) {
    await walk(join(skillDir, root), root)
  }

  return results.sort()
}

function isPathInside(baseDir: string, candidatePath: string): boolean {
  const normalizedBase = baseDir.endsWith(sep) ? baseDir : `${baseDir}${sep}`
  return candidatePath === baseDir || candidatePath.startsWith(normalizedBase)
}

export async function readSkillResource(
  skills: SkillMetadata[],
  name: string,
  relativePath: string
): Promise<
  | {
      skillDirectory: string
      relativePath: string
      content: string
    }
  | {
      error: string
      availableResources?: string[]
    }
> {
  const resolvedName = resolveSkillName(name)
  const skill = skills.find((s) => s.name.toLowerCase() === resolvedName.toLowerCase())
  if (!skill) {
    return {
      error: `Skill '${name}' not found`,
      availableResources: skills.map((s) => s.name)
    }
  }

  const sanitizedRelativePath = relativePath.replace(/\\/g, '/').replace(/^\.?\//, '')
  if (
    !(
      sanitizedRelativePath.startsWith('references/') ||
      sanitizedRelativePath.startsWith('scripts/') ||
      sanitizedRelativePath.startsWith('assets/')
    )
  ) {
    return {
      error: 'Only files under references/, scripts/, or assets/ can be read.',
      availableResources: await collectBundledResources(skill.path)
    }
  }

  const resolvedSkillDir = resolve(skill.path)
  const absolutePath = resolve(skill.path, sanitizedRelativePath)
  if (!isPathInside(resolvedSkillDir, absolutePath)) {
    return {
      error: 'Resource path escapes the skill directory.',
      availableResources: await collectBundledResources(skill.path)
    }
  }

  if (!READABLE_RESOURCE_EXTENSIONS.has(extname(absolutePath).toLowerCase())) {
    return {
      error: `Unsupported resource type '${extname(absolutePath)}' for in-context reading.`,
      availableResources: await collectBundledResources(skill.path)
    }
  }

  try {
    const content = await readFile(absolutePath, 'utf-8')
    return {
      skillDirectory: skill.path,
      relativePath: sanitizedRelativePath,
      content
    }
  } catch {
    return {
      error: `Resource '${sanitizedRelativePath}' not found in skill '${skill.name}'.`,
      availableResources: await collectBundledResources(skill.path)
    }
  }
}
