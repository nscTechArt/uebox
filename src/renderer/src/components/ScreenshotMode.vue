<template>
  <!-- 截图模式遮罩层 -->
  <Teleport to="body">
    <Transition name="screenshot-fade">
      <div v-if="isActive" class="screenshot-mode">
        <!-- 边缘指示框 -->

        <!-- 浮动工具栏（截图时隐藏） -->
        <div v-show="showOverlay" class="screenshot-toolbar">
          <button :disabled="capturing" class="screenshot-btn capture" @click="handleCapture">
            <span v-if="!capturing">📷 {{ $t('screenshotMode.captureButton') }}</span>
            <span v-else>{{ $t('screenshotMode.processingText') }}</span>
          </button>
          <button class="screenshot-btn cancel" @click="handleExit">
            ✕ {{ $t('screenshotMode.cancelButton') }}
          </button>
        </div>

        <!-- 提示信息（截图时隐藏） -->
        <div v-show="showOverlay" class="screenshot-hint">
          {{ $t('screenshotMode.hintText') }}
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
/**
 * 截图模式组件
 * 显示透明边缘指示和截图控制按钮
 */
import { ref, onMounted, onUnmounted, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { message } from '@renderer/utils/messageManager'

const { t } = useI18n()

/** 截图模式是否激活 */
const isActive = ref(false)
/** 是否正在截图（用于隐藏 UI） */
const capturing = ref(false)
/** 是否显示 UI 覆盖层（截图时隐藏） */
const showOverlay = ref(true)

/**
 * 进入截图模式
 */
async function enterScreenshotMode(): Promise<void> {
  const result = await window.api.screenshot.enterMode()
  if (!result.success) {
    message.error(result.error || '进入截图模式失败')
  }
}

/**
 * 退出截图模式
 */
async function handleExit(): Promise<void> {
  const result = await window.api.screenshot.exitMode()
  if (!result.success) {
    message.error(result.error || '退出截图模式失败')
  }
}

/**
 * 执行截图
 * 截图前隐藏 UI 覆盖层，截图后恢复
 */
async function handleCapture(): Promise<void> {
  capturing.value = true
  // 隐藏 UI 覆盖层
  showOverlay.value = false

  // 等待 DOM 更新和重绘完成
  await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 100))

  try {
    const result = await window.api.screenshot.capture()
    if (result.success) {
      message.success(t('screenshotMode.savedTo', { path: result.filePath }))
      // 截图成功后不退出模式，恢复 UI 显示以便继续截图
      showOverlay.value = true
    } else {
      // 失败时恢复 UI
      showOverlay.value = true
      message.error(result.error || t('screenshotMode.failed'))
    }
  } catch {
    // 出错时恢复 UI
    showOverlay.value = true
    message.error(t('screenshotMode.failed'))
  } finally {
    capturing.value = false
    // 确保 UI 总是恢复
    showOverlay.value = true
  }
}

/**
 * 处理键盘事件
 */
function handleKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && isActive.value) {
    handleExit()
  }
}

// 监听截图模式变化
let cleanup: (() => void) | null = null

onMounted(() => {
  // 监听模式变化事件
  cleanup = window.api.screenshot.onModeChanged((data) => {
    console.log('[ScreenshotMode] Mode changed:', data)
    isActive.value = data.active
    if (data.active) {
      document.body.style.setProperty('--screenshot-padding', `${data.padding}px`)
    } else {
      document.body.style.removeProperty('--screenshot-padding')
    }
  })

  // 主动查询当前状态（防止组件重新挂载时状态丢失）
  window.api.screenshot.getState().then((state) => {
    console.log('[ScreenshotMode] Initial state:', state)
    if (state.isActive) {
      isActive.value = true
      document.body.style.setProperty('--screenshot-padding', `${state.padding}px`)
    }
  })

  // 监听键盘事件
  window.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  cleanup?.()
  window.removeEventListener('keydown', handleKeydown)
  document.body.style.removeProperty('--screenshot-padding')
})

// 导出方法供外部调用
defineExpose({
  enter: enterScreenshotMode,
  exit: handleExit,
  capture: handleCapture,
  isActive
})
</script>

<style scoped>
.screenshot-mode {
  position: fixed;
  inset: 0;
  z-index: 99999;
  pointer-events: none;
}

.screenshot-border {
  position: absolute;
  inset: 0;
  border: var(--screenshot-padding) dashed var(--color-border-strong);
  box-sizing: border-box;
  pointer-events: none;
}

.screenshot-toolbar {
  position: absolute;
  bottom: calc(var(--screenshot-padding, 100px) + 20px);
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 12px;
  padding: 12px 20px;
  background: var(--color-bg-overlay);
  border-radius: 12px;
  backdrop-filter: blur(10px);
  pointer-events: auto;
  box-shadow: 0 4px 20px var(--shadow-color);
}

.screenshot-btn {
  padding: 10px 20px;
  border: none;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.screenshot-btn.capture {
  background: var(--color-success-solid);
  color: var(--color-text-primary);
}

.screenshot-btn.capture:hover:not(:disabled) {
  background: var(--color-success-solid);
  transform: scale(1.02);
}

.screenshot-btn.capture:disabled {
  color: var(--color-text-disabled);
  background: var(--color-bg-surface-hover);
  box-shadow: none;
  cursor: not-allowed;
}

.screenshot-btn.cancel {
  background: var(--color-bg-surface-hover);
  color: var(--color-text-secondary);
}

.screenshot-btn.cancel:hover {
  background: var(--color-bg-surface-hover);
  color: var(--color-text-primary);
}

.screenshot-hint {
  position: absolute;
  top: calc(var(--screenshot-padding, 100px) + 20px);
  left: 50%;
  transform: translateX(-50%);
  padding: 8px 16px;
  background: var(--color-bg-overlay);
  color: var(--color-text-on-solid);
  font-size: 12px;
  border-radius: 6px;
  pointer-events: none;
}

/* 过渡动画 */
.screenshot-fade-enter-active,
.screenshot-fade-leave-active {
  transition: opacity 0.3s ease;
}

.screenshot-fade-enter-from,
.screenshot-fade-leave-to {
  opacity: 0;
}
</style>
