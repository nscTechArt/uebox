<template>
  <div class="baiduyun-page">
    <BaiduyunAuthForm v-if="!isAuthenticated" />

    <!-- 已连接视图 -->
    <div v-if="isAuthenticated" class="content">
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
                {{ t('assetLib.baiduyun.toolbar.root') }}
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
          <div class="search-controls">
            <a-input
              v-model:value="searchKey"
              :placeholder="t('assetLib.baiduyun.toolbar.searchPlaceholder')"
              class="search-input"
              allow-clear
              @input="handleSearchDebounced"
              @press-enter="handleSearchImmediate"
            >
              <template #prefix>
                <PhMagnifyingGlass />
              </template>
            </a-input>
          </div>
          <AppDropdown>
            <AppButton class="icon-btn active">
              <template #icon><PhSortAscending /></template>
              <span class="sort-text">{{ currentSortLabel }}</span>
            </AppButton>
            <template #overlay>
              <AppMenu :selected-keys="[currentSortKey]" @click="handleSortClick">
                <AppMenuItem key="name-asc" item-key="name-asc">{{
                  t('assetLib.baiduyun.toolbar.sort.nameAsc')
                }}</AppMenuItem>
                <AppMenuItem key="name-desc" item-key="name-desc">{{
                  t('assetLib.baiduyun.toolbar.sort.nameDesc')
                }}</AppMenuItem>
                <AppMenuItem key="time-asc" item-key="time-asc">{{
                  t('assetLib.baiduyun.toolbar.sort.timeAsc')
                }}</AppMenuItem>
                <AppMenuItem key="time-desc" item-key="time-desc">{{
                  t('assetLib.baiduyun.toolbar.sort.timeDesc')
                }}</AppMenuItem>
                <AppMenuItem key="size-asc" item-key="size-asc">{{
                  t('assetLib.baiduyun.toolbar.sort.sizeAsc')
                }}</AppMenuItem>
                <AppMenuItem key="size-desc" item-key="size-desc">{{
                  t('assetLib.baiduyun.toolbar.sort.sizeDesc')
                }}</AppMenuItem>
              </AppMenu>
            </template>
          </AppDropdown>
          <BaiduyunUserInfoCard />
        </div>
      </div>

      <div class="main-layout">
        <div class="file-list-container">
          <BaiduyunFileList ref="fileListRef" @selection-change="handleSelectionChange" />
        </div>
        <div class="details-panel-container">
          <BaiduyunDetailsPanel :file="selectedFile" @close="selectedFile = null" />
        </div>
      </div>

      <!-- 悬浮上传按钮 -->
      <div class="floating-upload-btn">
        <div class="sub-actions">
          <AppTooltip :title="t('assetLib.baiduyun.upload.folder')" placement="left">
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
          <AppTooltip :title="t('assetLib.baiduyun.upload.file')" placement="left">
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
      :title="t('assetLib.baiduyun.upload.title')"
      width="680px"
      hide-footer
      destroy-on-close
    >
      <BaiduyunUploadPanel @uploaded="handleUploaded" />
    </AppModal>
  </div>
</template>

<script setup lang="ts">
import AppDropdown from '@renderer/components/AppDropdown.vue'
import AppMenu from '@renderer/components/AppMenu.vue'
import AppMenuItem from '@renderer/components/AppMenuItem.vue'
import AppModal from '@renderer/components/AppModal.vue'
import AppTooltip from '@renderer/components/AppTooltip.vue'
import AppButton from '@renderer/components/AppButton.vue'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { message } from '@/utils/messageManager'
import {
  PhArrowClockwise,
  PhArrowLeft,
  PhCloudArrowUp,
  PhFilePlus,
  PhFolderPlus,
  PhHardDrives,
  PhMagnifyingGlass,
  PhSortAscending
} from '@phosphor-icons/vue'
import { useBaiduyunStore } from '@renderer/store/modules/baiduyun'
import BaiduyunAuthForm from './components/Baiduyun/BaiduyunAuthForm.vue'
import BaiduyunUserInfoCard from './components/Baiduyun/BaiduyunUserInfoCard.vue'
import BaiduyunFileList from './components/Baiduyun/BaiduyunFileList.vue'
import BaiduyunUploadPanel from './components/Baiduyun/BaiduyunUploadPanel.vue'
import BaiduyunDetailsPanel from './components/Baiduyun/BaiduyunDetailsPanel.vue'
import type { BaiduFileItem } from '@renderer/api-services/baiduYunApi'

/** BaiduyunFileList 通过 defineExpose 暴露给本页的方法 */
interface BaiduyunFileListExposed {
  uploadLocalPaths?: (paths: string[]) => void
  refresh?: () => void
  search?: (keyword: string) => void
  sort?: (order: 'name' | 'time' | 'size', desc: number) => void
}

const { t } = useI18n()
const baiduyunStore = useBaiduyunStore()
const fileListRef = ref<BaiduyunFileListExposed | null>(null)
const selectedFile = ref<BaiduFileItem | null>(null)

// 排序状态
const currentSortKey = ref('name-asc')
const sortLabels = computed<Record<string, string>>(() => ({
  'name-asc': t('assetLib.baiduyun.toolbar.sort.nameAsc'),
  'name-desc': t('assetLib.baiduyun.toolbar.sort.nameDesc'),
  'time-asc': t('assetLib.baiduyun.toolbar.sort.timeAsc'),
  'time-desc': t('assetLib.baiduyun.toolbar.sort.timeDesc'),
  'size-asc': t('assetLib.baiduyun.toolbar.sort.sizeAsc'),
  'size-desc': t('assetLib.baiduyun.toolbar.sort.sizeDesc')
}))
const currentSortLabel = computed(() => sortLabels.value[currentSortKey.value] || '')

function handleSelectionChange(items: BaiduFileItem[]): void {
  if (items.length === 1) {
    selectedFile.value = items[0]
  } else {
    selectedFile.value = null
  }
}

/**
 * 是否已授权
 */
const isAuthenticated = computed(() => baiduyunStore.isAuthenticated && !baiduyunStore.isExpired)

/**
 * 当前路径
 */
const currentPath = computed(() => baiduyunStore.currentDir)

/**
 * 上传弹窗状态
 */
const uploadModalOpen = ref(false)

/**
 * 搜索关键字
 */
const searchKey = ref('')

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
    baiduyunStore.setCurrentDir(newPath)
  }
}

/**
 * 面包屑点击
 */
function handleBreadcrumbClick(path: string): void {
  if (path !== currentPath.value) {
    baiduyunStore.setCurrentDir(path)
  }
}

/**
 * 上传文件夹：打开系统文件夹选择对话框
 */
async function handleUploadFolder(): Promise<void> {
  if (!isAuthenticated.value) {
    message.error(t('assetLib.baiduyun.upload.error.auth'))
    return
  }
  try {
    if (!window.api || !window.api.dialog) {
      message.error(t('assetLib.baiduyun.upload.error.api'))
      return
    }
    const ret = await window.api.dialog.showOpenDialog({
      title: t('assetLib.baiduyun.upload.folderTitle'),
      properties: ['openDirectory', 'multiSelections']
    })
    if (!ret.canceled && ret.filePaths && ret.filePaths.length > 0) {
      // 触发文件列表组件的上传逻辑
      fileListRef.value?.uploadLocalPaths?.(ret.filePaths)
    }
  } catch (error) {
    console.error('选择文件夹失败:', error)
    message.error(t('assetLib.baiduyun.upload.error.folder'))
  }
}

/**
 * 上传文件：打开系统文件选择对话框
 */
async function handleUploadFiles(): Promise<void> {
  if (!isAuthenticated.value) {
    message.error(t('assetLib.baiduyun.upload.error.auth'))
    return
  }
  try {
    if (!window.api || !window.api.dialog) {
      message.error(t('assetLib.baiduyun.upload.error.api'))
      return
    }
    const ret = await window.api.dialog.showOpenDialog({
      title: t('assetLib.baiduyun.upload.fileTitle'),
      properties: ['openFile', 'multiSelections']
    })
    if (!ret.canceled && ret.filePaths && ret.filePaths.length > 0) {
      // 触发文件列表组件的上传逻辑
      fileListRef.value?.uploadLocalPaths?.(ret.filePaths)
    }
  } catch (error) {
    console.error('选择文件失败:', error)
    message.error(t('assetLib.baiduyun.upload.error.file'))
  }
}

/**
 * 上传完成回调
 */
function handleUploaded(): void {
  fileListRef.value?.refresh?.()
  // uploadModalOpen.value = false // 可选：上传完成后是否自动关闭
}

/**
 * 刷新列表
 */
function handleRefresh(): void {
  fileListRef.value?.refresh?.()
}

/**
 * 搜索
 */
let searchTimer: ReturnType<typeof setTimeout> | null = null

function handleSearchDebounced(): void {
  if (searchTimer) {
    clearTimeout(searchTimer)
  }
  searchTimer = setTimeout(() => {
    fileListRef.value?.search?.(searchKey.value)
  }, 300)
}

function handleSearchImmediate(): void {
  if (searchTimer) {
    clearTimeout(searchTimer)
    searchTimer = null
  }
  fileListRef.value?.search?.(searchKey.value)
}

function handleSortClick({ key }: { key: string }): void {
  currentSortKey.value = key
  const [order, direction] = key.split('-')
  const desc = direction === 'desc' ? 1 : 0
  fileListRef.value?.sort?.(order as 'name' | 'time' | 'size', desc)
}
</script>

<style scoped lang="less">
.baiduyun-page {
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

    .main-layout {
      flex: 1;
      display: flex;
      overflow: hidden;
    }

    .file-list-container {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .details-panel-container {
      width: 320px;
      flex-shrink: 0;
      border-left: 1px solid var(--color-border-subtle);
      background: var(--color-bg-surface);
      display: flex;
      flex-direction: column;
    }

    .top-toolbar {
      min-height: 56px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6.5px 16px;
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

        .icon-btn {
          width: auto;
          min-width: 32px;
          height: 32px;
          padding: 0 4px;
          display: flex;
          align-items: center;
          justify-content: center;
          border: none;
          background: transparent;
          color: var(--color-text-secondary);
          gap: 4px;
          border-radius: 4px;
          transition: all 0.2s;

          &:hover {
            background: var(--color-bg-surface-hover);
          }

          &.active {
            background: var(--color-bg-selected);
            color: var(--color-text-selected);
          }

          .sort-text {
            font-size: 12px;
            white-space: nowrap;
          }
        }

        .search-controls {
          width: 280px;
          flex-shrink: 0;

          .search-input {
            width: 100%;

            :deep(.ant-input-affix-wrapper) {
              height: 32px;
              border-radius: 4px;
              border: 1px solid var(--color-border-subtle);
              background: var(--color-bg-page);
              padding: 4px 11px;

              &:hover {
                border-color: var(--color-border);
                background: var(--color-bg-surface-hover);
              }

              &:focus,
              &.ant-input-affix-wrapper-focused {
                border-color: var(--color-border);
                box-shadow: 0 0 0 2px var(--color-accent-border);
              }

              .ant-input {
                background: transparent;
                color: var(--color-text-primary);

                &::placeholder {
                  color: var(--color-text-muted);
                }
              }

              .ant-input-prefix {
                color: var(--color-text-muted);
                margin-right: 8px;
              }

              .ant-input-clear-icon {
                color: var(--color-text-muted);

                &:hover {
                  color: var(--color-text-secondary);
                }
              }
            }
          }
        }
      }
    }

    .floating-upload-btn {
      position: absolute;
      bottom: 24px;
      right: 344px;
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
