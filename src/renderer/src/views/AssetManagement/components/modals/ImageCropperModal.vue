<template>
  <AppModal
    :open="open"
    :title="$t('assetLib.details.cropPreview')"
    :width="600"
    :mask-closable="false"
    :destroy-on-close="true"
    :ok-text="$t('common.confirm')"
    :cancel-text="$t('common.cancel')"
    :confirm-loading="loading"
    @update:open="updateOpen"
    @ok="handleOk"
    @cancel="handleCancel"
  >
    <div style="width: 100%; height: 400px">
      <VueCropper
        ref="cropperRef"
        :img="image"
        :auto-crop="true"
        :auto-crop-width="600"
        :auto-crop-height="600"
        :center-box="true"
        :fixed="true"
        :fixed-number="[1, 1]"
        :info="false"
      />
    </div>
  </AppModal>
</template>

<script setup lang="ts">
import AppModal from '@renderer/components/AppModal.vue'
import { ref } from 'vue'
import 'vue-cropper/dist/index.css'
import { VueCropper } from 'vue-cropper/dist/vue-cropper.es.js'

const props = defineProps<{
  open: boolean
  image: string
  loading?: boolean
}>()

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
  (e: 'confirm', data: string): void
}>()

const cropperRef = ref<InstanceType<typeof VueCropper> | null>(null)

const updateOpen = (val: boolean) => {
  emit('update:open', val)
}

const handleOk = () => {
  if (!cropperRef.value) return
  cropperRef.value.getCropData((data: string) => {
    emit('confirm', data)
  })
}

const handleCancel = () => {
  emit('update:open', false)
}
</script>
