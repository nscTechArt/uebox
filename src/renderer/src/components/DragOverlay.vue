<template>
  <Teleport to="body">
    <div
      v-if="visible"
      class="global-drag-overlay"
      :style="{ left: pos.x + 'px', top: pos.y + 'px' }"
    >
      {{ text }}
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'

interface Props {
  visible: boolean
  text?: string
  offsetX?: number
  offsetY?: number
}

const props = withDefaults(defineProps<Props>(), {
  text: '',
  offsetX: 12,
  offsetY: 12
})

const pos = ref<{ x: number; y: number }>({ x: 0, y: 0 })

/**
 * 三个事件都要听：
 * - mousemove：自己用 mousedown 实现的拖拽（资产库左树那套）只有它
 * - drag：原生 HTML5 拖拽期间 mousemove **不触发**，只有 drag 一直在源元素上冒泡
 * - dragover：光标落在别的可放置区域上时的补充
 * 少听一个 drag，小条就会一直停在初始的 (0,0)，也就是窗口左上角。
 */
const handleMove = (e: MouseEvent | DragEvent): void => {
  // 松手那一下浏览器会补一个坐标为 (0,0) 的事件，跟着它走小条会先跳到左上角再消失
  if (!e.clientX && !e.clientY) return
  pos.value = { x: e.clientX + props.offsetX, y: e.clientY + props.offsetY }
}

// 常挂着，不跟着 visible 开关：拖拽开始的那一瞬间监听器必须已经在了，
// 晚一个 tick 挂上就会错过前几个事件，小条从左上角「飞」过来
const bindMoveListeners = (): void => {
  window.addEventListener('mousemove', handleMove)
  window.addEventListener('drag', handleMove)
  window.addEventListener('dragover', handleMove)
}

const unbindMoveListeners = (): void => {
  window.removeEventListener('mousemove', handleMove)
  window.removeEventListener('drag', handleMove)
  window.removeEventListener('dragover', handleMove)
}

onMounted(bindMoveListeners)
onUnmounted(unbindMoveListeners)
</script>

<style scoped>
.global-drag-overlay {
  position: fixed;
  z-index: 10000;
  pointer-events: none;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: var(--radius-xs, 8px);
  font-size: 12px;
  line-height: 1.4;
  color: var(--color-text-primary);
  background: linear-gradient(180deg, var(--color-bg-surface), var(--color-bg-surface));
  border: 1px solid var(--color-border-subtle);
  box-shadow: 0 8px 24px var(--shadow-color);
  white-space: nowrap;
  backdrop-filter: saturate(120%) blur(6px);
  transform: translateZ(0);
  animation: dragOverlayFadeIn 120ms ease-out;
}

.global-drag-overlay::before {
  content: '';
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-accent-solid);
  box-shadow: 0 0 0 3px var(--color-accent-border);
}

@keyframes dragOverlayFadeIn {
  from {
    opacity: 0;
    transform: translateY(2px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>
