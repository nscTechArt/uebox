<script setup lang="ts">
import AppDropdown from '@renderer/components/AppDropdown.vue'
import AppMenu from '@renderer/components/AppMenu.vue'
import AppMenuItem from '@renderer/components/AppMenuItem.vue'
import AppModal from '@renderer/components/AppModal.vue'
import AppButton from '@renderer/components/AppButton.vue'
import AppPageSkeleton from '@renderer/components/AppPageSkeleton.vue'
import { ref, onMounted, onActivated, computed } from 'vue'
import { useRouter } from 'vue-router'
import {
  PhCircleNotch,
  PhDotsThree,
  PhFileText,
  PhImage,
  PhPencilSimple,
  PhPlus,
  PhTrash
} from '@phosphor-icons/vue'
import dayjs from 'dayjs'
import { useI18n } from 'vue-i18n'
import { useInitialLoading } from '@renderer/composables/useInitialLoading'
import { message } from '@renderer/utils/messageManager'
import { confirmDialog } from '@renderer/utils/dialog'
import { useStudioOutputStore } from '@renderer/store/modules/studioOutputStore'
import { buildNotebookDetailRoute } from '@renderer/views/Notebook/utils/notebookTabRoute'

const { t } = useI18n()
const router = useRouter()
const studioOutputStore = useStudioOutputStore()

/**
 * 知识库数据接口
 */
interface Notebook {
  id: string
  title: string
  updatedAt: number
  createdAt: number
  sourceCount: number
  coverStyle: string
  /** 自定义封面图片路径 */
  coverImage?: string
  role: 'Owner' | 'Editor' | 'Viewer'
}

const notebooks = ref<Notebook[]>([])
const loading = ref(true)
const initialLoading = useInitialLoading(
  () => loading.value,
  () => notebooks.value.length > 0
)
const activeCategory = ref('all')
const viewMode = ref<'grid' | 'list'>('grid')
const sortType = ref(['recent'])

/** 重命名对话框状态 */
const renameModalVisible = ref(false)
const renameNotebookId = ref('')
const renameTitle = ref('')

/** 正在加载的知识库 ID */
const loadingNotebookId = ref<string | null>(null)

/**
 * 渐变背景色列表
 */
const GRADIENTS = [
  'linear-gradient(135deg, #4b354f 0%, #2a2a35 100%)',
  'linear-gradient(135deg, #2c3e50 0%, #3498db 100%)',
  'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
  'linear-gradient(135deg, #0f0c29 0%, #302b63 50%, #24243e 100%)',
  'linear-gradient(135deg, #232526 0%, #414345 100%)',
  'linear-gradient(135deg, #3a1c71 0%, #d76d77 50%, #ffaf7b 100%)',
  'linear-gradient(135deg, #134e5e 0%, #71b280 100%)'
]

/**
 * 生成随机渐变背景色
 */
const generateCoverStyle = (): string => {
  return `background: ${GRADIENTS[Math.floor(Math.random() * GRADIENTS.length)]}`
}

const getFallbackCoverStyle = (notebookId: string, coverStyle?: string | null): string => {
  if (coverStyle) {
    return coverStyle
  }

  let hash = 0
  for (const char of notebookId) {
    hash = (hash * 31 + char.charCodeAt(0)) | 0
  }

  return `background: ${GRADIENTS[Math.abs(hash) % GRADIENTS.length]}`
}

/**
 * 加载知识库列表
 */
const loadNotebooks = async (): Promise<void> => {
  loading.value = true
  try {
    const list = await window.api.notebook.list()
    console.log(
      '[loadNotebooks] API 返回数据:',
      list.map((n) => ({ id: n.notebookId, coverImage: n.coverImage ? '有' : '无' }))
    )
    notebooks.value = list.map((item) => {
      const coverStyle = getFallbackCoverStyle(item.notebookId, item.coverStyle)

      return {
        id: item.notebookId,
        title: item.title,
        updatedAt: item.updatedAt ? new Date(item.updatedAt).getTime() : Date.now(),
        createdAt: item.createdAt ? new Date(item.createdAt).getTime() : Date.now(),
        sourceCount: item.sourceCount || 0,
        coverStyle,
        coverImage: item.coverImage || undefined,
        role: 'Owner' as const
      }
    })
  } catch (error) {
    console.error('加载知识库列表失败:', error)
    message.error(t('notebook.list.loadFailed'))
  } finally {
    loading.value = false
  }
}

/**
 * 排序后的知识库列表
 */
const sortedNotebooks = computed(() => {
  const list = [...notebooks.value]
  if (sortType.value[0] === 'recent') {
    return list.sort((a, b) => b.updatedAt - a.updatedAt)
  } else {
    return list.sort((a, b) => a.title.localeCompare(b.title))
  }
})

/**
 * 创建新知识库（创建时生成并保存 coverStyle）
 */
const handleCreateNotebook = async (): Promise<void> => {
  try {
    const coverStyle = generateCoverStyle()
    const notebookId = await window.api.notebook.create({
      title: t('notebook.detail.newNotebook'),
      coverStyle
    })
    message.success(t('notebook.list.createSuccess'))
    // 刷新列表以显示新创建的知识库
    await loadNotebooks()
    // 然后跳转到详情页
    router.push(buildNotebookDetailRoute(notebookId))
  } catch (error) {
    console.error('创建知识库失败:', error)
    message.error(t('notebook.list.createFailed'))
  }
}

/**
 * 打开知识库详情
 * 设置 loading 状态以提供用户反馈
 */
const handleOpenNotebook = (id: string): void => {
  loadingNotebookId.value = id
  router.push(buildNotebookDetailRoute(id))
}

/**
 * 处理更多按钮菜单点击
 */
const handleMenuClick = (key: string, notebook: Notebook): void => {
  if (key === 'delete') {
    handleDeleteNotebook(notebook.id, notebook.title)
  } else if (key === 'rename') {
    renameNotebookId.value = notebook.id
    renameTitle.value = notebook.title
    renameModalVisible.value = true
  } else if (key === 'cover') {
    handleUploadCover(notebook.id)
  }
}

/**
 * 确认重命名
 */
const handleRenameConfirm = async (): Promise<void> => {
  if (!renameTitle.value.trim()) {
    message.warning(t('notebook.list.renameEmpty'))
    return
  }
  try {
    await window.api.notebook.update(renameNotebookId.value, {
      title: renameTitle.value.trim()
    })
    message.success(t('notebook.list.renameSuccess'))
    renameModalVisible.value = false
    await loadNotebooks()
  } catch (error) {
    console.error('重命名失败:', error)
    message.error(t('notebook.list.renameFailed'))
  }
}

/**
 * 删除知识库
 */
const handleDeleteNotebook = (id: string, title: string): void => {
  confirmDialog({
    title: t('notebook.list.deleteTitle'),
    content: t('notebook.list.deleteConfirm', { title }),
    okText: t('common.delete'),
    danger: true,
    cancelText: t('common.cancel'),
    async onOk() {
      try {
        await window.api.notebook.delete(id)
        studioOutputStore.clearOutputs(id)
        message.success(t('notebook.list.deleteSuccess'))
        await loadNotebooks()
      } catch (error) {
        console.error('删除知识库失败:', error)
        message.error(t('notebook.list.deleteFailed'))
      }
    }
  })
}

/**
 * 格式化日期
 */
const formatDate = (timestamp: number): string => {
  return dayjs(timestamp).format('YYYY年M月D日')
}

/**
 * 获取知识库的产出数量
 */
const getOutputCount = (notebookId: string): number => {
  return studioOutputStore.getOutputs(notebookId).length
}

/** 待上传封面的知识库 ID */
const pendingCoverNotebookId = ref<string | null>(null)

/**
 * 处理上传封面
 */
const handleUploadCover = (notebookId: string): void => {
  pendingCoverNotebookId.value = notebookId
  // 触发隐藏的 file input
  const input = document.getElementById('cover-upload-input') as HTMLInputElement
  if (input) {
    input.click()
  }
}

/**
 * 处理封面文件选择
 */
const handleCoverFileChange = async (event: Event): Promise<void> => {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  const notebookId = pendingCoverNotebookId.value

  // 重置 input
  input.value = ''

  if (!file || !notebookId) {
    return
  }

  // 检查文件类型
  if (!file.type.startsWith('image/')) {
    message.error(t('notebook.list.pickImageFile'))
    return
  }

  // 检查文件大小（5MB 限制）
  if (file.size > 5 * 1024 * 1024) {
    message.error(t('notebook.list.coverTooLarge'))
    return
  }

  try {
    // 读取文件为 Base64（使用 Promise 包装）
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = () => reject(new Error('读取图片失败'))
      reader.readAsDataURL(file)
    })

    console.log('[Cover Upload] Base64 长度:', base64.length, '开头:', base64.substring(0, 50))

    // 保存到数据库
    const result = await window.api.notebook.update(notebookId, {
      coverImage: base64
    })
    console.log('[Cover Upload] 更新结果:', result)

    message.success(t('notebook.list.coverUpdated'))

    // 刷新列表
    console.log('[Cover Upload] 刷新列表...')
    await loadNotebooks()
    console.log(
      '[Cover Upload] notebooks 数据:',
      notebooks.value.map((n) => ({ id: n.id, coverImage: n.coverImage?.substring(0, 30) }))
    )
    pendingCoverNotebookId.value = null
  } catch (error) {
    console.error('上传封面失败:', error)
    message.error(t('notebook.list.coverUploadFailed'))
  }
}

/**
 * 获取封面样式
 * 优先使用自定义图片，否则使用渐变背景
 */
const getCoverStyle = (notebook: Notebook): string => {
  if (notebook.coverImage) {
    return `background-image: url(${notebook.coverImage}); background-size: cover; background-position: center;`
  }
  return notebook.coverStyle
}

// 组件挂载时加载数据
onMounted(() => {
  loadNotebooks()
})

// 组件从缓存中激活时刷新数据并清除loading状态
onActivated(() => {
  loadingNotebookId.value = null
  loadNotebooks()
})
</script>

<template>
  <div class="notebook-list-page">
    <!-- Header Area -->
    <div class="gallery-header">
      <!-- 左侧页面标题 -->
      <div class="header-title">
        <h1>{{ t('menu.notebooks') }}</h1>
      </div>

      <!-- 右侧操作区 -->
      <div class="header-actions">
        <!-- 岛屿 A: 视图与排序 -->
        <div class="action-island view-island">
          <div class="view-toggle">
            <button
              class="toggle-btn"
              :class="{ active: viewMode === 'grid' }"
              :title="t('notebook.list.viewGrid')"
              @click="viewMode = 'grid'"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <rect x="1" y="1" width="6" height="6" rx="1.5" fill="currentColor" />
                <rect x="9" y="1" width="6" height="6" rx="1.5" fill="currentColor" />
                <rect x="1" y="9" width="6" height="6" rx="1.5" fill="currentColor" />
                <rect x="9" y="9" width="6" height="6" rx="1.5" fill="currentColor" />
              </svg>
            </button>
            <button
              class="toggle-btn"
              :class="{ active: viewMode === 'list' }"
              :title="t('notebook.list.viewList')"
              @click="viewMode = 'list'"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <rect x="1" y="2" width="14" height="2.5" rx="1" fill="currentColor" />
                <rect x="1" y="6.75" width="14" height="2.5" rx="1" fill="currentColor" />
                <rect x="1" y="11.5" width="14" height="2.5" rx="1" fill="currentColor" />
              </svg>
            </button>
          </div>

          <div class="divider"></div>

          <div class="custom-select-wrapper">
            <select v-model="sortType[0]" class="minimal-select">
              <option value="recent">{{ t('notebook.list.sortRecent') }}</option>
              <option value="alpha">{{ t('notebook.list.sortName') }}</option>
            </select>
            <svg class="select-arrow" width="10" height="6" viewBox="0 0 10 6" fill="none">
              <path
                d="M1 1L5 5L9 1"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </div>
        </div>

        <!-- 岛屿 B: 次要操作。导入分享码只有云端才有意义，社区版整块不渲染 -->

        <!-- 岛屿 C: 核心操作 -->
        <button class="btn-primary-create" @click="handleCreateNotebook">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
          <span>{{ t('notebook.list.createNotebook') }}</span>
        </button>
      </div>
    </div>

    <!-- Main Content -->
    <div class="content-area">
      <AppPageSkeleton v-if="initialLoading && notebooks.length === 0" :layout="viewMode" />
      <div v-else-if="viewMode === 'grid'" class="notebook-grid">
        <!-- New Notebook Card -->
        <div class="notebook-card create-card" @click="handleCreateNotebook">
          <div class="create-icon">
            <PhPlus />
          </div>
          <div class="create-text">{{ t('notebook.list.newNotebook') }}</div>
        </div>

        <!-- Notebook Items -->
        <div
          v-for="item in sortedNotebooks"
          :key="item.id"
          class="notebook-card"
          :class="{ 'is-loading': loadingNotebookId === item.id }"
          @click="handleOpenNotebook(item.id)"
        >
          <!-- Loading 遮罩 -->
          <div v-if="loadingNotebookId === item.id" class="loading-overlay">
            <PhCircleNotch class="icon-spin loading-icon" />
            <span class="loading-text">{{ t('notebook.list.loading') }}</span>
          </div>
          <div class="card-cover" :style="getCoverStyle(item)">
            <!-- Placeholder for cover content/icon -->
            <div class="cover-icon">
              <PhFileText v-if="!item.coverStyle && !item.coverImage" />
            </div>
            <AppDropdown :trigger="['click']" placement="bottomRight">
              <template #overlay>
                <AppMenu @click="(info) => handleMenuClick(String(info.key), item)">
                  <AppMenuItem key="cover" item-key="cover">
                    <PhImage /> {{ t('notebook.list.uploadCover') }}
                  </AppMenuItem>
                  <AppMenuItem key="rename" item-key="rename">
                    <PhPencilSimple /> {{ t('common.edit') }}
                  </AppMenuItem>
                  <AppMenuItem key="delete" item-key="delete" danger>
                    <PhTrash /> {{ t('common.delete') }}
                  </AppMenuItem>
                </AppMenu>
              </template>
              <AppButton variant="text" class="more-btn" @click.stop>
                <template #icon>
                  <PhDotsThree />
                </template>
              </AppButton>
            </AppDropdown>
          </div>
          <div class="card-info">
            <div class="title">{{ item.title }}</div>
            <div class="meta">
              {{ formatDate(item.updatedAt) }} ·
              {{ t('notebook.list.sourcesCount', { count: item.sourceCount }) }} ·
              {{ t('notebook.list.outputsCount', { count: getOutputCount(item.id) }) }}
            </div>
          </div>
        </div>
      </div>

      <!-- List View -->
      <div v-else-if="viewMode === 'list'" class="notebook-list-view">
        <div class="list-header">
          <div class="col-title">{{ t('notebook.list.listHeader.title') }}</div>
          <div class="col-source">{{ t('notebook.list.listHeader.sources') }}</div>
          <div class="col-date">{{ t('notebook.list.listHeader.createdAt') }}</div>
          <div class="col-role">{{ t('notebook.list.listHeader.role') }}</div>
          <div class="col-action"></div>
        </div>

        <div class="list-body">
          <div
            v-for="item in sortedNotebooks"
            :key="item.id"
            class="list-item"
            :class="{ 'is-loading': loadingNotebookId === item.id }"
            @click="handleOpenNotebook(item.id)"
          >
            <div class="col-title">
              <PhCircleNotch
                v-if="loadingNotebookId === item.id"
                class="icon-spin list-loading-icon"
              />
              <div v-else class="item-icon-tiny" :style="getCoverStyle(item)">
                <PhFileText
                  v-if="!item.coverImage"
                  style="font-size: 12px; color: rgba(255, 255, 255, 0.7)"
                />
              </div>
              <span class="item-title-text">{{ item.title }} </span>
            </div>
            <div class="col-source">
              {{ t('notebook.list.sourcesCount', { count: item.sourceCount }) }} ·
              {{ t('notebook.list.outputsCount', { count: getOutputCount(item.id) }) }}
            </div>
            <div class="col-date">{{ formatDate(item.createdAt) }}</div>
            <div class="col-role">{{ item.role }}</div>
            <div class="col-action">
              <AppDropdown :trigger="['click']" placement="bottomRight">
                <template #overlay>
                  <AppMenu @click="(info) => handleMenuClick(String(info.key), item)">
                    <AppMenuItem key="cover" item-key="cover">
                      <PhImage /> {{ t('notebook.list.uploadCover') }}
                    </AppMenuItem>
                    <AppMenuItem key="rename" item-key="rename">
                      <PhPencilSimple /> {{ t('common.edit') }}
                    </AppMenuItem>
                    <AppMenuItem key="delete" item-key="delete" danger>
                      <PhTrash /> {{ t('common.delete') }}
                    </AppMenuItem>
                  </AppMenu>
                </template>
                <AppButton variant="text" class="list-more-btn" @click.stop>
                  <template #icon>
                    <PhDotsThree />
                  </template>
                </AppButton>
              </AppDropdown>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 重命名对话框 -->
    <AppModal
      v-model:open="renameModalVisible"
      :title="t('notebook.list.renameTitle')"
      :ok-text="t('common.confirm')"
      :cancel-text="t('common.cancel')"
      @ok="handleRenameConfirm"
    >
      <a-input
        v-model:value="renameTitle"
        :placeholder="t('notebook.list.renameEmpty')"
        @keyup.enter="handleRenameConfirm"
      />
    </AppModal>

    <!-- 隐藏的封面上传 input -->
    <input
      id="cover-upload-input"
      type="file"
      accept="image/*"
      style="display: none"
      @change="handleCoverFileChange"
    />
  </div>
</template>

<style scoped lang="less">
.notebook-list-page {
  padding: 24px 32px;
  height: 100%;
  color: var(--color-text-primary);
  overflow-y: auto;
}

// ListView Styles
.notebook-list-view {
  display: flex;
  flex-direction: column;
  width: 100%;

  .list-header {
    display: flex;
    align-items: center;
    padding: 0 16px 12px 16px;
    border-bottom: 1px solid var(--color-border-subtle);
    color: var(--color-text-secondary);
    font-size: 13px;

    .col-title {
      flex: 1;
      min-width: 0;
    }
    .col-source {
      width: 140px;
    }
    .col-date {
      width: 140px;
    }
    .col-role {
      width: 100px;
    }
    .col-action {
      width: 40px;
    }
  }

  .list-body {
    .list-item {
      display: flex;
      align-items: center;
      padding: 12px 16px;
      border-bottom: 1px solid var(--color-border-subtle);
      cursor: pointer;
      transition: background-color 0.2s;

      &:hover {
        background-color: var(--color-bg-surface-hover);

        .list-more-btn {
          opacity: 1;
        }
      }

      &.is-loading {
        pointer-events: none;
        background-color: var(--color-bg-surface-hover);
      }

      .col-title {
        flex: 1;
        min-width: 0;
        display: flex;
        align-items: center;
        gap: 12px;
        padding-right: 16px;

        .item-icon-tiny {
          width: 20px;
          height: 20px;
          border-radius: 4px;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
          /* If no coverStyle, fallback to gray */
          background-color: var(--color-bg-raised);
        }

        .list-loading-icon {
          font-size: 16px;
          color: var(--color-accent-text);
          flex-shrink: 0;
        }

        .item-title-text {
          font-size: 14px;
          color: var(--color-text-primary);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
      }

      .col-source,
      .col-date,
      .col-role {
        font-size: 14px;
        color: var(--color-text-primary);
      }

      .col-source {
        width: 140px;
        color: var(--color-text-secondary);
      } // Matches screenshot seemingly
      .col-date {
        width: 140px;
      }
      .col-role {
        width: 100px;
      }

      .col-action {
        width: 40px;
        display: flex;
        justify-content: flex-end;

        .list-more-btn {
          color: var(--color-text-secondary);
          opacity: 0; // Show on hover
          transition: opacity 0.2s;

          &:hover {
            color: var(--color-text-primary);
            background: var(--color-bg-surface-hover);
          }
        }
      }
    }
  }
}

// ========== Header Restyled ==========
.gallery-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 24px;
}

.header-title {
  h1 {
    font-size: 20px;
    font-weight: 600;
    margin: 0;
    background: linear-gradient(180deg, #ffffff 0%, rgba(255, 255, 255, 0.7) 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    letter-spacing: 0.5px;
  }
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 16px;
}

// 岛屿通用基础样式
.action-island {
  display: flex;
  align-items: center;
  background: var(--color-bg-sunken);
  backdrop-filter: blur(12px);
  border: 1px solid var(--color-border-subtle);
  border-radius: 8px;
  padding: 4px;
}

// 岛屿 A：视图与排序
.view-island {
  gap: 6px;

  .divider {
    width: 1px;
    height: 14px;
    background: var(--color-bg-surface-hover);
    margin: 0 4px;
  }
}

// 视图切换按钮
.view-toggle {
  display: flex;
  gap: 2px;

  .toggle-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--color-text-primary);
    cursor: pointer;
    transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);

    &:hover {
      color: var(--color-text-primary);
      background: var(--color-bg-surface-hover);
    }

    &.active {
      color: var(--color-text-primary);
      background: var(--color-bg-selected);
      box-shadow: 0 1px 3px var(--shadow-color);
    }
  }
}

// 极简排序下拉框
.custom-select-wrapper {
  position: relative;
  display: flex;
  align-items: center;
  padding: 0 8px 0 4px;

  .minimal-select {
    appearance: none;
    background: transparent;
    border: none;
    color: var(--color-text-primary);
    font-size: 13px;
    font-weight: 500;
    padding: 6px 16px 6px 6px;
    cursor: pointer;
    outline: none;
    transition: color 0.2s;
    line-height: 1.2;

    &:hover {
      color: var(--color-text-primary);
    }

    &:focus {
      color: var(--color-text-primary);
    }

    option {
      background: var(--color-bg-surface);
      color: var(--color-text-secondary);
    }
  }

  .select-arrow {
    position: absolute;
    right: 8px;
    pointer-events: none;
    color: var(--color-text-primary);
    transition: transform 0.2s;
  }

  &:hover .select-arrow {
    color: var(--color-text-primary);
  }
}

// 岛屿 B：次要操作（纯 Icon 按钮）
.secondary-island {
  gap: 4px;
}

.icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--color-text-primary);
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);

  &:hover {
    color: var(--color-text-primary);
    background: var(--color-bg-surface-hover);
  }
}

.notebook-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 20px;
}

.notebook-card {
  background: var(--color-bg-surface); // Assuming variable exists, otherwise hardcode darker
  border-radius: 12px;
  border: 1px solid var(--color-border-subtle);
  overflow: hidden;
  cursor: pointer;
  transition:
    transform 0.2s,
    box-shadow 0.2s;
  display: flex;
  flex-direction: column;
  height: 200px;
  position: relative;

  &:hover {
    box-shadow: 0 4px 12px var(--shadow-color-weak);
    border-color: var(--color-border);
  }

  &.is-loading {
    pointer-events: none;
  }

  .loading-overlay {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: var(--color-bg-scrim);
    backdrop-filter: blur(4px);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    z-index: 10;
    border-radius: 12px;

    .loading-icon {
      font-size: 28px;
      color: var(--color-accent-text);
      margin-bottom: 8px;
    }

    .loading-text {
      font-size: 13px;
      color: var(--color-text-primary);
    }
  }

  &.create-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: 1px dashed var(--color-border);

    &:hover {
      border-color: var(--color-border);
      .create-icon {
        color: var(--color-accent-text);
        background: var(--color-bg-sunken);
      }
      .create-text {
        color: var(--color-accent-text);
      }
    }

    .create-icon {
      width: 48px;
      height: 48px;
      border-radius: 50%;
      background: var(--color-bg-surface-hover);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
      color: var(--color-accent-text);
      margin-bottom: 12px;
      transition: all 0.2s;
    }

    .create-text {
      font-size: 14px;
      color: var(--color-text-secondary);
      transition: color 0.2s;
    }
  }

  .card-cover {
    flex: 1;
    padding: 16px;
    position: relative;
    display: flex;
    flex-direction: column;

    .more-btn {
      position: absolute;
      top: 8px;
      right: 8px;
      color: var(--color-text-primary);
      opacity: 0;
      transition: opacity 0.2s;

      &:hover {
        background: var(--color-bg-surface-hover);
        color: var(--color-text-primary);
      }
    }
  }

  &:hover .more-btn {
    opacity: 1;
  }

  .card-info {
    padding: 12px 16px;
    background: var(--color-bg-surface-hover);
    backdrop-filter: blur(10px);

    .title {
      font-size: 15px;
      font-weight: 500;
      margin-bottom: 4px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .meta {
      font-size: 12px;
      color: var(--color-text-secondary);
    }
  }
}

/* 入场动画关键帧 */
@keyframes fadeInDown {
  from {
    opacity: 0;
    transform: translateY(-20px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes fadeInUp {
  from {
    opacity: 0;
    transform: translateY(20px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>
