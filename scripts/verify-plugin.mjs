/**
 * 日常门禁的插件包检查：只在这次改动碰到打包输入时才查，查的是显式选定的那一个版本。
 *
 *   pnpm verify:plugin --engine 5.7
 *   $env:VERIFY_PLUGIN_ENGINE = '5.7'; pnpm verify:changed
 *
 * 先算改动范围再读目标：无关改动不读 VERIFY_PLUGIN_ENGINE、不开 zip、不探测引擎。
 *
 * 「打包输入」就是参与源码指纹的文件（plugin-package-format.mjs 的
 * isFingerprintedPath）。出包脚本和 LICENSE 也会影响包的内容，但构建标记只记
 * 源码指纹、不记脚本哈希，这里证明不了它们改完之后重新出过包，硬查只会卡住
 * 没装 Unreal 的人 —— 它们靠单测和发版前的全量重出（plugin:check:all）兜底。
 *
 * 仓库 CI 不跑这一步（verify.mjs 里的 localOnly）：runner 上没有 Unreal，也没有包。
 */
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { installedEngines } from './build-plugin.mjs'
import { RELEASE_ENGINES, isFingerprintedPath } from './plugin-package-format.mjs'
import { resolveChangeScope } from './verify-change-scope.mjs'

/**
 * 本机没装 Unreal、出不了包时的显式声明。
 *
 * 分发包不进 git，发版会重出全套再过 plugin:check:all，所以本地包新鲜与否
 * 只关系到开发者自己拿什么去测。出不了包的人既不可能「忘了出包」，也测不了插件，
 * 让这一步永远红只会教人无视门禁。
 *
 * 但声明要可信：本机探测到了受支持的引擎，就不接受 none —— 能出包就得出包。
 * 探测只用来拒绝 none、从不用来放行，所以探测出错最多多一次误报，不会漏掉
 * 真正的「忘了出包」。
 */
const NO_UNREAL = 'none'

const TARGET_HINT = [
  "  PowerShell: $env:VERIFY_PLUGIN_ENGINE = '5.7'",
  '  bash:       export VERIFY_PLUGIN_ENGINE=5.7',
  '  一次覆盖 / One-off: pnpm verify:plugin --engine 5.7'
]

/** 列出来的文件不是你改的？多半是比较基准落后了（fork 的 main 没同步最常见） */
const BASE_HINT = [
  '  上面的文件不是你改的？比较基准可能落后了：fork 的 main 先同步上游，或设 VERIFY_BASE=<目标分支>。',
  "  Not your files? The comparison base may be behind: sync your fork's main, or set VERIFY_BASE=<target branch>."
]

const HELP = `用法 / Usage:
  pnpm verify:plugin [--engine <version>|none]

只有改动碰到插件打包输入时，才检查所选开发版本的分发包。
Inspects the selected development package only when packaged plugin inputs changed.

  --engine <version>  覆盖 VERIFY_PLUGIN_ENGINE，仅本次有效 / Override VERIFY_PLUGIN_ENGINE once
  --help              显示帮助 / Show this help

适用时必须给出 UE 5.0–5.8 的显式目标 / When applicable, set an explicit UE 5.0–5.8 target:
${TARGET_HINT.join('\n')}

本机没装 Unreal、出不了包时声明 none：这一步报 NOT RUN 并放行，PR 里注明插件改动未经编译。
本机探测到引擎时不接受 none。
Without Unreal on this machine, declare none: the step reports NOT RUN and passes; state in the
PR that the plugin change was not compiled. none is rejected when an engine is installed.`

function defaultInspect(engine, { cwd, env }) {
  const result = spawnSync(
    process.execPath,
    [...process.execArgv, join(import.meta.dirname, 'plugin-check.mjs'), '--engine', engine],
    { cwd, env, encoding: 'utf8', windowsHide: true }
  )
  return {
    status: typeof result.status === 'number' ? result.status : 1,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`
  }
}

function defaultDetectEngines() {
  return [...installedEngines().keys()].filter((engine) => RELEASE_ENGINES.includes(engine)).sort()
}

const isTarget = (value) => value === NO_UNREAL || RELEASE_ENGINES.includes(value)

export function runVerifyPlugin({
  argv = [],
  env = process.env,
  cwd = process.cwd(),
  inspect = defaultInspect,
  detectEngines = defaultDetectEngines
} = {}) {
  let options
  try {
    options = parseArgs({
      args: argv,
      options: { engine: { type: 'string' }, help: { type: 'boolean' } },
      strict: true,
      allowPositionals: false
    }).values
  } catch (error) {
    return {
      status: 1,
      output: `✖ ${error.message}\n用法 / Usage: pnpm verify:plugin [--engine <version>|none]`
    }
  }
  if (options.help) return { status: 0, output: HELP }
  if (options.engine !== undefined && !isTarget(options.engine)) {
    return {
      status: 1,
      output: `✖ 不支持的版本 / Unsupported engine: ${options.engine} (UE 5.0–5.8, or ${NO_UNREAL})`
    }
  }

  let scope
  try {
    scope = resolveChangeScope({ cwd, env })
  } catch (error) {
    return { status: 1, output: `✖ ${error.message}` }
  }

  const changed = scope.paths.filter(isFingerprintedPath)
  if (changed.length === 0) {
    return {
      status: 0,
      output: `Plugin package check: not applicable（相对 ${scope.label} 没有改到插件打包输入）`
    }
  }

  const report = (status, lines) => ({
    status,
    output: [
      `插件打包输入有改动（相对 ${scope.label}）/ Packaged plugin inputs changed (vs ${scope.label}):`,
      ...changed.map((path) => `  ${path}`),
      ...lines,
      ...(status === 0 ? [] : BASE_HINT)
    ].join('\n')
  })

  const target = (options.engine ?? String(env.VERIFY_PLUGIN_ENGINE ?? '')).trim()

  if (target === NO_UNREAL) {
    const engines = detectEngines()
    if (engines.length > 0) {
      return report(1, [
        `✖ 声明了 ${NO_UNREAL}，但本机装了 UE ${engines.join('、')}：能出包就要出包。`,
        `  Declared ${NO_UNREAL}, but Unreal ${engines.join(', ')} is installed: build and check the package.`,
        `  pnpm plugin:build --engine ${engines.at(-1)} --project <uproject>`,
        ...TARGET_HINT.map((line) => line.replaceAll('5.7', engines.at(-1)))
      ])
    }
    return report(0, [
      'Plugin package check: NOT RUN (declared: no Unreal on this machine)',
      '  在 PR 里注明插件改动未经编译，交给装了 Unreal 的维护者出包验证。',
      '  State in the PR that the plugin change was not compiled.'
    ])
  }

  if (!isTarget(target)) {
    return report(1, [
      '✖ 改了插件打包输入，需要显式选择开发目标（UE 5.0–5.8）。',
      '  Packaged plugin inputs changed: select an explicit development target (UE 5.0–5.8).',
      ...(target ? [`  当前配置不受支持 / Unsupported value: '${target}'`] : []),
      ...TARGET_HINT,
      `  本机没装 Unreal / No Unreal on this machine: VERIFY_PLUGIN_ENGINE=${NO_UNREAL}`
    ])
  }

  const inspection = inspect(target, { cwd, env })
  return report(inspection.status, [
    inspection.output.trimEnd(),
    `Plugin package check: ${inspection.status === 0 ? 'passed' : 'failed'} (UE ${target})`,
    // 包检查通过只说明 zip 和源码对得上，不代表编得过、在编辑器里跑得通
    'Native build/runtime: NOT RUN'
  ])
}

function main() {
  const { status, output } = runVerifyPlugin({ argv: process.argv.slice(2) })
  console.log(output)
  process.exit(status)
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop())) {
  main()
}
