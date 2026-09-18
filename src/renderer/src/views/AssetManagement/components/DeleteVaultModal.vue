<template>
  <AppModal
    :open="open"
    :title="t('assetLib.vault.delete.title')"
    :ok-text="t('common.delete')"
    :cancel-text="t('common.cancel')"
    ok-danger
    :ok-disabled="deleteInput !== vault?.name"
    @ok="handleDeleteConfirm"
    @cancel="handleCancel"
  >
    <div class="delete-confirm-content">
      <p class="warning-text" style="color: var(--color-danger-text); margin-bottom: 16px">
        <template v-if="vault?.vaultType === 'network'">
          {{ t('assetLib.vault.delete.networkWarning', { networkPath: vault?.networkPath }) }}
        </template>
        <template v-else>
          {{ t('assetLib.vault.delete.warning', { name: vault?.name }) }}
        </template>
      </p>

      <div class="confirm-input-wrapper">
        <label style="display: block; margin-bottom: 8px">
          {{ t('assetLib.vault.delete.confirmLabel') }}
        </label>
        <Input
          v-model:value="deleteInput"
          :placeholder="t('assetLib.vault.delete.placeholder', { name: vault?.name })"
        />
      </div>
    </div>
  </AppModal>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { Input } from 'ant-design-vue'
import AppModal from '@renderer/components/AppModal.vue'
import { message } from '@renderer/utils/messageManager'
import { useI18n } from 'vue-i18n'
import { useVaultStore, type VaultInfo } from '../../../store/modules/vaultStore'

const props = defineProps<{
  open: boolean
  vault: VaultInfo | null
}>()

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
  (e: 'success'): void
}>()

const { t } = useI18n()
const vaultStore = useVaultStore()
const deleteInput = ref('')

// 当弹窗打开时，重置输入框
watch(
  () => props.open,
  (newVal) => {
    if (newVal) {
      deleteInput.value = ''
    }
  }
)

const handleCancel = () => {
  emit('update:open', false)
}

const handleDeleteConfirm = async () => {
  if (!props.vault) return
  if (props.vault.isSystem) {
    message.warning(t('deleteVaultModal.systemNotDeletable'))
    return
  }

  if (deleteInput.value !== props.vault.name) {
    return
  }

  const hide = message.loading(t('common.loading'), 0)
  try {
    await vaultStore.deleteVault(props.vault.id)
    message.success(t('assetLib.vault.messages.removed'))
    emit('success')
    emit('update:open', false)
  } catch (error) {
    console.error('删除保管库失败:', error)
    message.error(t('assetLib.vault.messages.removeFailed'))
  } finally {
    hide()
  }
}
</script>

<style scoped>
.warning-text {
  color: var(--color-danger-text);
  margin-bottom: 16px;
}
</style>
