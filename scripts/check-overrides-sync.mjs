/**
 * 两张依赖强制替换表必须钉同一个版本。
 *
 * package.json 里有两份 overrides，服务两拨读者：
 *   · pnpm.overrides —— pnpm 装包时真正生效的那一份；
 *   · overrides      —— npm 读它，GitHub 的依赖图与安全扫描也读它。
 *
 * 它们是手工维护的重复品，于是必然会漂。2026-09-18 就漂过一次：修
 * @xmldom/xmldom 的 8 个 high 漏洞时只改了 pnpm 那份（0.8.15），npm 那份
 * 留在 0.8.13 —— 实际安装是安全的，但 GitHub 读的是漂掉的那份，
 * 安全页上照旧挂着红。这种错没有任何征兆，只能靠门禁。
 *
 * ## 为什么不逐字比对两张表
 *
 * 两边语法不同，键里的版本选择器也**故意**不同：
 *   npm   "glob@7.2.3": { "minimatch": "3.1.4" }
 *   pnpm  "glob@7>minimatch": "3.1.4"
 * 硬比键会满屏假警报，然后这道门禁就会被无视。
 *
 * 所以只比真正要紧的那件事：**每个包最终被钉到哪个版本**。
 * 把两张表都摊平成「被覆盖的包名 → 版本集合」再比 —— 选择器与嵌套形式
 * 随便写，钉出来的版本不许不一致。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PKG = join(ROOT, 'package.json')

/** 从 "name@spec" / "@scope/name@spec" 里取出包名 */
function packageName(key) {
  const at = key.lastIndexOf('@')
  return at > 0 ? key.slice(0, at) : key
}

/**
 * 摊平成 Map<被覆盖的包名, Set<版本>>。
 *
 * npm 的嵌套对象与 pnpm 的 `a>b>c` 扁平键都归到这里 —— 两种形式下
 * 「被覆盖的包」都是路径的最后一段，值都是要钉的版本。
 */
function flatten(table, { separator } = {}) {
  const out = new Map()

  const record = (key, version) => {
    const name = packageName(separator ? key.split(separator).pop().trim() : key)
    if (!out.has(name)) out.set(name, new Set())
    out.get(name).add(version)
  }

  const walk = (node, parentKey) => {
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === 'string') record(key, value)
      // npm 的嵌套形式：父级只是限定范围，真正被钉的是更里面那层
      else if (value && typeof value === 'object') walk(value, key)
    }
    void parentKey
  }

  walk(table)
  return out
}

function main() {
  const pkg = JSON.parse(readFileSync(PKG, 'utf8'))
  const npmTable = pkg.overrides
  const pnpmTable = pkg.pnpm?.overrides

  if (!npmTable || !pnpmTable) {
    console.log('overrides 同步检查跳过：两张表不是都存在。')
    return 0
  }

  const npmFlat = flatten(npmTable)
  const pnpmFlat = flatten(pnpmTable, { separator: '>' })

  const problems = []
  for (const name of new Set([...npmFlat.keys(), ...pnpmFlat.keys()])) {
    const a = npmFlat.get(name)
    const b = pnpmFlat.get(name)
    if (!a) {
      problems.push(`${name}：只有 pnpm.overrides 钉了（${[...b].join(', ')}），npm 那份没有`)
      continue
    }
    if (!b) {
      problems.push(`${name}：只有 overrides 钉了（${[...a].join(', ')}），pnpm 那份没有`)
      continue
    }
    const left = [...a].sort().join(', ')
    const right = [...b].sort().join(', ')
    if (left !== right) {
      problems.push(`${name}：overrides 钉 ${left}，pnpm.overrides 钉 ${right}`)
    }
  }

  if (problems.length > 0) {
    console.error('\n✖ package.json 的两张 overrides 表钉的版本不一致：\n')
    for (const line of problems) console.error(`  · ${line}`)
    console.error(
      '\n  两份都要改。`overrides` 给 npm 和 GitHub 的安全扫描看，' +
        '\n  `pnpm.overrides` 决定实际装什么 —— 只改一份，另一份就在骗人。\n'
    )
    return 1
  }

  console.log(`overrides 同步检查通过（${npmFlat.size} 个被覆盖的包，两张表钉的版本一致）。`)
  return 0
}

process.exit(main())
