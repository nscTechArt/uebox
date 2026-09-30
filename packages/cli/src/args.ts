/**
 * 命令行解析。
 *
 * 用 Node 自带的 `util.parseArgs`，不引第三方框架：这套命令只有七条、
 * 选项也就十来个，为它背一个依赖不划算，而 `parseArgs` 恰好支持
 * `allowPositionals` + 选项出现在位置参数前后都行 —— 那正是 §4 要的
 * 「公共选项允许出现在子命令前后」。
 *
 * **未知命令和未知选项立刻返回用法错误**，不做模糊匹配、不猜用户想干什么。
 * 猜错的代价是执行了一条他没打算执行的命令。
 */

import { parseArgs } from 'node:util'

import { UeboxError } from './errors.js'

export interface ParsedArgs {
  /** 例如 `['tools', 'list']` */
  command: string[]
  json: boolean
  help: boolean
  version: boolean
  lang?: 'zh-CN' | 'en-US'
  /** 盒子的配置文件（`mcp-server.json`），装在非常规位置时用 */
  configPath?: string
  project?: string
  timeoutSeconds?: number
  search?: string
  args?: string
  argsFile?: string
  name?: string
  output?: string
  world?: 'auto' | 'editor'
  overwrite: boolean
  /** 这次允许调用会改动工程的工具。CLI 没有审批弹窗，这个开关顶替它 */
  allowWrite: boolean
}

const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  json: { type: 'boolean' },
  lang: { type: 'string' },
  config: { type: 'string' },
  project: { type: 'string' },
  timeout: { type: 'string' },
  search: { type: 'string' },
  args: { type: 'string' },
  'args-file': { type: 'string' },
  name: { type: 'string' },
  output: { type: 'string' },
  world: { type: 'string' },
  overwrite: { type: 'boolean' },
  'allow-write': { type: 'boolean' }
} as const

export function parse(argv: string[]): ParsedArgs {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true })
  } catch (error) {
    throw new UeboxError(
      'INVALID_ARGUMENT',
      (error as Error).message,
      '运行 uebox --help 看可用的命令和选项。'
    )
  }

  const values = parsed.values

  return {
    command: parsed.positionals,
    json: values.json === true,
    help: values.help === true,
    version: values.version === true,
    ...(values.lang ? { lang: parseLang(values.lang) } : {}),
    ...(values.config ? { configPath: values.config } : {}),
    ...(values.project ? { project: values.project } : {}),
    ...(values.timeout ? { timeoutSeconds: parseTimeout(values.timeout) } : {}),
    ...(values.search ? { search: values.search } : {}),
    ...(values.args !== undefined ? { args: values.args } : {}),
    ...(values['args-file'] !== undefined ? { argsFile: values['args-file'] } : {}),
    ...(values.name !== undefined ? { name: values.name } : {}),
    ...(values.output ? { output: values.output } : {}),
    ...(values.world ? { world: parseWorld(values.world) } : {}),
    overwrite: values.overwrite === true,
    allowWrite: values['allow-write'] === true
  }
}

function parseLang(value: string): 'zh-CN' | 'en-US' {
  if (value === 'zh-CN' || value === 'en-US') return value
  throw new UeboxError('INVALID_ARGUMENT', `--lang 只支持 zh-CN 或 en-US，收到 ${value}。`)
}

function parseWorld(value: string): 'auto' | 'editor' {
  if (value === 'auto' || value === 'editor') return value
  throw new UeboxError('INVALID_ARGUMENT', `--world 只支持 auto 或 editor，收到 ${value}。`)
}

function parseTimeout(value: string): number {
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600) {
    throw new UeboxError('INVALID_ARGUMENT', `--timeout 要是 1–3600 之间的秒数，收到 ${value}。`)
  }
  return Math.floor(seconds)
}

/** 两种参数输入互斥，都不给等同于 `{}`（§4） */
export function assertArgsInputExclusive(parsed: ParsedArgs): void {
  if (parsed.args !== undefined && parsed.argsFile !== undefined) {
    throw new UeboxError(
      'INVALID_ARGUMENT',
      '--args 和 --args-file 只能给一个。',
      '复杂结构用 --args-file，可以躲开各种 shell 的引号差异。'
    )
  }
}
