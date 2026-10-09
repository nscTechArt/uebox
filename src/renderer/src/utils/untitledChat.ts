/**
 * 「这条对话还没起名」的判断，新建对话的默认标题。
 *
 * 自动起名（首条消息截前 20 字顶上、轻量模型再换成真名）靠「标题等于默认标题」
 * 判断对话还没被命名。默认标题换成「未命名对话」之后，老用户存下的空对话标题
 * 还是历史值（AI会话、快速对话、Unnamed Session、Quick chat），只比对新默认的话
 * 它们会被当成已命名，首条消息不再触发自动起名 —— 所以历史默认标题在这里与
 * 当前默认标题一视同仁，包括已经有消息的对话：再发一条就按那条消息起名。
 * 这是有意的行为变化，不是回归。
 */
import zhCN from '../i18n/locales/zh-CN'
import enUS from '../i18n/locales/en-US'

/**
 * 新建对话的默认标题，取中文语言包的 `assistant.chatFlow.unnamedChat`。
 *
 * `createSession` 等没有 `t` 在手的地方拿它兜底 —— 写死字面量的话语言包改了值，
 * 这里就悄悄变成一个「用户起过的标题」，自动起名跟着失效。
 */
export const UNTITLED_CHAT_FALLBACK: string = zhCN.assistant.chatFlow.unnamedChat

/** 历史版本的默认标题。已存下的对话还带着它们；有意不改写，下一条消息会照常给它起名 */
const LEGACY_DEFAULT_TITLES = ['AI会话', 'Unnamed Session', '快速对话', 'Quick chat']

const UNTITLED_TITLES = new Set<string>([
  zhCN.assistant.chatFlow.unnamedChat,
  enUS.assistant.chatFlow.unnamedChat,
  ...LEGACY_DEFAULT_TITLES
])

/**
 * 判断这条对话是不是还没起名。比对前归一化首尾空白：空标题、等于当前默认标题或
 * 历史默认标题都算未命名，分不出是不是用户自己起的。代价是用户恰好起成这几个名字的
 * 对话，下一条消息会被改名；换来的是老对话还能自动起名。
 *
 * @param title 对话当前标题
 * @param currentDefault 调用方用自己的 `t` 取到的当前默认标题。注入或 mock 的 `t`
 *   （测试里原样返回 key）建出的对话标题就是它，传进来才认得出
 */
export function isUntitledChatTitle(title: string | undefined, currentDefault?: string): boolean {
  const normalized = title?.trim() ?? ''
  if (normalized === '') return true
  if (currentDefault && normalized === currentDefault) return true
  return UNTITLED_TITLES.has(normalized)
}
