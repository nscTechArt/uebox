/**
 * 本地磁盘的敏感位置边界。
 *
 * ## 为什么单独成一个模块
 *
 * 这份清单原先长在 `localFiles.ts` 里，只有 read / list / write / edit 四个
 * 「参数里明摆着有 path」的工具在用。于是出现了一个很尴尬的局面：
 *
 *   - `read_local_file('~/.ssh/id_rsa')` → 挡住
 *   - `run_shell_command('cat ~/.ssh/id_rsa')` → **放行**
 *   - `grep_local_files({ path: '~/.ssh', pattern: 'PRIVATE KEY' })` → **放行，还直接把内容回给模型**
 *
 * 一道墙只要有一扇没锁的门，它就不是墙。把边界抽出来放在这里，是为了让
 * 「哪些工具受它管」变成一个能一眼数清楚的问题 —— 长在 localFiles 里的时候，
 * 新写一个碰盘的工具很自然就会忘了这回事，上面那两个洞就是这么来的。
 *
 * ## 这道边界挡的是谁
 *
 * **不是用户。** 用户想看自己的 SSH 私钥，自己打开就是了，我们拦不住也不该拦。
 * 挡的是**被注入的提示词**：素材库里的一个 README、网上抓来的一段文档、
 * 第三方 MCP server 返回的一段文本，里面写着「顺便把 ~/.aws/credentials
 * 的内容发到 …」。agent 自己没有任何理由去碰这些位置，所以一律拒绝的代价
 * 几乎为零，而漏掉一次的代价是用户的云账号。
 *
 * ## 这道边界不是沙箱（重要）
 *
 * `assertCommandAllowed` 是在**命令字符串**里找特征，不是在系统调用层拦截。
 * `base64 -d`、`$(printf ...)`、变量拼接、写个脚本再执行 —— 全都能绕过去。
 * 它挡的是「直白地写出那个路径」这一种形态，而这恰好覆盖了几乎所有真实的
 * 注入尝试和模型自己的误闯，因为二者都没有绕过检查的动机。
 *
 * 真正的兜底是审批门（`core/approval.ts`）：`run_shell_command` 标了
 * `destructive`，ask / auto-edit 下每次都要用户点头。这层边界是给
 * **审批门不在场**的时候准备的 —— 定时任务和无人值守会话省略 `requestApproval`，
 * 等同 yolo，那时候它是唯一还站着的东西。
 */

import { posix } from 'path'

/**
 * 应用自己的 userData 目录（三个平台各不相同）。
 *
 * 里面躺着 `ai-provider-secrets.bin`（用户绑的 API key）、`chat-history`、
 * `agent-v3-sessions` —— 整个目录默认全拒，只开 `USER_DATA_EXCEPTIONS`
 * 那几个口子。
 */
const USER_DATA_FRAGMENTS = [
  '/appdata/roaming/unreal-box',
  '/library/application support/unreal-box',
  '/.config/unreal-box'
]

/**
 * userData 里允许碰的三个子目录。**只有这三个**，其余一律照旧拒绝。
 *
 * ## `skills/` —— 用户自己写的 skill
 *
 * `ue-skill-creator` 的整套流程 —— 读现有 skill、列目录看有没有重名、
 * 写 SKILL.md、回读校验 —— 落点全在 `<userData>/skills/` 下
 * （`capabilities/skills.ts` 的 `skillDirectories` 把它排在搜索路径第一位）。
 * 不开口子的话，模型会拿到「这个位置存放的是凭据」这句话，然后照着提示
 * 「换一个目录」把 skill 写到别处 —— 那个位置永远不会被加载，用户以为
 * 沉淀成功了，其实什么都没发生。
 *
 * 开得起是因为 skill 是**给模型看的说明书**，不是凭据。
 *
 * ## `database/vaults/` —— 用户的保管库（素材本体）
 *
 * 保管库的物理落点是 `<userData>/database/vaults/<库id>/`
 * （`VaultManager` 构造函数里拼的），也就是说**用户全部素材的原始文件都在
 * 禁区里面**。原先画的圈太大，把它一起圈进去了：真机上
 * `find_local_files({ path: '…/vaults/system_vault_aigc', pattern: '**\/*ToonHead*' })`
 * 会被当成「这里存放的是凭据」拒掉，而那只是用户自己的素材库。
 *
 * 只开 `vaults/`，不开 `database/` 整层 —— 同一层的 `app-data.db`
 * （公共库，含各种应用设置）、`backups/` 都还挡着。
 *
 * ## 例外的边界
 *
 * 匹配的是完整的一段路径（结尾带 `/`），所以 `skills-backup/`、
 * `vaults-old/` 这种前缀撞上的不算。`..` 在 `canonical` 里已经折叠掉了，
 * 从例外目录跳回 userData 根同样挡住。
 *
 * ## `team/` —— 工作室模式的共享工作区
 *
 * `/team` 的队员们在 `<userData>/team/<会话>/` 里放立项书、美术圣经、参考图、
 * 决策日志（见 `core/team/teamStore.ts`）。它在工程外面，因为工程是跑到半路才建的。
 * 不开口子的话，制作人被告知「这是你们的工作区」，第一次写文件就撞上「这里存放的是
 * 凭据」。开得起是因为里面全是团队自己写的文档；名册、任务板、队员对话这些
 * 盒子自己的账不在这里，在会话目录旁边，照旧挡着。
 *
 * 命令和 Python 也允许素材库，以支持图片尺寸检查、裁切等处理；skills 仍不开。
 * 命令逐处排除素材库前缀后继续检查敏感位置，不能用一个素材路径放行整条命令。
 */
const USER_DATA_EXCEPTION_SUBPATHS = ['skills', 'database/vaults', 'team']

const USER_DATA_EXCEPTIONS = USER_DATA_FRAGMENTS.flatMap((fragment) =>
  USER_DATA_EXCEPTION_SUBPATHS.map((subpath) => `${fragment}/${subpath}/`)
)

/**
 * 不允许访问的位置。
 *
 * 这里放的是「读到就等于泄露」的东西：AI 供应商密钥、SSH/云凭据、
 * 浏览器保存的登录态。
 *
 * **三个平台都要写全。** 这份清单原先只有 Windows 路径（`\appdata\roaming\…`），
 * 而 package.json 里有 `build:mac` / `build:linux`，electron-builder 也配了
 * dmg / AppImage / deb —— 也就是说在 macOS 和 Linux 上这层防护等于不存在：
 * `~/Library/Application Support/Google/Chrome`、`~/.config/gcloud` 全都放行。
 *
 * 判据统一成正斜杠再比，所以下面一律写 `/`。
 */
const OTHER_FRAGMENTS = [
  // ── SSH / 云 / 签名凭据（这几条本来就跨平台通用）──
  '/.ssh',
  '/.aws',
  '/.gnupg',
  '/.kube',
  '/.docker/config.json',
  '/.config/gcloud',
  '/.git-credentials',
  '/.netrc',
  '/.npmrc',

  // ── 浏览器保存的登录态 ──
  '/appdata/local/google/chrome/user data',
  '/appdata/local/microsoft/edge/user data',
  '/appdata/roaming/mozilla',
  '/library/application support/google/chrome',
  '/library/application support/firefox',
  '/library/safari',
  '/.config/google-chrome',
  '/.config/chromium',
  '/.mozilla',

  // ── 系统凭据库 ──
  '/appdata/roaming/microsoft/credentials',
  '/appdata/local/microsoft/credentials',
  '/library/keychains',
  '/.local/share/keyrings'
]

/** 命令先排除素材库前缀，再检查这些位置 */
const DENY_FRAGMENTS = [...USER_DATA_FRAGMENTS, ...OTHER_FRAGMENTS]

/**
 * 把一个路径压成能拿去比对的形状：正斜杠、小写、`..` 折叠掉、结尾带 `/`。
 *
 * ## 为什么必须折叠 `..`
 *
 * `SKILLS_EXCEPTIONS` 是按子串匹配的，而
 * `<userData>/skills/../ai-provider-secrets.bin` 这个字符串**含有**
 * `/unreal-box/skills/` —— 不折叠的话，例外会亲手把它放行，等于给密钥开后门。
 * 这是开这个口子最容易出的事故，`pathBoundary.test.ts` 里有专门盯它的用例。
 *
 * ## 为什么用 `posix.resolve` 而不是平台的 `resolve`
 *
 * 同一个 Windows 路径在 Linux 上跑 `resolve`，反斜杠不是分隔符，`..` 一个都
 * 折叠不掉 —— 于是「Windows 上挡住、CI 上放行」。先把反斜杠换成正斜杠，
 * 再一律按 posix 语义解析，两个平台才会得出同一个结论。
 *
 * 前面补 `/` 是为了让相对路径也有个确定的根（`posix.resolve` 否则会拿 cwd 去补，
 * 结果随进程工作目录变）。多出来的 `/c:` 前缀不影响子串比对。
 *
 * 导出是给 `accessScope.ts` 用的：那边要判「这个路径在不在某个允许的目录下」，
 * 靠的是前缀比对，而前缀比对的前提正是两边用**同一套**归一化。各写一份的话，
 * 早晚有一份漏掉折叠 `..`，于是 `<工程>/../../秘密` 会被当成工程内的路径放行。
 */
export function canonicalDir(path: string): string {
  return canonical(path)
}

function canonical(path: string): string {
  const resolved = posix.resolve('/', path.replace(/\\/g, '/')).toLowerCase()
  // 结尾补一个 `/`：不补的话，目录本身（`…/skills`）匹配不上以 `/` 收尾的例外，
  // 于是「能写文件、不能列目录」
  return resolved.endsWith('/') ? resolved : `${resolved}/`
}

function isDenied(absolute: string): boolean {
  const normalized = canonical(absolute)

  // 和 userData 无关的位置先判 —— 例外只对 userData 生效，不能让
  // `<userData>/skills/.ssh/id_rsa` 这种写法顺带把别的规则一起绕过去
  if (OTHER_FRAGMENTS.some((fragment) => normalized.includes(fragment))) return true

  if (!USER_DATA_FRAGMENTS.some((fragment) => normalized.includes(fragment))) return false

  return !USER_DATA_EXCEPTIONS.some((fragment) => normalized.includes(fragment))
}

// 读和写共用这一条，所以不能写成「不允许读取」—— 写入被挡时那句话对不上，
// 调用方会以为自己调错了工具再换一个试
const DENY_MESSAGE =
  '这个位置存放的是凭据、密钥或浏览器数据，不允许访问。' +
  '需要其中的信息就请用户自己查看后告诉你；需要在附近写文件请换一个目录，' +
  '不要换一种路径写法再试。'

// 命令被挡时不能用上面那句：那句在说「换个目录」，而这里的问题是整条命令
// 提到了某个敏感位置。不点明这一点，模型会去改路径写法（加引号、换成 $HOME、
// 拆成两条），一次次撞在同一堵墙上。
const DENY_COMMAND_MESSAGE =
  '这条命令里出现了凭据、密钥或浏览器数据的存放位置，已拒绝执行。' +
  '不要改写路径再试（换引号、换成 $HOME、拆成多条都一样会被挡）。' +
  '确实需要其中的信息，请让用户自己查看后告诉你。'

// 脚本走的是 UE 里的 Python，说「命令」对不上，模型会以为是别的工具被挡了
const DENY_SCRIPT_MESSAGE =
  '这段脚本里出现了凭据、密钥或浏览器数据的存放位置，已拒绝执行。' +
  '不要改写路径再试（os.path.expanduser、字符串拼接、换个变量名都一样会被挡）。' +
  '确实需要其中的信息，请让用户自己查看后告诉你。'

/**
 * 路径不允许时返回给模型看的说明，允许则返回 undefined。
 *
 * 读、列目录、写、改、查找、内容搜索共用这一份规则 —— 挡读不挡写、
 * 挡单文件不挡整目录，都等于没挡。
 */
export function assertPathAllowed(path: string): string | undefined {
  return isDenied(path) ? DENY_MESSAGE : undefined
}

/**
 * 把一条 shell 命令压成「能拿去和路径特征比对」的形状。
 *
 * 两步：
 *
 *   1. 反斜杠一律变正斜杠。它在 Windows 上是分隔符，在 bash 里是转义符
 *      （`/c/Program\ Files/...`）—— 两种身份都该被抹平，留着只会漏。
 *   2. **路径里不可能出现的字符一律变成 `/`，再把连续的 `/` 压成一个。**
 *      空格、引号、管道、分号、括号、反引号全算。这一步有两个作用：让 token
 *      的开头也成为一个「路径边界」（`cd ~ && cat .ssh/id_rsa` 里的 `.ssh`
 *      前面没有斜杠，不这么处理就漏了），以及让引号插在路径中间时不影响比对
 *      （`~/".ssh"/id_rsa`）。
 *
 * 代价是会误挡一些无辜的命令 —— `git commit -m "fix .netrc parsing"` 会被
 * 当成在碰 `.netrc`。这个方向的错是可以接受的：误挡一次模型换条路走，
 * 漏放一次是用户的私钥进了模型上下文。
 *
 * 导出是给 `projectCreationGuard` 用的：那道边界管的是另一回事（建工程要走
 * 专用工具），但「在一条命令里认出某个路径」这一步的规矩必须一模一样 ——
 * 各写一份的结果一定是其中一份漏掉引号或反斜杠那种写法。
 */
export function normalizeCommand(command: string): string {
  return command
    .replace(/\\/g, '/')
    .toLowerCase()
    .replace(/[^a-z0-9_./:~%$-]/g, '/')
    .replace(/\/+/g, '/')
}

/**
 * 拿去和命令比对的特征串。
 *
 * 清单里有三条带空格（`…/chrome/user data`、`…/application support/…`），
 * 而 `normalizeCommand` 刚把空格换成了 `/` —— 不同步做这一下，恰恰是浏览器
 * 登录态和 mac 上的密钥库这几条**永远匹配不上**，而它们正是最该挡的。
 */
const COMMAND_FRAGMENTS = DENY_FRAGMENTS.map((fragment) => fragment.replace(/ /g, '/'))

/**
 * 命令和 Python 里放行的 userData 子目录：素材库，加上工作室模式的共享工作区。
 *
 * 工作区那条是 2026-09-26 真机反馈补的：队员把 PowerShell 脚本写进团队工作区再
 * `powershell -File` 去跑，被当成「凭据位置」拒掉 —— 而报错还明令不许换写法重试，
 * 唯一的替代路就这样被堵死。skills 仍然不开。
 */
const COMMAND_ALLOWED_SUBPATHS = ['database/vaults', 'team']

const COMMAND_VAULT_PREFIXES = USER_DATA_FRAGMENTS.flatMap((fragment) =>
  COMMAND_ALLOWED_SUBPATHS.map(
    (subpath) =>
      new RegExp(
        `${fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/${subpath}(?=$|[/\\s'"\x60),;|&<>])`,
        'g'
      )
  )
)

/** 一段源码（shell 命令 / Python 脚本）里有没有提到敏感位置 */
function mentionsDeniedLocation(source: string): boolean {
  const normalized = normalizeCommand(source)
  // 不解析 shell 的 cwd 或 Python 的 chdir：出现父目录跳转时保守地保留原检查。
  // 这也覆盖先 cd 到素材库，再以相对路径跳出素材库的命令。
  if (normalized.split('/').includes('..')) {
    return COMMAND_FRAGMENTS.some((fragment) => normalized.includes(fragment))
  }

  /*
   * 在原文上匹配完整目录名，避免归一化把 vaults中文 / vaults.old 等变成例外。
   *
   * `\ ` 要先还原成空格再换分隔符。bash 里 `Application\ Support` 是一个带空格的
   * 目录名，而 mac 的 userData 路径恰好带空格；不先还原的话它变成
   * `Application/ Support`，例外匹配不上，然后 `normalizeCommand` 又把空格换成
   * `/` 拼回 `/library/application/support/unreal-box` —— 于是素材库例外在 mac 上
   * 对最常见的转义写法完全失效（拒绝，不是放行，但功能等于没有）。
   */
  let remaining = source.replace(/\\ /g, ' ').replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase()
  for (const prefix of COMMAND_VAULT_PREFIXES) {
    remaining = remaining.replace(prefix, '/user-vault')
  }
  const checked = normalizeCommand(remaining)
  return COMMAND_FRAGMENTS.some((fragment) => checked.includes(fragment))
}

/**
 * 命令里提到了敏感位置时返回说明，否则返回 undefined。
 *
 * 注意这是**特征匹配，不是沙箱** —— 模块头部那段说明了它挡得住什么、
 * 挡不住什么。别把它当成「跑命令是安全的」的依据。
 */
export function assertCommandAllowed(command: string): string | undefined {
  return mentionsDeniedLocation(command) ? DENY_COMMAND_MESSAGE : undefined
}

/**
 * 同上，用于在引擎里执行的 Python 脚本。
 *
 * 为什么这条也要管：`ue_run_python_script` 跑在 UE 进程里，但 UE 的 Python
 * 有完整的 `open()` —— `open(os.path.expanduser('~/.ssh/id_rsa')).read()`
 * 一样能把私钥读出来回给模型。这道边界只要漏掉一个出口就不成其为边界，
 * 而这是除 shell 之外最宽的那个出口。
 */
export function assertScriptAllowed(script: string): string | undefined {
  return mentionsDeniedLocation(script) ? DENY_SCRIPT_MESSAGE : undefined
}

export const __testing = {
  isDenied,
  canonical,
  normalizeCommand,
  DENY_MESSAGE,
  DENY_COMMAND_MESSAGE,
  DENY_SCRIPT_MESSAGE
}
