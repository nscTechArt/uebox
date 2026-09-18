/**
 * 把项目级安装的 UnrealAgentLink 挡在版本库外面。
 *
 * 插件是装到用户项目的 `Plugins/UnrealAgentLink/` 下的（见
 * `sqliteDataBase/ipc/project.ts` 的 `ensureUnrealAgentLinkPlugin`），这是
 * 兼容性最好的位置 —— Launcher 引擎和自编译引擎都能用。代价是它落在用户
 * 的工作区里，不处理的话就会跟着 `git add .` 一起被提交，同事拉下来会问
 * 「这几 MB 的插件是谁加的」。
 *
 * 所以安装成功后顺手往忽略文件里加一行。规则刻意保守：
 * - `.gitignore` 已存在就追加；不存在但有 `.git/` 才新建 —— 不是 git 仓库
 *   的项目凭空多出一个 `.gitignore` 是噪音。
 * - `.p4ignore` 只在已存在时追加。它的位置由 `P4IGNORE` 环境变量决定，
 *   我们猜不准，新建大概率是建到没人读的地方。
 */
import * as path from 'path'
import * as fs from 'fs'

/** 写进忽略文件的那一行 */
export const PLUGIN_IGNORE_ENTRY = 'Plugins/UnrealAgentLink/'

/** 追加时一并写上的来源说明，免得用户不知道这行是谁加的 */
export const PLUGIN_IGNORE_COMMENT = '# 虚幻盒子自动安装的 UnrealAgentLink 插件，不需要进版本库'

/**
 * 判断某一行是否已经覆盖了插件目录。
 *
 * 认三种写法：`Plugins/UnrealAgentLink`、带前导 `/` 或尾部 `/` 的变体，
 * 以及把整个 `Plugins/` 都忽略掉的情况（那已经够了，不必再加）。
 */
function coversPluginDir(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) return false

  // 否定规则（`!Plugins/...`）是把它重新纳入版本库，不算覆盖
  if (trimmed.startsWith('!')) return false

  // 反斜杠先归一，否则 `Plugins\UnrealAgentLink\` 的尾部分隔符会漏掉
  const normalized = trimmed.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
  return normalized === 'Plugins/UnrealAgentLink' || normalized === 'Plugins'
}

/** 已有内容里是否已经忽略了插件目录 */
export function alreadyIgnoresPlugin(content: string): boolean {
  return content.split(/\r?\n/).some(coversPluginDir)
}

/**
 * 往一个已有内容后面接上忽略规则。
 *
 * 原内容不以换行结尾就先补一个，否则会和最后一行粘在一起变成
 * `Saved/Plugins/UnrealAgentLink/`。
 */
export function appendIgnoreEntry(content: string): string {
  const needsNewline = content.length > 0 && !content.endsWith('\n')
  const separator = content.length === 0 ? '' : needsNewline ? '\n\n' : '\n'
  return `${content}${separator}${PLUGIN_IGNORE_COMMENT}\n${PLUGIN_IGNORE_ENTRY}\n`
}

/** 单个忽略文件的处理结果 */
export type IgnoreOutcome = 'updated' | 'created' | 'already-ignored' | 'skipped' | 'failed'

export interface EnsurePluginIgnoredResult {
  gitignore: IgnoreOutcome
  p4ignore: IgnoreOutcome
}

/**
 * 处理单个忽略文件。
 * @param filePath 忽略文件路径
 * @param createIfMissing 文件不存在时是否新建
 */
async function ensureIgnoreFile(
  filePath: string,
  createIfMissing: boolean
): Promise<IgnoreOutcome> {
  try {
    let content: string
    try {
      content = await fs.promises.readFile(filePath, 'utf-8')
    } catch {
      if (!createIfMissing) return 'skipped'
      await fs.promises.writeFile(filePath, appendIgnoreEntry(''), 'utf-8')
      return 'created'
    }

    if (alreadyIgnoresPlugin(content)) return 'already-ignored'

    await fs.promises.writeFile(filePath, appendIgnoreEntry(content), 'utf-8')
    return 'updated'
  } catch (error) {
    // 忽略文件只读、目录没权限 —— 都不该让插件安装本身失败
    console.warn(`[UALink] 更新忽略文件失败: ${filePath}`, error)
    return 'failed'
  }
}

/**
 * 确保项目的忽略文件里挡住了 `Plugins/UnrealAgentLink/`。
 *
 * 任何一步失败都只记日志，不抛错 —— 这是安装成功之后的锦上添花，
 * 不该反过来把安装判成失败。
 *
 * @param projectDir 项目根目录（.uproject 所在目录）
 */
export async function ensurePluginIgnored(projectDir: string): Promise<EnsurePluginIgnoredResult> {
  const gitignorePath = path.join(projectDir, '.gitignore')
  const p4ignorePath = path.join(projectDir, '.p4ignore')

  // 不是 git 仓库就别凭空造 .gitignore
  const isGitRepo = await fs.promises
    .access(path.join(projectDir, '.git'))
    .then(() => true)
    .catch(() => false)

  return {
    gitignore: await ensureIgnoreFile(gitignorePath, isGitRepo),
    p4ignore: await ensureIgnoreFile(p4ignorePath, false)
  }
}
