/**
 * 把锁状态推到虚幻编辑器里 —— 资产锁 C 阶段第一步。
 *
 * 锁本身只活在盒子进程里（见 `assetLock.ts`），可用户此刻眼睛在虚幻编辑器上。
 * 他双击打开一个材质、改两个参数、按 Ctrl+S，然后改动被 agent 盖掉，
 * 而全程没有任何一处告诉过他「这个资产 AI 正在动」。这个模块负责把锁表
 * 送到插件，让内容浏览器把角标画出来。
 *
 * 设计 的「C 阶段」。这里只讲三个不显然的决定：
 *
 * ## 推全量，不推增量
 *
 * 增量要求两边状态永远一致，而 WebSocket 会断、会重连、会漏。全量的话任何
 * 一次推送都能把插件侧拉回正确状态，断线重连也只是「下一次推送时自愈」。
 * 列表最多几十条路径，省这点带宽不值得用一致性去换。
 *
 * ## 按连接分组
 *
 * 锁的键含 `connectionId` —— 盒子可以同时连多个工程。不分组的话 A 工程的锁
 * 会跑到 B 工程的内容浏览器里亮灯，而用户完全无从理解那个角标是哪来的。
 *
 * ## 从有到无那一次**必须**推
 *
 * 这是最容易漏的一条：只在「有锁」时推，用户屏幕上就会留下一排永远擦不掉的
 * 「AI 锁定中」。那正是「盒子把我工程搞坏了」的观感 —— 比不显示还糟。
 */

import { CURRENT_LEVEL_LOCK } from './assetLock'
import type { LockRecord } from './assetLock'

/**
 * 真正发出去的那一下。
 *
 * `connectionId` 为 undefined 表示这批锁没指定目标工程，交给下游按默认连接处理。
 *
 * `enforced` 是 `paths` 的子集：只读位真的翻上去了的那些（B 阶段）。插件靠这个
 * 区分文案 —— 只锁不拦时只能说「会互相覆盖」，真拦住了才能说「保存会被拦下」。
 * 说错的代价是用户照着假话放弃自己的改动， 的文案红线。
 */
export type LockPushSender = (
  connectionId: string | undefined,
  paths: string[],
  enforced: string[],
  /**
   * 这条连接的**当前关卡**正被改着（`CURRENT_LEVEL_LOCK` 哨兵）。
   *
   * 单发一个布尔而不是混进 `paths`：盒子并不知道那是哪张关卡（Actor 工具的参数
   * 里没有路径），插件那边却一直知道。塞一个假路径进去只会让插件拿它去匹配包名，
   * 匹配不上就什么都不显示。
   */
  levelLocked: boolean
) => void

/** 分组的键。undefined 连接要能和字符串连接区分开，所以用一个不可能的路径当哨兵 */
const DEFAULT_GROUP = '\u0000default'

function groupKey(connectionId: string | undefined): string {
  return connectionId ?? DEFAULT_GROUP
}

/**
 * 按连接把锁表分组，路径排序。
 *
 * 排序是为了让「内容有没有变」可以直接比字符串 —— 锁的插入顺序取决于模型
 * 这一轮先碰哪个资产，不排序的话同一批锁会因为顺序不同被判成变了。
 */
export function groupLocksByConnection(locks: LockRecord[]): Map<string, string[]> {
  const groups = new Map<string, string[]>()
  for (const lock of locks) {
    const key = groupKey(lock.connectionId)
    const list = groups.get(key)
    if (list) list.push(lock.path)
    else groups.set(key, [lock.path])
  }
  for (const list of groups.values()) list.sort()
  return groups
}

export interface LockPusher {
  (locks: LockRecord[], enforced?: string[]): void
  /**
   * 忘掉「已经推过了」，下一次推送对**每条连接**都必定重发。
   *
   * **不按 connectionId 挑着忘。** 锁完全可能记在 `connectionId: undefined` 上
   * （会话没绑定目标工程时就是这样，单工程下最常见），那批锁落在默认分组里，
   * 拿真实连接 id 去忘根本碰不到它们。全忘一遍只是给别的连接多推一次全量，
   * 那本来就是幂等的。
   *
   * 编辑器连上来时要调一次。去重是按内容比的，而**失败的推送同样被记成已推**
   * （发的时候对面还没连上、或者插件是旧版），不忘掉的话：用户先在盒子里发起
   * 任务、再打开 UE，只要这一轮里锁表内容不再变化，内容浏览器上一个角标都不会
   * 出现 —— 用户拿到的是「这功能根本没生效」。
   */
  forgetAll(): void
}

/**
 * 造一个推送器。给它锁表，它决定推谁、推什么、推不推。
 *
 * 有状态（记着上次推给每个连接的内容），所以一个进程只该造一个。
 */
export function createLockPusher(send: LockPushSender): LockPusher {
  /** 上次推给每个连接的内容（序列化后），用来判断这次要不要推 */
  let lastPushed = new Map<string, string>()

  const push = (locks: LockRecord[], enforced: string[] = []): void => {
    const groups = groupLocksByConnection(locks)
    const enforcedKeys = new Set(enforced.map((p) => p.toLowerCase()))
    interface Payload {
      paths: string[]
      enforced: string[]
      levelLocked: boolean
      key: string
    }
    const next = new Map<string, Payload>()

    for (const [group, all] of groups) {
      // 哨兵不是包路径，不能混进推给插件的列表 —— 那边会拿它去匹配包名，
      // 匹配不上等于白推一条
      const levelLocked = all.includes(CURRENT_LEVEL_LOCK)
      const paths = all.filter((p) => p !== CURRENT_LEVEL_LOCK)
      const enforcedHere = paths.filter((p) => enforcedKeys.has(p.toLowerCase()))
      // 只读位的开合不改变锁列表，但**改变文案**，所以两者都要进比较键 ——
      // 只比路径的话「从只锁到真拦」这一步永远推不出去
      next.set(group, {
        paths,
        enforced: enforcedHere,
        levelLocked,
        key: [paths.join('\n'), enforcedHere.join('\n'), levelLocked ? 'L' : ''].join('\u0000')
      })
    }

    // 上一轮有、这一轮没有的连接要收到空列表 —— 不推的话它那边的角标永远擦不掉
    for (const group of lastPushed.keys()) {
      if (!next.has(group)) {
        next.set(group, { paths: [], enforced: [], levelLocked: false, key: '' })
      }
    }

    for (const [group, payload] of next) {
      if (lastPushed.get(group) === payload.key) continue
      send(
        group === DEFAULT_GROUP ? undefined : group,
        payload.paths,
        payload.enforced,
        payload.levelLocked
      )
    }

    // 已经清空的连接不再留在表里，否则每次都要白比一遍，而且这个 Map 只增不减
    lastPushed = new Map(
      [...next].filter(([, payload]) => payload.key !== '').map(([group, p]) => [group, p.key])
    )
  }

  push.forgetAll = (): void => {
    lastPushed = new Map()
  }

  return push
}
