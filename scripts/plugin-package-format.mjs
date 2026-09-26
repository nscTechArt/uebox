/**
 * 插件分发包的格式约定 —— 出包方和检查方共用的一份契约。
 *
 * 这里装的是「包里该是什么样」：支持的引擎版本、排除规则、zip 命名、
 * 构建标记文件名、源码指纹算法。
 * `build-plugin.mjs` 照着它出包，`plugin-check.mjs` 照着它验包 ——
 * 两边读同一份定义，才不会出「出的合法、验的违规」这种分裂。
 */

import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { pluginPlatform } from './plugin-platform.mjs'

const ROOT = resolve(import.meta.dirname, '..')
export const SOURCE_DIR = join(ROOT, 'plugin', 'UnrealAgentLink')
export const DIST_DIR = join(ROOT, 'resources', 'plugins')

/** 当前支持的版本；发版检查必须覆盖完整集合。 */
export const RELEASE_ENGINES = Object.freeze([
  '5.0',
  '5.1',
  '5.2',
  '5.3',
  '5.4',
  '5.5',
  '5.6',
  '5.7',
  '5.8'
])

/** 引擎版本对应的分发包文件名：5.5 → UnrealAgentLink55.zip */
export function zipNameForEngine(engine, platform = 'win32') {
  return `UnrealAgentLink${String(engine).replace('.', '')}${pluginPlatform(platform).suffix}.zip`
}

/**
 * 不进分发包的编译产物。
 *
 * `.pdb` 是调试符号，一个 16.7MB —— 占整包 83%，而装插件的用户用不到它。
 * `.exp`/`.lib` 是链接期产物，运行时同样不需要。
 *
 * 这条规则漏掉过一次，代价很具体：8 个包从 39MB 涨到 150MB，而且是**先污染
 * 一个、再随批量出包扩散到七个**。发现它靠的是有人说「我记得插件包没这么大」，
 * 不是任何自动检查 —— 所以现在有三道：
 *   1. 出包后自检（build-plugin.mjs 的 packZip），当场炸，坏包根本生不出来
 *   2. `plugin:check` 扫已有的 zip，别人用旧脚本出的坏包也能查出来
 *   3. 单元测试钉住这个函数本身（tests/unit/plugin-check.test.ts）
 */
const EXCLUDE_FROM_ZIP = /\.(pdb|exp|lib)$/i

/** 这个文件该不该被挡在分发包外面 */
export function shouldExcludeFromZip(name) {
  return EXCLUDE_FROM_ZIP.test(String(name ?? '')) || /\.dSYM(?:[\\/]|$)/i.test(String(name ?? ''))
}

/**
 * 检查一个 zip 里有没有混进不该带的文件。
 *
 * 返回违规条目名数组，空数组表示干净。
 */
export function findExcludedEntries(zipPath) {
  const AdmZip = createRequire(import.meta.url)('adm-zip')
  try {
    return new AdmZip(zipPath)
      .getEntries()
      .map((e) => e.entryName)
      .filter((n) => shouldExcludeFromZip(n))
  } catch {
    // 读不了的 zip 由别的检查去报，这里不冒充
    return []
  }
}

/** 出包时写进 zip 的标记文件，记录这份包是从哪个源码指纹编出来的 */
export const STAMP_FILE = '.ual-build'

/** 参与哈希的目录。`Binaries/` 是产物，不算源码 */
const HASHED_DIRS = ['Source', 'Config', 'Content', 'Resources']
const HASHED_FILES = ['UnrealAgentLink.uplugin']

/**
 * 源码指纹。
 *
 * 用内容哈希而不是 mtime —— 换台机器、重新 clone、动一下文件都会改 mtime，
 * 那样这道检查会天天误报，很快就没人看了。
 */
export function sourceFingerprint(dir = SOURCE_DIR) {
  const hash = createHash('sha256')
  const files = []

  const walk = (current) => {
    for (const entry of readdirSync(current).sort()) {
      const full = join(current, entry)
      if (statSync(full).isDirectory()) walk(full)
      else files.push(full)
    }
  }

  for (const sub of HASHED_DIRS) {
    const full = join(dir, sub)
    if (existsSync(full)) walk(full)
  }
  for (const file of HASHED_FILES) {
    const full = join(dir, file)
    if (existsSync(full)) files.push(full)
  }

  for (const file of files.sort()) {
    // 路径也进哈希：只哈希内容的话，重命名文件不会被发现
    hash.update(relative(dir, file).split('\\').join('/'))
    hash.update(readFileSync(file))
  }
  return hash.digest('hex').slice(0, 16)
}
