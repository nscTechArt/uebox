/**
 * 本地文件查找与内容搜索。
 *
 * ## 为什么不用现成的
 *
 * pi 的 `@earendil-works/pi-coding-agent` 里有做好的 grep / find / ls，实测都能用。
 * 但那个包 **120MB**，依赖里带 `pi-tui`（终端界面框架）、`photon-node`（原生
 * 图像库）、`grok-mermaid`、`highlight.js` —— 全是给命令行界面用的，我们是
 * Electron 桌面应用一个都用不上。而且它的 `exports` 只开了三个入口，
 * **没法只深引用 tools 子模块**，要 grep 就得整包拉进来。
 * 往安装包里塞一个原生模块换两个文件工具，不划算。
 *
 * 底层其实就是 glob + 正则。用 `tinyglobby`（39KB，两个依赖）自己写，
 * 比整包依赖轻三个数量级。
 *
 * ## 为什么必须自己定排除规则
 *
 * 通用 glob 工具不认识虚幻工程的目录约定。`DerivedDataCache/`、
 * `Intermediate/`、`Binaries/`、`Saved/` 装的全是引擎生成物 ——
 * 编译中间产物、着色器缓存、历年日志和自动保存。用户搜的从来不是它们。
 *
 * 体量差别很大：这台机器上的测试工程（几乎是空的）`Intermediate/` 就有
 * 2.4GB / 138 个文件，文件数从 413 降到 98；真实生产工程里这几个目录
 * 是几十 GB 起步的量级，而且随构建次数不断长。
 */

import { readFile, stat } from 'fs/promises'
import * as path from 'path'
import { glob } from 'tinyglobby'
import { z } from 'zod'

import { defineTool, type UnrealAgentTool } from '../defineTool'
import { assertInAccessScope } from './accessScope'
import { assertPathAllowed } from './pathBoundary'

/**
 * 一律跳过的目录。
 *
 * 前四个是虚幻工程的生成物（缓存、中间产物、编译输出、日志与自动保存），
 * 后面是通用的版本控制与包管理目录。这些目录的共同点：内容是机器生成的，
 * 用户搜的从来不是它们，但体量能大到把整次搜索拖垮。
 */
const ALWAYS_IGNORE = [
  '**/DerivedDataCache/**',
  '**/Intermediate/**',
  '**/Binaries/**',
  '**/Saved/**',
  '**/.git/**',
  '**/node_modules/**'
]

/** 找文件一次最多返回多少条 */
const MAX_FILES = 200
/** 搜内容一次最多返回多少行命中 */
const MAX_MATCHES = 100
/** 单个文件超过这个大小就不搜内容 —— 多半是二进制或日志，搜了也没意义 */
const MAX_SEARCHABLE_BYTES = 2_000_000
/** 命中行超长时截断，避免一行压缩过的 JSON 就占满上下文 */
const MAX_LINE_CHARS = 300

const findInput = z.object({
  path: z.string().describe('起始目录的绝对路径，如 "I:/MyProject" 或 "D:/素材"'),
  pattern: z
    .string()
    .describe('glob 模式，相对起始目录。如 "**/*.fbx"、"**/SKILL.md"、"Content/**/*.uasset"'),
  limit: z.number().optional().describe(`最多返回几条，默认 ${MAX_FILES}`)
})

const grepInput = z.object({
  path: z.string().describe('搜索起始目录的绝对路径'),
  pattern: z.string().describe('要搜的正则表达式（JavaScript 语法），如 "TODO|FIXME"'),
  glob: z
    .string()
    .optional()
    .describe('可选，只在匹配这个 glob 的文件里搜，如 "**/*.ini"。不给则搜所有文本文件'),
  ignoreCase: z.boolean().optional().describe('可选，忽略大小写，默认 false'),
  limit: z.number().optional().describe(`最多返回几条命中，默认 ${MAX_MATCHES}`)
})

/**
 * 盘符根目录（`C:\`、`D:\`、POSIX 的 `/`）。
 *
 * 从这里起扫是个陷阱：`**` 会走遍整块盘，几十万个文件、几分钟起步，
 * 而且**这几分钟里用户按停止是没用的**——工具还在 fs 里转，模型收不到中断。
 * 真机上模型为了找一个 `.uproject` 连着扫了 `C:/`、`C:/Users`、`D:/`，
 * 用户只能干看着。与其扫完再说，不如当场拒绝，让它去问路径。
 */
function isFilesystemRoot(target: string): boolean {
  const resolved = path.resolve(target)
  return path.parse(resolved).root === resolved
}

/** 把 tinyglobby 的结果规整成绝对路径 */
async function globFiles(
  root: string,
  pattern: string,
  limit: number,
  signal?: AbortSignal
): Promise<string[]> {
  const hits = await glob(pattern, {
    cwd: root,
    ignore: ALWAYS_IGNORE,
    onlyFiles: true,
    dot: false,
    // 跟随符号链接会在某些工程布局里绕回自身，扫到天荒地老
    followSymbolicLinks: false,
    absolute: true,
    // 用户按下停止时，扫描要真的停下来 —— 不接这个信号的话，
    // `agent.abort()` 只能让模型停在下一步，当前这次遍历照样跑到底
    ...(signal ? { signal } : {})
  })
  return hits.slice(0, limit + 1)
}

/** 拒绝整盘扫描时给模型的话。说清楚该怎么办，否则它会换个盘再来一次 */
function rootScanRefusal(target: string): string {
  return (
    `拒绝从 ${target} 开始搜索：这是整块盘的根目录，遍历它要几分钟，期间用户按停止也停不下来。\n` +
    '换个具体的起始目录再试。不知道目标在哪时，别靠扫盘去猜 —— ' +
    '先看已知工程所在的目录（同级目录里往往就有），或者直接问用户要路径。'
  )
}

function createFindTool(): UnrealAgentTool<never> {
  return defineTool({
    name: 'find_local_files',
    namespace: 'local',
    risk: 'safe',
    description:
      '按文件名模式在用户电脑上找文件（glob）。\n\n' +
      '【什么时候用】「D:/素材 底下所有 fbx 在哪」「这个工程里有哪些 ini 配置」——' +
      '需要跨多层目录找文件时用这个，不要用 list_local_dir 一层层翻。\n' +
      '【已自动跳过】DerivedDataCache、Intermediate、Binaries、Saved、.git、node_modules。' +
      '这些目录装的全是引擎生成物（编译产物、着色器缓存、日志），搜进去只有噪音。\n' +
      '【模式示例】"**/*.fbx"、"Content/**/*.uasset"、"**/Default*.ini"\n' +
      '【找素材不要用这个】用户导入保管库的素材，落盘是 `assetData/<时间戳>/` 这样的目录，' +
      '文件名早就不是原来那个了 —— 按名字去 glob 一定搜不到，而库里明明有。' +
      '按名字/标签/文件夹找素材一律用 search_assets（查的是数据库，还能跨库）。\n' +
      '【别整盘扫】起始目录不能是盘符根（C:/、D:/）。不知道目标在哪就问用户要路径，' +
      '或者从已知工程所在的目录找起 —— 扫一块盘要几分钟，中途还停不下来。',
    input: findInput,
    execute: async (args, ctx) => {
      const limit = Math.max(1, Math.min(args.limit ?? MAX_FILES, MAX_FILES))

      // 敏感位置这两个工具原先完全不管，于是 read_local_file 挡着的 ~/.ssh，
      // 换成「从 ~/.ssh 起找 *」照样能把文件名全列出来
      const denied = assertPathAllowed(args.path)
      if (denied) return { text: denied, isError: true }

      // 整盘扫描排在访问范围之前。盘符根在任何一档下都不该扫 ——
      // 让访问范围先说话的话，模型会得到「改成整台电脑就行」这句**错的**指引，
      // 而那一档下从 C:/ 起扫照样要几分钟、照样停不下来
      if (isFilesystemRoot(args.path)) {
        return { text: rootScanRefusal(args.path), isError: true }
      }

      const outOfScope = await assertInAccessScope(args.path)
      if (outOfScope) return { text: outOfScope, isError: true }

      try {
        const hits = await globFiles(args.path, args.pattern, limit, ctx.signal)
        if (hits.length === 0) {
          return {
            text:
              `在 ${args.path} 下没有匹配 "${args.pattern}" 的文件。\n` +
              '如果确定文件存在，检查一下模式：跨目录要用 ** 开头（如 "**/*.fbx"），' +
              '而且这几个目录是跳过的：DerivedDataCache、Intermediate、Binaries、Saved。'
          }
        }

        const truncated = hits.length > limit
        const shown = hits.slice(0, limit)
        const header = truncated
          ? `找到超过 ${limit} 个，显示前 ${limit} 个：`
          : `找到 ${shown.length} 个：`

        /**
         * 模式里没有 `**` 时提醒一句。
         *
         * `*Foo*` 只匹配起始目录那一层，子目录里的同名文件根本不在结果里。
         * 零命中时下面那段话会说，**有命中时原来什么都不说** —— 于是
         * 「找到了 1 个」被当成「一共就这 1 个」。真机上就这么误判过：
         * 根目录下匹配到一个文件，两层深的那个真正的目标压根没出现。
         */
        const shallow = !args.pattern.includes('**')
        const hint = shallow
          ? '\n（模式里没有 ** —— 只匹配了模式本身写明的那几层目录，' +
            '更深处的同名文件不会出现在结果里。' +
            `要递归到任意深度就写 "**/${args.pattern}"。）`
          : ''

        return {
          text: `${header}\n${shown.join('\n')}${hint}`,
          details: {
            root: args.path,
            pattern: args.pattern,
            count: shown.length,
            truncated,
            recursive: !shallow
          }
        }
      } catch (error) {
        // 中断信号会让遍历以 AbortError 抛出来。那是用户按了停止，
        // 报成「查找失败」会在界面上留下一条红色的假故障
        if (ctx.signal?.aborted) return { text: '查找已取消' }
        return { text: `查找失败：${(error as Error).message}`, isError: true }
      }
    }
  }) as unknown as UnrealAgentTool<never>
}

interface Match {
  file: string
  line: number
  text: string
}

/** 在单个文件里找命中行。读不了（二进制/无权限/太大）就跳过，不中断整次搜索 */
async function grepFile(file: string, regex: RegExp, remaining: number): Promise<Match[]> {
  try {
    // 先看大小再决定读不读。日志和数据转储动辄几百 MB，
    // 整个读进内存去跑正则，搜索会直接卡死
    const info = await stat(file)
    if (info.size > MAX_SEARCHABLE_BYTES) return []

    const content = await readFile(file, 'utf8')
    // 有 NUL 字节基本可以断定是二进制。.uasset / .fbx 这类搜文本没有意义，
    // 而且内容会带一堆乱码进上下文
    if (content.includes('\u0000')) return []

    const out: Match[] = []
    const lines = content.split('\n')
    for (let i = 0; i < lines.length && out.length < remaining; i++) {
      // 每行都要重置 —— 带 g 标志的正则会记住上次匹配位置，
      // 不重置会导致隔行漏匹配，而且是那种看起来"随机"的漏
      regex.lastIndex = 0
      if (!regex.test(lines[i])) continue
      const text = lines[i].trimEnd()
      out.push({
        file,
        line: i + 1,
        text: text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}…` : text
      })
    }
    return out
  } catch {
    return []
  }
}

function createGrepTool(): UnrealAgentTool<never> {
  return defineTool({
    name: 'grep_local_files',
    namespace: 'local',
    risk: 'safe',
    description:
      '在用户电脑上的文件内容里搜正则。\n\n' +
      '【什么时候用】「哪个配置文件里写了 Nanite」「这批脚本里谁调用了某个函数」——' +
      '需要按内容而不是文件名找东西时用。\n' +
      '【只搜文本】含 NUL 字节的文件（.uasset、.fbx 等二进制）自动跳过，' +
      '要查虚幻资产请用 ue_content_search / ue_content_describe。\n' +
      '【建议先收窄】用 glob 限定范围（如 "**/*.ini"），全盘搜既慢又吵。',
    input: grepInput,
    execute: async (args, ctx) => {
      const limit = Math.max(1, Math.min(args.limit ?? MAX_MATCHES, MAX_MATCHES))

      // 这一条在整个边界里最要紧：grep 回的是**文件内容**。
      // 少了它，`{ path: '~/.ssh', pattern: 'PRIVATE KEY' }` 会把私钥正文
      // 直接送进模型上下文 —— 比 read_local_file 被绕过还严重，因为它
      // 不需要事先知道文件名，一次就能把整个目录捞干净。
      const denied = assertPathAllowed(args.path)
      if (denied) return { text: denied, isError: true }

      // 排在正则校验之前：不然「从 C:/ 搜」会被报成「正则写错了」，
      // 模型只会去改正则，接着再扫一次盘。
      // 也排在访问范围之前，理由同 find：盘符根在哪一档下都不该扫
      if (isFilesystemRoot(args.path)) {
        return { text: rootScanRefusal(args.path), isError: true }
      }

      const outOfScope = await assertInAccessScope(args.path)
      if (outOfScope) return { text: outOfScope, isError: true }

      let regex: RegExp
      try {
        regex = new RegExp(args.pattern, args.ignoreCase ? 'i' : '')
      } catch (error) {
        // 正则写错要说清楚是哪里错，否则调用方只会换个写法再试一遍
        return {
          text: `正则表达式无效：${(error as Error).message}`,
          isError: true
        }
      }

      try {
        const files = await globFiles(args.path, args.glob ?? '**/*', 5000, ctx.signal)
        const matches: Match[] = []

        for (let i = 0; i < files.length; i++) {
          if (matches.length >= limit) break
          // 逐个文件读内容是这里最慢的一段。不看中断信号的话，用户按了停止
          // 还要等几千个文件读完才真的停
          if (ctx.signal?.aborted) {
            return {
              text: `搜索已取消（已搜 ${i}/${files.length} 个文件，命中 ${matches.length} 条）`
            }
          }
          matches.push(...(await grepFile(files[i], regex, limit - matches.length)))

          // 每 200 个文件推一次进度。每个文件都推的话，扫几千个文件会
          // 刷出几千条 IPC 消息，界面自己先卡住
          if (i > 0 && i % 200 === 0) {
            ctx.report?.({ text: `已搜 ${i}/${files.length} 个文件，命中 ${matches.length} 条` })
          }
        }

        if (matches.length === 0) {
          return {
            text: `在 ${args.path} 下的 ${files.length} 个文件里没有匹配 "${args.pattern}" 的内容。`
          }
        }

        const lines = matches.map((m) => `${m.file}:${m.line}: ${m.text}`)
        const hitFiles = new Set(matches.map((m) => m.file)).size
        const header =
          matches.length >= limit
            ? `命中 ${limit} 条（已达上限，可能还有更多），分布在 ${hitFiles} 个文件：`
            : `命中 ${matches.length} 条，分布在 ${hitFiles} 个文件：`

        return {
          text: `${header}\n${lines.join('\n')}`,
          details: {
            root: args.path,
            pattern: args.pattern,
            scanned: files.length,
            matches: matches.length,
            truncated: matches.length >= limit
          }
        }
      } catch (error) {
        // 同 find：中止不是故障
        if (ctx.signal?.aborted) return { text: '搜索已取消' }
        return { text: `搜索失败：${(error as Error).message}`, isError: true }
      }
    }
  }) as unknown as UnrealAgentTool<never>
}

/** 查找 / 搜索工具。不依赖引擎连接 */
export function createLocalSearchTools(): UnrealAgentTool<never>[] {
  return [createFindTool(), createGrepTool()]
}

export const __testing = {
  ALWAYS_IGNORE,
  MAX_FILES,
  MAX_MATCHES,
  MAX_LINE_CHARS,
  grepFile,
  isFilesystemRoot
}
