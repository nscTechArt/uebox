<template>
  <AppModal
    v-model:open="modalVisible"
    :title="$t('renameFolderModal.title')"
    :width="400"
    :mask-closable="false"
    :keyboard="false"
    @ok="handleConfirm"
    @cancel="handleCancel"
  >
    <div class="rename-folder-form">
      <div class="current-name">
        <label>{{ $t('renameFolderModal.currentNameLabel') }}</label>
        <span class="name-text">{{ folderName }}</span>
      </div>

      <div class="new-name">
        <label for="newFolderName">{{ $t('renameFolderModal.newNameLabel') }}</label>
        <a-input
          id="newFolderName"
          ref="inputRef"
          v-model:value="newName"
          :placeholder="$t('renameFolderModal.namePlaceholder')"
          :maxlength="50"
          show-count
          @keyup.enter="handleConfirm"
        />
      </div>
    </div>

    <template #footer>
      <AppButton @click="handleCancel">{{ $t('renameFolderModal.cancel') }}</AppButton>
      <AppButton
        variant="primary"
        :loading="loading"
        :disabled="!isValidName"
        @click="handleConfirm"
      >
        {{ $t('renameFolderModal.confirm') }}
      </AppButton>
    </template>
  </AppModal>
</template>

<script setup lang="ts">
import AppModal from '@renderer/components/AppModal.vue'
import AppButton from '@renderer/components/AppButton.vue'
import { ref, computed, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { message } from '@/utils/messageManager'

interface Props {
  open: boolean
  folderKey: string
  folderName: string
  loading?: boolean
}

interface Emits {
  (e: 'update:open', value: boolean): void
  (e: 'confirm', folderKey: string, newName: string): void
}

const props = withDefaults(defineProps<Props>(), {
  loading: false
})

const emit = defineEmits<Emits>()
const { t } = useI18n()

const inputRef = ref()
const newName = ref('')

// 计算属性
const modalVisible = computed({
  get: () => props.open,
  set: (value) => emit('update:open', value)
})

const isValidName = computed(() => {
  const trimmedName = newName.value.trim()
  return trimmedName.length > 0 && trimmedName !== props.folderName
})

// 监听弹窗打开状态
watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      newName.value = props.folderName
      nextTick(() => {
        inputRef.value?.focus()
        inputRef.value?.select()
      })
    }
  }
)

// 事件处理
const handleConfirm = () => {
  const trimmedName = newName.value.trim()

  if (!trimmedName) {
    message.warning(t('renameFolderModal.nameRequired'))
    return
  }

  if (trimmedName === props.folderName) {
    message.warning(t('renameFolderModal.sameName'))
    return
  }

  // 检查是否为保留名称 "ALL"
  if (trimmedName.toUpperCase() === 'ALL') {
    message.error(t('renameFolderModal.invalidNameAll'))
    return
  }

  // 检查文件夹名称是否包含非法字符
  const invalidChars = /[<>:"/\\|?*]/
  if (invalidChars.test(trimmedName)) {
    message.error(t('renameFolderModal.invalidChars'))
    return
  }

  emit('confirm', props.folderKey, trimmedName)
}

const handleCancel = () => {
  newName.value = ''
  modalVisible.value = false
}
</script>

<style lang="less" scoped>
.rename-folder-form {
  .current-name {
    margin-bottom: 16px;

    label {
      display: inline-block;
      width: 80px;
      color: var(--color-text-secondary);
      font-size: 14px;
    }

    .name-text {
      color: var(--color-text-primary);
      font-weight: 500;
    }
  }

  .new-name {
    label {
      display: block;
      margin-bottom: 8px;
      color: var(--color-text-secondary);
      font-size: 14px;
    }

    .ant-input {
      border-radius: var(--radius-xs);
      transition: all var(--motion-fast) var(--easing-standard);

      &:focus {
        border-color: var(--color-accent-border);
        box-shadow: 0 0 0 2px var(--color-accent-bg);
      }
    }
  }
}
</style>
