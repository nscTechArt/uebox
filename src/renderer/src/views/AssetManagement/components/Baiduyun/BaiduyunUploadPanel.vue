<template>
  <AppCard v-if="isAuthenticated" class="upload-card" :title="$t('baiduyunUploadPanel.card.title')">
    <div class="upload-toolbar">
      <a-input
        v-model:value="localAppName"
        :placeholder="$t('baiduyunUploadPanel.form.appNamePlaceholder')"
        allow-clear
        style="max-width: 380px"
        addon-before="/apps/"
      />
      <a-input
        v-model:value="localUploadPath"
        :placeholder="$t('baiduyunUploadPanel.form.uploadPathPlaceholder')"
        allow-clear
        style="max-width: 460px"
      />
      <a-upload
        :before-upload="handleBeforeUploadInternal"
        :max-count="1"
        @change="handleUploadChangeInternal"
      >
        <AppButton>
          <template #icon>
            <PhUploadSimple />
          </template>
          {{ $t('baiduyunUploadPanel.actions.chooseFile') }}
        </AppButton>
      </a-upload>
      <AppButton variant="primary" :loading="uploading" @click="handleStartUploadInternal">
        {{ $t('baiduyunUploadPanel.actions.startUpload') }}
      </AppButton>
    </div>
    <div v-if="uploading || uploadPercent > 0" class="upload-status">
      <div class="status-line">
        {{ $t('baiduyunUploadPanel.status.label', { status: uploadStepLabel }) }}
      </div>
      <AppProgress :percent="uploadPercent" />
    </div>
    <div class="hint">
      {{ $t('baiduyunUploadPanel.hint.testNote') }}
    </div>
  </AppCard>
  <AppCard v-else class="upload-card" :title="$t('baiduyunUploadPanel.card.title')">
    <div class="hint">{{ $t('baiduyunUploadPanel.hint.needAuth') }}</div>
  </AppCard>
</template>

<script setup lang="ts">
import AppCard from '@renderer/components/AppCard.vue'
import AppProgress from '@renderer/components/AppProgress.vue'
import AppButton from '@renderer/components/AppButton.vue'
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { message } from '@/utils/messageManager'
import { PhUploadSimple } from '@phosphor-icons/vue'
import { useBaiduyunStore } from '@renderer/store/modules/baiduyun'
import {
  precreateBaiduFile,
  locateUploadServer,
  uploadBaiduSuperfile,
  createBaiduFile
} from '@renderer/api-services/baiduYunApi'
import SparkMD5 from 'spark-md5'

interface Emits {
  (e: 'uploaded', payload: { path: string; name: string; size: number }): void
}

const emit = defineEmits<Emits>()
const baiduyunStore = useBaiduyunStore()
const { t } = useI18n()

const isAuthenticated = computed(() => baiduyunStore.isAuthenticated && !baiduyunStore.isExpired)

// 应用名称（用于拼接 /apps/{appname} 目录）
const localAppName = ref<string>('unreal-agent')
// 固定前缀的上传目录（不可编辑），由应用名称拼接得到
const localUploadFolder = computed(() => `/apps/${(localAppName.value || '').replace(/^\/+/, '')}`)
const localUploadPath = ref<string>('')
const uploadFile = ref<File | null>(null)
const uploading = ref(false)
const uploadPercent = ref(0)
const uploadStep = ref<'idle' | 'precreate' | 'locate' | 'upload' | 'create' | 'done' | 'error'>(
  'idle'
)

const uploadStepLabel = computed(() => {
  switch (uploadStep.value) {
    case 'precreate':
      return t('baiduyunUploadPanel.stepLabels.precreate')
    case 'locate':
      return t('baiduyunUploadPanel.stepLabels.locate')
    case 'upload':
      return t('baiduyunUploadPanel.stepLabels.upload')
    case 'create':
      return t('baiduyunUploadPanel.stepLabels.create')
    case 'done':
      return t('baiduyunUploadPanel.stepLabels.done')
    case 'error':
      return t('baiduyunUploadPanel.stepLabels.error')
    default:
      return t('baiduyunUploadPanel.stepLabels.idle')
  }
})

const chunkSize = 4 * 1024 * 1024

/**
 * 选择文件前置处理：记录文件对象，并基于固定前缀目录构造本地上传路径
 * @param file 选择的文件对象
 * @returns 阻止 antd Upload 的默认上传行为
 */
function handleBeforeUploadInternal(file: any) {
  const f = file as File
  uploadFile.value = f
  const baseDir = localUploadFolder.value || '/apps/unreal-agent'
  localUploadPath.value = `${baseDir}/${f.name}`
  return false
}

/**
 * Upload 变更回调：当文件选择变化时，更新文件并重建目标上传路径
 * @param info antd Upload 的变更信息对象
 */
function handleUploadChangeInternal(info: any) {
  const candidate =
    (info && info.file && (info.file.originFileObj || info.file)) ||
    (info &&
      info.fileList &&
      info.fileList[0] &&
      (info.fileList[0].originFileObj || info.fileList[0]))
  if (candidate) {
    const file = candidate as File
    uploadFile.value = file
    const baseDir = localUploadFolder.value || '/apps/unreal-agent'
    localUploadPath.value = `${baseDir}/${file.name}`
  } else {
    uploadFile.value = null
  }
}

function readChunk(file: File, start: number, end: number): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = reject
    reader.readAsArrayBuffer(file.slice(start, end))
  })
}

async function computeBlockList(file: File): Promise<string[]> {
  const total = file.size
  const blocks: string[] = []
  let offset = 0
  while (offset < total) {
    const end = Math.min(offset + chunkSize, total)
    const buf = await readChunk(file, offset, end)
    const md5 = SparkMD5.ArrayBuffer.hash(buf)
    blocks.push(md5)
    offset = end
  }
  return blocks
}

function pickUploadHost(resp: any): string {
  const httpsDomains: string[] = [
    ...(Array.isArray(resp.servers) ? resp.servers.map((e: any) => e.server) : []),
    ...(Array.isArray(resp.server) ? resp.server : [])
  ].filter((d: string) => typeof d === 'string' && d.startsWith('https://'))
  return (
    httpsDomains[0] || resp.host || (Array.isArray(resp.servers) && resp.servers[0]?.server) || ''
  )
}

/**
 * 开始上传：按百度云分片上传流程依次执行预上传、定位域名、分片上传和创建文件
 * - 确保目标路径位于 `/apps/{appname}`
 * - 进度通过 `uploadPercent` 和 `uploadStep` 展示
 */
async function handleStartUploadInternal() {
  try {
    if (!isAuthenticated.value) {
      message.error(t('baiduyunUploadPanel.messages.authRequired'))
      return
    }
    if (!uploadFile.value) {
      message.error(t('baiduyunUploadPanel.messages.fileRequired'))
      return
    }

    const file = uploadFile.value
    const accessToken = baiduyunStore.token?.accessToken
    if (!accessToken) {
      message.error(t('baiduyunUploadPanel.messages.missingToken'))
      return
    }

    let targetPath = (localUploadPath.value || `${localUploadFolder.value}/${file.name}`).trim()

    // 自动补全后缀：如果目标路径没有后缀且与源文件后缀不匹配，尝试补全
    if (file.name.lastIndexOf('.') > 0) {
      const ext = file.name.substring(file.name.lastIndexOf('.'))
      if (ext) {
        // 检查当前路径是否已经包含该后缀（忽略大小写）
        if (!targetPath.toLowerCase().endsWith(ext.toLowerCase())) {
          targetPath += ext
          // 同时更新输入框显示，让用户感知到后缀被补回了
          localUploadPath.value = targetPath
        }
      }
    }

    if (!targetPath.startsWith('/apps/')) {
      message.error(t('baiduyunUploadPanel.messages.pathMustBeInApps'))
      return
    }

    uploading.value = true
    uploadPercent.value = 2
    uploadStep.value = 'precreate'

    const blockList = await computeBlockList(file)
    if (blockList.length > 1024) {
      message.error(t('baiduyunUploadPanel.messages.tooManyChunks'))
      uploading.value = false
      uploadStep.value = 'error'
      return
    }

    const preRes = await precreateBaiduFile(accessToken, {
      path: targetPath,
      size: file.size,
      isdir: 0,
      blockList,
      rtype: 1,
      localCtime: Math.floor(Date.now() / 1000),
      localMtime: Math.floor(Date.now() / 1000)
    })
    const pre = (preRes as any)?.data ?? preRes

    uploadPercent.value = 10
    uploadStep.value = 'locate'

    const locateRes = await locateUploadServer(accessToken, {
      path: targetPath,
      uploadid: pre.uploadid
    })
    const locate = (locateRes as any)?.data ?? locateRes

    const host = pickUploadHost(locate)
    if (!host) {
      throw new Error('未获取到有效上传域名')
    }

    const totalChunks = blockList.length
    let indices: number[] = []
    if (Array.isArray((pre as any).block_list)) {
      indices = (pre as any).block_list as number[]
    } else {
      indices = Array.from({ length: totalChunks }, (_, i) => i)
    }

    uploadStep.value = 'upload'
    for (let i = 0; i < indices.length; i++) {
      const partIndex = indices[i]
      const start = partIndex * chunkSize
      const end = Math.min(start + chunkSize, file.size)
      const data = await readChunk(file, start, end)
      await uploadBaiduSuperfile(data, {
        host,
        accessToken,
        path: targetPath,
        uploadid: pre.uploadid,
        partseq: partIndex
      })
      uploadPercent.value = 10 + Math.round(((i + 1) / indices.length) * 80)
    }

    uploadStep.value = 'create'
    const createRes = await createBaiduFile(accessToken, {
      path: targetPath,
      size: file.size,
      isdir: 0,
      blockList,
      uploadid: pre.uploadid,
      rtype: 0,
      localCtime: Math.floor(Date.now() / 1000),
      localMtime: Math.floor(Date.now() / 1000)
    })

    const created = (createRes as any)?.data ?? createRes
    uploadPercent.value = 100
    uploadStep.value = 'done'
    message.success(t('baiduyunUploadPanel.messages.uploadDone', { name: created.server_filename }))

    emit('uploaded', { path: targetPath, name: created.server_filename, size: file.size })
  } catch (err: any) {
    console.error('上传失败', err)
    uploadStep.value = 'error'
    message.error(err?.message || t('baiduyunUploadPanel.messages.uploadFailedRetry'))
  } finally {
    uploading.value = false
  }
}
</script>

<style scoped lang="less">
.upload-card {
  margin-top: 16px;
  border-radius: 12px;
  box-shadow: 0 8px 24px var(--shadow-color-weak);

  :deep(.app-card__body) {
    padding: 20px;
  }

  .upload-toolbar {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;

    :deep(.ant-input) {
      border-radius: 8px;
    }
  }

  .upload-status {
    margin-top: 12px;

    .status-line {
      margin-bottom: 8px;
      color: var(--color-text-muted);
      font-size: 12px;
    }
  }

  .hint {
    margin-top: 8px;
    color: var(--color-text-muted);
    font-size: 12px;
  }
}
</style>
