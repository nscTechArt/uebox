/**
 * 播报风格：回复念出来之前，先不先让轻量任务模型压一遍，压到什么程度。
 *
 * ## 为什么需要它
 *
 * agent 的答复是写给人看的：几段说明、一张表、几个路径、一段代码。念出来
 * 就是另一回事 —— 一条两千字的回复要听三分钟，而用户开着自动朗读多半是
 * 因为他正盯着编辑器、想**顺耳听一句结论**。念原文的话，结论埋在第三分钟。
 *
 * ## 三档
 *
 * - `concise`  只念结论：做了什么、结果如何、要用户做什么。三句话以内。
 * - `detailed` 念要点：结论、关键步骤、需要用户决定的事，去掉过程解说和代码。
 * - `full`     原文照念，不经模型。
 *
 * 前两档每次朗读都要花一次轻量模型调用，而且音频要等它回来才开始 ——
 * 所以默认是 `full`：不改老用户听到的东西，也不在没配轻量模型的机器上每次白跑一趟。
 */

export const SPEECH_BRIEFING_STYLES = ['concise', 'detailed', 'full'] as const

export type SpeechBriefingStyle = (typeof SPEECH_BRIEFING_STYLES)[number]

export const DEFAULT_SPEECH_BRIEFING_STYLE: SpeechBriefingStyle = 'full'

/** 旧版本存的配置里没有这个字段，或被手改过。认不出就回默认档 */
export function normalizeSpeechBriefingStyle(value: unknown): SpeechBriefingStyle {
  return SPEECH_BRIEFING_STYLES.includes(value as SpeechBriefingStyle)
    ? (value as SpeechBriefingStyle)
    : DEFAULT_SPEECH_BRIEFING_STYLE
}

/** 真会走模型的那两档。`full` 在类型上就进不了模型那条路 */
export type CondensedSpeechStyle = Exclude<SpeechBriefingStyle, 'full'>

/**
 * 念出来的文本短于这个数就不压了：本来就只有一两句话，压一遍除了让音频晚
 * 两秒开始什么都换不来。按**去掉 Markdown 之后**的字数算。
 */
export const SPEECH_BRIEFING_SKIP_UNDER: Record<CondensedSpeechStyle, number> = {
  concise: 120,
  detailed: 400
}

/** 各档给模型的输出上限。留了余量：被 maxTokens 截断的口播稿会念到半句戛然而止 */
export const SPEECH_BRIEFING_MAX_TOKENS: Record<CondensedSpeechStyle, number> = {
  concise: 240,
  detailed: 800
}

/** 需不需要走一趟模型。`full` 永远不走，其余两档看字数 */
export function shouldBriefForSpeech(style: SpeechBriefingStyle, spokenLength: number): boolean {
  return style !== 'full' && spokenLength >= SPEECH_BRIEFING_SKIP_UNDER[style]
}
