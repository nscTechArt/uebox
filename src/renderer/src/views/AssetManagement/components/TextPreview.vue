<template>
  <div class="text-preview selectable">
    <div v-if="loading" class="status-message">
      <AppSpin :tip="$t('assetTextPreview.loadingTip')" />
    </div>
    <div v-else-if="error" class="status-message error">
      {{ error }}
    </div>
    <div v-else class="content-wrapper">
      <div class="text-header">
        <span class="type-text">TEXT</span>
        <AppButton variant="link" size="small" class="copy-btn" @click="handleCopy">
          <template #icon><PhCopy /></template>
          {{ copied ? $t('assetTextPreview.copied') : $t('assetTextPreview.copy') }}
        </AppButton>
      </div>
      <pre class="selectable">{{ content }}</pre>
    </div>
  </div>
</template>

<script setup lang="ts">
import AppSpin from '@renderer/components/AppSpin.vue'
import AppButton from '@renderer/components/AppButton.vue'
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { PhCopy } from '@phosphor-icons/vue'
import { message } from '@renderer/utils/messageManager'
import { fetchRemoteTextPreview, isHttpUrl } from '@renderer/utils/assetAccess'

const { t } = useI18n()

interface Props {
  filePath?: string
  fileUrl?: string
}

const props = defineProps<Props>()

const content = ref('')
const loading = ref(false)
const error = ref('')

// 定义简单的 API 接口以避免 any
interface WindowApi {
  fs: {
    readFile: (
      path: string,
      options?: { encoding?: string; maxBytes?: number }
    ) => Promise<string | { content: string }>
  }
}

/**
 * 加载文件内容
 */
const loadFile = async (): Promise<void> => {
  if (!props.filePath && !props.fileUrl) return

  loading.value = true
  error.value = ''
  content.value = ''

  try {
    if (props.fileUrl && isHttpUrl(props.fileUrl)) {
      const result = await fetchRemoteTextPreview(props.fileUrl, { maxBytes: 1024 * 1024 })
      content.value = result.content
    } else {
      const api = (window as unknown as { api: WindowApi }).api
      const res = await api.fs.readFile(props.filePath || '', {
        encoding: 'utf-8',
        maxBytes: 1024 * 1024
      })

      if (typeof res === 'string') {
        content.value = res
      } else if (res && typeof res.content === 'string') {
        content.value = res.content
      } else {
        content.value = ''
      }
    }
  } catch (err: unknown) {
    console.error('Failed to load file:', err)
    const message = err instanceof Error ? err.message : String(err)
    error.value = t('assetTextPreview.readFailed', {
      message: message || t('assetTextPreview.unknownError')
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
    await navigator.clipboard.writeText(content.value)
    copied.value = true
    message.success(t('assetTextPreview.copySuccess'))
    setTimeout(() => {
      copied.value = false
    }, 2000)
  } catch (err) {
    console.error('Failed to copy text:', err)
    message.error(t('assetTextPreview.copyFailed'))
  }
}

watch(() => [props.filePath, props.fileUrl], loadFile, { immediate: true })
</script>

<style scoped>
.text-preview {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background-color: var(--color-bg-surface); /* Dark background safer for text files */
  color: var(--color-text-primary);
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

.text-header {
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

.type-text {
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
  white-space: pre-wrap; /* Wrap text */
  word-break: break-all;
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  font-size: 14px;
  line-height: 1.5;
  user-select: text !important;
  -webkit-user-select: text !important;
}
</style>
