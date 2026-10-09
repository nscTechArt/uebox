/**
 * 按整段对话的梗概给对话重起名字。两个入口共用这一份：
 * 侧边栏重命名弹窗里的「智能命名」，和设置里的「自动生成新标题」（每轮结束后自动跑）。
 *
 * 下面先是喂给模型的那段文本怎么截，再是那次调用本身。
 *
 * ---
 *
 * 节选是**整段对话的梗概**：用户按时间顺序提过的每个问题，加上最后一条回答。
 *
 * 以前只喂最后一轮问答，起出来的名字很片面 —— 最后一句是「颜色再调红一点」，
 * 标题就成了「调红颜色」，前面二十轮在做的那件事反倒没了。用户的提问连起来就是
 * 这段对话的主线，而且一条通常不长，装得下；回答又长又多，只留最后一条交代结论。
 *
 * 节选那一半是纯函数，不认 store 也不认网络。
 */

/** 消息内容和 chatMessages store 一致：纯文本或多模态数组 */
type ContentPart = { type: string; text?: string }
export interface ExcerptMessage {
  role: 'user' | 'assistant'
  content: string | ContentPart[]
}

/** 喂给轻量模型的字数上限 */
export const MAX_EXCERPT_CHARS = 1500

/** 每个提问最多带多少字。贴进来的日志、代码不该挤掉别的提问 */
const QUESTION_MAX_CHARS = 120

/** 最后一条回答最多带多少字。它只负责交代结论，主线看提问 */
const ANSWER_MAX_CHARS = 300

/** 段落标签。模型要靠它分清哪段是什么，语言由系统提示单独指定 */
const CURRENT_TITLE_LABEL = 'Current title: '
const QUESTIONS_LABEL = 'User questions (in order):'
const ANSWER_LABEL = 'Latest answer: '
const BULLET = '- '
/** 给「省掉了几个提问」那一行留的位置 */
const OMITTED_LINE_RESERVE = 48

function toText(content: string | ContentPart[]): string {
  const raw =
    typeof content === 'string'
      ? content
      : content
          .filter((part) => part.type === 'text' && part.text)
          .map((part) => part.text)
          .join(' ')
  return raw.replace(/\s+/g, ' ').trim()
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/**
 * 从整条对话的消息里截出梗概。
 *
 * 提问太多装不下时，**第一个提问一定留着**（它多半交代了这段对话要干什么），
 * 其余从最近的往回装，中间省掉的用一行说明顶上，让模型知道那里还有内容。
 *
 * @param messages 对话的全部消息，按时间正序
 * @param currentTitle 对话现在的标题。给了的话模型可以沿用它，不至于每轮都换个名字
 * @param maxChars 字数上限，默认 {@link MAX_EXCERPT_CHARS}
 * @returns 可以直接喂给模型的节选；没有任何有效文本时是空串，调用方据此提示用户
 */
export function buildConversationExcerpt(
  messages: readonly ExcerptMessage[],
  currentTitle?: string,
  maxChars: number = MAX_EXCERPT_CHARS
): string {
  let firstIndex = -1
  let firstQuestion = ''
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i].role !== 'user') continue
    const text = toText(messages[i].content)
    if (!text) continue
    firstIndex = i
    firstQuestion = clip(text, QUESTION_MAX_CHARS)
    break
  }

  // 一条提问都没有（或全是空壳）：拿最后一条有内容的消息凑合
  if (firstIndex < 0) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const text = toText(messages[i].content)
      if (text) return text.slice(0, maxChars)
    }
    return ''
  }

  const title = currentTitle?.trim() || ''
  const head = title ? [`${CURRENT_TITLE_LABEL}${title}`, QUESTIONS_LABEL] : [QUESTIONS_LABEL]
  const firstLine = `${BULLET}${firstQuestion}`
  let budget = maxChars - head.join('\n').length - firstLine.length - OMITTED_LINE_RESERVE

  /*
   * 从尾巴往前扫，用到哪条才转哪条。
   *
   * 这个函数开了「自动生成新标题」之后是**每轮收尾都跑一次**的，拿到的是整条对话的
   * 全部消息。助手的回答动辄几 KB，一条聊了一百多轮的对话全转一遍就是几百 KB 的
   * 临时字符串，而且随轮数一直涨 —— 花在这儿的正好是界面在渲染最后那段答复的时刻。
   * 所以回答只转最后一条，提问装满预算就停。
   */
  let answerLine = ''
  let seenLaterQuestion = false
  let omitted = 0
  const recentLines: string[] = []
  for (let i = messages.length - 1; i > firstIndex; i -= 1) {
    if (messages[i].role === 'assistant') {
      // 最后一个提问之后的最后一条回答才是收尾的结论，中间可能夹着几条过程消息；
      // 倒着扫时它先出现。更早的回答不带
      if (answerLine || seenLaterQuestion) continue
      const text = toText(messages[i].content)
      if (!text) continue
      answerLine = `${ANSWER_LABEL}${clip(text, ANSWER_MAX_CHARS)}`
      budget -= answerLine.length + 1
      continue
    }
    seenLaterQuestion = true
    if (budget <= 0) {
      omitted += 1
      continue
    }
    const text = toText(messages[i].content)
    if (!text) continue
    const line = `${BULLET}${clip(text, QUESTION_MAX_CHARS)}`
    if (line.length + 1 > budget) {
      // 装不下了：后面（更早）的提问都不再转文本，只计数
      budget = 0
      omitted += 1
      continue
    }
    budget -= line.length + 1
    recentLines.unshift(line)
  }

  const lines = [...head, firstLine]
  if (omitted > 0) lines.push(`${BULLET}… (${omitted} earlier questions omitted)`)
  lines.push(...recentLines)
  if (answerLine) lines.push(answerLine)
  return lines.join('\n')
}

/** 起名在途的对话。同一条对话同时只起一次：重复发起不会更准，只会多花一次调用 */
const inFlight = new Set<string>()

export type RetitleOutcome = 'ok' | 'empty' | 'failed' | 'skipped'

/**
 * 给一条对话重起名字：截节选 → 轻量模型 → 写回标题。
 *
 * **不抛错。** 两个调用方谁都不该因为起名失败而中断：自动那条是后台行为，
 * 手动那条只需要一句提示。失败原因通过返回值区分，怎么说给用户听由调用方决定。
 *
 * @param messages 这条对话的全部消息，按时间正序
 * @param applyTitle 拿到名字后怎么落（改 store、顺带改标签页标题都在这里）
 * @param getTitle 读这条对话此刻的标题。给了的话，起名期间标题被改过就不落
 * @param options.keepCurrentTitle 把现有标题一并给模型，主线没变就沿用它。
 *   自动那条要开：每轮都跑，不开的话标题会跟着每轮的话头来回跳。手动那条不开：
 *   用户点「智能命名」就是想要个新的，回来还是原名会以为按钮坏了
 * @returns `empty` 没有可用对话内容；`skipped` 同一条对话正在起名；
 *          `failed` 模型没配 / 调用失败 / 返回废话；`ok` 已改名
 */
export async function retitleSession(
  chatSid: string,
  messages: readonly ExcerptMessage[],
  applyTitle: (title: string) => void,
  getTitle?: () => string | undefined,
  options: { keepCurrentTitle?: boolean } = {}
): Promise<RetitleOutcome> {
  if (!chatSid) return 'empty'
  if (inFlight.has(chatSid)) return 'skipped'

  const excerpt = buildConversationExcerpt(messages, options.keepCurrentTitle ? getTitle?.() : '')
  if (!excerpt) return 'empty'

  inFlight.add(chatSid)
  // 起名要几秒。这期间用户自己改了名，模型那个晚到的名字不能盖掉它
  const titleBefore = getTitle?.()
  try {
    // 懒加载：`api/ai` 顶层就把 i18n 实例建起来了，而这个模块会被侧边栏和
    // Agent 完成回调都引到，静态 import 会把那一整串拖进它们的单测里去
    const { aiAPI } = await import('../api/ai')
    const title = await aiAPI.generateSessionTitleFromExcerpt({ excerpt })
    if (!title) return 'failed'
    if (getTitle && getTitle() !== titleBefore) return 'skipped'
    applyTitle(title)
    return 'ok'
  } catch (error) {
    console.warn('[chat] 重新为对话起名失败:', error)
    return 'failed'
  } finally {
    inFlight.delete(chatSid)
  }
}

/** 只给单测用：清掉在途标记，避免用例之间互相串 */
export function resetRetitleStateForTest(): void {
  inFlight.clear()
}
