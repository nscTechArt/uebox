<script setup lang="ts">
import AppModal from '@renderer/components/AppModal.vue'
import { computed, ref, watch, type DefineComponent } from 'vue'
import { useI18n } from 'vue-i18n'
import * as TextPreviewModule from './TextPreview.vue'
import * as CodePreviewModule from './CodePreview.vue'
import assetDataAPI from '@renderer/api/assetData'
import assetFolderAPI from '@renderer/api/assetFolder'
import { useVaultStore, VaultType } from '@renderer/store/modules/vaultStore'
import {
  resolveAssetLocalPath,
  resolveAssetUrlWithFallback,
  isAbsolutePathOrUrl
} from '@renderer/utils/assetAccess'

type PreviewFile = {
  assetKey?: string
  name?: string
  assetName?: string
  filePath?: string
  originPath?: string
  fileExtension?: string
  ext?: string
  folderKey?: string
  [key: string]: unknown
}

type SfcComponent = DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
const TextPreview = (TextPreviewModule as unknown as { default: SfcComponent }).default
const CodePreview = (CodePreviewModule as unknown as { default: SfcComponent }).default

const props = defineProps<{
  visible: boolean
  file: PreviewFile | null
}>()

const { t } = useI18n()

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void
  (e: 'close'): void
}>()

const handleClose = (): void => {
  emit('update:visible', false)
  emit('close')
}

// 获取当前保管库信息
const vaultStore = useVaultStore()
const currentVault = computed(() => vaultStore.currentVault)
const networkPath = computed(() => currentVault.value?.networkPath || '')
const isNetworkVault = computed(() => currentVault.value?.vaultType === VaultType.NETWORK)
const isRemoteHttpNetworkVault = computed(
  () => isNetworkVault.value && /^https?:\/\//i.test(networkPath.value)
)

/**
 * 获取文件的绝对路径
 * - 引用模式：使用 originPath
 * - 备份模式：使用 vaultPath + filePath 拼接
 */
const absoluteFilePath = computed((): string => {
  if (!props.file) return ''
  return (
    resolveAssetLocalPath({
      vaultType: currentVault.value?.vaultType,
      vaultPath: currentVault.value?.path,
      networkPath: networkPath.value,
      originPath: String(props.file.originPath || ''),
      filePath: String(props.file.filePath || '')
    }) || ''
  )
})

/**
 * 本地文件的可加载 URL（local-resource://，见 toLocalResourceUrl）
 */
const fileUrl = ref('')
const resolveRequestId = ref(0)

const fileExtension = computed((): string => {
  if (!props.file) return ''
  let ext = String(props.file.fileExtension || props.file.ext || '')
  if (!ext) {
    const name = String(props.file.name || props.file.assetName || '')
    ext = name.split('.').pop()?.toLowerCase() || ''
  }
  return ext.toLowerCase().replace(/^\./, '')
})

const fileType = computed((): string => {
  const ext = fileExtension.value
  if (!ext) return 'unknown'

  const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp', 'tga', 'dds']
  const videoExts = ['mp4', 'webm', 'ogg', 'mov', 'avi', 'mkv']
  // 视为文本的格式
  const textExts = ['txt', 'log']
  // 视为代码的格式 (包括配置文件等)
  const codeExts = [
    'js',
    'ts',
    'jsx',
    'tsx',
    'vue',
    'css',
    'less',
    'scss',
    'sass',
    'html',
    'xml',
    'svg',
    'json',
    'yaml',
    'yml',
    'toml',
    'ini',
    'conf',
    'md',
    'markdown',
    'py',
    'java',
    'c',
    'cpp',
    'h',
    'hpp',
    'cs',
    'go',
    'rs',
    'php',
    'sh',
    'bash',
    'bat',
    'ps1',
    'cmd',
    'sql',
    'uproject',
    'uplugin',
    'lock',
    'gitignore'
  ]

  if (imageExts.includes(ext)) return 'image'
  if (videoExts.includes(ext)) return 'video'
  if (ext === 'pdf') return 'pdf'
  if (textExts.includes(ext)) return 'text'
  if (codeExts.includes(ext)) return 'code'

  return 'unknown'
})

const resolveFileUrl = async (): Promise<void> => {
  const requestId = ++resolveRequestId.value
  if (!props.file) {
    fileUrl.value = ''
    return
  }

  const assetFilePath = String(props.file.filePath || '')
  const assetOriginPath = String(props.file.originPath || '')
  const resolvedUrl =
    (await resolveAssetUrlWithFallback({
      vaultType: currentVault.value?.vaultType,
      vaultPath: currentVault.value?.path,
      networkPath: networkPath.value,
      originPath: assetOriginPath,
      filePath: assetFilePath,
      assetKey: String(props.file.assetKey || ''),
      assetName: String(props.file.name || props.file.assetName || ''),
      fileExtension: fileExtension.value,
      folderKey: String(props.file.folderKey || ''),
      resolveAssetByKey: async (assetKey: string) => {
        try {
          return await assetDataAPI.getById(assetKey)
        } catch (error) {
          console.warn('[FilePreviewModal] 获取资产详情失败，回退为当前列表数据:', error)
          return undefined
        }
      },
      resolveFolderRelativePath: async (folderKey: string) => {
        try {
          const folder = await assetFolderAPI.getByKey(folderKey)
          return folder?.fullPath
        } catch (error) {
          console.warn('[FilePreviewModal] 获取文件夹路径失败，回退为文件名:', error)
          return undefined
        }
      }
    })) || ''
  if (requestId !== resolveRequestId.value) return
  fileUrl.value = resolvedUrl

  if (fileUrl.value) return

  if (isNetworkVault.value && networkPath.value) {
    for (const candidate of [assetFilePath, assetOriginPath]) {
      if (!candidate) continue

      if (!isRemoteHttpNetworkVault.value && isAbsolutePathOrUrl(candidate)) {
        fileUrl.value = candidate
        return
      }
    }

    if (isRemoteHttpNetworkVault.value) return
  }
}

watch(
  [() => props.file, () => currentVault.value?.id, networkPath],
  () => {
    void resolveFileUrl()
  },
  { immediate: true, deep: true }
)
</script>

<template>
  <AppModal
    :open="visible"
    hide-footer
    :closable="false"
    width="100vw"
    :mask-style="{ backgroundColor: 'rgba(0, 0, 0, 0.85)', backdropFilter: 'blur(6px)' }"
    class="file-preview-modal"
    @cancel="handleClose"
  >
    <div class="preview-content">
      <button
        class="immersive-close-btn"
        :aria-label="t('filePreviewModal.closeAriaLabel')"
        @click="handleClose"
      >
        ×
      </button>
      <!-- 图片预览 -->
      <div v-if="fileType === 'image'" class="image-preview">
        <img :src="fileUrl" :alt="file?.name || ''" />
      </div>

      <!-- 视频预览 -->
      <div v-else-if="fileType === 'video'" class="video-preview">
        <video controls autoplay :src="fileUrl"></video>
      </div>

      <!-- PDF 预览 -->
      <div v-else-if="fileType === 'pdf'" class="pdf-preview">
        <iframe :src="fileUrl" width="100%" height="100%"></iframe>
      </div>

      <!-- 文本预览 -->
      <div v-else-if="fileType === 'text'" class="text-preview-container">
        <TextPreview :file-path="absoluteFilePath" :file-url="fileUrl" />
      </div>

      <!-- 代码预览 -->
      <div v-else-if="fileType === 'code'" class="code-preview-container">
        <CodePreview
          :file-path="absoluteFilePath"
          :file-url="fileUrl"
          :file-extension="fileExtension"
        />
      </div>

      <div v-else class="unsupported-preview">
        <p>
          {{
            t('filePreviewModal.unsupportedFormat', {
              ext: fileExtension || t('filePreviewModal.unknownExt')
            })
          }}
        </p>
      </div>
    </div>
  </AppModal>
</template>

<style>
.file-preview-modal .app-modal__panel {
  width: 100vw !important;
  max-width: 100vw !important;
  height: 100vh;
  margin: 0 !important;
  top: 0 !important;
  padding-bottom: 0 !important;
}

.file-preview-modal .app-modal__panel {
  background: transparent !important;
  box-shadow: none !important;
  padding: 0 !important;
  border-radius: 0 !important;
  overflow: hidden;
}

.file-preview-modal .app-modal__header {
  display: none !important;
}

.file-preview-modal .app-modal__body {
  padding: 0 !important;
  height: 100vh;
}
</style>

<style scoped>
.preview-content {
  position: relative;
  display: flex;
  justify-content: center;
  align-items: center;
  width: 100%;
  height: 100vh;
  overflow: hidden;
  background: var(--color-bg-page);
}

.immersive-close-btn {
  position: absolute;
  top: 16px;
  right: 16px;
  z-index: 10;
  width: 40px;
  height: 40px;
  border: none;
  border-radius: 999px;
  background: var(--color-bg-overlay);
  color: var(--color-text-on-solid);
  font-size: 28px;
  line-height: 40px;
  text-align: center;
  cursor: pointer;
  user-select: none;
  -webkit-user-select: none;
  backdrop-filter: blur(6px);
}

.immersive-close-btn:hover {
  background: var(--color-bg-overlay);
}

.immersive-close-btn:active {
  transform: scale(0.98);
}

/* Modifying background for text/code to match their dark theme if necessary,
   but the components handle their own background.
   We just ensure they fill the space.
*/
.text-preview-container,
.code-preview-container {
  width: 90%;
  height: 90%;
  background-color: var(--color-bg-surface);
  user-select: text;
  -webkit-user-select: text;
}
.code-preview-container {
  background-color: var(--color-bg-surface);
}

.image-preview img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

.video-preview {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.video-preview video {
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: var(--color-bg-page);
}

.pdf-preview {
  width: 100%;
  height: 100%;
}

.unsupported-preview {
  color: var(--color-text-secondary);
  font-size: 16px;
}
</style>
