#!/usr/bin/env node
/**
 * 把插件在全部支持的引擎版本上各编一遍、各出一个包；缺引擎直接报错。
 *
 * ## 为什么要一次跑全套
 *
 * 分发包按引擎大版本各一份，用户装哪个版本就用哪一份。只更新其中几个的话，
 * 其余版本的用户拿到的还是旧二进制 —— 而且从外面看不出来。
 *
 * 更要紧的是**跨版本 API 差异只有真编一遍才暴露**。5.0 上就有三处：
 * `UStaticMesh::IsNaniteEnabled`、`FAssetData::GetObjectPathString`、
 * `UMaterialExpression::CountInputs` 都是 5.1 才有的。这类问题在 5.5 上
 * 编一万次也发现不了。
 *
 * ## 每个版本都要各自的宿主工程
 *
 * `.uproject` 的 `EngineAssociation` 锁死引擎版本，5.5 的工程不能用 5.6 编。
 * 工程由 make-host-project.mjs 生成，放在临时目录，插件用目录联接挂进去。
 *
 * 用法：
 *   node scripts/build-all-plugins.mjs                 # 全部支持版本（5.0–5.8）
 *   node scripts/build-all-plugins.mjs --only 5.0,5.1  # 指定几个
 *   node scripts/build-all-plugins.mjs --hosts <目录>  # 宿主工程放哪
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { createHostProject } from './make-host-project.mjs'
import { installedEngines } from './build-plugin.mjs'
import { RELEASE_ENGINES } from './plugin-package-format.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const PLUGIN_SRC = join(ROOT, 'plugin', 'UnrealAgentLink')

/** 分发只覆盖 UE5，4.27 不在支持范围内（当前是 5.0–5.8） */
const isSupported = (version) => RELEASE_ENGINES.includes(version)

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32', ...opts })
}

/**
 * 把插件联接进宿主工程。
 *
 * 用联接而不是拷贝：八个版本各拷一份源码，改一处要同步八次，
 * 立刻就会漂。联接保证八个版本编的是同一份代码。
 */
function linkPlugin(hostRoot) {
  const target = join(hostRoot, 'Plugins', 'UnrealAgentLink')
  if (existsSync(target)) rmSync(target, { recursive: true, force: true })
  mkdirSync(join(hostRoot, 'Plugins'), { recursive: true })
  if (process.platform === 'darwin') {
    symlinkSync(PLUGIN_SRC, target, 'dir')
    return
  }
  // 不走 shell：交给 cmd 再解析一遍的话，PowerShell 里的管道会被 cmd 吃掉
  // （实测报 'Out-Null' 不是内部或外部命令）
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `New-Item -ItemType Junction -Path '${target}' -Target '${PLUGIN_SRC}' | Out-Null`
    ],
    { encoding: 'utf8' }
  )
  if (result.status !== 0) {
    throw new Error(`建立联接失败：${result.stderr?.slice(0, 200)}`)
  }
}

function main() {
  const argv = process.argv.slice(2)
  const flag = (n) => {
    const i = argv.indexOf(`--${n}`)
    return i >= 0 ? argv[i + 1] : undefined
  }

  /**
   * 不认识的参数直接报错，不要默默忽略。
   *
   * 这个脚本忽略未知参数的代价特别高：以为在编一个版本，实际编了八个。
   * 真踩过 —— 开发中想只验 5.5，敲的是 `--engine 5.5`（那是
   * build-plugin.mjs 的参数名），这里认的却是 `--only`。它一声不吭地跑了
   * 全套，连着两次，白等二十分钟才发现。
   */
  const KNOWN_FLAGS = ['only', 'hosts']
  const unknown = argv.filter((a) => a.startsWith('--') && !KNOWN_FLAGS.includes(a.slice(2)))
  if (unknown.length) {
    console.error(`✖ 不认识的参数：${unknown.join('、')}`)
    console.error(`  本脚本只认：${KNOWN_FLAGS.map((f) => `--${f}`).join('、')}`)
    console.error('  只编一个版本用：node scripts/build-all-plugins.mjs --only 5.5')
    process.exit(1)
  }

  if (!existsSync(join(PLUGIN_SRC, 'UnrealAgentLink.uplugin'))) {
    console.error('✖ 还没有插件源码，先跑：node scripts/build-plugin.mjs --sync')
    process.exit(1)
  }

  const hostsDir = flag('hosts') ?? join(ROOT, '..', '_ual-hosts')
  const only = flag('only')
    ?.split(',')
    .map((s) => s.trim())

  const engines = [...installedEngines()]
    .filter(([v]) => isSupported(v))
    .filter(([v]) => !only || only.includes(v))
    .sort((a, b) => Number(a[0].split('.')[1]) - Number(b[0].split('.')[1]))

  const requested = only || RELEASE_ENGINES
  const missing = requested.filter(
    (version) => !engines.some(([installed]) => installed === version)
  )
  if (missing.length) {
    console.error(
      `✖ 缺少所需引擎：${missing.join('、')}。发版必须覆盖全部支持版本；开发时可用 --only 5.5。`
    )
    process.exit(1)
  }

  if (!engines.length) {
    console.error('✖ 没有可用的引擎版本')
    process.exit(1)
  }

  console.log(`将为 ${engines.length} 个版本出包：${engines.map(([v]) => v).join('、')}`)
  console.log(`宿主工程目录：${hostsDir}\n`)

  const results = []
  for (const [version, enginePath] of engines) {
    console.log('─'.repeat(60))
    console.log(`UE ${version}`)

    try {
      const host = createHostProject(version, hostsDir)
      linkPlugin(host.root)

      const built = sh(
        'node',
        [
          join(ROOT, 'scripts', 'build-plugin.mjs'),
          '--engine',
          version,
          '--project',
          host.uproject,
          '--engine-path',
          enginePath
        ],
        { stdio: 'inherit' }
      )

      if (built.status !== 0) {
        results.push({ version, ok: false, reason: `编译或出包失败（退出码 ${built.status}）` })
        continue
      }
      results.push({ version, ok: true })
    } catch (error) {
      results.push({ version, ok: false, reason: error.message })
    }
  }

  console.log('\n' + '='.repeat(60))
  const ok = results.filter((r) => r.ok)
  console.log(`成功 ${ok.length}/${results.length}`)
  for (const r of results) {
    console.log(`  UE ${r.version.padEnd(5)} ${r.ok ? '✓' : `✖ ${r.reason}`}`)
  }

  // 有失败就退非零 —— 这个脚本的产物直接发给用户，"大部分成功"不是成功
  if (ok.length !== results.length) process.exit(1)
}

main()
