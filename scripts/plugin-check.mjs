#!/usr/bin/env node
/**
 * 检查插件分发包的新鲜度 —— 只做验证，不编译、不出包。
 *
 * 这套检查原先长在 build-plugin.mjs 里（`--check`）。拆出来是为了职责分开：
 * 出包要编译、要装着 Unreal，检查只读已有的 zip，不碰引擎。
 *
 * 这里只放检查流程；「包里该是什么样」的格式约定（支持版本、排除规则、
 * zip 命名、构建标记、源码指纹）在 scripts/plugin-package-format.mjs。
 *
 * `pnpm plugin:check` 比对源码指纹和 zip 里的 `.ual-build`。检查范围内的包
 * 过期、缺少可读标记或根本不存在都会失败。
 *
 * 检查范围必须显式选择，两档都不依赖本机有没有安装引擎：
 *   · `--engine <版本>` 只检查选中的包，不枚举其他包
 *   · `--all`（出正式安装包时跑）要求磁盘上**每个**包都新鲜，一个都不许旧，
 *     且必须覆盖 UE 5.0–5.8。
 * 日常就要求全套是不现实的，但发版时少一个版本，
 * 那个版本的用户就实实在在拿到旧插件 —— 所以那一档不留余地。
 *
 * 用法：
 *   node scripts/plugin-check.mjs --engine 5.7     # 只检查指定包，不需要引擎
 *   node scripts/plugin-check.mjs --all            # 发版：每个版本都要新鲜
 */

import { createRequire } from 'node:module'
import { existsSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  DIST_DIR,
  RELEASE_ENGINES,
  SOURCE_DIR,
  STAMP_FILE,
  findExcludedEntries,
  sourceFingerprint,
  zipNameForEngine
} from './plugin-package-format.mjs'

const ROOT = resolve(import.meta.dirname, '..')

/**
 * 读一个 zip 里的构建标记。
 *
 * 缺少标记、ZIP 无法读取或标记不是有效 JSON 时返回 null。
 * 检查器会拒绝这些包，不把「无法判断」当成新鲜。
 */
function readStamp(zipPath) {
  try {
    const AdmZip = createRequire(import.meta.url)('adm-zip')
    const entry = new AdmZip(zipPath).getEntry(STAMP_FILE)
    if (!entry) return null
    return JSON.parse(entry.getData().toString('utf8'))
  } catch {
    return null
  }
}

function macPackageHasBinary(zipPath) {
  const AdmZip = createRequire(import.meta.url)('adm-zip')
  return new AdmZip(zipPath).getEntry('Binaries/Mac/UnrealEditor-UnrealAgentLink.dylib') != null
}

/**
 * 日常入口：只检查所选版本的那一个包，不枚举、不打开其他包。
 * 缺包、读不了、过期、混进不该带的文件都失败，不会拿别的版本顶替。
 */
export function checkSelectedPackage(fingerprint, engine, distDir = DIST_DIR, platform = 'win32') {
  const name = zipNameForEngine(engine, platform)
  return checkPackages(fingerprint, distDir, platform, {
    required: new Map([[name, engine]]),
    zips: existsSync(join(distDir, name)) ? [name] : [],
    rebuildHint: `  出包：pnpm plugin:build --engine ${engine} --project <uproject>`,
    success: `\n✓ UE ${engine} 的分发包是最新的，也没有多余文件`
  })
}

/**
 * 发版入口：完整版本集，与个人开发目标、Git 范围和本机引擎安装无关。
 * 枚举当前平台的全部 ZIP，RELEASE_ENGINES 的必需包一个都不能少。
 */
export function checkReleasePackages(fingerprint, distDir = DIST_DIR, platform = 'win32') {
  const zips = existsSync(distDir)
    ? readdirSync(distDir)
        .filter(
          (f) =>
            f.endsWith('.zip') &&
            (platform === 'darwin' ? f.endsWith('-Mac.zip') : !f.endsWith('-Mac.zip'))
        )
        .sort()
    : []

  // 发版时一个包都没有，不能当成「没发现问题」—— 那是没东西可发
  if (zips.length === 0) {
    console.log(`插件源码指纹：${fingerprint}\n`)
    console.error(`\n✖ ${distDir} 下一个分发包都没有，发版没东西可带。`)
    console.error('  出全套：node scripts/build-all-plugins.mjs')
    return false
  }

  return checkPackages(fingerprint, distDir, platform, {
    required: new Map(
      RELEASE_ENGINES.map((engine) => [zipNameForEngine(engine, platform), engine])
    ),
    zips,
    rebuildHint: '  发版要求每个版本都新鲜，出全套：node scripts/build-all-plugins.mjs',
    success: `\n✓ ${zips.length} 个分发包全部是最新的，也没有多余文件 —— 可以发版`
  })
}

/**
 * 分发包和当前源码对不对得上。返回 true 表示通过。两类失败：
 *   · 要求新鲜的包不新鲜（过期／没有标记／根本不存在）——「用户装到旧的」
 *   · 检查范围内的包混进了不该带的文件 —— 和新旧无关
 */
function checkPackages(fingerprint, distDir, platform, { required, zips, rebuildHint, success }) {
  console.log(`插件源码指纹：${fingerprint}\n`)

  const blocking = []
  const polluted = []

  for (const name of zips) {
    // 先看有没有混进不该带的文件。
    //
    // 这一条独立于「新不新」：包可能指纹对得上、但仍然带着 16MB 的调试符号
    // —— 真实发生过，而且是别人用 `git add .` 把坏包一起提交进来的。
    // 所以检查本次范围内的所有 zip。
    const leaked = findExcludedEntries(join(distDir, name))
    if (leaked.length > 0) {
      polluted.push({ name, leaked })
    }

    const stamp = readStamp(join(distDir, name))

    if (!stamp?.fingerprint) {
      const reason = '构建标记缺失、无效或无法读取 / Missing, invalid or unreadable build stamp'
      blocking.push({ name, reason })
      console.log(`  ${name.padEnd(28)} ${reason}`)
      continue
    }

    const expectedEngine = required.get(name)
    const engineMatches = !expectedEngine || stamp.engine === expectedEngine
    const nativeMatches =
      platform !== 'darwin' ||
      (stamp.platform === 'Mac' && macPackageHasBinary(join(distDir, name)))
    const ok = stamp.fingerprint === fingerprint && engineMatches && nativeMatches
    if (!ok) {
      blocking.push({
        name,
        reason: !nativeMatches
          ? 'Mac 包缺少平台标记或 dylib'
          : engineMatches
            ? `指纹是 ${stamp.fingerprint}，源码已经变了`
            : `包名对应 UE ${expectedEngine}，构建标记却是 ${stamp.engine}`
      })
    }
    console.log(
      `  ${name.padEnd(28)} ${ok ? '最新' : '已过期'}  ${stamp.fingerprint}  ${stamp.builtAt ?? ''}`
    )
  }

  for (const [name, engine] of required) {
    if (zips.includes(name)) continue
    blocking.push({
      name,
      reason: `分发包不存在（UE ${engine}）—— 出一个：pnpm plugin:build --engine ${engine} --project <uproject>`
    })
  }

  if (polluted.length > 0) {
    console.error(`\n✖ ${polluted.length} 个分发包里混进了不该带的文件：`)
    for (const { name, leaked } of polluted) {
      console.error(`  ${name}：${leaked.length} 个，例如 ${leaked[0]}`)
    }
    console.error('\n  .pdb 是调试符号，一个就 16MB —— 用户装插件用不到它。')
    console.error(rebuildHint)
    return false
  }

  if (blocking.length > 0) {
    console.error(`\n✖ ${blocking.length} 个分发包不合格：`)
    for (const { name, reason } of blocking) {
      console.error(`  ${name}：${reason}`)
    }
    console.error('\n  改了插件源码就要重新出包，否则用户装到的还是旧的。')
    console.error(rebuildHint)
    return false
  }

  console.log(success)
  return true
}

const HELP = `用法 / Usage:
  pnpm plugin:check --engine 5.7   检查指定包 / Inspect the selected package
  pnpm plugin:check --all          发版检查 / Release check (UE 5.0–5.8)
  pnpm plugin:check:all            同上 / Same as --all

必须且只能选择 --engine <version> 或 --all；支持 UE 5.0–5.8，没有默认版本。
Select exactly one of --engine <version> and --all; supported: UE 5.0–5.8, no default.
单目标只读指定平台的那一个包，不需要安装 Unreal；缺包不会拿别的版本顶替。
Single-target inspection reads only the selected package and needs no Unreal installation.
发版检查要求全套包，外加同平台的其他 ZIP 也都通过。
The release check requires the complete set, and every other ZIP for the platform must pass.`

/** 这个脚本本身就是检查模式，必须且只能选一个范围。 */
function parseCheckOptions(args) {
  const { values } = parseArgs({
    args,
    options: {
      engine: { type: 'string' },
      all: { type: 'boolean' },
      help: { type: 'boolean' }
    },
    strict: true,
    allowPositionals: false
  })
  const hasEngine = values.engine !== undefined
  if (hasEngine && !RELEASE_ENGINES.includes(values.engine)) {
    throw new Error(`不支持的版本 / Unsupported engine: ${values.engine} (UE 5.0–5.8)`)
  }
  if ((hasEngine && values.all) || (!hasEngine && !values.all && !values.help)) {
    throw new Error('检查必须且只能选择一个 / Select exactly one: --engine <version> or --all')
  }
  return values
}

/** 只检查已有分发包，不编译不出包。 */
function main() {
  let checkOptions
  try {
    checkOptions = parseCheckOptions(process.argv.slice(2))
  } catch (error) {
    console.error(`✖ ${error.message}`)
    console.error('用法 / Usage: pnpm plugin:check --engine <version> | --all')
    process.exit(1)
  }
  if (checkOptions.help) {
    console.log(HELP)
    return
  }

  // 源码现在跟着本仓库走，检出里一定有。缺了说明工作区被破坏了，
  // 那是个要人看一眼的问题，不该静默继续。
  if (!existsSync(join(SOURCE_DIR, 'UnrealAgentLink.uplugin'))) {
    console.error(`
✖ 找不到插件源码：${relative(ROOT, SOURCE_DIR)}`)
    console.error('  它现在是本仓库的一部分（见根目录 .gitignore 里那段说明）。')
    console.error('  用 git 还原：git checkout -- plugin/')
    process.exit(1)
  }

  const fingerprint = sourceFingerprint()
  const ok = checkOptions.all
    ? checkReleasePackages(fingerprint, DIST_DIR, process.platform)
    : checkSelectedPackage(fingerprint, checkOptions.engine, DIST_DIR, process.platform)
  process.exit(ok ? 0 : 1)
}

// 被 import 时（测试）不执行主流程
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop())) {
  main()
}
