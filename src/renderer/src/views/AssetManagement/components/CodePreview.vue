<template>
  <div class="code-preview selectable">
    <div v-if="loading" class="status-message">
      <AppSpin :tip="$t('assetCodePreview.loadingTip')" />
    </div>
    <div v-else-if="error" class="status-message error">
      {{ error }}
    </div>
    <div v-else class="content-wrapper">
      <div class="code-header">
        <span class="lang-text">{{ fileExtension || 'code' }}</span>
        <AppButton variant="link" size="small" class="copy-btn" @click="handleCopy">
          <template #icon><PhCopy /></template>
          {{ copied ? $t('assetCodePreview.copied') : $t('assetCodePreview.copy') }}
        </AppButton>
      </div>
      <pre><code class="hljs" :class="languageClass" v-html="highlightedContent"></code></pre>
    </div>
  </div>
</template>

<script setup lang="ts">
import AppSpin from '@renderer/components/AppSpin.vue'
import AppButton from '@renderer/components/AppButton.vue'
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import hljs from 'highlight.js'
import 'highlight.js/styles/atom-one-dark.css'
import { PhCopy } from '@phosphor-icons/vue'
import { message } from '@renderer/utils/messageManager'
import { fetchRemoteTextPreview, isHttpUrl } from '@renderer/utils/assetAccess'

const { t } = useI18n()

interface Props {
  filePath?: string
  fileUrl?: string
  fileExtension?: string
}

const props = defineProps<Props>()

const rawContent = ref('')
const loading = ref(false)
const error = ref('')

/**
 * 语言类名
 */
const languageClass = computed(() => {
  if (props.fileExtension && hljs.getLanguage(props.fileExtension)) {
    return `language-${props.fileExtension}`
  }
  return ''
})

/**
 * 高亮后的内容
 */
const highlightedContent = computed(() => {
  if (!rawContent.value) return ''

  // 如果指定了扩展名且 hljs 支持，则使用指定语言高亮
  if (props.fileExtension && hljs.getLanguage(props.fileExtension)) {
    try {
      return hljs.highlight(rawContent.value, {
        language: props.fileExtension,
        ignoreIllegals: true
      }).value
    } catch {
      console.warn('Highlight failed for specified language')
    }
  }

  // 否则尝试自动检测
  try {
    return hljs.highlightAuto(rawContent.value).value
  } catch {
    // 降级处理：转义 HTML
    return rawContent.value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }
})

// 定义简单的 API 接口
interface WindowApi {
  fs: {
    readFile: (
      path: string,
      options?: { encoding?: string; maxBytes?: number }
    ) => Promise<string | { content: string }>
  }
}

/**
 * 加载文件
 */
const loadFile = async (): Promise<void> => {
  if (!props.filePath && !props.fileUrl) return

  loading.value = true
  error.value = ''
  rawContent.value = ''

  try {
    if (props.fileUrl && isHttpUrl(props.fileUrl)) {
      const result = await fetchRemoteTextPreview(props.fileUrl, { maxBytes: 1024 * 1024 })
      rawContent.value = result.content
    } else {
      const api = (window as unknown as { api: WindowApi }).api
      const res = await api.fs.readFile(props.filePath || '', {
        encoding: 'utf-8',
        maxBytes: 1024 * 1024
      })

      if (typeof res === 'string') {
        rawContent.value = res
      } else if (res && typeof res.content === 'string') {
        rawContent.value = res.content
      } else {
        rawContent.value = ''
      }
    }
  } catch (err: unknown) {
    console.error('Failed to load code file:', err)
    const message = err instanceof Error ? err.message : String(err)
    error.value = t('assetCodePreview.readFailed', {
      message: message || t('assetCodePreview.unknownError')
    })
  } finally {
    loading.value = false
  }
}

const copied = ref(false)

/**
 * 复制代码到剪贴板
 */
const handleCopy = async (): Promise<void> => {
  try {
    await navigator.clipboard.writeText(rawContent.value)
    copied.value = true
    message.success(t('assetCodePreview.copySuccess'))
    setTimeout(() => {
      copied.value = false
    }, 2000)
  } catch (err) {
    console.error('Failed to copy code:', err)
    message.error(t('assetCodePreview.copyFailed'))
  }
}

watch(() => [props.filePath, props.fileUrl], loadFile, { immediate: true })
</script>

<style scoped>
.code-preview {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background-color: var(--color-bg-surface); /* match atom-one-dark usually or similar */
  color: var(--color-text-secondary);
  overflow: hidden;
  user-select: text; /* 允许选择文本 */
  -webkit-user-select: text;
}

.status-message {
  display: flex;
  justify-content: center;
  align-items: center;
  height: 100%;
  color: var(--color-text-secondary);
}

.status-message.error {
  color: var(--color-danger-text);
}

.content-wrapper {
  flex: 1;
  overflow: auto;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.code-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 16px;
  background-color: var(--color-bg-surface-hover);
  border-bottom: 1px solid var(--color-border-subtle);
  position: sticky;
  top: 0;
  z-index: 10;
}

.lang-text {
  font-size: 12px;
  color: var(--color-text-secondary);
  text-transform: uppercase;
  font-weight: 600;
}

.copy-btn {
  color: var(--color-text-secondary);
  font-size: 12px;
}

.copy-btn:hover {
  color: var(--color-text-primary);
}

pre {
  margin: 0;
  padding: 16px;
  flex: 1;
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  font-size: 14px;
  line-height: 1.5;
}

code.hljs {
  background: transparent;
  padding: 0;
  overflow-x: visible; /* Let pre handle scroll */
}
</style>
