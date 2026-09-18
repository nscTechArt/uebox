<script setup lang="ts">
/**
 * 文字类产出的提示词编辑器。
 *
 * 一个产出对应一个或两个槽位（网页是「先读材料出 Brief」+「照 Brief 排版」两段），
 * 所以这里按槽位循环，而不是假定只有一段。
 *
 * 壳走 AppModal —— 焦点陷阱、焦点归还、滚动锁计数、Esc 关闭都在它那儿。
 * 上一版是手搓的 div/section/button，Esc 挂在一个没人聚焦的 `<section>` 上，
 * 刚打开的弹窗按 Esc 毫无反应，Tab 还会跑到遮罩后面去。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { PhArrowCounterClockwise } from '@phosphor-icons/vue'
import AppModal from '@renderer/components/AppModal.vue'
import AppButton from '@renderer/components/AppButton.vue'
import { message } from '@renderer/utils/messageManager'
import type { NotebookTaskType } from '@renderer/services/notebook/NotebookTaskService'
import {
  getDefaultPrompt,
  getPromptOverrides,
  savePromptOverrides,
  slotsForTask,
  type NotebookPromptSlotId
} from '@renderer/services/notebook/taskPrompts'

const { t } = useI18n()

const props = defineProps<{
  visible: boolean
  /** 编辑哪个产出的提示词。为空时不渲染 */
  task: NotebookTaskType | null
  /** 弹窗标题里显示的产出名 */
  taskLabel?: string
}>()

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void
}>()

/** 正在编辑的文本，按槽位存 */
const drafts = ref<Partial<Record<NotebookPromptSlotId, string>>>({})
const loading = ref(false)
const saving = ref(false)
/** 每次打开自增：异步读回来的时候弹窗可能已经关了或换了产出 */
let loadRevision = 0

const slots = computed(() => (props.task ? slotsForTask(props.task) : []))

/** 这个槽位现在和出厂值不一样 */
function isCustomized(id: NotebookPromptSlotId): boolean {
  return (drafts.value[id] ?? '').trim() !== getDefaultPrompt(id).trim()
}

const hasChanges = computed(() => slots.value.some((slot) => isCustomized(slot.id)))

function handleClose(): void {
  loadRevision += 1
  emit('update:visible', false)
}

async function loadDrafts(): Promise<void> {
  const revision = ++loadRevision
  loading.value = true

  try {
    const overrides = await getPromptOverrides()
    if (revision !== loadRevision) return

    const next: Partial<Record<NotebookPromptSlotId, string>> = {}
    for (const slot of slots.value) {
      next[slot.id] = overrides[slot.id] ?? slot.defaultPrompt
    }
    drafts.value = next
  } finally {
    if (revision === loadRevision) loading.value = false
  }
}

watch(
  () => [props.visible, props.task] as const,
  ([visible]) => {
    if (visible && props.task) void loadDrafts()
    else loadRevision += 1
  },
  { immediate: true }
)

function handleResetSlot(id: NotebookPromptSlotId): void {
  drafts.value = { ...drafts.value, [id]: getDefaultPrompt(id) }
}

async function handleSave(): Promise<void> {
  if (saving.value) return
  saving.value = true

  try {
    // 和出厂值一样的会在 savePromptOverrides 里被当成「恢复默认」删掉，
    // 所以这里原样把每个槽位交上去就行
    const patch: Partial<Record<NotebookPromptSlotId, string | null>> = {}
    for (const slot of slots.value) {
      patch[slot.id] = drafts.value[slot.id] ?? null
    }

    await savePromptOverrides(patch)
    message.success(t('notebook.taskPrompt.saved'))
    handleClose()
  } catch (error) {
    console.error('[TaskPromptModal] 保存提示词失败:', error)
    message.error(t('notebook.taskPrompt.saveFailed'))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <AppModal
    :open="visible && !!task"
    :title="t('notebook.taskPrompt.title', { name: taskLabel || '' })"
    :width="760"
    destroy-on-close
    @update:open="(value) => !value && handleClose()"
  >
    <p class="header-subtitle">{{ t('notebook.taskPrompt.subtitle') }}</p>

    <p v-if="loading" class="loading-text">{{ t('notebook.taskPrompt.loading') }}</p>

    <div v-for="slot in slots" v-else :key="slot.id" class="prompt-slot">
      <div class="slot-header">
        <label :for="`prompt-${slot.id}`">{{ t(slot.labelKey) }}</label>
        <AppButton
          variant="text"
          size="small"
          :disabled="!isCustomized(slot.id)"
          @click="handleResetSlot(slot.id)"
        >
          <PhArrowCounterClockwise />
          {{ t('notebook.taskPrompt.reset') }}
        </AppButton>
      </div>
      <textarea
        :id="`prompt-${slot.id}`"
        v-model="drafts[slot.id]"
        class="prompt-input"
        :class="{ compact: slots.length > 1 }"
        spellcheck="false"
      />
    </div>

    <template #footer>
      <span class="footer-hint">{{
        hasChanges ? t('notebook.taskPrompt.customized') : t('notebook.taskPrompt.isDefault')
      }}</span>
      <AppButton @click="handleClose">{{ t('common.cancel') }}</AppButton>
      <AppButton variant="primary" :disabled="loading" :loading="saving" @click="handleSave">
        {{ t('common.confirm') }}
      </AppButton>
    </template>
  </AppModal>
</template>

<style scoped lang="less">
.header-subtitle {
  margin: 0 0 var(--space-5);
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
  line-height: var(--line-height-normal);
}

.loading-text {
  margin: 0;
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
}

.prompt-slot {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);

  & + & {
    margin-top: var(--space-6);
  }
}

.slot-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);

  label {
    color: var(--color-text-primary);
    font-size: var(--font-size-sm);
    font-weight: var(--font-weight-semibold);
  }
}

/*
  提示词有几十行，给它真正够用的高度。上一版信息图弹窗把它挤成 120px 一个小窗，
  改一段话要在里面来回滚。两段的产出（网页）每段矮一点，否则一屏放不下两个。
*/
.prompt-input {
  box-sizing: border-box;
  width: 100%;
  min-height: 340px;
  padding: var(--space-4);
  color: var(--color-text-primary);
  font-family: var(--font-family-mono);
  font-size: var(--font-size-sm);
  line-height: var(--line-height-relaxed);
  resize: vertical;
  background: var(--color-bg-sunken);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-lg);

  &.compact {
    min-height: 240px;
  }

  &:hover {
    border-color: var(--color-border-strong);
  }

  &:focus {
    border-color: var(--color-accent-border);
    outline: 2px solid var(--color-border-focus);
    outline-offset: 1px;
  }
}

.footer-hint {
  margin-right: auto;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}
</style>
