/**
 * 按最后一轮问答给会话重起名字。两个入口共用这一份：
 * 侧边栏重命名弹窗里的「智能命名」，和设置里的「自动生成新标题」（每轮结束后自动跑）。
 *
 * 下面先是喂给模型的那段文本怎么截，再是那次调用本身。
 *
 * ---
 *
 * 节选取的是会话的**最后一轮问答**。
 *
 * 为什么是最后一轮而不是第一条消息：第一条消息已经被自动取名用掉了
 * （见 `views/Assistant/composables/sessionAutoTitle.ts`），用户点开重命名弹窗再
 * 按一次「智能命名」，想要的恰恰是「按现在聊到的东西重起一个」—— 一条会话聊够久，
 * 主题早就不是开头那件事了。
 *
 * 节选那一半是纯函数，不认 store 也不认网络。
 */

/** 消息内容和 chatMessages store 一致：纯文本或多模态数组 */
type ContentPart = { type: string; text?: string }
export interface ExcerptMessage {
  role: 'user' | 'assistant'
  content: string | ContentPart[]
}

/** 喂给轻量模型的字数上限。一轮问答要装两个人的话，比自动取名的 500 宽一倍 */
export const MAX_EXCERPT_CHARS = 1000

/** 角色前缀。模型要靠它分清哪句是提问哪句是回答，语言由系统提示单独指定 */
const USER_LABEL = 'User: '
const ASSISTANT_LABEL = 'Assistant: '

function toText(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content.trim()
  return content
    .filter((part) => part.type === 'text' && part.text)
    .map((part) => part.text)
    .join('\n')
    .trim()
}

/**
 * 两段话分一个字数预算：各拿一半，谁没用完剩下的归对方。
 *
 * 不这么分的话，一条贴了两千行日志的提问会把整个预算吃光，模型看不到回答 ——
 * 而恰恰是回答里写着这一轮到底在干什么。
 */
function splitBudget(firstLength: number, secondLength: number, budget: number): [number, number] {
  if (firstLength + secondLength <= budget) return [firstLength, secondLength]
  const half = Math.floor(budget / 2)
  if (firstLength <= half) return [firstLength, budget - firstLength]
  if (secondLength <= budget - half) return [budget - secondLength, secondLength]
  return [half, budget - half]
}

/**
 * 从整条会话的消息里截出最后一轮问答。
 *
 * @param messages 会话的全部消息，按时间正序
 * @param maxChars 字数上限，默认 {@link MAX_EXCERPT_CHARS}
 * @returns 可以直接喂给模型的节选；没有任何有效文本时是空串，调用方据此提示用户
 */
export function buildLastRoundExcerpt(
  messages: readonly ExcerptMessage[],
  maxChars: number = MAX_EXCERPT_CHARS
): string {
  const texts = messages.map((message) => ({ role: message.role, text: toText(message.content) }))

  let userIndex = -1
  for (let i = texts.length - 1; i >= 0; i -= 1) {
    if (texts[i].role === 'user' && texts[i].text) {
      userIndex = i
      break
    }
  }

  // 一条消息都没有（或全是空壳）：没什么可起名的
  if (userIndex < 0) {
    const lastText = [...texts].reverse().find((item) => item.text)?.text
    return lastText ? lastText.slice(0, maxChars) : ''
  }

  const userText = texts[userIndex].text
  // 这一轮的回答：用户那条之后**最后**一条助手消息。中间可能夹着几条过程消息，
  // 最后那条才是收尾的结论
  const answerText =
    [...texts.slice(userIndex + 1)].reverse().find((item) => item.role === 'assistant' && item.text)
      ?.text ?? ''

  const budget = Math.max(0, maxChars - USER_LABEL.length - ASSISTANT_LABEL.length - 1)
  const [userBudget, answerBudget] = splitBudget(userText.length, answerText.length, budget)

  const lines = [`${USER_LABEL}${userText.slice(0, userBudget)}`]
  if (answerText) lines.push(`${ASSISTANT_LABEL}${answerText.slice(0, answerBudget)}`)
  return lines.join('\n')
}

/** 起名在途的会话。同一条会话同时只起一次：重复发起不会更准，只会多花一次调用 */
const inFlight = new Set<string>()

export type RetitleOutcome = 'ok' | 'empty' | 'failed' | 'skipped'

/**
 * 给一条会话重起名字：截节选 → 轻量模型 → 写回标题。
 *
 * **不抛错。** 两个调用方谁都不该因为起名失败而中断：自动那条是后台行为，
 * 手动那条只需要一句提示。失败原因通过返回值区分，怎么说给用户听由调用方决定。
 *
 * @param messages 这条会话的全部消息，按时间正序
 * @param applyTitle 拿到名字后怎么落（改 store、顺带改标签页标题都在这里）
 * @returns `empty` 没有可用对话内容；`skipped` 同一条会话正在起名；
 *          `failed` 模型没配 / 调用失败 / 返回废话；`ok` 已改名
 */
export async function retitleSession(
  sessionId: string,
  messages: readonly ExcerptMessage[],
  applyTitle: (title: string) => void
): Promise<RetitleOutcome> {
  if (!sessionId) return 'empty'
  if (inFlight.has(sessionId)) return 'skipped'

  const excerpt = buildLastRoundExcerpt(messages)
  if (!excerpt) return 'empty'

  inFlight.add(sessionId)
  try {
    // 懒加载：`api/ai` 顶层就把 i18n 实例建起来了，而这个模块会被侧边栏和
    // Agent 完成回调都引到，静态 import 会把那一整串拖进它们的单测里去
    const { aiAPI } = await import('../api/ai')
    const title = await aiAPI.generateSessionTitleFromExcerpt({ excerpt })
    if (!title) return 'failed'
    applyTitle(title)
    return 'ok'
  } catch (error) {
    console.warn('[chat] 重新为会话起名失败:', error)
    return 'failed'
  } finally {
    inFlight.delete(sessionId)
  }
}

/** 只给单测用：清掉在途标记，避免用例之间互相串 */
export function resetRetitleStateForTest(): void {
  inFlight.clear()
}
