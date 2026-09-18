#!/usr/bin/env node
/**
 * 发布包体检 / uebox package guard.
 *
 * ## 为什么需要它
 *
 * 这个 CLI 住在一个 Electron 桌面应用的仓库里。仓库根上有主进程、
 * `better-sqlite3` 原生绑定、用户凭据、几百 MB 的插件分发包 —— 而
 * `npm pack` 的默认行为是「把目录里的东西都装进去」。夹带任何一样都不是
 * 「文件大了点」：
 *
 *   - **凭据**：令牌进了 npm 包就等于公开发布了它；
 *   - **Electron / 数据库**：用户 `npm i` 一个命令行工具，装下来一个桌面应用，
 *     而且 `better-sqlite3` 会在他机器上触发原生编译；
 *   - **测试脚手架**：`testServer.ts` 能起 HTTP 服务，没有任何理由发给用户。
 *
 * 这些都不会在开发机上暴露 —— 本地跑 `node dist/index.js` 一切正常，
 * 问题只在别人安装的那一刻出现。所以由脚本守。
 *
 * 用法：`pnpm --filter uebox-cli run verify:package`（或在本目录 `node scripts/check-package.mjs`）
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** 一个都不能出现在包里。命中即失败 */
const FORBIDDEN = [
  { pattern: /(^|\/)electron/i, why: 'Electron 相关文件' },
  { pattern: /better-sqlite3|\.node$/i, why: '原生数据库绑定' },
  { pattern: /\.env(\.|$)|mcp-server\.json|credentials?\./i, why: '疑似凭据文件' },
  { pattern: /(^|\/)src\/main\//i, why: '盒子主进程源码' },
  { pattern: /\.test\.(ts|js)$/i, why: '测试文件' },
  { pattern: /testServer\.(ts|js)$/i, why: '测试脚手架（能起 HTTP 服务）' },
  { pattern: /\.uplugin$|(^|\/)plugin\//i, why: 'UE 插件分发包' },
  { pattern: /\.map$/i, why: 'source map（体积大且泄露源码结构）' }
]

/** 这些必须在，缺了说明打包配置写错了 */
const REQUIRED = ['package/dist/index.js', 'package/README.md', 'package/skills/uebox/SKILL.md']

function packedFiles() {
  // `--dry-run` 不产出文件，只报会打进去什么。
  //
  // `--ignore-scripts` 是必须的：不加的话 `prepack` 会跑一遍 tsc，
  // 而它那句 `> uebox-cli@0.1.0 build …` 也走 stdout，把 JSON 冲坏。
  // 体检本来就该看**当前 dist 的样子**，构建是另一步的事。
  const raw = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32'
  })
  const report = JSON.parse(raw)
  return report[0].files.map((f) => `package/${f.path}`.replace(/\\/g, '/'))
}

function main() {
  const files = packedFiles()
  const problems = []

  for (const file of files) {
    for (const rule of FORBIDDEN) {
      if (rule.pattern.test(file)) problems.push(`夹带了${rule.why}：${file}`)
    }
  }

  for (const needed of REQUIRED) {
    if (!files.includes(needed)) problems.push(`包里少了：${needed.replace('package/', '')}`)
  }

  // 依赖闭包也要盯：多一个 dependency 就是多一份用户要装的东西
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const deps = Object.keys(pkg.dependencies ?? {})
  const allowed = ['@modelcontextprotocol/sdk']
  for (const dep of deps) {
    if (!allowed.includes(dep)) {
      problems.push(`多了一个运行时依赖：${dep}（这个 CLI 只该依赖 ${allowed.join('、')}）`)
    }
  }

  if (problems.length === 0) {
    console.log(`✓ uebox 发布包干净：${files.length} 个文件，运行时依赖 ${deps.length} 个。`)
    process.exit(0)
  }

  console.error('✖ uebox 发布包体检失败：\n')
  for (const problem of problems) console.error(`  · ${problem}`)
  console.error('\n包里的东西由 package.json 的 `files` 字段决定。')
  process.exit(1)
}

main()
