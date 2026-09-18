<script setup lang="ts">
/**
 * 网页查看器组件
 * 展示 AI 生成的博客网页，支持预览、下载与复制
 *
 * 没有分享：分享是把 HTML 传到官方服务端换一个公开链接，社区版没有那台服务器。
 * 网页本身完全不受影响 —— 生成、预览、下载、复制都是本地能力。
 */
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  PhArrowLeft,
  PhCheck,
  PhCircleNotch,
  PhCopy,
  PhDownloadSimple,
  PhGlobe
} from '@phosphor-icons/vue'
import { message } from '@renderer/utils/messageManager'

const { t } = useI18n()

const props = defineProps<{
  /** HTML 内容 */
  htmlContent: string | null
  /** 标题 */
  title?: string
  /** 产出 ID */
  outputId?: string
  /** 是否正在生成 */
  isGenerating?: boolean
  /** 生成进度 */
  progress?: number
  /** 状态消息 */
  statusMessage?: string
}>()

const emit = defineEmits<{
  (e: 'back'): void
}>()

/** 复制成功状态 */
const copySuccess = ref(false)

/**
 * 下载 HTML
 */
function handleDownload(): void {
  if (!props.htmlContent) {
    message.error(t('notebookWebPageViewer.toast.noDownloadContent'))
    return
  }
  const blob = new Blob([props.htmlContent], { type: 'text/html;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  const timestamp = new Date().toISOString().slice(0, 10)
  link.href = url
  link.download = `webpage-${timestamp}.html`
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
  message.success(t('notebookWebPageViewer.toast.downloaded'))
}

/**
 * 复制 HTML
 */
async function handleCopy(): Promise<void> {
  if (!props.htmlContent) {
    message.error(t('notebookWebPageViewer.toast.noCopyContent'))
    return
  }
  try {
    await navigator.clipboard.writeText(props.htmlContent)
    copySuccess.value = true
    message.success(t('notebookWebPageViewer.toast.copied'))
    setTimeout(() => {
      copySuccess.value = false
    }, 2000)
  } catch {
    message.error(t('notebookWebPageViewer.toast.copyFailed'))
  }
}
</script>

<template>
  <div class="webpage-viewer">
    <!-- 头部 -->
    <div class="viewer-header">
      <div class="header-row">
        <div class="header-left">
          <button class="back-btn" @click="emit('back')">
            <PhArrowLeft />
          </button>
          <div class="header-info">
            <div class="type-badge">
              <PhGlobe />
              <span>{{ $t('notebookWebPageViewer.badge.web') }}</span>
            </div>
            <h2 class="title">{{ title || $t('notebookWebPageViewer.title.fallback') }}</h2>
          </div>
        </div>

        <!-- 工具栏 - 移到标题右侧同行 -->
        <div class="toolbar">
          <button class="tool-btn" :disabled="!htmlContent" @click="handleDownload">
            <PhDownloadSimple />
            <span>{{ $t('notebookWebPageViewer.toolbar.download') }}</span>
          </button>
          <button class="tool-btn" :disabled="!htmlContent" @click="handleCopy">
            <PhCheck v-if="copySuccess" />
            <PhCopy v-else />
            <span>{{
              copySuccess
                ? $t('notebookWebPageViewer.toolbar.copied')
                : $t('notebookWebPageViewer.toolbar.copy')
            }}</span>
          </button>
        </div>
      </div>
    </div>

    <!-- 内容区 -->
    <div class="content-container">
      <!-- 生成中状态 -->
      <div v-if="isGenerating" class="generating-state">
        <div class="generating-content">
          <PhCircleNotch class="icon-spin generating-icon" />
          <div class="generating-info">
            <div class="generating-title">{{ $t('notebookWebPageViewer.generating.title') }}</div>
            <div class="generating-message">
              {{ statusMessage || $t('notebookWebPageViewer.generating.pleaseWait') }}
            </div>
            <div class="progress-bar">
              <div class="progress-fill" :style="{ width: (progress || 0) + '%' }"></div>
            </div>
            <div class="progress-text">{{ progress || 0 }}%</div>
          </div>
        </div>
      </div>

      <!-- 空状态 -->
      <div v-else-if="!htmlContent" class="empty-state">
        <PhGlobe class="empty-icon" />
        <span>{{ $t('notebookWebPageViewer.empty.text') }}</span>
      </div>

      <!-- 预览 -->
      <iframe
        v-else
        class="preview-iframe"
        sandbox=""
        referrerpolicy="no-referrer"
        :srcdoc="htmlContent || ''"
        :title="$t('notebookWebPageViewer.preview.title')"
      ></iframe>
    </div>
  </div>
</template>

<style scoped lang="less">
.webpage-viewer {
  width: 100%;
  height: 100%;
  background: var(--color-bg-surface-hover);
  display: flex;
  flex-direction: column;
}

.viewer-header {
  display: flex;
  flex-direction: column;
  padding: 16px 24px;
  backdrop-filter: blur(10px);
  border-bottom: 1px solid var(--color-border-subtle);
  flex-shrink: 0;

  .header-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 16px;
    flex: 1;
    min-width: 0; // 允许收缩

    .back-btn {
      width: 36px;
      height: 36px;
      flex-shrink: 0;
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
      min-width: 0; // 允许收缩

      .type-badge {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 11px;
        color: var(--color-text-primary);
        background: var(--color-accent-bg);
        padding: 2px 8px;
        border-radius: 4px;
        width: fit-content;
      }

      .title {
        font-size: 16px;
        font-weight: 500;
        color: var(--color-text-primary);
        margin: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 300px; // 限制标题最大宽度
      }
    }
  }

  .toolbar {
    display: flex;
    gap: 8px;
    flex-shrink: 0;

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
      white-space: nowrap;

      &:hover:not(:disabled) {
        background: var(--color-bg-surface-hover);
      }

      &:disabled {
        color: var(--color-text-disabled);
        cursor: not-allowed;
      }
    }
  }
}

.content-container {
  flex: 1;
  overflow: hidden;
}

.generating-state,
.empty-state {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.empty-state {
  flex-direction: column;
  gap: 12px;
  color: var(--color-text-primary);

  .empty-icon {
    font-size: 48px;
    opacity: 0.3;
  }
}

.generating-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 24px;
  padding: 40px;
  background: var(--color-bg-surface-hover);
  border-radius: 16px;
  border: 1px solid var(--color-border-subtle);
  max-width: 400px;

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
    transition: width 0.3s;
  }

  .progress-text {
    font-size: 12px;
    color: var(--color-text-primary);
  }
}

.preview-iframe {
  width: 100%;
  height: 100%;
  border: none;
  background: var(--color-bg-surface);
}
</style>
