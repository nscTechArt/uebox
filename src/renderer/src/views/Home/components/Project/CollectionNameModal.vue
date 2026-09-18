<template>
  <AppModal
    :open="open"
    :title="
      isRename
        ? $t('homeCollectionNameModal.renameTitle')
        : $t('homeCollectionNameModal.createTitle')
    "
    :ok-text="
      isRename ? $t('homeCollectionNameModal.renameOk') : $t('homeCollectionNameModal.createOk')
    "
    :cancel-text="$t('homeCollectionNameModal.cancelText')"
    @update:open="handleUpdateOpen"
    @ok="handleOk"
    @cancel="handleCancel"
  >
    <a-input
      v-model:value="modelName"
      :placeholder="$t('homeCollectionNameModal.namePlaceholder')"
      allow-clear
    />
  </AppModal>
</template>

<script setup lang="ts">
/**
 * 建分组和给分组改名是同一件事的两头：都只要一个名字。两个长得一样的弹窗没必要，
 * 传了 collectionKey 就是改名，没传就是新建。
 */
import AppModal from '@renderer/components/AppModal.vue'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { message } from '@/utils/messageManager'

const { t } = useI18n()

interface Props {
  open: boolean
  name: string
  /** 有值＝改这个分组的名字；null＝新建一个分组 */
  collectionKey?: string | null
}

interface Emits {
  (e: 'update:open', v: boolean): void
  (e: 'update:name', v: string): void
  (e: 'success', payload: { collectionKey: string; name: string; created: boolean }): void
  (e: 'cancel'): void
}

const props = withDefaults(defineProps<Props>(), { collectionKey: null })
const emit = defineEmits<Emits>()

const isRename = computed(() => Boolean(props.collectionKey))

const modelName = computed({
  get: () => props.name || '',
  set: (v: string) => emit('update:name', v)
})

const handleUpdateOpen = (v: boolean): void => emit('update:open', v)

const isOk = (res: unknown): boolean =>
  typeof res === 'boolean' ? res : Boolean((res as { success?: boolean } | null)?.success)

const handleOk = async (): Promise<void> => {
  const name = (modelName.value || '').trim()
  if (!name) {
    message.warning(t('homeProjectCollection.toast.nameRequired'))
    return
  }

  try {
    if (props.collectionKey) {
      const res = await window.api.database.projectCollection.update(props.collectionKey, { name })
      if (!isOk(res)) {
        message.error(t('page.home.project.collection.renameFailed'))
        return
      }
      emit('success', { collectionKey: props.collectionKey, name, created: false })
      emit('update:open', false)
      return
    }

    const collectionKey = `collection_${
      crypto.randomUUID?.() ? crypto.randomUUID() : Math.random().toString(36).slice(2)
    }`
    const res = await window.api.database.projectCollection.create({
      collectionKey,
      name,
      description: null,
      color: null,
      icon: null,
      sort_order: 0,
      isPinned: 0
    } as never)
    if (!isOk(res)) {
      message.error(t('homeProjectCollection.toast.createFailed'))
      return
    }
    message.success(t('homeProjectCollection.toast.created'))
    emit('success', { collectionKey, name, created: true })
    emit('update:open', false)
  } catch (error: unknown) {
    const errMsg =
      error instanceof Error
        ? error.message
        : t(
            props.collectionKey
              ? 'page.home.project.collection.renameFailed'
              : 'homeProjectCollection.toast.createFailed'
          )
    message.error(errMsg)
  }
}

const handleCancel = (): void => {
  emit('update:open', false)
  emit('cancel')
}
</script>
