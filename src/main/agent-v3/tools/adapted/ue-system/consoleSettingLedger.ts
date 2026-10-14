/**
 * 控制台设置账本：这台编辑器上被我们改过的 cvar / ShowFlag，以及它们原来的值。
 *
 * ## 为什么要记
 *
 * cvar 和 `ShowFlag.*` 都是全局设置，退出 PIE 不会复位，要到编辑器重启才回到默认。
 * 性能排查里一次 `ShowFlag.DynamicShadows 0` 忘了改回去，后面每一次采样都被污染，
 * 用户下次打开编辑器还会发现阴影没了。靠模型自觉记账迟早会漏，所以由工具来记。
 *
 * ## 原值从哪来
 *
 * 改之前先发一次不带参数的同名命令：cvar 会回一行 `名字 = "值"`，正则读出来就是原值。
 * 读不出来（不是 cvar、而是同名的命令）就不记账，也不拦这条命令。
 *
 * 只认「一个名字 + 一个数字」这种形状、且名字落在下面几个前缀里：要先把名字单独发一遍，
 * 如果那其实是个命令，不带参数执行它不该有副作用。`r.SetRes 1920x1080` 这种值不是数字的
 * 一律不碰。
 *
 * 输出格式 2026-10-14 在 UE 5.6 上真机核对过：首次查询是 `名字 = "值"      LastSetBy: …`；
 * 改过之后前面会多一段 `HISTORYConstructor: …Scalability: …` 前缀，没有换行也没有等号，
 * 所以正则取第一个 `= "…"` 就是当前值。
 *
 * ## 还原只还原值，不还原「谁设的」
 *
 * 从控制台改过的 cvar，LastSetBy 会变成 Console，还原时同样走控制台，值回来了，LastSetBy
 * 还是 Console。对 `r.ScreenPercentage` 这类由引擎可伸缩性设置管的项，这意味着到编辑器重启
 * 之前，用户在可伸缩性菜单里调画质不再影响它（Console 优先级更高）。ShowFlag 原值 2 是
 * 「不覆盖」，不受这个影响。要连优先级一起撤销得靠插件端调引擎的 API，这里做不到。
 *
 * ## 账本按连接分
 *
 * 编辑器一重启，这些设置本来就复位了，重连会拿到新的连接 id，旧账自然作废。
 */

const TRACKED_PREFIXES = ['r.', 'ShowFlag.', 'sg.', 't.', 'fx.', 'foliage.', 'grass.']

const SETTING_COMMAND = /^\s*([A-Za-z][\w.]*)\s+(-?\d+(?:\.\d+)?)\s*$/

/** UE 打印 cvar 当前值的格式：`r.ScreenPercentage = "100"      LastSetBy: Constructor` */
const CVAR_VALUE_LINE = /=\s*"([^"]*)"/

export interface SettingCommand {
  name: string
  value: string
}

export function parseSettingCommand(command: string): SettingCommand | null {
  const m = SETTING_COMMAND.exec(command)
  if (!m) return null
  const name = m[1]!
  if (!TRACKED_PREFIXES.some((p) => name.toLowerCase().startsWith(p.toLowerCase()))) return null
  return { name, value: m[2]! }
}

/** 从不带参数的查询输出里读出当前值；读不出说明这不是 cvar */
export function parseCvarValue(output: string | undefined): string | null {
  if (!output) return null
  const m = CVAR_VALUE_LINE.exec(output)
  return m ? m[1]! : null
}

function sameValue(a: string, b: string): boolean {
  const na = Number(a)
  const nb = Number(b)
  return Number.isFinite(na) && Number.isFinite(nb) ? na === nb : a === b
}

export interface ModifiedSetting {
  name: string
  original: string
}

// 连接 id → (小写名字 → 记录)。小写是因为 UE 的 cvar 名不分大小写
const ledgers = new Map<string, Map<string, ModifiedSetting>>()

function ledgerFor(connectionId: string | undefined): Map<string, ModifiedSetting> {
  const key = connectionId ?? ''
  let ledger = ledgers.get(key)
  if (!ledger) {
    ledger = new Map()
    ledgers.set(key, ledger)
  }
  return ledger
}

export function hasRecord(connectionId: string | undefined, name: string): boolean {
  return ledgerFor(connectionId).has(name.toLowerCase())
}

/**
 * 命令执行成功后调用。同一项改多次只留第一次的原值；
 * 改回原值（不管是 restore_all 还是模型自己改回去）就销账。
 */
export function recordChange(
  connectionId: string | undefined,
  name: string,
  original: string | null,
  newValue: string
): void {
  const ledger = ledgerFor(connectionId)
  const key = name.toLowerCase()
  const existing = ledger.get(key)
  if (existing) {
    if (sameValue(existing.original, newValue)) ledger.delete(key)
    return
  }
  if (original === null || sameValue(original, newValue)) return
  ledger.set(key, { name, original })
}

export function listModified(connectionId: string | undefined): ModifiedSetting[] {
  return [...ledgerFor(connectionId).values()]
}

export function forget(connectionId: string | undefined, name: string): void {
  ledgerFor(connectionId).delete(name.toLowerCase())
}

/** 仅供测试 */
export function resetLedgersForTest(): void {
  ledgers.clear()
}
