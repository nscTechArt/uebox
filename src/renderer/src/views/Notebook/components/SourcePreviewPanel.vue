<script setup lang="ts">
import AppButton from '@renderer/components/AppButton.vue'
/**
 * 来源内容预览组件
 * 用于在知识库中预览 Markdown 格式的来源内容
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { PhArrowLeft, PhFileText, PhGlobe, PhLink } from '@phosphor-icons/vue'
import MarkdownRenderer from '@renderer/views/Assistant/components/MarkdownRenderer.vue'
import { getFileTypeLabel } from '../utils/fileTypeUtils'

/**
 * 来源项接口
 */
interface SourceItem {
  id: string
  title: string
  type: 'file' | 'link' | 'youtube' | 'bilibili' | 'text' | 'note' | 'ue-project' | 'wechat' | 'mp'
  content: string | File
  /** 抓回来的原文（清洗过的网页才有） */
  rawContent?: string | null
  /** 原始 URL */
  sourceUrl?: string
  /** 文件名（用于获取文件类型标签） */
  fileName?: string
}

const props = defineProps<{
  /** 要预览的来源 */
  source: SourceItem
}>()

const emit = defineEmits<{
  /** 返回事件 */
  (e: 'back'): void
  /** 打开原始链接 */
  (e: 'open-url', url: string): void
}>()

const { t } = useI18n()

/**
 * 现在看的是原文还是清洗后的。
 *
 * 清洗是有损的 —— 模型判断哪段是广告、哪段是正文，判错了就是删掉了正文。
 * 所以原文得留一份，并且用户随时能切回去对账。默认看清洗后的（那才是 AI 用的）。
 */
const showingRaw = ref(false)

/** 这条来源有没有留着原文 */
const hasRawContent = computed(() => Boolean(props.source.rawContent?.trim()))

// 换了一条来源就切回默认视图，否则上一条选的「看原文」会带到下一条上
watch(
  () => props.source.id,
  () => {
    showingRaw.value = false
  }
)

/**
 * 获取内容字符串
 * 如果内容是 File 类型，返回提示信息
 */
const contentString = computed(() => {
  if (props.source.content instanceof File) {
    return t('notebookSourcePreviewPanel.unsupportedFileContent', {
      name: props.source.content.name
    })
  }
  if (showingRaw.value && props.source.rawContent) return props.source.rawContent
  return props.source.content || ''
})

/**
 * 判断是否应该使用 HTML 渲染
 * 笔记类型 (note) 的内容来自 Tiptap 编辑器，是 HTML 格式
 * text 类型仍然是 Markdown 内容
 */
const isHtmlContent = computed(() => {
  return props.source.type === 'note'
})

/**
 * 获取来源类型显示文本
 */
const sourceTypeLabel = computed(() => {
  // 如果是文件类型并且有文件名，使用文件类型标签
  if (props.source.type === 'file' && props.source.fileName) {
    return getFileTypeLabel(props.source.fileName)
  }

  switch (props.source.type) {
    case 'link':
      return t('notebookSourcePreviewPanel.type.link')
    case 'youtube':
      return t('notebookSourcePreviewPanel.type.youtube')
    case 'bilibili':
      return t('notebookSourcePreviewPanel.type.bilibili')
    case 'text':
      return t('notebookSourcePreviewPanel.type.text')
    case 'note':
      return t('notebookSourcePreviewPanel.type.note')
    case 'file':
      return t('notebookSourcePreviewPanel.type.file')
    case 'ue-project':
      return t('notebookSourcePreviewPanel.type.ueProject')
    default:
      return t('notebookSourcePreviewPanel.type.default')
  }
})

/**
 * 打开原始链接
 */
const handleOpenUrl = (): void => {
  if (props.source.sourceUrl) {
    emit('open-url', props.source.sourceUrl)
  }
}
</script>

<template>
  <div class="source-preview-panel">
    <!-- 头部 -->
    <div class="preview-header">
      <div class="header-left">
        <button class="back-btn" @click="$emit('back')">
          <PhArrowLeft />
        </button>
        <div class="source-info">
          <div class="source-type">
            <PhGlobe v-if="source.type === 'link'" />
            <span>{{ sourceTypeLabel }}</span>
          </div>
          <h2 class="source-title">{{ source.title }}</h2>
        </div>
      </div>

      <div class="header-actions">
        <AppButton
          v-if="hasRawContent"
          variant="text"
          class="action-btn"
          @click="showingRaw = !showingRaw"
        >
          <PhFileText />
          <span>{{
            showingRaw ? $t('notebook.source.viewCleaned') : $t('notebook.source.viewRaw')
          }}</span>
        </AppButton>
        <AppButton v-if="source.sourceUrl" variant="text" class="action-btn" @click="handleOpenUrl">
          <PhLink />
          <span>{{ $t('notebookSourcePreviewPanel.openOriginalLink') }}</span>
        </AppButton>
      </div>
    </div>

    <!-- 内容区域 -->
    <div class="preview-content">
      <div v-if="showingRaw" class="raw-hint">{{ $t('notebook.source.rawHint') }}</div>
      <!-- 笔记类型使用 HTML 渲染 (Tiptap 编辑器输出) -->
      <div v-if="isHtmlContent" class="html-content" v-html="contentString"></div>
      <!-- 其他类型使用 Markdown 渲染 -->
      <MarkdownRenderer v-else :content="contentString" />
    </div>
  </div>
</template>

<style scoped lang="less">
.source-preview-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--color-bg-surface);
  color: var(--color-text-primary);
  :deep(.markdown-body) {
    user-select: text;
  }
}

.raw-hint {
  margin-bottom: 12px;
  padding: 8px 12px;
  border-radius: 6px;
  background: var(--color-warning-bg);
  color: var(--color-warning-text);
  font-size: 12px;
}

.preview-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 24px;
  border-bottom: 1px solid var(--color-border-subtle);
  background: linear-gradient(to bottom, rgba(0, 0, 0, 0.3), rgba(0, 0, 0, 0.15));
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);

  .header-left {
    display: flex;
    align-items: center;
    gap: 16px;
    flex: 1;
    min-width: 0;

    .back-btn {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      border: none;
      background: var(--color-bg-surface-hover);
      color: var(--color-text-primary);
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      flex-shrink: 0;
      font-size: 16px;

      &:hover {
        background: var(--color-bg-surface-hover);
        transform: translateX(-2px);
        box-shadow: 0 2px 8px var(--shadow-color-weak);
      }

      &:active {
        transform: translateX(-2px) scale(0.95);
      }
    }

    .source-info {
      display: flex;
      flex-direction: column;
      gap: 6px;
      flex: 1;
      min-width: 0;

      .source-type {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 11px;
        color: var(--color-text-primary);
        background: var(--color-accent-bg);
        padding: 3px 10px;
        border-radius: 12px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        font-weight: 500;
        width: fit-content;
      }

      .source-title {
        font-size: 18px;
        font-weight: 600;
        color: var(--color-text-primary);
        margin: 0;
        line-height: 1.3;
        word-break: break-word;
        overflow: hidden;
        text-overflow: ellipsis;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        line-clamp: 2;
        -webkit-box-orient: vertical;
      }
    }
  }

  .header-actions {
    display: flex;
    gap: 8px;
    flex-shrink: 0;

    .action-btn {
      display: flex;
      align-items: center;
      gap: 6px;
      color: var(--color-accent-text);
      font-size: 13px;
      padding: 8px 16px;
      border-radius: 8px;
      transition: all 0.2s;

      &:hover {
        color: var(--color-text-primary);
        background: var(--color-accent-bg);
      }
    }
  }
}

.preview-content {
  flex: 1;
  overflow-y: auto;
  padding: 24px 32px;

  // 自定义 Markdown 渲染样式
  :deep(.markdown-body) {
    font-size: 15px;
    line-height: 1.7;
    color: var(--color-text-primary);

    h1,
    h2,
    h3,
    h4,
    h5,
    h6 {
      color: var(--color-text-primary);
      margin-top: 24px;
      margin-bottom: 16px;
      font-weight: 600;
      line-height: 1.25;
    }

    h1 {
      font-size: 1.8em;
      padding-bottom: 0.3em;
      border-bottom: 1px solid var(--color-border-subtle);
    }

    h2 {
      font-size: 1.5em;
      padding-bottom: 0.3em;
      border-bottom: 1px solid var(--color-border-subtle);
    }

    h3 {
      font-size: 1.25em;
    }

    p {
      margin-bottom: 16px;
    }

    a {
      color: var(--color-accent-text);
      text-decoration: none;

      &:hover {
        text-decoration: underline;
      }
    }

    code {
      background: var(--color-bg-surface-hover);
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 0.9em;
    }

    pre {
      background: var(--color-bg-surface-hover);
      border-radius: 8px;
      padding: 16px;
      overflow-x: auto;

      code {
        background: none;
        padding: 0;
      }
    }

    ul,
    ol {
      padding-left: 24px;
      margin-bottom: 16px;
    }

    li {
      margin-bottom: 8px;
    }

    blockquote {
      border-left: 4px solid var(--color-accent-border);
      padding-left: 16px;
      margin: 16px 0;
      color: var(--color-text-secondary);
      font-style: italic;
    }

    hr {
      border: none;
      border-top: 1px solid var(--color-border-subtle);
      margin: 24px 0;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 16px;

      th,
      td {
        border: 1px solid var(--color-border-subtle);
        padding: 10px 12px;
        text-align: left;
      }

      th {
        background: var(--color-bg-surface-hover);
        font-weight: 600;
      }

      tr:hover {
        background: var(--color-bg-surface-hover);
      }
    }

    img {
      max-width: 100%;
      border-radius: 8px;
      margin: 16px 0;
    }
  }

  // HTML 渲染样式 (用于笔记类型)
  .html-content {
    font-size: 15px;
    line-height: 1.7;
    color: var(--color-text-primary);
    user-select: text;

    h1,
    h2,
    h3,
    h4,
    h5,
    h6 {
      color: var(--color-text-primary);
      margin-top: 24px;
      margin-bottom: 16px;
      font-weight: 600;
      line-height: 1.25;
    }

    h1 {
      font-size: 1.8em;
      padding-bottom: 0.3em;
      border-bottom: 1px solid var(--color-border-subtle);
    }

    h2 {
      font-size: 1.5em;
      padding-bottom: 0.3em;
      border-bottom: 1px solid var(--color-border-subtle);
    }

    h3 {
      font-size: 1.25em;
    }

    p {
      margin-bottom: 16px;
    }

    a {
      color: var(--color-accent-text);
      text-decoration: none;

      &:hover {
        text-decoration: underline;
      }
    }

    strong {
      font-weight: 600;
      color: var(--color-text-primary);
    }

    em {
      font-style: italic;
    }

    s {
      text-decoration: line-through;
    }

    code {
      background: var(--color-bg-surface-hover);
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 0.9em;
      font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
    }

    pre {
      background: var(--color-bg-surface-hover);
      border-radius: 8px;
      padding: 16px;
      overflow-x: auto;

      code {
        background: none;
        padding: 0;
      }
    }

    ul,
    ol {
      padding-left: 24px;
      margin-bottom: 16px;
    }

    li {
      margin-bottom: 8px;

      p {
        margin-bottom: 8px;
      }
    }

    blockquote {
      border-left: 4px solid var(--color-accent-border);
      padding-left: 16px;
      margin: 16px 0;
      color: var(--color-text-secondary);
      font-style: italic;
    }

    hr {
      border: none;
      border-top: 1px solid var(--color-border-subtle);
      margin: 24px 0;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 16px;

      th,
      td {
        border: 1px solid var(--color-border-subtle);
        padding: 10px 12px;
        text-align: left;
      }

      th {
        background: var(--color-bg-surface-hover);
        font-weight: 600;
      }

      tr:hover {
        background: var(--color-bg-surface-hover);
      }
    }

    img {
      max-width: 100%;
      border-radius: 8px;
      margin: 16px 0;
    }

    // Tiptap 特有元素样式
    .editor-image {
      max-width: 100%;
      border-radius: 8px;
    }

    .editor-table {
      width: 100%;
      border-collapse: collapse;
    }

    // 任务列表样式
    ul[data-type='taskList'] {
      list-style: none;
      padding-left: 0;

      li {
        display: flex;
        align-items: flex-start;
        gap: 8px;

        &[data-checked='true'] {
          text-decoration: line-through;
          opacity: 0.6;
        }

        input[type='checkbox'] {
          margin-top: 4px;
        }
      }
    }

    // 高亮标记
    mark {
      background: var(--color-warning-bg);
      color: inherit;
      padding: 0 2px;
      border-radius: 2px;
    }
  }
}
</style>
