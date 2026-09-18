<script setup lang="ts">
/**
 * 信息图查看器组件
 * 展示 AI 生成的信息图，支持下载和复制功能
 */
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  PhArrowLeft,
  PhCheck,
  PhCircleNotch,
  PhCopy,
  PhCornersOut,
  PhDownloadSimple,
  PhImage
} from '@phosphor-icons/vue'
import { message } from '@renderer/utils/messageManager'
import { useInfographicGenerationStore } from '@renderer/store/modules/infographicGenerationStore'
import { openSingleImage } from '@renderer/services/imageViewer'
import { toLocalResourceUrl } from '@renderer/utils/localResource'

const { t } = useI18n()

const props = defineProps<{
  /** 信息图图片数据 (base64 data URL 或 HTTP URL) */
  imageUrl: string | null
  /** 信息图标题 */
  title?: string
  /** 产出 ID，用于检查生成状态 */
  outputId?: string
}>()

const infographicStore = useInfographicGenerationStore()

/** 是否正在生成 */
const isGenerating = computed(() => {
  if (!props.outputId) return false
  return infographicStore.isOutputGenerating(props.outputId)
})

/** 生成进度 */
const progress = computed(() => infographicStore.state.progress)

/** 生成消息 */
const statusMessage = computed(() => infographicStore.state.message)

const emit = defineEmits<{
  /** 返回事件 */
  (e: 'back'): void
}>()

/** 复制成功状态 */
const copySuccess = ref(false)

/** 图片加载状态 */
const imageLoaded = ref(false)

/** 图片加载错误 */
const imageError = ref(false)

/** 是否为 base64 图片 */
const isBase64 = computed(() => {
  return props.imageUrl?.startsWith('data:')
})

/** 是否为本地文件路径 */
const isLocalPath = computed(() => {
  if (!props.imageUrl) return false
  // Windows 路径: C:\path 或 C:/path
  return /^[a-zA-Z]:[/\\]/.test(props.imageUrl)
})

/**
 * 规范化图片 URL
 * 将本地路径转换为 local-resource:// 协议（dev 模式下 file:/// 会被 Chromium 拒绝）
 */
const normalizedImageUrl = computed(() => {
  if (!props.imageUrl) return null
  if (isBase64.value || props.imageUrl.startsWith('http')) {
    return props.imageUrl
  }
  if (props.imageUrl.startsWith('file://') || isLocalPath.value) {
    return toLocalResourceUrl(props.imageUrl) ?? props.imageUrl
  }
  return props.imageUrl
})

watch(
  () => normalizedImageUrl.value,
  () => {
    imageLoaded.value = false
    imageError.value = false
    copySuccess.value = false
  },
  { immediate: true }
)

/**
 * 处理图片加载完成
 */
function handleImageLoad(): void {
  imageLoaded.value = true
  imageError.value = false
}

/**
 * 处理图片加载错误
 */
function handleImageError(): void {
  imageLoaded.value = false
  imageError.value = true
}

/**
 * 下载图片
 */
async function handleDownload(): Promise<void> {
  const imageUrl = normalizedImageUrl.value
  if (!imageUrl) {
    message.error(t('notebookInfographicViewer.toast.noImageToDownload'))
    return
  }

  try {
    // 生成文件名
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const filename = `infographic-${timestamp}.png`

    if (imageUrl.startsWith('data:')) {
      // base64 直接下载；local-resource:// 走下面的 fetch → blob，
      // <a download> 对自定义协议不生效
      const link = document.createElement('a')
      link.href = imageUrl
      link.download = filename
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
    } else {
      // HTTP URL 需要先获取 blob
      const response = await fetch(imageUrl)
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      URL.revokeObjectURL(url)
    }

    message.success(t('notebookInfographicViewer.toast.downloadSuccess'))
  } catch (error) {
    console.error('[InfographicViewer] 下载失败:', error)
    message.error(t('notebookInfographicViewer.toast.downloadFailed'))
  }
}

/**
 * 将图片转换为 PNG Blob
 * Clipboard API 只支持 image/png 格式，需要将其他格式转换
 * @param imageUrl 图片 URL（base64 或 HTTP URL）
 */
async function convertToPngBlob(imageUrl: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'

    img.onload = () => {
      // 创建 canvas 并绘制图片
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight

      const ctx = canvas.getContext('2d')
      if (!ctx) {
        reject(new Error('无法创建 Canvas 上下文'))
        return
      }

      ctx.drawImage(img, 0, 0)

      // 将 canvas 转换为 PNG blob
      canvas.toBlob(
        (blob) => {
          if (blob) {
            resolve(blob)
          } else {
            reject(new Error('无法转换为 PNG'))
          }
        },
        'image/png',
        1.0
      )
    }

    img.onerror = () => {
      reject(new Error('图片加载失败'))
    }

    img.src = imageUrl
  })
}

/**
 * 复制图片到剪贴板
 */
async function handleCopy(): Promise<void> {
  const imageUrl = normalizedImageUrl.value
  if (!imageUrl) {
    message.error(t('notebookInfographicViewer.toast.noImageToCopy'))
    return
  }

  try {
    // 将图片转换为 PNG 格式（Clipboard API 只支持 image/png）
    const pngBlob = await convertToPngBlob(imageUrl)

    // 复制到剪贴板
    await navigator.clipboard.write([
      new ClipboardItem({
        'image/png': pngBlob
      })
    ])

    copySuccess.value = true
    message.success(t('notebookInfographicViewer.toast.copySuccess'))

    // 2秒后重置状态
    setTimeout(() => {
      copySuccess.value = false
    }, 2000)
  } catch (error) {
    console.error('[InfographicViewer] 复制失败:', error)
    message.error(t('notebookInfographicViewer.toast.copyFailed'))
  }
}

/**
 * 全屏查看图片
 */
async function handleFullscreen(): Promise<void> {
  const imageUrl = normalizedImageUrl.value
  if (!imageUrl) {
    message.error(t('notebookInfographicViewer.toast.noImageToView'))
    return
  }
  await openSingleImage(imageUrl, props.title || t('notebookInfographicViewer.defaultTitle'))
}
</script>

<template>
  <div class="infographic-viewer">
    <!-- 头部 -->
    <div class="viewer-header">
      <div class="header-left">
        <button class="back-btn" @click="emit('back')">
          <PhArrowLeft />
        </button>
        <div class="header-info">
          <div class="type-badge">
            <PhImage />
            <span>{{ t('notebookInfographicViewer.typeBadge') }}</span>
          </div>
          <h2 class="title">{{ title || t('notebookInfographicViewer.defaultTitle') }}</h2>
        </div>
      </div>

      <!-- 工具栏 -->
      <div class="toolbar">
        <button class="tool-btn" :disabled="!imageUrl" @click="handleDownload">
          <PhDownloadSimple />
          <span>{{ t('notebookInfographicViewer.toolbar.download') }}</span>
        </button>
        <button class="tool-btn" :disabled="!imageUrl" @click="handleCopy">
          <PhCheck v-if="copySuccess" />
          <PhCopy v-else />
          <span>{{
            copySuccess
              ? t('notebookInfographicViewer.toolbar.copied')
              : t('notebookInfographicViewer.toolbar.copy')
          }}</span>
        </button>
        <button class="tool-btn" :disabled="!imageUrl" @click="handleFullscreen">
          <PhCornersOut />
          <span>{{ t('notebookInfographicViewer.toolbar.fullscreen') }}</span>
        </button>
      </div>
    </div>

    <!-- 图片展示区 -->
    <div class="image-container">
      <!-- 生成中状态 -->
      <div v-if="isGenerating" class="generating-state">
        <div class="generating-content">
          <PhCircleNotch class="icon-spin generating-icon" />
          <div class="generating-info">
            <div class="generating-title">
              {{ t('notebookInfographicViewer.generating.title') }}
            </div>
            <div class="generating-message">
              {{ statusMessage || t('notebookInfographicViewer.generating.pleaseWait') }}
            </div>
            <div class="progress-bar">
              <div class="progress-fill" :style="{ width: progress + '%' }"></div>
            </div>
            <div class="progress-text">{{ progress }}%</div>
          </div>
        </div>
      </div>

      <!-- 空状态 -->
      <div v-else-if="!normalizedImageUrl" class="empty-state">
        <PhImage class="empty-icon" />
        <span>{{ t('notebookInfographicViewer.emptyState') }}</span>
      </div>

      <div v-else-if="imageError" class="error-state">
        <span>{{ t('notebookInfographicViewer.loadFailed') }}</span>
      </div>

      <div v-else class="image-wrapper">
        <div v-if="!imageLoaded" class="loading-state">
          <div class="loading-spinner"></div>
          <span>{{ t('notebookInfographicViewer.loading') }}</span>
        </div>
        <img
          :src="normalizedImageUrl"
          :alt="title || t('notebookInfographicViewer.defaultTitle')"
          class="infographic-image"
          :class="{ loaded: imageLoaded }"
          @load="handleImageLoad"
          @error="handleImageError"
          @click="handleFullscreen"
        />
      </div>
    </div>
  </div>
</template>

<style scoped lang="less">
.infographic-viewer {
  width: 100%;
  height: 100%;
  position: relative;
  background: var(--color-bg-surface-hover);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.viewer-header {
  height: 85px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 24px;
  backdrop-filter: blur(10px);
  border-bottom: 1px solid var(--color-border-subtle);
  z-index: 10;
  flex-shrink: 0;

  .header-left {
    display: flex;
    align-items: center;
    gap: 16px;

    .back-btn {
      width: 36px;
      height: 36px;
      border-radius: 50%;
      border: 1px solid var(--color-border-subtle);
      background: var(--color-bg-surface-hover);
      color: var(--color-text-primary);
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: all 0.2s;

      &:hover {
        background: var(--color-bg-surface-hover);
        transform: scale(1.05);
      }
    }

    .header-info {
      display: flex;
      flex-direction: column;
      gap: 4px;

      .type-badge {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 11px;
        color: var(--color-text-primary);
        background: var(--color-bg-surface-hover);
        padding: 2px 8px;
        border-radius: 4px;
        width: fit-content;
      }

      .title {
        font-size: 16px;
        font-weight: 500;
        color: var(--color-text-primary);
        margin: 0;
        line-height: 1.2;
      }
    }
  }

  .toolbar {
    display: flex;
    gap: 8px;

    .tool-btn {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 16px;
      border-radius: 8px;
      border: 1px solid var(--color-border-subtle);
      background: var(--color-bg-surface-hover);
      color: var(--color-text-primary);
      font-size: 13px;
      cursor: pointer;
      transition: all 0.2s;

      &:hover:not(:disabled) {
        background: var(--color-bg-surface-hover);
        color: var(--color-text-primary);
      }

      &:disabled {
        color: var(--color-text-disabled);
        cursor: not-allowed;
      }
    }
  }
}

.image-container {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  overflow: auto;
}

.empty-state,
.error-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  color: var(--color-text-primary);
  font-size: 14px;

  .empty-icon {
    font-size: 48px;
    opacity: 0.3;
  }
}

.generating-state {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;

  .generating-content {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 24px;
    padding: 40px;
    background: var(--color-bg-surface-hover);
    border-radius: 16px;
    border: 1px solid var(--color-border-subtle);
    backdrop-filter: blur(10px);
    max-width: 400px;
    width: 90%;
  }

  .generating-icon {
    font-size: 48px;
    color: var(--color-accent-text);
  }

  .generating-info {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    width: 100%;
  }

  .generating-title {
    font-size: 18px;
    font-weight: 500;
    color: var(--color-text-primary);
  }

  .generating-message {
    font-size: 14px;
    color: var(--color-text-primary);
    text-align: center;
  }

  .progress-bar {
    width: 100%;
    height: 6px;
    background: var(--color-bg-surface-hover);
    border-radius: 3px;
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    background: var(--gradient-accent);
    border-radius: 3px;
    transition: width 0.3s ease;
  }

  .progress-text {
    font-size: 12px;
    color: var(--color-text-primary);
  }
}

.image-wrapper {
  position: relative;
  max-width: 100%;
  max-height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.loading-state {
  position: absolute;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  color: var(--color-text-primary);

  .loading-spinner {
    width: 32px;
    height: 32px;
    border: 3px solid var(--color-border-subtle);
    border-top-color: var(--color-border-strong);
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.infographic-image {
  max-width: 100%;
  max-height: calc(100vh - 160px);
  object-fit: contain;
  border-radius: 8px;
  box-shadow: 0 8px 32px var(--shadow-color);
  opacity: 0;
  transition: opacity 0.3s ease;
  cursor: zoom-in;

  &.loaded {
    opacity: 1;
  }
}
</style>
