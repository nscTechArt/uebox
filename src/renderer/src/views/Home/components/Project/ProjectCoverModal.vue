<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { VueCropper } from 'vue-cropper/dist/vue-cropper.es.js'
import 'vue-cropper/dist/index.css'
import AppModal from '@renderer/components/AppModal.vue'
import AppButton from '@renderer/components/AppButton.vue'
import { projectCoverAPI } from '@renderer/api/projectCover'
import { message } from '@renderer/utils/messageManager'

const props = defineProps<{ open: boolean; projectKey: string; image: string }>()
const emit = defineEmits<{
  'update:open': [value: boolean]
  success: []
}>()
const { t } = useI18n()
const cropper = ref<InstanceType<typeof VueCropper> | null>(null)
const saving = ref(false)
const ready = ref(false)
watch(
  () => props.image,
  () => {
    ready.value = false
  }
)

function close(): void {
  if (!saving.value) emit('update:open', false)
}

async function save(): Promise<void> {
  if (saving.value || !ready.value || !cropper.value || !props.projectKey) return
  const projectKey = props.projectKey
  saving.value = true
  try {
    const blob = await new Promise<Blob>((resolve, reject) => {
      cropper.value!.getCropBlob((value: Blob | null) => {
        if (value?.size) resolve(value)
        else reject(new Error('Empty crop'))
      })
    })
    await projectCoverAPI.save(projectKey, new Uint8Array(await blob.arrayBuffer()))
    message.success(t('page.home.project.messages.coverUpdated'))
    emit('success')
    emit('update:open', false)
  } catch (error) {
    console.warn('[ProjectCover] Save failed:', error)
    message.error(t('page.home.project.messages.coverSaveFailed'))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <AppModal
    :open="open"
    :title="t('page.home.project.cropCover')"
    :width="600"
    :mask-closable="false"
    :closable="!saving"
    :keyboard="!saving"
    destroy-on-close
    @cancel="close"
  >
    <div class="cover-cropper">
      <VueCropper
        ref="cropper"
        :img="image"
        :auto-crop="true"
        :auto-crop-width="600"
        :auto-crop-height="600"
        :center-box="true"
        :fixed="true"
        :fixed-number="[1, 1]"
        :info="false"
        output-type="jpeg"
        @img-load="ready = $event === 'success'"
      />
    </div>
    <template #footer>
      <AppButton :disabled="saving" @click="close">{{ t('common.cancel') }}</AppButton>
      <AppButton variant="primary" :disabled="!ready" :loading="saving" @click="save">
        {{ t('common.confirm') }}
      </AppButton>
    </template>
  </AppModal>
</template>

<style scoped>
.cover-cropper {
  width: 100%;
  height: 400px;
}
</style>
