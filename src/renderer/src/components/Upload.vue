<template>
  <div class="upload-container">
    <div class="avatar-wrapper">
      <a-upload
        ref="uploadRef"
        v-model:file-list="fileList"
        name="avatar"
        list-type="picture-circle"
        class="avatar-uploader"
        :show-upload-list="false"
        :before-upload="beforeUpload"
        :custom-request="customUpload"
      >
        <div v-if="imageUrl"><img :src="imageUrl" alt="avatar" class="avatar-image" /></div>

        <div v-else class="avatar-placeholder">
          <PhCircleNotch v-if="loading" class="icon-spin" />
          <PhPlus v-else />
          <div class="ant-upload-text">{{ displayUploadText }}</div>
        </div>
      </a-upload>
    </div>

    <!-- 裁剪弹窗 -->
    <AppModal
      v-model:open="cropperVisible"
      :title="$t('componentsUpload.modal.title')"
      :width="600"
      :ok-text="$t('componentsUpload.modal.okText')"
      :cancel-text="$t('componentsUpload.modal.cancelText')"
      @ok="handleCropOk"
    >
      <div style="width: 100%">
        <VueCropper
          ref="cropperRef"
          :auto-crop="isCropper"
          :auto-crop-width="cropWidth"
          :auto-crop-height="cropHeight"
          :fixed-number="fixedRatio"
          :img="cropperImage"
          :center-box="true"
          :fixed="fixedEnabled"
          :info="false"
        />
      </div>
    </AppModal>
  </div>
</template>

<script setup lang="ts">
import AppModal from '@renderer/components/AppModal.vue'
import { PhCircleNotch, PhPlus } from '@phosphor-icons/vue'
import { ref, watch, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { message } from '@/utils/messageManager'
import type { UploadFile } from 'ant-design-vue'
import type { UploadRequestOption } from 'ant-design-vue/es/vc-upload/interface'
import { prepareImage } from '@/utils/imageUpload'
import 'vue-cropper/dist/index.css'
import { VueCropper } from 'vue-cropper/dist/vue-cropper.es.js'

const { t } = useI18n()

const emits = defineEmits(['update:value'])
const props = defineProps({
  value: String,
  maxSize: {
    type: Number,
    default: 5 // 默认5MB限制
  },
  isCropper: {
    type: Boolean,
    default: true // 默认启用裁剪
  },
  cropWidth: {
    type: Number,
    default: 100 // 默认裁剪宽度
  },
  cropHeight: {
    type: Number,
    default: 100 // 默认裁剪高度
  },
  fixedNumber: {
    type: Array
  },
  uploadText: {
    type: String
  }
})
const displayUploadText = computed(
  () => props.uploadText ?? t('componentsUpload.defaultUploadText')
)
const fixedEnabled = computed(
  () => Array.isArray(props.fixedNumber) && props.fixedNumber.length === 2
)
const fixedRatio = computed(() => (fixedEnabled.value ? props.fixedNumber : [1, 1]))
watch(
  () => props.value,
  (n) => {
    imageUrl.value = n || ''
  }
)
// 响应式变量
const loading = ref(false)
const imageUrl = ref<string>('')
const fileList = ref<UploadFile[]>([])
const cropperRef = ref<InstanceType<typeof VueCropper> | null>(null)
const cropperVisible = ref(false)
const cropperImage = ref<string>('')
let currentFile: File | null = null

// upload 组件 ref
const uploadRef = ref<InstanceType<typeof import('ant-design-vue').Upload> | null>(null)

// 修改后的上传前检查
const compressImage = async (file: File, quality: number): Promise<File> => {
  const bitmap = await createImageBitmap(file)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d')
    if (!context) {
      throw new Error('无法创建图片处理画布')
    }
    context.drawImage(bitmap, 0, 0)
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (result) => (result ? resolve(result) : reject(new Error('图片压缩失败'))),
        'image/jpeg',
        quality
      )
    })
    return new File([blob], file.name, {
      type: 'image/jpeg',
      lastModified: Date.now()
    })
  } finally {
    bitmap.close()
  }
}

const beforeUpload = async (file: File): Promise<boolean> => {
  // 文件类型检查
  const isImage = file.type.startsWith('image/')
  if (!isImage) {
    message.error(t('actionToast.upload.imageOnly'))
    return false
  }

  // 压缩处理逻辑
  if (file.size / 1024 / 1024 > props.maxSize) {
    try {
      currentFile = await compressImage(file, 0.8)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      message.error(t('actionToast.upload.processFailed', { reason: errorMessage }))
      return false
    }
  } else {
    currentFile = file
  }

  // 裁剪处理逻辑
  if (props.isCropper) {
    const reader = new FileReader()
    reader.onload = (e) => {
      const target = e.target as FileReader | null
      const result = target?.result
      cropperImage.value = typeof result === 'string' ? result : ''
      cropperVisible.value = true
    }
    if (currentFile) {
      reader.readAsDataURL(currentFile)
    }
  } else {
    if (currentFile) {
      handleDirectUpload(currentFile)
    }
  }

  return false
}

const uploadAvatar = async (file: File): Promise<void> => {
  const result = await prepareImage(file)
  if (!result.success || !result.url) {
    throw new Error(result.error || '上传失败')
  }
  imageUrl.value = result.url
  emits('update:value', result.url)
}

// 新增直接上传方法
const handleDirectUpload = async (file: File): Promise<void> => {
  try {
    loading.value = true
    await uploadAvatar(file)
    message.success(t('actionToast.upload.ok'))
  } catch (error) {
    console.error('上传错误:', error)
    message.error(t('actionToast.upload.failed'))
  } finally {
    loading.value = false
  }
}

// 确认裁剪
const handleCropOk = async (): Promise<void> => {
  try {
    cropperVisible.value = false
    loading.value = true

    // 获取裁剪后的图片 blob
    const blob: Blob = await new Promise<Blob>((resolve) => {
      if (!cropperRef.value) {
        resolve(new Blob())
        return
      }
      cropperRef.value.getCropBlob((data: Blob) => resolve(data))
    })

    const croppedFile = new File([blob], currentFile?.name || `avatar-${Date.now()}.jpg`, {
      type: blob.type || 'image/jpeg',
      lastModified: Date.now()
    })
    await uploadAvatar(croppedFile)
    message.success(t('actionToast.upload.ok'))
  } catch (error) {
    console.error('上传错误:', error)
    message.error(t('actionToast.upload.failed'))
  } finally {
    loading.value = false
  }
}

// 自定义上传方法
const customUpload = ({ onError }: UploadRequestOption): void => {
  // 实际上传操作在裁剪确认后进行
  if (onError) {
    onError(new Error('请先完成图片裁剪'))
  }
}

/**
 * 手动触发文件选择器
 * 供父组件通过 ref 调用
 */
const triggerUpload = (): void => {
  // 查找 input[type=file] 并触发点击
  const uploadEl = uploadRef.value?.$el as HTMLElement | undefined
  const input = uploadEl?.querySelector('input[type="file"]') as HTMLInputElement | null
  input?.click()
}

// 暴露方法给父组件
defineExpose({
  triggerUpload
})
</script>

<style scoped>
.upload-container {
  padding: 0;
}

.avatar-wrapper {
  display: flex;
  justify-content: center;
  cursor: pointer;
}

.avatar-image {
  width: 80px;
  height: 80px;
  object-fit: contain;
  border-radius: 40px;
}
.avatar-placeholder {
  width: 200px;
  height: 200px;

  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;

  border: 2px dashed var(--color-border);
}
.ant-upload-text {
  margin-top: 8px;
}

:deep(.vue-cropper) {
  height: 400px;
}
</style>
