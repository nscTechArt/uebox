/**
 * 跨保管库执行 —— 让工具不再只看「当前活跃的那一个库」。
 *
 * ## 为什么要有这一层
 *
 * 盒子的资产不是一个库，是**一组库**：注册表在公共库（app-data.db 的 vaults 表），
 * 每个库自己一份 `vault-data.db`。用户手上至少两个（默认保管库、AIGC 资产库），
 * 还能自己建，还能挂网络协作库。
 *
 * 而所有资产工具过去都写死 `getVaultDatabase()` —— 那是**当前活跃的那一个**。
 * 于是出现过这样一次真机失败：用户的活跃库是 AIGC 库（59 个 AI 生成的图），
 * 他的 776 个素材连同 `SoStylized` 文件夹全在默认保管库里；
 * 他说「把 SoStylized 导入到项目里」，工具如实回答「整个素材库共 59 个资产，
 * 没有 SoStylized」—— 数字是真的，结论是错的，而且**错得看不出来**：
 * 返回值里没有任何东西提示「你只看了其中一个库」。
 *
 * 这不是数据库层面的限制。`VaultManager.withVaultDatabase(vaultId, op)` 一直
 * 就能打开任意一个库（当前库直接复用连接，别的库开完就关）。缺的只是工具
 * 愿不愿意去问第二个库。
 *
 * ## 一个库出问题不拖垮其余的
 *
 * 库文件被删了、网络库连不上、schema 太老 —— 这些都只影响它自己那一趟。
 * 其余库的结果照常返回，坏掉的那个在 `error` 里说清楚是哪个库、为什么。
 * 反过来做（一个失败就整次失败）会让用户因为一个早就不用的旧库而彻底搜不了东西。
 */

import type Database from 'better-sqlite3'
import { getDatabaseManager } from '../../../../sqliteDataBase'
import type { VaultInfo } from '../../../../sqliteDataBase/VaultManager'

/** 一个库跑完的结果。要么有 value，要么有 error，不会两个都没有 */
export interface VaultRun<T> {
  vault: VaultInfo
  value?: T
  /** 这个库没跑成的原因 */
  error?: string
}

export interface VaultScopeResult<T> {
  runs: VaultRun<T>[]
  /** scope 指到一个不存在的库时的报错。此时 runs 为空 */
  error?: string
}

/** `vault` 参数的两个保留字 */
const SCOPE_ALL = 'all'
const SCOPE_CURRENT = 'current'

/**
 * `vault` 参数认哪些写法，写进工具描述用。
 *
 * 抽成常量是为了两个工具（search_assets / library_overview）说的是同一套话 ——
 * 两处各写一遍，早晚会有一处漏掉「可以直接写库名」。
 */
export const VAULT_SCOPE_DESCRIPTION =
  '搜哪个保管库：不填 / "all" = 全部保管库（默认）、"current" = 只搜当前活跃的那个、' +
  '或者直接写库名（如 "默认保管库"、"AIGC 资产库"）。' +
  '**用户的素材分散在多个库里，默认全搜是对的** —— 只在用户明确说「只看某个库」时才收窄。'

/**
 * 把 scope 解析成要跑哪几个库。
 *
 * 当前库排在最前面：用户嘴里的「我库里的东西」多半先指它，
 * 分页时它的结果也就排在前面。
 */
function resolveTargets(
  scope: string | undefined,
  all: VaultInfo[],
  current: VaultInfo | null
): { targets: VaultInfo[]; error?: string } {
  const raw = String(scope ?? '').trim()

  const ordered = current
    ? [...all.filter((v) => v.id === current.id), ...all.filter((v) => v.id !== current.id)]
    : all

  if (!raw || raw.toLowerCase() === SCOPE_ALL) return { targets: ordered }

  if (raw.toLowerCase() === SCOPE_CURRENT) {
    if (!current) return { targets: [], error: '当前没有活跃的保管库。' }
    return { targets: [current] }
  }

  const matched = all.filter((v) => v.name.toLowerCase() === raw.toLowerCase() || v.id === raw)
  if (matched.length > 0) return { targets: matched }

  return {
    targets: [],
    error:
      `没有叫「${raw}」的保管库。现在有这几个：${all.map((v) => v.name).join('、')}。` +
      '不确定就别填这个参数，默认是全部一起搜。'
  }
}

/**
 * 依次在每个库上跑一遍 `op`。
 *
 * **是顺序跑不是并发**：调用方经常要在回调里攒跨库的分页状态
 * （还要取几个、要跳过几个），并发跑那些状态就乱了。
 * 库的个数是个位数，顺序跑不值得为它引入并发。
 */
export async function runAcrossVaults<T>(
  scope: string | undefined,
  op: (db: Database.Database, vault: VaultInfo) => Promise<T> | T
): Promise<VaultScopeResult<T>> {
  let vaultManager: ReturnType<ReturnType<typeof getDatabaseManager>['getVaultManager']>
  try {
    vaultManager = getDatabaseManager().getVaultManager()
  } catch (error) {
    return { runs: [], error: error instanceof Error ? error.message : String(error) }
  }

  const { targets, error } = resolveTargets(
    scope,
    vaultManager.getAllVaults(),
    vaultManager.getCurrentVault()
  )
  if (error) return { runs: [], error }

  const runs: VaultRun<T>[] = []
  for (const vault of targets) {
    try {
      runs.push({
        vault,
        value: await vaultManager.withVaultDatabase(vault.id, (db) => op(db, vault))
      })
    } catch (err) {
      runs.push({ vault, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return { runs }
}

/**
 * 「在当前保管库里没找到」时，去别的库看一眼再说话。
 *
 * ## 读跨库，写不跨库 —— 这是**故意的**
 *
 * 搜索和统计要跨库，否则用户看得见的东西 agent 看不见。
 * 但**改动一律只在当前活跃保管库里发生**：移动、删除、改备注、打标签、
 * 导入工程，都不许 agent 自己跳到别的库去做。切库是**用户的动作**，
 * 在界面上完成 —— 让 agent 代劳的话，用户会在一个自己没打开的库里
 * 发现东西被改过，而他全程没看见那个库。
 *
 * 所以这个函数不做任何补救，它只负责**把话说准**：
 * 「未找到」和「在另一个库里，你得先切过去」是两件完全不同的事，
 * 而前一句会让用户以为自己的素材丢了。
 *
 * 真机上栽过一次：用户活跃库是 AIGC 库，他的 `SoStylized` 在默认保管库里，
 * 工具回「没有这个文件夹」，模型据此告诉他「库里并没有这个名字的素材」——
 * 而那个文件夹连同 776 个资产一直好好待着。
 *
 * @param probe 在某个库里能不能找到这个东西。查得到就返回 true
 */
export async function explainVaultMiss(
  baseReason: string,
  probe: (db: Database.Database) => boolean
): Promise<string> {
  try {
    // 当前库自己查出来，不让调用方传 —— 传错了这句话就指向了用户已经在的那个库
    const current = getDatabaseManager().getVaultManager().getCurrentVault()

    const found: string[] = []
    const { runs } = await runAcrossVaults('all', (db, vault) => {
      if (vault.id === current?.id) return
      if (probe(db)) found.push(vault.name)
    })
    if (runs.length === 0 || found.length === 0) return baseReason

    return (
      `${baseReason}。但它在「${found.join('、')}」里 —— 当前活跃的保管库是` +
      `「${current?.name ?? '当前库'}」，而**改动只能发生在活跃库里**。` +
      `用 switch_vault 切到「${found[0]}」再重做一次这一步；` +
      '那一步会让用户确认（他也可以选「本会话都允许」），' +
      '被拒绝就如实告诉他需要自己在界面上切。' +
      '（不要告诉用户「库里没有这个东西」，它是在的。）'
    )
  } catch {
    // 查别的库本身失败了就算了，原样报基础原因 —— 别为一句补充说明把整个操作搞崩
    return baseReason
  }
}

/** `explainVaultMissBatch` 的结论：这一批在哪儿、该怎么办 */
export interface VaultBatchMiss {
  /** 当前活跃库里没有的那些键 */
  missing: string[]
  /** 这些键在别的库里找得到，按库名分组（只放**这一批**里找得到的那些） */
  foundIn: Record<string, number>
  /** 写给模型的一句话。missing 为空时是空串 */
  message: string
}

/**
 * 整批一次性核对：这些 key 在不在当前活跃库里；不在的话，在哪个库里。
 *
 * ## 为什么不能沿用逐条的 `explainVaultMiss`
 *
 * 导入是**批量**的。逐条版本会在循环里对每一个 key 把所有库都探一遍，
 * 于是 51 个资产撞上「库不对」时，返回体里是 51 行一模一样的长文案，
 * 而这件事从头到尾只需要说一次：「这批在 FPS 库里，当前活跃的是 AIGC 库，
 * 先 switch_vault」。真机上那一次就是这样：整批失败、51 条同样的话、
 * 打断用户一次确认框、重发整批，多花 2~3 轮。
 *
 * 更要紧的是**时机**：逐条版是在开工之后才发现的。收到 assetKeys 的那一刻
 * 就能判断它们属于哪个库，所以这个函数是给「动手之前」用的。
 *
 * @param keys      要核对的 assetKey
 * @param existsIn  某个库的连接里有没有这个 key
 */
export async function explainVaultMissBatch(
  keys: string[],
  existsIn: (db: Database.Database, key: string) => boolean
): Promise<VaultBatchMiss> {
  const empty: VaultBatchMiss = { missing: [], foundIn: {}, message: '' }
  if (keys.length === 0) return empty

  try {
    const vaultManager = getDatabaseManager().getVaultManager()
    const current = vaultManager.getCurrentVault()
    if (!current) return empty

    const missing = await vaultManager.withVaultDatabase(current.id, (db) =>
      keys.filter((key) => !existsIn(db, key))
    )
    if (missing.length === 0) return empty

    const foundIn: Record<string, number> = {}
    await runAcrossVaults('all', (db, vault) => {
      if (vault.id === current.id) return
      const hit = missing.filter((key) => existsIn(db, key)).length
      if (hit > 0) foundIn[vault.name] = hit
    })

    const elsewhere = Object.entries(foundIn).sort((a, b) => b[1] - a[1])
    if (elsewhere.length === 0) {
      return {
        missing,
        foundIn,
        message:
          `这批 ${keys.length} 个资产里有 ${missing.length} 个在**任何**保管库里都查不到` +
          `（当前活跃库是「${current.name}」）。key 可能是旧的或抄错了 —— ` +
          '用 search_assets 重新搜一遍，拿新的 assetKey，不要照原样重试。'
      }
    }

    const [topVault, topCount] = elsewhere[0]
    return {
      missing,
      foundIn,
      message:
        `这批 ${keys.length} 个资产里有 ${missing.length} 个不在当前活跃的保管库` +
        `「${current.name}」里，而在${elsewhere.map(([name, n]) => `「${name}」${n} 个`).join('、')}。` +
        `**改动只能发生在活跃库里**，所以先用 switch_vault 切到「${topVault}」` +
        `（那里有 ${topCount} 个），再原样重做这一步。` +
        '切库那一步会让用户确认，他也可以选「本会话都允许」；被拒绝就如实告诉他要自己在界面上切。' +
        '（不要告诉用户「库里没有这些素材」，它们是在的。）'
    }
  } catch {
    // 探库本身失败就当没探到：调用方会照原来的逐条路径往下走，不会因为这一句崩掉
    return empty
  }
}
