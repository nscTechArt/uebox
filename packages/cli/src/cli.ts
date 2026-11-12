/**
 * 命令分发。
 *
 * 这一层负责：解析参数 → 派给命令 → 把结果或异常变成一个信封 → 定退出码。
 * **所有出口都走这里**，所以「stdout 只有一个 JSON」和「错误码决定退出码」
 * 这两条约定不可能被某条命令漏掉。
 */

import { assertArgsInputExclusive, parse, type ParsedArgs } from './args.js'
import { runAsk } from './commands/ask.js'
import { runDoctor } from './commands/doctor.js'
import { runProjectsList } from './commands/projects.js'
import { runSkillsAdd } from './commands/skills.js'
import { runViewportScreenshot } from './commands/screenshot.js'
import {
  runTeamGate,
  runTeamHook,
  runTeamList,
  runTeamRound,
  runTeamStatus,
  runTeamUse
} from './commands/team.js'
import { runGuardHook } from './commands/teamGuard.js'
import { runToolsCall, runToolsList, runToolsShow } from './commands/tools.js'
import { failure, writeJson, type Envelope } from './envelope.js'
import { exitCodeFor, toUeboxError, UeboxError } from './errors.js'
import { helpText, type Lang } from './help.js'
import { markSettled } from './interrupt.js'
import { render } from './render.js'

export const VERSION = '0.1.0'

export interface RunResult {
  exitCode: number
  stdout: string
  stderr: string
}

/**
 * 跑一条命令。
 *
 * 不直接写 process.stdout —— 返回字符串，由 `index.ts` 落到真实的流上。
 * 这样测试能拿到完整输出并断言「stdout 能 JSON.parse」，而不用去劫持全局。
 */
export interface RunIO {
  /**
   * 长命令（`ask`）的进度往哪写。结果仍然只在最后交一次 —— 进度是给人看的，
   * 走 stderr，不碰 stdout 上那唯一一个 JSON。
   */
  progress?: (message: string) => void
  /** 读标准输入。`--hook` 时 Claude Code 把 hook 输入（JSON）从这里交进来 */
  readStdin?: () => Promise<string>
}

export async function run(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  io: RunIO = {}
): Promise<RunResult> {
  let parsed: ParsedArgs
  try {
    parsed = parse(argv)
  } catch (error) {
    // 连参数都没解析出来时还不知道用户要哪种语言/格式，按默认来
    return output(toEnvelope(error), false)
  }

  const lang: Lang = parsed.lang ?? 'zh-CN'

  // --help / --version 不读凭据、不连服务（§4）。
  //
  // 版本要判在最前面：`uebox --version` 没有位置参数，先判「有没有给命令」
  // 的话它会掉进用法错误那条路 —— 一条最常用的命令报退出码 2。
  if (parsed.version) {
    return { exitCode: 0, stdout: `${VERSION}\n`, stderr: '' }
  }

  // 光敲 `uebox` 等同于 `uebox --help`。这不是用法错误 —— 用户什么都没说错，
  // 他只是还没说要干什么，这时候该给他看清单，不是给他一个非零退出码。
  if (parsed.help || parsed.command.length === 0) {
    return { exitCode: 0, stdout: `${helpText(lang)}\n`, stderr: '' }
  }

  // hook 模式不出信封：Claude Code 只认它自己的约定（见 commands/team.ts）
  if (parsed.hook) return runHook(parsed, env, io)

  try {
    return output(await dispatch(parsed, env, io), parsed.json)
  } catch (error) {
    return output(toEnvelope(error), parsed.json)
  }
}

async function dispatch(parsed: ParsedArgs, env: NodeJS.ProcessEnv, io: RunIO): Promise<Envelope> {
  const [group, sub] = parsed.command
  const shared = {
    ...(parsed.configPath ? { configPath: parsed.configPath } : {}),
    ...(parsed.timeoutSeconds ? { timeoutSeconds: parsed.timeoutSeconds } : {}),
    env
  }

  switch (group) {
    case 'ask':
      // 位置参数全拼起来：`uebox ask 把灯调暗` 不加引号也能用
      return runAsk({
        ...shared,
        prompt: parsed.command.slice(1).join(' '),
        allowWrite: parsed.allowWrite,
        ...(parsed.project ? { project: parsed.project } : {}),
        ...(parsed.model ? { model: parsed.model } : {}),
        ...(io.progress ? { onProgress: io.progress } : {})
      })

    case 'doctor':
      requireNoSubcommand(parsed, 'doctor')
      return runDoctor({ ...shared, ...(parsed.project ? { project: parsed.project } : {}) })

    case 'projects':
      if (sub !== 'list') throw unknownCommand(['projects list'])
      return runProjectsList(shared)

    case 'tools':
      return dispatchTools(parsed, sub, shared, parsed.allowWrite)

    case 'viewport':
      if (sub !== 'screenshot') throw unknownCommand(['viewport screenshot'])
      if (!parsed.output) {
        // 这条命令交付的是文件，没有目标位置就无事可做 —— 与其挑一个默认
        // 路径把图丢在那儿让用户去找，不如让他说清楚
        throw new UeboxError(
          'INVALID_ARGUMENT',
          'viewport screenshot 需要 --output 指定保存到哪个 .png 文件。',
          '例如：uebox viewport screenshot --output .\\artifacts\\viewport.png'
        )
      }
      return runViewportScreenshot({
        ...shared,
        output: parsed.output,
        overwrite: parsed.overwrite,
        ...(parsed.project ? { project: parsed.project } : {}),
        ...(parsed.world ? { world: parsed.world } : {})
      })

    case 'team':
      return dispatchTeam(parsed, sub, shared)

    case 'skills':
      if (sub !== 'add') throw unknownCommand(['skills add <技能名或技能页地址>'])
      return runSkillsAdd({ ...shared, ref: parsed.command.slice(2).join(' ') })

    default:
      throw unknownCommand([
        'ask "<要做的事>"',
        'doctor',
        'projects list',
        'tools list',
        'tools show <name>',
        'tools call <name>',
        'viewport screenshot',
        'skills add <技能名或技能页地址>',
        'team list|status|use|gate|round'
      ])
  }
}

async function dispatchTeam(
  parsed: ParsedArgs,
  sub: string | undefined,
  shared: { configPath?: string; timeoutSeconds?: number; env: NodeJS.ProcessEnv }
): Promise<Envelope> {
  const teamId = parsed.command[2]
  // --project 在这里指「哪个目录的 .uebox/team.json」，默认当前目录
  const options = {
    ...shared,
    ...(teamId ? { teamId } : {}),
    ...(parsed.project ? { cwd: parsed.project } : {})
  }
  switch (sub) {
    case 'list':
      return runTeamList(shared)
    case 'status':
      return runTeamStatus(options)
    case 'use':
      return runTeamUse(options)
    case 'gate':
      return runTeamGate(options)
    case 'round':
      return runTeamRound(options)
    default:
      throw unknownCommand([
        'team list',
        'team status [id]',
        'team use <id>',
        'team gate [id]',
        'team round'
      ])
  }
}

/** `team gate|round|guard --hook`：永远退出码 0，只有拦的时候 stdout 有一个 hook JSON */
async function runHook(parsed: ParsedArgs, env: NodeJS.ProcessEnv, io: RunIO): Promise<RunResult> {
  const [group, sub] = parsed.command
  if (group !== 'team' || (sub !== 'gate' && sub !== 'round' && sub !== 'guard')) {
    return output(
      toEnvelope(
        new UeboxError('INVALID_ARGUMENT', '--hook 只用于 team gate、team round 和 team guard。')
      ),
      parsed.json
    )
  }
  const stdin = io.readStdin ? await io.readStdin().catch(() => '') : ''
  // 守卫只看这次要调的工具，不连盒子：每次工具调用前都跑，不能慢
  if (sub === 'guard') {
    markSettled()
    return { exitCode: 0, stdout: runGuardHook(stdin), stderr: '' }
  }
  const result = await runTeamHook(
    sub,
    {
      env,
      ...(parsed.configPath ? { configPath: parsed.configPath } : {}),
      ...(parsed.timeoutSeconds ? { timeoutSeconds: parsed.timeoutSeconds } : {}),
      ...(parsed.command[2] ? { teamId: parsed.command[2] } : {}),
      ...(parsed.project ? { cwd: parsed.project } : {})
    },
    stdin
  )
  markSettled()
  return { exitCode: 0, ...result }
}

async function dispatchTools(
  parsed: ParsedArgs,
  sub: string | undefined,
  shared: { configPath?: string; timeoutSeconds?: number; env: NodeJS.ProcessEnv },
  allowWrite: boolean
): Promise<Envelope> {
  switch (sub) {
    case 'list':
      return runToolsList({
        ...shared,
        allowWrite,
        ...(parsed.search ? { search: parsed.search } : {})
      })

    case 'show': {
      const name = requireToolName(parsed, 'tools show')
      return runToolsShow({ ...shared, name })
    }

    case 'call': {
      const name = requireToolName(parsed, 'tools call')
      assertArgsInputExclusive(parsed)
      return runToolsCall({
        ...shared,
        name,
        allowWrite,
        ...(parsed.args !== undefined ? { args: parsed.args } : {}),
        ...(parsed.argsFile !== undefined ? { argsFile: parsed.argsFile } : {}),
        ...(parsed.project ? { project: parsed.project } : {})
      })
    }

    default:
      throw unknownCommand(['tools list', 'tools show <name>', 'tools call <name>'])
  }
}

/** 工具名走位置参数，也接受 `--name`（有些 shell 里位置参数不好传） */
function requireToolName(parsed: ParsedArgs, command: string): string {
  const name = parsed.command[2] ?? parsed.name
  if (!name) {
    throw new UeboxError(
      'INVALID_ARGUMENT',
      `${command} 需要一个工具名。`,
      '运行 uebox tools list 看有哪些可用。'
    )
  }
  return name
}

function requireNoSubcommand(parsed: ParsedArgs, command: string): void {
  if (parsed.command.length > 1) {
    throw new UeboxError('INVALID_ARGUMENT', `${command} 不接受子命令：${parsed.command[1]}`)
  }
}

function unknownCommand(available: string[]): UeboxError {
  return new UeboxError(
    'INVALID_ARGUMENT',
    '不认识这条命令。',
    `可用的命令：${available.join('、')}。完整说明见 uebox --help。`
  )
}

function toEnvelope(error: unknown): Envelope {
  const failed = toUeboxError(error)
  return failure({
    code: failed.code,
    message: failed.message,
    ...(failed.hint ? { hint: failed.hint } : {}),
    execution: failed.execution
  })
}

/**
 * 定输出和退出码。
 *
 * `--json` 时 stdout **只有**那一个 JSON 对象加换行，成功失败都一样。
 */
function output(envelope: Envelope, json: boolean): RunResult {
  const exitCode = envelope.ok ? 0 : exitCodeFor(envelope.error!.code)

  // 结果定下来了：此后再来的 Ctrl+C 不许把它改判成「结局不明」（见 interrupt.ts）
  markSettled()

  if (json) {
    return { exitCode, stdout: `${JSON.stringify(envelope)}\n`, stderr: '' }
  }

  const text = render(envelope)
  // 默认模式下失败信息走 stderr：`uebox projects list > out.txt` 之后
  // 用户还能在终端上看见出了什么事
  return envelope.ok
    ? { exitCode, stdout: `${text}\n`, stderr: '' }
    : { exitCode, stdout: '', stderr: `${text}\n` }
}

export { writeJson }
