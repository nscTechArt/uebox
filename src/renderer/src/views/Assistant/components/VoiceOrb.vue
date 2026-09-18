<template>
  <Transition name="voice-orb">
    <div
      v-if="visual"
      class="voice-orb"
      :class="[`is-${visual.speaker}`, `rest-${visual.resting}`]"
      :style="orbStyle"
      aria-hidden="true"
    >
      <span class="voice-orb-glow"></span>
      <span class="voice-orb-body">
        <!--
          响度和说话人一起交给球体：球里那三团史莱姆靠它们决定鼓多大、哪个色相占上风。
          动效全在球**里面** —— 外面不再套任何扩散的圈。
        -->
        <BrandSphere
          :size="size"
          :minimum-size="size"
          :level="visual.level"
          :speaker="visual.speaker"
        />
      </span>
    </div>
  </Transition>
</template>

<script setup lang="ts">
/**
 * 对话中的语音球。它要回答的是**此刻谁在说话**，而这件事必须一眼读出来，
 * 不能靠猜：
 *
 * - 你在说：翡翠绿占上风，三团一起鼓起来
 * - 它在说：电蓝占上风
 * - 没人说话：三团继续慢慢流动（会话还开着），外面留一层很淡的底光标出状态
 *
 * 这一层自己**不画任何动效** —— 它只决定谁在说话、有多大声，然后把这两个数
 * 交给 BrandSphere。动的东西全在球里面：外面再套一圈扩散波纹的话，
 * 眼睛会被最外层那道边吸走，而真正在传达信息的是里面那三团。
 *
 * 响度是真的：两路都来自 PCM 的均方根，不是拿状态假装的波形。
 */
import { computed, type CSSProperties } from 'vue'
import BrandSphere from './BrandSphere.vue'
import type { RealtimeVoicePhase } from '../composables/useRealtimeVoice'
import { voiceOrbVisual } from './voiceOrb'

interface Props {
  phase: RealtimeVoicePhase
  /** 麦克风采到的响度，0–1 */
  inputLevel?: number
  /** 正在播放的响度，0–1 */
  outputLevel?: number
  size?: number
}

const props = withDefaults(defineProps<Props>(), {
  inputLevel: 0,
  outputLevel: 0,
  size: 72
})

const visual = computed(() => voiceOrbVisual(props.phase, props.inputLevel, props.outputLevel))

const orbStyle = computed<CSSProperties>(() => ({
  '--orb-level': String(visual.value?.level ?? 0),
  width: `${props.size}px`,
  height: `${props.size}px`
}))
</script>

<style scoped lang="less">
.voice-orb {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
}

/*
 * 整个球轻微地随响度胀一下。
 *
 * 幅度只有 6% —— 大头在球**里面**（那三团会鼓起来、会更亮），
 * 外面再放大一次的话，72px 的球会顶到输入框上。
 */
.voice-orb-body {
  position: relative;
  z-index: 2;
  display: flex;
  transform: scale(calc(1 + var(--orb-level, 0) * 0.06));
  transition: transform 110ms linear;
  will-change: transform;
}

.voice-orb-body :deep(.brand-sphere) {
  margin-bottom: 0;
  cursor: default;
}

/*
 * 底光。**只在没人说话的间隙里出现** ——
 * 有人说话时球体自己的辉光已经在做这件事了，两层叠着只会糊成一团。
 * 它在这里的职责是把安静的那一刻也标出颜色：红=麦克风开着，蓝=它在忙。
 */
.voice-orb-glow {
  position: absolute;
  inset: -18%;
  z-index: 1;
  border-radius: 50%;
  background: radial-gradient(
    closest-side,
    color-mix(in srgb, var(--orb-color, transparent) 45%, transparent),
    transparent 70%
  );
  opacity: 0;
  transition:
    opacity 260ms var(--easing-standard),
    background 220ms var(--easing-standard);
}

/*
 * 没人说话的间隙。这时候球里那三团仍然在慢慢流动 —— 会话确实还开着 ——
 * 但外面这层底光负责说清楚是在等你，还是它在忙。
 */
.voice-orb.is-idle {
  &.rest-listening {
    /* 在等你开口：红色底光常驻，因为麦克风确实开着 */
    --orb-color: var(--color-danger-solid);

    .voice-orb-glow {
      opacity: 0.22;
    }
  }

  &.rest-busy {
    /* 在想 / 在调工具：转成蓝，底光慢慢起伏，表示它没死机 */
    --orb-color: var(--color-accent-solid);

    .voice-orb-glow {
      animation: voice-orb-think 2600ms var(--easing-standard) infinite;
    }
  }
}

/* ==================== 进出场 ==================== */

.voice-orb-enter-active {
  transition:
    opacity 360ms var(--easing-decelerate),
    transform 360ms var(--easing-decelerate);
}

.voice-orb-leave-active {
  transition:
    opacity 220ms var(--easing-accelerate),
    transform 220ms var(--easing-accelerate);
}

.voice-orb-enter-from {
  opacity: 0;
  transform: scale(0.7);
}

.voice-orb-leave-to {
  opacity: 0;
  transform: scale(0.82);
}

/* 在想：底光很慢地一涨一落。慢是重点 —— 快了会被读成「在说话」 */
@keyframes voice-orb-think {
  0%,
  100% {
    opacity: 0.14;
  }

  50% {
    opacity: 0.34;
  }
}

/* 「减少动态效果」：缩放和呼吸停掉，颜色留着 */
@media (prefers-reduced-motion: reduce) {
  .voice-orb-body,
  .voice-orb-glow {
    animation: none !important;
    transition: none !important;
    transform: none !important;
  }

  .voice-orb-enter-active,
  .voice-orb-leave-active {
    transition: none;
  }
}
</style>
