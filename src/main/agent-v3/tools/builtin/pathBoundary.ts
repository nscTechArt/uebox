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

import { homedir } from 'os'
import { posix } from 'path'

/**
 * 应用自己的 userData 目录（三个平台各不相同）。
 *
 * ## 只挡里面的凭据，不挡整个目录
 *
 * 原先整个目录默认全拒，只开 skills / 素材库 / 团队工作区三个口子。代价是 agent
 * 读不了自己的日志（`logs/`）、MCP 配置（`mcp.json`）、对话记录 —— 排查「刚才那一步
 * 为什么失败」时最该看的东西全在禁区里。读到就等于泄露的只有下面列出的几处。
 */
const USER_DATA_FRAGMENTS = [
  '/appdata/roaming/unreal-box',
  '/library/application support/unreal-box',
  '/.config/unreal-box'
]

/**
 * userData 里读写都挡的（相对 userData 根）。
 *
 * - `ai-provider-secrets.bin`：模型密钥（`ai/credentials.ts`）
 * - `catalog-library-secrets.bin`：服务端资产库的凭据（`libraryV3/catalogService.ts`）
 * - `network-credentials/`：网络共享盘的账号密码（`smb/NetworkAuthManager.ts`）
 * - `mcp-server.json`：盒子对外 MCP 服务的令牌，明文（`capabilities/mcp/hostStore.ts`）
 * - `database/`（保管库 `database/vaults/` 除外，见下）：`app-data.db` 里存着资产库
 *   访问码，safeStorage 不可用时是明文（`VaultManager.writeServerAccessKey`）；它又是
 *   正在用的 SQLite，写一下就可能把库写坏，读出来的也可能是写到一半的页。读写都挡最简单，
 *   agent 要查库里的东西有专门的工具。
 * - Chromium 的会话数据（`Cookies`、`Network/`、`Local Storage/`、`Session Storage/`、
 *   `IndexedDB/`、`Partitions/`）：应用和 Agent 浏览器的登录态，等同浏览器配置目录。
 */
const USER_DATA_SECRET_SUBPATHS = [
  'ai-provider-secrets.bin',
  'catalog-library-secrets.bin',
  'network-credentials',
  'mcp-server.json',
  'database',
  'cookies',
  'cookies-journal',
  'network',
  'local storage',
  'session storage',
  'indexeddb',
  'partitions'
]

/**
 * 上面那份里开的口子：保管库。
 *
 * 保管库的物理落点是 `<userData>/database/vaults/<库id>/`（`VaultManager` 拼的），
 * **用户全部素材的原始文件**都在这里。只开 `vaults/`，同一层的 `app-data.db`、
 * `backups/` 照旧挡着。按完整一段匹配，`vaults-old/` 这种前缀撞上的不算。
 */
const USER_DATA_SECRET_EXCEPTIONS = ['database/vaults']

/**
 * userData 里能读、不能写的：决定 agent 自己权限和行为的配置。
 *
 * 写进去等于 agent 给自己松绑，或者埋一条绕过审批门执行的命令：`app-settings.json`
 * 里有文件访问范围和浏览器局域网开关；`models.json` 的密钥可以配成「跑一条命令取」；
 * `mcp.json` 和 `plugins/` 会在下次启动时拉起任意进程。这些走设置页改。
 *
 * 只管路径类工具。命令和脚本分不清读和写，所以这一档在命令里不挡 —— 那条路
 * 靠审批门兜底（见文件头）。
 */
const USER_DATA_WRITE_PROTECTED_SUBPATHS = [
  'app-settings.json',
  'models.json',
  'mcp.json',
  'plugins'
]

/**
 * 用户主目录下的凭据。**只有直接挂在主目录下才算。**
 *
 * 原先按子串匹配，路径或命令里任何地方出现 `.npmrc`、`.kube`、`.netrc` 都挡：工程自己的
 * `.npmrc`、`git commit -m "fix .netrc"`、仓库里叫 `.kube` 的部署目录全被当成凭据拒掉。
 * 真正的凭据只在 `~/.npmrc` 这种位置。
 */
const HOME_CREDENTIALS = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.kube',
  '.docker/config.json',
  '.config/gcloud',
  '.git-credentials',
  '.netrc',
  '.npmrc'
]

/**
 * 位置本身就足够特别、出现在哪都算的：浏览器保存的登录态、系统凭据库。
 *
 * **三个平台都要写全。** 这份清单原先只有 Windows 路径，而仓库也出 mac / Linux 包 ——
 * 在那两个平台上这层防护等于不存在。判据统一成正斜杠再比，所以下面一律写 `/`。
 */
const ANYWHERE_FRAGMENTS = [
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

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const HOME_CREDENTIAL_ALTERNATION = HOME_CREDENTIALS.map(escapeRegExp).join('|')

/** 本机实际的主目录（规范化后、不带结尾 `/`）。读不到就只靠通用写法 */
function actualHome(): string | undefined {
  try {
    const home = homedir()
    return home ? canonical(home).replace(/\/$/, '') : undefined
  } catch {
    return undefined
  }
}

let homeCredentialPath: RegExp | undefined
let homeCredentialCommand: RegExp | undefined

/**
 * 路径（已规范化）是不是主目录下的凭据。
 *
 * 「主目录」认这几种样子：`~` 和环境变量写法、三个平台的约定位置（`C:/Users/<名>`、
 * Git Bash 的 `/c/Users/<名>`、`/Users/<名>`、`/home/<名>`、`/root`），加上本机实际的
 * 主目录（主目录不在约定位置时靠它）。
 */
function isHomeCredentialPath(normalized: string): boolean {
  if (!homeCredentialPath) {
    const home = actualHome()
    const homes = [
      String.raw`/(?:~|\$home|\$\{home\}|%userprofile%)`,
      String.raw`(?:/[a-z]:?)?/(?:users|home)/[^/]+`,
      '/root',
      '/var/root',
      ...(home ? [escapeRegExp(home)] : [])
    ].join('|')
    homeCredentialPath = new RegExp(`^(?:${homes})/(?:${HOME_CREDENTIAL_ALTERNATION})/`)
  }
  return homeCredentialPath.test(normalized)
}

/**
 * 命令（已经过 `normalizeCommand`）里有没有写出主目录下的凭据。
 *
 * 命令里的路径不在开头，所以主目录的通用写法不锚定在行首；`${HOME}` 归一化后是
 * `$/home`，单独补一条。
 */
function mentionsHomeCredential(normalized: string): boolean {
  if (!homeCredentialCommand) {
    const home = actualHome()
    const after = `/(?:${HOME_CREDENTIAL_ALTERNATION})(?=/|$)`
    homeCredentialCommand = new RegExp(
      [
        String.raw`(?:^|/)(?:~|\$home|\$/home|%userprofile%)${after}`,
        String.raw`/(?:users|home)/[^/]+${after}`,
        String.raw`(?:^|/)root${after}`,
        ...(home ? [`${escapeRegExp(home)}${after}`] : [])
      ].join('|')
    )
  }
  return homeCredentialCommand.test(normalized)
}

/**
 * 把一个路径压成能拿去比对的形状：正斜杠、小写、`..` 折叠掉、结尾带 `/`。
 *
 * ## 为什么必须折叠 `..`
 *
 * 保管库例外是按前缀认的，而 `<userData>/database/vaults/../../ai-provider-secrets.bin`
 * 这个字符串**含有**那个前缀 —— 不折叠的话，例外会亲手把它放行，等于给密钥开后门。
 * `pathBoundary.test.ts` 里有专门盯它的用例。
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
  // 结尾补一个 `/`：不补的话，目录本身（`…/database`）匹配不上以 `/` 收尾的规则
  return resolved.endsWith('/') ? resolved : `${resolved}/`
}

/**
 * 相对路径按主目录解析：本地文件工具的工作目录就是用户主目录（`localFiles.ts` 的
 * `getEnv`），`.ssh/id_rsa` 读到的就是 `~/.ssh/id_rsa`。
 */
function asAbsolute(path: string): string {
  const trimmed = path.trim()
  return /^(?:[a-z]:|[\\/]|~|\$|%)/i.test(trimmed) ? trimmed : `~/${trimmed}`
}

/** userData 根之后的那一段（规范化、带结尾 `/`）。不在 userData 里返回 undefined */
function userDataRest(normalized: string): string | undefined {
  for (const fragment of USER_DATA_FRAGMENTS) {
    const index = normalized.indexOf(`${fragment}/`)
    if (index >= 0) return normalized.slice(index + fragment.length + 1)
  }
  return undefined
}

const startsWithSegment = (rest: string, subpath: string): boolean => rest.startsWith(`${subpath}/`)

type AccessMode = 'read' | 'write'

/** 为什么不许：凭据（读写都挡），或者盒子自己的配置（只挡写）。允许返回 undefined */
function denialKind(path: string, mode: AccessMode = 'read'): 'secret' | 'config' | undefined {
  const normalized = canonical(asAbsolute(path))

  if (ANYWHERE_FRAGMENTS.some((fragment) => normalized.includes(fragment))) return 'secret'
  if (isHomeCredentialPath(normalized)) return 'secret'

  const rest = userDataRest(normalized)
  if (rest === undefined) return undefined

  const secret =
    USER_DATA_SECRET_SUBPATHS.some((subpath) => startsWithSegment(rest, subpath)) &&
    !USER_DATA_SECRET_EXCEPTIONS.some((subpath) => startsWithSegment(rest, subpath))
  if (secret) return 'secret'

  if (
    mode === 'write' &&
    USER_DATA_WRITE_PROTECTED_SUBPATHS.some((subpath) => startsWithSegment(rest, subpath))
  ) {
    return 'config'
  }
  return undefined
}

function isDenied(path: string, mode: AccessMode = 'read'): boolean {
  return denialKind(path, mode) !== undefined
}

// 读和写共用这一条，所以不能写成「不允许读取」—— 写入被挡时那句话对不上，
// 调用方会以为自己调错了工具再换一个试
const DENY_MESSAGE =
  '这个位置存放的是凭据、密钥或浏览器数据，不允许访问。' +
  '需要其中的信息就请用户自己查看后告诉你；需要在附近写文件请换一个目录，' +
  '不要换一种路径写法再试。'

// 配置能读不能写。说清楚为什么、该找谁改，不然模型会换个写法再写一遍
const DENY_CONFIG_WRITE_MESSAGE =
  '这是虚幻盒子自己的配置（权限、模型、MCP、插件），可以读，不允许直接改写 —— ' +
  '改了等于绕过设置页给 agent 换权限。需要调整请告诉用户去设置页里改。'

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
 * 挡单文件不挡整目录，都等于没挡。`mode` 只多管一件事：盒子自己的配置能读不能写。
 */
export function assertPathAllowed(path: string, mode: AccessMode = 'read'): string | undefined {
  const kind = denialKind(path, mode)
  if (kind === 'secret') return DENY_MESSAGE
  if (kind === 'config') return DENY_CONFIG_WRITE_MESSAGE
  return undefined
}

/**
 * 把一条 shell 命令压成「能拿去和路径特征比对」的形状。
 *
 * 两步：
 *
 *   1. 反斜杠一律变正斜杠。它在 Windows 上是分隔符，在 bash 里是转义符
 *      （`/c/Program\ Files/...`）—— 两种身份都该被抹平，留着只会漏。
 *   2. **路径里不可能出现的字符一律变成 `/`，再把连续的 `/` 压成一个。**
 *      空格、引号、管道、分号、括号、反引号全算。这一步让引号插在路径中间时
 *      不影响比对（`~/".ssh"/id_rsa`）。
 *
 * 导出是给 `projectCreationGuard` 用的：那边管的是另一回事（建工程该走专用工具），
 * 但「在一条命令里认出某个路径」这一步的规矩必须一模一样 —— 各写一份的结果
 * 一定是其中一份漏掉引号或反斜杠那种写法。
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
 * 清单里有几条带空格（`…/chrome/user data`、`…/application support/…`、
 * `local storage`），而 `normalizeCommand` 把空格换成了 `/` —— 不同步做这一下，
 * 恰恰是浏览器登录态和 mac 上的密钥库这几条**永远匹配不上**。
 */
const toCommandForm = (fragment: string): string => fragment.replace(/ /g, '/')

const COMMAND_ANYWHERE = ANYWHERE_FRAGMENTS.map(toCommandForm)
const COMMAND_USER_DATA = USER_DATA_FRAGMENTS.map(toCommandForm)

/** userData 里的凭据，命令形态。按完整一段匹配：后面必须是 `/` 或结尾 */
const COMMAND_USER_DATA_SECRETS = COMMAND_USER_DATA.flatMap((fragment) =>
  USER_DATA_SECRET_SUBPATHS.map(
    (subpath) => new RegExp(`${escapeRegExp(`${fragment}/${toCommandForm(subpath)}`)}(?=/|$)`)
  )
)

/**
 * 命令和 Python 里的保管库前缀。先在原文上把它换成一个中性的占位，再查凭据 ——
 * 在原文上匹配完整目录名，避免归一化把 vaults中文 / vaults.old 等变成例外。
 */
const COMMAND_VAULT_PREFIXES = USER_DATA_FRAGMENTS.flatMap((fragment) =>
  USER_DATA_SECRET_EXCEPTIONS.map(
    (subpath) => new RegExp(`${escapeRegExp(fragment)}/${subpath}(?=$|[/\\s'"\x60),;|&<>])`, 'g')
  )
)

/** 认作「主目录」的 cd 目标（原文、小写、去掉结尾 `/`） */
const HOME_CD_TARGETS = new Set(['', '~', '$home', '${home}', '%userprofile%'])

/**
 * 命令是不是一直待在主目录（shell 的工作目录就是主目录，见 `asAbsolute`）。
 *
 * 没有 cd，或者 cd 的都是主目录，相对路径 `.netrc` 指的就是 `~/.netrc`；cd 到别处
 * 之后它指的是那里的 `.netrc`（比如工程自己的 `.npmrc`），不该挡。
 */
function staysInHome(raw: string): boolean {
  const cd =
    /(?:^|[\s;&|(])(?:cd|pushd|chdir|set-location|sl)(?:\s+\/d)?(?:\s+["']?([^\s;&|)"']*)["']?)?(?=$|[\s;&|)])/g
  return [...raw.matchAll(cd)].every((match) =>
    HOME_CD_TARGETS.has((match[1] ?? '').replace(/\/+$/, ''))
  )
}

/**
 * 主目录下的凭据以**相对路径**出现（`cat .netrc`、`cd ~ && cat .ssh/id_rsa`）。
 *
 * 只认作为一个 token 开头出现、且不在引号里的那种：引号里的多半是提交信息之类的文字
 * （`git commit -m "fix .netrc"`），`proj/.npmrc` 则是别处的文件。
 */
function mentionsRelativeHomeCredential(raw: string): boolean {
  if (!staysInHome(raw)) return false
  const unquoted = raw.replace(/"[^"]*"|'[^']*'/g, ' ')
  return new RegExp(
    String.raw`(?:^|[\s;&|(<>=])(?:\./)?(?:${HOME_CREDENTIAL_ALTERNATION})(?=$|[\s/;&|)<>])`
  ).test(unquoted)
}

/** 一段源码（shell 命令 / Python 脚本）里有没有提到敏感位置 */
function mentionsDeniedLocation(source: string, kind: 'command' | 'script'): boolean {
  const normalized = normalizeCommand(source)

  if (COMMAND_ANYWHERE.some((fragment) => normalized.includes(fragment))) return true
  if (mentionsHomeCredential(normalized)) return true

  // Python 的工作目录是引擎的，不是主目录 —— 相对路径那一条只对命令有意义
  const raw = source.replace(/\\/g, '/').toLowerCase()
  if (kind === 'command' && mentionsRelativeHomeCredential(raw)) return true

  if (!COMMAND_USER_DATA.some((fragment) => normalized.includes(fragment))) return false

  // 不解析 shell 的 cwd 或 Python 的 chdir：提到 userData 又出现父目录跳转时，保守地拒绝。
  // 这也覆盖先 cd 到素材库，再以相对路径跳出去读密钥的命令。
  if (normalized.split('/').includes('..')) return true

  /*
   * `\ ` 要先还原成空格再换分隔符。bash 里 `Application\ Support` 是一个带空格的
   * 目录名，而 mac 的 userData 路径恰好带空格；不先还原的话素材库例外在 mac 上
   * 对最常见的转义写法完全失效。
   */
  let remaining = source.replace(/\\ /g, ' ').replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase()
  for (const prefix of COMMAND_VAULT_PREFIXES) {
    remaining = remaining.replace(prefix, '/user-vault')
  }
  const checked = normalizeCommand(remaining)
  return COMMAND_USER_DATA_SECRETS.some((pattern) => pattern.test(checked))
}

/**
 * 命令里提到了敏感位置时返回说明，否则返回 undefined。
 *
 * 注意这是**特征匹配，不是沙箱** —— 模块头部那段说明了它挡得住什么、
 * 挡不住什么。别把它当成「跑命令是安全的」的依据。
 */
export function assertCommandAllowed(command: string): string | undefined {
  return mentionsDeniedLocation(command, 'command') ? DENY_COMMAND_MESSAGE : undefined
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
  return mentionsDeniedLocation(script, 'script') ? DENY_SCRIPT_MESSAGE : undefined
}

export const __testing = {
  isDenied,
  canonical,
  normalizeCommand,
  DENY_MESSAGE,
  DENY_CONFIG_WRITE_MESSAGE,
  DENY_COMMAND_MESSAGE,
  DENY_SCRIPT_MESSAGE
}
