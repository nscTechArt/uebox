/**
 * 帮助文本，中英两份。
 *
 * 命令名、选项名、字段名和错误码**固定为英文**（§4）—— 它们是接口，翻译过去
 * 就成了两套接口。只有解释性的话有两个版本。
 *
 * `--help` / `--version` 不读凭据、不连服务：用户想知道怎么用的时候，
 * 不该被「先去配置一下」挡住。
 *
 * ## 写这份文本的四条约束（`helpText` 上的测试逐条钉住）
 *
 * 1. **不许出现 Markdown。** 终端不渲染 `**`，用户看见的就是两个星号。
 *    要强调就靠措辞和位置，不靠标记。
 * 2. **每行不超过 80 列（CJK 按 2 列算）。** 超了会在 80 列终端上回绕，
 *    把对齐好的两栏排版拧成一团 —— 那比不对齐更难读。
 * 3. **陈述行为，不论证行为。** 「为什么这么设计」属于；
 *    帮助里只说它会怎么做。
 * 4. **例子必须是能照抄的。** 尤其 `--args`：PowerShell 5.1 和 cmd 会吃掉
 *    裸 JSON 里的引号（实测：`'{"k":"v"}'` 到进程里变成 `{k:v}`），
 *    所以这里给的是两个 shell 各自验证过的转义形式。
 *
 * ## 分两层：`--help` 和 `--help --all`
 *
 * 加上写操作之后完整帮助有一百一十多行 —— 在一个 30 行的终端上是四屏，而
 * 最要紧的东西（写操作规则、退出码）恰好在最下面，最不容易被看到。
 *
 * 所以默认那份只留「要动手就得知道」的：命令、例子、公共选项、退出码；
 * 参考性的那几段（各命令的专属选项、写操作的完整规则、工程解析、输出可信度）
 * 挪到 `--help --all`。**不是靠删内容达标的** —— 两份都在，只是分了层。
 */

export type Lang = 'zh-CN' | 'en-US'

/** 总是要显示的部分：命令、例子、公共选项 */
const ZH_CORE = `虚幻盒子 CLI —— 从终端调用虚幻引擎能力

用法：
  uebox <命令> [选项]

  第一次用先跑 uebox setup；之后连不上就跑 uebox doctor。

命令：
  setup                     关联本机虚幻盒子的配置并验证连接
  doctor                    逐层体检：连接、接口契约、工具范围、工程注册
  projects list             列出已注册且在线的 UE 工程
  tools list                列出能调用的工具（加 --allow-write 连写工具一起列）
  tools show <name>         某个工具的完整描述和参数定义
  tools call <name>         调用任意一个工具
  selection get             编辑器里此刻选中/打开的内容
  actors list               关卡里的 Actor（位置厘米、旋转度、缩放倍数）
  viewport screenshot       把视口画面存成 PNG 文件

  后三条是 tools call 的快捷形式：参数更少，输出字段固定。

写命令（会改动东西，都要加 --allow-write）：
  actors spawn              生成一个 Actor，要 --name 和 --asset
  actors move               设置位置/旋转/缩放，要 --name
  actors delete             删除一个 Actor，要 --name
  actors undo               撤销上面这些命令做过的一步
  tools call <name>         盒子 AI 助手能用的工具，这里都能调

  前四条是加强档：返回前 CLI 自己回读引擎核对，对不上就报失败，超时给
  回读命令。tools call 是原样转发，核实看工具自己的返回值。都别直接重发。
  撤销一定要用 actors undo —— 编辑器里按 Ctrl+Z 碰不到 CLI 这一步。

示例：
  uebox setup
  uebox actors list --name PlayerStart
  uebox actors list --limit 200 --include-system --json
  uebox viewport screenshot --output shot.png --overwrite
  uebox tools call search_assets --args-file args.json
  uebox actors move --name MyCube --location z=200 --allow-write
  uebox actors spawn --name Box1 --asset StaticMeshActor --allow-write

  --args 里直接写 JSON 要按所在 shell 转义，裸 JSON 两边都会被吃掉引号：
    PowerShell   --args '{\\"name\\":\\"Floor\\"}'
    cmd          --args "{""name"":""Floor""}"
  嫌绕就用 --args-file <文件>，或 --args-file - 从标准输入读。

公共选项（写在子命令前面或后面都行）：
  --json                    stdout 只输出一个 JSON 对象；诊断走 stderr
  --config <path>           指定 CLI 自己的配置文件
  --lang zh-CN|en-US        帮助与提示用哪种语言
  --timeout <seconds>       整条命令的期限，默认 120
  -h, --help                看这段
  -v, --version             看版本号`

/** 参考性的几段，只在 `--help --all` 里给 */
const ZH_DETAIL = `命令专属选项：
  setup       --host-config <path>  直接指定盒子的配置文件（无 TTY 时必须给）
  doctor      --project <path>      顺带确认这个工程能不能当目标
  tools list  --search <text>       按名字或描述筛选
  tools call  --args <JSON>         参数
              --args-file <path>    从文件读参数；写 - 表示从标准输入读
              --project <path>      目标工程，.uproject 文件或其所在目录都行
  actors list --name <text>         按 Name/Label 精确匹配，不填则扫全关卡
              --limit <n>           返回上限，1-1000，默认 50
              --include-system      连引擎的记账 Actor 一起算
  viewport screenshot
              --output <path>       必填，只接受 .png，相对路径按当前目录算
              --world auto|editor   默认 auto，PIE 在跑就拍游戏世界
              --overwrite           允许覆盖已存在的文件
  写命令共用   --allow-write         确认这条命令可以改动工程
              --asset <text>        生成什么：别名、/Game/ 路径或类名
              --location x,y,z      位置，厘米。也可以写 z=200 只设一个分量
              --rotation p,y,r      旋转，度。也可以写 yaw=90
              --scale x,y,z         缩放倍数。也可以写 x=2

关于写操作：
  判据一句话：盒子自己的 AI 助手能用的工具，这里加 --allow-write 都能调。
  命名空间不参与判断，所以素材库（search_assets）、工程库（project_list /
  project_organize）、把素材库资产导进工程（project_manage）全都在。
  只有两类仍然不给：要求逐次人工审批的工具，和盒子那头压根没暴露的
  本机文件/shell。判据。

  --allow-write 不是多余的开关。盒子里那个「同时开放写操作工具」是给带审批
  界面的客户端用的，CLI 这头一个弹窗都没有，这个开关就是顶替它的那一下。
  （盒子那头没勾的话，写工具根本不在清单里 —— uebox doctor 会说破。）

  两条路，核实强度不同：
    actors spawn/move/delete/undo   CLI 自己回读核对，对不上就报失败
    tools call <任意工具>           原样转发，核实看工具自己的返回值

  超时都不要直接重发。加强档会给一条能直接敲的回读命令；tools call 那条
  只能告诉你去查哪里 —— 先查清楚做了没有，再决定要不要重发。

目标工程按这个顺序定：
  1. --project 指定的
  2. 从当前目录逐层往上找到的最近的 .uproject
  3. 前两步都没有时，恰好只有一个工程在线才用它

  前两步定出来的工程如果没连着，命令直接失败，不会改发给别的在线工程。

读结果之前要知道的：
  actors list   引擎的记账 Actor（HLOD、导航网格、物理体积）默认不计入，
                有被滤掉时警告里给真实总数。被 --limit 截断时也有警告。
                totalCount 为 null 是「插件没报总数」，不是「没有更多」。
  screenshot    文件落地前核验 PNG 格式与尺寸，核验不过一律非零退出。
                这条路自己渲一帧，曝光比编辑器视口偏暗约一档，
                不要拿它判断过曝或欠曝。`

/** 退出码和前提，两份都要有 —— 脚本靠它决定下一步 */
const ZH_TAIL = `退出码：
  0     成功
  2     参数或输出位置要改
  3     配置或认证
  4     盒子不可达，或版本不支持
  5     定不下唯一的目标工程
  6     工具超出范围，或是写工具但没加 --allow-write
  7     超时。请求可能已经到引擎，结果不明，先核实再重发
  8     引擎操作失败，或文件没交付
  130   用户中断。不代表引擎已经撤销操作

  不会返回 1。真收到 1 说明进程在 CLI 接手之前就崩了。

不加 --allow-write 时，CLI 只调用只读工具。
需要虚幻盒子正在运行（对外服务默认开着，除非你在设置里关过）。
引擎类命令还要求目标 UE 编辑器已打开并完成插件握手；列工具不要求。`

/** 短帮助里指路，别让人以为就这些 */
const ZH_MORE = `还有：各命令的专属选项、写操作的完整规则、目标工程怎么定、
结果里哪些数不能直接信 —— 都在 uebox --help --all。`

const EN_CORE = `Unreal Box CLI — drive Unreal Engine from your terminal

Usage:
  uebox <command> [options]

  Run uebox setup once first; run uebox doctor when it stops connecting.

Commands:
  setup                     Link this machine's Unreal Box config, verify it
  doctor                    Layered check: connection, contract, scope, projects
  projects list             List registered, online UE projects
  tools list                List callable tools (--allow-write adds writers)
  tools show <name>         Full description and input schema for one tool
  tools call <name>         Call any tool
  selection get             What is selected / open in the editor right now
  actors list               Actors in the level (cm, degrees, multipliers)
  viewport screenshot       Save the viewport image to a PNG file

  The last three are shortcuts over tools call: fewer arguments, fixed fields.

Write commands (these change things; all need --allow-write):
  actors spawn              Spawn one actor; needs --name and --asset
  actors move               Set location / rotation / scale; needs --name
  actors delete             Delete one actor; needs --name
  actors undo               Undo one step made by the commands above
  tools call <name>         Anything the box's own assistant can use

  The first four are reinforced: the CLI reads the engine back and fails if
  it disagrees. tools call forwards as-is — trust the tool's own reply, and
  never blind-retry. Undo with actors undo; Ctrl+Z hits the editor's stack.

Examples:
  uebox setup
  uebox actors list --name PlayerStart
  uebox viewport screenshot --output shot.png --overwrite
  uebox tools call search_assets --args-file args.json
  uebox actors move --name MyCube --location z=200 --allow-write
  uebox actors spawn --name Box1 --asset StaticMeshActor --allow-write

  Inline JSON in --args must be escaped for your shell; both eat bare quotes:
    PowerShell   --args '{\\"name\\":\\"Floor\\"}'
    cmd          --args "{""name"":""Floor""}"
  Or skip it: --args-file <file>, or --args-file - to read stdin.

Common options (before or after the subcommand):
  --json                    Emit one JSON object on stdout; diagnostics stderr
  --config <path>           Use a specific CLI config file
  --lang zh-CN|en-US        Language for help and CLI-generated messages
  --timeout <seconds>       Deadline for the whole command, default 120
  -h, --help                Show this
  -v, --version             Show the version`

const EN_DETAIL = `Command options:
  setup       --host-config <path>  The box's config file (required, no TTY)
  doctor      --project <path>      Also check this project can be targeted
  tools list  --search <text>       Filter by name or description
  tools call  --args <JSON>         Arguments
              --args-file <path>    Read arguments from a file; - means stdin
              --project <path>      Target project; .uproject or its directory
  actors list --name <text>         Exact Name/Label match; omit to scan level
              --limit <n>           Max results, 1-1000, default 50
              --include-system      Also count engine bookkeeping actors
  viewport screenshot
              --output <path>       Required, .png only, relative to cwd
              --world auto|editor   Default auto: captures PIE when running
              --overwrite           Allow overwriting an existing file
  write cmds  --allow-write         Confirm this command may change the project
              --asset <text>        What to spawn: alias, /Game/ path or class
              --location x,y,z      Location in cm; z=200 sets one component
              --rotation p,y,r      Rotation in degrees; yaw=90 also works
              --scale x,y,z         Scale multipliers; x=2 also works

About writes:
  One rule: whatever the box's own assistant can use, this can call with
  --allow-write. Namespace plays no part, so the asset library, the project
  library and library-to-project import are all in. Two things stay out:
  tools needing per-call human approval, and the local file / shell tools the
  box never exposes. See

  --allow-write is not a redundant switch. The box's "also expose mutating
  tools" setting is meant for clients that have an approval dialog; the CLI
  has none, and this flag stands in for it. With that box setting off, write
  tools are not in the catalog at all — uebox doctor says so.

  Two paths, different strength of proof:
    actors spawn/move/delete/undo   CLI reads back and fails on disagreement
    tools call <any tool>           Forwarded as-is; trust the tool's own reply

  Never blind-retry after a timeout. The reinforced path hands you a read-back
  command; tools call can only tell you where to look.

The target project is decided in this order:
  1. Whatever --project names
  2. The nearest .uproject walking up from the current directory
  3. Only if neither applies: the one project online, when there is exactly one

  A project from step 1 or 2 that is not connected fails the command; it is
  never redirected to a different online project.

Before you trust the output:
  actors list   Engine bookkeeping actors (HLOD, navmesh, physics volumes) are
                excluded by default; warnings report the real total and any
                --limit truncation. A null totalCount means "not reported".
  screenshot    PNG format and size are verified before the file lands; a failed
                check exits non-zero. This path renders its own frame, about a
                stop darker than the viewport, so do not judge exposure from it.`

const EN_TAIL = `Exit codes:
  0     ok
  2     fix the arguments or the output location
  3     config or auth
  4     box unreachable, or incompatible version
  5     no single target project
  6     tool out of scope, or --allow-write missing
  7     timeout. The request may have reached the engine; verify before retry
  8     engine operation failed, or the file was not delivered
  130   interrupted. Does not mean the engine rolled anything back

  1 is never returned. Seeing 1 means the process died before the CLI ran.

Without --allow-write the CLI calls read-only tools only. Requires Unreal Box
running (its service is on by default unless you turned it off). Engine
commands also need the target editor open with the plugin connected; listing
tools does not.`

const EN_MORE = `More — per-command options, the full write rules, how the target
project is decided, and which numbers not to trust: uebox --help --all`

export interface HelpOptions {
  /** 连参考性的几段一起给（`--help --all`） */
  all?: boolean
}

export function helpText(lang: Lang, options: HelpOptions = {}): string {
  const parts =
    lang === 'en-US'
      ? { core: EN_CORE, detail: EN_DETAIL, tail: EN_TAIL, more: EN_MORE }
      : { core: ZH_CORE, detail: ZH_DETAIL, tail: ZH_TAIL, more: ZH_MORE }

  return [parts.core, options.all ? parts.detail : parts.more, parts.tail].join('\n\n')
}
