<template>
  <div
    class="selection-overlay"
    @mousedown="handleMouseDown"
    @mousemove="handleMouseMove"
    @mouseup="handleMouseUp"
  >
    <!-- 遮罩层 -->
    <div class="mask top" :style="{ height: selection.y + 'px' }"></div>
    <div class="mask bottom" :style="{ top: selection.y + selection.h + 'px' }"></div>
    <div
      class="mask left"
      :style="{ top: selection.y + 'px', height: selection.h + 'px', width: selection.x + 'px' }"
    ></div>
    <div
      class="mask right"
      :style="{
        top: selection.y + 'px',
        height: selection.h + 'px',
        left: selection.x + selection.w + 'px'
      }"
    ></div>

    <!-- 选区框 -->
    <div
      v-show="isSelecting || hasSelected"
      class="selection-box"
      :style="{
        left: selection.x + 'px',
        top: selection.y + 'px',
        width: selection.w + 'px',
        height: selection.h + 'px'
      }"
    >
      <!-- 尺寸标签 -->
      <div class="dimensions-label">{{ selection.w }} x {{ selection.h }}</div>

      <!-- 工具栏 -->
      <div v-if="hasSelected && !isSelecting" class="toolbar" @mousedown.stop>
        <button class="btn confirm" @click="handleConfirm">
          <svg
            viewBox="0 0 24 24"
            width="16"
            height="16"
            stroke="currentColor"
            stroke-width="2"
            fill="none"
          >
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
          {{ $t('screenRecorderSelectionOverlay.toolbar.confirm') }}
        </button>
        <button class="btn cancel" @click="handleCancel">
          <svg
            viewBox="0 0 24 24"
            width="16"
            height="16"
            stroke="currentColor"
            stroke-width="2"
            fill="none"
          >
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
          {{ $t('screenRecorderSelectionOverlay.toolbar.cancel') }}
        </button>
      </div>
    </div>

    <!-- 提示文本 -->
    <div v-if="!isSelecting && !hasSelected" class="instruction">
      <div class="instruction-text">
        {{ $t('screenRecorderSelectionOverlay.instruction.text') }}
      </div>
      <div class="instruction-sub">{{ $t('screenRecorderSelectionOverlay.instruction.sub') }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'

const selection = ref({ x: 0, y: 0, w: 0, h: 0 })
const startPos = ref({ x: 0, y: 0 })
const isSelecting = ref(false)
const hasSelected = ref(false)

const handleMouseDown = (e: MouseEvent) => {
  // 如果点击的是工具栏，不重新开始选区
  if ((e.target as HTMLElement).closest('.toolbar')) return

  isSelecting.value = true
  hasSelected.value = false
  startPos.value = { x: e.clientX, y: e.clientY }
  selection.value = { x: e.clientX, y: e.clientY, w: 0, h: 0 }
}

const handleMouseMove = (e: MouseEvent) => {
  if (!isSelecting.value) return
  const currentX = e.clientX
  const currentY = e.clientY

  selection.value.w = Math.abs(currentX - startPos.value.x)
  selection.value.h = Math.abs(currentY - startPos.value.y)
  selection.value.x = Math.min(currentX, startPos.value.x)
  selection.value.y = Math.min(currentY, startPos.value.y)
}

const handleMouseUp = () => {
  isSelecting.value = false
  if (selection.value.w > 0 && selection.value.h > 0) {
    hasSelected.value = true
  }
}

const handleConfirm = () => {
  // 发送选区数据回主进程
  // 这里需要使用 IPC，但我们还没定义类型，先假设存在
  window.electron.ipcRenderer.send('screen-recorder:selection-complete', {
    x: selection.value.x,
    y: selection.value.y,
    width: selection.value.w,
    height: selection.value.h
  })
}

const handleCancel = () => {
  window.electron.ipcRenderer.send('screen-recorder:selection-cancelled')
}

const handleKeyDown = (e: KeyboardEvent) => {
  if (e.key === 'Escape') {
    handleCancel()
  }
}

onMounted(() => {
  window.addEventListener('keydown', handleKeyDown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeyDown)
})
</script>

<style lang="less" scoped>
:global(html, body, #app) {
  background-color: transparent;
}

.selection-overlay {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  cursor: crosshair;
  z-index: 99999;
  user-select: none;
  background-color: transparent;

  .mask {
    position: absolute;
    background-color: var(--color-bg-scrim);
    pointer-events: none;

    &.top {
      top: 0;
      left: 0;
      width: 100%;
    }
    &.bottom {
      left: 0;
      width: 100%;
      bottom: 0;
    }
    &.left {
      left: 0;
    }
    &.right {
      right: 0;
    }
  }

  .selection-box {
    position: absolute;
    border: 2px solid var(--color-accent-border);
    background-color: var(--color-accent-bg);
    box-shadow: 0 0 0 1px var(--shadow-highlight);

    .dimensions-label {
      position: absolute;
      top: -24px;
      left: 0;
      background-color: var(--color-accent-solid);
      color: var(--color-text-on-solid);
      padding: 2px 6px;
      font-size: 12px;
      border-radius: 2px;
      white-space: nowrap;
    }

    .toolbar {
      position: absolute;
      bottom: -40px;
      right: 0;
      display: flex;
      gap: 8px;
      background-color: white;
      padding: 4px;
      border-radius: 4px;
      box-shadow: 0 2px 8px var(--shadow-color-weak);
      cursor: default;

      .btn {
        display: flex;
        align-items: center;
        gap: 4px;
        border: none;
        padding: 4px 12px;
        border-radius: 2px;
        font-size: 13px;
        cursor: pointer;
        transition: all 0.2s;

        &.confirm {
          background-color: var(--color-accent-solid);
          color: var(--color-text-on-solid);

          &:hover {
            background-color: var(--color-accent-solid);
          }
        }

        &.cancel {
          background-color: var(--color-bg-raised);
          color: var(--color-text-primary);

          &:hover {
            background-color: var(--color-bg-surface-hover);
          }
        }
      }
    }
  }

  .instruction {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    text-align: center;
    color: var(--color-text-primary);
    text-shadow: 0 1px 4px var(--shadow-color-strong);
    pointer-events: none;

    .instruction-text {
      font-size: 24px;
      font-weight: 500;
      margin-bottom: 8px;
    }

    .instruction-sub {
      font-size: 14px;
      opacity: 0.8;
    }
  }
}
</style>
