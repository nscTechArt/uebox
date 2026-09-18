<template>
  <AppModal
    :open="open"
    :title="$t('renameProjectModal.title')"
    :ok-text="$t('renameProjectModal.okText')"
    :cancel-text="$t('renameProjectModal.cancelText')"
    :z-index="2050"
    @update:open="handleUpdateOpen"
    @ok="handleOk"
    @cancel="handleCancel"
  >
    <a-input
      v-model:value="modelName"
      :placeholder="$t('renameProjectModal.namePlaceholder')"
      allow-clear
    />
  </AppModal>
</template>

<script setup lang="ts">
import AppModal from '@renderer/components/AppModal.vue'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { message } from '@/utils/messageManager'

const { t } = useI18n()

interface Props {
  open: boolean
  name: string
  projectKey: string
}

interface Emits {
  (e: 'update:open', v: boolean): void
  (e: 'update:name', v: string): void
  (e: 'confirm'): void
  (e: 'success', payload: { projectKey: string; name: string }): void
  (e: 'cancel'): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()

const modelName = computed({
  get: () => props.name || '',
  set: (v: string) => emit('update:name', v)
})

const handleUpdateOpen = (v: boolean) => emit('update:open', v)
const handleOk = async () => {
  const name = (modelName.value || '').trim()
  const key = props.projectKey
  if (!name) {
    message.warning(t('renameProjectModal.nameRequired'))
    return
  }
  if (!key) {
    message.error(t('renameProjectModal.projectNotFound'))
    return
  }
  try {
    const res = await window.api.database.project.update(key, { projectName: name })
    const ok = typeof res === 'boolean' ? res : Boolean((res as any)?.success)
    if (ok) {
      // message.success('重命名成功')
      emit('success', { projectKey: key, name })
      emit('update:open', false)
    } else {
      message.error(t('renameProjectModal.failed'))
    }
  } catch (err: any) {
    message.error(err?.message || '重命名异常')
  }
}
const handleCancel = () => {
  emit('update:open', false)
  emit('cancel')
}
</script>

<style lang="less" scoped>
.form-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-bottom: var(--space-3);
}
</style>
