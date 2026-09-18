/**
 * 命令行解析。
 *
 * 用 Node 自带的 `util.parseArgs`，不引第三方框架：这套命令只有六条、
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
  /** `--help --all`：连参考性的几段一起给 */
  all: boolean
  version: boolean
  lang?: 'zh-CN' | 'en-US'
  configPath?: string
  hostConfigPath?: string
  project?: string
  timeoutSeconds?: number
  search?: string
  args?: string
  argsFile?: string
  limit?: number
  name?: string
  output?: string
  world?: 'auto' | 'editor'
  overwrite: boolean
  includeSystem: boolean
  /** 这次允许调用会改动工程的工具。CLI 没有审批弹窗，这个开关顶替它 */
  allowWrite: boolean
  /** `actors spawn` 生成什么：别名、资产路径或类名 */
  asset?: string
  location?: string
  rotation?: string
  scale?: string
}

const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  all: { type: 'boolean' },
  version: { type: 'boolean', short: 'v' },
  json: { type: 'boolean' },
  lang: { type: 'string' },
  config: { type: 'string' },
  'host-config': { type: 'string' },
  project: { type: 'string' },
  timeout: { type: 'string' },
  search: { type: 'string' },
  args: { type: 'string' },
  'args-file': { type: 'string' },
  limit: { type: 'string' },
  name: { type: 'string' },
  output: { type: 'string' },
  world: { type: 'string' },
  overwrite: { type: 'boolean' },
  'include-system': { type: 'boolean' },
  'allow-write': { type: 'boolean' },
  asset: { type: 'string' },
  location: { type: 'string' },
  rotation: { type: 'string' },
  scale: { type: 'string' }
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
    all: values.all === true,
    version: values.version === true,
    ...(values.lang ? { lang: parseLang(values.lang) } : {}),
    ...(values.config ? { configPath: values.config } : {}),
    ...(values['host-config'] ? { hostConfigPath: values['host-config'] } : {}),
    ...(values.project ? { project: values.project } : {}),
    ...(values.timeout ? { timeoutSeconds: parseTimeout(values.timeout) } : {}),
    ...(values.search ? { search: values.search } : {}),
    ...(values.args !== undefined ? { args: values.args } : {}),
    ...(values['args-file'] !== undefined ? { argsFile: values['args-file'] } : {}),
    ...(values.limit !== undefined ? { limit: parseLimit(values.limit) } : {}),
    ...(values.name !== undefined ? { name: values.name } : {}),
    ...(values.output ? { output: values.output } : {}),
    ...(values.world ? { world: parseWorld(values.world) } : {}),
    overwrite: values.overwrite === true,
    includeSystem: values['include-system'] === true,
    allowWrite: values['allow-write'] === true,
    ...(values.asset !== undefined ? { asset: values.asset } : {}),
    ...(values.location !== undefined ? { location: values.location } : {}),
    ...(values.rotation !== undefined ? { rotation: values.rotation } : {}),
    ...(values.scale !== undefined ? { scale: values.scale } : {})
  }
}

/**
 * `--location 0,0,200` 这类三元组。
 *
 * 也接受只给一部分：`--location z=200` 表示「只设 Z，X/Y 保持原样」。
 * 这不是顺手加的便利 —— 三个分量全给才能设一个的话，用户就得先查一次
 * 当前坐标再原样填回去，而那两个填回去的数正是最容易抄错的东西。
 */
export function parseVector(
  raw: string,
  keys: readonly string[],
  option: string
): Record<string, number> {
  const out: Record<string, number> = {}

  // 具名形式：z=200 或 pitch=0,yaw=90
  if (raw.includes('=')) {
    for (const part of raw.split(',')) {
      const [key, value] = part.split('=').map((piece) => piece.trim())
      if (!key || value === undefined) {
        throw new UeboxError('INVALID_ARGUMENT', `${option} 里这一段写坏了：${part}`)
      }
      if (!keys.includes(key)) {
        throw new UeboxError(
          'INVALID_ARGUMENT',
          `${option} 不认识分量 ${key}，只支持 ${keys.join(' / ')}。`
        )
      }
      out[key] = finite(value, option)
    }
    if (Object.keys(out).length === 0) {
      throw new UeboxError('INVALID_ARGUMENT', `${option} 至少要给一个分量。`)
    }
    return out
  }

  // 位置形式：三个数按顺序
  const parts = raw.split(',').map((piece) => piece.trim())
  if (parts.length !== keys.length) {
    throw new UeboxError(
      'INVALID_ARGUMENT',
      `${option} 要 ${keys.length} 个数（${keys.join(',')}），收到 ${parts.length} 个：${raw}`,
      `只想设一个分量的话用具名形式，例如 ${option} ${keys[keys.length - 1]}=200。`
    )
  }
  keys.forEach((key, index) => {
    out[key] = finite(parts[index]!, option)
  })
  return out
}

function finite(value: string, option: string): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    throw new UeboxError('INVALID_ARGUMENT', `${option} 里 ${value} 不是一个数。`)
  }
  return parsed
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

/**
 * `--limit` 取 1–1000 的整数。
 *
 * 上限存在的理由不是性能，是**别让人以为自己拿到了全部**：给一个大得离谱的
 * 数字然后拿到 1000 条，很容易被当成「一共就这么多」。真实总数由
 * `totalCount` 说了算（§4）。
 */
function parseLimit(value: string): number {
  const limit = Number(value)
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new UeboxError('INVALID_ARGUMENT', `--limit 要是 1–1000 之间的整数，收到 ${value}。`)
  }
  return limit
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
