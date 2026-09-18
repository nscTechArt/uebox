<template>
  <div v-if="isAuthenticated" class="list-card">
    <div
      ref="scrollContainer"
      class="file-content"
      :class="{ 'drop-target-active': isDropTarget }"
      @click="handleEmptyClick"
      @dragover.prevent="handleDropDragOver"
      @dragenter.prevent="handleDropDragEnter"
      @dragleave="handleDropDragLeave"
      @drop.prevent="handleDropFromAssetLib"
      @scroll="handleScroll"
    >
      <AppSpin :spinning="loading">
        <div v-if="files.length === 0 && !loading" class="empty-state">
          <div class="empty-icon">📄</div>
          <div class="empty-text">{{ $t('baiduyunFileList.emptyText') }}</div>
        </div>

        <template v-else>
          <div class="file-content-wrapper">
            <div v-if="folderItems.length > 0" class="folder-section">
              <div class="section-header">
                <span class="section-title">{{
                  $t('baiduyunFileList.folderSectionTitle', { count: folderItems.length })
                }}</span>
              </div>
              <div class="file-grid" :style="gridStyle">
                <div
                  v-for="item in folderItems"
                  :key="item.fs_id"
                  class="file-item folder-item"
                  :class="{ 'file-item-selected': isSelected(item) }"
                  :title="item.server_filename"
                  draggable="true"
                  @click="handleItemClick(item, $event)"
                  @dblclick="handleItemDblClick(item)"
                  @contextmenu="handleItemContextMenu($event, item)"
                  @dragstart="handleDragStart($event, item)"
                  @dragend="handleDragEnd"
                >
                  <div class="file-icon">
                    <div class="folder-icon-wrapper">
                      <PhFolder weight="fill" class="folder-icon" />
                    </div>
                  </div>
                  <div class="file-info">
                    <div v-if="inlineEditId !== item.fs_id" class="file-name">
                      {{ item.server_filename }}
                    </div>
                    <input
                      v-else
                      ref="inlineInputRef"
                      v-model="inlineEditValue"
                      class="inline-rename-input"
                      @keydown.enter="confirmInlineRename"
                      @keydown.esc="cancelInlineRename"
                      @blur="confirmInlineRename"
                      @click.stop
                      @dblclick.stop
                    />
                  </div>

                  <!-- 文件夹下载蒙层与进度 -->
                  <div
                    v-if="folderDownloadStates[item.fs_id]?.downloading"
                    class="download-overlay"
                  >
                    <div class="overlay-content">
                      <AppProgress
                        type="circle"
                        :percent="folderDownloadStates[item.fs_id]?.percent || 0"
                        size="medium"
                      />
                      <div class="overlay-status">
                        {{
                          folderDownloadStates[item.fs_id]?.phase === 'scanning'
                            ? $t('baiduyunFileList.scanningText')
                            : `${folderDownloadStates[item.fs_id]?.downloadedFiles || 0}/${folderDownloadStates[item.fs_id]?.totalFiles || 0}`
                        }}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div v-if="fileItems.length > 0" class="asset-section">
              <div class="section-header">
                <span class="section-title">{{
                  $t('baiduyunFileList.assetSectionTitle', { count: fileItems.length })
                }}</span>
              </div>
              <div class="file-grid" :style="gridStyle">
                <div
                  v-for="item in fileItems"
                  :key="item.fs_id"
                  class="file-item asset-item"
                  :class="{ 'file-item-selected': isSelected(item) }"
                  :title="item.server_filename"
                  draggable="true"
                  @click="handleItemClick(item, $event)"
                  @dblclick="handleItemDblClick(item)"
                  @contextmenu="handleItemContextMenu($event, item)"
                  @dragstart="handleDragStart($event, item)"
                  @dragend="handleDragEnd"
                >
                  <div class="file-icon">
                    <div v-if="item.thumbs?.url1" class="thumb-wrapper">
                      <img :src="item.thumbs.url1" class="file-thumb" alt="" />
                    </div>
                    <div v-else class="solid-icon-wrapper">
                      <PhFile />
                    </div>
                  </div>
                  <div class="file-info">
                    <div v-if="inlineEditId !== item.fs_id" class="file-name">
                      {{ item.server_filename }}
                    </div>
                    <input
                      v-else
                      ref="inlineInputRef"
                      v-model="inlineEditValue"
                      class="inline-rename-input"
                      @keydown.enter="confirmInlineRename"
                      @keydown.esc="cancelInlineRename"
                      @blur="confirmInlineRename"
                      @click.stop
                      @dblclick.stop
                    />
                  </div>

                  <!-- 下载蒙层与圆形进度 -->
                  <div v-if="downloadStates[item.fs_id]?.downloading" class="download-overlay">
                    <div class="overlay-content">
                      <AppProgress
                        type="circle"
                        :percent="downloadStates[item.fs_id]?.percent || 0"
                        size="medium"
                      />
                      <div v-if="downloadStates[item.fs_id]?.speedBps" class="overlay-speed">
                        {{ formatSpeed(downloadStates[item.fs_id]?.speedBps || 0) }}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </template>
      </AppSpin>
    </div>

    <!-- 全局右键菜单（文件与文件夹通用） -->
    <ContextMenu ref="contextMenuRef" :menu-items="menuItems" @click="handleMenuClick" />

    <!-- 百度网盘文件拖拽时的浮动提示 -->
    <Teleport to="body">
      <div
        v-if="baiduyunDragOverlayVisible"
        class="baiduyun-drag-overlay"
        :style="{ left: dragOverlayPos.x + 'px', top: dragOverlayPos.y + 'px' }"
      >
        {{ baiduyunDragOverlayText }}
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import AppProgress from '@renderer/components/AppProgress.vue'
import AppSpin from '@renderer/components/AppSpin.vue'
import { ref, watch, computed, reactive, onMounted, nextTick } from 'vue'
import { message } from '@renderer/utils/messageManager'
import { confirmDialog } from '@renderer/utils/dialog'
import { useI18n } from 'vue-i18n'
import { useBaiduyunStore } from '@renderer/store/modules/baiduyun'
import { type BaiduFileItem } from '@renderer/api-services/baiduYunApi'
import { PhDownloadSimple, PhFile, PhFolder, PhPencilSimple, PhTrash } from '@phosphor-icons/vue'
import { formatSpeed } from '@renderer/common/utils'
import { ContextMenu, type MenuItem } from '@renderer/components/ContextMenu'
import assetFolderAPI from '@renderer/api/assetFolder'
import assetDataAPI from '@renderer/api/assetData'
import { useAssetSelectionStore } from '@renderer/store/modules/assetSelectionStore'

interface Props {
  tableHeight?: number
  itemSize?: number
}

withDefaults(defineProps<Props>(), {
  tableHeight: 500,
  itemSize: 160
})

const emit = defineEmits<{
  (e: 'selection-change', items: BaiduFileItem[]): void
}>()

const baiduyunStore = useBaiduyunStore()
const { t } = useI18n()
const isAuthenticated = computed(() => baiduyunStore.isAuthenticated && !baiduyunStore.isExpired)
const selectionStore = useAssetSelectionStore()

const files = ref<BaiduFileItem[]>([])
const loading = ref(false)
const loadingMore = ref(false)
const hasMore = ref(true)
const start = ref(0)
const limit = 200
const scrollContainer = ref<HTMLElement | null>(null)
const searchKey = ref('')
const isSearching = ref(false)
const selectedFiles = ref<Set<number>>(new Set())

// 排序状态
const currentOrder = ref<'name' | 'time' | 'size'>('name')
const currentDesc = ref<0 | 1>(0)

// 内联重命名状态
const inlineEditId = ref<number | null>(null)
const inlineEditValue = ref('')
const inlineInputRef = ref<HTMLInputElement | null>(null)

// 右键菜单上下文
const contextMenuRef = ref()
const currentContextItem = ref<BaiduFileItem | null>(null)
const menuItems = computed<MenuItem[]>(() => {
  const disabled = !currentContextItem.value
  const isFolder = currentContextItem.value?.isdir === 1
  return [
    {
      key: 'rename',
      label: t('baiduyunFileList.contextMenu.rename'),
      icon: PhPencilSimple,
      disabled
    },
    {
      key: 'download',
      label: isFolder
        ? t('baiduyunFileList.contextMenu.downloadFolder')
        : t('baiduyunFileList.contextMenu.download'),
      icon: PhDownloadSimple,
      disabled
    },
    { type: 'divider' as const },
    {
      key: 'delete',
      label: t('baiduyunFileList.contextMenu.delete'),
      icon: PhTrash,
      danger: true,
      disabled
    }
  ]
})

type DownloadStep = 'idle' | 'list' | 'metas' | 'download' | 'done' | 'error'
const downloadStates = reactive<
  Record<
    number,
    { downloading: boolean; percent: number; step: DownloadStep; speedBps?: number; error?: string }
  >
>({})

// 文件夹下载状态
type FolderDownloadPhase = 'scanning' | 'downloading' | 'done' | 'error'
const folderDownloadStates = reactive<
  Record<
    number,
    {
      downloading: boolean
      phase: FolderDownloadPhase
      totalFiles: number
      downloadedFiles: number
      failedFiles: number
      currentFile: string
      percent: number
    }
  >
>({})

const getPathSep = (base: string): string => (base.includes('\\') ? '\\' : '/')

async function ensureDir(targetDir: string) {
  await (window as any).api.invoke('fs:ensureDir', targetDir)
}

const ensureBaiduFolder = async (): Promise<{ folderKey: string; fullPath: string }> => {
  const BAIDU_NAME = '百度网盘'
  try {
    const siblings = await assetFolderAPI.getByFatherKey('ALL')
    const found = (siblings || []).find((f: any) => f.folderName === BAIDU_NAME)
    if (found) {
      const fullPath = found.fullPath || `/ALL/${BAIDU_NAME}`.replace(/\/{2,}/g, '/')
      return { folderKey: found.folderKey, fullPath }
    }
  } catch (e) {
    console.warn('读取ALL子文件夹失败，尝试创建百度网盘文件夹', e)
  }

  // 未找到则创建
  const folderKey = `folder_${Date.now()}`
  try {
    await assetFolderAPI.create({
      folderKey,
      fatherKey: 'ALL',
      folderName: BAIDU_NAME,
      type: 'normal',
      img: ''
    } as any)

    // 派发事件通知资产树刷新（使文件夹展开图标正确显示）
    window.dispatchEvent(new CustomEvent('asset-folder:changed', { detail: { folderKey } }))
  } catch (e) {
    console.warn('创建百度网盘文件夹失败，使用ALL作为兜底', e)
    return { folderKey: 'ALL', fullPath: '/ALL' }
  }

  return {
    folderKey,
    fullPath: `/ALL/${BAIDU_NAME}`.replace(/\/{2,}/g, '/')
  }
}

async function resolveVaultTargetDir(): Promise<{
  vaultPath: string
  targetDir: string
  folderKey?: string
}> {
  const result = await (window as any).api.invoke('vault:getCurrentPath')
  if (!result?.success || !result.path) {
    throw new Error('未选择本地资产库，请先在资产库页选择一个保管库')
  }
  const vaultPath: string = result.path
  const sep = getPathSep(vaultPath)
  let folderKey = selectionStore.selectedTreeKey || null
  let folderFullPath: string | null = null
  if (!folderKey) {
    const ensured = await ensureBaiduFolder()
    folderKey = ensured.folderKey
    folderFullPath = ensured.fullPath
  } else {
    try {
      const folder = await assetFolderAPI.getByKey(folderKey)
      folderFullPath = folder?.fullPath || null
    } catch {
      folderFullPath = null
    }
  }
  if (!folderKey) folderKey = 'ALL'
  let relative = 'assetData'
  try {
    const normalized = (folderFullPath || '').replace(/^[/\\]+/, '').replace(/[\\/]+/g, sep)
    if (normalized) {
      relative = `assetData${sep}${normalized}`
    }
  } catch {
    // ignore, fallback to assetData root
  }
  const targetDir = `${vaultPath}${sep}${relative}`
  return { vaultPath, targetDir, folderKey }
}

function buildUniquePath(
  dir: string,
  filename: string
): () => Promise<{ fullPath: string; name: string }> {
  const sep = getPathSep(dir)
  const extIndex = filename.lastIndexOf('.')
  const base = extIndex > 0 ? filename.slice(0, extIndex) : filename
  const ext = extIndex > 0 ? filename.slice(extIndex) : ''
  return async () => {
    for (let i = 0; i < 50; i++) {
      const name = i === 0 ? filename : `${base} (${i})${ext}`
      const fullPath = `${dir}${sep}${name}`
      let exists = false
      try {
        const existsRes = await (window as any).api.invoke('fs:exists', fullPath)
        exists = existsRes?.exists ?? existsRes === true
      } catch {
        // 若主进程缺少 handler，则退回为不存在，避免中断下载
        exists = false
      }
      if (!exists) {
        return { fullPath, name }
      }
    }
    throw new Error('目标目录存在过多同名文件，请更换目录')
  }
}

async function ingestDownloadedFile(filePath: string, folderKey?: string): Promise<void> {
  try {
    const stats = await (window as any).api.getFileStats(filePath)
    const name = filePath.split(/[/\\]/).pop() || filePath
    const fileInfo = {
      name,
      path: filePath,
      type: 'file' as const,
      size: stats?.size ?? null,
      modifiedTime: stats?.mtime ?? new Date().toISOString(),
      depth: 0,
      relativePath: name
    }
    await assetDataAPI.importFolderStructureWithMetadata([fileInfo], 'ALL', folderKey)
  } catch (error) {
    console.warn('写入资产索引失败（可稍后手动导入）:', error)
  }
}

/**
 * 将下载的文件夹递归导入到资产库
 * @param folderPath 本地文件夹路径
 * @param folderKey 目标资产库文件夹key
 */
async function ingestDownloadedFolder(folderPath: string, folderKey?: string): Promise<void> {
  try {
    // 使用 IPC 递归扫描文件夹内容
    const result = await window.api.fs.readFolderContentsRecursive(folderPath)
    // API 可能返回 { success, data } 或直接返回数组
    const contents = Array.isArray(result) ? result : result?.data || result
    if (!contents || !Array.isArray(contents) || contents.length === 0) {
      console.warn('文件夹为空或扫描失败:', folderPath, result)
      return
    }
    // importFolderStructureWithMetadata 接受文件夹内容数组和根路径
    await assetDataAPI.importFolderStructureWithMetadata(contents, folderPath, folderKey)
  } catch (error) {
    console.warn('文件夹导入资产库索引失败（可稍后手动导入）:', error)
  }
}

function setDownloadState(
  fsId: number,
  patch: Partial<{
    downloading: boolean
    percent: number
    step: DownloadStep
    speedBps?: number
    error?: string
  }>
) {
  const prev = downloadStates[fsId] || {
    downloading: false,
    percent: 0,
    step: 'idle' as DownloadStep
  }
  downloadStates[fsId] = { ...prev, ...patch }
}

// 已移除未使用的目录解析函数，避免类型检查警告

async function handleFetchInternal(isLoadMore = false) {
  console.log(baiduyunStore.currentDir)

  const accessToken = baiduyunStore.token?.accessToken
  if (!accessToken) return
  try {
    if (isLoadMore) {
      loadingMore.value = true
    } else {
      loading.value = true
      start.value = 0
      hasMore.value = true
      // 滚动回顶部
      if (scrollContainer.value) {
        scrollContainer.value.scrollTop = 0
      }
    }

    const res = await window.api.baiduYun.getFileList({
      accessToken,
      dir: baiduyunStore.currentDir || '/',
      order: currentOrder.value,
      desc: currentDesc.value,
      start: start.value,
      limit: limit,
      web: 1
    })
    console.log(res)

    if (res?.success) {
      const newFiles = res.data?.list || []
      if (isLoadMore) {
        files.value = [...files.value, ...newFiles]
      } else {
        files.value = newFiles
      }

      // 判断是否还有更多数据
      if (newFiles.length < limit) {
        hasMore.value = false
      } else {
        start.value += limit
      }
    } else {
      throw new Error(res?.error || '请求失败')
    }
    isSearching.value = false
  } catch (err) {
    console.error('获取文件列表失败', err)
    message.error(t('baiduyunFileList.messages.listFetchFailed'))
  } finally {
    loading.value = false
    loadingMore.value = false
  }
}

const handleScroll = (e: Event) => {
  const target = e.target as HTMLElement
  if (!target) return

  // 距离底部 50px 时加载更多
  if (
    target.scrollHeight - target.scrollTop - target.clientHeight < 50 &&
    hasMore.value &&
    !loadingMore.value &&
    !loading.value &&
    !isSearching.value // 搜索模式下暂不支持滚动加载（根据实际 API 支持情况）
  ) {
    handleFetchInternal(true)
  }
}

/**
 * 处理排序变更
 */
function handleSortChange(order: 'name' | 'time' | 'size', desc: 0 | 1) {
  currentOrder.value = order
  currentDesc.value = desc
  handleFetchInternal()
}

function handleItemDblClick(record: BaiduFileItem) {
  console.log(record.isdir)

  if (record.isdir === 1) {
    if (isSearching.value) {
      isSearching.value = false
      searchKey.value = ''
    }
    baiduyunStore.setCurrentDir(record.path)
  }
}

async function handleDownloadInternal(record: BaiduFileItem) {
  let offListener: (() => void) | null = null
  try {
    if (record.isdir === 1) {
      message.info(t('baiduyunFileList.messages.folderDownloadNotSupported'))
      return
    }
    const accessToken = baiduyunStore.token?.accessToken
    if (!accessToken) {
      message.error(t('baiduyunFileList.messages.missingToken'))
      return
    }

    const { targetDir, folderKey } = await resolveVaultTargetDir()
    await ensureDir(targetDir)
    const pickPath = buildUniquePath(targetDir, record.server_filename || 'download')
    const { fullPath } = await pickPath()

    const downloadId = `${record.fs_id}-${Date.now()}`
    let lastTs = Date.now()
    let lastLoaded = 0
    offListener = window.api.baiduYun.onProgress((evt) => {
      if (evt.downloadId !== downloadId) return
      const now = Date.now()
      const deltaBytes = Math.max(0, evt.loaded - lastLoaded)
      const deltaMs = Math.max(1, now - lastTs)
      const bps = (deltaBytes * 1000) / deltaMs
      lastLoaded = evt.loaded
      lastTs = now
      const base = 5
      const pct = evt.total ? Math.max(base, Math.min(99, Math.round(evt.percent))) : base
      setDownloadState(record.fs_id, { percent: pct, speedBps: bps })
    })

    setDownloadState(record.fs_id, { downloading: true, percent: 5, step: 'download' })

    const result = await window.api.baiduYun.downloadByFsId({
      downloadId,
      accessToken,
      fsId: record.fs_id,
      filename: record.server_filename,
      savePath: fullPath
    })

    offListener?.()

    if (!result?.success) {
      throw new Error(result?.error || '下载失败')
    }

    await ingestDownloadedFile(fullPath, folderKey)

    setDownloadState(record.fs_id, { percent: 100, step: 'done', downloading: false, speedBps: 0 })
    // message.success(`已下载到资产库：${fullPath}`)
  } catch (err: any) {
    console.error('下载失败', err)
    try {
      offListener?.()
    } catch {}
    setDownloadState(record.fs_id, { step: 'error', downloading: false })
    message.error(err?.message || t('baiduyunFileList.messages.downloadFailedRetry'))
  }
}

/**
 * 下载文件夹内部处理函数
 * @param record 文件夹记录
 */
async function handleDownloadFolderInternal(record: BaiduFileItem) {
  let offListener: (() => void) | null = null
  try {
    if (record.isdir !== 1) {
      // 不是文件夹，走单文件下载逻辑
      await handleDownloadInternal(record)
      return
    }

    const accessToken = baiduyunStore.token?.accessToken
    if (!accessToken) {
      message.error(t('baiduyunFileList.messages.missingToken'))
      return
    }

    const { targetDir, folderKey } = await resolveVaultTargetDir()
    await ensureDir(targetDir)

    const downloadId = `folder-${record.fs_id}-${Date.now()}`

    // 初始化状态
    folderDownloadStates[record.fs_id] = {
      downloading: true,
      phase: 'scanning',
      totalFiles: 0,
      downloadedFiles: 0,
      failedFiles: 0,
      currentFile: '',
      percent: 0
    }

    // 监听进度
    offListener = window.api.baiduYun.onFolderDownloadProgress((evt) => {
      if (evt.downloadId !== downloadId) return
      folderDownloadStates[record.fs_id] = {
        downloading: evt.phase !== 'done' && evt.phase !== 'error',
        phase: evt.phase,
        totalFiles: evt.totalFiles,
        downloadedFiles: evt.downloadedFiles,
        failedFiles: evt.failedFiles,
        currentFile: evt.currentFile,
        percent: evt.percent
      }
    })

    // 开始下载
    const result = await window.api.baiduYun.downloadFolder({
      downloadId,
      accessToken,
      folderPath: record.path,
      folderName: record.server_filename,
      savePath: targetDir
    })

    offListener?.()

    if (result?.error === 'TOKEN_EXPIRED') {
      message.error(t('baiduyunFileList.messages.tokenExpired'))
      baiduyunStore.clearToken()
      return
    }

    if (!result?.success) {
      const failedCount = result?.data?.failedFiles?.length || 0
      if (failedCount > 0) {
        message.warning(
          t('baiduyunFileList.messages.downloadDoneWithFailures', { count: failedCount })
        )
      } else {
        throw new Error(result?.error || '下载失败')
      }
    } else {
      const downloadedCount = result?.data?.downloadedCount || 0
      if (result?.data?.message === '文件夹为空') {
        message.info(t('baiduyunFileList.messages.folderEmptyNoDownload'))
      } else {
        message.success(
          t('baiduyunFileList.messages.downloadedToVault', { count: downloadedCount })
        )
      }
    }

    // 尝试将下载的文件夹导入资产库索引
    if (result?.data?.savePath && folderKey) {
      try {
        await ingestDownloadedFolder(result.data.savePath, folderKey)
      } catch (e) {
        console.warn('导入资产库索引失败:', e)
      }
    }

    // 清理状态
    folderDownloadStates[record.fs_id] = {
      downloading: false,
      phase: 'done',
      totalFiles: result?.data?.downloadedCount || 0,
      downloadedFiles: result?.data?.downloadedCount || 0,
      failedFiles: result?.data?.failedFiles?.length || 0,
      currentFile: '',
      percent: 100
    }
  } catch (err: unknown) {
    console.error('文件夹下载失败', err)
    try {
      offListener?.()
    } catch {
      /* ignore */
    }
    folderDownloadStates[record.fs_id] = {
      downloading: false,
      phase: 'error',
      totalFiles: 0,
      downloadedFiles: 0,
      failedFiles: 0,
      currentFile: '',
      percent: 0
    }
    const errMsg =
      err instanceof Error ? err.message : t('baiduyunFileList.messages.downloadFailedRetry')
    message.error(errMsg)
  }
}

/**
 * 检查文件是否被选中
 */
function isSelected(item: BaiduFileItem): boolean {
  return selectedFiles.value.has(item.fs_id)
}

/**
 * 处理文件项点击
 */
function handleItemClick(item: BaiduFileItem, event: MouseEvent): void {
  // 阻止事件冒泡,避免触发空白区域点击
  event.stopPropagation()

  // 关闭右键菜单（因为 stopPropagation 会阻止 ContextMenu 的 handleClickOutside 检测到点击）
  contextMenuRef.value?.hide()

  // 如果按住 Ctrl,进行多选
  if (event.ctrlKey || event.metaKey) {
    if (selectedFiles.value.has(item.fs_id)) {
      selectedFiles.value.delete(item.fs_id)
    } else {
      selectedFiles.value.add(item.fs_id)
    }
  } else {
    // 单选
    selectedFiles.value.clear()
    selectedFiles.value.add(item.fs_id)
  }
  emitSelectionChange()
}

/**
 * 点击空白区域清除选中
 */
function handleEmptyClick(event: MouseEvent): void {
  if (event.target === event.currentTarget) {
    selectedFiles.value.clear()
    emitSelectionChange()
  }
}

function emitSelectionChange() {
  const items = files.value.filter((f) => selectedFiles.value.has(f.fs_id))
  emit('selection-change', items)
}

function handleItemContextMenu(event: MouseEvent, record: BaiduFileItem) {
  event.preventDefault()
  event.stopPropagation()
  currentContextItem.value = record
  contextMenuRef.value?.show(event.clientX, event.clientY)
}

const handleMenuClick = async (key: string) => {
  const item = currentContextItem.value
  if (!item) return

  switch (key) {
    case 'rename':
      await handleRename(item)
      break
    case 'download':
      if (item.isdir === 1) {
        await handleDownloadFolderInternal(item)
      } else {
        await handleDownloadInternal(item)
      }
      break
    case 'delete':
      await handleDelete(item)
      break
    default:
      break
  }
}

/**
 * 开始内联重命名
 */
function startInlineRename(record: BaiduFileItem): void {
  const fullName = record.server_filename || ''
  const isFolder = record.isdir === 1

  // 文件则提取不含扩展名的部分
  let base = fullName
  if (!isFolder) {
    const idx = fullName.lastIndexOf('.')
    if (idx > 0 && idx < fullName.length - 1) {
      base = fullName.slice(0, idx)
    }
  }

  inlineEditId.value = record.fs_id
  inlineEditValue.value = base

  nextTick(() => {
    setTimeout(() => {
      const inputEl = inlineInputRef.value
      if (inputEl) {
        inputEl.focus()
        inputEl.select()
      }
    }, 50)
  })
}

/**
 * 取消内联重命名
 */
function cancelInlineRename(): void {
  inlineEditId.value = null
  inlineEditValue.value = ''
}

/**
 * 确认内联重命名
 */
async function confirmInlineRename(): Promise<void> {
  const fsId = inlineEditId.value
  if (!fsId) return

  const record = files.value.find((f) => f.fs_id === fsId)
  if (!record) {
    cancelInlineRename()
    return
  }

  const isFolder = record.isdir === 1
  const fullName = record.server_filename || ''
  let ext = ''
  if (!isFolder) {
    const idx = fullName.lastIndexOf('.')
    if (idx > 0 && idx < fullName.length - 1) {
      ext = fullName.slice(idx)
    }
  }

  const baseNew = (inlineEditValue.value || '').trim()
  if (!baseNew) {
    message.warning(t('baiduyunFileList.messages.nameRequired'))
    return
  }

  const finalName = isFolder ? baseNew : baseNew + ext
  if (finalName === record.server_filename) {
    cancelInlineRename()
    return
  }

  const accessToken = baiduyunStore.token?.accessToken
  if (!accessToken) {
    message.error(t('baiduyunFileList.messages.missingToken'))
    return
  }

  try {
    const res = await window.api.baiduYun.fileManager({
      accessToken,
      opera: 'rename',
      filelist: [{ path: record.path, newname: finalName }],
      async: 0
    })
    if (!res?.success) {
      throw new Error(res?.error || t('baiduyunFileList.messages.renameFailed'))
    }
    cancelInlineRename()
    await handleFetchInternal()
  } catch (err) {
    console.error('重命名失败', err)
    message.error(t('baiduyunFileList.messages.renameFailed'))
  }
}

/**
 * 兼容旧调用：调用内联重命名
 */
async function handleRename(record: BaiduFileItem): Promise<void> {
  startInlineRename(record)
}

async function handleDelete(record: BaiduFileItem) {
  return new Promise<void>((resolve, reject) => {
    confirmDialog({
      title: t('baiduyunFileList.deleteConfirm.title'),
      content: t('baiduyunFileList.deleteConfirm.content', { name: record.server_filename }),
      okText: t('baiduyunFileList.deleteConfirm.okText'),
      danger: true,
      cancelText: t('baiduyunFileList.deleteConfirm.cancelText'),
      async onOk() {
        const accessToken = baiduyunStore.token?.accessToken
        if (!accessToken) {
          message.error(t('baiduyunFileList.messages.missingToken'))
          return Promise.reject()
        }
        try {
          const res = await window.api.baiduYun.fileManager({
            accessToken,
            opera: 'delete',
            filelist: [{ path: record.path }],
            async: 0
          })
          if (!res?.success) {
            throw new Error(res?.error || t('baiduyunFileList.messages.deleteFailed'))
          }
          message.success(t('baiduyunFileList.messages.deleteSuccess'))
          await handleFetchInternal()
          resolve()
        } catch (err) {
          console.error('删除失败', err)
          message.error(t('baiduyunFileList.messages.deleteFailed'))
          reject(err)
        }
      },
      onCancel() {
        resolve()
      }
    })
  })
}

const folderItems = computed(() => files.value.filter((f) => f.isdir === 1))
const fileItems = computed(() => files.value.filter((f) => f.isdir !== 1))

const gridItemSize = computed(() => 120)

const gridStyle = computed(() => ({
  gridTemplateColumns: `repeat(auto-fill, minmax(${gridItemSize.value}px, 1fr))`
}))

watch(
  () => isAuthenticated.value,
  (val, oldVal) => {
    if (val && !oldVal) handleFetchInternal()
  }
)

watch(
  () => baiduyunStore.currentDir,
  () => {
    if (isAuthenticated.value) {
      handleFetchInternal()
    }
  }
)

onMounted(() => {
  if (isAuthenticated.value) handleFetchInternal()
})

/**
 * 从本地路径上传文件/文件夹到百度网盘
 * @param localPaths 本地文件或文件夹路径数组
 */
async function uploadLocalPaths(localPaths: string[]): Promise<void> {
  if (!isAuthenticated.value) {
    message.error(t('baiduyunFileList.messages.authRequired'))
    return
  }
  if (!localPaths || localPaths.length === 0) {
    return
  }

  // message.info(`开始上传 ${localPaths.length} 个项目到百度网盘...`)

  message.info(t('baiduyunFileList.messages.uploadStart'))

  let successCount = 0
  let failCount = 0

  for (const localPath of localPaths) {
    try {
      // 获取文件/文件夹信息
      const stats = await window.api.getFileStats(localPath)
      const isDirectory = stats?.isDirectory ?? false
      const name = localPath.split(/[/\\]/).pop() || 'unknown'

      if (isDirectory) {
        // 文件夹：递归获取所有文件并逐个上传
        const result = await window.api.fs.readFolderContentsRecursive(localPath)
        const contents = Array.isArray(result) ? result : result?.data || []
        const files = contents.filter((item: { type: string }) => item.type === 'file')

        for (const file of files) {
          const relativePath = file.relativePath || file.name
          const targetPath = `${baiduyunStore.currentDir}/${name}/${relativePath}`.replace(
            /\/+/g,
            '/'
          )
          const success = await uploadFileToBaiduyun(file.path, targetPath)
          if (success) successCount++
          else failCount++
        }
      } else {
        // 单个文件
        const targetPath = `${baiduyunStore.currentDir}/${name}`.replace(/\/+/g, '/')
        const success = await uploadFileToBaiduyun(localPath, targetPath)
        if (success) successCount++
        else failCount++
      }
    } catch (error) {
      console.error('上传失败:', localPath, error)
      failCount++
    }
  }

  if (successCount > 0) {
    await handleFetchInternal()
    message.success(t('baiduyunFileList.messages.uploadSuccess', { count: successCount }))
  }
  if (failCount > 0) {
    message.warning(t('baiduyunFileList.messages.uploadFailed', { count: failCount }))
  }
}

defineExpose({
  refresh: handleFetchInternal,
  search: handleSearch,
  uploadLocalPaths,
  sort: handleSortChange
})

// 删除未使用的格式化函数，模板中已注释对应输出

async function handleSearch(value?: string) {
  const kw = (typeof value === 'string' ? value : searchKey.value).trim()
  if (!kw) {
    if (isSearching.value) {
      await handleClearSearch()
    }
    return
  }
  const accessToken = baiduyunStore.token?.accessToken
  if (!accessToken) {
    message.error(t('baiduyunFileList.messages.missingToken'))
    return
  }
  try {
    loading.value = true
    const res = await window.api.baiduYun.searchFiles({
      accessToken,
      key: kw,
      dir: encodeURI(baiduyunStore.currentDir || '/'),
      recursion: 1,
      web: 1
    })
    if (res?.success) {
      files.value = res.data?.list || []
      isSearching.value = true
      searchKey.value = kw
      message.success(t('baiduyunFileList.messages.searchFound', { count: files.value.length }))
    } else {
      throw new Error(res?.error || t('baiduyunFileList.messages.searchFailed'))
    }
  } catch (error) {
    console.error('搜索失败:', error)
    message.error(t('baiduyunFileList.messages.searchFailed'))
  } finally {
    loading.value = false
  }
}

async function handleClearSearch() {
  searchKey.value = ''
  isSearching.value = false
  await handleFetchInternal()
}

// ========== 百度网盘拖拽到资产库的 DragOverlay ==========
const baiduyunDragOverlayVisible = ref(false)
const baiduyunDragOverlayText = ref(t('baiduyunFileList.dragOverlay.downloadTo'))
const dragOverlayPos = reactive({ x: 0, y: 0 })

/**
 * 拖拽过程中更新 DragOverlay 的位置和目标文本
 * 注意：使用 drag 事件而不是 mousemove，因为拖拽时 mousemove 不会触发
 */
function handleBaiduyunDrag(e: DragEvent): void {
  // 更新位置（drag 事件的坐标可能为 0，需要过滤掉）
  if (e.clientX !== 0 || e.clientY !== 0) {
    dragOverlayPos.x = e.clientX + 12
    dragOverlayPos.y = e.clientY + 12
  }

  // 获取鼠标下方的元素并更新目标文本
  const elUnder = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null
  const wrapper = elUnder?.closest('.ant-tree-node-content-wrapper') as HTMLElement | null

  if (wrapper) {
    // 找到目标节点的标题
    const titleEl = wrapper.querySelector('.tree-node-title')
    const folderKey = titleEl?.getAttribute('data-folder-key')
    const titleText = titleEl?.querySelector('.tree-node-text')?.textContent || folderKey || 'ALL'
    baiduyunDragOverlayText.value = t('baiduyunFileList.dragOverlay.downloadToTarget', {
      name: titleText
    })
  } else {
    baiduyunDragOverlayText.value = t('baiduyunFileList.dragOverlay.downloadTo')
  }
}

/**
 * 获取当前选中的所有文件项（用于批量拖拽）
 */
function getSelectedItems(): BaiduFileItem[] {
  if (selectedFiles.value.size === 0) {
    return []
  }
  return files.value.filter((f) => selectedFiles.value.has(f.fs_id))
}

/**
 * 拖拽开始处理
 * 将百度网盘文件信息存储到 dataTransfer 中
 * @param event 拖拽事件
 * @param item 被拖拽的文件项
 */
function handleDragStart(event: DragEvent, item: BaiduFileItem) {
  if (!event.dataTransfer) return

  // 如果当前项未被选中，则只拖拽当前项
  // 否则拖拽所有选中的项
  let itemsToTransfer: BaiduFileItem[] = []
  if (selectedFiles.value.has(item.fs_id)) {
    itemsToTransfer = getSelectedItems()
  } else {
    itemsToTransfer = [item]
  }

  // 设置拖拽数据类型和内容
  const transferData = {
    source: 'baiduyun',
    items: itemsToTransfer.map((f) => ({
      fs_id: f.fs_id,
      path: f.path,
      server_filename: f.server_filename,
      size: f.size,
      isdir: f.isdir
    }))
  }
  event.dataTransfer.setData('application/x-baiduyun-items', JSON.stringify(transferData))
  event.dataTransfer.setData('text/plain', itemsToTransfer.map((f) => f.server_filename).join(', '))
  event.dataTransfer.effectAllowed = 'copy'

  // 隐藏浏览器默认的 ghost 拖拽图像
  const emptyImg = document.createElement('img')
  emptyImg.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
  event.dataTransfer.setDragImage(emptyImg, 0, 0)

  // 添加拖拽类样式
  const target = event.target as HTMLElement
  target.classList.add('dragging')

  // 初始化 DragOverlay 位置
  dragOverlayPos.x = event.clientX + 12
  dragOverlayPos.y = event.clientY + 12

  // 显示 DragOverlay "下载到..."
  baiduyunDragOverlayText.value = t('baiduyunFileList.dragOverlay.downloadTo')
  baiduyunDragOverlayVisible.value = true

  // 使用 drag 事件（而不是 mousemove）来更新位置和目标文本
  // 因为拖拽时 mousemove 不会触发
  target.addEventListener('drag', handleBaiduyunDrag as unknown as (e: Event) => void)
}

/**
 * 拖拽结束处理
 * @param event 拖拽事件
 */
function handleDragEnd(event: DragEvent): void {
  // 移除拖拽类样式
  const target = event.target as HTMLElement
  target.classList.remove('dragging')

  // 隐藏 DragOverlay
  baiduyunDragOverlayVisible.value = false
  target.removeEventListener('drag', handleBaiduyunDrag as unknown as (e: Event) => void)
}

// ========== 从资产库拖入百度网盘的处理 ==========
const isDropTarget = ref(false)
let dropDragLeaveTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 拖拽悬停处理（接收资产库文件）
 */
function handleDropDragOver(e: DragEvent): void {
  // 检查是否包含本地资产库数据或文件
  if (
    e.dataTransfer?.types.includes('application/x-asset-items') ||
    e.dataTransfer?.types.includes('Files')
  ) {
    e.dataTransfer.dropEffect = 'copy'
  }
}

/**
 * 拖拽进入处理
 */
function handleDropDragEnter(e: DragEvent): void {
  if (dropDragLeaveTimer) {
    clearTimeout(dropDragLeaveTimer)
    dropDragLeaveTimer = null
  }
  if (
    e.dataTransfer?.types.includes('application/x-asset-items') ||
    e.dataTransfer?.types.includes('Files')
  ) {
    isDropTarget.value = true
  }
}

/**
 * 拖拽离开处理
 */
function handleDropDragLeave(e: DragEvent): void {
  if (dropDragLeaveTimer) {
    clearTimeout(dropDragLeaveTimer)
  }
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const x = e.clientX
  const y = e.clientY
  if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
    return
  }
  dropDragLeaveTimer = setTimeout(() => {
    isDropTarget.value = false
    dropDragLeaveTimer = null
  }, 100)
}

/**
 * 根据资产命名规则和分类生成百度网盘目标路径
 * 按照规则系统文档的要求：/apps/unreal-agent/{分类目录}
 * @param assetType 资产类型
 * @param fileName 文件名
 */
function getBaiduyunTargetPath(assetType: string | undefined, fileName: string): string {
  const basePath = '/apps/unreal-agent'

  // 根据资产类型获取分类目录
  const assetTypeToDirectory: Record<string, string> = {
    StaticMesh: 'Meshes/Static',
    SkeletalMesh: 'Meshes/Skeletal',
    Texture: 'Textures',
    Material: 'Materials',
    MaterialInstance: 'Materials/Instances',
    Blueprint: 'Blueprints',
    Animation: 'Animations',
    Sound: 'Audio',
    Particle: 'Effects',
    NiagaraSystem: 'Effects/Niagara',
    Widget: 'UI',
    DataTable: 'Data',
    Level: 'Maps',
    Unknown: 'Others'
  }

  const directory = assetTypeToDirectory[assetType || 'Unknown'] || 'Others'
  return `${basePath}/${directory}/${fileName}`
}

/**
 * 上传文件到百度网盘
 * 通过主进程IPC完成所有网络请求，前端只传递文件路径
 * @param filePath 本地文件路径
 * @param targetPath 百度网盘目标路径
 */
async function uploadFileToBaiduyun(filePath: string, targetPath: string): Promise<boolean> {
  const accessToken = baiduyunStore.token?.accessToken
  if (!accessToken) {
    message.error(t('baiduyunFileList.messages.notAuthorized'))
    return false
  }

  try {
    const SparkMD5 = (await import('spark-md5')).default
    const fileName = filePath.split(/[/\\]/).pop() || 'unknown'

    // 读取文件内容计算MD5
    const fileBufferResult = await window.api.fs.readFileBuffer(filePath)
    if (!fileBufferResult?.success || !fileBufferResult.data) {
      throw new Error(fileBufferResult?.error || '读取文件失败')
    }
    const fileBuffer = fileBufferResult.data
    const fileSize = fileBuffer.byteLength

    // 计算分片的MD5
    const chunkSize = 4 * 1024 * 1024 // 4MB
    const blockList: string[] = []
    let offset = 0
    while (offset < fileSize) {
      const end = Math.min(offset + chunkSize, fileSize)
      const chunk = fileBuffer.slice(offset, end)
      const md5 = SparkMD5.ArrayBuffer.hash(chunk)
      blockList.push(md5)
      offset = end
    }

    // 1. 预上传（通过IPC）
    const preRes = await window.api.baiduYun.precreate({
      accessToken,
      path: targetPath,
      size: fileSize,
      isdir: 0,
      blockList,
      rtype: 1
    })
    if (!preRes?.success || !preRes.data) {
      throw new Error(preRes?.error || '预上传失败')
    }
    const pre = preRes.data

    // 2. 定位上传服务器（通过IPC）
    const locateRes = await window.api.baiduYun.locateUpload({
      accessToken,
      path: targetPath,
      uploadid: pre.uploadid
    })
    if (!locateRes?.success || !locateRes.data) {
      throw new Error(locateRes?.error || '获取上传域名失败')
    }
    const locate = locateRes.data

    // 获取上传域名（类型安全处理）
    const locateData = locate as {
      host?: string
      servers?: Array<{ server?: string }>
      server?: string[]
    }
    const httpsDomains: string[] = [
      ...(Array.isArray(locateData.servers)
        ? locateData.servers.map((e) => e.server || '').filter(Boolean)
        : []),
      ...(Array.isArray(locateData.server) ? locateData.server : [])
    ].filter((d: string) => typeof d === 'string' && d.startsWith('https://'))
    const host =
      httpsDomains[0] ||
      locateData.host ||
      (Array.isArray(locateData.servers) && locateData.servers[0]?.server) ||
      ''

    if (!host) {
      throw new Error('未获取到有效上传域名')
    }

    // 3. 上传文件（通过IPC，主进程读取文件并分片上传）
    const uploadId = `upload-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const uploadRes = await window.api.baiduYun.uploadFile({
      accessToken,
      localPath: filePath,
      remotePath: targetPath,
      uploadid: pre.uploadid,
      host,
      uploadId,
      blockSize: chunkSize
    })
    if (!uploadRes?.success) {
      throw new Error(uploadRes?.error || '分片上传失败')
    }

    // 4. 创建文件（通过IPC）
    const createRes = await window.api.baiduYun.create({
      accessToken,
      path: targetPath,
      size: fileSize,
      isdir: 0,
      blockList,
      uploadid: pre.uploadid,
      rtype: 0
    })
    if (!createRes?.success) {
      throw new Error(createRes?.error || '创建文件失败')
    }

    // message.success(`已上传到百度网盘: ${fileName}`)
    return true
  } catch (err) {
    console.error('上传到百度网盘失败:', err)
    message.error(
      t('baiduyunFileList.messages.uploadFailedWithError', { error: (err as Error).message })
    )
    return false
  }
}

/**
 * 从资产库拖入百度网盘的放置处理
 */
async function handleDropFromAssetLib(e: DragEvent): Promise<void> {
  if (dropDragLeaveTimer) {
    clearTimeout(dropDragLeaveTimer)
    dropDragLeaveTimer = null
  }
  isDropTarget.value = false

  // 检查是否有资产库数据
  const assetData = e.dataTransfer?.getData('application/x-asset-items')

  if (assetData) {
    try {
      const parsed = JSON.parse(assetData) as {
        source: string
        items: Array<{
          id: string
          name: string
          path: string
          type: string
          assetType?: string
        }>
      }

      if (
        parsed.source !== 'assetlib' ||
        !Array.isArray(parsed.items) ||
        parsed.items.length === 0
      ) {
        return
      }

      message.info(
        t('baiduyunFileList.messages.uploadStartToBaiduyun', { count: parsed.items.length })
      )

      let successCount = 0
      for (const item of parsed.items) {
        const targetPath = getBaiduyunTargetPath(item.assetType, item.name)
        const success = await uploadFileToBaiduyun(item.path, targetPath)
        if (success) successCount++
      }

      if (successCount > 0) {
        // 刷新文件列表
        await handleFetchInternal()
      }
    } catch (err) {
      console.error('处理资产库拖拽数据失败:', err)
      message.error(t('baiduyunFileList.messages.dragDataProcessFailed'))
    }
    return
  }

  // 检查是否有本地文件（通过系统文件拖拽）
  const files = e.dataTransfer?.files
  if (files && files.length > 0) {
    message.info(t('baiduyunFileList.messages.uploadStartToBaiduyun', { count: files.length }))

    let successCount = 0
    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      try {
        const filePath = await window.api.getPathForFile(file)
        if (filePath) {
          const targetPath = getBaiduyunTargetPath(undefined, file.name)
          const success = await uploadFileToBaiduyun(filePath, targetPath)
          if (success) successCount++
        }
      } catch (err) {
        console.error('获取文件路径失败:', err)
      }
    }

    if (successCount > 0) {
      await handleFetchInternal()
    }
    return
  }
}
</script>

<style scoped lang="less">
.list-card {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  height: 100%;

  .file-content {
    flex: 1;
    height: 100%;
    padding: var(--space-3);
    overflow-y: auto;
    overflow-x: hidden;
    background: var(--color-bg-page);
    transition:
      background 0.2s ease,
      box-shadow 0.2s ease;

    // 拖拽目标激活状态
    &.drop-target-active {
      background: var(--color-accent-bg);
      box-shadow: inset 0 0 0 2px var(--color-accent-border);
    }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 200px;
      color: var(--color-text-muted);

      .empty-icon {
        font-size: 48px;
        margin-bottom: 16px;
        opacity: 0.6;
      }

      .empty-text {
        font-size: 16px;

        margin-bottom: 8px;
      }

      .empty-desc {
        font-size: 14px;
        opacity: 0.8;
      }
    }

    .file-content-wrapper {
      .folder-section,
      .asset-section {
        margin-bottom: var(--space-4);

        &:last-child {
          margin-bottom: 0;
        }

        .section-header {
          padding: var(--space-2) 0;
          margin-bottom: var(--space-3);
          border-bottom: 1px solid var(--color-border-subtle);

          .section-title {
            font-size: 12px;
            font-weight: 600;
            color: var(--color-text-secondary);
            text-transform: uppercase;
            letter-spacing: 0.5px;
          }
        }
      }
    }

    .file-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: var(--space-3);

      .file-item {
        display: flex;
        flex-direction: column;
        padding: 12px;
        border-radius: 8px;
        background: transparent; // 默认透明背景
        border: 1px solid transparent; // 默认透明边框
        cursor: pointer;
        transition: all 0.2s ease;
        -webkit-user-drag: element;

        &:hover {
          background: var(--color-bg-surface-hover);
          border-color: var(--color-border-subtle);
          box-shadow: 0 4px 12px var(--shadow-color-weak);
        }

        .file-icon {
          display: flex;
          align-items: center;
          justify-content: center;
          height: 80px;
          margin-bottom: 8px;
          overflow: hidden;

          .folder-icon-wrapper {
            .folder-icon {
              font-size: 64px;
              color: var(--color-folder);
              filter: drop-shadow(0 2px 4px var(--shadow-color-weak));
            }
          }

          .thumb-wrapper {
            width: 100%;
            height: 100%;
            display: flex;
            align-items: center;
            justify-content: center;

            .file-thumb {
              width: 100%;
              height: 100%;
              object-fit: contain;
              border-radius: 4px;
            }
          }

          .solid-icon-wrapper {
            font-size: 48px;
            color: var(--color-text-secondary);
            opacity: 0.8;
            background: var(--color-bg-surface);
            width: 60px;
            height: 70px;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 4px;
            box-shadow: 0 2px 4px var(--shadow-color-weak);
          }
        }

        .file-info {
          width: 100%;
          text-align: center;

          .file-name {
            font-size: 13px;
            font-weight: 500;
            color: var(--color-text-primary);
            margin-bottom: 4px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
          }

          .inline-rename-input {
            width: 100%;
            max-width: 120px;
            padding: 2px 6px;
            font-size: 12px;
            border: 1px solid var(--color-border);
            border-radius: 4px;
            background: var(--color-bg-surface);
            color: var(--color-text-primary);
            outline: none;

            &:focus {
              box-shadow: 0 0 0 2px var(--color-accent-border);
            }
          }

          .file-meta {
            font-size: 11px;
            color: var(--color-text-muted);
            display: flex;
            align-items: center;
            justify-content: center;
            gap: var(--space-2);

            .file-size {
              margin-right: var(--space-2);
            }

            .file-date {
              display: inline-block;
              max-width: 100%;
              white-space: nowrap;
              overflow: hidden;
              text-overflow: ellipsis;
            }
          }
        }

        .item-actions {
          margin-top: var(--space-2);
          width: 100%;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        // 文件夹特殊样式
        .folder-item {
          &:hover {
            border-color: var(--color-border-strong);
            background: var(--color-bg-surface-hover);
          }
        }

        // 文件特殊样式
        .asset-item {
          // 文件样式
        }

        &.file-item-selected {
          background-color: var(--color-bg-selected) !important;
          border-color: var(--color-border) !important;
          box-shadow:
            0 0 0 1px var(--color-accent-border),
            0 4px 12px var(--shadow-color-weak) !important;

          .file-name {
            color: var(--color-text-primary);
            font-weight: 600;
          }
        }

        .file-icon {
          position: relative;

          .favorite-icon {
            position: absolute;
            top: -2px;
            right: -2px;
            font-size: 12px;
            color: var(--color-warning-text);
            z-index: 3;
            background: var(--color-bg-page);
            border-radius: 50%;
            padding: 1px;
          }
        }

        &.file-item-selectable {
          user-select: none;
          cursor: pointer;
          position: relative;

          &::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            z-index: 1;
            pointer-events: none;
          }
        }

        &.file-item-hover {
          border-color: var(--color-accent-border);
          background: var(--color-accent-bg);
          transform: scale(1.02);
        }

        /* 下载蒙层样式 */
        .download-overlay {
          position: absolute;
          inset: 0;
          background: var(--color-bg-surface-hover);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 5;
          border-radius: var(--radius-xs);
          backdrop-filter: saturate(120%) blur(2px);

          .overlay-content {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 8px;
            color: var(--color-text-primary);

            .overlay-speed {
              font-size: 12px;
              opacity: 0.95;
              font-variant-numeric: tabular-nums;
            }
          }
        }
      }
    }
  }
}

:deep(.ds-selector) {
  background: var(--color-accent-bg);
  border: 1px solid var(--color-accent-border);
  border-radius: var(--radius-xs);
}

.file-content {
  position: relative;
}
</style>

<!-- 非 scoped 样式块，用于 Teleport 到 body 的元素 -->
<style lang="less">
// 百度网盘拖拽浮层样式（不使用 scoped，因为元素被 Teleport 到 body）
.baiduyun-drag-overlay {
  position: fixed;
  z-index: 10000;
  pointer-events: none;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: var(--radius-xs, 8px);
  font-size: 12px;
  line-height: 1.4;
  color: var(--color-text-primary);
  background: linear-gradient(180deg, var(--color-bg-surface), var(--color-bg-surface));
  border: 1px solid var(--color-border-subtle);
  box-shadow: 0 8px 24px var(--shadow-color);
  white-space: nowrap;
  backdrop-filter: saturate(120%) blur(6px);
  transform: translateZ(0);

  &::before {
    content: '';
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--color-accent-solid);
    box-shadow: 0 0 0 3px var(--color-accent-border);
  }
}
</style>
