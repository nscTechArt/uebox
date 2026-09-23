<template>
  <div class="user-bubble-row">
    <div class="bubble-container">
      <!-- 编辑模式 -->
      <div v-if="isEditing" class="edit-container">
        <textarea
          ref="editTextareaRef"
          v-model="editingContent"
          class="edit-textarea"
          :placeholder="t('assistant.chat.editMessagePlaceholder')"
          @keydown="handleKeydown"
        />
        <div class="edit-actions">
          <AppButton class="edit-button" size="small" @click="cancelEdit">{{
            t('common.cancel')
          }}</AppButton>
          <AppButton class="edit-button" variant="primary" size="small" @click="confirmEdit">{{
            t('common.send')
          }}</AppButton>
        </div>
      </div>

      <!-- 正常显示模式 -->
      <template v-else>
        <div class="bubble">
          <!-- @提及来源标签区域 -->
          <div v-if="mentionedSources && mentionedSources.length > 0" class="mentioned-sources">
            <div v-for="source in mentionedSources" :key="source.id" class="source-tag">
              <span class="source-icon">@</span>
              <span class="source-title">{{ source.title }}</span>
            </div>
          </div>
          <!-- 附件标签区域：Excel、文档、音视频 -->
          <div v-if="excelFiles && excelFiles.length > 0" class="excel-files">
            <div v-for="(file, index) in excelFiles" :key="index" class="excel-tag">
              <PhFileVideo v-if="file.kind === 'video'" class="excel-icon" />
              <PhFileAudio v-else-if="file.kind === 'audio'" class="excel-icon" />
              <PhFileText v-else-if="file.kind === 'document'" class="excel-icon" />
              <PhFileXls v-else class="excel-icon" />
              <span class="excel-name">{{ file.fileName }}</span>
              <span v-if="file.rowCount" class="excel-rows">{{
                t('assistantUserBubble.excelRows', { count: file.rowCount })
              }}</span>
            </div>
          </div>
          <!-- 图片区域 -->
          <div v-if="images.length > 0" class="images-container">
            <div v-for="(imgUrl, index) in images" :key="index" class="image-wrapper">
              <img
                :src="imgUrl"
                :alt="t('assistant.userBubble.imageAlt')"
                class="user-image"
                loading="lazy"
                @click="openPreview(imgUrl)"
              />
            </div>
          </div>
          <!-- 文本区域 -->
          <div v-if="textContent" class="text-content">{{ textContent }}</div>
        </div>
        <!-- 工具栏 -->
        <div class="tools">
          <PhCheck v-if="isCopied" class="tool copied" />
          <PhCopy v-else class="tool" @click="handleCopy" />
          <PhPencilSimple class="tool" @click="startEdit" />
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import AppButton from '@renderer/components/AppButton.vue'
import { computed, ref, nextTick } from 'vue'
import type {
  ChatMessageContent,
  ExcelFileInfo,
  MultimodalContentItem,
  MentionedSource
} from '@renderer/store/modules/chatMessages'
import { useI18n } from 'vue-i18n'
import { openImageViewer } from '@renderer/services/imageViewer'
import {
  PhCheck,
  PhCopy,
  PhFileAudio,
  PhFileText,
  PhFileVideo,
  PhFileXls,
  PhPencilSimple
} from '@phosphor-icons/vue'

const { t } = useI18n()

/**
 * 用户气泡组件：
 * - 右对齐，采用略浅的深灰背景，与 AI 气泡形成对比。
 * - 支持纯文本或多模态内容（文本+图片）
 * - 提供复制和修改按钮（hover时显示）
 * - 点击修改按钮后，直接在气泡位置变为可编辑的输入框
 */
const props = defineProps<{
  id: string
  content: ChatMessageContent
  /** @提及的来源列表 */
  mentionedSources?: MentionedSource[]
  /** 附带的文件列表。名字是存量，现在 Excel、文档、音视频都在里面，按 kind 选图标 */
  excelFiles?: ExcelFileInfo[]
}>()

const emit = defineEmits<{
  (e: 'copy', payload: { id: string; content: string }): void
  (
    e: 'confirm-edit',
    payload: { id: string; newContent: string; originalContent: ChatMessageContent }
  ): void
}>()

// 复制成功状态
const isCopied = ref(false)
let copyTimeoutId: ReturnType<typeof setTimeout> | null = null

// 编辑状态
const isEditing = ref(false)
const editingContent = ref('')
const editTextareaRef = ref<HTMLTextAreaElement | null>(null)

/**
 * 提取文本内容
 */
const textContent = computed(() => {
  if (typeof props.content === 'string') {
    return props.content
  }
  // 多模态内容：拼接所有文本部分
  return props.content
    .filter(
      (item): item is MultimodalContentItem & { type: 'text'; text: string } =>
        item.type === 'text' && !!item.text
    )
    .map((item) => item.text)
    .join('\n')
})

/**
 * 提取图片 URL 列表
 */
const images = computed(() => {
  if (typeof props.content === 'string') {
    return []
  }
  return props.content
    .filter(
      (item): item is MultimodalContentItem & { type: 'image_url'; image_url: { url: string } } =>
        item.type === 'image_url' && !!item.image_url?.url
    )
    .map((item) => item.image_url.url)
})

/**
 * 打开图片预览
 */
function openPreview(url: string): void {
  const list = images.value || []
  const items = list.map((src) => ({ src, alt: t('assistant.userBubble.imageAlt') }))
  const idx = Math.max(0, list.indexOf(url))
  void openImageViewer({ items, index: idx })
}

/**
 * 处理复制事件
 */
function handleCopy(): void {
  emit('copy', { id: props.id, content: textContent.value })

  // 设置复制成功状态
  isCopied.value = true

  // 清除之前的定时器
  if (copyTimeoutId) {
    clearTimeout(copyTimeoutId)
  }

  // 2秒后恢复为复制图标
  copyTimeoutId = setTimeout(() => {
    isCopied.value = false
    copyTimeoutId = null
  }, 2000)
}

/**
 * 开始编辑
 */
function startEdit(): void {
  editingContent.value = textContent.value
  isEditing.value = true
  // 聚焦到输入框
  nextTick(() => {
    if (editTextareaRef.value) {
      editTextareaRef.value.focus()
      // 将光标移到末尾
      editTextareaRef.value.setSelectionRange(
        editingContent.value.length,
        editingContent.value.length
      )
    }
  })
}

/**
 * 取消编辑
 */
function cancelEdit(): void {
  isEditing.value = false
  editingContent.value = ''
}

/**
 * 确认编辑
 */
function confirmEdit(): void {
  const newContent = editingContent.value.trim()
  if (!newContent) {
    cancelEdit()
    return
  }

  emit('confirm-edit', {
    id: props.id,
    newContent,
    originalContent: props.content
  })

  // 重置编辑状态
  isEditing.value = false
  editingContent.value = ''
}

/**
 * 处理键盘事件
 */
function handleKeydown(e: KeyboardEvent): void {
  // Ctrl+Enter 或 Meta+Enter 发送
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault()
    confirmEdit()
  }
  // Escape 取消
  if (e.key === 'Escape') {
    e.preventDefault()
    cancelEdit()
  }
}
</script>

<style scoped lang="less">
.user-bubble-row {
  display: flex;
  justify-content: flex-end;
}

.bubble-container {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  max-width: 72%;
}

.bubble {
  background: var(--color-bg-surface-hover);
  border-radius: 14px;
  padding: 12px 14px;
  color: var(--color-text-primary);
  user-select: text !important;
  -webkit-user-select: text !important;
}

// @提及来源标签样式
.mentioned-sources {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}

.source-tag {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 8px;
  background: var(--color-accent-bg);
  border: 1px solid var(--color-accent-border);
  border-radius: 12px;
  font-size: 11px;
  color: var(--color-accent-text);

  .source-icon {
    font-weight: 600;
    color: var(--color-accent-text);
  }

  .source-title {
    max-width: 150px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

// Excel 文件标签样式
.excel-files {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}

.excel-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  background: var(--color-success-bg);
  border: 1px solid var(--color-success-border);
  border-radius: 12px;
  font-size: 11px;
  color: var(--color-success-text);

  .excel-icon {
    font-size: 12px;
    color: var(--color-success-text);
  }

  .excel-name {
    max-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .excel-rows {
    color: var(--color-text-primary);
    font-size: 12px;
  }
}

.images-container {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 8px;

  &:last-child {
    margin-bottom: 0;
  }
}

.image-wrapper {
  position: relative;
  max-width: 200px;
  max-height: 200px;
  border-radius: 8px;
  overflow: hidden;
  cursor: pointer;

  &:hover {
    opacity: 0.9;
  }
}

.user-image {
  display: block;
  max-width: 100%;
  max-height: 200px;
  object-fit: contain;
  border-radius: 8px;
}

.text-content {
  white-space: pre-wrap;
  word-break: break-word;
  user-select: text !important;
  -webkit-user-select: text !important;
}

.tools {
  margin-top: 6px;
  padding-right: 3px;
  display: inline-flex;
  align-items: center;
  gap: 18px;
  color: var(--color-text-primary);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.15s ease;
}

.bubble-container:hover .tools {
  opacity: 1;
  pointer-events: auto;
}

.tool {
  font-size: 14px;
  cursor: pointer;

  &:hover {
    color: var(--color-text-primary);
  }

  &.copied {
    color: var(--color-success-text);
  }
}

// 编辑模式样式
.edit-container {
  width: 100%;
  min-width: 600px;
  max-width: 600px;
  background: var(--color-bg-surface-hover);
  border-radius: 16px;
  padding: 12px 14px;
}

.edit-textarea {
  width: 100%;
  min-height: 60px;
  max-height: 200px;
  background: transparent;
  border: none;
  outline: none;
  color: var(--color-text-primary);
  font-size: 14px;
  line-height: 1.6;
  resize: none;
  font-family: inherit;

  &::placeholder {
    color: var(--color-text-muted);
  }
}

.edit-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 10px;
  padding-top: 10px;
}

.edit-button {
  font-size: 12px;
  padding: 6px 12px;
  height: auto;
  border-radius: 16px;
}
</style>
