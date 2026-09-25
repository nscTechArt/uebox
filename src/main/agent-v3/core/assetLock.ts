/**
 * 资产独占锁 —— 防止两条会话同时改同一个资产。
 *
 * ## 为什么需要
 *
 * 盒子允许多条会话同时执行（`activeAgents` 是个 Map），子 Agent 还会再开执行流。
 * 两条会话改到同一个资产时，后写的会把先写的整个盖掉，而且**一声不吭** ——
 * 没有报错，用户只是发现自己刚让 AI 做的东西没了。
 *
 * ## 为什么全在盒子进程内就够
 *
 * UE 编辑器是单机的：一个工程同时只有一个编辑器实例，那个实例只连一个盒子。
 * 所以「两条会话改同一个资产」必然发生在同一个主进程内。锁表因此是进程内单例，
 * 白拿三个好处：
 *
 *   - **不落盘** —— 进程没了锁就没了，不可能留下僵尸锁把用户工程卡死
 *   - **不用 TTL / 心跳** —— run 结束必走 finally，进程崩了锁表跟着消失
 *   - **不用改插件** —— 不碰九个引擎版本里的任何一个
 *
 * 拦用户手动保存是另一回事（要在插件里翻文件的只读位）。
 *
 * ## 拿不到锁就直接失败，绝不排队
 *
 * 从不等待就没有环，**永远不会死锁**。模型收到失败会自己绕开去做别的 ——
 * 正是想要的行为。排队则会把一条会话卡住，而 agent 卡住比失败更糟：
 * 用户看到的是转圈，不知道在等什么。
 */

import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * 「当前这张关卡」的哨兵键。
 *
 * Actor 类工具（spawn / 移动 / 改属性）的参数里**一个资产路径都没有** —— 只有
 * actor 名、坐标、旋转。它们改的其实是当前关卡的那个包，可盒子这边并不知道
 * 那是哪张：问插件就要给每次调用多一次 RPC，缓存下来又会在用户切关卡时过期。
 *
 * 所以不猜路径，用一个哨兵占位。**哪张关卡由插件自己回答**（它本来就在
 * `GetEditorWorldContext().World()` 上取），盒子只需要表达「这条连接的关卡
 * 正被某条会话改着」。一个编辑器同时只有一张当前关卡，所以按连接算这个键
 * 是准确的，不是近似。
 *
 * 前导 `\0` 保证它永远撞不上真实包路径（`looksLikeAssetPath` 只认 `/Game/` 开头）。
 */
export const CURRENT_LEVEL_LOCK = '\0current-level'

/** 界面和给模型的文案里，哨兵要显示成人话 */
export function describeLockPath(path: string): string {
  return path === CURRENT_LEVEL_LOCK ? '当前关卡' : path
}

export interface LockRecord {
  /** 归一后的包路径，如 `/Game/Materials/M_Rock`；或 `CURRENT_LEVEL_LOCK` 哨兵 */
  path: string
  /** 哪个工程。undefined 表示这一轮没指定目标连接 */
  connectionId: string | undefined
  /** 锁的主人，根 sessionId */
  owner: string
  acquiredAt: number
  /**
   * 软锁：**只挡另一条 AI 会话，不翻只读位**。
   *
   * 关卡走这一档。用户在主视口里干活是常态，把关卡的保存也拦下来，代价和收益
   * 完全不成比例；而「两条 AI 会话同时改同一张关卡」仍然该挡。
   * 界面文案会自动降到保守那一档（「会互相覆盖」），因为它是按
   * `enforced`（只读位真翻上去了的）挑话说的 —— 软锁永远进不了那个集合。
   */
  soft?: boolean
}

/** 一次冲突 */
export interface LockConflict {
  path: string
  /** 现在持有它的那条会话 */
  owner: string
  /** 它从什么时候占着的。报错里说「已占 N 分钟」，省得调用方盲等 */
  since?: number
}

export type AcquireResult = { ok: true } | { ok: false; conflicts: LockConflict[] }

/**
 * 锁表。
 *
 * 键是 `连接 + 归一路径` —— 盒子可以同时连多个工程，不带连接的话
 * test222 的 `/Game/Foo` 会挡住 UALinkDev55 的 `/Game/Foo`。
 */
const locks = new Map<string, LockRecord>()

/** 已经就某个 (主人, 资产) 提示过了。防止模型重试几次就把界面刷屏 */
const notified = new Set<string>()

const ownerStorage = new AsyncLocalStorage<string>()

type ConflictNotifier = (conflict: LockConflict & { requester: string }) => void
let notifier: ConflictNotifier | undefined

type ChangeListener = (locks: LockRecord[]) => void
let changeListener: ChangeListener | undefined

/**
 * 注册「锁表变了」回调，由 ipc 层接上，用来把锁状态推到虚幻编辑器里
 * （内容浏览器角标那套，C 阶段）。
 *
 * 只在**真的增减了**锁时触发 —— 同一个主人重复拿同一把锁是幂等的，
 * 那种情况一轮 run 里有几十次，跟着推等于白刷 WebSocket。
 */
export function setLockChangeListener(fn: ChangeListener | undefined): void {
  changeListener = fn
}

type ReleaseListener = (released: LockRecord[]) => void
let releaseListener: ReleaseListener | undefined

/**
 * 注册「锁被放掉了」回调，由 ipc 层接上，用来把只读位一并解掉（B 阶段）。
 *
 * 和变更回调分开是因为拿到的东西不一样：那个要的是**现在还锁着什么**（画角标），
 * 这个要的是**刚刚放掉了什么**（解哪些文件的只读位）。合成一个就得两份都传，
 * 而三个释放点（execute / continue / 评测端点）里没有一处需要两份。
 *
 * 挂在 `releaseAll` 内部而不是那三个调用点上：那三处分散在两个文件里，
 * 将来加第四个入口时一定会有人忘。
 */
export function setLockReleaseListener(fn: ReleaseListener | undefined): void {
  releaseListener = fn
}

function notifyReleased(released: LockRecord[]): void {
  if (released.length === 0) return
  try {
    releaseListener?.(released)
  } catch {
    /* 同 notifyChanged：解不掉的留在台账上，下次工程连上来时还原 */
  }
}

function notifyChanged(): void {
  // 回调抛异常不能影响锁本身：锁没放掉才是会卡死用户工程的那一头
  try {
    changeListener?.(listLocks())
  } catch {
    /* 显示是增强功能，坏了不许影响锁 */
  }
}

/**
 * 注册冲突提示回调，由 ipc 层在启动时接上。
 *
 * 冲突**必须**让用户看见：他可能开着两个窗口，以为两边在干不同的活。
 * 静默失败的话，他只会看到一条会话莫名其妙地绕开了任务。
 */
export function setLockConflictNotifier(fn: ConflictNotifier | undefined): void {
  notifier = fn
}

/**
 * `${父}:sub-N` → 父。
 *
 * 子 Agent 的 sessionId 是父的 id 加后缀（见 `createAgent.ts`）。若它用自己的
 * id 当锁主，就会出现**父 agent 跟自己派出去的子 agent 互锁**：父持有资产 M、
 * 子要改 M、子被拒、父等子。归约到根之后父子共享同一把锁，子天然继承父的权限。
 */
export function rootSessionId(sessionId: string): string {
  return sessionId.split(':sub-')[0] ?? sessionId
}

/**
 * 工作室模式里队员的锁主是 `<会话>:mate-<队员>`（见 `createAgent.ts` 的 `memberLockOwner`），
 * 制作人的锁主是会话本身。两者同属一个团队。
 */
const MATE = ':mate-'

export function teamRootOf(owner: string): string {
  return owner.split(MATE)[0] ?? owner
}

export function sameTeam(a: string, b: string): boolean {
  return teamRootOf(a) === teamRootOf(b)
}

/** 冲突里占着锁的那一方叫什么：队友名，或者制作人 */
export function holderLabel(owner: string): string {
  const at = owner.indexOf(MATE)
  return at >= 0 ? `队友「${owner.slice(at + MATE.length)}」` : '制作人'
}

/**
 * 把执行流标记成属于某条会话。
 *
 * 和 `runWithTargetConnectionId` 一样用 AsyncLocalStorage 而不是模块级变量：
 * 多条会话并发执行时，模块级变量会被后启动的那条覆盖掉。
 */
export function runWithLockOwner<T>(sessionId: string, fn: () => T): T {
  return ownerStorage.run(rootSessionId(sessionId), fn)
}

/** 当前执行流的锁主。不在上下文里时是 undefined（此时不加锁） */
export function getLockOwner(): string | undefined {
  return ownerStorage.getStore()
}

/**
 * 归一成**包**路径 —— 锁的粒度是一个包，也就是磁盘上的一个文件。
 *
 * `/Game/Foo.Foo_C` 这种带子对象的写法要削成 `/Game/Foo`，否则同一个文件会被
 * 两条会话各锁一次而互不冲突。削法是「最后一个斜杠之后的第一个点」——
 * 目录名里可能带点，不能整串找。
 */
export function toPackagePath(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '')
  const lastSlash = trimmed.lastIndexOf('/')
  const dot = trimmed.indexOf('.', lastSlash + 1)
  return dot === -1 ? trimmed : trimmed.slice(0, dot)
}

function keyOf(connectionId: string | undefined, path: string): string {
  return `${connectionId ?? ''} ${path.toLowerCase()}`
}

/**
 * 一个字符串看着像不像 UE 的资产路径。
 *
 * **只认 `/Game/`**，这是有意收窄的：
 *
 *   - 参数名靠不住 —— 全仓 `path` 出现 205 次，里面既有 `/Game/...` 也有磁盘
 *     路径（shell 工具、资产库导入）。维护一张名字白名单必然会漏；
 *   - 放宽到「任何以 / 开头的字符串」则会误伤 Git Bash 风格的磁盘路径
 *     （`/c/Users/...`）和 URL 路径；
 *   - `/Engine/` 是引擎自带内容，agent 本来就不该改；插件内容根极少见。
 *
 * 宁可漏锁也不误锁：漏锁退回到今天的行为（没有锁），误锁会把一条会话
 * 卡在一个根本不存在的冲突上。
 */
function looksLikeAssetPath(value: string): boolean {
  if (!value.startsWith('/Game/')) return false
  if (value.includes('\\')) return false
  // `/Game/` 之后至少要有东西 —— `/Game/` 本身是内容根目录，不是资产
  return value.length > '/Game/'.length
}

/**
 * 从工具参数里挖出所有资产路径。
 *
 * 递归扫整个参数对象而不是查固定字段名：工具的参数命名并不统一
 * （`path` / `blueprint_path` / `graph_path` / `material_path` / `asset_path` /
 * `packagePath` …），而且新工具随时会引入新的写法。按**值的形状**判断
 * 才不会随着工具增加而漂。
 */
/**
 * 这些参数装的是**目录**，不是资产：「建在 /Game/Materials 下」锁的应该是新建出来的那个资产，
 * 不是整个目录。锁目录的后果是两个队员往同一个目录里建东西互相挡（2026-09-26 真机反馈：
 * 三张材质全被一把 `/Game/Materials` 的「锁」拦下）。
 */
const FOLDER_KEYS =
  /^(destination|dest|folder|directory|dir|target_folder|output_folder|package_folder|path_prefix|root_path)(_?path)?$/i

export function extractPackagePaths(params: unknown): string[] {
  const found = new Set<string>()

  const walk = (node: unknown, depth: number): void => {
    // 深度上限是防御性的：参数是 JSON Schema 校验过的普通对象，不该有环，
    // 但一个跑飞的工具不值得把主进程拖死
    if (depth > 8 || node === null || node === undefined) return

    if (typeof node === 'string') {
      if (looksLikeAssetPath(node)) found.add(toPackagePath(node))
      return
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1)
      return
    }
    if (typeof node === 'object') {
      const record = node as Record<string, unknown>
      // 写 ini 的参数（section + key/value）：值里的资产路径只是配置里的一个引用，
      // 改配置不碰那个资产。锁它会把「设默认 GameMode」挡在 GameMode 蓝图的锁后面
      const isConfigWrite = 'section' in record && ('key' in record || 'config_name' in record)
      for (const [key, value] of Object.entries(record)) {
        if (FOLDER_KEYS.test(key)) continue
        if (isConfigWrite && key === 'value') continue
        walk(value, depth + 1)
      }
    }
  }

  walk(params, 0)
  return [...found]
}

/**
 * 拿锁。**要么全拿到，要么一个都不拿。**
 *
 * 拿到一半就失败会留下半锁状态，而那半把锁不属于任何一次成功的调用，
 * 也就没人会去释放它。
 *
 * 同一个主人重复拿是幂等的 —— 一轮 run 里会反复碰到同一个资产。
 */
export function acquire(
  connectionId: string | undefined,
  owner: string,
  paths: string[],
  options: { soft?: boolean } = {}
): AcquireResult {
  const root = rootSessionId(owner)
  // 哨兵不是包路径，别让 `toPackagePath` 按「截掉第一个点后面」的规则改它
  const wanted = [...new Set(paths.map((p) => (p === CURRENT_LEVEL_LOCK ? p : toPackagePath(p))))]

  const conflicts: LockConflict[] = []
  for (const path of wanted) {
    const held = locks.get(keyOf(connectionId, path))
    if (held && held.owner !== root) {
      conflicts.push({ path, owner: held.owner, since: held.acquiredAt })
    }
  }

  if (conflicts.length > 0) {
    for (const conflict of conflicts) {
      // 同一个团队里的队员互相等锁是日常，不是用户要处理的「两个窗口抢资产」，不弹提示
      if (sameTeam(conflict.owner, root)) continue
      const dedupeKey = `${root} ${conflict.path.toLowerCase()}`
      if (notified.has(dedupeKey)) continue
      notified.add(dedupeKey)
      notifier?.({ ...conflict, requester: root })
    }
    return { ok: false, conflicts }
  }

  const acquiredAt = Date.now()
  let added = 0
  for (const path of wanted) {
    const key = keyOf(connectionId, path)
    if (!locks.has(key)) {
      locks.set(key, {
        path,
        connectionId,
        owner: root,
        acquiredAt,
        ...(options.soft ? { soft: true } : {})
      })
      added++
    }
  }
  if (added > 0) notifyChanged()
  return { ok: true }
}

/**
 * 释放某条会话持有的全部锁。
 *
 * 挂在 run 的 `finally` 上，所以用户按停止、模型报错、异常抛穿都覆盖得到；
 * 进程崩了则整张表跟着消失。这就是全部的兜底 —— 不需要 TTL。
 */
export function releaseAll(owner: string): number {
  const root = rootSessionId(owner)
  const released: LockRecord[] = []
  for (const [key, record] of locks) {
    if (record.owner === root && locks.delete(key)) released.push(record)
  }
  for (const key of notified) {
    if (key.startsWith(`${root} `)) notified.delete(key)
  }
  if (released.length > 0) {
    notifyChanged()
    notifyReleased(released)
  }
  return released.length
}

/** 当前所有锁，给界面上那个「AI 锁定了 N 个资产」用 */
export function listLocks(): LockRecord[] {
  return [...locks.values()]
}

/**
 * 某条会话持有的锁。
 *
 * 释放**之前**要先拿一份：只读位（B 阶段）得知道解哪些文件，而 `releaseAll`
 * 一走这些记录就没了。
 */
export function locksOwnedBy(owner: string): LockRecord[] {
  const root = rootSessionId(owner)
  return [...locks.values()].filter((record) => record.owner === root)
}

/**
 * 这个包此刻还锁着吗（不问是谁锁的）。
 *
 * 给只读位那层用：释放前要确认没被下一轮重新抢走。它原先是自己
 * `listLocks()` 全表拷一遍再拼 Set —— 为了判断手上三条路径而先建一个几百元素
 * 的索引，还把这里的键格式拄到了第二个模块里。锁表本来就是按这个键存的，
 * 直接查就是 O(1)。
 */
export function isLocked(connectionId: string | undefined, path: string): boolean {
  return locks.has(keyOf(connectionId, path))
}

/**
 * 全部强制解锁。
 *
 * 界面上那个逃生口按的就是它。任何锁一旦出 bug 卡死，用户的感受是
 * 「盒子把我工程搞坏了」而不是「有个 bug」—— 必须永远留一个看得见的出口。
 */
export function forceReleaseAll(): number {
  const released = [...locks.values()]
  locks.clear()
  notified.clear()
  if (released.length > 0) {
    notifyChanged()
    // 逃生口也要把只读位解掉。只清锁表不解位的话，用户点了「强制解锁」
    // 之后文件还是存不进去 —— 那个按钮就成了个假出口
    notifyReleased(released)
  }
  return released.length
}

/**
 * 给模型看的冲突说明。要让它能据此决定「先去做别的」，而不是原样重试。
 *
 * **故意不带会话 id。** 它是个 uuid，模型拿它做不了任何事，却会原样转述给
 * 用户 —— 真机上就出现过「这个材质被会话 b04ba478… 占用了」这种话。
 * 用户看到一串乱码，既不知道是自己哪个窗口，也没法据此决定做什么。
 *
 * 「是哪条会话」由界面上的锁指示器回答，那边能把 id 换成会话标题
 * （见 `renderer/.../AssetLockIndicator.vue`）。
 *
 * 也明确告诉模型别去猜原因：它曾经把「另一条 agent 会话占着」误说成
 * 「你先在编辑器里关掉这个资产」，把用户支去做一件没用的事。
 */
export function describeConflicts(conflicts: LockConflict[], requester?: string): string {
  // 工作室模式：占着它的是同一个团队里的队友或制作人。说清是谁、什么时候放、怎么商量 ——
  // 「另一条 AI 会话」在团队里既不准确也没法照着做（2026-09-26 真机反馈）
  if (requester && conflicts.every((c) => sameTeam(c.owner, requester))) {
    return [
      '以下资产正被**队友**改着，本次调用未做任何改动：',
      ...conflicts.map(
        (c) =>
          `  - ${describeLockPath(c.path)}（${holderLabel(c.owner)}` +
          `${c.since ? `，已占 ${Math.max(1, Math.round((Date.now() - c.since) / 60_000))} 分钟` : ''}）`
      ),
      '锁在它这件活交回时释放，已经等过一会儿了还没放。先做别的活；急的话用 team_message 跟它商量交接。'
    ].join('\n')
  }
  const lines = conflicts.map((c) => `  - ${describeLockPath(c.path)}`)
  return [
    '以下资产正被**盒子里的另一条 AI 会话**修改中，本次调用未做任何改动：',
    ...lines,
    '这与用户在虚幻编辑器里的操作无关，别让用户去关闭资产或退出编辑 —— 那不会解锁。',
    '锁在那条会话结束时自动释放。请先做别的任务，或告诉用户等它结束。反复重试不会让锁提前释放。'
  ].join('\n')
}
