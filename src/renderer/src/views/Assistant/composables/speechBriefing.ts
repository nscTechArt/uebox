/**
 * 念之前先压一遍：把一条回复按「播报风格」交给轻量模型改成口播稿。
 *
 * 这一层只管三件事，模型调用本身在 `api/ai.ts` 的 `condenseForSpeech`：
 *
 * - **该不该压。** `full` 不压；另两档看去掉 Markdown 之后的字数，短于门槛不压
 *   （门槛钉在 `shared/speechBriefing.ts`）—— 一句话的回复压一遍只会让音频晚两秒开始。
 * - **压坏了怎么办。** 模型没配、超时、回了空话或只回了标点：一律退回念原文。朗读
 *   不能因为一个装饰性的调用而没声音；用户听到原文至少知道活干完了。原因通过
 *   `onFallback` 报给调用方，由它决定要不要提示用户（模型没配这种事该说一次）。
 * - **同一条别压两次。** 用户点两下同一条气泡、自动朗读和手动朗读碰上同一条，
 *   都不该再花一次调用。按（风格 + 原文）记最近几十条。
 *
 * 喂给模型的是**原文 Markdown**而不是去格式后的纯文本：代码块、表格的边界
 * 模型看得见才好整块扔掉。模型的输出照样过一遍 `speechText`，它爱用列表就让它用。
 */

import {
  shouldBriefForSpeech,
  type CondensedSpeechStyle,
  type SpeechBriefingStyle
} from '@core/shared/speechBriefing'
import { splitSpeechText } from '@core/shared/speech'
import { speechText } from './speechText'

/** 压缩器：拿原文和档位，回口播稿。抽出来是为了单测不用碰 `api/ai` */
export type SpeechCondenser = (text: string, style: CondensedSpeechStyle) => Promise<string>

/** 退回念原文的原因。`error` 含超时 —— 对用户来说都是「压缩这步没成」 */
export type SpeechBriefingFallback = 'error' | 'empty'

export interface SpeechBriefingOptions {
  condense?: SpeechCondenser
  /** 原文去掉 Markdown 之后的纯文本。调用方多半已经算过，传进来省一次 lexer */
  plainText?: string
  /** 等模型最多多久。厂商那头挂住时，音频不能跟着一直不响 */
  timeoutMs?: number
  onFallback?: (reason: SpeechBriefingFallback) => void
}

/**
 * 喂给模型的字数上限。超过就掐头去尾各留一半：结论多半在尾巴上，
 * 而开头那段说明了这一轮在干什么 —— 中间的过程恰恰是要扔的。
 */
export const MAX_BRIEFING_INPUT_CHARS = 8000

/** 轻量模型几秒内该回来；等到这个数还没回，就当它挂了，改念原文 */
export const BRIEFING_TIMEOUT_MS = 15_000

/** 同一条回复最近压出来的口播稿。几十条足够：用户回头重听的只会是最近几条 */
const MAX_CACHED = 32
const cache = new Map<string, string>()

function remember(key: string, value: string): void {
  cache.delete(key)
  cache.set(key, value)
  if (cache.size > MAX_CACHED) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
}

/** 只给单测用 */
export function clearSpeechBriefingCacheForTest(): void {
  cache.clear()
}

export function clipBriefingInput(text: string, maxChars = MAX_BRIEFING_INPUT_CHARS): string {
  if (text.length <= maxChars) return text
  const half = Math.floor(maxChars / 2)
  return `${text.slice(0, half)}\n…\n${text.slice(text.length - half)}`
}

/**
 * 懒加载 `api/ai`：它顶层就把 i18n 实例建起来了，而这个模块会被朗读那一串引到，
 * 静态 import 会把那一整串拖进朗读的单测里去（`sessionRetitle` 也是这么做的）。
 */
const defaultCondenser: SpeechCondenser = async (text, style) => {
  const { aiAPI } = await import('@renderer/api/ai')
  return aiAPI.condenseForSpeech({ text, style })
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`speech briefing timed out after ${ms}ms`)), ms)
    work.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}

/**
 * @param text 要念的原文（Markdown）
 * @param style 播报风格
 * @returns 该念的文本。`full`、太短、压失败、压出来念不出声时，就是原文本身
 */
export async function briefForSpeech(
  text: string,
  style: SpeechBriefingStyle,
  options: SpeechBriefingOptions = {}
): Promise<string> {
  if (style === 'full') return text
  const plain = options.plainText ?? speechText(text)
  if (!shouldBriefForSpeech(style, plain.length)) return text

  const key = `${style}\n${text}`
  const cached = cache.get(key)
  if (cached !== undefined) return cached

  const condense = options.condense ?? defaultCondenser
  let brief: string
  try {
    brief = (
      await withTimeout(
        condense(clipBriefingInput(text), style),
        options.timeoutMs ?? BRIEFING_TIMEOUT_MS
      )
    ).trim()
  } catch (error) {
    console.warn('[ReadAloud] 口播稿压缩失败，改念原文:', error)
    options.onFallback?.('error')
    return text
  }
  // 模型只回了标点之类念不出声的东西：也退回原文，而且不记 —— 下次再给它一次机会
  if (!splitSpeechText(speechText(brief)).length) {
    console.warn('[ReadAloud] 口播稿压缩回了空稿，改念原文:', JSON.stringify(brief))
    options.onFallback?.('empty')
    return text
  }
  remember(key, brief)
  return brief
}
