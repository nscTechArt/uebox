<template>
  <AppModal
    v-model:open="visible"
    :title="t('assetRenameModal.title')"
    @ok="handleConfirm"
    @cancel="handleCancel"
  >
    <a-form :model="form" layout="vertical">
      <a-form-item :label="t('assetRenameModal.nameLabel')" required>
        <a-input
          v-model:value="form.name"
          :placeholder="t('assetRenameModal.namePlaceholder')"
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
  assetKey?: string
  assetName?: string
}

interface Emits {
  (e: 'update:open', value: boolean): void
  (e: 'confirm', assetKey: string, newName: string): void
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

// 监听弹窗打开，设置初始值
watch(
  () => props.open,
  (newVal) => {
    if (newVal && props.assetName) {
      form.name = props.assetName
    }
  }
)

const handleConfirm = () => {
  if (!form.name.trim()) {
    message.error(t('assetRenameModal.nameRequired'))
    return
  }

  if (!props.assetKey) {
    message.error(t('assetRenameModal.assetInfoError'))
    return
  }

  emit('confirm', props.assetKey, form.name.trim())
  visible.value = false
}

const handleCancel = () => {
  visible.value = false
  form.name = ''
}
</script>
