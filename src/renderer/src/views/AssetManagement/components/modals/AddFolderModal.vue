<template>
  <AppModal
    v-model:open="visible"
    :title="$t('addFolderModal.title')"
    @ok="handleConfirm"
    @cancel="handleCancel"
  >
    <a-form :model="form" layout="vertical">
      <a-form-item :label="$t('addFolderModal.nameLabel')" required>
        <a-input
          v-model:value="form.name"
          :placeholder="$t('addFolderModal.namePlaceholder')"
          @press-enter="handleConfirm"
        />
      </a-form-item>
    </a-form>
  </AppModal>
</template>

<script setup lang="ts">
import AppModal from '@renderer/components/AppModal.vue'
import { reactive, watch, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { message } from '@/utils/messageManager'

interface Props {
  open: boolean
  folderKey?: string
}

interface Emits {
  (e: 'update:open', value: boolean): void
  (e: 'confirm', folderKey: string, folderName: string): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()
const { t } = useI18n()

const visible = computed({
  get: () => props.open,
  set: (value) => emit('update:open', value)
})

const form = reactive({
  name: ''
})

// 监听弹窗打开，重置表单
watch(
  () => props.open,
  (newVal) => {
    if (newVal) {
      form.name = ''
    }
  }
)

const handleConfirm = () => {
  const trimmedName = form.name.trim()

  if (!trimmedName) {
    message.error(t('addFolderModal.nameRequired'))
    return
  }

  // 检查是否为保留名称 "ALL"
  if (trimmedName.toUpperCase() === 'ALL') {
    message.error(t('addFolderModal.invalidNameAll'))
    return
  }

  // 检查文件夹名称是否包含非法字符
  const invalidChars = /[<>:"/\\|?*]/
  if (invalidChars.test(trimmedName)) {
    message.error(t('addFolderModal.invalidChars'))
    return
  }

  if (!props.folderKey) {
    message.error(t('addFolderModal.folderRequired'))
    return
  }

  emit('confirm', props.folderKey, trimmedName)
  visible.value = false
}

const handleCancel = () => {
  visible.value = false
  form.name = ''
}
</script>
