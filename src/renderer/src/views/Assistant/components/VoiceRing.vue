<template>
  <Transition name="voice-ring">
    <span v-if="visual" class="voice-ring" :class="`is-${visual.state}`" aria-hidden="true">
      <span class="voice-ring-body" :style="bodyStyle">
        <span class="voice-ring-halo"></span>
        <span class="voice-ring-ripple"></span>
        <svg class="voice-ring-svg" viewBox="0 0 44 44" focusable="false">
          <circle class="voice-ring-track" cx="22" cy="22" r="20" />
          <circle class="voice-ring-arc" cx="22" cy="22" r="20" :stroke-dasharray="arcDash" />
          <circle
            v-if="visual.counterArc > 0"
            class="voice-ring-arc is-counter"
            cx="22"
            cy="22"
            r="20"
            :stroke-dasharray="counterDash"
          />
        </svg>
      </span>
    </span>
  </Transition>
</template>

<script setup lang="ts">
/**
 * 实时语音的状态圆环。套在麦克风按钮外面，本身不接受任何交互。
 *
 * 三层动效各管一件事：
 * - 主层（弧）：现在处在会话的哪个阶段 —— 用户唯一需要读的信息
 * - 次层（辉光）：跟着响度走，比主层慢一拍，声音停了它才收
 * - 环境层（涟漪）：只在「在听」时扩散，负责让静止的等待看起来还活着
 *
 * 颜色也在传话：**在听是红的**（麦克风开着，既是隐私也是计费），
 * 模型自己在忙的时候才转成品牌蓝。开了「减少动态效果」时动画全停、
 * 颜色留着 —— 会话开着这件事不能只靠动画来说。
 */
import { computed, type CSSProperties } from 'vue'
import type { RealtimeVoicePhase } from '../composables/useRealtimeVoice'
import { voiceRingVisual } from './voiceRing'

interface Props {
  phase: RealtimeVoicePhase
  /** 模型出声的真实响度，0–1。`useRealtimeVoice` 的 outputLevel 原样传进来 */
  level?: number
}

const props = withDefaults(defineProps<Props>(), { level: 0 })

/** 半径 20 的周长。弧长按比例从它切 */
const CIRCUMFERENCE = Number((2 * Math.PI * 20).toFixed(2))

const visual = computed(() => voiceRingVisual(props.phase, props.level))

const arcDash = computed(() =>
  visual.value ? `${(visual.value.arc * CIRCUMFERENCE).toFixed(2)} ${CIRCUMFERENCE}` : ''
)

const counterDash = computed(() =>
  visual.value ? `${(visual.value.counterArc * CIRCUMFERENCE).toFixed(2)} ${CIRCUMFERENCE}` : ''
)

const bodyStyle = computed<CSSProperties>(() => ({
  '--voice-level': String(visual.value?.level ?? 0)
}))
</script>

<style scoped lang="less">
.voice-ring {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 44px;
  height: 44px;
  margin: -22px 0 0 -22px;
  pointer-events: none;
  /* 按钮自己的图标要压在环上面 */
  z-index: 0;
}

.voice-ring-body {
  position: absolute;
  inset: 0;
  /*
   * 响度只改这一层的大小。110ms 是贴着音频分片来的（20–100ms 一片）——
   * 再长就会把两个字糊成一次起伏，再短则每片都是一次硬跳。
   */
  transform: scale(calc(1 + var(--voice-level, 0) * 0.14));
  transition: transform 110ms linear;
  will-change: transform;
}

.voice-ring-svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
}

.voice-ring-track {
  fill: none;
  stroke: color-mix(in srgb, var(--ring-color) 20%, transparent);
  stroke-width: 1.5;
}

.voice-ring-arc {
  fill: none;
  stroke: var(--ring-color);
  stroke-width: 2;
  stroke-linecap: round;
  transform-box: fill-box;
  transform-origin: center;
}

.voice-ring-arc.is-counter {
  stroke-width: 1.25;
  opacity: 0.55;
}

/* 次层：跟着声音亮，比主层慢一拍收 —— 声音停了辉光还在，才像有余韵 */
.voice-ring-halo {
  position: absolute;
  inset: -6px;
  border-radius: 50%;
  background: radial-gradient(
    closest-side,
    color-mix(in srgb, var(--ring-color) 28%, transparent),
    transparent 72%
  );
  opacity: 0;
  transition: opacity 180ms var(--easing-standard);
}

/* 环境层：只在「在听」时用，负责让等待看起来还活着 */
.voice-ring-ripple {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  border: 1px solid var(--ring-color);
  opacity: 0;
}

/* ==================== 各阶段 ==================== */

/* 还没连上：一小段快扫。linear 是对的 —— 匀速转圈才读得出「不知道要多久」 */
.voice-ring.is-connecting {
  --ring-color: var(--color-text-secondary);

  .voice-ring-arc {
    animation: voice-ring-spin 900ms linear infinite;
  }
}

/* 在听：整圈闭合 + 呼吸 + 涟漪。红色 = 麦克风开着 */
.voice-ring.is-listening {
  --ring-color: var(--color-danger-solid);

  .voice-ring-arc {
    animation: voice-ring-breathe 2600ms var(--easing-standard) infinite;
  }

  .voice-ring-ripple {
    animation: voice-ring-ripple 2600ms var(--easing-decelerate) infinite;
  }
}

/* 在想：长弧慢扫，副弧反向 —— 反向那一段是「里面有东西在动」 */
.voice-ring.is-thinking {
  --ring-color: var(--color-accent-solid);

  .voice-ring-arc {
    animation: voice-ring-spin 1800ms var(--easing-standard) infinite;
  }

  .voice-ring-arc.is-counter {
    animation: voice-ring-spin-reverse 2400ms var(--easing-standard) infinite;
  }
}

/* 在调工具：两段咬合着转，比 thinking 更机械、更慢，读起来是「在干活」不是「在犹豫」 */
.voice-ring.is-executing {
  --ring-color: var(--color-accent-solid);

  .voice-ring-arc {
    animation: voice-ring-spin 2600ms linear infinite;
  }

  .voice-ring-arc.is-counter {
    animation: voice-ring-spin-reverse 2600ms linear infinite;
  }
}

/* 在说：不转不呼吸，形状完全交给响度。这里任何自带节奏都会跟人声打架 */
.voice-ring.is-speaking {
  --ring-color: var(--color-accent-solid);

  .voice-ring-arc {
    opacity: calc(0.45 + var(--voice-level, 0) * 0.55);
    transition: opacity 110ms linear;
  }

  .voice-ring-halo {
    opacity: calc(var(--voice-level, 0) * 0.9);
  }
}

/* ==================== 进出场 ==================== */

/*
 * 进场比出场长：用户在意的是「开始录音了」这件事，得看清楚。
 * 收的时候往里塌一点点再消失，读起来是被关掉，而不是被抹掉。
 */
.voice-ring-enter-active {
  transition:
    opacity 320ms var(--easing-decelerate),
    transform 320ms var(--easing-decelerate);
}

.voice-ring-leave-active {
  transition:
    opacity 200ms var(--easing-accelerate),
    transform 200ms var(--easing-accelerate);
}

.voice-ring-enter-from {
  opacity: 0;
  transform: scale(0.72);
}

.voice-ring-leave-to {
  opacity: 0;
  transform: scale(0.84);
}

@keyframes voice-ring-spin {
  to {
    transform: rotate(360deg);
  }
}

@keyframes voice-ring-spin-reverse {
  to {
    transform: rotate(-360deg);
  }
}

/* 呼吸：正弦式的一进一出，不是脉冲。缩放和亮度一起走，避免只靠透明度 */
@keyframes voice-ring-breathe {
  0%,
  100% {
    transform: scale(1);
    opacity: 0.6;
  }

  50% {
    transform: scale(1.05);
    opacity: 1;
  }
}

@keyframes voice-ring-ripple {
  0% {
    transform: scale(0.92);
    opacity: 0.35;
  }

  70%,
  100% {
    transform: scale(1.45);
    opacity: 0;
  }
}

/*
 * 「减少动态效果」：动画全停，颜色和整圈的形状留着。
 * 会话开没开、模型在忙什么，光看颜色仍然读得出来。
 */
@media (prefers-reduced-motion: reduce) {
  .voice-ring-body,
  .voice-ring-arc,
  .voice-ring-halo,
  .voice-ring-ripple {
    animation: none !important;
    transition: none !important;
    transform: none !important;
  }

  .voice-ring-ripple {
    display: none;
  }

  .voice-ring-enter-active,
  .voice-ring-leave-active {
    transition: none;
  }
}
</style>
