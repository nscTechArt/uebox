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
 * 3. **陈述行为，不论证行为。** 「为什么这么设计」属于源码注释；
 *    帮助里只说它会怎么做。
 * 4. **例子必须是能照抄的。** 尤其 `--args`：PowerShell 5.1 和 cmd 会吃掉
 *    裸 JSON 里的引号（实测：`'{"k":"v"}'` 到进程里变成 `{k:v}`），
 *    所以这里给的是两个 shell 各自验证过的转义形式。
 *
 * ## 只有一层
 *
 * 以前分 `--help` 和 `--help --all` 两层，因为包装命令各带一串专属选项，
 * 全摆出来一百多行。包装命令删掉之后选项只剩十来个，一屏放得下，
 * 分层反而让人多猜一次「是不是还有没看到的」。
 */

export type Lang = 'zh-CN' | 'en-US'

const ZH = `虚幻盒子 CLI —— 从终端调用虚幻引擎能力

用法：
  uebox <命令> [选项]

  虚幻盒子开着就能直接用；连不上就跑 uebox doctor。

命令：
  ask "<要做的事>"          把一件事交给盒子的 Agent 做完，拿回结论
  doctor                    逐层体检：连接、接口契约、工具范围、工程注册
  projects list             列出已注册且在线的 UE 工程
  tools list                列出能调用的工具（加 --allow-write 连写工具一起列）
  tools show <name>         某个工具的完整描述和参数定义
  tools call <name>         调用一个工具
  viewport screenshot       把视口画面存成 PNG 文件

示例：
  uebox ask "列出当前关卡里所有点光源和它们的强度"
  uebox ask "把所有点光源的强度调低一半" --allow-write
  uebox doctor
  uebox tools list --search actor
  uebox tools call ue_get_selection
  uebox tools call search_assets --args-file args.json
  uebox tools call ue_set_transform --args-file move.json --allow-write
  uebox viewport screenshot --output shot.png --overwrite

  --args 里直接写 JSON 要按所在 shell 转义，裸 JSON 两边都会被吃掉引号：
    PowerShell   --args '{\\"name\\":\\"Floor\\"}'
    cmd          --args "{""name"":""Floor""}"
  嫌绕就用 --args-file <文件>，或 --args-file - 从标准输入读。

选项（写在命令前面或后面都行）：
  --json                    stdout 只输出一个 JSON 对象；诊断走 stderr
  --project <path>          目标工程，.uproject 文件或其所在目录都行
  --allow-write             允许这条命令改动工程
  --search <text>           tools list 按名字或描述筛选
  --args <JSON>             tools call 的参数
  --args-file <path>        从文件读参数；写 - 表示从标准输入读
  --name <tool>             工具名，位置参数不好传时用
  --output <path>           截图存到哪，只接受 .png，相对路径按当前目录算
  --world auto|editor       截图拍哪个世界，默认 auto：PIE 在跑就拍游戏
  --overwrite               截图允许覆盖已存在的文件
  --config <path>           盒子的配置文件，装在别处时用；或设 UEBOX_HOST_CONFIG
  --timeout <seconds>       整条命令的期限，默认 120
  --lang zh-CN|en-US        帮助与提示用哪种语言
  -h, --help                看这段
  -v, --version             看版本号

ask：
  用的是盒子里配置的模型，费用记在那个模型的账上。子任务只碰引擎、
  素材库和工程库；shell、本地文件、浏览器、第三方 MCP 一律不给。
  不加 --allow-write 时它只能查，不能改。进度打在 stderr 上；
  --timeout 对它算的是多久没有任何进度，不是总时长。

写操作：
  不加 --allow-write 只调只读工具。加了之后，盒子自己的 AI 助手能用的工具
  这里都能调，要求逐次人工审批的除外。
  超时不要直接重发：请求可能已经生效，先用只读工具查清楚再决定。
  撤销用 tools call ue_undo --allow-write，args 一定带 {"steps":1}，
  不带 steps 会把整条栈全撤；编辑器里按 Ctrl+Z 碰不到这一步。

目标工程按这个顺序定：--project，从当前目录往上最近的 .uproject，
恰好只有一个工程在线时用它。前两步定出的工程没连着就直接失败。

截图的明暗只在场景锁了手动曝光时可信，看 data.exposure；自动曝光时先锁再判断。

退出码：
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

需要虚幻盒子正在运行（对外服务默认开着，除非你在设置里关过）。
引擎类命令还要求目标 UE 编辑器已打开并完成插件握手；列工具不要求。`

const EN = `Unreal Box CLI — drive Unreal Engine from your terminal

Usage:
  uebox <command> [options]

  Works while Unreal Box is running; run uebox doctor when it can't connect.

Commands:
  ask "<task>"              Hand a task to the box's own agent, get the result
  doctor                    Layered check: connection, contract, scope, projects
  projects list             List registered, online UE projects
  tools list                List callable tools (--allow-write adds writers)
  tools show <name>         Full description and input schema for one tool
  tools call <name>         Call one tool
  viewport screenshot       Save the viewport image to a PNG file

Examples:
  uebox ask "list every point light in the level with its intensity"
  uebox ask "halve the intensity of every point light" --allow-write
  uebox doctor
  uebox tools list --search actor
  uebox tools call ue_get_selection
  uebox tools call search_assets --args-file args.json
  uebox tools call ue_set_transform --args-file move.json --allow-write
  uebox viewport screenshot --output shot.png --overwrite

  Inline JSON in --args must be escaped for your shell; both eat bare quotes:
    PowerShell   --args '{\\"name\\":\\"Floor\\"}'
    cmd          --args "{""name"":""Floor""}"
  Or skip it: --args-file <file>, or --args-file - to read stdin.

Options (before or after the command):
  --json                    Emit one JSON object on stdout; diagnostics stderr
  --project <path>          Target project; .uproject or its directory
  --allow-write             Let this command change the project
  --search <text>           tools list: filter by name or description
  --args <JSON>             tools call: arguments
  --args-file <path>        Read arguments from a file; - means stdin
  --name <tool>             Tool name, when a positional is awkward to pass
  --output <path>           Screenshot file, .png only, relative to cwd
  --world auto|editor       Which world to capture; auto captures PIE if running
  --overwrite               Let the screenshot replace an existing file
  --config <path>           The box's config file if installed elsewhere;
                            or set UEBOX_HOST_CONFIG
  --timeout <seconds>       Deadline for the whole command, default 120
  --lang zh-CN|en-US        Language for help and CLI-generated messages
  -h, --help                Show this
  -v, --version             Show the version

ask:
  Runs on the model configured in the box, billed to that model. The subtask
  only touches the engine and the asset and project libraries; shell, local
  files, browser and third-party MCP are never given. Without --allow-write it
  can look but not change. Progress goes to stderr; for ask, --timeout means
  how long without any progress, not total time.

Writes:
  Without --allow-write only read-only tools are called. With it, anything the
  box's own assistant can use is callable, except tools needing per-call
  human approval.
  Never blind-retry after a timeout: it may have taken effect; check first.
  Undo with tools call ue_undo --allow-write and args {"steps":1};
  without steps it undoes the whole stack. Editor Ctrl+Z won't reach it.

The target project is: --project, else the nearest .uproject above the current
directory, else the one online project if there is exactly one. A project from
the first two that is not connected fails the command.

Screenshot brightness is only reliable when the scene uses manual exposure;
check data.exposure, and lock it before judging exposure.

Exit codes:
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

Requires Unreal Box running (its service is on by default unless you turned it
off). Engine commands also need the target editor open with the plugin
connected; listing tools does not.`

export function helpText(lang: Lang): string {
  return lang === 'en-US' ? EN : ZH
}
