<script setup lang="ts">
/**
 * ViewModeToolbar —— 画布底部的可视化模式条
 *
 * 2026-09-14 重做图标与状态样式：
 * - 原来五个模式用的是 5 张 PNG 截图（img_base.png 那套）缩成 24px 圆点，和旁边的
 *   线性图标完全不是一路，还带 grayscale 滤镜靠亮度区分选中 —— 换成同一套 Phosphor，
 *   按语义挑，不是照着旧图形直译。
 * - 选中态原来是三种颜色的 12px 辉光（橙/绿/蓝），像网吧外设。现在统一成一块底色。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useModel3DViewerStore, type ViewMode } from './viewerStore'
import {
  PhArrowsClockwise,
  PhCamera,
  PhCheckerboard,
  PhCube,
  PhNavigationArrow,
  PhPlay,
  PhPolygon,
  PhSphere
} from '@phosphor-icons/vue'
import type { Component } from 'vue'

const { t } = useI18n()
const store = useModel3DViewerStore()

const props = withDefaults(
  defineProps<{
    /** 有没有可更新的资产。从资产库点进来才有，自己拖进来的文件没有 */
    canSnapshot?: boolean
  }>(),
  { canSnapshot: false }
)

const emit = defineEmits<{
  /** 请求截图 */
  captureSnapshot: []
}>()

/** 图标按含义挑：法线是面朝向（箭头）、线框是多边形、白模是素球、UV 是棋盘格 */
const modes: { key: ViewMode; icon: Component; labelKey: string }[] = [
  { key: 'default', icon: PhCube, labelKey: 'model3dStudio.viewMode.default' },
  { key: 'normal', icon: PhNavigationArrow, labelKey: 'model3dStudio.viewMode.normal' },
  { key: 'wireframe', icon: PhPolygon, labelKey: 'model3dStudio.viewMode.wireframe' },
  { key: 'clay', icon: PhSphere, labelKey: 'model3dStudio.viewMode.clay' },
  { key: 'uv', icon: PhCheckerboard, labelKey: 'model3dStudio.viewMode.uv' }
]

const currentMode = computed(() => store.viewMode)
</script>

<template>
  <div class="view-mode-toolbar">
    <button
      class="mode-btn"
      :class="{ active: store.autoRotate }"
      :title="t('model3dStudio.viewMode.autoRotate')"
      @click="store.setAutoRotate(!store.autoRotate)"
    >
      <PhArrowsClockwise :size="18" :class="{ spinning: store.autoRotate }" />
    </button>
    <button
      class="mode-btn"
      :class="{ active: store.autoPlay }"
      :title="t('model3dStudio.viewMode.autoPlay')"
      @click="store.setAutoPlay(!store.autoPlay)"
    >
      <PhPlay :size="18" />
    </button>

    <div class="separator" />

    <button
      v-for="mode in modes"
      :key="mode.key"
      class="mode-btn"
      :class="{ active: currentMode === mode.key }"
      :title="t(mode.labelKey)"
      @click="store.setViewMode(mode.key)"
    >
      <component :is="mode.icon" :size="18" />
    </button>

    <div class="separator" />

    <button
      class="mode-btn"
      :disabled="!props.canSnapshot"
      :title="
        props.canSnapshot
          ? t('model3dStudio.viewMode.snapshot')
          : t('model3dStudio.viewMode.snapshotUnavailable')
      "
      @click="emit('captureSnapshot')"
    >
      <PhCamera :size="18" />
    </button>
  </div>
</template>

<style scoped>
.view-mode-toolbar {
  position: absolute;
  bottom: var(--space-4);
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-full);
  background: var(--color-bg-overlay);
  backdrop-filter: blur(16px);
  z-index: 100;
}

.mode-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 0;
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  transition:
    background-color var(--motion-fast) var(--easing-standard),
    color var(--motion-fast) var(--easing-standard);
}

.mode-btn:hover:not(:disabled) {
  background: var(--color-bg-surface-hover);
  color: var(--color-text-primary);
}

.mode-btn:disabled {
  color: var(--color-text-disabled);
  cursor: default;
}

/* 选中就是选中：一块底色说清楚，不靠发光 */
.mode-btn.active {
  background: var(--color-bg-selected);
  color: var(--color-text-selected);
}

.separator {
  width: 1px;
  height: 18px;
  margin: 0 var(--space-1);
  background: var(--color-border-subtle);
}

.spinning {
  animation: spin 2s linear infinite;
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
</style>
