/**
 * 把资产锁接到只读位上 —— A 阶段（会话间互斥）和 B 阶段（拦用户手动保存）的接缝。
 *
 * 锁表只知道包路径和 `connectionId`，只读位要的是磁盘绝对路径，中间差一个
 * 「这条连接是哪个工程」。这个模块只干这一件事，外加两个时机：
 *
 *   - **持有者要动手之前** → `suspendForWrite`：清位，否则 agent 自己也写不进去
 *   - **持有者做完之后** → `enforceAfterWrite`：立刻翻回来
 *
 * 拆成单独一个文件是为了能测：`assetReadonlyGuard` 是纯 fs，`registry.ts` 一
 * import 就把整个工具注册表拽进来，只有中间这层能注入依赖单独跑。
 */

import {
  invalidateSourceControlCache,
  protectPackages,
  restoreLedger,
  suspendProtection,
  unprotectPackages,
  type ProtectOutcome
} from './assetReadonlyGuard'
import type { LockRecord } from './assetLock'

/** 把 `connectionId` 换成工程根目录。测试里替掉它 */
export type ProjectRootResolver = (connectionId: string | undefined) => Promise<string | undefined>

/**
 * 默认解析：问工程管理器。
 *
 * 懒加载 `projectManager` —— 它经由 `../logger` 拽进服务容器，而这个模块被
 * `registry.ts` 引用，也就是每个工具的入口。静态引用会让所有摸到注册表的测试
 * 都去加载原生模块（见 AGENTS.md §7 的 `appSettingsManager` 陷阱）。
 */
const defaultResolver: ProjectRootResolver = async (connectionId) => {
  const { projectManager } = await import('../../services/project/projectManager')

  const info = connectionId
    ? projectManager.getProject(connectionId)
    : // 没指定目标连接时只在**恰好一条**的情况下回退。多条连接时猜错的代价是
      // 去翻另一个工程的文件，宁可不做
      ((): { projectPath?: string } | undefined => {
        const all = projectManager.getInteractiveProjects()
        return all.length === 1 ? all[0] : undefined
      })()

  const uproject = info?.projectPath
  if (!uproject) return undefined

  // projectPath 是 .uproject 文件；只读位要的是工程目录
  const normalized = uproject.replace(/\\/g, '/')
  return normalized.endsWith('.uproject')
    ? normalized.slice(0, normalized.lastIndexOf('/'))
    : normalized
}

let resolveProjectRoot: ProjectRootResolver = defaultResolver

/** 测试用：换掉工程根目录的解析方式 */
export function setProjectRootResolver(resolver: ProjectRootResolver | undefined): void {
  resolveProjectRoot = resolver ?? defaultResolver
}

/**
 * 哪些包此刻真的被只读位护着。界面文案能不能说「保存会被拦下」就看它。
 *
 * 键带 `connectionId` —— 和锁表同一套：盒子可以同时连多个工程，只按路径记的话
 * A 工程翻上去的位会让 B 工程里同名的资产也显示成「保存会被拦下」。
 * 路径取小写，免得大小写不同被当成两个。
 */
const enforcedPaths = new Set<string>()

/**
 * 分隔符用 NUL，和 `assetLock.ts` 的 `keyOf` 保持同一套。
 *
 * 那是包路径里不可能出现的字节，拼出来的键没有歧义。用空格的话，只要
 * `connectionId` 里出现一个空格（它的格式没在任何地方被约束住），两个不同的
 * (连接, 路径) 组合就能撞成同一个键 —— 表现为 A 工程的资产被算成 B 工程的
 * 已拦截状态，进而在界面上说错话。
 */
function keyOf(connectionId: string | undefined, packagePath: string): string {
  return `${connectionId ?? ''}\0${packagePath.toLowerCase()}`
}

/** 当前被只读位真正护住的包路径（原样，不是小写） */
export function listEnforced(locks: LockRecord[]): string[] {
  return locks
    .filter((lock) => enforcedPaths.has(keyOf(lock.connectionId, lock.path)))
    .map((lock) => lock.path)
}

/** 测试用：把「哪些位翻上去了」和清位引用计数一并清空 */
export function resetEnforcementState(): void {
  enforcedPaths.clear()
  suspendCounts.clear()
}

type EnforcementChangeListener = () => void
let enforcementListener: EnforcementChangeListener | undefined

/**
 * 只读位的开合要能触发一次重推。
 *
 * 锁表本身没变（还是那几个包），但**文案变了**：从「会互相覆盖」变成
 * 「保存会被拦下」。不通知的话插件那边会一直显示保守版本，
 * 用户以为自己还能存，其实早就存不进去了。
 */
export function setEnforcementChangeListener(fn: EnforcementChangeListener | undefined): void {
  enforcementListener = fn
}

type RepublishTrigger = () => void
let republishTrigger: RepublishTrigger | undefined

/**
 * 注册「把锁状态整份重推一次」的动作，由 ipc 层接上。
 *
 * 和 `setEnforcementChangeListener` 是同一个套路：**方向必须是 ipc 层往下注册**，
 * 不能让消息层反过来 import `ipc/agentV3`（AGENTS.md §4 把主进程 IPC 定为
 * `src/main/ipc/` 那一层的入口）。反过来写的话，那条动态 import 会把整个
 * `ipc/agentV3` 依赖图 —— electron 的 webContents、服务容器 —— 拉进消息处理
 * 路径，而那条路在无头模式和单测里是要能单独跑起来的。
 */
export function setLockRepublishTrigger(fn: RepublishTrigger | undefined): void {
  republishTrigger = fn
}

function notifyEnforcementChanged(): void {
  try {
    enforcementListener?.()
  } catch {
    /* 通知失败不影响位本身 */
  }
}

function remember(connectionId: string | undefined, outcome: ProtectOutcome): void {
  let changed = false

  for (const packagePath of outcome.enforced) {
    // 逐个看加没加进去，**不比集合基数**：同一次 outcome 里一增一减时基数不变，
    // 按基数判就永远不通知，插件那边一半资产的文案会停在错的那一档
    if (!enforcedPaths.has(keyOf(connectionId, packagePath))) changed = true
    enforcedPaths.add(keyOf(connectionId, packagePath))
  }
  for (const { packagePath } of outcome.skipped) {
    if (enforcedPaths.delete(keyOf(connectionId, packagePath))) changed = true
  }

  if (changed) notifyEnforcementChanged()
}

/** 按连接分组。盒子可以同时连多个工程，一批锁可能横跨两个 */
function groupByConnection(locks: LockRecord[]): Map<string | undefined, string[]> {
  const byConnection = new Map<string | undefined, string[]>()
  for (const lock of locks) {
    const list = byConnection.get(lock.connectionId)
    if (list) list.push(lock.path)
    else byConnection.set(lock.connectionId, [lock.path])
  }
  return byConnection
}

/**
 * 持有者要写了，先把位清掉。
 *
 * **传的必须是这条会话手上的全部锁，不是这次调用参数里那几个。** 很多工具落盘的
 * 不是自己参数里那个资产：`ue_save` 参数里根本没有路径，它存的是这一轮所有被改脏
 * 的包；编译蓝图会顺带改脏依赖它的资产。只清参数里那几个的话，agent 自己的保存
 * 会被自己几步之前加的位挡下 —— 而且报出来的是「文件只读」，看着像用户的锅。
 *
 * **不动台账** —— 台账仍然记着「这个文件被我们接管了」。方向是安全的：此刻崩了，
 * 下次还原只是把一个已经可写的文件再设成可写，无害。反过来才会留下真孤儿。
 *
 * 一路吞异常：只读位是增强层，它出问题绝不能让工具本身失败。清位**失败**则不吞，
 * 记一条日志 —— 清不掉的话工具的落盘会被引擎报成「文件只读」，不说出来的话
 * 这类问题在真机上完全无从下手。
 *
 * ## 引用计数
 *
 * 同一批工具是并发跑的（见 `defineTool.ts` 的 `concurrency`），而它们的 `held`
 * 互相包含。没有计数的话先返回的那个会在兄弟工具**还在写盘时**把位翻回去，
 * agent 自己的保存被自己会话几毫秒前加的位挡下。所以每个包记一个「还有几个
 * 调用正开着它」，减到 0 才真的翻回来。
 */
const suspendCounts = new Map<string, number>()

export async function suspendForWrite(locks: LockRecord[]): Promise<void> {
  if (locks.length === 0) return

  for (const [connectionId, packagePaths] of groupByConnection(locks)) {
    // 计数先加，再去清位：加在 await 之前，兄弟调用才不可能在这中间
    // 看到 0 而把位翻回来
    const firstOpen: string[] = []
    for (const packagePath of packagePaths) {
      const key = keyOf(connectionId, packagePath)
      const next = (suspendCounts.get(key) ?? 0) + 1
      suspendCounts.set(key, next)
      if (next === 1) firstOpen.push(packagePath)
    }
    if (firstOpen.length === 0) continue

    try {
      const root = await resolveProjectRoot(connectionId)
      if (!root) continue
      const failed = await suspendProtection(root, firstOpen)
      if (failed.length > 0) {
        console.warn(
          `[AgentV3] 只读位没能清掉，这些资产的写入可能被自己的锁挡下：${failed.join('、')}`
        )
      }
    } catch {
      /* 增强层，坏了不影响工具 */
    }
  }
}

/**
 * 持有者做完了，立刻把位翻回来。
 *
 * 挂在工具的 `finally` 上，所以模型报错、用户按停止、异常抛穿都覆盖得到。
 * 同样传全部锁 —— 和 `suspendForWrite` 一开一合必须对称，否则计数会对不上。
 *
 * 只翻**引用计数归零**的那些：兄弟调用还开着的包留着不动，见上面那段说明。
 */
export async function enforceAfterWrite(locks: LockRecord[]): Promise<void> {
  if (locks.length === 0) return

  for (const [connectionId, packagePaths] of groupByConnection(locks)) {
    const lastClose: string[] = []
    for (const packagePath of packagePaths) {
      const key = keyOf(connectionId, packagePath)
      const next = (suspendCounts.get(key) ?? 1) - 1
      if (next <= 0) {
        suspendCounts.delete(key)
        lastClose.push(packagePath)
      } else {
        suspendCounts.set(key, next)
      }
    }
    if (lastClose.length === 0) continue

    try {
      const root = await resolveProjectRoot(connectionId)
      if (!root) continue
      remember(connectionId, await protectPackages(root, lastClose))
    } catch {
      /* 同上 */
    }
  }
}

/**
 * 删资产之前，把盒子自己翻在这些包上的只读位清掉并销账。
 *
 * ## 为什么删除这一条要单独来一次
 *
 * 只读的 `.uasset` 引擎**删不掉，而且一声不吭**：`ObjectTools` 里那个
 * 「文件只读，仍要删吗」的对话框在无人值守模式下默认答「否」，整个资产被跳过，
 * `ForceDeleteObjects` 只返回 0（2026-09-16 在 UE 5.5 上实测：只读时
 * `delete_asset` 返回 False 文件还在，清掉位立刻删得掉）。
 *
 * 正常路径上这个位在每次写工具调用期间是清着的（`suspendForWrite`），但那只覆盖
 * **这条会话此刻手上的锁**。台账里的陈年条目（盒子上次崩在还原之前）不在其中 ——
 * 那种位会让删除莫名其妙地失败，而失败原因指向引擎。
 *
 * 销账是对的：资产马上就没了，留着条目只会让下次还原去 chmod 一个不存在的文件。
 * 删失败也不亏 —— 这次调用收尾时 `enforceAfterWrite` 会把还在的文件重新翻上去。
 */
export async function releaseProtectionBeforeDelete(
  connectionId: string | undefined,
  packagePaths: string[]
): Promise<void> {
  if (packagePaths.length === 0) return

  try {
    const root = await resolveProjectRoot(connectionId)
    if (!root) return
    await unprotectPackages(root, packagePaths)
  } catch {
    // 增强层：清不掉就让插件那边如实报「文件只读」，总比在这里把删除弄失败强
    return
  }

  let changed = false
  for (const packagePath of packagePaths) {
    if (enforcedPaths.delete(keyOf(connectionId, packagePath))) changed = true
  }
  if (changed) notifyEnforcementChanged()
}

/** 一轮 run 结束，把这些锁对应的只读位全解掉 */
export async function releaseEnforcement(locks: LockRecord[]): Promise<void> {
  if (locks.length === 0) return

  // 按键直接问锁表，而不是把整张表拷出来拼成 Set：多会话下锁表可能有几百条，
  // 为了判断手上这几条路径先建一个几百元素的索引是逆向的，也会把锁表的内部
  // 键格式拄到这个模块里
  const { isLocked } = await import('./assetLock')

  for (const [connectionId, packagePaths] of groupByConnection(locks)) {
    // **下一轮可能已经把同一批路径重新抢走了。** 释放是 `releaseAll` 里发出来的
    // 未 await 的调用，等它轮到时，用户的下一条消息可能已经起跑并锁上了同一个
    // 资产。不筛的话会把新一轮刚翻上去的位又清掉，那段时间里它毫无保护。
    const releasable = packagePaths.filter((packagePath) => !isLocked(connectionId, packagePath))
    if (releasable.length === 0) continue

    // 清位引用计数跟着一起清，但**只清真正释放掉的那些**。它只靠 suspend/enforce
    // 严格配对来归零，一次不平衡就会让这个包在本进程剩下的时间里再也翻不上位。
    //
    // 「还锁着的也一起清」是错的：那批包已经归下一轮了，它可能正有两个并发工具
    // 开着（计数 2）。把计数抹平之后先返回的那个会算出 0、当成「最后一个关」
    // 把位翻上去，而兄弟工具还在写 —— 正是引用计数当初要防的那一幕。
    for (const packagePath of releasable) suspendCounts.delete(keyOf(connectionId, packagePath))

    try {
      const root = await resolveProjectRoot(connectionId)
      if (!root) continue
      await unprotectPackages(root, releasable)
      for (const packagePath of releasable) {
        enforcedPaths.delete(keyOf(connectionId, packagePath))
      }
    } catch {
      /* 解不掉的留在台账上，下次工程连上来时还原 */
    }
  }
}

/**
 * 工程连上来时把台账上的**残留**位还原 —— 「盒子崩了留下只读文件」唯一的兜底。
 *
 * 放在连接时而不是盒子启动时：盒子启动时还不知道有哪些工程，而残留的只读位
 * 恰恰是在用户开始用那个工程的时刻才咬人。
 *
 * **当前仍被持有的锁要跳过。** 编辑器崩溃后插件会自动重连，那时候盒子这边的
 * 会话往往还在跑。无脑还原会把它正握着的位一起清掉，而 `enforcedPaths` 没变，
 * 界面继续写着「保存会被拦下（文件已设为只读）」—— 用户照着这句假话放弃自己的
 * 改动，那是文案红线上最坏的一种。清掉的那些同步从 `enforcedPaths` 里摘掉并重推，
 * 是第二道保险。
 */
export async function restoreOnConnect(connectionId: string): Promise<number> {
  try {
    return await restoreLedgerFor(connectionId)
  } finally {
    // **无条件重推**，放在 finally 里。
    //
    // 上面那条路随时可能提前返回（工程路径为空、多连接、抛异常），而角标重推
    // 跟只读位没有半点关系 —— 把 C 阶段的主功能挂到 B 阶段的前置条件上，
    // 结果就是「插件没报工程路径」这种小事让内容浏览器一个角标都不出现。
    try {
      republishTrigger?.()
    } catch {
      /* 重推是增强，坏了不影响还原本身 */
    }
  }
}

/** 上一次在这个工程根目录上看到的连接。只有真换了连接才值得重探版本控制 */
const lastConnectionByRoot = new Map<string, string>()

async function restoreLedgerFor(connectionId: string): Promise<number> {
  try {
    const root = await resolveProjectRoot(connectionId)
    if (!root) return 0

    // 版本控制的判定重探一次 —— 但只在**真的换了连接**时。
    // `project.info` 在握手、重连、盒子主动查询时都会来，每来一条就作废的话，
    // 这个缓存当初想从工具热路径上拿掉的那几次 syscall 又回来了
    if (lastConnectionByRoot.get(root) !== connectionId) {
      lastConnectionByRoot.set(root, connectionId)
      invalidateSourceControlCache(root)
    }

    // `connectionId` 为 undefined 的锁同样算「仍被持有」。那不是边角情况：
    // 会话没绑定目标工程时 `getTargetConnectionId()` 就返回 undefined，
    // 单工程下的普通对话记的锁全长这样。只按 id 严格相等去筛的话，它们既进不了
    // keep 名单、又不会被下面那个清理循环匹配到 —— 位被还原了、界面还在说
    // 「保存会被拦下」，恰好是这段逻辑要防的那句假话。
    //
    // 宁可多留一个位也不能多还一个：多留的最坏结果是它等到下一次连接才被清掉，
    // 而多还的结果是我们对用户说了假话。
    const { listLocks } = await import('./assetLock')
    const held = listLocks()
      .filter((lock) => lock.connectionId === connectionId || lock.connectionId === undefined)
      .map((lock) => lock.path.toLowerCase())
    const heldSet = new Set(held)

    const restored = await restoreLedger(root, held)

    // 还原掉的那些不可能再是「已拦截」。两个键空间都要扫：这条连接的，
    // 和没指定连接的
    // 前缀从 `keyOf` 自己算，不手写分隔符 —— 手写的话两边会各自演化，
    // 而不匹配的表现是「界面继续说保存会被拦下」，没有任何报错
    const prefixes = [keyOf(connectionId, ''), keyOf(undefined, '')]
    let changed = false
    for (const key of [...enforcedPaths]) {
      const prefix = prefixes.find((candidate) => key.startsWith(candidate))
      if (prefix === undefined) continue
      if (heldSet.has(key.slice(prefix.length))) continue
      enforcedPaths.delete(key)
      changed = true
    }
    if (changed) notifyEnforcementChanged()

    return restored
  } catch {
    return 0
  }
}
