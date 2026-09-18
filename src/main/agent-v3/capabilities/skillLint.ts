/**
 * 写完一个 SKILL.md 之后的机器体检。
 *
 * ## 为什么要有
 *
 * skill 是 agent 自己写、自己下次照着执行的东西，中间没有人过目。而它写坏的
 * 方式里有两类是**纯机械**的：
 *
 *   1. 结构坏了 —— frontmatter 缺失、带 BOM、`name` 和目录名对不上。
 *      后果不是「效果差一点」，是 `discoverSkills` 直接跳过它：文件躺在盘上，
 *      清单里没有，用户以为沉淀成功了，其实什么都没发生。
 *   2. 引用了不存在的工具 —— 正文里写 `ue_hide_actor`，而根本没这个工具。
 *      模型会照着调，拿一句「工具不存在」卡住，而且它不知道问题出在 skill 上，
 *      只会换个名字反复试。
 *
 * 这两类 100% 可机检，代价接近零。剩下的（少说一步、说反了）机器查不了，
 * 那是真机跑一次才能发现的事，不在这里假装能管。
 *
 * ## 为什么写完才查，而不是拦住不让写
 *
 * 一个 skill 常常分几次写完 —— 先 SKILL.md，再 `references/` 下的文件。
 * 写的当下引用还不存在是**正常顺序**，拦住就死锁了。而且写坏的文件本身无害：
 * `discoverSkills` 解析失败就跳过，不会把别的 skill 一起带坏。
 *
 * 所以这里只做一件事：把后果讲清楚，讲给正在写的那个模型听。它看到
 * 「这个 skill 现在不会被加载」，比看到「校验失败」有用得多。
 */

import { readFile, stat } from 'fs/promises'
import { basename, dirname, join } from 'path'

export interface SkillProblem {
  /**
   * blocking = 这个 skill 现在用不了（加载不到，或者永远不会被选中）；
   * warn = 能用，但下次照着走会踩坑。
   *
   * 分级不是为了排版，是为了让模型知道哪些必须现在就回头改。
   */
  severity: 'blocking' | 'warn'
  message: string
}

/** 只对 SKILL.md 生效。写在哪个目录都查 —— 仓库里的内置 skill 同样适用 */
export function isSkillFile(path: string): boolean {
  return basename(path.replace(/\\/g, '/')).toLowerCase() === 'skill.md'
}

/** frontmatter 里的 name，取不到返回 undefined */
function frontmatterField(yaml: string, field: string): string | undefined {
  const match = yaml.match(new RegExp(`^${field}:\\s*(.+)$`, 'm'))
  return match?.[1]?.trim()
}

/** 编辑距离。只拿来判「是不是把某个真工具名拼错了」，串都很短 */
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j]! + 1,
        row[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)
      )
    }
    prev = row
  }
  return prev[b.length]!
}

/**
 * 正文里看着像工具名、但注册表里没有的 token。
 *
 * ## 为什么分成「拼错了」和「说不好」两档
 *
 * 拿真实的 15 个内置 skill 跑过一遍：单靠「前缀撞上某个真工具」这一条判据，
 * 抓出来的 6 个全是误报 —— `blueprint_path` 和 `material_slots` 是**工具返回的
 * 字段名**，`list_projects` / `create_project` 是 `project_manage` 的**动作名**。
 * 它们和真工具名长得一模一样，因为本来就是同一套命名。
 *
 * 光看字符串分不开这三者，但**模型分得开** —— 它知道自己写那句话时指的是
 * 字段还是调用。所以这里不下判断，只把事实摆出来：
 *
 *   - 和某个真工具名只差一两个字符 → 几乎只可能是拼错，直接点名说错在哪；
 *   - 其余 → 合并成一句「如果这些是工具名，它们不存在」，交给模型自己认领。
 *
 * 误报要按「训练模型忽略整份报告」来计价，所以宁可把判断权交出去。
 */
function suspectToolNames(
  body: string,
  known: Set<string>
): { typos: Array<{ wrote: string; meant: string }>; unknown: string[] } {
  const prefixes = new Set<string>()
  for (const name of known) {
    const head = name.split('_')[0]
    if (head) prefixes.add(head)
  }

  const typos: Array<{ wrote: string; meant: string }> = []
  const unknown = new Set<string>()
  const seen = new Set<string>()

  for (const match of body.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)) {
    const token = match[1]!
    if (known.has(token) || seen.has(token)) continue
    seen.add(token)
    if (!prefixes.has(token.split('_')[0]!)) continue

    let best: { name: string; distance: number } | undefined
    for (const name of known) {
      const distance = editDistance(token, name)
      if (!best || distance < best.distance) best = { name, distance }
    }

    // 阈值 2：`material_aply`→`material_apply` 是 1，`ue_hide_actor`→`ue_get_actor`
    // 是 4。差到 4 就不是手滑了，可能是工具下线也可能根本是个字段名 —— 交给模型
    if (best && best.distance <= 2) typos.push({ wrote: token, meant: best.name })
    else unknown.add(token)
  }

  return { typos, unknown: [...unknown] }
}

/** 正文里引用的附带资源路径 */
function referencedResources(body: string): string[] {
  const found = new Set<string>()
  for (const match of body.matchAll(/(references|scripts|assets)\/[A-Za-z0-9._/-]+/g)) {
    found.add(match[0].replace(/[.,;:)]+$/, ''))
  }
  return [...found]
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * 体检一个 SKILL.md。
 *
 * `knownToolNames` 由调用方传进来而不是这里去问注册表 —— 注册表要 import
 * 本地文件工具，本地文件工具又要 import 这个模块，直接引会成环。
 */
export async function lintSkillFile(
  path: string,
  knownToolNames: Set<string>
): Promise<SkillProblem[]> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return [{ severity: 'blocking', message: `读不回来：${path}` }]
  }

  const problems: SkillProblem[] = []

  // BOM 会让 frontmatter 的 `^---` 匹配不上，整个 skill 直接消失。
  // 这是最隐蔽的一种坏法 —— 文件用编辑器打开一切正常
  if (raw.charCodeAt(0) === 0xfeff) {
    problems.push({
      severity: 'blocking',
      message: '文件以 BOM 开头，frontmatter 解析不了，这个 skill 不会被加载。存成 UTF-8 无 BOM。'
    })
  }

  // BOM 写成转义而不是字面量：字面量在编辑器里是不可见字符，
  // 下一个人改这行时会毫无察觉地把它删掉，于是带 BOM 的 skill 从此报两条错
  const frontmatter = raw.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/)
  if (!frontmatter) {
    problems.push({
      severity: 'blocking',
      message: '开头没有 `---` 包起来的 frontmatter，这个 skill 不会被加载。'
    })
    return problems
  }

  const yaml = frontmatter[1]!
  const body = raw.slice(frontmatter[0].length).trim()

  const name = frontmatterField(yaml, 'name')
  const dir = basename(dirname(path))

  if (!name) {
    problems.push({
      severity: 'blocking',
      message: 'frontmatter 里没有 `name`，这个 skill 不会被加载。'
    })
  } else {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
      problems.push({
        severity: 'warn',
        message: `name "${name}" 不是小写 kebab-case。`
      })
    }
    if (name !== dir) {
      problems.push({
        severity: 'warn',
        message: `name "${name}" 和目录名 "${dir}" 不一致。能加载，但用户按目录找不到它。`
      })
    }
  }

  const description = frontmatterField(yaml, 'description')
  if (!description) {
    // 能加载，但清单里没有判据 —— 模型永远不会选它，等于白写
    problems.push({
      severity: 'blocking',
      message:
        'frontmatter 里没有 `description`。skill 会被加载，但模型没有判据去选它，等于永远不触发。'
    })
  } else if (description.length > 1024) {
    problems.push({
      severity: 'warn',
      message: `description ${description.length} 字符，超过 1024 会被截断，末尾的负向边界可能丢掉。`
    })
  }

  if (!body) {
    problems.push({ severity: 'blocking', message: 'frontmatter 之后没有正文。' })
  }

  const suspects = suspectToolNames(body, knownToolNames)
  for (const { wrote, meant } of suspects.typos) {
    problems.push({
      severity: 'blocking',
      message: `\`${wrote}\` 不存在，看着是 \`${meant}\` 拼错了。下次照着这条 skill 走会卡在这里。`
    })
  }
  if (suspects.unknown.length > 0) {
    problems.push({
      severity: 'warn',
      message:
        `这些 token 长得像工具名，但注册表里没有：${suspects.unknown.map((t) => `\`${t}\``).join('、')}。` +
        '如果它们其实是工具返回的字段名或动作名，忽略这条；如果是要调用的工具，那它们不存在。'
    })
  }

  const skillDir = dirname(path)
  for (const resource of referencedResources(body)) {
    if (!(await exists(join(skillDir, resource)))) {
      problems.push({
        severity: 'warn',
        message: `正文引用了 \`${resource}\`，但这个文件还不存在。`
      })
    }
  }

  return problems
}

/**
 * 把体检结果写成给模型看的一段话。没问题时也要说一句 —— 沉默是有歧义的，
 * 模型分不清「查过了没事」和「根本没查」。
 */
export function formatSkillLint(problems: SkillProblem[]): string {
  if (problems.length === 0) return '\n\n[skill 体检] 结构、工具名、资源引用都没问题。'

  const blocking = problems.filter((p) => p.severity === 'blocking')
  const warn = problems.filter((p) => p.severity === 'warn')

  const lines = ['', '', `[skill 体检] ${problems.length} 处问题：`]
  for (const p of blocking) lines.push(`- 必须修：${p.message}`)
  for (const p of warn) lines.push(`- 建议修：${p.message}`)
  if (blocking.length > 0) {
    lines.push('这个 skill 现在还不能用。回头把上面「必须修」的改掉，再告诉用户写好了。')
  }

  return lines.join('\n')
}
