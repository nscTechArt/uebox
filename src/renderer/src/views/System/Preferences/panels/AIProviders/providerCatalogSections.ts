/**
 * 「添加服务商」弹窗的分区与分页规则。
 *
 * 逻辑单独放一个 .ts，是为了让测试能直接 import —— 从前这张表写在
 * ProviderCatalogModal.vue 里，守门的测试只能拿正则去抠源码（`.vue` 一 import
 * 就要拉起整个组件依赖）。正则守不住的东西不少，而这张表漏一行的代价是
 * **一整组厂商在界面上消失且不报错**。
 */
import {
  CATALOG_GROUPS,
  PROVIDER_KINDS,
  type CatalogEntry,
  type CatalogGroup,
  type ProviderKind
} from '@core/shared/aiProvider'

/**
 * 分区的键：对话类按「从哪儿买算力」分，其余按用途分。
 *
 * 两个轴合成一个键，是因为它们在界面上就是并排的一列标题 —— 但在类型上
 * 分开（CatalogGroup / ProviderKind），免得又变回一个枚举两种含义。
 */
export type SectionKey = CatalogGroup | Exclude<ProviderKind, 'chat'>

/** 弹窗顶上的分页。按「用户打开这个框是来干什么的」分 */
export type TabKey = 'chat' | 'visual' | 'voice' | 'creative' | 'retrieval'

/**
 * 每个分页收哪些分区。**这是渲染白名单**：SectionKey 有了新值却没登记到这里，
 * 那一组会整组不显示，而且不报错。
 *
 * 这不是假设。「向量化」那一组加进目录之后就正好这样漏了一次：7 家厂商 20 个
 * 模型全在目录里，能力位也标对了，界面上一个都找不到。providerCatalogGroups.test.ts
 * 现在盯着**类型里所有可能的 SectionKey**（而不是「目录里已经出现过的」），
 * 所以加一种能力那一刻就会红，不用等到第一家厂商进目录。
 *
 * 对话页里「订阅」和「本机推理」排在最前：这两档是**不用再掏一次钱**的入口 ——
 * 已经有 ChatGPT Plus 的人，和愿意在自己机器上跑模型的人，都不该先滚过 31 家
 * 按 token 计费的厂商才看见它们。
 *
 * 注意这个顺序曾经翻过车，但翻的是**没有分页**的那一版：当时全部 15 个分区首尾
 * 相接，本机排最前会把国内/国际两组直接挤到可视区外面，而弹窗没有滚动提示 ——
 * 看上去就像目录里没有 DeepSeek 和 OpenAI。分页之后这一页只剩 5 个分区 41 家，
 * 前面多两组一共 5 张卡，国内厂商仍在第一屏。
 */
export const TAB_SECTIONS: Readonly<Record<TabKey, readonly SectionKey[]>> = Object.freeze({
  chat: Object.freeze(['subscription', 'local', 'cn', 'cloud', 'gateway'] as SectionKey[]),
  visual: Object.freeze(['image', 'video'] as SectionKey[]),
  voice: Object.freeze(['realtime', 'tts', 'stt'] as SectionKey[]),
  creative: Object.freeze(['music', 'model3d'] as SectionKey[]),
  retrieval: Object.freeze(['embedding', 'search', 'judge'] as SectionKey[])
})

/**
 * 分页顺序。「对话」排第一是因为它一个人占了目录的一半以上，
 * 其余四页是**带着明确目的**来的人才点（「我要配生图」「我要配听写」）。
 */
export const TAB_ORDER: readonly TabKey[] = Object.freeze([
  'chat',
  'visual',
  'voice',
  'creative',
  'retrieval'
] as TabKey[])

/** 分区的全局顺序，等于把 TAB_SECTIONS 按分页顺序摊平 */
export const SECTION_ORDER: readonly SectionKey[] = Object.freeze(
  TAB_ORDER.flatMap((tab) => [...TAB_SECTIONS[tab]])
)

const SECTION_TO_TAB: ReadonlyMap<SectionKey, TabKey> = new Map(
  TAB_ORDER.flatMap((tab) => TAB_SECTIONS[tab].map((section) => [section, tab] as const))
)

/** 类型里所有可能的分区键。测试拿它核对白名单有没有漏 */
export const ALL_SECTION_KEYS: readonly SectionKey[] = Object.freeze([
  ...CATALOG_GROUPS,
  ...PROVIDER_KINDS.filter((kind): kind is Exclude<ProviderKind, 'chat'> => kind !== 'chat')
])

export function sectionOf(entry: CatalogEntry): SectionKey {
  return entry.kind === 'chat' ? (entry.group ?? 'cloud') : entry.kind
}

/** 没登记进任何分页的分区会返回 undefined —— 那种条目一个都渲染不出来 */
export function tabOfSection(section: SectionKey): TabKey | undefined {
  return SECTION_TO_TAB.get(section)
}

export function tabOf(entry: CatalogEntry): TabKey | undefined {
  return tabOfSection(sectionOf(entry))
}

/**
 * 搜索：厂商名、id，**以及模型名**。
 *
 * 模型名那一条不是锦上添花 —— 想配 Kimi 的人未必知道厂商叫 Moonshot，
 * 想配 gpt-image 的人也未必想得起来它在 OpenAI 名下。所以搜索框的
 * placeholder 里直接举了这两个例子，否则这个能力没人知道。
 */
export function matchesKeyword(entry: CatalogEntry, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return (
    entry.displayName.toLowerCase().includes(needle) ||
    entry.id.toLowerCase().includes(needle) ||
    entry.models.some((model) =>
      `${model.id} ${model.displayName || ''}`.toLowerCase().includes(needle)
    )
  )
}

/** 卡片副标题里「这家要不要钥匙」那一档 */
export type AccessTone = 'free' | 'oauth' | 'key'

/**
 * 卡片副标题原本写的是「预置 12 个模型」。
 *
 * 那句话几乎不承载决策信息 —— 没人因为 12 比 8 大就选它。真正决定「我现在能不能
 * 用上」的是另一件事：要不要去控制台申请密钥。所以把它提到前面，模型数缩成一个
 * 尾巴（有没有预置模型仍然要说，那决定选完之后还要不要手填）。
 */
export function accessOf(entry: CatalogEntry): AccessTone {
  if (!entry.requiresApiKey) return 'free'
  if (entry.supportsOAuth) return 'oauth'
  return 'key'
}
