import type { RealtimeVoicePhase } from '../composables/useRealtimeVoice'
import { shapeVoiceLevel } from './voiceRing'

/**
 * 这一刻是谁在出声。球体的全部动效都从这一个判断出发。
 *
 * `idle` 不等于「没在会话」——它是**会话开着但此刻没人说话**：
 * 你说完了在等，或者它正在想。那个安静的间隙也要有样子，
 * 不然用户会以为断了。
 */
export type VoiceOrbSpeaker = 'user' | 'assistant' | 'idle'

export interface VoiceOrbVisual {
  speaker: VoiceOrbSpeaker
  /** 当前说话人的响度，0–1。没人说话时是 0 */
  level: number
  /** 没人说话的那个间隙里，它是在等你（listening）还是在忙（thinking / executing） */
  resting: 'listening' | 'busy'
}

/**
 * 阶段 + 两路响度 → 球体该演谁。
 *
 * 返回 `null` = 会话没开，球体整个不该在。
 *
 * **输出优先**：麦克风开了回声消除，模型说话时麦克风那一路本该接近静音；
 * 万一漏进来一点（外放、回声消除没跟上），也不该把它当成「你在说话」。
 * 反过来你要插话打断它时，输出会先停，这里立刻就翻到 user。
 */
export function voiceOrbVisual(
  phase: RealtimeVoicePhase,
  inputLevel: number,
  outputLevel: number
): VoiceOrbVisual | null {
  if (phase === 'idle') return null

  const resting: VoiceOrbVisual['resting'] =
    phase === 'thinking' || phase === 'executing' ? 'busy' : 'listening'
  const out = shapeVoiceLevel(outputLevel)
  const input = shapeVoiceLevel(inputLevel)

  if (out > 0 && out >= input) return { speaker: 'assistant', level: out, resting }
  if (input > 0) return { speaker: 'user', level: input, resting }
  return { speaker: 'idle', level: 0, resting }
}
