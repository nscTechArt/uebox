/**
 * 只读位 —— 资产锁 B 阶段：真的拦住用户手动保存。
 *
 * ## 为什么是文件系统的位，而不是引擎 API
 *
 * UE 认文件系统的只读位，就是 Perforce 独占签出用的那个位。引擎在三处认它
 * （`Engine/Source/Editor/UnrealEd/Private/FileHelpers.cpp`）：保存时弹框硬拒、
 * Save All 静默跳过、进签出对话框带一个 "Make Writable"。
 *
 * 它不是 API 而是文件系统行为，所以 **5.0–5.8 九个版本通吃**，不需要版本适配，
 * 也不需要改插件。前置实测（`scripts/readonly-lock-probe.mjs`，真机跑完整闭环）
 * 证明它挡得住引擎，也挡得住我们自己的插件 —— 插件走的是低层 `UPackage::Save`，
 * 绕开了编辑器那套只读检查 UI，但仍然被文件系统挡下，不存在「报成功但没写进去」。
 *
 * ## 所以锁必须「对别人只读，对持有者可写」
 *
 * 一直锁着的话 agent 自己的活也落不了盘 —— 那不叫锁，叫把文件冻死。
 * 做法是：**持有者要动手之前把位清掉，做完立刻翻回来**（见 `registry.ts` 的
 * `withAssetLock`）。清位窗口就是一次工具调用的时间，用户要正好在那个窗口里
 * 按 Ctrl+S 才漏得过去。
 *
 * 清位期间**不动台账** —— 台账仍然记着「这个文件被我们接管了」。方向是安全的：
 * 万一此刻崩了，下次还原只是把一个已经可写的文件再设成可写，无害。反过来
 * （清位时把台账也删掉）才会留下真正的孤儿。
 *
 * ## 四条安全约束（全部来自设计评审，别自作主张放宽）
 *
 * 1. **工程启用了版本控制就整个不启用这一层。** 那个位归 Perforce 管，我们乱翻
 *    会让签出状态和磁盘对不上，而用户会怪到编辑器头上，永远查不到是谁干的。
 * 2. **只翻原本可写的文件。** 原本就只读的一律不碰，也不「还原」成可写 ——
 *    那不是我们翻的位。
 * 3. **台账先落盘再翻位。** 反过来的话，翻完崩在写台账之前就会留下一个没人认领的
 *    只读文件，用户的工程从此存不了，而且查不出原因。
 * 4. **翻位后回读校验**，读不回来就不算成功 —— 报一个没生效的锁比不加锁更危险。
 *
 * 设计与实测数据。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { resolveExistingPackageFile } from './assetSnapshotPaths'

/** 台账放 `Saved/` 底下 —— UE 约定里那是不进版本库的目录，和快照同一个根 */
const LEDGER_RELATIVE = path.join('Saved', 'UnrealBox', 'readonly-ledger.json')

/** 一条台账：我们把这个文件从可写翻成了只读 */
export interface ReadonlyLedgerEntry {
  /** 包路径，如 `/Game/Materials/M_Rock` */
  packagePath: string
  /** 磁盘上的绝对路径 */
  file: string
  at: number
}

interface Ledger {
  entries: ReadonlyLedgerEntry[]
}

export interface SourceControlState {
  enabled: boolean
  provider?: string
  /** 从哪个 ini 判定出来的，报错时给用户看 */
  file?: string
}

/**
 * 版本控制探测结果按工程缓存。
 *
 * 这个探测挂在每个写工具的 `finally` 上，不缓存的话一轮 run 就是几百次 ini
 * 探测，而这个答案在一轮里不会变。
 *
 * **缓存必须在工程连上来时作废**（`invalidateSourceControlCache`）。一度写的是
 * 「重连时 `restoreLedger` 本来就会把位还回去，所以缓存过期没关系」—— 那个理由
 * 不再成立：`restoreLedger` 会**跳过当前仍被持有的锁**。用户在 agent 跑着的时候
 * 给工程接上 Perforce、编辑器再重启一次，那批位既不会被还原、缓存又还说着
 * 「没启用」，本进程剩下的时间里我们会一直在一个 Perforce 管着的工程上翻只读位。
 */
const sccCache = new Map<string, SourceControlState>()

/**
 * 让这个工程的版本控制判定重新探一次。
 *
 * 工程连上来时调 —— 那是「用户可能在这中间改过工程配置」唯一可观测的时刻。
 */
export function invalidateSourceControlCache(projectRoot: string): void {
  sccCache.delete(projectRoot)
}

/**
 * 工程有没有启用版本控制。
 *
 * **宁可误报「启用了」而放弃保护，也不能误判成没启用然后去翻 Perforce 管着的位。**
 * 前者只是少一层增强，后者会让用户的签出状态和磁盘对不上。
 */
export function detectSourceControl(projectRoot: string): SourceControlState {
  const cached = sccCache.get(projectRoot)
  if (cached) return cached

  const state = probeSourceControl(projectRoot)
  sccCache.set(projectRoot, state)
  return state
}

function probeSourceControl(projectRoot: string): SourceControlState {
  const candidates = [
    path.join(projectRoot, 'Saved', 'Config', 'WindowsEditor', 'SourceControlSettings.ini'),
    path.join(projectRoot, 'Saved', 'Config', 'Windows', 'SourceControlSettings.ini'),
    path.join(projectRoot, 'Config', 'DefaultSourceControlSettings.ini')
  ]

  for (const file of candidates) {
    let text: string
    try {
      if (!existsSync(file)) continue
      // 同步读：这是几百字节的 ini，而调用点在工具执行路径上，
      // 为它多一次 await 调度不划算
      text = readFileSync(file, 'utf8')
    } catch {
      // 读不出来当成「可能启用了」—— 见上面那条「宁可误报」
      return { enabled: true, file }
    }

    const match = text.match(/^\s*Provider\s*=\s*(.+)$/m)
    const provider = match?.[1]?.trim()
    if (provider && provider.toLowerCase() !== 'none') {
      return { enabled: true, provider, file }
    }
  }
  return { enabled: false }
}

/**
 * `/Game/Foo/Bar` → `<工程>/Content/Foo/Bar.uasset`（或 `.umap`）。
 *
 * 只是 `resolveExistingPackageFile` 的转发。映射规则**只有那一份**
 * （`assetSnapshotPaths.ts`）：快照和只读位都拿 `/Game/` 换磁盘路径，
 * 各写各的话将来加新内容根只会改到一处，而漏掉的那处不会立刻暴露。
 */
export function packageToFile(projectRoot: string, packagePath: string): string | null {
  return resolveExistingPackageFile(projectRoot, packagePath)
}

/** 文件当前可写吗。Windows 上 stat 的 mode 直接反映只读属性位 */
function isWritable(file: string): boolean {
  try {
    return (statSync(file).mode & 0o200) !== 0
  } catch {
    return false
  }
}

function ledgerPath(projectRoot: string): string {
  return path.join(projectRoot, LEDGER_RELATIVE)
}

/**
 * 台账在内存里的那一份。盒子是台账的唯一写者，所以缓存住就不用每次读盘。
 *
 * 仍然会在写之前确认盘上那个文件还在（`ensureLedgerOnDisk`）—— 用户手动清了
 * `Saved/` 的话，缓存说有、盘上没有，那才是真会留下孤儿的状态。
 */
const ledgerCache = new Map<string, Ledger>()

/**
 * 每个工程一条串行队列。
 *
 * 台账是读-改-写，而**同一批工具是并发跑的**（见 `defineTool.ts` 的
 * `concurrency`）。不串行的话两个 `protectPackages` 会各自读到同一份旧台账、
 * 各自写回自己那份，后写的把先写的条目抹掉 —— 而先写的那个文件的只读位
 * 已经翻上去了。结果是用户工程里躺着一个存不进去、且台账里查不到的资产，
 * 正是「安全约束 3」要防的后果。
 */
const ledgerChains = new Map<string, Promise<unknown>>()

async function loadLedger(projectRoot: string): Promise<Ledger> {
  const cached = ledgerCache.get(projectRoot)
  if (cached) return cached

  let ledger: Ledger = { entries: [] }
  try {
    const parsed = JSON.parse(await readFile(ledgerPath(projectRoot), 'utf8'))
    if (Array.isArray(parsed?.entries)) ledger = parsed as Ledger
  } catch {
    // 文件不存在是常态；损坏则当空处理并让下一次写覆盖掉 —— 台账损坏时
    // 唯一比「丢台账」更糟的是「因为读不出台账而整个功能瘫掉」
  }
  ledgerCache.set(projectRoot, ledger)
  return ledger
}

async function writeLedger(projectRoot: string, ledger: Ledger): Promise<void> {
  const file = ledgerPath(projectRoot)

  if (ledger.entries.length === 0) {
    await rm(file, { force: true })
  } else {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify(ledger, null, 2), 'utf8')
  }

  // 写通了才更新缓存。**失败时不动它** —— 一度是「写不进去就把缓存删掉，别让
  // 内存那份冒充已落盘」，那样会留下更难缠的状态：调用方是就地改 `ledger.entries`
  // 的，删掉缓存之后它手里还攥着同一个对象继续增删，收尾还可能把这个游离对象
  // 重新塞回缓存。保持内存那份是权威，落盘失败交给 `ensureLedgerOnDisk` 一直重试。
  ledgerCache.set(projectRoot, ledger)
  ledgerWriteFailureReported.delete(projectRoot)
}

/**
 * 测试用：让**下一次**台账操作抛一个异常。
 *
 * 只为验一条：操作抛的时候，收尾的「台账还在盘上吗」照样跑。那是那段 `finally`
 * 存在的全部理由，而从公开接口很难可靠地造出一次抛异常。
 *
 * 只让一次操作失败，不收任意回调 —— 收回调的版本能把任意代码塞进台账的临界区，
 * 一个死循环就能把这个工程的台账队列永久卡死。
 */
let throwOnNextLedgerOp = false

export function throwOnNextLedgerOpForTest(): void {
  throwOnNextLedgerOp = true
}

/** 排队本身。`ensure` 决定收尾要不要补写台账 —— 只读路径不该改磁盘状态 */
function queueOnLedger<T>(
  projectRoot: string,
  fn: (ledger: Ledger) => Promise<T>,
  ensure: boolean
): Promise<T> {
  const previous = ledgerChains.get(projectRoot) ?? Promise.resolve()
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const ledger = await loadLedger(projectRoot)
      if (!ensure) return fn(ledger)
      try {
        if (throwOnNextLedgerOp) {
          throwOnNextLedgerOp = false
          throw new Error('throwOnNextLedgerOpForTest')
        }
        return await fn(ledger)
      } finally {
        // finally 而不是直线执行：`fn` 抛出来的时候内存台账很可能已经带上了新条目
        // （`protectPackages` 是先 push 再写盘的），那正是最需要这道补写的时刻
        await ensureLedgerOnDisk(projectRoot, ledger)
      }
    })

  // 队尾记的是「吞掉异常」的那一版，否则一次失败会把后面全部连坐
  ledgerChains.set(
    projectRoot,
    next.catch(() => undefined)
  )
  return next
}

/**
 * 把这个工程的台账**改动**排到队尾，保证同一时刻只有一个在读-改-写。
 *
 * 收尾统一补一次「台账还在盘上吗」：缓存说有条目、盘上却没有文件，就是用户手动
 * 删了 `Saved/` 之后的状态。放在这一处而不是各调用点，是因为 protect / suspend /
 * unprotect / restore 全都经过这里，漏一个就是一个静默的洞。
 */
function withLedger<T>(projectRoot: string, fn: (ledger: Ledger) => Promise<T>): Promise<T> {
  return queueOnLedger(projectRoot, fn, true)
}

/**
 * 只读地看一眼台账，同样排队，但**不碰磁盘**。
 *
 * 给 `countProtected` 用。读一个计数不该顺带修盘上的状态；而完全不排队又会让
 * 并发那组测例的主断言可能读到读-改-写的中间值 —— 那种测试会时红时绿。
 */
function readLedger<T>(projectRoot: string, fn: (ledger: Ledger) => Promise<T>): Promise<T> {
  return queueOnLedger(projectRoot, fn, false)
}

/** 测试用：把台账和版本控制的缓存全清掉 */
export function resetReadonlyGuardCaches(): void {
  ledgerCache.clear()
  ledgerChains.clear()
  sccCache.clear()
  ledgerWriteFailureReported.clear()
  throwOnNextLedgerOp = false
}

export interface ProtectOutcome {
  /** 真的翻成只读了的包路径。界面文案能不能说「保存会被拦下」就看它 */
  enforced: string[]
  /** 没能保护的，附原因 */
  skipped: Array<{ packagePath: string; reason: string }>
}

/**
 * 把这些包设成只读，并记账。
 *
 * 幂等：已经在台账里的直接算成功，不重复翻位。
 */
export async function protectPackages(
  projectRoot: string,
  packagePaths: string[]
): Promise<ProtectOutcome> {
  const outcome: ProtectOutcome = { enforced: [], skipped: [] }
  if (packagePaths.length === 0) return outcome

  const scc = detectSourceControl(projectRoot)
  if (scc.enabled) {
    for (const packagePath of packagePaths) {
      outcome.skipped.push({
        packagePath,
        reason: `工程启用了版本控制（${scc.provider ?? '未知 provider'}），只读位归它管`
      })
    }
    return outcome
  }

  return withLedger(projectRoot, async (ledger) => {
    const known = new Map(ledger.entries.map((entry) => [entry.file, entry]))

    /** 这一批里新接管的（还没翻位）。攒着，为的是台账只写一次 */
    const fresh: Array<{ packagePath: string; file: string }> = []

    for (const packagePath of packagePaths) {
      const file = packageToFile(projectRoot, packagePath)
      if (!file) {
        outcome.skipped.push({ packagePath, reason: '磁盘上没有对应文件（可能还没存过）' })
        continue
      }

      if (known.has(file)) {
        // 台账里已有，但位可能被外部改回去了（用户点了 "Make Writable"）。
        // 顺手补翻一次，别让锁静悄悄失效
        if (isWritable(file)) await chmod(file, 0o444).catch(() => undefined)
        if (isWritable(file)) {
          outcome.skipped.push({ packagePath, reason: '只读位被外部改回可写，补翻没成功' })
        } else {
          outcome.enforced.push(packagePath)
        }
        continue
      }

      if (!isWritable(file)) {
        // 原本就只读 —— 不是我们翻的，不记账也不动。记了的话解锁时会把一个
        // 本来就该只读的文件「还原」成可写
        outcome.skipped.push({ packagePath, reason: '文件原本就是只读，不接管' })
        continue
      }

      const entry: ReadonlyLedgerEntry = { packagePath, file, at: Date.now() }
      ledger.entries.push(entry)
      known.set(file, entry)
      fresh.push({ packagePath, file })
    }

    if (fresh.length === 0) {
      await ensureLedgerOnDisk(projectRoot, ledger)
      return outcome
    }

    // **整批记完账再翻位**（安全约束 3：台账必须先落盘）。攒成一次写而不是
    // 每条写一遍 —— 顺序不变，落盘时机不变，只是少了 N-1 次整份重写
    await writeLedger(projectRoot, ledger)

    const rejected = new Set<string>()
    for (const { packagePath, file } of fresh) {
      try {
        await chmod(file, 0o444)
      } catch (error) {
        rejected.add(file)
        outcome.skipped.push({ packagePath, reason: `翻只读位失败：${String(error)}` })
        continue
      }

      // 回读校验（安全约束 4）。没生效就把台账撤回来，绝不报成功
      if (isWritable(file)) {
        rejected.add(file)
        outcome.skipped.push({ packagePath, reason: '翻了位但回读仍然可写，不算数' })
        continue
      }

      outcome.enforced.push(packagePath)
    }

    if (rejected.size > 0) {
      ledger.entries = ledger.entries.filter((entry) => !rejected.has(entry.file))
      await writeLedger(projectRoot, ledger)
    }

    return outcome
  })
}

/**
 * 缓存说有条目、盘上却没有台账文件时补写一次。
 *
 * 用户手动清掉 `Saved/` 之后就是这个状态：内存里记着我们接管了几个文件，
 * 盘上什么都没有 —— 此刻崩掉就是真孤儿。
 */
async function ensureLedgerOnDisk(projectRoot: string, ledger: Ledger): Promise<void> {
  if (ledger.entries.length === 0) return
  if (existsSync(ledgerPath(projectRoot))) return

  const files = ledger.entries.map((entry) => entry.file)
  try {
    await writeLedger(projectRoot, ledger)
  } catch (error) {
    // 盘上没有台账 = 这些文件仍然只读，而盒子从此不知道它们的存在：本轮结束时
    // `unprotectPackages` 找不到条目，下次连接时 `restoreLedger` 也找不到。
    // 唯一还能做的是把路径喊出来 —— 不喊的话用户只会发现「这几个资产怎么存不了」。
    //
    // **只喊一次。** 补写挂在每次台账操作的收尾上，一轮 run 上百次；不去重就是
    // 几千行一模一样的告警把日志刷穿，而这条恰恰是唯一的线索。
    if (ledgerWriteFailureReported.has(projectRoot)) return
    ledgerWriteFailureReported.add(projectRoot)
    console.warn(
      `[AgentV3] 只读台账写不进去（${String(error)}），以下资产可能保持只读且无人认领：\n` +
        files.join('\n')
    )
  }
}

/** 已经就这个工程报过「台账写不进去」了。写成功一次就清掉，下次再坏还能再报 */
const ledgerWriteFailureReported = new Set<string>()

/**
 * 临时放行持有者的写入：清位，但**不动台账**。
 *
 * agent 自己保存前必须走这一步 —— 只读位挡得住我们自己的插件（实测），
 * 不清位的话 agent 的活也落不了盘。
 *
 * @returns 清位**失败**的包路径。绝不静默吞掉：清不掉的话工具随后的落盘会被
 *   引擎报成「文件只读」，而真正的原因是我们自己没能把位放开 —— 不说出来的话
 *   这类问题在真机上完全无从下手。
 */
export async function suspendProtection(
  projectRoot: string,
  packagePaths: string[]
): Promise<string[]> {
  if (packagePaths.length === 0) return []

  const failed: string[] = []

  await withLedger(projectRoot, async (ledger) => {
    if (ledger.entries.length === 0) return

    const owned = new Set(ledger.entries.map((entry) => entry.file))
    for (const packagePath of packagePaths) {
      const file = packageToFile(projectRoot, packagePath)
      if (!file || !owned.has(file)) continue

      try {
        await chmod(file, 0o666)
      } catch {
        /* 下面统一按回读结果判定 */
      }
      if (!isWritable(file)) failed.push(packagePath)
    }
  })

  return failed
}

/**
 * 彻底解除保护：清位 + 销账。
 *
 * 还原失败的**保留台账** —— 下次启动还能再试。清了才是真的丢。
 *
 * 匹配按台账里存着的 `packagePath` 走，**不拿包路径去磁盘上反查**：
 * 反查依赖文件此刻还在，而 agent 完全可能在这一轮里把它改名或删掉，
 * 那样这条就永远匹配不上、烂在台账里。
 */
export async function unprotectPackages(
  projectRoot: string,
  packagePaths: string[]
): Promise<number> {
  if (packagePaths.length === 0) return 0

  return withLedger(projectRoot, async (ledger) => {
    if (ledger.entries.length === 0) return 0

    const wanted = new Set(packagePaths.map((p) => p.toLowerCase()))
    const released = await releaseEntries(
      ledger,
      ledger.entries.filter((entry) => wanted.has(entry.packagePath.toLowerCase()))
    )
    if (released > 0) await writeLedger(projectRoot, ledger)
    return released
  })
}

/**
 * 把台账上还标着的位全部还原。
 *
 * 这是「进程崩了留下只读文件」唯一的兜底，在**工程连上来的那一刻**跑：
 * 那正是用户开始用这个工程的时刻，也是残留只读位会咬人的时刻。
 *
 * @param keepPackagePaths 这些包**跳过**。工程重连时当前会话可能正握着锁，
 *   把它们一起还原掉的话，界面还在说「保存会被拦下」而位已经没了 —— 那是
 *   文案红线上最坏的一种假话。
 */
export async function restoreLedger(
  projectRoot: string,
  keepPackagePaths: string[] = []
): Promise<number> {
  return withLedger(projectRoot, async (ledger) => {
    if (ledger.entries.length === 0) return 0

    const keep = new Set(keepPackagePaths.map((p) => p.toLowerCase()))
    const stale = ledger.entries.filter((entry) => !keep.has(entry.packagePath.toLowerCase()))
    if (stale.length === 0) return 0

    const released = await releaseEntries(ledger, stale)
    if (released > 0) await writeLedger(projectRoot, ledger)
    return released
  })
}

async function releaseEntries(ledger: Ledger, entries: ReadonlyLedgerEntry[]): Promise<number> {
  const done = new Set<string>()

  for (const entry of entries) {
    if (!existsSync(entry.file)) {
      // 文件没了（被删/被移走），台账没有保留的意义
      done.add(entry.file)
      continue
    }

    await chmod(entry.file, 0o666).catch(() => undefined)
    if (isWritable(entry.file)) done.add(entry.file)
  }

  ledger.entries = ledger.entries.filter((entry) => !done.has(entry.file))
  return done.size
}

/** 台账上现在还标着多少个（诊断 / 测试用） */
export async function countProtected(projectRoot: string): Promise<number> {
  return readLedger(projectRoot, async (ledger) => ledger.entries.length)
}
