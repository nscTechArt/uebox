#!/usr/bin/env node
/**
 * 把 uebox CLI 打成一份自包含的目录，供安装包携带。
 *
 * ## 为什么用户不需要装 Node
 *
 * 盒子本身就是 Electron，而 Electron 里带着一个完整的 Node 运行时。设上
 * `ELECTRON_RUN_AS_NODE=1`，`unreal-agent.exe` 就是个 node —— 于是
 * `uebox.cmd` 只是一层三行的转发（见 `build/uebox.cmd`）。
 *
 * 这一条决定了整个分发方案：目标用户是普通 UE 开发者，让他先去装 Node 和 npm
 * 才能用一个命令行工具，等于把大多数人挡在门外。而这份运行时本来就在他机器上。
 *
 * ## 为什么单独带一份依赖，而不是复用盒子的 node_modules
 *
 * CLI 只依赖 `@modelcontextprotocol/sdk`，盒子的主进程也依赖它。共用一份看着
 * 省事，但 `resources/cli/index.js` 的模块解析是从它自己所在的目录往上找的，
 * 够不到 asar 里的 `node_modules`；要够到就得在启动器里塞 `NODE_PATH`，
 * 那等于把 CLI 的依赖解析绑死在盒子的目录结构上 —— 盒子哪天改了打包布局，
 * 坏的是命令行，而且坏在用户机器上。
 *
 * 多带一份的代价是几十兆，在一个 Electron 应用旁边可以忽略；换来的是 CLI
 * 的依赖闭包**完全自己说了算**。
 *
 * 用法：`node scripts/build-cli-bundle.mjs`，产物在 `packages/cli/bundle/`。
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(new URL('..', import.meta.url) + 'x'))
const CLI = join(ROOT, 'packages', 'cli')
const BUNDLE = join(CLI, 'bundle')

const isWindows = process.platform === 'win32'

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: 'inherit', shell: isWindows })
}

function main() {
  const pkg = JSON.parse(readFileSync(join(CLI, 'package.json'), 'utf8'))

  console.log('[cli-bundle] 编译 TypeScript…')
  run('npx', ['tsc', '-p', 'tsconfig.json'], CLI)

  if (!existsSync(join(CLI, 'dist', 'index.js'))) {
    console.error('✖ 编译没产出 dist/index.js')
    process.exit(1)
  }

  console.log('[cli-bundle] 准备打包目录…')
  rmSync(BUNDLE, { recursive: true, force: true })
  mkdirSync(BUNDLE, { recursive: true })

  // dist 直接摊平到 bundle 根：安装后是 resources/cli/index.js，
  // 启动器里的路径少一层，出错时也少一层要解释的东西
  cpSync(join(CLI, 'dist'), BUNDLE, { recursive: true })
  cpSync(join(CLI, 'skills'), join(BUNDLE, 'skills'), { recursive: true })
  cpSync(join(CLI, 'README.md'), join(BUNDLE, 'README.md'))
  if (process.platform === 'darwin') {
    mkdirSync(join(BUNDLE, 'bin'), { recursive: true })
    cpSync(join(ROOT, 'build', 'uebox.sh'), join(BUNDLE, 'bin', 'uebox'))
  }

  // 只写运行时需要的那部分 package.json。
  // 不整个照抄：devDependencies 和 scripts 进了包只会让 npm 在用户机器上
  // 多做一堆无意义的事。
  writeFileSync(
    join(BUNDLE, 'package.json'),
    `${JSON.stringify(
      {
        name: pkg.name,
        version: pkg.version,
        private: true,
        type: 'module',
        dependencies: pkg.dependencies ?? {}
      },
      null,
      2
    )}\n`
  )

  console.log('[cli-bundle] 装生产依赖…')
  run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--silent'], BUNDLE)

  // package-lock 是安装过程的产物，不该跟着发出去
  rmSync(join(BUNDLE, 'package-lock.json'), { force: true })

  const deps = Object.keys(pkg.dependencies ?? {})
  console.log(`✓ CLI 打包完成：${BUNDLE}`)
  console.log(`  运行时依赖 ${deps.length} 个：${deps.join('、')}`)
}

main()
