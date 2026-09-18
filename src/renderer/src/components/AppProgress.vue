<script setup lang="ts">
/**
 * 进度条 / 进度环。接替 ant-design-vue 的 `<a-progress>`（7 处）。
 *
 * 两种形态：`type="line"`（默认）和 `type="circle"`。上传、导入、批量处理在用。
 *
 * ## 进度必须念得出来
 *
 * 一律带 `role="progressbar"` + aria-valuenow/min/max —— 不带的话读屏软件
 * 只会念到一个空 div，用户完全不知道传到哪了。百分比文字是 `aria-hidden`，
 * 因为那个数字已经在 aria-valuenow 里，念两遍是噪音。
 */
import { computed } from 'vue'

interface Props {
  /** 0–100 */
  percent?: number
  type?: 'line' | 'circle'
  status?: 'normal' | 'active' | 'success' | 'exception'
  /** 线形的粗细 / 环形的直径 */
  size?: 'small' | 'medium'
  /** 显示右侧（或环心）的百分比数字 */
  showInfo?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  percent: 0,
  type: 'line',
  status: 'normal',
  size: 'medium',
  showInfo: true
})

const clamped = computed(() => Math.max(0, Math.min(100, Math.round(props.percent))))

/** 环形几何：半径固定，周长用来做 stroke-dasharray */
const RADIUS = 40
const CIRCUMFERENCE = 2 * Math.PI * RADIUS
const dashOffset = computed(() => CIRCUMFERENCE * (1 - clamped.value / 100))
</script>

<template>
  <div
    :class="['app-progress', `app-progress--${type}`, `app-progress--${status}`]"
    role="progressbar"
    :aria-valuenow="clamped"
    aria-valuemin="0"
    aria-valuemax="100"
  >
    <template v-if="type === 'line'">
      <div :class="['app-progress__track', `app-progress__track--${size}`]">
        <div class="app-progress__fill" :style="{ width: `${clamped}%` }" />
      </div>
      <span v-if="showInfo" class="app-progress__info" aria-hidden="true">{{ clamped }}%</span>
    </template>

    <template v-else>
      <svg class="app-progress__circle" viewBox="0 0 100 100">
        <circle class="app-progress__circle-track" cx="50" cy="50" :r="RADIUS" />
        <circle
          class="app-progress__circle-fill"
          cx="50"
          cy="50"
          :r="RADIUS"
          :stroke-dasharray="CIRCUMFERENCE"
          :stroke-dashoffset="dashOffset"
        />
      </svg>
      <span v-if="showInfo" class="app-progress__circle-info" aria-hidden="true">
        {{ clamped }}%
      </span>
    </template>
  </div>
</template>

<style scoped>
.app-progress--line {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.app-progress__track {
  flex: 1;
  min-width: 0;
  border-radius: var(--radius-full);
  background: var(--color-bg-surface-hover);
  overflow: hidden;
}

.app-progress__track--small {
  height: 4px;
}

.app-progress__track--medium {
  height: 8px;
}

.app-progress__fill {
  height: 100%;
  border-radius: inherit;
  background: var(--color-accent-solid);
  transition: width var(--motion-normal) var(--easing-standard);
}

.app-progress__info {
  flex: none;
  min-width: 3em;
  text-align: right;
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  font-variant-numeric: tabular-nums;
}

/* 状态只改填充色，轨道不动 —— 轨道变色会让整条看起来像另一个控件 */
.app-progress--success .app-progress__fill,
.app-progress--success .app-progress__circle-fill {
  stroke: var(--color-success-solid);
  background: var(--color-success-solid);
}

.app-progress--exception .app-progress__fill,
.app-progress--exception .app-progress__circle-fill {
  stroke: var(--color-danger-solid);
  background: var(--color-danger-solid);
}

/* ---------- 环形 ---------- */
.app-progress--circle {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.app-progress__circle {
  width: 100%;
  height: 100%;
  transform: rotate(-90deg);
}

.app-progress__circle-track,
.app-progress__circle-fill {
  fill: none;
  stroke-width: 8;
}

.app-progress__circle-track {
  stroke: var(--color-bg-surface-hover);
}

.app-progress__circle-fill {
  stroke: var(--color-accent-solid);
  stroke-linecap: round;
  transition: stroke-dashoffset var(--motion-normal) var(--easing-standard);
}

.app-progress__circle-info {
  position: absolute;
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
  font-variant-numeric: tabular-nums;
}

@media (prefers-reduced-motion: reduce) {
  .app-progress__fill,
  .app-progress__circle-fill {
    transition: none;
  }
}
</style>
