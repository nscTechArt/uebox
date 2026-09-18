<script setup lang="ts">
import AppProgress from '@renderer/components/AppProgress.vue'
import AppModal from '@renderer/components/AppModal.vue'
import AppButton from '@renderer/components/AppButton.vue'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  PhCheckCircle,
  PhCircleNotch,
  PhFile,
  PhFolder,
  PhTrash,
  PhUploadSimple,
  PhXCircle
} from '@phosphor-icons/vue'
import { message } from '@/utils/messageManager'
import assetDataAPI from '@renderer/api/assetData'
import assetFolderAPI from '@renderer/api/assetFolder'
import { useVaultStore } from '@renderer/store/modules/vaultStore'
import { resolveErrorText } from '../../utils/assetVaultHelpers'

defineProps<{
  open: boolean
}>()

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
  (e: 'done'): void
}>()

interface UploadItem {
  fileName: string
  filePath: string
  baseName: string
  status: 'pending' | 'matching' | 'matched' | 'processing' | 'done' | 'error'
  errorMsg?: string
  matchedFolder?: { folderKey: string; name: string }
  matchedAssets: Array<{
    assetKey: string
    assetName: string
    className?: string
    folderKey?: string
  }>
  savedFileName?: string
}

const { t } = useI18n()

const uploadItems = ref<UploadItem[]>([])
const isProcessing = ref(false)
const isSyncing = ref(false)
const repairProgressPercent = ref(0)
const repairProgressText = ref('')
const repairProgressDetail = ref('')
const repairProgressCurrent = ref(0)
const repairProgressTotal = ref(0)
const processedCount = ref(0)
const isDragOver = ref(false)
const assetPrefix = ref('')
const assetSuffix = ref('')
let dragCounter = 0
const vaultStore = useVaultStore()
const currentVault = computed(() => vaultStore.currentVault)
const imageExts = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.mp4', '.mov', '.webm']

const stripAssetExtension = (name: string): string => name.replace(/\.[^.]+$/, '')

const resolveAssetFolderKey = async (
  asset: UploadItem['matchedAssets'][number]
): Promise<string | null> => {
  if (asset.folderKey) return String(asset.folderKey)

  try {
    const row = await assetDataAPI.getById(asset.assetKey)
    return row?.folderKey ? String(row.folderKey) : null
  } catch (error) {
    console.warn(
      '[BatchThumbnailUploadModal] asset scope lookup failed:',
      error instanceof Error ? error.message : String(error)
    )
    return null
  }
}

const resetMatchState = (item: UploadItem): void => {
  item.status = 'pending'
  item.errorMsg = undefined
  item.matchedFolder = undefined
  item.matchedAssets = []
  item.savedFileName = undefined
}

const matchesFolderAsset = (assetName: string, baseName: string): boolean => {
  const normalizedName = stripAssetExtension(assetName || '')
  const prefix = assetPrefix.value.trim()
  const suffix = assetSuffix.value.trim()

  if (!prefix && !suffix) return true
  if (prefix && !normalizedName.startsWith(`${prefix}${baseName}`)) return false
  if (suffix && !normalizedName.endsWith(suffix)) return false
  return true
}

const matchesStandaloneAsset = (assetName: string, baseName: string): boolean => {
  const normalizedName = stripAssetExtension(assetName || '')
  const prefix = assetPrefix.value.trim()
  const suffix = assetSuffix.value.trim()

  if (!prefix && !suffix) {
    return normalizedName === baseName
  }

  if (prefix && !normalizedName.startsWith(`${prefix}${baseName}`)) return false
  if (suffix && !normalizedName.endsWith(suffix)) return false
  return true
}

const matchAll = async (): Promise<void> => {
  let allFolders: AssetFolder[] = []
  try {
    allFolders = await assetFolderAPI.getAll()
  } catch (err) {
    console.error('获取文件夹列表失败:', err)
    message.error(t('batchThumbnailUploadModal.messages.folderListFailed'))
    return
  }

  for (const item of uploadItems.value) {
    if (item.status !== 'pending') continue
    item.status = 'matching'

    const folder = allFolders.find((folderItem) => {
      return folderItem.folderName === item.baseName && !folderItem.isDelete
    })

    if (folder) {
      item.matchedFolder = { folderKey: folder.folderKey, name: folder.folderName }

      try {
        const assets = await assetDataAPI.getByFolderKeyRecursive(folder.folderKey)
        const matched = (assets || []).filter((asset) =>
          matchesFolderAsset(asset.assetName || '', item.baseName)
        )

        item.matchedAssets = matched.map((asset) => ({
          assetKey: asset.assetKey,
          assetName: asset.assetName,
          folderKey: asset.folderKey
        }))
        item.status = 'matched'
      } catch (err) {
        console.error('搜索文件夹内资产失败:', err)
        item.status = 'error'
        item.errorMsg = t('batchThumbnailUploadModal.messages.searchFolderAssetsFailed')
      }

      continue
    }

    try {
      const assets = await assetDataAPI.searchByName(item.baseName)
      const matched = (assets || []).filter((asset) => {
        return matchesStandaloneAsset(asset.assetName || '', item.baseName) && !asset.isDelete
      })

      if (matched.length === 0) {
        item.status = 'error'
        item.errorMsg = t('batchThumbnailUploadModal.messages.noFolderOrAssetFound', {
          name: item.baseName
        })
        continue
      }

      item.matchedAssets = matched.map((asset) => ({
        assetKey: asset.assetKey,
        assetName: asset.assetName,
        folderKey: asset.folderKey
      }))
      item.status = 'matched'
    } catch (err) {
      console.error('按名称搜索资产失败:', err)
      item.status = 'error'
      item.errorMsg = t('batchThumbnailUploadModal.messages.searchAssetsFailed')
    }
  }
}

const addUploadItem = (filePath: string): boolean => {
  const fileName = filePath.split(/[\\/]/).pop() || ''
  const ext = '.' + (fileName.split('.').pop() || '').toLowerCase()

  if (!imageExts.includes(ext)) {
    message.warning(t('batchThumbnailUploadModal.messages.unsupportedFormat', { name: fileName }))
    return false
  }

  const dotIdx = fileName.lastIndexOf('.')
  const baseName = dotIdx > 0 ? fileName.substring(0, dotIdx) : fileName

  if (uploadItems.value.some((item) => item.baseName === baseName)) {
    message.warning(t('batchThumbnailUploadModal.messages.alreadyInList', { name: fileName }))
    return false
  }

  uploadItems.value.push({
    fileName,
    filePath,
    baseName,
    status: 'pending',
    matchedAssets: []
  })

  return true
}

const handleSelectFiles = async (): Promise<void> => {
  try {
    const result = await (window as any).api.dialog.showOpenDialog({
      title: t('batchThumbnailUploadModal.messages.dialogSelectTitle'),
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: t('batchThumbnailUploadModal.messages.dialogFilterName'),
          extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'mp4', 'mov', 'webm']
        }
      ]
    })

    if (result?.canceled || !result?.filePaths?.length) return

    let hasNewItem = false
    for (const filePath of result.filePaths) {
      hasNewItem = addUploadItem(filePath) || hasNewItem
    }

    if (hasNewItem) {
      await matchAll()
    }
  } catch (error) {
    console.error('选择文件失败:', error)
    message.error(t('batchThumbnailUploadModal.messages.selectFilesFailed'))
  }
}

const handleDragEnter = (e: DragEvent): void => {
  e.preventDefault()
  dragCounter++
  if (e.dataTransfer?.types.includes('Files')) {
    isDragOver.value = true
  }
}

const handleDragLeave = (): void => {
  dragCounter--
  if (dragCounter === 0) {
    isDragOver.value = false
  }
}

const handleDragOver = (e: DragEvent): void => {
  e.preventDefault()
  if (e.dataTransfer) {
    e.dataTransfer.dropEffect = 'copy'
  }
}

const handleDrop = async (e: DragEvent): Promise<void> => {
  e.preventDefault()
  isDragOver.value = false
  dragCounter = 0

  const files = e.dataTransfer?.files
  if (!files?.length) return

  let hasNewItem = false
  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    let filePath = await (window as any).api.getPathForFile(file)
    if (!filePath) {
      filePath = (file as any).path
    }
    if (!filePath) continue

    hasNewItem = addUploadItem(filePath) || hasNewItem
  }

  if (hasNewItem) {
    await matchAll()
  }
}

const handleMatchRuleChange = async (): Promise<void> => {
  if (isProcessing.value || uploadItems.value.length === 0) return

  let shouldRematch = false
  for (const item of uploadItems.value) {
    if (item.status === 'processing' || item.status === 'done') continue
    resetMatchState(item)
    shouldRematch = true
  }

  if (shouldRematch) {
    await matchAll()
  }
}

const totalMatchedCount = computed(() => {
  let count = 0
  for (const item of uploadItems.value) {
    if (item.matchedFolder) {
      count++
    }
    count += item.matchedAssets.length
  }
  return count
})

const executableItemCount = computed(() => {
  return uploadItems.value.filter((item) => item.status !== 'pending' && item.status !== 'matching')
    .length
})

const progressPercent = computed(() => {
  if (executableItemCount.value === 0) return 0
  return Math.round((processedCount.value / executableItemCount.value) * 100)
})

const repairProgressVisible = computed(() => {
  return isSyncing.value || repairProgressText.value.length > 0
})

const progressDisplayPercent = computed(() => {
  if (isSyncing.value) return repairProgressPercent.value
  return progressPercent.value
})

const progressDisplayText = computed(() => {
  if (isSyncing.value) {
    if (repairProgressTotal.value > 0) {
      return `${repairProgressText.value} ${repairProgressCurrent.value} / ${repairProgressTotal.value}`
    }
    return repairProgressText.value
  }
  return `${processedCount.value} / ${executableItemCount.value}`
})

const progressDisplayDetail = computed(() => {
  if (isSyncing.value) return repairProgressDetail.value
  return ''
})

const canExecute = computed(() => {
  return !isProcessing.value && uploadItems.value.some((item) => item.status === 'matched')
})

const repairProgressHandler = (payload?: {
  phase?: string
  current?: number
  total?: number
  percent?: number
  message?: string
}): void => {
  repairProgressText.value = payload?.phase || t('batchThumbnailUploadModal.messages.repairing')
  repairProgressCurrent.value = payload?.current || 0
  repairProgressTotal.value = payload?.total || 0
  repairProgressPercent.value = Math.max(0, Math.min(100, payload?.percent || 0))
  repairProgressDetail.value = payload?.message || ''
}

let repairProgressListener: ((...args: unknown[]) => void) | null = null

onMounted(() => {
  repairProgressListener = (window as any).api.on(
    'asset:repairVaultThumbnailsProgress',
    repairProgressHandler
  )
})

onBeforeUnmount(() => {
  if (repairProgressListener) {
    ;(window as any).api.off('asset:repairVaultThumbnailsProgress', repairProgressListener)
    repairProgressListener = null
  }
})

const handleExecute = async (): Promise<void> => {
  if (isProcessing.value) return

  isProcessing.value = true
  processedCount.value = 0

  let successCount = 0
  let failCount = 0

  for (const item of uploadItems.value) {
    if (item.status !== 'matched') continue
    item.status = 'processing'

    try {
      const saveResult = await (window as any).api.asset.saveThumbnailFile(
        item.filePath,
        item.matchedFolder?.folderKey || item.baseName
      )
      if (!saveResult?.success || !saveResult.data) {
        throw new Error(
          saveResult?.error || t('batchThumbnailUploadModal.messages.saveThumbnailFailed')
        )
      }

      const savedFileName = saveResult.data
      item.savedFileName = savedFileName

      if (item.matchedFolder) {
        await assetFolderAPI.update(item.matchedFolder.folderKey, { img: savedFileName })
      }

      for (const asset of item.matchedAssets) {
        await assetDataAPI.update(asset.assetKey, { customPoster: savedFileName })
      }

      item.status = 'done'
      successCount++
    } catch (err: any) {
      console.error(`处理 ${item.baseName} 失败:`, err)
      item.status = 'error'
      item.errorMsg = resolveErrorText(
        err,
        err.message || t('batchThumbnailUploadModal.messages.processFailed')
      )
      failCount++
    }

    processedCount.value++
  }

  isProcessing.value = false
  message.success(
    t('batchThumbnailUploadModal.messages.processDone', {
      success: successCount,
      failed: failCount
    })
  )
  if (successCount > 0) {
    emit('done')
  }
}

const handleRepairVaultThumbnails = async (): Promise<void> => {
  if (isProcessing.value || isSyncing.value) return
  isSyncing.value = true
  repairProgressPercent.value = 0
  repairProgressText.value = t('batchThumbnailUploadModal.messages.repairPreparing')
  repairProgressDetail.value = t('batchThumbnailUploadModal.messages.repairCollecting')
  repairProgressCurrent.value = 0
  repairProgressTotal.value = 0
  try {
    const result = await (window as any).api.asset.syncCurrentVaultThumbnailsToRemote()
    if (!result?.success || !result.data) {
      throw new Error(result?.error || t('batchThumbnailUploadModal.messages.repairFailed'))
    }

    const stats = result.data as {
      scannedAssets: number
      scannedFolders: number
      regenerated: number
      updatedRecords: number
      uploadedOriginal: number
      uploadedThumb: number
      verifiedOriginal: number
      alreadyRemotePresent: number
      missingLocal: number
      failed: number
    }

    const summary = t('batchThumbnailUploadModal.messages.repairSummary', {
      scannedAssets: stats.scannedAssets,
      scannedFolders: stats.scannedFolders,
      regenerated: stats.regenerated,
      updatedRecords: stats.updatedRecords,
      uploadedOriginal: stats.uploadedOriginal,
      uploadedThumb: stats.uploadedThumb
    })

    if (stats.failed > 0 || stats.missingLocal > 0) {
      message.warning(
        t('batchThumbnailUploadModal.messages.repairSummaryWithIssues', {
          summary,
          alreadyRemotePresent: stats.alreadyRemotePresent,
          verifiedOriginal: stats.verifiedOriginal,
          missingLocal: stats.missingLocal,
          failed: stats.failed
        })
      )
    } else {
      message.success(
        t('batchThumbnailUploadModal.messages.repairSummarySuccess', {
          summary,
          alreadyRemotePresent: stats.alreadyRemotePresent,
          verifiedOriginal: stats.verifiedOriginal
        })
      )
    }

    emit('done')
  } catch (error: any) {
    console.error('修复资产库缩略图失败:', error)
    message.error(error?.message || t('batchThumbnailUploadModal.messages.repairFailed'))
  } finally {
    isSyncing.value = false
  }
}

const handleRemoveItem = (index: number): void => {
  if (isProcessing.value) return
  uploadItems.value.splice(index, 1)
}

const handleClear = (): void => {
  if (isProcessing.value) return
  uploadItems.value = []
}

const handleClose = (): void => {
  if (isProcessing.value) return
  emit('update:open', false)
}

const getStatusText = (item: UploadItem): string => {
  switch (item.status) {
    case 'pending':
      return t('batchThumbnailUploadModal.status.pending')
    case 'matching':
      return t('batchThumbnailUploadModal.status.matching')
    case 'matched': {
      const parts: string[] = []
      if (item.matchedFolder) {
        parts.push(t('batchThumbnailUploadModal.status.matchedFolder'))
      }
      if (item.matchedAssets.length > 0) {
        parts.push(
          t('batchThumbnailUploadModal.status.matchedAssetsCount', {
            count: item.matchedAssets.length
          })
        )
      }
      return t('batchThumbnailUploadModal.status.matchedPrefix', { parts: parts.join(' + ') })
    }
    case 'processing':
      return t('batchThumbnailUploadModal.status.processing')
    case 'done':
      return t('batchThumbnailUploadModal.status.done')
    case 'error':
      return item.errorMsg || t('batchThumbnailUploadModal.status.error')
    default:
      return ''
  }
}

const getStatusColor = (item: UploadItem): string => {
  switch (item.status) {
    case 'matched':
    case 'done':
      return 'var(--color-success-text)'
    case 'error':
      return 'var(--color-danger-text)'
    case 'processing':
    case 'matching':
      return 'var(--color-accent-text)'
    default:
      return 'var(--color-text-muted)'
  }
}
</script>

<template>
  <AppModal
    :open="open"
    :title="$t('batchThumbnailUploadModal.title')"
    width="720px"
    :mask-closable="!isProcessing"
    :closable="!isProcessing"
    :keyboard="!isProcessing"
    @cancel="handleClose"
  >
    <div class="batch-thumbnail-upload">
      <div
        class="upload-zone"
        :class="{ 'drag-over': isDragOver }"
        @dragenter="handleDragEnter"
        @dragleave="handleDragLeave"
        @dragover="handleDragOver"
        @drop="handleDrop"
        @click="handleSelectFiles"
      >
        <PhUploadSimple class="upload-icon" />
        <div class="upload-text">{{ $t('batchThumbnailUploadModal.uploadZone.text') }}</div>
        <div class="upload-hint">
          {{ $t('batchThumbnailUploadModal.uploadZone.hint') }}
        </div>
      </div>

      <div class="match-rule-row">
        <div class="match-rule-group">
          <span class="match-rule-label">{{
            $t('batchThumbnailUploadModal.matchRule.prefixLabel')
          }}</span>
          <a-input
            v-model:value="assetPrefix"
            allow-clear
            class="rule-input"
            size="small"
            :placeholder="$t('batchThumbnailUploadModal.matchRule.prefixPlaceholder')"
            :disabled="isProcessing"
            @blur="handleMatchRuleChange"
            @press-enter="handleMatchRuleChange"
          />
        </div>
        <div class="match-rule-group">
          <span class="match-rule-label">{{
            $t('batchThumbnailUploadModal.matchRule.suffixLabel')
          }}</span>
          <a-input
            v-model:value="assetSuffix"
            allow-clear
            class="rule-input"
            size="small"
            :placeholder="$t('batchThumbnailUploadModal.matchRule.suffixPlaceholder')"
            :disabled="isProcessing"
            @blur="handleMatchRuleChange"
            @press-enter="handleMatchRuleChange"
          />
        </div>
        <span class="match-rule-hint">{{ $t('batchThumbnailUploadModal.matchRule.hint') }}</span>
      </div>

      <div v-if="uploadItems.length > 0" class="file-list">
        <div class="list-header">
          <span class="list-title">{{
            $t('batchThumbnailUploadModal.list.title', { count: uploadItems.length })
          }}</span>
          <AppButton v-if="!isProcessing" variant="link" size="small" danger @click="handleClear">
            {{ $t('batchThumbnailUploadModal.list.clear') }}
          </AppButton>
        </div>

        <div class="list-body">
          <div
            v-for="(item, index) in uploadItems"
            :key="item.baseName"
            class="file-item"
            :class="{ 'is-done': item.status === 'done', 'is-error': item.status === 'error' }"
          >
            <div class="file-item-main">
              <div class="file-name-row">
                <span class="file-name">{{ item.fileName }}</span>
                <AppButton
                  v-if="!isProcessing"
                  variant="text"
                  size="small"
                  class="remove-btn"
                  @click="handleRemoveItem(index)"
                >
                  <template #icon><PhTrash /></template>
                </AppButton>
              </div>

              <div class="match-info" :style="{ color: getStatusColor(item) }">
                <PhCircleNotch
                  v-if="item.status === 'matching' || item.status === 'processing'"
                  class="icon-spin"
                  style="margin-right: 4px"
                />
                <PhCheckCircle
                  v-else-if="item.status === 'done'"
                  weight="fill"
                  style="margin-right: 4px"
                />
                <PhXCircle
                  v-else-if="item.status === 'error'"
                  weight="fill"
                  style="margin-right: 4px"
                />
                {{ getStatusText(item) }}
              </div>

              <div v-if="item.matchedFolder || item.matchedAssets.length > 0" class="match-details">
                <div v-if="item.matchedFolder" class="match-detail-row">
                  <PhFolder style="color: var(--color-folder); margin-right: 4px" />
                  <span class="match-label">{{
                    $t('batchThumbnailUploadModal.list.folderLabel')
                  }}</span>
                  <span class="match-value">{{ item.matchedFolder.name }}</span>
                </div>
                <div
                  v-for="asset in item.matchedAssets"
                  :key="asset.assetKey"
                  class="match-detail-row"
                >
                  <PhFile style="color: var(--color-filetype-unknown); margin-right: 4px" />
                  <span class="match-label">{{
                    $t('batchThumbnailUploadModal.list.assetLabel')
                  }}</span>
                  <span class="match-value">{{ asset.assetName }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div v-if="isProcessing || repairProgressVisible" class="progress-section">
        <AppProgress :percent="progressDisplayPercent" />
        <span class="progress-text">{{ progressDisplayText }}</span>
        <span v-if="progressDisplayDetail" class="progress-detail">{{
          progressDisplayDetail
        }}</span>
      </div>
    </div>

    <template #footer>
      <div class="modal-footer">
        <div class="modal-footer-left">
          <AppButton
            :disabled="isProcessing || isSyncing"
            :loading="isSyncing"
            @click="handleRepairVaultThumbnails"
          >
            {{
              isSyncing
                ? $t('batchThumbnailUploadModal.footer.repairing')
                : $t('batchThumbnailUploadModal.footer.repairButton')
            }}
          </AppButton>
        </div>
        <div class="modal-footer-right">
          <AppButton :disabled="isProcessing || isSyncing" @click="handleClose">{{
            $t('batchThumbnailUploadModal.footer.close')
          }}</AppButton>
          <AppButton
            variant="primary"
            :disabled="!canExecute || isSyncing"
            :loading="isProcessing"
            @click="handleExecute"
          >
            {{
              isProcessing
                ? $t('batchThumbnailUploadModal.footer.processing')
                : $t('batchThumbnailUploadModal.footer.execute', { count: totalMatchedCount })
            }}
          </AppButton>
        </div>
      </div>
    </template>
  </AppModal>
</template>

<style scoped>
.batch-thumbnail-upload {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.modal-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
}

.modal-footer-left,
.modal-footer-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.upload-zone {
  border: 2px dashed var(--color-border, var(--color-border-strong));
  border-radius: 8px;
  padding: 32px 16px;
  text-align: center;
  cursor: pointer;
  transition: all 0.3s;
}

.upload-zone:hover,
.upload-zone.drag-over {
  border-color: var(--color-accent-border);
  background: var(--color-accent-bg);
}

.upload-icon {
  font-size: 40px;
  color: var(--color-accent-text);
  margin-bottom: 8px;
}

.upload-text {
  font-size: 15px;
  color: var(--color-text-primary);
  margin-bottom: 4px;
}

.upload-hint {
  font-size: 12px;
  color: var(--color-text-secondary);
}

.match-rule-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 16px;
  padding: 8px 12px;
  border-radius: 6px;
}

.match-rule-group {
  display: flex;
  align-items: center;
  gap: 8px;
}

.match-rule-label {
  font-size: 13px;
  color: var(--color-text-primary);
  flex-shrink: 0;
  font-weight: 500;
}

.rule-input {
  width: 180px;
}

.match-rule-hint {
  font-size: 12px;
  color: var(--color-text-muted);
  flex-shrink: 0;
}

.file-list {
  border: 1px solid var(--color-border, var(--color-border-strong));
  border-radius: 8px;
  overflow: hidden;
}

.list-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: var(--color-bg-page);
  border-bottom: 1px solid var(--color-border, var(--color-border-strong));
}

.list-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text-primary);
}

.list-body {
  max-height: 360px;
  overflow-y: auto;
}

.file-item {
  padding: 10px 12px;
  border-bottom: 1px solid var(--color-border, var(--color-border-strong));
  transition: background 0.2s;
}

.file-item:last-child {
  border-bottom: none;
}

.file-item:hover {
  background: var(--color-bg-surface);
}

.file-item.is-done {
  background: var(--color-success-bg);
}

.file-item.is-error {
  background: var(--color-danger-bg);
}

.file-item-main {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.file-name-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.file-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--color-text-primary);
}

.remove-btn {
  opacity: 0.5;
  transition: opacity 0.2s;
}

.file-item:hover .remove-btn {
  opacity: 1;
}

.match-info {
  font-size: 12px;
  display: flex;
  align-items: center;
}

.match-details {
  margin-top: 4px;
  padding: 6px 8px;
  background: var(--color-bg-page);
  border-radius: 4px;
}

.match-detail-row {
  display: flex;
  align-items: center;
  font-size: 12px;
  color: var(--color-text-secondary);
  line-height: 22px;
}

.match-label {
  margin-right: 4px;
  color: var(--color-text-muted);
  flex-shrink: 0;
}

.match-value {
  color: var(--color-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.progress-section {
  display: flex;
  align-items: center;
  gap: 12px;
}

.progress-section :deep(.app-progress) {
  flex: 1;
}

.progress-text {
  font-size: 13px;
  color: var(--color-text-secondary);
  flex-shrink: 0;
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.progress-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.progress-text {
  font-size: 12px;
  color: var(--color-text-primary);
}

.progress-detail {
  font-size: 12px;
  color: var(--color-text-secondary);
  word-break: break-all;
}
</style>
