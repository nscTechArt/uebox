<template>
  <AppModal
    v-model:open="visible"
    :title="$t('changeIconModal.title')"
    :width="500"
    :confirm-loading="loading"
    @ok="handleOk"
    @cancel="handleCancel"
  >
    <div class="change-icon-container">
      <div class="upload-wrapper">
        <Upload
          v-model:value="iconUrl"
          :max-size="5"
          :is-cropper="true"
          :crop-width="200"
          :crop-height="200"
          :upload-text="$t('changeIconModal.uploadText')"
        />
      </div>
      <div class="hint-text">{{ $t('changeIconModal.hint') }}</div>
    </div>
  </AppModal>
</template>

<script setup lang="ts">
import AppModal from '@renderer/components/AppModal.vue'
import { ref, computed, watch } from 'vue'
import { useVaultStore } from '../../../store/modules/vaultStore'
import { useI18n } from 'vue-i18n'
import { message } from '@/utils/messageManager'
import Upload from '@/components/Upload.vue'

interface Props {
  open: boolean
  vaultId: string
  currentIcon?: string
}

interface Emits {
  (e: 'update:open', value: boolean): void
  (e: 'success'): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()
const { t } = useI18n()
const vaultStore = useVaultStore()

const loading = ref(false)
const iconUrl = ref('')

const visible = computed({
  get: () => props.open,
  set: (val) => emit('update:open', val)
})

watch(
  () => props.open,
  (val) => {
    if (val) {
      // 如果当前图标是URL（包含http或/），则初始化显示，否则（内置图标名）置空
      const isCustomIcon =
        props.currentIcon && (props.currentIcon.includes('/') || props.currentIcon.includes('\\'))
      iconUrl.value = isCustomIcon ? props.currentIcon! : ''
    }
  }
)

const handleOk = async () => {
  if (!iconUrl.value) {
    message.warning(t('changeIconModal.uploadImageFirst'))
    return
  }

  try {
    loading.value = true
    await vaultStore.updateVaultIcon(props.vaultId, iconUrl.value)
    message.success(t('changeIconModal.iconUpdated'))
    emit('success')
    visible.value = false
  } catch (error) {
    console.error('更新图标失败:', error)
    message.error(t('changeIconModal.iconUpdateFailed'))
  } finally {
    loading.value = false
  }
}

const handleCancel = () => {
  visible.value = false
}
</script>

<style lang="less" scoped>
.change-icon-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 20px 0;

  .upload-wrapper {
    margin-bottom: 16px;
  }

  .hint-text {
    color: var(--color-text-muted);
    font-size: 12px;
  }
}
</style>
