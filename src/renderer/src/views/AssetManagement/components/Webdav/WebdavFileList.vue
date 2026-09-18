<template>
  <div
    class="webdav-file-list"
    @dragenter.prevent="handleDragEnter"
    @dragover.prevent="handleDragOver"
    @dragleave.prevent="handleDragLeave"
    @drop.prevent="handleDrop"
  >
    <div class="file-content" @click="handleEmptyClick">
      <AppSpin :spinning="loading">
        <div v-if="fileList.length === 0 && !loading" class="empty-state">
          <div class="empty-icon">☁️</div>
          <div class="empty-text">{{ $t('webdavFileList.emptyText') }}</div>
          <div class="empty-desc">
            <span>{{ $t('webdavFileList.emptyDesc') }}</span>
          </div>
        </div>
        <div v-else class="file-content-wrapper">
          <!-- 文件夹区域 -->
          <div v-if="folderFiles.length > 0" class="folder-section">
            <div class="section-header">
              <span class="section-title">{{
                $t('webdavFileList.folderSectionTitle', { count: folderFiles.length })
              }}</span>
            </div>
            <div class="file-grid" :style="gridStyle">
              <div
                v-for="file in folderFiles"
                :key="file.filename"
                class="file-item folder-item"
                :class="{ 'file-item-selected': isSelected(file) }"
                @click="handleItemClick(file, $event)"
                @dblclick="handleItemDoubleClick(file)"
                @contextmenu="handleRightClick($event, file)"
              >
                <div class="file-icon">
                  <div class="folder-icon-wrapper">
                    <PhFolder weight="fill" class="folder-icon" />
                  </div>
                </div>
                <div class="file-info">
                  <div class="file-name" :title="file.basename">{{ file.basename }}</div>
                  <div class="file-meta">
                    <span class="file-date">{{ formatDate(file.lastmod) }}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- 文件区域 -->
          <div v-if="assetFiles.length > 0" class="asset-section">
            <div class="section-header">
              <span class="section-title">{{
                $t('webdavFileList.fileSectionTitle', { count: assetFiles.length })
              }}</span>
            </div>
            <div class="file-grid" :style="gridStyle">
              <div
                v-for="file in assetFiles"
                :key="file.filename"
                class="file-item asset-item"
                :class="{ 'file-item-selected': isSelected(file), dragging: isDraggingFile(file) }"
                draggable="true"
                @click="handleItemClick(file, $event)"
                @contextmenu="handleRightClick($event, file)"
                @dragstart="handleFileDragStart($event, file)"
                @drag="handleFileDrag"
                @dragend="handleFileDragEnd"
              >
                <div class="file-icon">
                  <div class="solid-icon-wrapper">
                    <PhFile />
                  </div>
                </div>
                <div class="file-info">
                  <div class="file-name" :title="file.basename">{{ file.basename }}</div>
                  <div class="file-meta">
                    <span class="file-size">{{ formatFileSize(file.size) }}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </AppSpin>
    </div>

    <!-- 右键菜单 -->
    <ContextMenu
      ref="contextMenuRef"
      :menu-items="currentContextMenuItems"
      @click="handleContextMenuClick"
    />

    <!-- 拖拽覆盖层 -->
    <DragDropOverlay :visible="isDragging" />

    <!-- 文件拖拽覆盖层 -->
    <Teleport to="body">
      <div
        v-if="fileDragState.visible"
        class="webdav-file-drag-overlay"
        :style="{ left: fileDragState.x + 'px', top: fileDragState.y + 'px' }"
      >
        <div class="drag-icon">
          <!-- 不写死白色：浮层底是 --color-bg-surface，浅色主题下是纯白 -->
          <PhDownloadSimple style="font-size: 16px" />
        </div>
        <span class="drag-text">{{ fileDragState.text }}</span>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import AppSpin from '@renderer/components/AppSpin.vue'
import { ref, onMounted, watch, computed, reactive, h } from 'vue'
import { message } from '@/utils/messageManager'
import { Input } from 'ant-design-vue'
import { confirmDialog } from '@renderer/utils/dialog'
import { useI18n } from 'vue-i18n'
import { PhDownloadSimple, PhFile, PhFolder, PhPencilSimple, PhTrash } from '@phosphor-icons/vue'
import { useWebdavStore } from '@renderer/store/modules/webdav'
import { ContextMenu, type MenuItem } from '@renderer/components/ContextMenu'
import DragDropOverlay from '@renderer/components/DragDropOverlay.vue'
import assetFolderAPI from '@renderer/api/assetFolder'
import assetDataAPI from '@renderer/api/assetData'
import { useAssetSelectionStore } from '@renderer/store/modules/assetSelectionStore'

/**
 * WebDav文件信息接口
 */
interface WebDavFile {
  filename: string
  basename: string
  type: 'file' | 'directory'
  size: number
  lastmod: string
}

const webdavStore = useWebdavStore()
const { t } = useI18n()
const selectionStore = useAssetSelectionStore()
const emit = defineEmits(['files-dropped'])

const fileList = ref<WebDavFile[]>([])
const loading = ref(false)
const contextMenuRef = ref()
const currentRightClickFile = ref<WebDavFile | null>(null)
const selectedFiles = ref<Set<string>>(new Set())
const isDragging = ref(false)
let dragCounter = 0

const getPathSep = (base: string): string => (base.includes('\\') ? '\\' : '/')

async function ensureDir(targetDir: string) {
  await (window as any).api.invoke('fs:ensureDir', targetDir)
}

/**
 * 确保 WebDAV 文件夹存在
 * 如果不存在则创建，用于存放从 WebDAV 下载的文件
 */
const ensureWebdavFolder = async (): Promise<{ folderKey: string; fullPath: string }> => {
  const WEBDAV_NAME = 'WebDAV'
  try {
    const siblings = await assetFolderAPI.getByFatherKey('ALL')
    const found = (siblings || []).find((f: any) => f.folderName === WEBDAV_NAME)
    if (found) {
      const fullPath = found.fullPath || `/ALL/${WEBDAV_NAME}`.replace(/\/{2,}/g, '/')
      return { folderKey: found.folderKey, fullPath }
    }
  } catch (e) {
    console.warn('读取ALL子文件夹失败，尝试创建 WebDAV 文件夹', e)
  }

  const folderKey = `folder_${Date.now()}`
  try {
    await assetFolderAPI.create({
      folderKey,
      fatherKey: 'ALL',
      folderName: WEBDAV_NAME,
      type: 'normal',
      img: ''
    } as any)
  } catch (e) {
    console.warn('创建 WebDAV 文件夹失败，使用ALL作为兜底', e)
    return { folderKey: 'ALL', fullPath: '/ALL' }
  }

  return {
    folderKey,
    fullPath: `/ALL/${WEBDAV_NAME}`.replace(/\/{2,}/g, '/')
  }
}

async function resolveVaultTargetDir(): Promise<{ targetDir: string; folderKey?: string }> {
  const result = await (window as any).api.invoke('vault:getCurrentPath')
  if (!result?.success || !result.path) {
    throw new Error('未选择本地资产库，请先在资产库页选择一个保管库')
  }
  const vaultPath: string = result.path
  const sep = getPathSep(vaultPath)
  let folderKey = selectionStore.selectedTreeKey || null
  let folderFullPath: string | null = null
  if (!folderKey) {
    const ensured = await ensureWebdavFolder()
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
    // fallback to assetData root
  }
  const targetDir = `${vaultPath}${sep}${relative}`
  return { targetDir, folderKey }
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

// 拖拽处理
const handleDragEnter = (e: DragEvent) => {
  e.stopPropagation()
  // 只有当拖入的是外部文件时才显示上传覆层
  // 排除掉我们自定义的 WebDAV 拖拽类型，防止在拖出文件时触发自己的上传覆层
  const types = e.dataTransfer?.types || []
  const isExternalFile = types.includes('Files') && !types.includes('application/json')

  dragCounter++
  if (isExternalFile) {
    isDragging.value = true
  }
}

const handleDragOver = (e: DragEvent) => {
  e.stopPropagation()
  // 必须阻止默认行为才能触发 drop
  e.preventDefault()
}

const handleDragLeave = (e: DragEvent) => {
  e.stopPropagation()
  dragCounter--
  if (dragCounter === 0) {
    isDragging.value = false
  }
}

const handleDrop = (e: DragEvent) => {
  e.stopPropagation()
  e.preventDefault()
  isDragging.value = false
  dragCounter = 0

  // 只有外部文件才触发上传
  const types = e.dataTransfer?.types || []
  if (types.includes('Files') && !types.includes('application/json')) {
    const files = e.dataTransfer?.files
    if (files && files.length > 0) {
      emit('files-dropped', Array.from(files))
    }
  }
}

// ========== 文件拖拽到本地资产库的处理 ==========

/**
 * 文件拖拽状态
 */
const fileDragState = reactive({
  visible: false,
  text: '',
  x: 0,
  y: 0
})

const draggingFile = ref<any | null>(null)

/**
 * 创建空白canvas用于隐藏默认拖拽图像
 */
const emptyCanvas = document.createElement('canvas')
emptyCanvas.width = 1
emptyCanvas.height = 1

/**
 * 检查文件是否正在被拖拽
 */
function isDraggingFile(file: any): boolean {
  return draggingFile.value?.filename === file.filename
}

/**
 * 处理文件拖拽开始
 */
function handleFileDragStart(event: DragEvent, file: any): void {
  if (!event.dataTransfer) return

  draggingFile.value = file

  // 将WebDav文件信息存储到dataTransfer中
  const webdavFileData = {
    type: 'webdav-file',
    serverUrl: webdavStore.connection?.serverUrl,
    username: webdavStore.connection?.username,
    password: webdavStore.connection?.password,
    remotePath: file.filename,
    basename: file.basename || file.filename.split('/').pop(),
    size: file.size
  }

  event.dataTransfer.setData('application/json', JSON.stringify(webdavFileData))
  event.dataTransfer.effectAllowed = 'copy'

  // 隐藏默认拖拽图像
  event.dataTransfer.setDragImage(emptyCanvas, 0, 0)

  // 显示自定义拖拽覆盖层
  fileDragState.text = t('webdavFileList.dragOverlay.downloadTo', {
    name: file.basename || file.filename
  })
  fileDragState.x = event.clientX + 12
  fileDragState.y = event.clientY + 12
  fileDragState.visible = true
}

/**
 * 处理文件拖拽移动
 */
function handleFileDrag(event: DragEvent): void {
  // 过滤掉拖拽结束时的(0,0)事件
  if (event.clientX === 0 && event.clientY === 0) return

  if (fileDragState.visible) {
    fileDragState.x = event.clientX + 12
    fileDragState.y = event.clientY + 12
  }
}

/**
 * 处理文件拖拽结束
 */
function handleFileDragEnd(): void {
  fileDragState.visible = false
  draggingFile.value = null
}

// 网格大小
const gridItemSize = computed(() => 120)

const gridStyle = computed(() => {
  return {
    gridTemplateColumns: `repeat(auto-fill, minmax(${gridItemSize.value}px, 1fr))`
  }
})

// 分离文件夹和文件
const folderFiles = computed(() => {
  return fileList.value.filter((file) => file.type === 'directory')
})

const assetFiles = computed(() => {
  return fileList.value.filter((file) => file.type === 'file')
})

const isSelected = (file: any) => {
  return selectedFiles.value.has(file.filename)
}

const handleItemClick = (file: any, event: MouseEvent) => {
  // 如果按住 Ctrl，进行多选
  if (event.ctrlKey || event.metaKey) {
    if (selectedFiles.value.has(file.filename)) {
      selectedFiles.value.delete(file.filename)
    } else {
      selectedFiles.value.add(file.filename)
    }
  } else {
    // 单选
    selectedFiles.value.clear()
    selectedFiles.value.add(file.filename)
  }
}

// 点击空白区域清除选中
const handleEmptyClick = (event: MouseEvent) => {
  if (event.target === event.currentTarget) {
    selectedFiles.value.clear()
  }
}

// 右键菜单项
const fileMenuItems: MenuItem[] = [
  {
    key: 'download',
    label: t('webdavFileList.contextMenu.download'),
    icon: PhDownloadSimple
  },
  {
    key: 'rename',
    label: t('webdavFileList.contextMenu.rename'),
    icon: PhPencilSimple
  },
  {
    key: 'divider-1',
    label: '',
    type: 'divider'
  },
  {
    key: 'delete',
    label: t('webdavFileList.contextMenu.delete'),
    icon: PhTrash,
    danger: true
  }
]

const currentContextMenuItems = computed(() => {
  return fileMenuItems
})

const loadDirectoryContents = async () => {
  if (!webdavStore.connection) {
    return
  }

  loading.value = true
  try {
    const result = await (window as any).api.webdav.getDirectoryContents({
      serverUrl: webdavStore.connection.serverUrl,
      username: webdavStore.connection.username,
      password: webdavStore.connection.password,
      path: webdavStore.currentDir
    })

    if (result.success) {
      fileList.value = result.data || []
    } else {
      message.error(result.error || t('webdavFileList.messages.loadFailed'))
    }
  } catch (error) {
    console.error('加载目录失败:', error)
    message.error(t('webdavFileList.messages.loadFailed'))
  } finally {
    loading.value = false
  }
}

const refresh = () => {
  loadDirectoryContents()
}

const handleItemDoubleClick = (file: any) => {
  if (file.type === 'directory') {
    webdavStore.setCurrentDir(file.filename)
  }
}

const handleRightClick = (event: MouseEvent, file: any) => {
  event.preventDefault()
  event.stopPropagation()

  currentRightClickFile.value = file
  contextMenuRef.value?.show(event.clientX, event.clientY)
}

const handleContextMenuClick = async (key: string) => {
  if (!currentRightClickFile.value) return

  if (key === 'download') {
    await handleDownload(currentRightClickFile.value)
  } else if (key === 'delete') {
    await handleDelete(currentRightClickFile.value)
  } else if (key === 'rename') {
    handleRename(currentRightClickFile.value)
  }

  currentRightClickFile.value = null
}

/**
 * 重命名 WebDAV 文件
 */
const handleRename = (file: WebDavFile | null) => {
  if (!file || !webdavStore.connection) return

  let newName = file.basename
  confirmDialog({
    title: t('webdavFileList.rename.title'),
    icon: h(PhPencilSimple),
    content: () =>
      h(Input, {
        defaultValue: file.basename,
        onChange: (e: any) => {
          newName = e.target.value
        },
        onKeypress: (e: KeyboardEvent) => {
          if (e.key === 'Enter') {
            const okBtn = document.querySelector(
              '.ant-modal-confirm-btns .app-button--primary'
            ) as HTMLElement
            okBtn?.click()
          }
        },
        style: { marginTop: '16px' },
        placeholder: t('webdavFileList.rename.placeholder'),
        autoFocus: true
      }),
    okText: t('webdavFileList.rename.okText'),
    cancelText: t('webdavFileList.rename.cancelText'),
    async onOk() {
      if (!newName || newName === file.basename) return

      try {
        message.loading({ content: t('webdavFileList.rename.renaming'), key: 'webdav-rename' })

        // 构建目标路径：当前目录 + 新文件名
        // 注意：WebDAV 的 filename 通常是完整路径
        const dir = file.filename.substring(0, file.filename.lastIndexOf('/') + 1)
        const toPath = `${dir}${newName}`

        const result = await (window as any).api.webdav.moveFile({
          serverUrl: webdavStore.connection!.serverUrl,
          username: webdavStore.connection!.username,
          password: webdavStore.connection!.password,
          fromPath: file.filename,
          toPath: toPath
        })

        if (result.success) {
          message.success({
            content: t('webdavFileList.rename.renameSuccess'),
            key: 'webdav-rename'
          })
          loadDirectoryContents()
        } else {
          message.error({
            content: result.error || t('webdavFileList.rename.renameFailed'),
            key: 'webdav-rename'
          })
        }
      } catch (error) {
        console.error('重命名失败:', error)
        message.error({ content: t('webdavFileList.rename.operationFailed'), key: 'webdav-rename' })
      }
    }
  })
}

const handleDownload = async (record: any) => {
  if (!webdavStore.connection) {
    return
  }

  try {
    // message.loading({ content: '准备下载...', key: 'download' })

    const { targetDir, folderKey } = await resolveVaultTargetDir()
    await ensureDir(targetDir)
    const pickPath = buildUniquePath(targetDir, record.basename || record.filename || 'download')
    const { fullPath } = await pickPath()

    const result = await (window as any).api.webdav.downloadFile({
      serverUrl: webdavStore.connection.serverUrl,
      username: webdavStore.connection.username,
      password: webdavStore.connection.password,
      remotePath: record.filename,
      savePath: fullPath
    })

    if (result.success) {
      await ingestDownloadedFile(fullPath, folderKey)
      message.success({
        content: t('webdavFileList.messages.savedToVault', { path: fullPath }),
        key: 'download'
      })
    } else {
      message.error({
        content: result.error || t('webdavFileList.messages.downloadFailed'),
        key: 'download'
      })
    }
  } catch (error) {
    console.error('下载文件失败:', error)
    const msg = error instanceof Error ? error.message : t('webdavFileList.messages.downloadFailed')
    message.error({ content: msg, key: 'download' })
  }
}

const handleDelete = async (record: any) => {
  if (!webdavStore.connection) {
    return
  }

  try {
    const result = await (window as any).api.webdav.deleteFile({
      serverUrl: webdavStore.connection.serverUrl,
      username: webdavStore.connection.username,
      password: webdavStore.connection.password,
      path: record.filename
    })

    if (result.success) {
      message.success(t('webdavFileList.messages.deleteSuccess'))
      await loadDirectoryContents()
    } else {
      message.error(result.error || t('webdavFileList.messages.deleteFailed'))
    }
  } catch (error) {
    console.error('删除失败:', error)
    message.error(t('webdavFileList.messages.deleteFailed'))
  }
}

const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i]
}

const formatDate = (dateString: string): string => {
  if (!dateString) return '-'
  const date = new Date(dateString)
  return date.toLocaleDateString('zh-CN', {
    month: '2-digit',
    day: '2-digit'
  })
}

watch(
  () => webdavStore.currentDir,
  () => {
    loadDirectoryContents()
  }
)

onMounted(() => {
  loadDirectoryContents()
})

/**
 * 上传单个文件到 WebDAV
 * @param filePath 本地文件路径
 * @param remotePath 远程目标路径
 */
async function uploadFileToWebdav(filePath: string, remotePath: string): Promise<boolean> {
  if (!webdavStore.connection) {
    return false
  }
  try {
    const fileBufferResult = await (window as any).api.fs.readFileBuffer(filePath)
    if (!fileBufferResult?.success || !fileBufferResult.data) {
      throw new Error(fileBufferResult?.error || '读取文件失败')
    }

    const result = await (window as any).api.webdav.uploadFile({
      serverUrl: webdavStore.connection.serverUrl,
      username: webdavStore.connection.username,
      password: webdavStore.connection.password,
      remotePath,
      fileBuffer: fileBufferResult.data
    })

    return result?.success ?? false
  } catch (error) {
    console.error('上传到 WebDAV 失败:', error)
    return false
  }
}

/**
 * 从本地路径上传文件/文件夹到 WebDAV
 * @param localPaths 本地文件或文件夹路径数组
 */
async function uploadLocalPaths(localPaths: string[]): Promise<void> {
  if (!webdavStore.connection) {
    message.error(t('webdavFileList.messages.connectFirst'))
    return
  }
  if (!localPaths || localPaths.length === 0) {
    return
  }

  message.info(t('webdavFileList.messages.uploadStart', { count: localPaths.length }))

  let successCount = 0
  let failCount = 0

  for (const localPath of localPaths) {
    try {
      // 获取文件/文件夹信息
      const stats = await (window as any).api.getFileStats(localPath)
      const isDirectory = stats?.isDirectory ?? false
      const name = localPath.split(/[/\\]/).pop() || 'unknown'

      if (isDirectory) {
        // 文件夹：递归获取所有文件并逐个上传
        const result = await (window as any).api.fs.readFolderContentsRecursive(localPath)
        const contents = Array.isArray(result) ? result : result?.data || []
        const files = contents.filter((item: { type: string }) => item.type === 'file')

        for (const file of files) {
          const relativePath = file.relativePath || file.name
          const remotePath = webdavStore.currentDir.endsWith('/')
            ? `${webdavStore.currentDir}${name}/${relativePath}`
            : `${webdavStore.currentDir}/${name}/${relativePath}`
          const success = await uploadFileToWebdav(file.path, remotePath)
          if (success) successCount++
          else failCount++
        }
      } else {
        // 单个文件
        const remotePath = webdavStore.currentDir.endsWith('/')
          ? `${webdavStore.currentDir}${name}`
          : `${webdavStore.currentDir}/${name}`
        const success = await uploadFileToWebdav(localPath, remotePath)
        if (success) successCount++
        else failCount++
      }
    } catch (error) {
      console.error('上传失败:', localPath, error)
      failCount++
    }
  }

  if (successCount > 0) {
    await loadDirectoryContents()
    message.success(t('webdavFileList.messages.uploadSuccess', { count: successCount }))
  }
  if (failCount > 0) {
    message.warning(t('webdavFileList.messages.uploadFailed', { count: failCount }))
  }
}

defineExpose({
  refresh,
  uploadLocalPaths
})
</script>

<style scoped lang="less">
.webdav-file-list {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--color-bg-page);

  .file-content {
    flex: 1;
    overflow: auto;
    padding: var(--space-3);

    // 空状态
    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      min-height: 300px;

      .empty-icon {
        font-size: 64px;
        margin-bottom: 16px;
        opacity: 0.3;
      }

      .empty-text {
        font-size: 16px;
        font-weight: 500;
        color: var(--color-text-primary);
        margin-bottom: 8px;
      }

      .empty-desc {
        font-size: 14px;
        color: var(--color-text-secondary);
      }
    }

    .file-content-wrapper {
      .folder-section,
      .asset-section {
        margin-bottom: 24px;

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

        .file-grid {
          display: grid;
          gap: 12px;
          grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));

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
              display: flex;
              align-items: center;
              justify-content: center;
              height: 80px;
              margin-bottom: 8px;

              .folder-icon-wrapper {
                .folder-icon {
                  font-size: 64px; // 加大图标
                  color: var(--color-folder); // 文件夹黄色 (参考 Win11 或 AssetFileList)
                  filter: drop-shadow(0 2px 4px var(--shadow-color-weak));
                }
              }

              .solid-icon-wrapper {
                font-size: 48px;
                color: var(--color-text-secondary); // 默认文件图标颜色
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

              .file-meta {
                font-size: 11px;
                color: var(--color-text-secondary);

                .file-date,
                .file-size {
                  display: inline-block;
                }
              }
            }
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
        }
      }
    }
  }
}
</style>
