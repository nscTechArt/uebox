#!/usr/bin/env node
/**
 * 从插件源码编译出分发给用户的插件包。
 *
 * ## 源码就在本仓库 plugin/ 下
 *
 * 插件原先是独立仓库（github.com/ueboxai/unreal-agent-link），2026-09-03 合并进来。
 * 合并的判据和当初拆分的理由都记在根目录 `.gitignore` 里那段注释，
 * **要动这个结构之前先读它** —— 拆分当初也是有道理的，不了解就改会来回折腾。
 *
 * 所以这里不再有 `--sync`：没有远端可同步，源码跟着本仓库走。
 *
 * ## 这个脚本为什么存在
 *
 * 在它之前，出包是手工的，源码和 `resources/plugins/*.zip` 脱节了**七个月**：
 * zip 里的 `UAL_EditorCommands.cpp` 停在 2026-01-06，期间的修复（控制台输出
 * 捕获、Python stdout 回传、截图改走 SceneCapture）用户一个都拿不到，
 * 而且没有任何东西会提醒你「改了源码还没出包」。
 *
 * 所以这里有两件事：出包，以及让「忘了出包」变成一个会响的错误。
 * 后者（比对源码指纹和 zip 里的 `.ual-build` 判新鲜度）的检查流程在
 * `scripts/plugin-check.mjs`：`pnpm plugin:check --engine <版本>` /
 * `pnpm plugin:check --all`，只做验证。格式约定本身（排除规则、zip 命名、
 * 构建标记、源码指纹）在 `scripts/plugin-package-format.mjs`。改本文件不触发
 * 日常包检查，原因见 verify-plugin.mjs 顶部。
 *
 * ## 用法
 *
 *   node scripts/build-plugin.mjs --engine 5.5             # 出一个版本的包
 *   node scripts/build-plugin.mjs --engine 5.5 --project <uproject 路径>
 *   node scripts/plugin-check.mjs --engine 5.7             # 只检查指定包，不需要引擎
 *   node scripts/plugin-check.mjs --all                    # 发版：每个版本都要新鲜
 *
 * ## 为什么需要一个宿主工程
 *
 * 虚幻插件不能脱离工程单独编译，UBT 要一个 `.uproject` 才知道用哪套目标规则。
 * 开发时用目录联接把本目录挂进工程的 `Plugins/` 下：
 *
 *   New-Item -ItemType Junction -Path "<工程>/Plugins/UnrealAgentLink" \
 *     -Target "<仓库>/plugin/UnrealAgentLink"
 *
 * 联接之后编译产物会落回仓库里的 `plugin/UnrealAgentLink/Binaries/`，
 * 那些路径已经在 .gitignore 里。
 *
 * **没有这条联接，UBT 不会报错** —— 它只是编宿主工程自己的模块，一个
 * UnrealAgentLink 的编译动作都没有，退出码照样是 0。脚本要是就这么往下走，
 * 会把**当前源码的指纹**盖到一个装着**陈旧 DLL** 的 zip 上，于是上面那道
 * `plugin:check` 门禁反而会说「一致」—— 它存在的全部理由被它自己掩盖掉。
 * 所以出包前有两道卡：编译前查联接（findMissingHostLink），
 * 编译后查二进制（findStaleBinary）。
 */

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pluginPlatform, installedMacEngines } from './plugin-platform.mjs'
import {
  DIST_DIR,
  SOURCE_DIR,
  STAMP_FILE,
  findExcludedEntries,
  shouldExcludeFromZip,
  sourceFingerprint,
  zipNameForEngine
} from './plugin-package-format.mjs'

/**
 * 已安装的引擎，从 Epic Launcher 的清单里读。
 *
 * 和盒子运行时用的是同一份数据（见 `src/main/utils/UnrealPathManager.ts`）——
 * 硬编码 `D:/Game/UE_5.5` 这种路径在这台机器上就是错的：九个引擎散在
 * C/D/G/I 四个盘。
 */
const LAUNCHER_MANIFEST = 'C:/ProgramData/Epic/UnrealEngineLauncher/LauncherInstalled.dat'

/**
 * 每个安装项各自一份的 manifest。
 *
 * 上面那份汇总文件只在启动器认为该重写时才整体重写，会滞后于实际安装 ——
 * UE 5.8 装完二十分钟后它里面还没有 5.8，导致 `--only 5.8` 报「没有可用的引擎版本」。
 * 这些 .item 是装完当场落盘的，所以以它为准。
 */
const LAUNCHER_MANIFEST_DIR = 'C:/ProgramData/Epic/EpicGamesLauncher/Data/Manifests'

const ENGINE_APP_NAME = /^UE_\d+\.\d+$/

function enginesFromInstalledDat(manifestPath) {
  if (!existsSync(manifestPath)) return new Map()
  try {
    const data = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const found = new Map()
    for (const install of data.InstallationList ?? []) {
      if (!ENGINE_APP_NAME.test(install.ArtifactId ?? '')) continue
      found.set(String(install.AppName).replace('UE_', ''), install.InstallLocation)
    }
    return found
  } catch (error) {
    console.warn(`读取引擎清单失败（${error.message}），只能靠 --engine-path 指定`)
    return new Map()
  }
}

function enginesFromManifestDir(dir) {
  if (!existsSync(dir)) return new Map()
  const found = new Map()
  for (const entry of readdirSync(dir)) {
    if (!entry.toLowerCase().endsWith('.item')) continue
    try {
      const item = JSON.parse(readFileSync(join(dir, entry), 'utf8'))
      if (!ENGINE_APP_NAME.test(item.AppName ?? '')) continue
      if (item.bIsIncompleteInstall === true) continue
      if (!item.InstallLocation) continue
      found.set(String(item.AppName).replace('UE_', ''), item.InstallLocation)
    } catch {
      // 单个 manifest 坏了不该让整次扫描失败
    }
  }
  return found
}

/**
 * 已安装的引擎。两份记录都读，manifest 优先。
 *
 * 和盒子运行时用的是同一套来源（见 `src/main/utils/UnrealPathManager.ts`）。
 */
export function installedEngines(
  manifestPath = LAUNCHER_MANIFEST,
  manifestDir = LAUNCHER_MANIFEST_DIR,
  platform = process.platform
) {
  if (
    platform === 'darwin' &&
    manifestPath === LAUNCHER_MANIFEST &&
    manifestDir === LAUNCHER_MANIFEST_DIR
  )
    return installedMacEngines()
  return new Map([...enginesFromInstalledDat(manifestPath), ...enginesFromManifestDir(manifestDir)])
}

const ROOT = resolve(import.meta.dirname, '..')

/**
 * 同一份标记也写进插件源码目录。
 *
 * 插件在运行时读自己 `GetBaseDir()` 下的这个文件，把指纹通过
 * `ue_get_project_info` 报出来 —— 验证插件改动时第一步就能确认
 * 「跑着的是不是我刚编的那份」。
 *
 * 只写进 zip 是不够的：开发时宿主工程的 `Plugins/UnrealAgentLink` 是一条
 * 指向本目录的联接，插件从这里加载，根本不经过 zip。结果就是**开发机上
 * 永远报 unknown**，而开发机恰恰是最需要这个信息的地方 —— 真为此白跑过
 * 一整轮回归：代码改了没出包，测试在旧 DLL 上跑出「修复未生效」。
 *
 * 这个文件不参与源码指纹（不在 plugin-package-format.mjs 的
 * HASHED_DIRS / HASHED_FILES 里），所以写它不会让下一次的指纹变化。
 */
export function writeSourceStamp(engine, fingerprint, dir = SOURCE_DIR) {
  const target = join(dir, STAMP_FILE)
  writeFileSync(
    target,
    JSON.stringify(
      { fingerprint, engine, platform: pluginPlatform().target, builtAt: new Date().toISOString() },
      null,
      2
    ),
    'utf8'
  )
  return target
}

/**
 * 编译产物落点。packZip 打的也正是这个目录下的 `Binaries/`，
 * 所以「有没有编出插件」和「包里是不是新的 DLL」是同一个问题。
 */
const BUILD_PLATFORM = pluginPlatform()

/** 宿主工程里挂插件的固定位置 */
const HOST_LINK = join('Plugins', 'UnrealAgentLink')

/** 两个路径是不是同一个东西（联接/软链接都算）。Windows 上路径不分大小写 */
function samePath(a, b) {
  try {
    const first = realpathSync.native(a)
    const second = realpathSync.native(b)
    return process.platform === 'win32'
      ? first.toLowerCase() === second.toLowerCase()
      : first === second
  } catch {
    return false
  }
}

/**
 * 宿主工程的 `Plugins/UnrealAgentLink` 有没有指到本仓库的插件源码。
 *
 * 返回 null 表示没问题，否则返回一句人话。**这道检查必须在编译之前跑** ——
 * 联接没建时 UBT 不报错、只是不编插件（见文件顶部），等编完再发现就白等了
 * 五分钟，而且下一步就要拿旧 DLL 出包了。
 */
export function findMissingHostLink(projectPath, sourceDir = SOURCE_DIR) {
  const linked = join(dirname(resolve(projectPath)), HOST_LINK)
  if (!existsSync(linked)) return `宿主工程里没有插件联接：${linked}`
  if (!samePath(linked, sourceDir)) {
    return (
      `宿主工程里的插件不是本仓库这一份：\n` +
      `    ${linked}\n` +
      `  指向别处，而出包打的是 ${sourceDir}`
    )
  }
  return null
}

/** 目录下最新的一个文件（含 mtime）。空目录/不存在返回 null */
function newestFile(dir) {
  let newest = null
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry)
      const st = statSync(full)
      if (st.isDirectory()) walk(full)
      else if (!newest || st.mtimeMs > newest.mtimeMs) newest = { file: full, mtimeMs: st.mtimeMs }
    }
  }
  if (existsSync(dir)) walk(dir)
  return newest
}

/**
 * 这次构建到底有没有产出**当前源码**对应的插件二进制。
 *
 * 返回 null 表示没问题，否则返回一句人话。
 *
 * 比的是「DLL 和 Source/ 下最新的文件谁更新」，而不是「DLL 是不是这次构建
 * 期间写的」。后者看着更直接，但源码没变时 UBT 本来就会跳过链接（"Target is
 * up to date"），DLL 不会被碰 —— 那样连着出两次同一个版本的包，第二次必然
 * 误报，而且没法自证清白：只能去 touch 一个源文件骗过检查。
 *
 * 用 mtime 而不是内容指纹是有意的：这里比的是同一台机器上刚编完的产物和它的
 * 输入，正好是 UBT 自己判增量的那套信号 —— UBT 认为该重编的，这里就不会说旧。
 * （跨机器判包新旧仍然走 sourceFingerprint，那里 mtime 会天天误报。）
 * 也只比 `Source/`：Content/Config 变了不触发 UBT 重编，拿它们比会卡死在
 * 「重跑也过不了」。
 */
export function findStaleBinary(dir = SOURCE_DIR, platform = 'win32') {
  const config = pluginPlatform(platform)
  const dll = join(dir, 'Binaries', config.target, config.binary)
  if (!existsSync(dll)) return `没有找到插件二进制：${dll}`

  const builtAt = statSync(dll).mtimeMs
  const newest = newestFile(join(dir, 'Source'))
  if (newest && newest.mtimeMs > builtAt) {
    return (
      `插件二进制比源码还旧：\n` +
      `    ${dll}\n      ${new Date(builtAt).toISOString()}\n` +
      `    ${newest.file}\n      ${new Date(newest.mtimeMs).toISOString()}`
    )
  }
  return null
}

function run(cmd, args, label) {
  console.log(`\n▶ ${label}`)
  const result = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.status !== 0) {
    console.error(`✖ ${label} 失败（退出码 ${result.status}）`)
    process.exit(1)
  }
}

/**
 * 把编译产物 + 源码打成分发包。
 *
 * 结构照搬现有的 zip（Binaries / Config / Content / Resources / Source /
 * *.uplugin 平铺在根），额外多一个 `.ual-build` 标记 —— 那是让 plugin:check
 * 能判过期的唯一依据。
 */
function packZip(engine, fingerprint) {
  const AdmZip = createRequire(import.meta.url)('adm-zip')
  const zip = new AdmZip()

  for (const sub of [
    `Binaries/${BUILD_PLATFORM.target}`,
    'Config',
    'Content',
    'Resources',
    'Source'
  ]) {
    const full = join(SOURCE_DIR, sub)
    // 调试符号（.pdb）不进分发包：一个就 16.7MB，占整包 83%，
    // 而用户只是装个插件，用不到它。漏掉这条过滤会让包从 5MB 涨到 23MB。
    if (existsSync(full)) zip.addLocalFolder(full, sub, (name) => !shouldExcludeFromZip(name))
  }
  zip.addLocalFile(join(SOURCE_DIR, 'UnrealAgentLink.uplugin'))
  zip.addLocalFile(join(SOURCE_DIR, 'LICENSE'))
  zip.addFile(
    STAMP_FILE,
    Buffer.from(
      JSON.stringify(
        {
          fingerprint,
          engine,
          platform: pluginPlatform().target,
          builtAt: new Date().toISOString()
        },
        null,
        2
      ),
      'utf8'
    )
  )

  const target = join(DIST_DIR, zipNameForEngine(engine, process.platform))
  zip.writeZip(target)

  // 写完立刻自检。过滤器写错、adm-zip 换了行为、有人加了新的产物类型 ——
  // 任何一种都会在这里当场炸，而不是等到用户下载了 20MB 的调试符号
  const leaked = findExcludedEntries(target)
  if (leaked.length > 0) {
    throw new Error(
      `出包自检失败：${leaked.length} 个不该带的文件混进了 ${target}\n  ` +
        leaked.slice(0, 5).join('\n  ')
    )
  }

  const size = (statSync(target).size / 1024 / 1024).toFixed(1)
  console.log(`\n✓ 已出包：${relative(ROOT, target)}（${size} MB，指纹 ${fingerprint}）`)
}

/** 通过宿主工程编译并打包当前仓库的插件源码。 */
function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--check')) {
    console.error(
      '✖ --check 已移到 pnpm plugin:check（scripts/plugin-check.mjs）/ moved to pnpm plugin:check'
    )
    process.exit(1)
  }
  const flag = (name) => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 ? argv[i + 1] : undefined
  }

  // 列引擎不需要插件源码，放在源码检查之前
  if (argv.includes('--list-engines')) {
    const engines = installedEngines()
    if (!engines.size) {
      console.log('没有从 Epic Launcher 清单里读到任何引擎')
      return
    }
    for (const [version, location] of [...engines].sort()) {
      console.log(`  UE ${version.padEnd(5)} ${location}`)
    }
    return
  }

  // 源码现在跟着本仓库走，检出里一定有。缺了说明工作区被破坏了，
  // 那是个要人看一眼的问题，不该静默继续 —— 从前这里会去 GitHub 拉一份，
  // 合并之后没有远端可拉了。
  if (!existsSync(join(SOURCE_DIR, 'UnrealAgentLink.uplugin'))) {
    console.error(`
✖ 找不到插件源码：${relative(ROOT, SOURCE_DIR)}`)
    console.error('  它现在是本仓库的一部分（见根目录 .gitignore 里那段说明）。')
    console.error('  用 git 还原：git checkout -- plugin/')
    process.exit(1)
  }

  const fingerprint = sourceFingerprint()

  const engine = flag('engine')
  if (!engine) {
    console.error('✖ 需要 --engine <版本>，例如 --engine 5.5')
    console.error('  看已装的引擎：node scripts/build-plugin.mjs --list-engines')
    process.exit(1)
  }

  const project = flag('project')
  if (!project || !existsSync(project)) {
    console.error('✖ 需要 --project <uproject 路径>：虚幻插件不能脱离工程单独编译')
    process.exit(1)
  }

  // 编译前就得知道插件挂没挂进去 —— 没挂的话 UBT 会安安静静地只编宿主工程，
  // 退出码 0，然后我们拿旧 DLL 出一个「指纹最新」的包
  const linkProblem = findMissingHostLink(project)
  if (linkProblem) {
    console.error(`✖ ${linkProblem}`)
    console.error('\n  虚幻只编译工程 Plugins/ 下的插件。缺了这条联接，UBT 不会报错，')
    console.error('  但一行插件代码都不会编 —— 出的包会带着旧 DLL 和新指纹，')
    console.error('  把「改了源码没出包」这件事瞒过 plugin:check 门禁。')
    console.error('\n  建联接（PowerShell）：')
    console.error(
      `  New-Item -ItemType Junction -Path "${join(dirname(resolve(project)), HOST_LINK)}" ` +
        `-Target "${SOURCE_DIR}"`
    )
    console.error('\n  或者用 build-all-plugins.mjs，它会自动生成宿主工程并建好联接。')
    process.exit(1)
  }

  const enginePath = flag('engine-path') ?? installedEngines().get(engine)
  if (!enginePath) {
    console.error(`✖ Epic Launcher 清单里没有 UE ${engine}。`)
    console.error('  已装的版本：node scripts/build-plugin.mjs --list-engines')
    console.error('  或用 --engine-path 手动指定')
    process.exit(1)
  }
  const buildBat = join(enginePath, 'Engine', 'Build', 'BatchFiles', ...BUILD_PLATFORM.script)
  if (!existsSync(buildBat)) {
    console.error(`✖ 找不到引擎构建脚本：${buildBat}`)
    console.error('  用 --engine-path 指定引擎安装目录')
    process.exit(1)
  }

  const targetName = `${project
    .split(/[\\/]/)
    .pop()
    .replace(/\.uproject$/, '')}Editor`
  /**
   * 给每次调用一个**独占的 UBT 日志路径**。
   *
   * UnrealBuildTool 默认把日志写到
   * `%LOCALAPPDATA%\UnrealBuildTool\Log.txt` —— 全机器共用一个文件。
   * 而它**在拿构建互斥锁之前**就去开这个日志（顺带把上一份改名备份），
   * 所以 `-WaitMutex` 拦不住这一步：两个构建同时起来，后一个会在
   * `File.Move` 上抛 IOException 直接崩掉，报的是
   * 「The process cannot access the file because it is being used by
   * another process」—— 和插件代码毫无关系，但看起来像编译失败。
   *
   * 同一台机器上并行跑两个构建（两个 agent 会话、或人和 CI 撞上）时必然踩到。
   * 各写各的日志就没有这个问题。
   */
  const ubtLog = join(tmpdir(), `ual-ubt-${engine}-${process.pid}.log`)
  run(
    buildBat,
    [
      targetName,
      BUILD_PLATFORM.target,
      'Development',
      `-Project=${project}`,
      '-WaitMutex',
      `-Log=${ubtLog}`
    ],
    `编译插件（UE ${engine}）`
  )

  // UBT 退出码为 0 不等于编了插件（插件在 .uproject 里没启用、联接指向别处、
  // 目标规则没引用模块都会走到这里）。出包前确认产物真的在，且不比源码旧。
  const binaryProblem = findStaleBinary(SOURCE_DIR, process.platform)
  if (binaryProblem) {
    console.error(`\n✖ 构建跑完了，但没有产出这次源码对应的插件二进制：`)
    console.error(`  ${binaryProblem}`)
    console.error('\n  这次没有出包 —— 拿旧 DLL 出包会给它盖上新指纹，')
    console.error('  plugin:check 会因此认为包是最新的，反而把问题盖住。')
    console.error('\n  往上翻构建输出：如果里面没有 UnrealAgentLink 的编译动作，')
    console.error(`  多半是宿主工程没启用这个插件，检查 ${project} 的 Plugins 段。`)
    process.exit(1)
  }

  console.log(`\n✓ 编译完成，源码指纹 ${fingerprint}`)
  writeSourceStamp(engine, fingerprint)
  packZip(engine, fingerprint)
}

// 被 import 时（测试）不执行主流程
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop())) {
  main()
}
