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
 * `pnpm plugin:check` 拿源码指纹和每个 zip 里的 `.ual-build` 标记比对，对不上
 * 就退出非零。**它只在出过一次包之后才有意义** —— 老的 8 个 zip 是手工出的、
 * 里面没有标记，对这些它只会提示"未知"而不是报错，否则接进门禁的第一天
 * 就会全红。
 *
 * 新鲜度分两档，因为「日常写代码」和「把包发给用户」要求不一样：
 *   · `pnpm plugin:check`（`pnpm verify` 每次跑）只钉 VERIFY_ENGINES —— 开发时编的那个版本
 *   · `pnpm plugin:check:all`（出正式安装包时跑）要求磁盘上**每个**包都新鲜，一个都不许旧
 * 日常就要求全套是不现实的（见 VERIFY_ENGINES 的注释），但发版时少一个版本，
 * 那个版本的用户就实实在在拿到旧插件 —— 所以那一档不留余地。
 *
 * 用法：
 *   node scripts/plugin-check.mjs          # 日常：只看 5.5
 *   node scripts/plugin-check.mjs --all    # 发版：每个版本都要新鲜
 */

import { createRequire } from 'node:module'
import { existsSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { installedEngines } from './build-plugin.mjs'
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
 * 日常门禁（`pnpm verify`）只要求这些版本新鲜。
 *
 * 开发时编的是 5.5（见 `--only 5.5` 的用法）。要求每次改插件源码都把 5.0–5.8
 * 全重编一遍是不现实的：本机不一定装齐九个引擎，一轮下来接近一小时 ——
 * 门禁会长期全红，然后被当成背景噪音跳过，那和没有它没区别。
 *
 * 所以日常只钉 5.5，其余版本打印状态但不拦。**发版是另一回事**：
 * `--all` 要求磁盘上每个包都新鲜，因为那些包会原样发给用户。
 */
const VERIFY_ENGINES = Object.freeze(['5.5'])

/**
 * 读一个 zip 里的构建标记。
 *
 * 老的 8 个 zip 是手工出的、里面没有标记，返回 null —— 调用方要把「没有标记」
 * 和「标记对不上」区别对待，否则接进门禁的第一天就会全红，然后被人加白名单
 * 关掉，等于没做。
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
 * 分发包和当前源码对不对得上。
 *
 * 返回 true 表示通过。两类失败：
 *   · 要求新鲜的包不新鲜（过期／没有标记／根本不存在）——「用户装到旧的」
 *   · 任何一个包里混进了不该带的文件 —— 和新旧无关，见下面的注释
 *
 * `requiredEngines` 决定「要求谁新鲜」：
 *   · 一个版本数组（默认 VERIFY_ENGINES）—— 日常门禁，只钉这几个，其余只提示
 *   · `null` —— 发版门禁，磁盘上**每个**包都必须新鲜，一个都不许旧
 */
export function checkStaleness(
  fingerprint,
  distDir = DIST_DIR,
  requiredEngines = VERIFY_ENGINES,
  platform = 'win32',
  canBuildHere = installedEngines(undefined, undefined, platform).size > 0
) {
  console.log(`插件源码指纹：${fingerprint}\n`)

  // null = 发版模式：必须覆盖声明支持的全部版本，缺包同样是失败。
  const requireAll = requiredEngines === null
  const required = new Map(
    (requireAll ? RELEASE_ENGINES : requiredEngines).map((engine) => [
      zipNameForEngine(engine, platform),
      engine
    ])
  )
  const zips = existsSync(distDir)
    ? readdirSync(distDir)
        .filter(
          (f) =>
            f.endsWith('.zip') &&
            (platform === 'darwin' ? f.endsWith('-Mac.zip') : !f.endsWith('-Mac.zip'))
        )
        .sort()
    : []

  const blocking = []
  const staleOthers = []
  const polluted = []

  // 发版时一个包都没有，不能当成「没发现问题」—— 那是没东西可发
  if (requireAll && zips.length === 0) {
    console.error(`\n✖ ${distDir} 下一个分发包都没有，发版没东西可带。`)
    console.error('  出全套：node scripts/build-all-plugins.mjs')
    return false
  }

  for (const name of zips) {
    // 先看有没有混进不该带的文件。
    //
    // 这一条独立于「新不新」：包可能指纹对得上、但仍然带着 16MB 的调试符号
    // —— 真实发生过，而且是别人用 `git add .` 把坏包一起提交进来的。
    // 只检查自己出的包挡不住这种情况，所以这里扫的是磁盘上的所有 zip。
    const leaked = findExcludedEntries(join(distDir, name))
    if (leaked.length > 0) {
      polluted.push({ name, leaked })
    }

    const mustBeFresh = requireAll || required.has(name)
    const mark = mustBeFresh && !requireAll ? '  ← 必须新鲜' : ''
    const stamp = readStamp(join(distDir, name))

    if (!stamp?.fingerprint) {
      // 没有标记 = 判不了新旧。对不要求的版本这只是「未知」，对要求新鲜的就是
      // 不合格：说不清它是不是旧的，就不能拿它去发版。
      if (mustBeFresh) blocking.push({ name, reason: '没有构建标记，判不了新旧' })
      console.log(`  ${name.padEnd(28)} 未知（手工出的包，没有构建标记）${mark}`)
      continue
    }

    const expectedEngine = required.get(name)
    const engineMatches = !expectedEngine || stamp.engine === expectedEngine
    const nativeMatches =
      platform !== 'darwin' ||
      (stamp.platform === 'Mac' && macPackageHasBinary(join(distDir, name)))
    const ok = stamp.fingerprint === fingerprint && engineMatches && nativeMatches
    if (!ok) {
      if (mustBeFresh)
        blocking.push({
          name,
          reason: !nativeMatches
            ? 'Mac 包缺少平台标记或 dylib'
            : engineMatches
              ? `指纹是 ${stamp.fingerprint}，源码已经变了`
              : `包名对应 UE ${expectedEngine}，构建标记却是 ${stamp.engine}`
        })
      else staleOthers.push(name)
    }
    console.log(
      `  ${name.padEnd(28)} ${ok ? '最新' : '已过期'}  ${stamp.fingerprint}  ${stamp.builtAt ?? ''}${mark}`
    )
  }

  /*
   * 缺包：分「忘了出」和「出不了」。
   *
   * 2026-09-03 起 zip 不再进 git（派生产物），于是「磁盘上没有这个包」成了
   * 干净检出上的**常态**，而不再一定是「改了源码忘了出包」。
   *
   * 这道门禁存在的意义是让「忘了出包」变成一个会响的错误。而一台**没装虚幻引擎**
   * 的机器（CI runner 就是）根本产不出包 —— 对它报错，等于让门禁在 CI 上常红，
   * 而一道天天红的门禁很快会被人关掉，那时候真正的「忘了出包」也没人管了。
   *
   * 所以判据用「这台机器能不能出包」：
   *   · 装了引擎 → 你能出，缺包就是忘了出，拦。
   *   · 没装引擎 → 你出不了，缺包不是你的错，警告并放行。
   * 发版那一档（--all）不吃这一套：没包就是没东西可发，前面已经硬拦过了。
   */
  const missing = [...required].filter(([name]) => !zips.includes(name))
  for (const [name, engine] of missing) {
    if (requireAll || canBuildHere) {
      blocking.push({
        name,
        reason: `分发包不存在（UE ${engine}）—— 这台机器装了引擎，出一个：pnpm plugin:build --engine ${engine} --project <uproject>`
      })
    } else {
      console.warn(`  ${name.padEnd(28)} 不存在（本机没装虚幻引擎，出不了包，跳过）`)
    }
  }

  if (staleOthers.length > 0) {
    console.log(`\n${staleOthers.length} 个包已过期：${staleOthers.join('、')}`)
    console.log(
      `  日常门禁只钉 UE ${requiredEngines.join('、')}，这些先不拦；` +
        '\n  但发版前必须全部补出 —— pnpm plugin:check:all 会一个不落地卡住。'
    )
  }

  if (polluted.length > 0) {
    console.error(`\n✖ ${polluted.length} 个分发包里混进了不该带的文件：`)
    for (const { name, leaked } of polluted) {
      console.error(`  ${name}：${leaked.length} 个，例如 ${leaked[0]}`)
    }
    console.error('\n  .pdb 是调试符号，一个就 16MB —— 用户装插件用不到它。')
    console.error('  这类包多半是用旧版脚本出的，重新出一次即可：')
    console.error('  node scripts/build-all-plugins.mjs')
    return false
  }

  if (blocking.length > 0) {
    console.error(`\n✖ ${blocking.length} 个分发包不合格：`)
    for (const { name, reason } of blocking) {
      console.error(`  ${name}：${reason}`)
    }
    console.error('\n  改了插件源码就要重新出包，否则用户装到的还是旧的。')
    console.error(
      requireAll
        ? '  发版要求每个版本都新鲜，出全套：node scripts/build-all-plugins.mjs'
        : `  出包：node scripts/build-plugin.mjs --engine ${requiredEngines[0]} --project <uproject>`
    )
    return false
  }

  console.log(
    requireAll
      ? `\n✓ ${zips.length} 个分发包全部是最新的，也没有多余文件 —— 可以发版`
      : `\n✓ UE ${requiredEngines.join('、')} 的分发包是最新的，也没有多余文件`
  )
  return true
}

/** 只检查已有分发包，不编译不出包。 */
function main() {
  // 源码现在跟着本仓库走，检出里一定有。缺了说明工作区被破坏了，
  // 那是个要人看一眼的问题，不该静默继续。
  if (!existsSync(join(SOURCE_DIR, 'UnrealAgentLink.uplugin'))) {
    console.error(`
✖ 找不到插件源码：${relative(ROOT, SOURCE_DIR)}`)
    console.error('  它现在是本仓库的一部分（见根目录 .gitignore 里那段说明）。')
    console.error('  用 git 还原：git checkout -- plugin/')
    process.exit(1)
  }

  // --all = 发版模式，每个包都要新鲜；不带 --all 只钉 VERIFY_ENGINES
  const required = process.argv.slice(2).includes('--all') ? null : VERIFY_ENGINES
  process.exit(checkStaleness(sourceFingerprint(), DIST_DIR, required, process.platform) ? 0 : 1)
}

// 被 import 时（测试）不执行主流程
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop())) {
  main()
}
