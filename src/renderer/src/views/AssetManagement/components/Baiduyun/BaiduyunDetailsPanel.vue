<template>
  <div class="asset-details-panel">
    <div class="panel-header">
      <span class="title">{{ file?.server_filename || $t('assetLib.details.title') }}</span>
    </div>

    <div v-if="file" class="panel-body">
      <!-- Header 容器：预览区 + 文件名 -->
      <div class="header-container">
        <div class="preview-wrapper">
          <div v-if="previewUrl" class="preview-box has-image">
            <img
              :src="previewUrl"
              :alt="file.server_filename"
              referrerpolicy="no-referrer"
              @click="handlePreviewClick"
            />
          </div>
          <div v-else class="preview-box">
            <!-- 如果是文件夹 -->
            <div v-if="isFolder" class="folder-icon-large">
              <PhFolder weight="fill" class="folder-icon-large-svg" />
            </div>
            <!-- 其他文件显示图标 -->
            <div v-else class="file-icon-box-inner">
              <component :is="fileTypeIcon" class="file-type-icon" />
            </div>
          </div>
        </div>
        <h1 class="file-name">{{ file.server_filename }}</h1>
        <div class="file-meta">
          {{ isFolder ? $t('baiduyunDetailsPanel.folder') : getFileTypeDisplay() }} ·
          {{ file.size ? formatFileSize(file.size) : '—' }}
        </div>
      </div>

      <!-- 文件详情 -->
      <AppSpin :spinning="loading">
        <div class="inspector-group">
          <div class="inspector-group-title">{{ $t('assetLib.details.fileInfo') }}</div>
          <div class="meta-grid-container">
            <div class="meta-row">
              <label class="meta-label">{{ $t('baiduyunDetailsPanel.path') }}</label>
              <div class="meta-value path-value" :title="file.path">{{ file.path }}</div>
            </div>
            <div class="meta-row">
              <label class="meta-label">{{ $t('baiduyunDetailsPanel.createdTime') }}</label>
              <div class="meta-value">{{ formatTime(file.server_ctime) }}</div>
            </div>
            <div class="meta-row">
              <label class="meta-label">{{ $t('baiduyunDetailsPanel.modifiedTime') }}</label>
              <div class="meta-value">{{ formatTime(file.server_mtime) }}</div>
            </div>
            <div class="meta-row">
              <label class="meta-label">MD5</label>
              <div class="meta-value">{{ file.md5 || metaInfo?.md5 || '—' }}</div>
            </div>
            <div class="meta-row">
              <label class="meta-label">fs_id</label>
              <div class="meta-value">{{ file.fs_id }}</div>
            </div>
          </div>
        </div>

        <!-- 媒体信息 (针对图片/视频) -->
        <div v-if="mediaInfo" class="inspector-group">
          <div class="inspector-group-title">{{ $t('baiduyunDetailsPanel.mediaInfo') }}</div>
          <div class="meta-grid-container">
            <div v-if="mediaInfo.width && mediaInfo.height" class="meta-row">
              <label class="meta-label">{{ $t('baiduyunDetailsPanel.resolution') }}</label>
              <div class="meta-value">{{ mediaInfo.width }} x {{ mediaInfo.height }}</div>
            </div>
            <div v-if="mediaInfo.date_taken" class="meta-row">
              <label class="meta-label">{{ $t('baiduyunDetailsPanel.dateTaken') }}</label>
              <div class="meta-value">{{ formatTime(mediaInfo.date_taken / 1000) }}</div>
            </div>
            <!-- 其他媒体信息可以根据 API 返回扩展 -->
          </div>
        </div>
      </AppSpin>
    </div>

    <div v-else class="empty">
      <div class="empty-state-content">
        <div class="empty-icon">📄</div>
        <div class="empty-text">{{ $t('assetLib.details.selectPrompt') }}</div>
        <div class="empty-desc">{{ $t('assetLib.details.selectPromptDesc') }}</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import AppSpin from '@renderer/components/AppSpin.vue'
import { ref, watch, computed } from 'vue'
import { PhCode, PhFile, PhFilePdf, PhFileText, PhFileZip, PhFolder } from '@phosphor-icons/vue'
import { formatFileSize } from '@renderer/utils/tool'

import { useI18n } from 'vue-i18n'
import {
  getBaiduFileMetas,
  type BaiduFileItem,
  type BaiduFileMetaItem
} from '@renderer/api-services/baiduYunApi'
import { useBaiduyunStore } from '@renderer/store/modules/baiduyun'
import { openImageViewer } from '@renderer/services/imageViewer'
import dayjs from 'dayjs'

const props = defineProps<{
  file?: BaiduFileItem | null
}>()

defineEmits(['close'])

const { t } = useI18n()
const baiduyunStore = useBaiduyunStore()

const loading = ref(false)
const metaInfo = ref<BaiduFileMetaItem | null>(null)

const isFolder = computed(() => props.file?.isdir === 1)

// 获取文件类型图标
const fileTypeIcon = computed(() => {
  if (!props.file) return PhFile
  if (isFolder.value) return PhFolder

  const fileName = props.file.server_filename.toLowerCase()
  const ext = fileName.split('.').pop() || ''

  // 代码文件
  if (['ts', 'js', 'jsx', 'tsx', 'vue', 'cpp', 'h', 'cs', 'java', 'py'].includes(ext)) {
    return PhCode
  }
  // 文本文件
  if (['txt', 'md', 'json', 'xml', 'html', 'css', 'scss', 'less'].includes(ext)) {
    return PhFileText
  }
  // PDF
  if (ext === 'pdf') {
    return PhFilePdf
  }
  // 压缩文件
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) {
    return PhFileZip
  }
  // 默认
  return PhFile
})

// 预览图逻辑
const previewUrl = computed(() => {
  if (!props.file) return null
  // 1. 如果有 API 返回的 thumbs (通常 filemetas 接口会返回 thumbs 字典)
  if (metaInfo.value?.thumbs) {
    // 优先取大图，例如 icon800 > url3 > url2 > url1
    // 百度网盘 API通常返回 keys: icon, url1, url2, url3 ...
    // 这里简单取个 url3 (800x600等) 或者 icon
    const t = metaInfo.value.thumbs
    if (t.url3) return t.url3
    if (t.url2) return t.url2
    if (t.url1) return t.url1
    if (t.icon) return t.icon
    // 遍历 values
    const vals = Object.values(t)
    if (vals.length > 0) return vals[vals.length - 1]
  }

  // 2. 如果列表项自带 thumbs (某些列表接口可能会带，但一般是空的)
  if (props.file.thumbs && Array.isArray(props.file.thumbs) && props.file.thumbs.length > 0) {
    return props.file.thumbs[0] // 或者是其它逻辑
  }

  // 3. 如果是图片且没有 thumbs，可能需要 dlink 但 dlink 需要 token，且不能直接 src
  // 暂时只支持 thumbs
  return null
})

const handlePreviewClick = () => {
  if (previewUrl.value) {
    console.log('[BaiduyunDetailsPanel] Opening preview for:', props.file?.server_filename)
    const w = mediaInfo.value?.width ? Number(mediaInfo.value.width) : undefined
    const h = mediaInfo.value?.height ? Number(mediaInfo.value.height) : undefined

    if (typeof openImageViewer === 'function') {
      openImageViewer({
        items: [
          {
            src: previewUrl.value,
            alt: props.file?.server_filename,
            width: w,
            height: h
          }
        ],
        index: 0
      })
    } else {
      console.error('[BaiduyunDetailsPanel] openImageViewer is not defined or not a function')
    }
  }
}

const mediaInfo = computed(() => {
  return metaInfo.value?.media_info || (metaInfo.value as any) // 有些字段可能直接在 root, 视 API 而定
})

const getFileTypeDisplay = () => {
  if (!props.file) return t('assetLib.details.file')
  const ext = props.file.server_filename.split('.').pop() || ''
  if (ext) {
    return ext.toUpperCase() + t('assetLib.details.fileSuffix')
  }
  return t('assetLib.details.file')
}

const formatTime = (ts: number) => {
  if (!ts) return '—'
  // 百度返回的是秒
  return dayjs.unix(ts).format('YYYY-MM-DD HH:mm:ss')
}

// 加载详细信息
const fetchMeta = async () => {
  if (!props.file) {
    metaInfo.value = null
    return
  }

  // 文件夹通常不需要查 filemetas，或者 filemetas 也可以查文件夹
  // 但为了缩略图，主要针对文件
  // if (isFolder.value) {
  //   metaInfo.value = null
  //   return
  // }

  loading.value = true
  try {
    const accessToken = baiduyunStore.token?.accessToken
    if (!accessToken) return

    const res = await getBaiduFileMetas(accessToken, {
      fsids: [props.file.fs_id],
      dlink: 1,
      needmedia: 1,
      thumb: 1,
      extra: 1,
      detail: 1
    })

    if (res?.list && res.list.length > 0) {
      metaInfo.value = res.list[0]
    } else {
      metaInfo.value = null
    }
  } catch (e) {
    console.error('Fetch baidu meta failed', e)
  } finally {
    loading.value = false
  }
}

watch(
  () => props.file?.fs_id,
  (newVal) => {
    if (newVal) {
      fetchMeta()
    } else {
      metaInfo.value = null
    }
  },
  { immediate: true }
)
</script>

<style lang="less" scoped>
.asset-details-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--color-bg-surface);
  border-left: 1px solid var(--color-border-subtle);
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 12px;
  background: var(--color-bg-page);
  border-bottom: 1px solid var(--color-border-subtle);
}

.title {
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 200px;
}

.close-btn {
  color: var(--color-text-secondary);
}

.panel-body {
  padding: 16px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

// Header
.header-container {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.preview-wrapper {
  position: relative;
  width: 100%;
  display: flex;
  justify-content: center;
  margin-top: 20px;
  margin-bottom: 16px;
}

.preview-box {
  width: 200px;
  height: 200px;
  border-radius: var(--radius-sm);
  // 空预览是凹槽不是强调态，跟 AssetDetailsPanel 里那块保持一致
  background: var(--color-bg-sunken);
  border: 1px solid var(--color-border-subtle);
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  overflow: hidden;
}

.preview-box.has-image {
  background: none;
  border: none;
  cursor: pointer;
}

.preview-box img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

.file-icon-box-inner,
.folder-icon-large {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
}

.folder-icon-large-svg {
  font-size: 64px;
  color: var(--color-warning-text); /* Typical folder color */
}

.file-type-icon {
  font-size: 64px;
  color: var(--color-accent-text);
}

.file-name {
  font-size: 16px;
  font-weight: 600;
  color: var(--color-text-primary);
  text-align: center;
  word-break: break-all;
  margin: 0 0 4px 0;
  padding: 0 10px;
}

.file-meta {
  font-size: 12px;
  color: var(--color-text-secondary);
  text-align: center;
}

// Inspector Group
.inspector-group {
  background-color: var(--color-bg-surface-hover);
  border-radius: 6px;
  padding: 12px;
  margin-bottom: 12px;
  border: 1px solid var(--color-border-subtle);
  width: 100%;
}

.inspector-group-title {
  font-size: 12px;
  color: var(--color-text-secondary);
  font-weight: bold;
  letter-spacing: 1px;
  margin-bottom: 8px;
}

.meta-grid-container {
  display: grid;
  grid-template-columns: 70px 1fr;
  row-gap: 10px;
  column-gap: 10px;
}

.meta-row {
  display: contents;
}

.meta-label {
  font-size: 12px;
  color: var(--color-text-secondary);
  text-align: left;
}

.meta-value {
  font-size: 12px;
  color: var(--color-text-primary);
  font-family: 'JetBrains Mono', monospace;
  word-break: break-all;
}

.path-value {
  max-height: 60px;
  overflow-y: auto;
  /* Custom scrollbar for small areas */
  &::-webkit-scrollbar {
    width: 4px;
  }
  &::-webkit-scrollbar-thumb {
    background: var(--color-bg-surface-hover);
    border-radius: 2px;
  }
}

.empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}
.empty-state-content {
  text-align: center;
  color: var(--color-text-muted);
}
.empty-icon {
  font-size: 48px;
  margin-bottom: 16px;
  opacity: 0.5;
}
.empty-text {
  font-size: 14px;
  font-weight: 500;
  margin-bottom: 8px;
  color: var(--color-text-secondary);
}
.empty-desc {
  font-size: 12px;
  color: var(--color-text-muted);
}
</style>
