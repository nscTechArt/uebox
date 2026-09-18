/**
 * 「这一轮还没有任何正文」的占位文案。
 *
 * 它身兼两职，事故就出在这上面：
 *
 * 1. **给用户看的一行字** —— 气泡里那句带流光的「正在思考…」。既然要给人看，
 *    它就得跟着界面语言翻译。
 * 2. **一个哨兵值** —— 好几处逻辑靠「message.content 是不是还等于占位符」来判断
 *    这一轮有没有输出过：刷新后重连要拿它决定从哪儿接着写，收尾要拿它决定
 *    终稿取哪一份，中断和「用户终止」要拿它决定是整条换掉还是在末尾补一行。
 *
 * 两职撞车的后果：写入方是 `t('assistant.agentProcess.thinking')`（中文
 * 「思考中...」、英文 'Processing...'），判定方却各自硬写着 `'正在思考...'`。
 * 比不中 → 占位符被当成模型已经说过的话，刷新后的正文接在它后面继续累积，
 * 于是 `content` 比过程时间线多出一个前缀，两边再也对不上 ——
 * 界面在时间线下面把**整条回复又画了一遍**。
 *
 * 所以判定收在这里一处，而且认全部语言的写法：落盘的历史消息里存的，
 * 是它被写下去时那个语言的那一句。
 */
import zhCN from '@renderer/i18n/locales/zh-CN'
import enUS from '@renderer/i18n/locales/en-US'

/**
 * 新建 typing 消息时写进 `content` 的那一句。
 *
 * 保持中文字面量不变（历史消息里存的就是它），显示由渲染层按需要翻译。
 */
export const TYPING_PLACEHOLDER = '正在思考...'

/**
 * 认得出的全部写法。
 *
 * 从语言包**取值**而不是再抄一遍字面量：以后改文案或加一门语言，这里自动跟上，
 * 不会再出现「写入方翻译了、判定方没跟上」的错位。
 */
const PLACEHOLDERS = new Set<string>([
  TYPING_PLACEHOLDER,
  ...[zhCN, enUS].map((locale) => locale.assistant.agentProcess.thinking)
])

/** 这条 `content` 还只是占位符 —— 模型一个字都还没说 */
export function isTypingPlaceholder(content: unknown): boolean {
  return typeof content === 'string' && PLACEHOLDERS.has(content.trim())
}
