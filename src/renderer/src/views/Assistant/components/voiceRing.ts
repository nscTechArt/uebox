import type { RealtimeVoicePhase } from '../composables/useRealtimeVoice'

/**
 * 语音圆环的视觉状态 —— 会话阶段到动效的唯一映射。
 *
 * 单独拎出来是因为「哪个阶段该转多快、弧长多少」是会被反复调的，
 * 而它不该藏在 `<style>` 里靠读 CSS 才知道。组件只负责画，这里负责决定画什么。
 */
export type VoiceRingState = 'connecting' | 'listening' | 'thinking' | 'executing' | 'speaking'

export interface VoiceRingVisual {
  state: VoiceRingState
  /** 主弧长占整圈的比例，0–1。整圈用 1 */
  arc: number
  /** 反向副弧的比例。0 表示这个阶段不画副弧 */
  counterArc: number
  /** 驱动缩放与辉光的响度，0–1。只有模型出声时才是真实数据 */
  level: number
}

/**
 * 低于这个响度按静音处理。
 *
 * 播放间隙的底噪会让 RMS 在 0.01 上下抖，直接映射成缩放的话，
 * 圆环在没人说话的时候也在细微地哆嗦 —— 那看着像卡了。
 */
const NOISE_GATE = 0.04

/**
 * 把 PCM 的 RMS 响度掰成看得见的幅度。
 *
 * 原始值（`measurePcmLevel`，RMS × 4）在正常语速下大多落在 0.15–0.5，
 * 直接乘个系数的话动静小到看不出来。开方把低段抬起来，
 * 于是「在说话」和「说完了」是两个明显不同的形状，而不是同一个圆环差几个像素。
 */
export function shapeVoiceLevel(raw: number): number {
  if (!Number.isFinite(raw) || raw <= NOISE_GATE) return 0
  return Math.sqrt(Math.min(1, raw))
}

/** 各阶段的弧长。整圈 = 稳定态，缺口 = 正在进行中 */
const ARC_BY_STATE: Record<VoiceRingState, { arc: number; counterArc: number }> = {
  // 还没连上：一小段快速扫圈，缺口大 = 明显未完成
  connecting: { arc: 0.28, counterArc: 0 },
  // 在听：整圈闭合，靠呼吸表示活着。麦克风开着这件事不能只靠一段弧暗示
  listening: { arc: 1, counterArc: 0 },
  // 在想：长弧慢扫，另一段反向走 —— 反向那段是「里面有东西在动」的廉价而有效的信号
  thinking: { arc: 0.55, counterArc: 0.18 },
  // 在调工具：两段互相咬合地转，比 thinking 更机械
  executing: { arc: 0.4, counterArc: 0.4 },
  // 在说：整圈，形状交给真实响度
  speaking: { arc: 1, counterArc: 0 }
}

/**
 * 阶段 + 响度 → 圆环该长什么样。
 *
 * 返回 `null` 表示这一刻**不该有圆环**（会话没开）。让调用方用 `v-if` 收掉，
 * 而不是画一个 opacity 0 的环 —— 后者会一直占着合成层做无用的动画。
 */
export function voiceRingVisual(
  phase: RealtimeVoicePhase,
  rawLevel: number
): VoiceRingVisual | null {
  if (phase === 'idle') return null
  const state: VoiceRingState = phase
  return {
    state,
    ...ARC_BY_STATE[state],
    level: state === 'speaking' ? shapeVoiceLevel(rawLevel) : 0
  }
}
