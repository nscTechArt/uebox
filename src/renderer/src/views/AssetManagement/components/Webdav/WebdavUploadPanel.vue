<template>
  <div class="webdav-upload-panel">
    <a-upload-dragger
      v-model:file-list="fileList"
      :before-upload="beforeUpload"
      :custom-request="handleUpload"
      :multiple="true"
    >
      <p class="ant-upload-drag-icon">
        <PhCloudArrowUp />
      </p>
      <p class="ant-upload-text">{{ $t('webdavUploadPanel.dragger.text') }}</p>
      <p class="ant-upload-hint">{{ $t('webdavUploadPanel.dragger.hint') }}</p>
    </a-upload-dragger>

    <div v-if="uploadProgress.length > 0" class="upload-progress-list">
      <h4>{{ $t('webdavUploadPanel.progress.title') }}</h4>
      <div v-for="item in uploadProgress" :key="item.name" class="progress-item">
        <div class="progress-info">
          <span class="filename">{{ item.name }}</span>
          <span v-if="item.status === 'success'" class="progress-text">{{
            $t('webdavUploadPanel.progress.success')
          }}</span>
          <span v-else-if="item.status === 'exception'" class="progress-text">{{
            $t('webdavUploadPanel.progress.failed')
          }}</span>
          <span v-else class="progress-text">{{ $t('webdavUploadPanel.progress.uploading') }}</span>
        </div>
        <div v-if="item.status === 'active'" class="loader"></div>
        <AppProgress v-else :percent="item.percent" :status="item.status" :show-info="false" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import AppProgress from '@renderer/components/AppProgress.vue'
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { message } from '@/utils/messageManager'
import { PhCloudArrowUp } from '@phosphor-icons/vue'
import { useWebdavStore } from '@renderer/store/modules/webdav'

const { t } = useI18n()
const webdavStore = useWebdavStore()

const emit = defineEmits(['uploaded'])

const fileList = ref<any[]>([])

const uploadProgress = ref<
  Array<{
    name: string
    percent: number
    status: 'active' | 'success' | 'exception'
  }>
>([])

const beforeUpload = () => {
  if (!webdavStore.connection) {
    message.error(t('webdavUploadPanel.connectFirst'))
    return false
  }
  return true
}

const handleUpload = async (options: any) => {
  const { file } = options

  if (!webdavStore.connection) {
    message.error(t('webdavUploadPanel.connectFirst'))
    return
  }

  const progressItem: {
    name: string
    percent: number
    status: 'active' | 'success' | 'exception'
  } = {
    name: file.name,
    percent: 50, // 设置中间值以显示进度条
    status: 'active'
  }
  uploadProgress.value.push(progressItem)

  try {
    const arrayBuffer = await file.arrayBuffer()
    // 渲染进程不能直接使用 Buffer，直接传递 ArrayBuffer 给主进程
    // 主进程接收到后会自动处理或我们需要在 preload/main 中处理

    const remotePath = webdavStore.currentDir.endsWith('/')
      ? `${webdavStore.currentDir}${file.name}`
      : `${webdavStore.currentDir}/${file.name}`

    const result = await (window as any).api.webdav.uploadFile({
      serverUrl: webdavStore.connection.serverUrl,
      username: webdavStore.connection.username,
      password: webdavStore.connection.password,
      remotePath,
      fileBuffer: arrayBuffer
    })

    if (result.success) {
      progressItem.percent = 100
      progressItem.status = 'success'
      message.success(t('webdavUploadPanel.uploadSuccess', { name: file.name }))
      emit('uploaded')
    } else {
      progressItem.status = 'exception'
      message.error(
        t('webdavUploadPanel.uploadFailedWithError', { name: file.name, error: result.error })
      )
    }
  } catch (error) {
    console.error('上传文件失败:', error)
    progressItem.status = 'exception'
    message.error(t('webdavUploadPanel.uploadFailed', { name: file.name }))
  }
}
const uploadFiles = async (files: File[]) => {
  if (!webdavStore.connection) {
    message.error(t('webdavUploadPanel.connectFirst'))
    return
  }

  for (const file of files) {
    // 模拟 Ant Design Vue 的 upload customRequest 参数结构
    await handleUpload({ file })
  }
}

defineExpose({
  uploadFiles
})
</script>

<style scoped lang="less">
.webdav-upload-panel {
  padding: 24px;

  .upload-progress-list {
    margin-top: 24px;

    h4 {
      margin-bottom: 12px;
      font-size: 14px;
      font-weight: 600;
      color: var(--color-text-primary);
    }

    .progress-item {
      margin-bottom: 16px;

      .progress-info {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 4px;

        .filename {
          max-width: 500px;
          font-size: 13px;
          color: var(--color-text-secondary);
        }

        .progress-text {
          font-size: 12px;
          color: var(--color-text-muted);
        }
      }
    }
  }
}

.loader {
  width: 100%;
  height: 12px;
  display: inline-block;
  // 以前底是写死的白 + 黑斜纹，只在深色底上成立；浅色主题下白条压白底，
  // 只剩几道斜线在动。现在底走强调色，斜纹用同色的实心档，两个主题都看得见。
  background-color: var(--color-accent-solid);
  background-image: linear-gradient(
    45deg,
    var(--color-accent-bg-hover) 25%,
    transparent 25%,
    transparent 50%,
    var(--color-accent-bg-hover) 50%,
    var(--color-accent-bg-hover) 75%,
    transparent 75%,
    transparent
  );
  font-size: 30px;
  background-size: 1em 1em;
  box-sizing: border-box;
  animation: barStripe 1s linear infinite;
  border-radius: 100px; // 添加圆角使其更美观
}

@keyframes barStripe {
  0% {
    background-position: 1em 0;
  }
  100% {
    background-position: 0 0;
  }
}
</style>
