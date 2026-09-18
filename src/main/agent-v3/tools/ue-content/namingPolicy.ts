/**
 * 用户自己的命名规则 → 整理能力的输入。
 *
 * 「偏好设置 → 命名规则」那一页用户填的东西（前缀表、命名约定、自定义改名规则、
 * 资产归属目录）原先只服务导入流程，Agent 一个字都看不到。结果是
 * `ue-content-import-organize` 技能里写着「**问用户**他们用什么前缀，然后传 rules
 * 进来」—— 用户早就填过了，我们还要再问一遍。
 *
 * 这个模块把那份配置翻成 `ue_content_naming_audit` 认识的形状。
 *
 * ## 两条路故意不一致
 *
 * `customRules` **只在整理时生效，导入时不生效**（2026-09-10 维护者定）。导入走的还是
 * `main/ipc/projectImport.ts` 里 `normalizeAssetName` 那六步（拼音 → 命名约定 →
 * 纹理后缀 → 前缀 → 拼接 → 清理），里面没有 customRules。
 * 别「顺手修一下」把它加进导入 —— 那是有意的分工，不是漏掉的。
 *
 * ## 改写建议名之后，冲突判定就不能信了
 *
 * 插件回来的 `conflict` 是拿**它自己**算的建议名去查注册表的结果。我们用自定义规则
 * 改写过的名字它没查过，所以这类条目要标成「冲突未知」，由调用方靠
 * `ue_content_move` 的 `dry_run` 兜。宁可说没确认上，不许假装查过。
 */

import type {
  CustomRule,
  CustomRuleMatch,
  NamingRulesConfig
} from '../../../../renderer/src/types/namingRules'
import { DEFAULT_NAMING_RULES_CONFIG } from '../../../../renderer/src/types/namingRules'
import { loadNamingRulesConfig } from '../../../utils/namingRulesConfig'

/**
 * 引擎类名 → 配置里的键。
 *
 * 命名规则页那份配置用的是导入流程的类型名（`Texture`），插件回的是引擎类名
 * （`Texture2D`）。只映射语义确实一对一的那几个：
 *
 * **不映射 NiagaraSystem → ParticleSystem。** 两者前缀不同（FXS_ / PS_），
 * 硬映射会拿 Cascade 的规范去改 Niagara 的资产。查不到就查不到，不猜。
 */
const CLASS_ALIASES: Record<string, string> = {
  Texture2D: 'Texture',
  TextureCube: 'Texture',
  Texture2DArray: 'Texture',
  VolumeTexture: 'Texture',
  TextureRenderTarget2D: 'Texture',
  MaterialInstanceConstant: 'MaterialInstance'
}

/**
 * 反向表：配置键 → 插件那边认的引擎类名。
 *
 * 从 `CLASS_ALIASES` 倒过来算，不另抄一份 —— 两张表分别维护迟早对不上。
 * 没有别名的键（StaticMesh、Blueprint 之类）引擎类名和配置键本来就一样，
 * 用的时候回落到键本身。
 */
const ENGINE_CLASSES_BY_CONFIG_KEY: Record<string, string[]> = (() => {
  const out: Record<string, string[]> = {}
  for (const [engineClass, configKey] of Object.entries(CLASS_ALIASES)) {
    ;(out[configKey] ??= []).push(engineClass)
  }
  return out
})()

/**
 * **用户改过的前缀不再自动发给插件。** 它只被报告给模型，由模型跟用户确认后自己传 `rules`。
 *
 * 为什么不自动发：插件的 override 是**整条规则替换**，`Accepted` 只留新前缀
 * （`UAL_ContentOrganizeCommands.cpp:495-500`），而 `KnownPrefixes` 是在 override
 * **之后**才从规则表建起来的（`:504-512`）。于是把 `Texture: 'TX_'` 发过去，`T_` 就从
 * 「认识的前缀」里整个消失：
 *
 * - `T_Rock` 不再匹配 `TX_`，剥前缀那一步只剥认识的前缀 —— 什么都没剥掉；
 * - 于是 `reason = missing_prefix`，`Suggested = 'TX_' + 'T_Rock'` = **`TX_T_Rock`**；
 * - 而 `missing_prefix` 不会置 `ambiguous`，所以这一条**一个警告标记都没有**，
 *   摘要照常把它交给 `ue_content_move`。
 *
 * 十三个配置键里有七个会这样（StaticMesh / SkeletalMesh / Texture / Material /
 * MaterialInstance / AnimSequence / AnimMontage），而且是默认路径，模型不用做任何事。
 * 讽刺的是：**名字错的资产反而改对，名字本来就对的资产被毁掉。**
 *
 * 真正的修法在插件里 —— `KnownPrefixes` 要从「默认表 ∪ override」建，让被顶掉的旧前缀
 * 仍然「可剥」但不再「合规」。那要动 C++ 并重出九个版本的包，不在这一轮。
 * 在那之前，盒子这边宁可不发：把用户改过什么如实报给模型，比悄悄改坏整个工程强。
 */
export function describeCustomPrefixes(prefixRules: Record<string, string>): string[] {
  return Object.entries(prefixRules).map(([configKey, prefix]) => {
    // 报的时候就把引擎类名写出来。配置用的是导入流程的类型名（Texture、
    // MaterialInstance），插件只按引擎类名查 —— 只报配置键的话，模型照着传
    // `MaterialInstance: 'MTI_'`，那条规则永远匹配不上，而 `MTI_` 还是会进插件的
    // KnownPrefixes，于是用户本来正确的 MTI_Rock 反被建议改成 MI_Rock。
    const engineClasses = ENGINE_CLASSES_BY_CONFIG_KEY[configKey]
    const keys = engineClasses ? engineClasses.join(' / ') : configKey
    return `${configKey} → ${prefix}（要传就用引擎类名：${keys}）`
  })
}

/** 一条自定义规则命中之后的说明，用来在结果里交代「凭什么改成这样」 */
export interface CustomRuleHit {
  /** 规则名，用户在设置页起的 */
  rule: string
  before: string
  after: string
}

export interface UserNamingPolicy {
  /**
   * 传给 naming_audit 的 rules：引擎类名 → 前缀。
   *
   * **只包含用户真正改过的条目**，出厂值一条都不在里面 —— 理由见
   * `pickCustomized` 上面那段。
   */
  prefixRules: Record<string, string>
  /** 启用中的自定义改名规则 */
  customRules: CustomRule[]
  /** 资产归属目录：配置键 → /Game 下的绝对路径。同样只含用户改过的 */
  directories: Record<string, string>
}

/**
 * 挑出用户真正改过的条目，出厂值原样的一律不要。
 *
 * 命名规范的**默认档是虚幻官方那一套**（2026-09-10 维护者定），它在插件里
 * （`UAL_ContentOrganizeCommands.cpp`，以 Epic《Recommended Asset Naming Conventions》
 * 为底）。盒子这边不该把自己的表盖上去。
 *
 * 而「偏好设置 → 命名规则」那份配置的**出厂值不是 Epic 的表** —— 它是导入流程自己攒的
 * 一份小表，跟 Epic 有出入（`SoundWave: 'A_'` 和 `AnimSequence: 'A_'` 还互相撞，
 * 而 Epic 根本没给音频定前缀、插件也特意不猜）。整份并进去等于：
 *
 *   1. 拿我们的口味盖掉 Epic 官方表；
 *   2. 把插件明确拒绝检查的类型（音频、字体）又塞回去检查。
 *
 * 所以只发 diff。用户没动过命名规则页，这里就是空的，审计完全走 Epic 那一套；
 * 他改过哪几条，哪几条才叠上去 —— 那才是他自己的项目规范。
 */
function pickCustomized(
  current: Record<string, string> | undefined,
  factory: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(current ?? {})) {
    if (!key || !value) continue
    if (factory[key] === value) continue
    out[key] = value
  }
  return out
}

/**
 * 把用户配置读成整理能用的形状。传 `config` 是为了测试，正常调用不传。
 *
 * 注意这里**不推导 `pascal_case`**。配置里的 `namingConvention` 出厂就是 `pascalCase`，
 * 我们分不出「用户选的」和「他从没打开过这一页」；而插件的建议名本来就按 Epic 的大小写来。
 * 分不出来的东西不猜，需要时让模型自己传。
 */
export function resolveUserNamingPolicy(config?: NamingRulesConfig): UserNamingPolicy {
  const cfg = config ?? loadNamingRulesConfig()

  return {
    prefixRules: pickCustomized(cfg.assetPrefixes, DEFAULT_NAMING_RULES_CONFIG.assetPrefixes),
    // 自定义规则不用 diff：出厂就是空数组，里面有什么都是用户自己写的。
    //
    // **这里只按开关过滤。** 没起名字、或者要找的原文是空的，都要一路走到
    // compileCustomRules 由它报出来 —— 在这一层静默丢掉的话，用户在设置页上看着
    // 那条规则，摘要却说「他什么都没配」，两句话对不上
    customRules: (cfg.customRules ?? []).filter((r) => r.enabled !== false),
    directories: pickCustomized(
      cfg.assetTypeToDirectory,
      DEFAULT_NAMING_RULES_CONFIG.assetTypeToDirectory
    )
  }
}

/**
 * 先按引擎类名查，查不到再按别名查。两次都没有就返回 undefined —— 不猜。
 *
 * 连**命中的那个配置键**一起给出来：报错要报到用户看得见的那一行上。设置页那张表的
 * 行键是配置键（`Texture`），而这里进来的是引擎类名（`Texture2D` / `TextureCube` /
 * `VolumeTexture`）—— 只报引擎类名的话，一条填错的 `Texture` 会变成三条「Texture2D
 * 填错了」，而那一页上压根没有 Texture2D 这一行。
 */
export function lookupEntryByClass<T>(
  table: Record<string, T>,
  engineClass: string
): { key: string; value: T } | undefined {
  if (engineClass in table) return { key: engineClass, value: table[engineClass] }
  const alias = CLASS_ALIASES[engineClass]
  if (alias && alias in table) return { key: alias, value: table[alias] }
  return undefined
}

/** 只要值的那一档 */
export function lookupByClass<T>(table: Record<string, T>, engineClass: string): T | undefined {
  return lookupEntryByClass(table, engineClass)?.value
}

/** 一条能用的规则。纯文本匹配，没有编译、没有正则、没有回溯 */
export interface CompiledRule {
  name: string
  match: CustomRuleMatch
  /** 要找的原文，按字面匹配 */
  text: string
  /** 换成什么，空串表示删掉 */
  replacement: string
}

export interface CompiledRuleSet {
  rules: CompiledRule[]
  /** 这次没生效的规则：没起名字、或者要找的原文是空的 */
  rejected: { rule: string; reason: 'unnamed' | 'empty' }[]
}

/**
 * 挑出能用的规则。
 *
 * 这里以前要 `new RegExp` 并拦危险形状，现在两件事都没有了 —— 规则是纯文本的，
 * 编译不了也炸不了，理由见 `CustomRuleMatch` 上面那段。剩下的只有两种废规则：
 * 没起名字的（用户在设置页上看着它、以为它生效，得报出来），和要找的原文是空的
 * （空串在任何位置都「匹配」，套上去等于把替换串插到每个名字里）。
 */
export function compileCustomRules(rules: CustomRule[]): CompiledRuleSet {
  const compiled: CompiledRule[] = []
  const rejected: CompiledRuleSet['rejected'] = []

  for (const rule of rules) {
    if (!rule.name) {
      rejected.push({ rule: '(未命名)', reason: 'unnamed' })
      continue
    }
    if (!rule.text) {
      rejected.push({ rule: rule.name, reason: 'empty' })
      continue
    }
    compiled.push({
      name: rule.name,
      match: rule.match ?? 'contains',
      text: rule.text,
      replacement: rule.replacement ?? ''
    })
  }

  return { rules: compiled, rejected }
}

/** 按一条规则改写一次。三个位置都是纯字符串操作，最坏情况线性 */
function applyOne(name: string, rule: CompiledRule): string {
  switch (rule.match) {
    case 'startsWith':
      return name.startsWith(rule.text) ? rule.replacement + name.slice(rule.text.length) : name
    case 'endsWith':
      return name.endsWith(rule.text)
        ? name.slice(0, name.length - rule.text.length) + rule.replacement
        : name
    default:
      // split/join 而不是 replaceAll：把 text 当纯文本，不给它任何正则语义
      return name.split(rule.text).join(rule.replacement)
  }
}

/**
 * 按用户的自定义规则改写一个资产名。
 *
 * 规则按用户在设置页里的顺序**依次**套用，后一条作用在前一条的结果上 ——
 * 这样「先去掉 _FINAL，再把 Temp_ 换成 WIP_」这种链式意图才写得出来。
 *
 * **规则把名字清成空串时保留原名**，和插件里那个 `if (Base.IsEmpty()) { Base = Name; }`
 * 对齐。不保留的话 `suggested_path` 会以 `/` 结尾，而那在 `ue_content_move` 那边的含义是
 * 「搬过去、名字不变」—— 一次什么都没改的改名被报成成功。
 *
 * 没有时间预算：纯字符串操作跑不出指数级，几千个资产 × 几条规则也是毫秒级。
 * 上一版那个 `RULE_BUDGET_MS` 是给正则兜底的，正则没了它也就没有意义了。
 */
export function applyCustomRules(
  name: string,
  compiled: CompiledRuleSet
): { name: string; hits: CustomRuleHit[] } {
  const hits: CustomRuleHit[] = []

  let current = name
  for (const rule of compiled.rules) {
    const next = applyOne(current, rule)
    if (next !== current && next.length > 0) {
      hits.push({ rule: rule.name, before: current, after: next })
      current = next
    }
  }

  return { name: current, hits }
}

/**
 * 拼一条包路径。
 *
 * 直接写 `${dir}/${name}` 会在顶层拼出 `//Name` —— `directoryOf('/SM_Rock')` 返回 `'/'`，
 * 再加一个斜杠就是两个。三处拼接都走这里。
 */
export function joinPackage(directory: string, name: string): string {
  const dir = directory.replace(/\/+$/, '')
  return `${dir}/${name}`
}

/** 取 `/Game/A/B/Name` 的目录部分 */
export function directoryOf(packagePath: string): string {
  const at = packagePath.lastIndexOf('/')
  return at <= 0 ? '/' : packagePath.slice(0, at)
}
