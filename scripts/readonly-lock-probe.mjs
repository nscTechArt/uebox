/**
 * 只读位资产锁 —— 非侵入性技术探针。
 *
 * ## 这个脚本在验证什么
 *
 * 「AI 正在改的资产，用户不能保存」这件事，UE 里唯一可行的机制是**文件系统的
 * 只读位** —— 就是 Perforce 独占签出的那个位。引擎在三处认它（5.6 源码）：
 *
 *   FileHelpers.cpp:792   弹框硬拒："Unable to save package ... because the file is read-only!"
 *   FileHelpers.cpp:3817  Save All **静默跳过**只读的包
 *   FileHelpers.cpp:1720  只读的包进签出对话框，带一个 "Make Writable" 按钮
 *
 * 它不是 API，是文件系统行为，所以九个引擎版本通吃。
 *
 * 但有一条必须先测出来才敢往下做：**我们自己的插件会不会被自己的锁挡住**。
 * 插件存盘走的是低层 `UPackage::Save`（见 UAL_EditorCommands.cpp:1742），
 * 不经过编辑器那套只读检查的 UI 流程。如果它也被挡，锁的设计就得改成
 * 「agent 动手前临时清位、写完再翻回来」，而不是简单地一直锁着。
 *
 * ## 为什么做成独立脚本
 *
 * 不碰盒子和插件的任何一行生产代码。翻位、观察、还原全在外面完成，
 * 结论错了也不留痕迹。
 *
 * ## 安全约束（这是在动用户工程里的真文件，不是测试夹具）
 *
 *   1. 工程启用了版本控制就**拒绝执行** —— 那个位归 Perforce 管，我们乱翻会
 *      让 P4 和编辑器的状态对不上；
 *   2. 只翻**原本可写**的文件。原本就只读的一律不碰，也不"还原"成可写 ——
 *      那不是我们翻的位；
 *   3. **台账先落盘再翻位**。反过来的话，翻到一半崩了就会留下没记账的只读
 *      文件，用户的工程从此存不了，而且没人知道为什么；
 *   4. 翻完**回读校验**。读不回来就不报成功；
 *   5. 只碰 `<工程>/Content` 底下的文件，路径越界直接拒。
 *
 * ## 用法
 *
 *   node scripts/readonly-lock-probe.mjs status  <工程>
 *   node scripts/readonly-lock-probe.mjs lock    <工程> /Game/Foo /Game/Bar
 *   node scripts/readonly-lock-probe.mjs unlock  <工程> [/Game/Foo ...]
 *   node scripts/readonly-lock-probe.mjs restore <工程>
 *
 * `<工程>` 可以是 `.uproject` 文件，也可以是工程目录。
 * `restore` 是崩溃恢复演练：不看参数，把台账里记的全部还原 ——
 * 正式方案里盒子每次启动要做的就是这一步。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  chmodSync,
  writeFileSync,
  rmSync
} from 'node:fs'
import { dirname, join, resolve, relative, sep } from 'node:path'

/** 台账放 Saved/ 底下 —— UE 约定里那是不进版本库的目录 */
const LEDGER_RELATIVE = join('Saved', 'UnrealBox', 'readonly-probe-ledger.json')

/** 资产包的两种扩展名。关卡是 .umap，其余都是 .uasset */
const PACKAGE_EXTENSIONS = ['.uasset', '.umap']

function fail(message) {
  console.error(`✖ ${message}`)
  process.exit(1)
}

/** `.uproject` 路径或工程目录 → { root, uproject } */
function resolveProject(input) {
  if (!input)
    fail('缺少工程路径。用法见脚本头部注释，或 `node scripts/readonly-lock-probe.mjs` 不带参数')

  const target = resolve(input)
  if (!existsSync(target)) fail(`路径不存在：${target}`)

  if (statSync(target).isFile()) {
    if (!target.endsWith('.uproject')) fail(`不是 .uproject 文件：${target}`)
    return { root: dirname(target), uproject: target }
  }

  const found = readdirSync(target).find((name) => name.endsWith('.uproject'))
  if (!found) fail(`目录里没有 .uproject：${target}`)
  return { root: target, uproject: join(target, found) }
}

/**
 * 工程有没有启用版本控制。
 *
 * 启用了就不能碰只读位。宁可误报「启用了」而放弃执行，也不能误判成没启用
 * 然后去翻 Perforce 管着的位 —— 那会让用户的签出状态和磁盘对不上，
 * 而且他大概率会怪到编辑器头上，永远查不到是我们干的。
 */
function detectSourceControl(root) {
  const candidates = [
    join(root, 'Saved', 'Config', 'WindowsEditor', 'SourceControlSettings.ini'),
    join(root, 'Saved', 'Config', 'Windows', 'SourceControlSettings.ini'),
    join(root, 'Config', 'DefaultSourceControlSettings.ini')
  ]

  for (const file of candidates) {
    if (!existsSync(file)) continue
    const text = readFileSync(file, 'utf8')
    const match = text.match(/^\s*Provider\s*=\s*(.+)$/m)
    const provider = match?.[1]?.trim()
    if (provider && provider.toLowerCase() !== 'none') {
      return { enabled: true, provider, file }
    }
  }
  return { enabled: false }
}

/**
 * 包路径归一。
 *
 * Git Bash（MSYS）会把命令行上以 `/` 开头的参数当成 Unix 路径自动转成 Windows
 * 路径 —— `/Game/Foo` 到了脚本手里变成 `C:/Program Files/Git/Game/Foo`。
 * 这不是我们的 bug，但用户一定会撞上，所以在这里认出来并还原，
 * 而不是甩一句「路径不对」让人自己猜。
 *
 * 同时接受不带前导斜杠的 `Game/Foo` —— 那种写法 MSYS 不碰，最省事。
 */
function normalizePackagePath(input) {
  const trimmed = input.trim().replace(/\\/g, '/')

  if (trimmed.startsWith('/Game/')) return trimmed
  if (trimmed.startsWith('Game/')) return `/${trimmed}`

  // MSYS 转换过的：截回最后一个 /Game/ 处
  const index = trimmed.lastIndexOf('/Game/')
  if (index > 0) return trimmed.slice(index)

  return trimmed
}

/**
 * `/Game/Foo/Bar` → `<工程>/Content/Foo/Bar.uasset`
 *
 * 只认 `/Game/`。`/Engine/` 是引擎安装目录里的文件，绝对不能碰。
 */
function packageToFile(root, packagePath) {
  const trimmed = normalizePackagePath(packagePath)
  if (!trimmed.startsWith('/Game/')) {
    fail(`只支持 /Game/ 开头的包路径，拿到的是：${trimmed}`)
  }

  const contentRoot = join(root, 'Content')
  const withoutPrefix = trimmed.slice('/Game/'.length)
  const base = join(contentRoot, ...withoutPrefix.split('/'))

  // 越界检查放在拼完之后 —— `/Game/../../..` 这种要在这里被挡住
  const rel = relative(contentRoot, base)
  if (rel.startsWith('..') || rel.startsWith(sep + '..')) {
    fail(`路径越出 Content 目录，拒绝执行：${trimmed}`)
  }

  for (const ext of PACKAGE_EXTENSIONS) {
    if (existsSync(base + ext)) return base + ext
  }
  return null
}

/** 文件当前可写吗。Windows 上 stat 的 mode 直接反映只读属性位 */
function isWritable(file) {
  return (statSync(file).mode & 0o200) !== 0
}

function ledgerPath(root) {
  return join(root, LEDGER_RELATIVE)
}

function readLedger(root) {
  const file = ledgerPath(root)
  if (!existsSync(file)) return { entries: [] }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(parsed?.entries) ? parsed : { entries: [] }
  } catch {
    fail(`台账文件损坏，无法安全还原，请人工检查：${file}`)
    return { entries: [] }
  }
}

function writeLedger(root, ledger) {
  const file = ledgerPath(root)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(ledger, null, 2), 'utf8')
}

// ----------------------------------------------------------------------------
// 命令
// ----------------------------------------------------------------------------

function cmdStatus(root) {
  const sc = detectSourceControl(root)
  console.log(`工程：${root}`)
  console.log(
    sc.enabled ? `版本控制：已启用（${sc.provider}）—— lock 会被拒绝` : '版本控制：未启用'
  )

  const ledger = readLedger(root)
  if (ledger.entries.length === 0) {
    console.log('台账：空（没有本脚本翻过的位）')
    return
  }

  console.log(`台账：${ledger.entries.length} 条`)
  for (const entry of ledger.entries) {
    const exists = existsSync(entry.file)
    const actual = exists ? (isWritable(entry.file) ? '可写' : '只读') : '文件已不存在'
    // 台账说该是只读、实际却可写，说明有人（用户点了 Make Writable、或别的工具）
    // 把位改回去了。这不是错误，但要报出来 —— 它意味着锁已经失效
    const drift = exists && isWritable(entry.file) ? '  ← 位已被外部改回可写' : ''
    console.log(`  ${entry.package}\n    ${actual}${drift}\n    ${entry.file}`)
  }
}

function cmdLock(root, packages) {
  if (packages.length === 0) fail('lock 至少要给一个包路径，例如 /Game/Materials/M_Test')

  const sc = detectSourceControl(root)
  if (sc.enabled) {
    fail(
      `这个工程启用了版本控制（${sc.provider}，见 ${sc.file}）。\n` +
        '  只读位归版本控制管，本脚本拒绝插手 —— 翻了会让签出状态和磁盘对不上。'
    )
  }

  const ledger = readLedger(root)
  const known = new Set(ledger.entries.map((entry) => entry.file))

  for (const raw of packages) {
    // 台账里存归一后的路径，否则 unlock 时 `/Game/Foo` 对不上被 MSYS 转过的那份
    const pkg = normalizePackagePath(raw)
    const file = packageToFile(root, pkg)
    if (!file) {
      console.log(`- ${pkg}：磁盘上没有对应文件（可能是新建还没存过的资产），跳过`)
      continue
    }
    if (known.has(file)) {
      console.log(`- ${pkg}：台账里已有，跳过`)
      continue
    }
    if (!isWritable(file)) {
      // 原本就只读 —— 不是我们翻的，不记账也不动。否则 unlock 时会把一个
      // 本来就该只读的文件"还原"成可写
      console.log(`- ${pkg}：原本就是只读，不接管`)
      continue
    }

    // 先记账再翻位。反过来的话，翻完崩在写台账之前，就会留下一个没人认领的
    // 只读文件 —— 用户的工程从此存不了，而且查不出原因
    ledger.entries.push({ package: pkg, file, originalWritable: true })
    writeLedger(root, ledger)

    chmodSync(file, 0o444)

    // 回读校验。没读回来就不算成功 —— 报一个没生效的锁比不加锁更危险
    if (isWritable(file)) {
      fail(`已写台账但只读位没生效：${file}\n  请先跑 restore 把台账清干净再排查`)
    }
    console.log(`✔ ${pkg} 已锁（只读）`)
  }
}

function restoreEntries(root, ledger, entries) {
  const restored = new Set()

  for (const entry of entries) {
    if (!existsSync(entry.file)) {
      console.log(`- ${entry.package}：文件已不存在，仅清台账`)
      restored.add(entry.file)
      continue
    }

    chmodSync(entry.file, 0o666)

    if (!isWritable(entry.file)) {
      // 还原失败就把台账留着 —— 下次 restore 还能再试。清了才是真丢
      console.error(`✖ ${entry.package}：还原失败，台账保留：${entry.file}`)
      continue
    }
    console.log(`✔ ${entry.package} 已解锁（可写）`)
    restored.add(entry.file)
  }

  ledger.entries = ledger.entries.filter((entry) => !restored.has(entry.file))
  if (ledger.entries.length === 0) {
    rmSync(ledgerPath(root), { force: true })
  } else {
    writeLedger(root, ledger)
  }
}

function cmdUnlock(root, packages) {
  const ledger = readLedger(root)
  if (ledger.entries.length === 0) {
    console.log('台账为空，没有要解锁的')
    return
  }

  const wanted = new Set(packages.map(normalizePackagePath))
  const targets =
    wanted.size === 0 ? ledger.entries : ledger.entries.filter((entry) => wanted.has(entry.package))

  if (targets.length === 0) {
    console.log('台账里没有这些包，什么都没做')
    return
  }
  restoreEntries(root, ledger, targets)
}

/**
 * 崩溃恢复演练。
 *
 * 正式方案里盒子每次启动的第一件事就是这一步：读台账、把还标着的位全还原。
 * 不带参数、不问理由、全量还原 —— 因为真出事的时候，没人知道该还哪几个。
 */
function cmdRestore(root) {
  const ledger = readLedger(root)
  if (ledger.entries.length === 0) {
    console.log('台账为空，无需还原')
    return
  }
  console.log(`台账 ${ledger.entries.length} 条，全部还原：`)
  restoreEntries(root, ledger, [...ledger.entries])
}

// ----------------------------------------------------------------------------

const USAGE = `只读位资产锁 —— 非侵入性技术探针

  node scripts/readonly-lock-probe.mjs status  <工程>
  node scripts/readonly-lock-probe.mjs lock    <工程> /Game/Foo /Game/Bar
  node scripts/readonly-lock-probe.mjs unlock  <工程> [/Game/Foo ...]
  node scripts/readonly-lock-probe.mjs restore <工程>

<工程> 可以是 .uproject 文件或工程目录。
不碰盒子和插件的任何生产代码；只翻原本可写的文件，全部记台账。
`

function main() {
  const [command, project, ...rest] = process.argv.slice(2)
  if (!command || command === '--help' || command === '-h') {
    console.log(USAGE)
    return
  }

  const KNOWN = ['status', 'lock', 'unlock', 'restore']
  if (!KNOWN.includes(command)) fail(`不认识的命令「${command}」，只认：${KNOWN.join('、')}`)

  const { root } = resolveProject(project)

  if (command === 'status') cmdStatus(root)
  else if (command === 'lock') cmdLock(root, rest)
  else if (command === 'unlock') cmdUnlock(root, rest)
  else cmdRestore(root)
}

main()
