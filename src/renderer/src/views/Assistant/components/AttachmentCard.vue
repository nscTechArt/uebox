<template>
  <div
    class="attachment-card"
    :class="[`is-${kind}`, { 'is-busy': busy, 'is-error': !!error }]"
    :title="fileName"
  >
    <span class="attachment-icon">
      <PhCircleNotch v-if="busy" class="icon-spin" />
      <PhWarningCircle v-else-if="error" weight="fill" />
      <PhFileVideo v-else-if="kind === 'video'" weight="fill" />
      <PhFileAudio v-else-if="kind === 'audio'" weight="fill" />
      <PhFileXls v-else-if="kind === 'excel'" weight="fill" />
      <PhFilePdf v-else-if="ext === 'PDF'" weight="fill" />
      <PhFileDoc v-else-if="ext === 'DOC' || ext === 'DOCX'" weight="fill" />
      <PhFileText v-else weight="fill" />
    </span>
    <span class="attachment-body">
      <span class="attachment-name">{{ fileName }}</span>
      <span class="attachment-meta">{{ meta }}</span>
    </span>
    <button
      v-if="removable"
      type="button"
      class="attachment-remove"
      :aria-label="t('common.remove')"
      @click="emit('remove')"
    >
      <PhX />
    </button>
  </div>
</template>

<script setup lang="ts">
/**
 * 一个附件的卡片。消息气泡和输入框共用这一个 —— 发出去前后长得一样，
 * 用户才认得出「刚才拖进来的那个就是它」。
 *
 * 卡片本身中性，种类只由左边的色块区分：一排里视频、音频、表格混在一起时，
 * 靠颜色一眼分开，不用读文件名。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  PhCircleNotch,
  PhFileAudio,
  PhFileDoc,
  PhFilePdf,
  PhFileText,
  PhFileVideo,
  PhFileXls,
  PhWarningCircle,
  PhX
} from '@phosphor-icons/vue'
import { attachmentExtension, type AttachmentKind } from '../composables/turnAttachments'

const props = defineProps<{
  fileName: string
  kind: AttachmentKind
  rowCount?: number
  /** 还在解析。图标换成转圈 */
  busy?: boolean
  /** 解析时报上来的进度，有就顶替副标题 */
  note?: string
  /** 解析失败的原因，有就顶替副标题、卡片转成出错的样子 */
  error?: string
  removable?: boolean
}>()

const emit = defineEmits<{ (e: 'remove'): void }>()

const { t } = useI18n()

const ext = computed(() => attachmentExtension(props.fileName))

/** 「视频 · MP4」「表格 · XLSX · 120 行」—— 种类一眼看出，扩展名兜细节 */
const meta = computed(() => {
  if (props.error) return props.error
  if (props.busy && props.note) return props.note
  const parts = [t(`assistantUserBubble.attachmentKind.${props.kind}`)]
  if (ext.value) parts.push(ext.value)
  if (props.rowCount) parts.push(t('assistantUserBubble.excelRows', { count: props.rowCount }))
  return parts.join(' · ')
})
</script>

<style scoped lang="less">
.attachment-card {
  --kind-color: var(--color-filetype-unknown);

  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  max-width: 240px;
  padding: var(--space-1) var(--space-3) var(--space-1) var(--space-1);
  background: var(--color-bg-surface);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-xl);
  transition: opacity var(--motion-fast) var(--easing-standard);

  &.is-video {
    --kind-color: var(--color-filetype-video);
  }

  &.is-audio {
    --kind-color: var(--color-filetype-audio);
  }

  &.is-document {
    --kind-color: var(--color-filetype-doc);
  }

  &.is-excel {
    --kind-color: var(--color-success-text);
  }

  &.is-busy {
    opacity: 0.75;
  }

  &.is-error {
    --kind-color: var(--color-danger-text);

    border-color: var(--color-danger-border);

    .attachment-meta {
      color: var(--color-danger-text);
    }
  }
}

.attachment-icon {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  font-size: 18px;
  color: var(--kind-color);
  background: color-mix(in oklab, var(--kind-color) 16%, transparent);
  border-radius: var(--radius-md);
}

.attachment-body {
  display: flex;
  flex-direction: column;
  min-width: 0;
  line-height: var(--line-height-tight);
}

.attachment-name {
  overflow: hidden;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--color-text-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.attachment-meta {
  margin-top: 2px;
  overflow: hidden;
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.attachment-remove {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  margin-right: calc(-1 * var(--space-1));
  font-size: 12px;
  color: var(--color-text-muted);
  cursor: pointer;
  background: transparent;
  border: none;
  border-radius: var(--radius-full);
  transition:
    color var(--motion-fast) var(--easing-standard),
    background var(--motion-fast) var(--easing-standard);

  &:hover {
    color: var(--color-text-primary);
    background: var(--color-bg-surface-hover);
  }

  &:focus-visible {
    outline: 2px solid var(--color-border-focus);
    outline-offset: 1px;
  }
}

.icon-spin {
  animation: attachment-spin 1s linear infinite;
}

@keyframes attachment-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
