#!/usr/bin/env node
/**
 * 跑插件的 C++ 自动化测试，把结果读成退出码。
 *
 * ## 为什么需要这个脚本
 *
 * `Private/Tests/` 下的 `IMPLEMENT_SIMPLE_AUTOMATION_TEST` 一直都在，但仓库里
 * 没有任何入口去跑它们 —— 于是插件的 C++ 改动长期只有「编过了」这一个判据，
 * 「编过了」和「行为对」之间的差距，正是定序器那三轮返工的全部原因。
 *
 * ## 那个静默假绿
 *
 * `build-all-plugins.mjs` 把九个引擎的编译产物全都落在同一个
 * `plugin/UnrealAgentLink/Binaries/Win64/`（宿主工程用目录联接指过来）。
 * 所以那里躺着的永远是**最后一个编的版本**。拿 5.8 的 DLL 去启 5.5 的宿主工程，
 * BuildId 对不上，插件加载失败 —— 而编辑器的表现不是报错退出，是
 * **正常跑完 0 条测试、退出码 0**。
 *
 * 所以这里有两条硬规矩：
 *
 *   1. 默认先重编目标版本（`--no-build` 可跳过，但你要自己保证刚编的就是它）
 *   2. **跑到 0 条测试一律算失败**，不管退出码多好看
 *
 * ## 用法
 *
 *   node scripts/test-plugin.mjs                      # UE 5.5，全部 UnrealAgentLink 测试
 *   node scripts/test-plugin.mjs --filter UnrealAgentLink.Sequencer
 *   node scripts/test-plugin.mjs --engine 5.6
 *   node scripts/test-plugin.mjs --no-build           # 已经编过了，只想再跑一遍
 *
 * 默认钉 5.5，和 `plugin-check.mjs` 里 `VERIFY_ENGINES` 同一个理由：
 * 本机不一定装齐九个引擎，全套跑一轮接近一小时，门禁会长期全红然后被无视。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { createHostProject } from './make-host-project.mjs'
import { installedEngines } from './build-plugin.mjs'

const ROOT = resolve(import.meta.dirname, '..')

/** 测试名前缀。引擎按前缀匹配，给 `UnrealAgentLink` 就是全套 */
const DEFAULT_FILTER = 'UnrealAgentLink'
const DEFAULT_ENGINE = '5.5'

/** 现在有没有 UnrealEditor 在跑 */
function editorIsRunning() {
  const probe =
    process.platform === 'win32'
      ? spawnSync('tasklist', ['/FI', 'IMAGENAME eq UnrealEditor*'], { encoding: 'utf8' })
      : spawnSync('pgrep', ['-f', 'UnrealEditor'], { encoding: 'utf8' })
  // 探测本身失败就当没在跑，别因为一个辅助判断把测试拦下来
  if (probe.error) return false
  return /UnrealEditor/.test(probe.stdout ?? '')
}

/**
 * 等上一个编辑器退干净再开编。
 *
 * UBT 在有编辑器活着时会拒绝编译（"Unable to build while Live Coding is active"），
 * 而连着跑两次本脚本就会撞上 —— 上一轮的自动化测试编辑器还在退出途中。
 * 真撞上过一次，表现是编译退出码 6，错误信息埋在几百行 UBT 输出里。
 */
function waitForEditorToExit(timeoutMs = 60_000) {
  if (!editorIsRunning()) return

  console.log('有 UnrealEditor 在跑，等它退出（UBT 不允许带着编辑器编译）……')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    // 同步睡 2 秒：这个脚本本来就是串行的，不值得为它引入异步
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},2000)'], { stdio: 'ignore' })
    if (!editorIsRunning()) {
      console.log('已退出。\n')
      return
    }
  }

  console.error('✖ 等了 60 秒，还有 UnrealEditor 在跑。')
  console.error('  如果是你自己开着的编辑器，先关掉；或者加 --no-build 跳过编译这步。')
  process.exit(1)
}

function main() {
  const argv = process.argv.slice(2)
  const flag = (n) => {
    const i = argv.indexOf(`--${n}`)
    return i >= 0 ? argv[i + 1] : undefined
  }

  // 未知参数直接报错 —— 理由同 build-all-plugins.mjs：默默忽略的代价是
  // 你以为在跑一个子集，实际跑了别的东西，然后照着错的结果下结论
  const KNOWN = ['engine', 'filter', 'hosts', 'no-build']
  const unknown = argv.filter((a) => a.startsWith('--') && !KNOWN.includes(a.slice(2)))
  if (unknown.length) {
    console.error(`✖ 不认识的参数：${unknown.join('、')}`)
    console.error(`  本脚本只认：${KNOWN.map((f) => `--${f}`).join('、')}`)
    process.exit(1)
  }

  const engine = flag('engine') ?? DEFAULT_ENGINE
  const filter = flag('filter') ?? DEFAULT_FILTER
  const hostsDir = flag('hosts') ?? join(ROOT, '..', '_ual-hosts')
  const skipBuild = argv.includes('--no-build')

  const enginePath = installedEngines().get(engine)
  if (!enginePath) {
    console.error(`✖ 本机没装 UE ${engine}`)
    console.error(`  已装：${[...installedEngines().keys()].sort().join('、') || '（一个都没有）'}`)
    process.exit(1)
  }

  if (!skipBuild) {
    waitForEditorToExit()
    console.log(`先重编 UE ${engine} —— 联接目录里躺的可能是别的版本，见文件头注释\n`)
    const built = spawnSync(
      'node',
      [join(ROOT, 'scripts', 'build-all-plugins.mjs'), '--only', engine],
      { stdio: 'inherit', shell: process.platform === 'win32' }
    )
    if (built.status !== 0) {
      console.error(`\n✖ UE ${engine} 编译失败，测试没跑`)
      process.exit(1)
    }
    console.log('')
  }

  const host = createHostProject(engine, hostsDir)
  const editor = join(
    enginePath,
    'Engine',
    'Binaries',
    process.platform === 'win32' ? 'Win64' : 'Mac',
    process.platform === 'win32' ? 'UnrealEditor-Cmd.exe' : 'UnrealEditor-Cmd'
  )
  if (!existsSync(editor)) {
    console.error(`✖ 找不到编辑器可执行文件：${editor}`)
    process.exit(1)
  }

  const reportDir = mkdtempSync(join(tmpdir(), 'ual-automation-'))
  console.log(`UE ${engine} · 过滤器 ${filter}`)
  console.log('编辑器冷启约 40 秒，请等\n')

  const run = spawnSync(
    editor,
    [
      host.uproject,
      `-ExecCmds=Automation RunTests ${filter}`,
      '-TestExit=Automation Test Queue Empty',
      `-ReportExportPath=${reportDir}`,
      // -nullrhi 免掉窗口和 GPU；测试本身是 EditorContext，不需要渲染
      '-unattended',
      '-nop4',
      '-nosplash',
      '-nullrhi',
      '-NoSound',
      '-stdout'
    ],
    { encoding: 'utf8' }
  )

  const indexPath = join(reportDir, 'index.json')
  if (!existsSync(indexPath)) {
    console.error('✖ 编辑器没有产出测试报告，说明测试根本没跑起来。')
    console.error('  最常见的原因是插件加载失败（BuildId 对不上）。编辑器日志尾部：')
    console.error(
      (run.stdout ?? '')
        .split('\n')
        .slice(-25)
        .map((l) => `    ${l}`)
        .join('\n')
    )
    process.exit(1)
  }

  // 引擎写出来的 index.json 带 UTF-8 BOM，JSON.parse 会直接抛。
  // trim() 就能去掉 —— BOM（U+FEFF）在 ECMAScript 里算空白字符
  const report = JSON.parse(readFileSync(indexPath, 'utf8').trim())
  rmSync(reportDir, { recursive: true, force: true })

  const tests = report.tests ?? []
  for (const test of tests) {
    const ok = test.state === 'Success'
    console.log(`${ok ? '✓' : '✗'} ${test.fullTestPath}`)
    if (ok) continue
    for (const entry of test.entries ?? []) {
      const event = entry.event ?? {}
      if (event.type === 'Error' || event.type === 'Warning') {
        console.log(`    ${event.message}`)
      }
    }
  }

  // 0 条测试是失败，不是通过。这一条是本脚本存在的主要理由：
  // 插件没加载时，编辑器会安静地跑完 0 条然后 exit 0
  if (tests.length === 0) {
    console.error(`\n✖ 没有任何测试匹配「${filter}」。插件真的加载了吗？`)
    process.exit(1)
  }

  const failed = tests.filter((t) => t.state !== 'Success')
  console.log(`\n${tests.length} 条测试，${tests.length - failed.length} 条通过`)
  if (failed.length) {
    console.error(`✖ ${failed.length} 条失败`)
    process.exit(1)
  }
  console.log('✓ 全部通过')
}

main()
