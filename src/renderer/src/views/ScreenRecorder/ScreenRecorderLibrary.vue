<template>
  <div class="screen-recorder-library">
    <header v-if="viewMode === 'edit'" class="library-header is-edit">
      <div class="title-group">
        <div class="title">{{ $t('screenRecorderLibrary.edit.title') }}</div>
        <div class="subtitle">
          {{ editFileName || $t('screenRecorderLibrary.edit.subtitleFallback') }}
        </div>
      </div>
      <div class="header-actions">
        <AppButton @click="handleExitEdit">{{
          $t('screenRecorderLibrary.edit.backButton')
        }}</AppButton>
      </div>
    </header>

    <div v-if="viewMode === 'list'" class="library-body">
      <section class="list-panel">
        <div class="list-toolbar">
          <a-input
            v-model:value="keyword"
            :aria-label="$t('screenRecorderLibrary.list.searchLabel')"
            :placeholder="$t('screenRecorderLibrary.list.searchPlaceholder')"
            allow-clear
            class="search-input"
          >
            <template #prefix>
              <PhMagnifyingGlass />
            </template>
          </a-input>
          <div class="action-group">
            <AppTooltip :title="$t('screenRecorderLibrary.list.openFolderTitle')">
              <AppButton
                :aria-label="$t('screenRecorderLibrary.list.openFolderTitle')"
                :disabled="!directory"
                @click="handleOpenFolder"
              >
                <template #icon>
                  <PhFolderOpen aria-hidden="true" />
                </template>
              </AppButton>
            </AppTooltip>
            <AppTooltip :title="$t('screenRecorderLibrary.list.refreshTitle')">
              <AppSpin :spinning="loading">
                <AppButton
                  :aria-label="$t('screenRecorderLibrary.list.refreshTitle')"
                  :disabled="loading"
                  @click="handleRefresh"
                >
                  <template #icon>
                    <PhArrowClockwise aria-hidden="true" />
                  </template>
                </AppButton>
              </AppSpin>
            </AppTooltip>
          </div>
        </div>
        <div class="record-list custom-scroll" :aria-busy="loading">
          <div v-if="filteredRecordings.length === 0" class="empty-state">
            <PhFilmSlate class="empty-icon" aria-hidden="true" />
            <p v-if="keyword.trim()">
              {{ $t('screenRecorderLibrary.list.noSearchResults') }}
            </p>
            <p v-else>{{ $t('screenRecorderLibrary.list.emptyState') }}</p>
            <AppButton v-if="keyword.trim()" variant="link" size="small" @click="keyword = ''">
              {{ $t('screenRecorderLibrary.list.clearSearch') }}
            </AppButton>
          </div>
          <button
            v-for="item in filteredRecordings"
            :key="item.path"
            type="button"
            class="record-item"
            :class="{ 'is-active': item.path === selectedPath }"
            :aria-pressed="item.path === selectedPath"
            @click="handleSelect(item)"
          >
            <div class="item-icon" aria-hidden="true">
              <PhVideoCamera />
            </div>
            <div class="item-content">
              <div class="record-name" :title="item.name">{{ item.name }}</div>
              <div class="record-meta">
                <span class="meta-tag size">{{ formatBytes(item.size) }}</span>
                <span class="meta-separator">•</span>
                <span class="meta-tag time">{{ formatDate(item.mtime) }}</span>
              </div>
            </div>
          </button>
        </div>
      </section>

      <section class="detail-panel">
        <div v-if="activeRecording" class="detail-content">
          <div class="info-section">
            <div class="info-header">
              <div class="file-identity">
                <h3 class="file-name" :title="activeRecording.name">
                  {{ activeRecording.name }}
                </h3>
                <div class="file-summary">
                  <span>{{ activeRecording.extension.toUpperCase() }}</span>
                  <span aria-hidden="true">•</span>
                  <span>{{ formatBytes(activeRecording.size) }}</span>
                  <span aria-hidden="true">•</span>
                  <span>{{ formatDate(activeRecording.mtime) }}</span>
                </div>
              </div>
              <AppButton class="open-button" @click="handleOpen">
                <template #icon><PhPlayCircle /></template>
                {{ $t('screenRecorderLibrary.detail.openInPlayer') }}
              </AppButton>
            </div>

            <details class="file-details">
              <summary>{{ $t('screenRecorderLibrary.detail.moreDetails') }}</summary>
              <div class="details-content">
                <div class="action-bar">
                  <AppButton variant="text" size="small" @click="handleReveal">
                    <template #icon><PhFolder /></template>
                    {{ $t('screenRecorderLibrary.detail.openLocation') }}
                  </AppButton>
                  <AppButton variant="text" size="small" danger @click="handleDelete">
                    <template #icon><PhTrash /></template>
                    {{ $t('screenRecorderLibrary.detail.delete') }}
                  </AppButton>
                </div>

                <div class="info-item">
                  <span class="label">{{ $t('screenRecorderLibrary.detail.filePath') }}</span>
                  <span class="value path" :title="activeRecording.path">{{
                    activeRecording.path
                  }}</span>
                </div>
              </div>
            </details>
          </div>

          <details class="preview-details">
            <summary>{{ $t('screenRecorderLibrary.detail.previewDisclosure') }}</summary>
            <div class="preview-wrapper">
              <div class="preview-card">
                <video
                  v-if="previewUrl"
                  class="preview-video"
                  :src="previewUrl"
                  :aria-label="
                    $t('screenRecorderLibrary.detail.previewLabel', { name: activeRecording.name })
                  "
                  preload="none"
                  controls
                />
              </div>
            </div>
          </details>
        </div>

        <div v-else class="empty-selection">
          <div class="empty-content">
            <PhVideoCamera class="empty-icon" />
            <p>{{ $t('screenRecorderLibrary.detail.emptySelection') }}</p>
          </div>
        </div>
      </section>
    </div>
    <div v-else class="edit-body">
      <ScreenRecorderExportPanel
        :source-url="editSourceUrl"
        :recording-name="editFileName"
        @export="handleExport"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import AppTooltip from '@renderer/components/AppTooltip.vue'
import AppButton from '@renderer/components/AppButton.vue'
import { computed, onMounted, ref, createVNode } from 'vue'
import { useI18n } from 'vue-i18n'
import { Input as AInput } from 'ant-design-vue'
import AppSpin from '@renderer/components/AppSpin.vue'
import { message } from '@renderer/utils/messageManager'
import { confirmDialog } from '@renderer/utils/dialog'
import {
  PhArrowClockwise,
  PhFilmSlate,
  PhFolder,
  PhFolderOpen,
  PhMagnifyingGlass,
  PhPlayCircle,
  PhTrash,
  PhVideoCamera,
  PhWarningCircle
} from '@phosphor-icons/vue'
import ScreenRecorderExportPanel from './ScreenRecorderExportPanel.vue'
import { toLocalResourceUrl } from '@renderer/utils/localResource'

interface RecordingItem {
  name: string
  path: string
  size: number
  mtime: string
  extension: string
}

const { t } = useI18n()

const directory = ref('')
const recordings = ref<RecordingItem[]>([])
const selectedPath = ref('')
const keyword = ref('')
const loading = ref(false)
const viewMode = ref<'list' | 'edit'>('list')
const editSourcePath = ref('')
const editSourceUrl = ref('')
const editFileName = ref('')

type ExportFormat = 'mp4' | 'gif'
type ExportQuality = 'high' | 'balanced' | 'fast'
type ExportResolution = 'original' | '1080p' | '720p'

interface ExportOptions {
  format: ExportFormat
  quality: ExportQuality
  resolution: ExportResolution
  fps: number
  bitrate: number
  includeAudio: boolean
  highQualityScale: boolean
  trimStart: number
  trimEnd: number
}

const filteredRecordings = computed(() => {
  const key = keyword.value.trim().toLowerCase()
  if (!key) return recordings.value
  return recordings.value.filter((item) => item.name.toLowerCase().includes(key))
})

const activeRecording = computed(() =>
  recordings.value.find((item) => item.path === selectedPath.value)
)

const previewUrl = computed(() => {
  if (!activeRecording.value) return ''
  return toFileUrl(activeRecording.value.path)
})

onMounted(async () => {
  await loadRecordingsDirectory()
  await loadRecordings()
})

async function loadRecordingsDirectory(): Promise<void> {
  const res = await window.api.screenRecorder.getRecordingsDir()
  if (res.success && res.dirPath) {
    directory.value = res.dirPath
    return
  }
  message.error(res.error || '获取录制目录失败')
}

async function loadRecordings(): Promise<void> {
  loading.value = true
  const res = await window.api.screenRecorder.listRecordings()
  loading.value = false
  if (!res.success || !res.data) {
    message.error(res.error || '读取录制列表失败')
    return
  }
  if (res.dirPath) {
    directory.value = res.dirPath
  }
  recordings.value = res.data
  if (recordings.value.length === 0) {
    selectedPath.value = ''
    return
  }
  const exists = recordings.value.some((item) => item.path === selectedPath.value)
  if (!exists) {
    selectedPath.value = recordings.value[0].path
  }
}

function handleSelect(item: RecordingItem): void {
  selectedPath.value = item.path
}

function handleExitEdit(): void {
  viewMode.value = 'list'
  editSourcePath.value = ''
  editSourceUrl.value = ''
  editFileName.value = ''
}

async function handleRefresh(): Promise<void> {
  await loadRecordings()
}

async function handleOpenFolder(): Promise<void> {
  if (!directory.value) return
  const res = await window.api.shell.openPath(directory.value)
  if (!res?.success) {
    message.error(res?.error || '打开目录失败')
  }
}

async function handleReveal(): Promise<void> {
  if (!activeRecording.value) return
  const res = await window.api.shell.showItemInFolder(activeRecording.value.path)
  if (!res?.success) {
    message.error(res?.error || '定位失败')
  }
}

async function handleOpen(): Promise<void> {
  if (!activeRecording.value) return
  const res = await window.api.shell.openPath(activeRecording.value.path)
  if (!res?.success) {
    message.error(res?.error || '打开文件失败')
  }
}

function handleDelete(): void {
  if (!activeRecording.value) return

  confirmDialog({
    title: t('screenRecorderLibrary.actions.deleteTitle'),
    icon: createVNode(PhWarningCircle),
    content: t('screenRecorderLibrary.actions.deleteConfirm', { name: activeRecording.value.name }),
    okText: t('common.delete'),
    danger: true,
    cancelText: t('common.cancel'),
    async onOk() {
      if (!activeRecording.value) return
      try {
        const res = await window.api.screenRecorder.deleteRecording(activeRecording.value.path)
        if (!res.success) {
          message.error(res.error || t('screenRecorderLibrary.actions.deleteFailed'))
          return
        }
        message.success(t('screenRecorderLibrary.actions.deleted'))
        await loadRecordings()
      } catch (error) {
        console.error('Delete failed:', error)
        message.error(t('screenRecorderLibrary.actions.deleteError'))
      }
    }
  })
}

async function handleExport(options: ExportOptions): Promise<void> {
  if (!editSourcePath.value) {
    message.error(t('screenRecorderLibrary.actions.noExportSource'))
    return
  }

  try {
    const result = await window.api.screenRecorder.exportRecording({
      inputPath: editSourcePath.value,
      format: options.format,
      quality: options.quality,
      resolution: options.resolution,
      fps: options.fps,
      bitrate: options.bitrate,
      includeAudio: options.includeAudio,
      highQualityScale: options.highQualityScale,
      trimStart: options.trimStart,
      trimEnd: options.trimEnd
    })
    if (result?.success && result.filePath) {
      message.success(t('screenRecorderLibrary.actions.exported'))
    } else {
      message.error(result?.error || t('screenRecorderLibrary.actions.exportFailed'))
    }
  } catch (error) {
    console.error('导出失败:', error)
    message.error(t('screenRecorderLibrary.actions.exportFailed'))
  }
}

function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = size
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value.toFixed(index === 0 ? 0 : 2)} ${units[index]}`
}

function formatDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date)
}

// 本地视频必须走 local-resource://：dev 模式下 <video src="file:///..."> 加载不了，
// 而且这个协议由主进程按 Range 供流，进度条能正常拖。
function toFileUrl(filePath: string): string {
  return toLocalResourceUrl(filePath) ?? filePath
}
</script>

<style scoped lang="less">
.screen-recorder-library {
  display: flex;
  flex-direction: column;
  height: 100%;
  color: var(--color-text-primary);
  background: transparent;

  /* 通用滚动条样式 */
  .custom-scroll {
    &::-webkit-scrollbar {
      width: 4px;
    }
    &::-webkit-scrollbar-track {
      background: transparent;
    }
    &::-webkit-scrollbar-thumb {
      background: var(--color-bg-surface-hover);
      border-radius: 2px;
      &:hover {
        background: var(--color-bg-surface-hover);
      }
    }
  }

  .library-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-4) var(--space-6);
    border-bottom: 1px solid var(--color-border-subtle);
    background: var(--color-bg-surface-hover);
    flex-shrink: 0;

    .header-left {
      .header-title {
        font-size: 14px;
        font-weight: 600;
        color: var(--color-text-primary);
        display: flex;
        align-items: center;
        gap: 8px;

        .count {
          font-size: 11px;
          color: var(--color-text-muted);
          font-weight: normal;
        }
      }
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 12px;

      .search-input {
        width: 240px;
        :deep(.ant-input) {
          background: var(--color-bg-surface-hover);
          border-color: transparent;
          color: var(--color-text-primary);
          &::placeholder {
            color: var(--color-text-muted);
          }
        }
        :deep(.ant-input-affix-wrapper) {
          background: var(--color-bg-surface-hover);
          border: 1px solid var(--color-border-subtle);
          border-radius: 6px;
          color: var(--color-text-muted);
          &:hover,
          &:focus-within {
            border-color: var(--color-border);
          }
        }
      }

      .action-group {
        display: flex;
        gap: 8px;

        :deep(.app-button) {
          background: var(--color-bg-surface-hover);
          border: 1px solid var(--color-border-subtle);
          color: var(--color-text-primary);
          display: flex;
          align-items: center;
          justify-content: center;
          width: 32px;
          height: 32px;
          padding: 0;

          &:hover {
            background: var(--color-bg-surface-hover);
            border-color: var(--color-border);
            color: var(--color-accent-text);
          }
        }
      }
    }
  }

  .library-header.is-edit {
    .header-actions {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .title-group {
      .title {
        font-size: 14px;
        font-weight: 600;
      }
      .subtitle {
        font-size: 11px;
        color: var(--color-text-muted);
      }
    }
  }

  .library-body {
    flex: 1;
    display: flex;
    overflow: hidden;
  }

  .edit-body {
    flex: 1;
    display: flex;
    height: 100%;
  }

  /* 左侧列表面板 */
  .list-panel {
    width: 320px;
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--color-border-subtle);
    background: var(--color-bg-surface);
    flex-shrink: 0;
  }

  .list-toolbar {
    padding: 12px;
    display: flex;
    gap: 8px;
    border-bottom: 1px solid var(--color-border-subtle);

    .search-input {
      flex: 1;
      min-width: 0;

      :deep(.ant-input) {
        background: var(--color-bg-surface-hover);
        border-color: transparent;
        color: var(--color-text-primary);
        font-size: 12px;
        &::placeholder {
          color: var(--color-text-muted);
        }
      }
      :deep(.ant-input-affix-wrapper) {
        background: var(--color-bg-surface-hover);
        border: 1px solid var(--color-border-subtle);
        border-radius: 6px;
        color: var(--color-text-muted);
        padding-top: 4px;
        padding-bottom: 4px;
        &:hover,
        &:focus-within {
          border-color: var(--color-border);
        }
      }
    }

    .action-group {
      display: flex;
      gap: 6px;

      :deep(.app-button) {
        background: var(--color-bg-surface-hover);
        border: 1px solid var(--color-border-subtle);
        color: var(--color-text-primary);
        display: flex;
        align-items: center;
        justify-content: center;
        width: 32px;
        height: 32px;
        padding: 0;
        border-radius: 6px;

        &:hover {
          background: var(--color-bg-surface-hover);
          border-color: var(--color-border);
          color: var(--color-accent-text);
        }
      }
    }
  }

  .record-list {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    padding: 8px;
    gap: 4px;
  }

  .record-item {
    display: flex;
    gap: 12px;
    padding: 12px;
    border-radius: 8px;
    cursor: pointer;
    width: 100%;
    background: transparent;
    font: inherit;
    text-align: left;
    transition:
      background-color var(--motion-fast) var(--easing-standard),
      color var(--motion-fast) var(--easing-standard);
    border: 1px solid transparent;
    color: var(--color-text-secondary);

    &:hover {
      background: var(--color-bg-surface-hover);
      color: var(--color-text-primary);
    }

    &:focus-visible {
      outline: 2px solid var(--color-border-focus);
      outline-offset: -2px;
    }

    &.is-active {
      background: var(--color-bg-selected);
      color: var(--color-text-selected);

      .item-icon {
        color: var(--color-text-selected);
        background: var(--color-bg-selected-hover);
      }

      .record-name {
        color: var(--color-text-selected);
      }
    }

    &.is-active:hover {
      background: var(--color-bg-selected-hover);
    }

    .item-icon {
      width: 36px;
      height: 36px;
      border-radius: 6px;
      background: var(--color-bg-surface-hover);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 18px;
      color: var(--color-text-muted);
      flex-shrink: 0;
    }

    .item-content {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      justify-content: center;
      gap: 4px;
    }

    .record-name {
      font-size: 12px;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      line-height: 1.4;
    }

    .record-meta {
      display: flex;
      align-items: center;
      font-size: 10px;
      color: var(--color-text-muted);

      .meta-separator {
        margin: 0 6px;
        opacity: 0.5;
      }
    }
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 40px 0;
    color: var(--color-text-muted);
    gap: 12px;

    .empty-icon {
      font-size: 32px;
      opacity: 0.5;
    }

    p {
      font-size: 12px;
      margin: 0;
    }
  }

  /* 右侧详情面板 */
  .detail-panel {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    background: var(--color-bg-surface);
    position: relative;
  }

  .detail-content {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow-y: auto;
  }

  .preview-wrapper {
    padding: var(--space-6);
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--color-bg-sunken);
  }

  .preview-card {
    width: 100%;
    aspect-ratio: 16 / 9;
    display: flex;
    align-items: center;
    justify-content: center;
    max-width: 1200px;

    .preview-video {
      width: 100%;
      height: 100%;
      object-fit: contain;
      border-radius: 8px;
      box-shadow: 0 4px 20px var(--shadow-color);
      background: var(--color-bg-page);

      &:focus-visible {
        outline: 2px solid var(--color-border-focus);
        outline-offset: 2px;
      }
    }
  }

  .info-section {
    padding: var(--space-4) var(--space-6);
    background: transparent;
    flex-shrink: 0;
  }

  .info-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-4);

    .file-identity {
      min-width: 0;
    }

    .file-name {
      margin: 0;
      font-size: 16px;
      font-weight: 600;
      color: var(--color-text-primary);
      overflow-wrap: anywhere;
      line-height: 1.4;
    }

    .file-summary {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      margin-top: var(--space-1);
      font-size: var(--font-size-xs);
      color: var(--color-text-muted);
      font-variant-numeric: tabular-nums;
    }

    .open-button {
      flex-shrink: 0;
    }
  }

  .file-details {
    margin-top: var(--space-3);
    border-top: 1px solid var(--color-border-subtle);
  }

  .file-details,
  .preview-details {
    summary {
      width: fit-content;
      color: var(--color-text-secondary);
      font-size: var(--font-size-sm);
      cursor: pointer;

      &:hover {
        color: var(--color-text-primary);
      }

      &:focus-visible {
        outline: 2px solid var(--color-border-focus);
        outline-offset: 2px;
        border-radius: var(--radius-xs);
      }
    }
  }

  .file-details summary {
    padding: var(--space-3) 0;
  }

  .preview-details {
    border-top: 1px solid var(--color-border-subtle);

    summary {
      padding: var(--space-4) var(--space-6);
    }
  }

  .details-content {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding-bottom: var(--space-2);

    .action-bar {
      display: flex;
      gap: var(--space-2);
      flex-wrap: wrap;

      :deep(.app-button) {
        display: flex;
        align-items: center;
        gap: var(--space-1);
      }
    }

    .info-item {
      display: flex;
      flex-direction: column;
      gap: var(--space-1);
      padding: var(--space-3);
      background: var(--color-bg-sunken);
      border-radius: var(--radius-md);
      border: 1px solid var(--color-border-subtle);

      .label {
        font-size: 11px;
        color: var(--color-text-muted);
      }

      .value {
        font-size: 12px;
        color: var(--color-text-secondary);
        font-family: monospace;

        &.path {
          word-break: break-all;
          user-select: text;
        }
      }
    }
  }

  .empty-selection {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;

    .empty-content {
      text-align: center;
      color: var(--color-text-muted);

      .empty-icon {
        font-size: 48px;
        margin-bottom: 16px;
        opacity: 0.2;
      }

      p {
        font-size: 12px;
        margin: 0;
      }
    }
  }
}
</style>
