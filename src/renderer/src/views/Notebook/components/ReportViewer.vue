<template>
  <div class="report-viewer">
    <div class="report-header">
      <div class="header-top">
        <div class="header-left">
          <div class="icon-wrapper">
            <PhFileText />
          </div>
          <h2>{{ output.title }}</h2>
        </div>
        <AppButton variant="text" class="close-btn" @click="$emit('close')">
          <template #icon>
            <PhX />
          </template>
        </AppButton>
      </div>
      <div class="meta">
        <span class="tag">{{ $t('notebookReportViewer.tag') }}</span>
        <span v-if="isGenerating" class="status generating">
          <PhCircleNotch /> {{ $t('notebookReportViewer.generating') }}
        </span>
        <span v-else class="status completed">
          <PhCheckCircle /> {{ $t('notebookReportViewer.completed') }}
        </span>
      </div>
    </div>

    <div class="report-content-wrapper">
      <div v-if="!content && !isGenerating" class="empty-state">
        <div class="empty-icon">
          <PhFileText />
        </div>
        <p>{{ $t('notebookReportViewer.emptyState') }}</p>
      </div>

      <div v-else class="markdown-container">
        <MarkdownRenderer :content="content || ''" />

        <!-- 生成中的加载指示器 -->
        <div v-if="isGenerating" class="typing-indicator">
          <span></span>
          <span></span>
          <span></span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import AppButton from '@renderer/components/AppButton.vue'
import { computed } from 'vue'
import { PhCheckCircle, PhCircleNotch, PhFileText, PhX } from '@phosphor-icons/vue'
import type { StudioOutput } from '@renderer/store/modules/studioOutputStore'
import MarkdownRenderer from '@renderer/views/Assistant/components/MarkdownRenderer.vue'

const props = defineProps<{
  output: StudioOutput
  isGenerating?: boolean
}>()

defineEmits<{
  (e: 'close'): void
}>()

const content = computed(() => {
  return props.output.reportContent
})
</script>

<style scoped lang="less">
.report-viewer {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--color-bg-surface-hover);
  border-radius: 12px;
  overflow: hidden;

  .report-header {
    padding: 24px;
    border-bottom: 1px solid var(--color-border-subtle);
    background: var(--color-bg-surface-hover);
    backdrop-filter: blur(10px);

    .header-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;

      .header-left {
        display: flex;
        align-items: center;
        gap: 12px;

        .icon-wrapper {
          width: 40px;
          height: 40px;
          background: var(--color-warning-bg);
          border-radius: 8px;
          display: flex;
          align-items: center;
          justify-content: center;
          color: var(--color-warning-text);
          font-size: 20px;
        }

        h2 {
          margin: 0;
          color: var(--color-text-primary);
          font-size: 20px;
          line-height: 1.4;
          font-weight: 600;
        }
      }

      .close-btn {
        color: var(--color-text-primary);
        &:hover {
          color: var(--color-text-primary);
          background: var(--color-bg-surface-hover);
        }
      }
    }

    .meta {
      display: flex;
      align-items: center;
      gap: 12px;
      padding-left: 52px; // Align with title text (icon width + gap)

      .tag {
        font-size: 12px;
        background: var(--color-bg-surface-hover);
        padding: 2px 8px;
        border-radius: 4px;
        color: var(--color-text-primary);
      }

      .status {
        font-size: 12px;
        display: flex;
        align-items: center;
        gap: 4px;

        &.generating {
          color: var(--color-accent-text);
        }

        &.completed {
          color: var(--color-success-text);
        }
      }
    }
  }

  .report-content-wrapper {
    flex: 1;
    overflow-y: auto;
    padding: 32px 48px; // 增加左右内边距，使阅读体验更好

    /* Custom Scrollbar */
    &::-webkit-scrollbar {
      width: 6px;
    }
    &::-webkit-scrollbar-thumb {
      background: var(--color-bg-surface-hover);
      border-radius: 3px;
    }
    &::-webkit-scrollbar-track {
      background: transparent;
    }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: var(--color-text-primary);
      gap: 16px;

      .empty-icon {
        font-size: 48px;
        opacity: 0.5;
      }
    }

    .markdown-container {
      max-width: 900px;
      margin: 0 auto;

      :deep(.markdown-body) {
        // 针对报告阅读优化样式
        h1 {
          font-size: 28px;
          border-bottom: 1px solid var(--color-border);
          padding-bottom: 16px;
          margin-bottom: 32px;
        }

        h2 {
          font-size: 24px;
          margin-top: 40px;
          margin-bottom: 24px;
          padding-bottom: 8px;
          border-bottom: 1px solid var(--color-border-subtle);
        }

        p {
          font-size: 16px;
          line-height: 1.8;
          margin-bottom: 20px;
          color: var(--color-text-primary);
        }

        ul,
        ol {
          padding-left: 24px;
          li {
            margin-bottom: 8px;
            font-size: 16px;
            color: var(--color-text-primary);
          }
        }
      }
    }

    .typing-indicator {
      display: flex;
      gap: 4px;
      justify-content: center;
      padding: 24px;
      margin-top: 20px;

      span {
        width: 8px;
        height: 8px;
        background: var(--color-bg-surface-hover);
        border-radius: 50%;
        animation: typing 1.4s infinite ease-in-out both;

        &:nth-child(1) {
          animation-delay: -0.32s;
        }
        &:nth-child(2) {
          animation-delay: -0.16s;
        }
      }
    }
  }
}

@keyframes typing {
  0%,
  80%,
  100% {
    transform: scale(0);
  }
  40% {
    transform: scale(1);
  }
}
</style>
