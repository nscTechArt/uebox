<template>
  <div class="webdav-page">
    <WebdavHeader v-if="!isConnected" />
    <WebdavAuthForm v-if="!isConnected" />

    <!-- 已连接视图1 -->
    <div v-if="isConnected" class="content">
      <!-- 顶部工具栏 -->
      <div class="top-toolbar">
        <div class="breadcrumb-section">
          <AppButton :disabled="currentPath === '/'" size="small" @click="handleGoBack">
            <template #icon>
              <PhArrowLeft />
            </template>
          </AppButton>
          <div class="current-path">
            <PhHardDrives class="path-icon" />
            <div class="breadcrumb-list">
              <span
                class="breadcrumb-item"
                :class="{ active: currentPath === '/' }"
                @click="handleBreadcrumbClick('/')"
              >
                {{ $t('webdavPage.rootDir') }}
              </span>
              <template v-for="(part, index) in pathParts" :key="index">
                <span class="separator">/</span>
                <span
                  class="breadcrumb-item"
                  :class="{ active: index === pathParts.length - 1 }"
                  @click="handleBreadcrumbClick(part.fullPath)"
                >
                  {{ part.name }}
                </span>
              </template>
            </div>
            <AppButton variant="text" size="small" class="refresh-btn" @click="handleRefresh">
              <template #icon><PhArrowClockwise /></template>
            </AppButton>
          </div>
        </div>
        <div class="actions-section">
          <WebdavUserInfoCard />
        </div>
      </div>

      <WebdavFileList ref="fileListRef" @files-dropped="handleFilesDropped" />

      <!-- 悬浮上传按钮 -->
      <div class="floating-upload-btn">
        <div class="sub-actions">
          <AppTooltip :title="$t('webdavPage.uploadFolderTooltip')" placement="left">
            <AppButton
              variant="primary"
              shape="circle"
              size="large"
              class="sub-btn"
              @click="handleUploadFolder"
            >
              <template #icon><PhFolderPlus /></template>
            </AppButton>
          </AppTooltip>
          <AppTooltip :title="$t('webdavPage.uploadFilesTooltip')" placement="left">
            <AppButton
              variant="primary"
              shape="circle"
              size="large"
              class="sub-btn"
              @click="handleUploadFiles"
            >
              <template #icon><PhFilePlus /></template>
            </AppButton>
          </AppTooltip>
        </div>
        <AppButton variant="primary" shape="circle" size="large" class="upload-fab">
          <template #icon><PhCloudArrowUp /></template>
        </AppButton>
      </div>
    </div>

    <!-- 上传弹窗 -->
    <AppModal
      v-model:open="uploadModalOpen"
      :title="$t('webdavPage.uploadModalTitle')"
      width="680px"
      hide-footer
      destroy-on-close
    >
      <WebdavUploadPanel ref="uploadPanelRef" @uploaded="handleUploaded" />
    </AppModal>
  </div>
</template>

<script setup lang="ts">
import AppModal from '@renderer/components/AppModal.vue'
import AppTooltip from '@renderer/components/AppTooltip.vue'
import AppButton from '@renderer/components/AppButton.vue'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { message } from '@/utils/messageManager'
import { useWebdavStore } from '@renderer/store/modules/webdav'
import {
  PhArrowClockwise,
  PhArrowLeft,
  PhCloudArrowUp,
  PhFilePlus,
  PhFolderPlus,
  PhHardDrives
} from '@phosphor-icons/vue'
import WebdavHeader from './components/Webdav/WebdavHeader.vue'
import WebdavAuthForm from './components/Webdav/WebdavAuthForm.vue'
import WebdavUserInfoCard from './components/Webdav/WebdavUserInfoCard.vue'
import WebdavFileList from './components/Webdav/WebdavFileList.vue'
import WebdavUploadPanel from './components/Webdav/WebdavUploadPanel.vue'

/** WebdavFileList 通过 defineExpose 暴露给本页的方法 */
interface WebdavFileListExposed {
  uploadLocalPaths?: (paths: string[]) => void
  refresh?: () => void
}

/** WebdavUploadPanel 通过 defineExpose 暴露给本页的方法 */
interface WebdavUploadPanelExposed {
  uploadFiles: (files: File[]) => Promise<void>
}

const { t } = useI18n()
const webdavStore = useWebdavStore()
const fileListRef = ref<WebdavFileListExposed | null>(null)

/**
 * 是否已连接
 */
const isConnected = computed(() => webdavStore.isConnected)

/**
 * 当前路径
 */
const currentPath = computed(() => webdavStore.currentDir)

/**
 * 上传弹窗状态
 */
const uploadModalOpen = ref(false)

/**
 * 路径片段
 */
const pathParts = computed(() => {
  const parts = currentPath.value.split('/').filter(Boolean)
  let current = ''
  return parts.map((part) => {
    current += '/' + part
    return {
      name: part,
      fullPath: current
    }
  })
})

/**
 * 返回上级目录
 */
function handleGoBack(): void {
  const parts = currentPath.value.split('/').filter(Boolean)
  if (parts.length > 0) {
    parts.pop()
    const newPath = '/' + parts.join('/')
    webdavStore.setCurrentDir(newPath)
  }
}

/**
 * 面包屑点击
 */
function handleBreadcrumbClick(path: string): void {
  if (path !== currentPath.value) {
    webdavStore.setCurrentDir(path)
  }
}

/**
 * 上传文件夹：打开系统文件夹选择对话框
 */
async function handleUploadFolder(): Promise<void> {
  if (!isConnected.value) {
    message.error(t('webdavPage.connectServerFirst'))
    return
  }
  try {
    if (!window.api || !window.api.dialog) {
      message.error(t('webdavPage.dialogApiUnavailable'))
      return
    }
    const ret = await window.api.dialog.showOpenDialog({
      title: t('webdavPage.selectFolderDialogTitle'),
      properties: ['openDirectory', 'multiSelections']
    })
    if (!ret.canceled && ret.filePaths && ret.filePaths.length > 0) {
      // 触发文件列表组件的上传逻辑
      fileListRef.value?.uploadLocalPaths?.(ret.filePaths)
    }
  } catch (error) {
    console.error('选择文件夹失败:', error)
    message.error(t('webdavPage.openFolderDialogFailed', { message: (error as Error).message }))
  }
}

/**
 * 上传文件：打开系统文件选择对话框
 */
async function handleUploadFiles(): Promise<void> {
  if (!isConnected.value) {
    message.error(t('webdavPage.connectServerFirst'))
    return
  }
  try {
    if (!window.api || !window.api.dialog) {
      message.error(t('webdavPage.dialogApiUnavailable'))
      return
    }
    const ret = await window.api.dialog.showOpenDialog({
      title: t('webdavPage.selectFilesDialogTitle'),
      properties: ['openFile', 'multiSelections']
    })
    if (!ret.canceled && ret.filePaths && ret.filePaths.length > 0) {
      // 触发文件列表组件的上传逻辑
      fileListRef.value?.uploadLocalPaths?.(ret.filePaths)
    }
  } catch (error) {
    console.error('选择文件失败:', error)
    message.error(t('webdavPage.openFileDialogFailed', { message: (error as Error).message }))
  }
}

/**
 * 是否正在批量上传
 */
const isBatchUploading = ref(false)

/**
 * 上传完成回调（单个文件）
 */
function handleUploaded(): void {
  // 如果是批量上传过程中，不自动关闭，由 handleFilesDropped 统一处理
  if (isBatchUploading.value) {
    return
  }

  // 如果是手动上传（非批量），上传成功后刷新列表
  fileListRef.value?.refresh?.()
  // 手动上传通常由用户点击关闭，或者我们可以选择自动关闭
  // 这里保持不自动关闭，让用户看到结果
}

const uploadPanelRef = ref<WebdavUploadPanelExposed | null>(null)

/**
 * 处理拖拽文件
 */
async function handleFilesDropped(files: File[]): Promise<void> {
  if (!isConnected.value) {
    message.error(t('webdavPage.connectServerFirst'))
    return
  }

  uploadModalOpen.value = true
  isBatchUploading.value = true

  // 等待弹窗渲染
  setTimeout(async () => {
    if (uploadPanelRef.value) {
      try {
        await uploadPanelRef.value.uploadFiles(files)
        message.success(t('webdavPage.allFilesUploaded'))
        uploadModalOpen.value = false
        fileListRef.value?.refresh?.()
      } catch (error) {
        console.error('批量上传部分失败:', error)
      } finally {
        isBatchUploading.value = false
      }
    } else {
      isBatchUploading.value = false
    }
  }, 100)
}

/**
 * 刷新列表
 */
function handleRefresh(): void {
  fileListRef.value?.refresh?.()
}
</script>

<style scoped lang="less">
.webdav-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--color-bg-page);

  .content {
    width: 100%;
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    position: relative;

    .top-toolbar {
      min-height: 56px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 5px 16px;
      gap: 16px;
      border-bottom: 1px solid var(--color-border-subtle);
      background: var(--color-bg-surface);
      .app-button--default {
        width: 46px;
        height: 38px;
      }

      .breadcrumb-section {
        display: flex;
        align-items: center;
        gap: 12px;
        flex: 1;
        min-width: 0;

        .current-path {
          display: flex;
          align-items: center;
          gap: 8px;
          flex: 1;
          min-width: 0;
          padding: 6px 12px;
          background: var(--color-bg-page);
          border-radius: 6px;
          border: 1px solid var(--color-border-subtle);

          .path-icon {
            font-size: 14px;
            color: var(--color-accent-text);
            flex-shrink: 0;
          }

          .breadcrumb-list {
            display: flex;
            align-items: center;
            overflow: hidden;
            white-space: nowrap;

            .breadcrumb-item {
              font-size: 13px;
              color: var(--color-text-secondary);
              cursor: pointer;
              padding: 2px 4px;
              border-radius: 4px;
              transition: all 0.2s;

              &:hover {
                color: var(--color-accent-text);
                background: var(--color-bg-surface);
              }

              &.active {
                color: var(--color-text-primary);
                font-weight: 500;
                cursor: default;

                &:hover {
                  background: transparent;
                  color: var(--color-text-primary);
                }
              }
            }

            .separator {
              color: var(--color-text-muted);
              margin: 0 2px;
              font-size: 12px;
            }
          }

          .refresh-btn {
            color: var(--color-text-secondary);
            margin-left: auto;
            &:hover {
              color: var(--color-accent-text);
              background: var(--color-bg-surface);
            }
          }
        }
      }

      .actions-section {
        display: flex;
        align-items: center;
        gap: 12px;
        padding-right: 6px;
      }
    }

    .floating-upload-btn {
      position: absolute;
      bottom: 24px;
      right: 24px;
      z-index: 100;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 12px;

      .upload-fab {
        background-color: var(--color-bg-surface-hover) !important;
        border-color: var(--color-border) !important;
        width: 48px;
        height: 48px;
        font-size: 20px;
        box-shadow: 0 4px 12px var(--shadow-color);
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        z-index: 2;

        &:active {
          transform: scale(0.95);
        }
      }

      &:hover {
        .sub-actions {
          opacity: 1;
          transform: translateY(0);
          pointer-events: auto;
          visibility: visible;
        }

        .upload-fab {
          transform: rotate(45deg);
          background-color: var(--color-bg-surface-hover) !important;
          border-color: var(--color-border) !important;
        }
      }

      .sub-actions {
        display: flex;
        flex-direction: column;
        gap: 12px;
        opacity: 0;
        transform: translateY(20px);
        pointer-events: none;
        visibility: hidden;
        transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        padding-bottom: 8px;

        .sub-btn {
          width: 40px;
          height: 40px;
          font-size: 18px;
          box-shadow: 0 4px 12px var(--shadow-color-weak);
          transition: all 0.2s;
          background-color: var(--color-bg-surface-hover) !important;
          border-color: var(--color-border) !important;

          &:hover {
            transform: scale(1.1);
          }
        }
      }
    }
  }
}
</style>
