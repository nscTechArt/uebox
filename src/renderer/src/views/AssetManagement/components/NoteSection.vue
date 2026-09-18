<template>
  <div class="inspector-group note-container">
    <div class="inspector-group-title">{{ $t('assetLib.details.note') }}</div>

    <!-- 第一层：一句话备注。纯文本，就地改，图快 -->
    <div v-if="!isEditing" class="note-content-wrapper" @click="handleNoteClick">
      <div v-if="!note" class="note-placeholder">
        {{ $t('assetLib.details.addNotePlaceholder') }}
      </div>
      <div v-else class="note-content">{{ note }}</div>
      <PhPencilSimple class="note-edit-hint" />
    </div>
    <div v-else class="note-editor-wrapper">
      <a-textarea
        ref="inputRef"
        v-model:value="draft"
        :placeholder="$t('assetLib.details.noteInputPlaceholder')"
        :auto-size="{ minRows: 3, maxRows: 8 }"
        :maxlength="NOTE_MAX_LENGTH"
        :show-count="isNearLimit"
        @blur="handleSave"
        @keydown.esc="handleCancel"
        @keydown.enter.ctrl="handleSave"
      />
      <div class="note-editor-hint">{{ $t('assetLib.details.noteEditHint') }}</div>
    </div>

    <!-- 第二层：详细说明。图、视频、表格这些放不进上面那个框的东西 -->
    <div v-if="richNoteLoading" class="rich-note-loading">
      <AppSpin size="small" />
    </div>

    <button v-else-if="richNote" class="rich-note-card" @click="handleOpenRichNote">
      <img v-if="richNoteCover" class="rich-note-cover" :src="richNoteCover" alt="" />
      <div v-else class="rich-note-cover placeholder"><PhArticle /></div>
      <div class="rich-note-text">
        <div class="rich-note-title">{{ richNote.title }}</div>
        <div class="rich-note-meta">{{ richNoteMeta }}</div>
      </div>
      <PhCaretRight class="rich-note-go" />
    </button>

    <AppButton
      v-else
      variant="soft"
      size="small"
      block
      class="rich-note-create"
      :loading="creatingRichNote"
      @click="handleCreateRichNote"
    >
      <template #icon><PhArticle /></template>
      {{ $t('assetLib.details.writeDetailedNote') }}
    </AppButton>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { PhArticle, PhCaretRight, PhPencilSimple } from '@phosphor-icons/vue'

import AppButton from '@renderer/components/AppButton.vue'
import AppSpin from '@renderer/components/AppSpin.vue'
import { message } from '@/utils/messageManager'
import assetNoteAPI from '@renderer/api/assetNote'
import { toLocalResourceUrl } from '@renderer/utils/localResource'
import type { AssetNote } from '@renderer/api/assetNote'

/**
 * 备注分两层，资产和文件夹共用这一个组件。
 *
 * 上面那个小框是「一句话备注」，存的是纯文本 —— 它进全文搜索索引，agent
 * 也读也写，所以绝不能塞富文本进去。要放图放视频，走下面的详细说明，那是
 * 一篇独立的笔记，只在这里挂个 noteId。
 */
const NOTE_MAX_LENGTH = 1000
/** 离上限还有这么多字以内才显示计数器。平时报数纯属噪声 */
const COUNT_HINT_THRESHOLD = 100

const props = defineProps<{
  /** 一句话备注（纯文本） */
  note: string
  /** 关联的详细说明笔记 id，没有就是 null */
  noteId?: number | null
  /** 新建详细说明时用的标题，一般是资产名或文件夹名 */
  defaultTitle: string
  /**
   * 落库。返回 false 表示没存上 —— 这时候编辑态和用户刚打的字都要保住，
   * 不能一边弹「保存失败」一边把他写的东西清掉。
   */
  saveNote: (note: string) => Promise<boolean>
  saveNoteId: (noteId: number | null) => Promise<boolean>
}>()

const { t } = useI18n()
const router = useRouter()

const isEditing = ref(false)
const draft = ref('')
const inputRef = ref<{ focus?: () => void } | null>(null)

const isNearLimit = computed(() => draft.value.length > NOTE_MAX_LENGTH - COUNT_HINT_THRESHOLD)

const saving = ref(false)

const handleNoteClick = async (): Promise<void> => {
  draft.value = props.note
  isEditing.value = true
  await nextTick()
  inputRef.value?.focus?.()
}

const handleSave = async (): Promise<void> => {
  if (!isEditing.value || saving.value) return

  const next = draft.value
  if (next === props.note) {
    isEditing.value = false
    return
  }

  saving.value = true
  try {
    // 存上了才退出编辑态。没存上就留在原地，用户刚打的字还在，可以再试一次
    if (await props.saveNote(next)) isEditing.value = false
  } finally {
    saving.value = false
  }
}

/** Esc 放弃这次修改。原来只能靠失焦保存，写错了没有退路 */
const handleCancel = (): void => {
  draft.value = props.note
  isEditing.value = false
}

// ========== 详细说明 ==========

const richNote = ref<AssetNote | null>(null)
const richNoteLoading = ref(false)
const creatingRichNote = ref(false)
let richNoteRequestId = 0

/** 从正文 HTML 里抠第一张图当封面。抠不到就显示占位图标 */
const richNoteCover = computed(() => {
  const html = richNote.value?.content || ''
  const match = html.match(/<img[^>]+src="([^"]+)"/i)
  return match?.[1] ? toLocalResourceUrl(match[1]) : ''
})

const richNoteMeta = computed(() => {
  const html = richNote.value?.content || ''
  const imageCount = (html.match(/<img\b/gi) || []).length
  const videoCount = (html.match(/<video-embed\b/gi) || []).length
  const parts: string[] = []
  if (imageCount > 0) parts.push(t('assetLib.details.noteImageCount', { count: imageCount }))
  if (videoCount > 0) parts.push(t('assetLib.details.noteVideoCount', { count: videoCount }))
  if (richNote.value?.updated_at) parts.push(richNote.value.updated_at)
  return parts.join(' · ')
})

const loadRichNote = async (noteId: number | null | undefined): Promise<void> => {
  const requestId = ++richNoteRequestId
  if (!noteId) {
    richNote.value = null
    richNoteLoading.value = false
    return
  }

  richNoteLoading.value = true
  try {
    const found = await assetNoteAPI.getById(noteId)
    // 用户可能已经点到别的资产上了，迟到的结果丢掉
    if (requestId !== richNoteRequestId) return
    richNote.value = found || null
    // 笔记被用户在笔记页删掉了，这里的关联就是个空指针，顺手清掉
    if (!found) void props.saveNoteId(null)
  } catch (error) {
    if (requestId !== richNoteRequestId) return
    console.error('加载详细说明失败:', error)
    richNote.value = null
  } finally {
    if (requestId === richNoteRequestId) richNoteLoading.value = false
  }
}

watch(() => props.noteId, loadRichNote, { immediate: true })

/** 换了目标就退出编辑态，免得把 A 的草稿存到 B 头上 */
watch(
  () => [props.note, props.defaultTitle] as const,
  () => {
    isEditing.value = false
  }
)

const handleCreateRichNote = async (): Promise<void> => {
  if (creatingRichNote.value) return
  creatingRichNote.value = true
  try {
    // 标题带上「说明」二字：笔记列表里一排资产名，看不出哪些是说明书
    const newId = await assetNoteAPI.create({
      title: t('assetLib.details.detailedNoteTitle', { name: props.defaultTitle })
    })
    if (!newId) throw new Error('note:create returned no id')
    // 关联没落上库就不要跳走：跳过去写半天，回来发现这儿还是「写详细说明」
    if (!(await props.saveNoteId(newId))) return
    openNoteEditor(newId)
  } catch (error) {
    console.error('创建详细说明失败:', error)
    message.error(t('assetLib.details.createNoteFailed'))
  } finally {
    creatingRichNote.value = false
  }
}

const handleOpenRichNote = (): void => {
  if (richNote.value?.id) openNoteEditor(richNote.value.id)
}

/**
 * 在笔记页里打开。
 *
 * 详情面板最宽也就 640px，图文排不开；而且富文本编辑器那一套（自动保存、
 * 图片落盘迁移、斜杠命令）已经长在笔记页里了，搬进模态是另一件事。
 */
const openNoteEditor = (noteId: number): void => {
  void router.push({ name: 'NoteEditor', query: { noteId: String(noteId) } })
}
</script>

<style lang="less" scoped>
.note-container {
  margin-top: 0;
  padding: 12px;
}

.note-content-wrapper {
  position: relative;
  padding: 10px 28px 10px 10px;
  background: var(--color-bg-sunken);
  border-radius: 6px;
  min-height: 60px;
  color: var(--color-text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: background-color 0.2s ease;

  // 原来 hover 色和常态色是同一个 token，等于没有 hover，
  // 整块是「点一下进编辑」却不给任何反馈
  &:hover {
    background: var(--color-bg-raised);

    .note-edit-hint {
      opacity: 1;
    }
  }
}

// 一支铅笔，告诉用户这块能点
.note-edit-hint {
  position: absolute;
  top: 8px;
  right: 8px;
  font-size: 13px;
  color: var(--color-text-muted);
  opacity: 0;
  transition: opacity 0.2s ease;
}

.note-editor-wrapper {
  :deep(.ant-input) {
    background: var(--color-bg-sunken);
    border-color: var(--color-border);
    color: var(--color-text-primary);
    font-size: 12px;
    padding: 8px 10px;

    &:focus {
      border-color: var(--color-accent-border);
      box-shadow: 0 0 0 2px var(--color-accent-border);
    }

    &::placeholder {
      color: var(--color-text-disabled);
    }
  }

  :deep(.ant-input-textarea-show-count::after) {
    color: var(--color-text-muted);
    font-size: 11px;
    margin: 4px 0 0;
  }
}

.note-editor-hint {
  margin-top: 4px;
  font-size: 11px;
  color: var(--color-text-muted);
}

.note-placeholder {
  color: var(--color-text-muted);
  font-size: 12px;
}

.note-content {
  color: var(--color-text-secondary);
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
}

.rich-note-loading {
  display: flex;
  justify-content: center;
  padding: 12px 0 4px;
}

.rich-note-create {
  margin-top: 10px;
}

.rich-note-card {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  margin-top: 10px;
  padding: 8px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-sm);
  background: var(--color-bg-sunken);
  cursor: pointer;
  text-align: left;
  transition:
    background-color 0.15s ease,
    border-color 0.15s ease;

  &:hover {
    background: var(--color-bg-raised);
    border-color: var(--color-border);

    .rich-note-go {
      opacity: 1;
    }
  }
}

.rich-note-cover {
  flex-shrink: 0;
  width: 44px;
  height: 44px;
  border-radius: var(--radius-xs);
  object-fit: cover;
  background: var(--color-bg-surface-hover);

  &.placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 20px;
    color: var(--color-text-muted);
  }
}

.rich-note-text {
  flex: 1;
  min-width: 0;
}

.rich-note-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rich-note-meta {
  margin-top: 2px;
  font-size: 11px;
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rich-note-go {
  flex-shrink: 0;
  font-size: 14px;
  color: var(--color-text-muted);
  opacity: 0;
  transition: opacity 0.15s ease;
}
</style>
