<template>
  <AppModal
    v-model:open="visible"
    :title="$t('importToProjectModal.title')"
    :width="1040"
    :centered="true"
    :mask-closable="false"
    :destroy-on-close="true"
    :confirm-loading="loading || preparing"
    @cancel="handleCancel"
  >
    <div class="import-project-modal">
      <!-- 「导入什么」是前提，排在「往哪导」的搜索筛选之前 -->
      <p class="source-summary">{{ sourceSummary }}</p>
      <div class="toolbar">
        <div class="toolbar-filters">
          <a-input-search
            v-model:value="keyword"
            :placeholder="$t('importToProjectModal.searchPlaceholder')"
            allow-clear
            :disabled="preparing"
            :aria-label="t('importToProjectModal.searchPlaceholder')"
            class="project-search"
          />
          <a-select
            v-model:value="engineFilter"
            :options="engineOptions"
            :disabled="preparing"
            :aria-label="t('importToProjectModal.engineFilter')"
            class="engine-filter"
          />
        </div>
        <AppButton
          :disabled="preparing || projectsLoading || addingProject"
          :loading="addingProject"
          @click="handleAddProject"
        >
          <template #icon><PhPlus aria-hidden="true" /></template>
          {{ t('importToProjectModal.addProject') }}
        </AppButton>
      </div>
      <p v-if="preparing" class="preparation-status" role="status">
        {{ t('importToProjectModal.preparing') }}
      </p>
      <div v-if="projectsLoading" class="list-status" role="status">
        {{ t('importToProjectModal.loadingProjects') }}
      </div>
      <div v-else-if="loadFailed" class="list-status" role="alert">
        <span>{{ t('importToProjectModal.loadProjectsFailed') }}</span>
        <AppButton @click="loadAllProjects">{{ t('importToProjectModal.retry') }}</AppButton>
      </div>

      <div v-if="loading" class="progress-panel">
        <AppProgress :percent="displayPercent" />
        <!-- 为 0 的那几项不显示：「失败 0」「已存在 0」只是噪声，看的人还得先读懂再忽略 -->
        <div class="progress-meta">
          <span>{{
            $t('importToProjectModal.progress.processed', {
              count: stats.processed,
              total: stats.total
            })
          }}</span>
          <span v-if="stats.success > 0">{{
            $t('importToProjectModal.progress.success', { count: stats.success })
          }}</span>
          <span v-if="stats.existing > 0">{{
            $t('importToProjectModal.progress.existing', { count: stats.existing })
          }}</span>
          <span v-if="stats.error > 0" class="progress-error">{{
            $t('importToProjectModal.progress.error', { count: stats.error })
          }}</span>
        </div>
      </div>

      <!-- 集合就地展开，不进下一层：挑个导入目标不该还要来回钻页面 -->
      <div v-if="!projectsLoading && !loadFailed && sections.length > 0" class="browse-list">
        <template v-for="section in sections" :key="section.kind + section.key">
          <div v-if="section.kind === 'projects'" class="project-grid">
            <ImportProjectCard
              v-for="item in section.projects"
              :key="item.projectKey"
              :project="item"
              :image="getProjectImage(item)"
              :version-label="engineTag(item.EngineAssociation)"
              :connected="isProjectConnected(item.projectPath)"
              :selected="selectedProjectKey === item.projectKey"
              :disabled="preparing"
              @select="handleSelect"
            />
          </div>
          <section v-else class="collection-group" :class="{ open: isCollectionOpen(section.key) }">
            <button
              type="button"
              class="collection-header"
              :disabled="preparing"
              :aria-expanded="isCollectionOpen(section.key)"
              @click="toggleCollection(section.key)"
            >
              <PhFolder weight="fill" class="collection-icon" aria-hidden="true" />
              <span class="collection-name">{{
                section.collection.name || t('homeProjectCollection.collection.untitled')
              }}</span>
              <span class="collection-count">{{
                t('importToProjectModal.collectionCount', { count: section.projects.length })
              }}</span>
              <PhPushPin v-if="section.pinned" weight="fill" class="collection-pin" />
              <PhCaretDown class="collection-chevron" aria-hidden="true" />
            </button>
            <div v-if="isCollectionOpen(section.key)" class="project-grid collection-members">
              <ImportProjectCard
                v-for="item in section.projects"
                :key="item.projectKey"
                :project="item"
                :image="getProjectImage(item)"
                :version-label="engineTag(item.EngineAssociation)"
                :connected="isProjectConnected(item.projectPath)"
                :selected="selectedProjectKey === item.projectKey"
                :disabled="preparing"
                @select="handleSelect"
              />
            </div>
          </section>
        </template>
      </div>
      <div v-else-if="!projectsLoading && !loadFailed" class="empty-state">
        <AppEmpty
          :description="
            keyword || engineFilter
              ? $t('importToProjectModal.emptyNoMatch')
              : $t('importToProjectModal.emptyNoProjects')
          "
        />
      </div>
    </div>

    <template #footer>
      <div class="modal-footer">
        <!-- TODO: 暂时隐藏规范化导入功能 -->
        <div v-if="false && isPluginReady" style="display: flex; align-items: center; gap: 8px">
          <AppTooltip :title="t('importToProjectModal.importPathTooltip')">
            <a-input
              v-model:value="userImportPath"
              :placeholder="'Imported'"
              :addon-before="t('importToProjectModal.importPathLabel')"
              style="width: 240px"
            />
          </AppTooltip>
          <AppTooltip :title="normalizedImportTooltip">
            <AppButton
              variant="primary"
              :ghost="true"
              :loading="loading"
              :disabled="!selectedProjectKey || !canUseNormalizedImport"
              @click="handleNormalizedImport"
            >
              <template #icon>
                <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                  <path d="M12 2L4 7v10l8 5 8-5V7l-8-5zm0 2.5L18 8v8l-6 3.75L6 16V8l6-3.5z" />
                  <path d="M12 9v6M9 12h6" />
                </svg>
              </template>
              {{ t('importToProjectModal.normalizedImport') }}
            </AppButton>
          </AppTooltip>
        </div>
        <div class="selection-summary" aria-live="polite">
          <ImportTargetSummary
            v-if="selectedProject"
            :key="selectedProject.projectKey"
            :project-key="selectedProject.projectKey"
            :project-name="selectedProject.projectName || t('importToProjectModal.unnamedProject')"
            :compatibility-text="compatibilityText"
            :blocked="compatibilityBlocked"
            :failed="compatibilityFailed"
            @retry="refreshCompatibility"
          />
          <span v-else>{{ t('importToProjectModal.selectProjectFirst') }}</span>
        </div>
        <div class="footer-actions">
          <AppButton @click="handleCancel">{{ t('importToProjectModal.cancel') }}</AppButton>
          <AppButton
            variant="primary"
            :loading="loading || preparing"
            :disabled="!selectedProject || projectsLoading || loadFailed"
            @click="handleConfirm"
            >{{ t('importToProjectModal.startImport') }}</AppButton
          >
        </div>
      </div>
    </template>
  </AppModal>

  <!-- 压缩包处理方式：只在真正要导进工程时才问，往资产库里拖的时候不打扰 -->
  <AppModal
    v-model:open="archiveDialogVisible"
    :title="$t('importToProjectModal.archive.title')"
    :width="520"
  >
    <div class="archive-choice">
      <p>{{ $t('importToProjectModal.archive.question', { name: archiveAssetName }) }}</p>
      <p class="archive-hint">{{ $t('importToProjectModal.archive.extractOption') }}</p>
      <p class="archive-hint">{{ $t('importToProjectModal.archive.copyOption') }}</p>
      <div class="archive-remember">
        <AppCheckbox v-model:checked="archiveDontAskAgain">
          {{ $t('importToProjectModal.archive.dontAskAgain') }}
        </AppCheckbox>
      </div>
    </div>
    <template #footer>
      <div class="modal-footer">
        <div style="flex: 1">
          <AppButton @click="archiveDialogVisible = false">
            {{ $t('importToProjectModal.cancel') }}
          </AppButton>
          <AppButton @click="chooseArchiveAction('copy')">
            {{ $t('importToProjectModal.archive.copyAction') }}
          </AppButton>
          <AppButton variant="primary" @click="chooseArchiveAction('extract')">
            {{ $t('importToProjectModal.archive.extractAction') }}
          </AppButton>
        </div>
      </div>
    </template>
  </AppModal>
</template>

<script setup lang="ts">
import ImportTargetSummary from './ImportTargetSummary.vue'
import ImportProjectCard from './ImportProjectCard.vue'
import { PhPushPin, PhCaretDown, PhFolder, PhPlus } from '@phosphor-icons/vue'
import {
  importProjectChoices,
  importBrowserEntries,
  importProjectConnection,
  type ImportBrowserEntry,
  type ImportProjectChoice
} from '../../utils/importProjectChoices'
import { summarizeBlockedAssets, type BlockedAsset } from '../../utils/blockedAssetsSummary'
import { checkImportCompatibility, getImportProjectCollections } from '@renderer/api/projectImport'
import AppProgress from '@renderer/components/AppProgress.vue'
import AppEmpty from '@renderer/components/AppEmpty.vue'
import AppModal from '@renderer/components/AppModal.vue'
import AppTooltip from '@renderer/components/AppTooltip.vue'
import AppButton from '@renderer/components/AppButton.vue'
import AppCheckbox from '@renderer/components/AppCheckbox.vue'
import { ref, watch, onMounted, onUnmounted, computed, reactive, h, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { useProjects } from '@renderer/hooks/useProjects'
import { useConnectedProjects } from '@renderer/composables/useBridgeStatus'
import { useEngineVersionLabel } from '@renderer/hooks/useEngineVersionLabel'
import { useVaultStore } from '@renderer/store/modules/vaultStore'
import { message } from '@renderer/utils/messageManager'
import { confirmDialog, warningDialog, type DialogHandle } from '@renderer/utils/dialog'
import { isCleanImportReport, type ImportFailureReport } from '@core/shared/projectImport'

const { t } = useI18n()
// 浏览器兼容的路径辅助函数（替代 Node.js path 模块）
const getExtname = (filePath: string): string => {
  const lastDot = filePath.lastIndexOf('.')
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  if (lastDot > lastSlash && lastDot !== -1) {
    return filePath.substring(lastDot)
  }
  return ''
}

const getBasename = (filePath: string): string => {
  const normalized = filePath.replace(/\\/g, '/')
  const parts = normalized.split('/')
  return parts[parts.length - 1] || ''
}

const joinPath = (...parts: string[]): string => {
  return parts.join('/').replace(/\/+/g, '/')
}

/** 判断路径是否为绝对路径（Windows 驱动器号或 UNC 路径） */
const isAbsolutePath = (p: string): boolean => {
  return /^[a-zA-Z]:/.test(p) || p.startsWith('\\\\') || p.startsWith('//')
}

type ProjectRecord = {
  projectKey: string
  projectName?: string | null
  projectPath?: string | null
  originPath?: string | null
  EngineAssociation?: string | null
  id?: number
  isPinned?: number | null
  projectData?: string | null
  projectConfig?: string | null
  image?: string | null
  note?: string | null
  sort_order?: number | null
  created_at?: string
  updated_at?: string
}

/**
 * 需要通过 UE 插件 Import API 导入的外部文件扩展名
 * - 音频文件会导入为 Sound Wave
 * - 视频文件会导入为 File Media Source
 */
const EXTERNAL_FILE_EXTENSIONS = new Set([
  // 3D 模型
  'fbx',
  'obj',
  'glb',
  'gltf',
  // 贴图
  'png',
  'jpg',
  'jpeg',
  'tga',
  'exr',
  'hdr',
  'bmp',
  'tiff',
  // 音频 → Sound Wave
  'wav',
  'mp3',
  'ogg',
  'flac',
  // 视频 → File Media Source
  'mp4',
  'mov',
  'avi',
  'wmv',
  'mkv',
  'webm',
  // 其他
  'abc',
  'ply',
  'stl',
  'usd',
  'usda',
  'usdc',
  'usdz'
])

/**
 * 原生媒体文件扩展名 - 可直接导入资产库，不需要UE转换
 * 包括：视频、音频、常见图片格式
 */
const NATIVE_MEDIA_EXTENSIONS = new Set([
  // 视频
  'mp4',
  'mov',
  'avi',
  'wmv',
  'mkv',
  'webm',
  // 音频
  'wav',
  'mp3',
  'ogg',
  'flac',
  // 常见图片（Web/通用格式）
  'png',
  'jpg',
  'jpeg',
  'bmp',
  'gif',
  'webp'
])

/**
 * 需要 UE 转换的外部文件扩展名
 * 这些文件需要通过 UE 插件才能转换为 .uasset
 */
const UE_CONVERSION_EXTENSIONS = new Set([
  // 3D 模型
  'fbx',
  'obj',
  'glb',
  'gltf',
  'abc',
  'ply',
  'stl',
  'usd',
  'usda',
  'usdc',
  'usdz',
  // 专业贴图格式
  'tga',
  'exr',
  'hdr',
  'tiff',
  'psd',
  'dds'
])

/**
 * 判断资产是否为原生媒体文件（可直接导入，不需要UE转换）
 */
const isNativeMediaFile = (asset: { assetName?: string; fileExtension?: string }): boolean => {
  const ext = String(asset.fileExtension || '')
    .toLowerCase()
    .replace('.', '')
  if (NATIVE_MEDIA_EXTENSIONS.has(ext)) return true
  const name = String(asset.assetName || '').toLowerCase()
  return Array.from(NATIVE_MEDIA_EXTENSIONS).some((e) => name.endsWith('.' + e))
}

/**
 * 判断资产是否需要 UE 转换（FBX/TGA 等专业格式）
 */
const isUEConversionRequired = (asset: { assetName?: string; fileExtension?: string }): boolean => {
  const ext = String(asset.fileExtension || '')
    .toLowerCase()
    .replace('.', '')
  if (UE_CONVERSION_EXTENSIONS.has(ext)) return true
  const name = String(asset.assetName || '').toLowerCase()
  return Array.from(UE_CONVERSION_EXTENSIONS).some((e) => name.endsWith('.' + e))
}

/**
 * 判断资产是否为外部文件（需要通过 UE Import API 导入）
 */
const isExternalFile = (asset: { assetName?: string; fileExtension?: string }): boolean => {
  const ext = String(asset.fileExtension || '')
    .toLowerCase()
    .replace('.', '')
  if (EXTERNAL_FILE_EXTENSIONS.has(ext)) return true
  const name = String(asset.assetName || '').toLowerCase()
  return Array.from(EXTERNAL_FILE_EXTENSIONS).some((e) => name.endsWith('.' + e))
}

/**
 * 判断资产是否为虚幻资产（.uasset/.umap）
 */
const isUnrealAsset = (asset: {
  assetName?: string
  fileExtension?: string
  softPath?: string
  classKey?: string
}): boolean => {
  const nameLower = String(asset.assetName || '').toLowerCase()
  const extLower = String(asset.fileExtension || '').toLowerCase()
  const softPath = String(asset.softPath || '')
  const classKey = String(asset.classKey || '')
  return (
    softPath.startsWith('/Game') ||
    nameLower.endsWith('.uasset') ||
    nameLower.endsWith('.umap') ||
    extLower === 'uasset' ||
    extLower === 'umap' ||
    classKey === 'uasset' ||
    classKey === 'umap'
  )
}

/**
 * 检查 UE 是否已连接
 */
const isUprojectAsset = (asset: {
  assetName?: string
  fileExtension?: string
  classKey?: string
}): boolean => {
  const nameLower = String(asset.assetName || '').toLowerCase()
  const extLower = String(asset.fileExtension || '')
    .toLowerCase()
    .replace('.', '')
  const classKey = String(asset.classKey || '').toLowerCase()
  return nameLower.endsWith('.uproject') || extLower === 'uproject' || classKey === 'uproject'
}

const standardProjectRootCache = new Map<string, Promise<boolean>>()
const standardProjectImportFolderCache = new Map<string, Promise<boolean>>()

const validateStandardUEProjectRootFolder = async (folderKey: string): Promise<boolean> => {
  if (!folderKey) return false

  const cached = standardProjectRootCache.get(folderKey)
  if (cached) {
    return cached
  }

  const detection = (async () => {
    try {
      const [foldersResp, assetsResp] = await Promise.all([
        (window as any).api.database.assetFolder.getByFatherKey(folderKey),
        (window as any).api.database.assetData.getByFolderKeyRecursive(folderKey)
      ])

      const folders = (foldersResp?.success ? foldersResp.data : []) || []
      const assets = (assetsResp?.success ? assetsResp.data : []) || []

      const hasContentFolder = (folders as any[]).some((folder) => {
        const folderName = String(folder?.folderName || folder?.name || '')
          .trim()
          .toLowerCase()
        return folderName === 'content'
      })
      const uprojectCount = (assets as any[]).filter((asset) => isUprojectAsset(asset)).length

      return hasContentFolder && uprojectCount === 1
    } catch (error) {
      console.warn('[ImportToProjectModal] 标准 UE 工程根目录检测失败:', folderKey, error)
      return false
    }
  })()

  standardProjectRootCache.set(folderKey, detection)
  return detection
}

const isStandardUEProjectImportFolder = async (folderKey: string): Promise<boolean> => {
  if (!folderKey) return false

  const cached = standardProjectImportFolderCache.get(folderKey)
  if (cached) {
    return cached
  }

  const detection = (async () => {
    try {
      const folderResp = await (window as any).api.database.assetFolder.getByKey(folderKey)
      const folder = folderResp?.success ? folderResp.data : null
      if (!folder) return false

      const folderName = String(folder.folderName || folder.name || '')
        .trim()
        .toLowerCase()

      if (folderName === 'content') {
        return await validateStandardUEProjectRootFolder(String(folder.fatherKey || ''))
      }

      return await validateStandardUEProjectRootFolder(folderKey)
    } catch (error) {
      console.warn('[ImportToProjectModal] 标准 UE 导入目录检测失败:', folderKey, error)
      return false
    }
  })()

  standardProjectImportFolderCache.set(folderKey, detection)
  return detection
}

const checkUEConnection = async (): Promise<boolean> => {
  try {
    const connections = await (window as any).api.websocket.getConnections()
    return Array.isArray(connections) && connections.length > 0
  } catch {
    return false
  }
}

/**
 * 获取外部文件类型的描述
 */
const getExternalFileTypesDescription = (assets: any[]): string => {
  const types: Set<string> = new Set()
  for (const a of assets) {
    const ext = String(a?.fileExtension || '')
      .toLowerCase()
      .replace('.', '')
    if (['fbx', 'obj', 'glb', 'gltf'].includes(ext))
      types.add(t('importToProjectModal.fileTypes.model'))
    else if (['png', 'jpg', 'jpeg', 'tga', 'exr', 'hdr', 'bmp', 'tiff'].includes(ext))
      types.add(t('importToProjectModal.fileTypes.texture'))
    else if (['wav', 'mp3', 'ogg', 'flac'].includes(ext))
      types.add(t('importToProjectModal.fileTypes.audio'))
    else if (['mp4', 'mov', 'avi', 'wmv', 'mkv', 'webm'].includes(ext))
      types.add(t('importToProjectModal.fileTypes.video'))
  }
  return Array.from(types).join('、')
}

/**
 * 压缩包扩展名。
 *
 * 往资产库里拖 zip 我们**不问也不解** —— 用户很可能就是想把这个包存起来。
 * 只有他真的要把它导进工程时，「解压还是原样复制」才成为一个需要问的问题。
 */
const ARCHIVE_EXTENSIONS = new Set(['zip', 'rar', '7z'])

/** 记住的处理方式：空 = 每次问；'extract' = 解压后导入；'copy' = 原样复制压缩包 */
const ARCHIVE_ACTION_KEY = 'assetManagement.archiveImportAction'
type ArchiveAction = 'extract' | 'copy'

const readArchiveAction = (): ArchiveAction | null => {
  const stored = localStorage.getItem(ARCHIVE_ACTION_KEY)
  return stored === 'extract' || stored === 'copy' ? stored : null
}

const rememberArchiveAction = (action: ArchiveAction): void => {
  localStorage.setItem(ARCHIVE_ACTION_KEY, action)
  // 偏好设置里的开关要跟着翻过来，不然用户在两个地方看到两个说法
  window.dispatchEvent(
    new CustomEvent('local-storage-change', {
      detail: { key: ARCHIVE_ACTION_KEY, value: action }
    })
  )
}

/** 取压缩包扩展名（小写、不带点），不是压缩包返回空串 */
const getArchiveExtension = (source: {
  assetName?: string
  name?: string
  fileExtension?: string
}): string => {
  const ext = String(source?.fileExtension || '')
    .toLowerCase()
    .replace('.', '')
  if (ARCHIVE_EXTENSIONS.has(ext)) return ext

  const name = String(source?.assetName || source?.name || '').toLowerCase()
  for (const candidate of ARCHIVE_EXTENSIONS) {
    if (name.endsWith(`.${candidate}`)) return candidate
  }
  return ''
}

/**
 * 检测是否为插件类型（插件文件夹或 .uplugin 文件）
 */
const isPluginSource = (source: any): boolean => {
  if (!source) return false
  // 检查文件夹类型
  if (source.folderType === 'plugin') return true
  // 检查 .uplugin 文件
  const ext = String(source.fileExtension || '').toLowerCase()
  if (ext === 'uplugin') return true
  return false
}

/**
 * 资产导入统计信息接口
 */
interface ImportStats {
  unrealCount: number
  nativeMediaCount: number
  ueConversionCount: number
  fileTypesDesc: string
}

/**
 * 显示资产导入选项对话框（三按钮设计）
 * @param stats 资产统计信息
 * @param onImportUnrealOnly 只导入虚幻资产回调
 * @param onImportAllNative 导入全部（保留原生）回调
 */
const showImportOptionsDialog = (
  stats: ImportStats,
  onImportUnrealOnly: () => void,
  onImportAllNative: () => void
): void => {
  const { unrealCount, nativeMediaCount, ueConversionCount, fileTypesDesc } = stats
  const totalExternalCount = nativeMediaCount + ueConversionCount

  // 构建对话框内容
  const contentLines: string[] = []
  contentLines.push(t('importToProjectModal.classifyConfirmTitle'))

  if (unrealCount > 0) {
    contentLines.push(t('importToProjectModal.classifyUnrealCount', { count: unrealCount }))
  }
  if (totalExternalCount > 0) {
    // 合并显示所有外部文件
    const typeDesc = fileTypesDesc || t('importToProjectModal.defaultFileTypesDesc')
    contentLines.push(
      t('importToProjectModal.classifyExternalCount', {
        count: totalExternalCount,
        types: typeDesc
      })
    )
  }

  // 添加提示说明
  contentLines.push(t('importToProjectModal.importAllHint'))

  let modalInstance: DialogHandle | null = null

  modalInstance = confirmDialog({
    title: t('importToProjectModal.engineNotConnectedTitle'),
    icon: null,
    content: h('div', { style: 'white-space: pre-line' }, contentLines.join('\n')),
    okText: t('importToProjectModal.importUnrealOnly'),
    cancelText: t('importToProjectModal.cancel'),
    footer: () =>
      h(
        'div',
        {
          style: 'display: flex; justify-content: flex-end; gap: 8px; padding-top: 12px'
        },
        [
          h(
            AppButton,
            {
              onClick: () => {
                modalInstance?.destroy()
              }
            },
            () => t('importToProjectModal.cancel')
          ),
          unrealCount > 0
            ? h(
                AppButton,
                {
                  onClick: () => {
                    modalInstance?.destroy()
                    onImportUnrealOnly()
                  }
                },
                () => t('importToProjectModal.importUnrealOnly')
              )
            : null,
          totalExternalCount > 0 || unrealCount > 0
            ? h(
                AppButton,
                {
                  variant: 'primary',
                  onClick: () => {
                    modalInstance?.destroy()
                    onImportAllNative()
                  }
                },
                () => t('importToProjectModal.importAllKeepNative')
              )
            : null
        ].filter(Boolean)
      )
  })
}

/**
 * 显示 UE 已连接时的导入选项对话框
 * 让用户选择是将外部文件转换为虚幻资产还是保留原生格式
 * @param stats 资产统计信息
 * @param onConvertToUE 转换为虚幻资产回调
 * @param onKeepNative 保留原生格式回调
 */
const showConnectedImportOptionsDialog = (
  stats: ImportStats,
  onConvertToUE: () => void,
  onKeepNative: () => void
): void => {
  const { unrealCount, nativeMediaCount, ueConversionCount, fileTypesDesc } = stats

  // 构建对话框内容
  const contentLines: string[] = []
  contentLines.push(t('importToProjectModal.chooseModeTitle'))

  if (unrealCount > 0) {
    contentLines.push(t('importToProjectModal.connectedUnrealCount', { count: unrealCount }))
  }
  if (nativeMediaCount > 0) {
    contentLines.push(t('importToProjectModal.nativeMediaCount', { count: nativeMediaCount }))
  }
  if (ueConversionCount > 0) {
    contentLines.push(
      t('importToProjectModal.externalCountWithTypes', {
        count: ueConversionCount,
        types: fileTypesDesc
      })
    )
  }

  // 添加提示说明
  const hasConvertibleFiles = nativeMediaCount > 0 || ueConversionCount > 0
  if (hasConvertibleFiles) {
    contentLines.push(t('importToProjectModal.convertToUEOption'))
    contentLines.push(t('importToProjectModal.keepNativeOption'))
  }

  let modalInstance: DialogHandle | null = null

  modalInstance = confirmDialog({
    title: t('importToProjectModal.chooseModeModalTitle'),
    icon: null,
    content: h('div', { style: 'white-space: pre-line' }, contentLines.join('\n')),
    okText: t('importToProjectModal.convertToUE'),
    cancelText: t('importToProjectModal.cancel'),
    footer: () =>
      h(
        'div',
        {
          style: 'display: flex; justify-content: flex-end; gap: 8px; padding-top: 12px'
        },
        [
          h(
            AppButton,
            {
              onClick: () => {
                modalInstance?.destroy()
              }
            },
            () => t('importToProjectModal.cancel')
          ),
          hasConvertibleFiles
            ? h(
                AppButton,
                {
                  onClick: () => {
                    modalInstance?.destroy()
                    onConvertToUE()
                  }
                },
                () => t('importToProjectModal.convertToUE')
              )
            : null,
          h(
            AppButton,
            {
              variant: 'primary',
              onClick: () => {
                modalInstance?.destroy()
                onKeepNative()
              }
            },
            () => t('importToProjectModal.keepNative')
          )
        ].filter(Boolean)
      )
  })
}

interface Props {
  open: boolean
  loading?: boolean
  source?: any
}

/** 后台导入任务信息 */
interface BackgroundImportTask {
  id: string
  name: string
  projectName: string
  progress: number
  stageText: string
  status?: 'running' | 'completed' | 'error'
}

interface Emits {
  (e: 'update:open', v: boolean): void
  (e: 'confirm', project: ProjectRecord): void
  /** 后台导入任务开始 */
  (e: 'backgroundImportStart', task: BackgroundImportTask): void
  /** 后台导入进度更新 */
  (e: 'backgroundImportProgress', task: BackgroundImportTask): void
  /** 后台导入任务完成 */
  (e: 'backgroundImportComplete', task: BackgroundImportTask): void
}

const props = defineProps<Props>()
const loading = ref<boolean>(Boolean(props.loading))
watch(
  () => props.loading,
  (v) => {
    loading.value = Boolean(v)
  }
)
const emit = defineEmits<Emits>()

const visible = ref<boolean>(props.open)
watch(
  () => props.open,
  (v) => {
    visible.value = v
  }
)
watch(visible, async (v) => {
  emit('update:open', v)
  if (!v) preparing.value = false
  if (v) {
    selectedProjectKey.value = null
    keyword.value = ''
    engineFilter.value = ''
    expandedCollections.value = new Set()
    await loadAllProjects()
    // 已连接工程正常靠订阅保持新鲜，但**首拉失败就没有第二次机会**：
    // /asset-management 是 keepAlive 的，这个弹窗从挂上去到应用退出都不会重挂。
    // 所以只在还没拿到过的时候补一次，拿到过就不动（避免盖掉更新的推送）。
    if (connectedProjectsRaw.value === null) await retryConnectedProjects()
  }
})

const {
  projects,
  filteredProjects,
  keyword,
  getProjectImage,
  loadAllProjects: loadSavedProjects,
  loading: savedProjectsLoading,
  loadFailed: savedLoadFailed,
  handleImportSingle
} = useProjects()

const collections = ref<ProjectCollectionRecord[]>([])
const collectionsLoading = ref(false)
const collectionsFailed = ref(false)
const addingProject = ref(false)
const engineFilter = ref('')
const expandedCollections = ref<Set<string>>(new Set())
const projectsLoading = computed(() => savedProjectsLoading.value || collectionsLoading.value)
const loadFailed = computed(() => savedLoadFailed.value || collectionsFailed.value)
async function loadCollections(): Promise<void> {
  collectionsLoading.value = true
  try {
    collections.value = await getImportProjectCollections()
    collectionsFailed.value = false
  } catch {
    collectionsFailed.value = true
  } finally {
    collectionsLoading.value = false
  }
}
async function loadAllProjects(): Promise<void> {
  await Promise.all([loadSavedProjects(), loadCollections()])
}
/**
 * 集合展开与否。
 *
 * 搜索或筛版本的时候一律当展开处理：能留在列表里的集合，本来就是因为里面有东西命中了，
 * 这时候还让人点一下才看得到命中的工程，等于把搜索结果藏起来。
 */
const isFiltering = computed(() => Boolean(keyword.value.trim() || engineFilter.value))
const isCollectionOpen = (key: string): boolean =>
  isFiltering.value || expandedCollections.value.has(key)
const toggleCollection = (key: string): void => {
  if (preparing.value) return
  const next = new Set(expandedCollections.value)
  if (!next.delete(key)) next.add(key)
  expandedCollections.value = next
}
const expandCollection = (key: string): void => {
  expandedCollections.value = new Set(expandedCollections.value).add(key)
}
const handleAddProject = async (): Promise<void> => {
  if (preparing.value || addingProject.value) return
  addingProject.value = true
  try {
    const added = await handleImportSingle()
    if (!added || !visible.value) return
    await loadCollections()
    if (!visible.value) return
    keyword.value = ''
    engineFilter.value = ''
    const group = collections.value.find((c) =>
      c.items?.some((p) => p.projectKey === added.projectKey)
    )
    if (group) expandCollection(group.collectionKey)
    await nextTick()
    handleSelect(added)
    await nextTick()
    document
      .querySelector('.import-project-modal .project-card.selected')
      ?.scrollIntoView({ block: 'nearest' })
  } finally {
    addingProject.value = false
  }
}

// 自编译引擎的 EngineAssociation 是一串 GUID，卡片上要翻成 5.8 这样的版本号
const { ensureEngineLabels, engineLabel } = useEngineVersionLabel()
/** 卡片上写「UE 5.8」而不是光一个「5.8」—— 不看别处也知道这个数字是什么 */
const engineTag = (association?: string | null): string => {
  const label = engineLabel(association)
  return label === 'N/A' ? t('importToProjectModal.unknownEngineVersion') : `UE ${label}`
}

watch(
  filteredProjects,
  (list) => {
    void ensureEngineLabels(
      list.map((p: { EngineAssociation?: string | null }) => p.EngineAssociation)
    )
  },
  { immediate: true }
)

const vaultStore = useVaultStore()
const selectedProjectKey = ref<string | null>(null)

/**
 * 将已连接 LINK 的项目排在前面的计算属性
 * 如果有已连接但不在数据库中的项目，也合成为 ProjectRecord 显示
 */
const allProjectChoices = computed(() =>
  importProjectChoices(projects.value, connectedProjects.value, '')
)
const engineOptions = computed(() => [
  { value: '', label: t('importToProjectModal.allEngineVersions') },
  ...Array.from(new Set(allProjectChoices.value.map((p) => engineLabel(p.EngineAssociation))))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .map((version) => ({
      value: version,
      label: version === 'N/A' ? t('importToProjectModal.unknownEngineVersion') : `UE ${version}`
    }))
])
const browserEntries = computed(() =>
  importBrowserEntries(
    allProjectChoices.value,
    collections.value,
    keyword.value,
    engineFilter.value,
    engineLabel
  )
)

type ImportBrowserSection =
  | { kind: 'projects'; key: string; projects: ImportProjectChoice[] }
  | (ImportBrowserEntry & { kind: 'collection' })

/**
 * 把相邻的工程并成一段。
 *
 * 集合是通栏的一条，工程是网格里的一格 —— 两者混在同一个 grid 里，通栏那条会把当前行
 * 剩下的格子撑空。分段之后既没有空洞，相关度排序也原样保留。
 */
const sections = computed<ImportBrowserSection[]>(() => {
  const list: ImportBrowserSection[] = []
  for (const entry of browserEntries.value) {
    if (entry.kind === 'collection') {
      list.push(entry)
      continue
    }
    const last = list[list.length - 1]
    if (last?.kind === 'projects') last.projects.push(entry.project)
    else list.push({ kind: 'projects', key: entry.key, projects: [entry.project] })
  }
  return list
})

/** 能被选中的工程：顶层的，加上已展开集合里的。收起的集合里那些点不到，也不算候选 */
const sortedProjects = computed(() =>
  sections.value.flatMap((section) =>
    section.kind === 'projects' || isCollectionOpen(section.key) ? section.projects : []
  )
)
const selectedProject = computed(() =>
  sortedProjects.value.find((item) => item.projectKey === selectedProjectKey.value)
)
/**
 * 这次要导的资产明细，文件夹递归摊平。
 *
 * 顶部「导入文件夹 X（N 个资产）」的计数和底部的版本预检共用这一份 —— 原来预检自己
 * 又查一遍库，同一个文件夹要递归两次。
 */
type SourceAsset = {
  assetKey?: string
  assetName?: string
  fileExtension?: string
  softPath?: string
  classKey?: string
}
const sourceAssets = ref<SourceAsset[]>([])
const sourceAssetsLoading = ref(false)
const sourceAssetsFailed = ref(false)
let sourceAssetsRevision = 0

const loadSourceAssets = async (): Promise<void> => {
  const revision = ++sourceAssetsRevision
  sourceAssets.value = []
  sourceAssetsFailed.value = false
  sourceAssetsLoading.value = false
  const source = props.source
  if (!visible.value || !source) return
  sourceAssetsLoading.value = true
  try {
    const children = source.type === 'batch' ? source.children || [] : [source]
    const collected: SourceAsset[] = []
    for (const item of children) {
      if (!item) continue
      if (item.type === 'folder') {
        // folderKey 才是这张表的主键；id 在列表里恰好等于它，但别的入口不保证
        const result = await window.api.database.assetData.getByFolderKeyRecursive(
          String(item.folderKey || item.id || '')
        )
        if (!result?.success) throw new Error(result?.error || 'getByFolderKeyRecursive 返回失败')
        collected.push(...(result.data || []))
      } else collected.push(item)
    }
    if (revision !== sourceAssetsRevision) return
    sourceAssets.value = collected
  } catch (error) {
    if (revision !== sourceAssetsRevision) return
    // 这条一定要落到控制台：界面上只说「没检查成」，不留原因就没法查
    console.error('[ImportToProject] 读取待导入资产失败:', error)
    sourceAssetsFailed.value = true
  } finally {
    if (revision === sourceAssetsRevision) sourceAssetsLoading.value = false
  }
}

const sourceSummary = computed(() => {
  const source = props.source
  if (!source) return t('importToProjectModal.noImportableAssets')
  if (source.type === 'batch')
    return t('importToProjectModal.sourceItems', { count: source.children?.length || 0 })
  const name =
    getBasename(source.assetName || source.folderName || source.name || '') ||
    t('importToProjectModal.unknownAsset')
  if (source.type !== 'folder') return t('importToProjectModal.sourceName', { name })
  // 还在数的时候先不报数字，免得先闪一下「0 个资产」
  return sourceAssetsLoading.value || sourceAssetsFailed.value
    ? t('importToProjectModal.sourceFolder', { name })
    : t('importToProjectModal.sourceFolderWithCount', { name, count: sourceAssets.value.length })
})
const compatibilityText = ref('')
const compatibilityBlocked = ref(0)
const compatibilityFailed = ref(false)
let compatibilityRevision = 0
const refreshCompatibility = async (): Promise<void> => {
  const revision = ++compatibilityRevision
  const project = selectedProject.value
  compatibilityText.value = ''
  compatibilityBlocked.value = 0
  compatibilityFailed.value = false
  if (!visible.value || !project || !props.source) return
  if (sourceAssetsLoading.value) return
  if (sourceAssetsFailed.value) {
    compatibilityFailed.value = true
    compatibilityText.value = t('importToProjectModal.compatibilityCheckFailed')
    return
  }
  compatibilityText.value = t('importToProjectModal.checkingVersion')
  try {
    const unreal = sourceAssets.value.filter(isUnrealAsset)
    const check = unreal.length ? await checkImportCompatibility(project, unreal) : null
    if (revision !== compatibilityRevision) return
    compatibilityBlocked.value = check?.blocked.length || 0
    compatibilityText.value = check?.blocked.length
      ? t('importToProjectModal.versionConflicts', { count: check.blocked.length })
      : t(
          unreal.length
            ? 'importToProjectModal.versionPreflightDone'
            : 'importToProjectModal.versionPreflightOther'
        )
  } catch (error) {
    if (revision !== compatibilityRevision) return
    // 同上：界面只说「没检查成」，真实原因必须留在控制台，否则这个故障没法复现定位
    console.error('[ImportToProject] 版本预检失败:', error)
    compatibilityFailed.value = true
    compatibilityText.value = t('importToProjectModal.compatibilityCheckFailed')
  }
}

/**
 * 规范化导入的目标路径
 * 用户可以自定义，例如 /Game/Asset、/Game/MyLib 等
 * @default /Game/Imported
 */
const userImportPath = ref<string>(localStorage.getItem('unreal-agent:import-path') || 'Imported')
watch(userImportPath, (val) => {
  localStorage.setItem('unreal-agent:import-path', val)
})

const normalizedImportPath = computed(() => {
  let p = userImportPath.value.trim().replace(/\\/g, '/')
  // 移除开头的斜杠
  p = p.replace(/^\/+/, '')
  // 如果用户手动输入了 Game/ 开头（忽略大小写），也移除掉，避免重复拼接
  if (p.toLowerCase().startsWith('game/')) {
    p = p.substring(5)
  }
  // 再次移除可能存在的开头斜杠
  p = p.replace(/^\/+/, '')
  return `/Game/${p}`
})

// 已通过 WebSocket 连接的工程列表（包含 enabledPlugins 用于判断插件安装状态）。
// 订阅、退订、首拉都在 useConnectedProjects 里 —— 原来是手写的，而且先 await
// getProjects() 再订阅，弹窗在这段 await 里被关掉就会漏一个监听器。
const connectedProjectsRaw = useConnectedProjects()
/** 首拉失败后的补救。见 watch(visible) 里的说明 */
async function retryConnectedProjects(): Promise<void> {
  try {
    connectedProjectsRaw.value = await window.api.websocket.getProjects()
  } catch (e) {
    console.warn('获取已连接工程失败:', e)
  }
}
const connectedProjects = computed(() => connectedProjectsRaw.value ?? [])
const clearMissingSelection = (): void => {
  if (!selectedProject.value) selectedProjectKey.value = null
}
watch(sortedProjects, clearMissingSelection)
// 先把待导资产读出来（顶部计数要用），读完再让预检跑 —— 预检直接吃这份结果
watch([() => props.source, visible], loadSourceAssets, { immediate: true })
watch(
  [selectedProject, sourceAssets, sourceAssetsLoading, sourceAssetsFailed, visible],
  refreshCompatibility
)

/**
 * 检查工程是否已通过 WebSocket 连接（使用路径匹配）
 * 注意：WebSocket 返回的 projectPath 可能是 .uproject 文件路径，
 * 而数据库中存储的是项目目录路径，需要兼容两种情况
 */
const normalizePath = (p: string): string => {
  // 统一路径分隔符、转小写、移除尾部斜杠
  return p.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '')
}
const extractDirPath = (p: string): string => {
  const normalized = normalizePath(p)
  // 如果路径以 .uproject 结尾，提取其父目录
  if (normalized.endsWith('.uproject')) {
    const lastSlash = normalized.lastIndexOf('/')
    return lastSlash > 0 ? normalized.substring(0, lastSlash) : normalized
  }
  return normalized
}
const isProjectConnected = (projectPath: string | null | undefined): boolean => {
  if (!projectPath) return false
  const normalizedInput = extractDirPath(projectPath)
  return connectedProjects.value.some((p) => {
    if (!p.projectPath) return false
    const connectedPath = extractDirPath(p.projectPath)
    return connectedPath === normalizedInput
  })
}
const stats = reactive({ total: 0, processed: 0, success: 0, existing: 0, error: 0 })
const progressPercent = computed(() => {
  if (stats.total <= 0) return 0
  const p = Math.round((stats.processed / stats.total) * 100)
  return Math.max(0, Math.min(100, p))
})
const displayPercent = ref<number>(0)
let progressTimer: number | null = null
const startProgressTick = () => {
  stopProgressTick()
  displayPercent.value = 0
  progressTimer = window.setInterval(() => {
    displayPercent.value = progressPercent.value
  }, 1000)
}
const stopProgressTick = () => {
  if (progressTimer !== null) {
    clearInterval(progressTimer)
    progressTimer = null
  }
}

const handleSelect = (item: ProjectRecord): void => {
  if (preparing.value) return
  selectedProjectKey.value = item.projectKey
}

/**
 * 判断是否可以使用规范化导入
 * 仅当源资产为 uasset/umap 类型时可用
 */
const canUseNormalizedImport = computed((): boolean => {
  const source = props.source
  if (!source) return false

  // 文件夹导入时，检查是否包含虚幻资产
  if ('type' in source && source.type === 'folder') {
    const children = (source as { children?: unknown[] }).children
    if (Array.isArray(children)) {
      return children.some((child) => {
        if (child && typeof child === 'object') {
          const asset = child as { assetName?: string; fileExtension?: string }
          return isUnrealAsset(asset)
        }
        return false
      })
    }
    return false
  }

  // 单文件导入
  if ('assetName' in source || 'fileExtension' in source) {
    return isUnrealAsset(
      source as { assetName?: string; fileExtension?: string; softPath?: string; classKey?: string }
    )
  }

  return false
})

/**
 * 检查是否有已连接的工程（即插件已就绪）
 * 根据用户反馈：只要是连接状态，那必定是有插件的
 */
const isPluginReady = computed((): boolean => {
  // 1. 检查是否有选中项目
  if (!selectedProjectKey.value) return false

  // 2. 获取选中的项目信息
  const selectedProject = filteredProjects.value.find(
    (p) => p.projectKey === selectedProjectKey.value
  )
  if (!selectedProject) return false

  // 3. 检查该项目是否在已连接列表中
  // 只要能找到连接记录，说明项目已通过 WebSocket 连接（即插件正在工作）
  const connection = connectedProjects.value.find(
    (p) => p.projectName === selectedProject.projectName
  )

  // 只要连接存在，就认为插件正常
  return !!connection
})

/**
 * 规范化导入按钮的 tooltip
 */
const normalizedImportTooltip = computed((): string => {
  if (!canUseNormalizedImport.value) {
    return t('importToProjectModal.normalizedImportOnlyUAsset')
  }
  const targetPath = normalizedImportPath.value.trim() || '/Game/Imported'
  return t('importToProjectModal.normalizedImportTooltip', { path: targetPath })
})

/** 1.2 GB / 350 MB 这种，别让用户去数零 */
const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

/**
 * 进度条下面那行字。
 *
 * 一万个资产、几十 G 的包，光报「第 3271/10000 个」看不出还要多久，
 * 所以把已写入的字节数也报出来 —— 那才是用户实际在等的东西。
 */
const describeBatchStage = (
  payload: {
    processed: number
    filesCopied: number
    filesQueued: number
    bytesCopied: number
    bytesTotal: number
    cancelled: boolean
  },
  totalAssets: number
): string => {
  if (payload.cancelled) return t('importToProjectModal.stageCancelling')

  const base = t('importToProjectModal.importingProgress', {
    processed: payload.processed,
    total: totalAssets
  })
  if (payload.filesQueued <= 0) return base

  return t('importToProjectModal.copyingFiles', {
    base,
    files: payload.filesCopied,
    totalFiles: payload.filesQueued,
    bytes: formatBytes(payload.bytesCopied),
    totalBytes: formatBytes(payload.bytesTotal)
  })
}

/** 被挡资产的点名文案；上限逻辑在 summarizeBlockedAssets 里，这里只负责拼话 */
const describeBlockedAssets = (blocked: readonly BlockedAsset[]): string => {
  const { listed, rest } = summarizeBlockedAssets(blocked)
  if (rest === 0) return listed
  return t('importToProjectModal.blockedAssetsOverflow', { assets: listed, rest })
}

type VersionConflictChoice = 'force' | 'compatible' | 'cancel'

/**
 * 有资产版本太高时问一句怎么办。
 *
 * 「仍然导入」是照抄字节、不做任何转换 —— 高版本的 .uasset 在低版本编辑器里打不开，
 * 这句话写在正文里。之所以还留这个口子：挡不挡人是按资产库里记的 engineVersion 判的，
 * 那个值可能扫错了或者过期了，不该由我们替用户一票否决。
 *
 * 按钮用自定义 footer 而不是 okText/cancelText，是因为非全挡的情况有三个出口
 * （取消 / 只导其余的 / 仍然全部导入），两个按钮排不下。
 */
const askVersionConflict = (content: string, allBlocked: boolean): Promise<VersionConflictChoice> =>
  new Promise((resolve) => {
    let dialog: DialogHandle | null = null
    const choose = (choice: VersionConflictChoice) => () => {
      dialog?.destroy()
      resolve(choice)
    }
    dialog = confirmDialog({
      title: t('importToProjectModal.compatibilityTitle'),
      content,
      // 点遮罩、按 Esc 关掉都算放弃；已经 resolve 过的话这次是空操作
      afterClose: () => resolve('cancel'),
      footer: () =>
        h(
          'div',
          { style: 'display: flex; justify-content: flex-end; gap: 8px; padding-top: 12px' },
          [
            h(AppButton, { onClick: choose('cancel') }, () => t('importToProjectModal.cancel')),
            // 全挡住时没有「其余的」可导，这个按钮就不该出现
            allBlocked
              ? null
              : h(AppButton, { variant: 'primary', onClick: choose('compatible') }, () =>
                  t('importToProjectModal.importCompatibleOnly')
                ),
            // 破坏性动作不配主按钮
            h(AppButton, { danger: true, onClick: choose('force') }, () =>
              t(
                allBlocked
                  ? 'importToProjectModal.forceImport'
                  : 'importToProjectModal.forceImportAll'
              )
            )
          ]
        )
    })
  })

/**
 * 执行文件夹导入（处理虚幻资产和外部文件）
 * @param isBackgroundMode 是否后台模式（关闭模态框后在后台执行）
 * @param sourceFolderKeys 源文件夹 key 数组，用于在对应文件夹上显示进度覆盖层
 */
const doFolderImport = async (
  payloadProject: {
    projectKey: string
    projectName: string | null
    projectPath: string | null
    originPath: string | null
    EngineAssociation: string | null
  },
  unrealAssets: any[],
  externalFiles: any[],
  isBackgroundMode = false,
  sourceFolderKeys: string[] = [],
  skipDependencyResolution = false,
  signal?: AbortSignal
): Promise<void> => {
  if (signal?.aborted) return
  // 主进程在真正拷文件时还会再按版本挡一次，所以用户点「仍然导入」之后
  // 必须把这个决定一路带到 importUAssetsBatch，否则前面放行、后面照样退回来
  let ignoreEngineVersion = false
  if (unrealAssets.length > 0) {
    const check = await checkImportCompatibility(payloadProject, unrealAssets).catch((error) => {
      message.error(String(error instanceof Error ? error.message : error))
      return null
    })
    if (!check || signal?.aborted) return
    if (check.blocked.length > 0) {
      const blockedKeys = new Set(check.blocked.map((asset) => asset.assetKey))
      const compatible = unrealAssets.filter((asset) => !blockedKeys.has(String(asset.assetKey)))
      const allBlocked = compatible.length === 0 && externalFiles.length === 0
      const content = t('importToProjectModal.compatibilityDetails', {
        project: payloadProject.projectName || '',
        version: check.projectVersion,
        count: check.blocked.length,
        assets: describeBlockedAssets(check.blocked)
      })
      const choice = await askVersionConflict(content, allBlocked)
      if (choice === 'cancel' || signal?.aborted) return
      // force：原样全拷过去，打不开是用户知情选的，我们不替他否决
      if (choice === 'compatible') unrealAssets = compatible
      else ignoreEngineVersion = true
    }
  }
  const totalAssets = unrealAssets.length + externalFiles.length

  // 生成后台任务 ID
  const taskId = isBackgroundMode ? `project-import-${Date.now()}` : ''
  const taskName = t('importToProjectModal.taskName', { count: totalAssets })
  const projectName = payloadProject.projectName || t('importToProjectModal.unknownProject')

  // 发送后台任务进度事件的辅助函数
  const dispatchProgress = (
    progress: number,
    stageText: string,
    status: 'running' | 'completed' | 'error' = 'running'
  ): void => {
    if (!isBackgroundMode) return
    window.dispatchEvent(
      new CustomEvent('project-import:progress', {
        detail: {
          id: taskId,
          name: taskName,
          projectName,
          progress,
          stageText,
          status,
          taskType: 'project-import',
          sourceFolderKeys
        }
      })
    )
  }

  // 后台模式：立即关闭模态框，发送任务开始事件
  if (isBackgroundMode) {
    visible.value = false
    window.dispatchEvent(
      new CustomEvent('project-import:start', {
        detail: {
          id: taskId,
          name: taskName,
          projectName,
          progress: 0,
          stageText: t('importToProjectModal.stagePreparing'),
          status: 'running',
          taskType: 'project-import',
          sourceFolderKeys,
          // 虚幻资产走批量通道，可以中途叫停；纯外部文件那条路还得等 UE 插件返回
          cancellable: unrealAssets.length > 0
        }
      })
    )
  } else {
    loading.value = true // 确保进度条显示
  }

  stats.total = totalAssets
  stats.processed = 0
  stats.success = 0
  stats.existing = 0
  stats.error = 0
  if (!isBackgroundMode) startProgressTick()

  let copied = 0
  let total = 0
  let cancelled = false
  let filesFailed = 0
  /** 出了什么问题、影响了谁。交给挂件上的「查看详情」 */
  let failureReport: ImportFailureReport | undefined
  const warnings: string[] = []

  // 处理虚幻资产（.uasset/.umap）- 直接复制
  //
  // 整批交给主进程一次做完，而不是在这里 for 循环逐个 invoke：几百个资产共用的依赖
  // （骨骼、材质、贴图）在主进程里共享一份解析状态，只解析并拷贝一次。逐个调用时
  // 每个资产都要重来一遍，KawaiiAnimations 那种 500 个动画共用一副骨骼的包会卡死。
  if (unrealAssets.length > 0) {
    const requestId = `import-uassets-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const batchSources = unrealAssets.map((a) => ({
      assetKey: String(a?.assetKey || ''),
      assetName: String(a?.assetName || a?.softPath || ''),
      skipDependencyResolution
    }))

    // 主进程是「规划串行 + 拷贝并发」的流水线：规划一边走，队列一边长。
    // 所以百分比拆成两半 —— 规划占前 50，拷贝占后 49，留 1 给收尾。
    // 队列在规划途中变长会让拷贝那一半算出来倒退，所以再夹一道单调保护：
    // 进度条只准往前走，看着往回缩比停着不动更让人以为卡了。
    let lastPercent = 0
    const unsubscribe = window.api.projectImport.onImportUAssetsBatchProgress((payload) => {
      if (payload.requestId !== requestId) return
      stats.processed = payload.processed
      stats.success = payload.succeeded
      stats.existing = payload.existing
      stats.error = payload.failed

      const planShare = Math.round((payload.processed / totalAssets) * 50)
      const copyShare =
        payload.filesQueued > 0 ? Math.round((payload.filesCopied / payload.filesQueued) * 49) : 0
      lastPercent = Math.max(lastPercent, Math.min(99, planShare + copyShare))
      dispatchProgress(lastPercent, describeBatchStage(payload, totalAssets))
    })

    // 几万个文件的导入必须能叫停
    const handleCancelRequest = (event: Event): void => {
      const detail = (event as CustomEvent).detail
      if (detail?.id !== taskId) return
      void window.api.projectImport.cancelImportUAssetsBatch(requestId)
    }
    if (isBackgroundMode) window.addEventListener('project-import:cancel', handleCancelRequest)

    try {
      const r = await window.api.projectImport.importUAssetsBatch(payloadProject, batchSources, {
        requestId,
        ignoreEngineVersion
      })
      stats.success = r?.succeeded ?? 0
      stats.existing = r?.existing ?? 0
      stats.error = r?.failed ?? 0
      stats.processed = stats.success + stats.existing + stats.error
      copied += Number(r?.copied || 0)
      total += Number(r?.copied || 0)
      if (Array.isArray(r?.warnings) && r.warnings.length > 0) warnings.push(...r.warnings)
      if (r?.error) warnings.push(String(r.error))
      if (r?.cancelled) cancelled = true
      // 「缺了什么、影响了谁」这份结构化的东西以前在这里被丢掉了，
      // 用户最后只看到一句「导入完成，N 条警告」。留着交给失败详情弹窗
      if (r?.report && !isCleanImportReport(r.report)) failureReport = r.report
      // 有文件没落盘但归不到具体资产头上（依赖文件没有 assetKey），
      // 这时候 stats.error 是 0，不额外记一笔就会显示成「全部成功」
      filesFailed += Number(r?.filesFailed || 0)
    } catch (e: any) {
      warnings.push(String(e?.message || e))
      stats.error += unrealAssets.length
      stats.processed = totalAssets - externalFiles.length
    } finally {
      unsubscribe()
      window.removeEventListener('project-import:cancel', handleCancelRequest)
    }
  }

  // 处理外部文件（FBX/GLB/PNG 等）- 通过 UE 插件导入
  if (externalFiles.length > 0 && !cancelled) {
    const targetConnectionId = importProjectConnection(payloadProject, connectedProjects.value)
    const filePaths = externalFiles
      .map((a) => String(a?.filePath || a?.originPath || ''))
      .filter((p) => p.length > 0)

    if (filePaths.length > 0) {
      // 检查是否有非uasset资产（需要插件转换）
      const nonUassetFiles = filePaths.filter((filePath: string) => {
        const ext = getExtname(filePath).toLowerCase()
        return ext !== '.uasset' && ext !== '.umap'
      })

      // 如果有非uasset资产，检查选中的项目是否已连接
      if (nonUassetFiles.length > 0) {
        const project = payloadProject
        const isConnected = Boolean(targetConnectionId)

        // 如果项目未连接，直接复制文件到项目目录（用户已在外层确认"导入全部"）
        if (!isConnected) {
          try {
            if (!project?.projectPath) {
              message.error(t('importToProjectModal.projectPathNotFound'))
              return
            }

            // 目标路径：项目目录/Content/Imported/
            const projectRoot = project.projectPath
            const destDir = joinPath(projectRoot, 'Content', 'Imported')
            await (window as any).api.invoke('fs:ensureDir', destDir)

            let successCount = 0
            let failCount = 0

            for (const filePath of nonUassetFiles) {
              try {
                const fileName = getBasename(filePath)
                const targetPath = joinPath(destDir, fileName)

                // 复制文件
                await window.api.fs.copyFile(filePath, targetPath)
                successCount++
              } catch (err: any) {
                console.error(`复制文件失败: ${filePath}`, err)
                failCount++
                warnings.push(t('importToProjectModal.copyFailed', { name: getBasename(filePath) }))
              }
            }

            if (successCount > 0) {
              stats.success += successCount
              copied += successCount
              total += nonUassetFiles.length
              message.success(t('importToProjectModal.copiedToProject', { count: successCount }))
            }
            if (failCount > 0) {
              stats.error += failCount
              message.warning(t('importToProjectModal.copyFailedCount', { count: failCount }))
            }
            stats.processed += nonUassetFiles.length
          } catch (err: any) {
            message.error(
              t('importToProjectModal.copyError', { error: String(err?.message || err) })
            )
            stats.error += nonUassetFiles.length
            stats.processed += nonUassetFiles.length
          }
          // 关闭 loading 和 modal
          loading.value = false
          visible.value = false
          return
        }
      }

      // 项目已连接，串行逐个导入（避免自定义导入管线冲突）
      console.log('[doFolderImport] 开始串行导入', filePaths.length, '个外部文件')
      for (const singleFilePath of filePaths) {
        try {
          const r = await (window as any).api.projectImport.importExternalFiles({
            files: [singleFilePath],
            destinationPath: '/Game/Imported',
            targetConnectionId,
            overwrite: false
          })
          if (r?.success) {
            stats.success += r.imported_count || 0
            stats.processed += 1
            copied += r.imported_count || 0
            total += 1
          } else if (r?.ue_not_connected) {
            warnings.push(
              t('importToProjectModal.ueNotConnectedFile', { name: getBasename(singleFilePath) })
            )
            stats.error += 1
            stats.processed += 1
          } else {
            const errMsg = r?.error ? String(r.error) : t('importToProjectModal.importFailed')
            warnings.push(`${getBasename(singleFilePath)}: ${errMsg}`)
            stats.error += 1
            stats.processed += 1
          }
        } catch (e: any) {
          warnings.push(`${getBasename(singleFilePath)}: ${String(e?.message || e)}`)
          stats.error += 1
          stats.processed += 1
        }
      }
    }
  }

  const summaryText = cancelled
    ? t('importToProjectModal.doneCancelled', {
        success: stats.success,
        existing: stats.existing
      })
    : t('importToProjectModal.doneSummary', {
        success: stats.success,
        existing: stats.existing,
        error: stats.error
      })

  // 后台模式：发送完成事件
  if (isBackgroundMode) {
    /*
     * 「这批算不算出了问题」必须把 report 也算进去。
     *
     * 只看 stats.error / filesFailed 的话，**目标路径冲突整批漏网**：冲突的文件
     * 压根没进队列，所以 filesFailed 是 0；结算也不为冲突降级，所以 stats.error
     * 是 0 —— 于是一次「B 的资产被 A 静默顶替」报成绿色的「已完成」，3 秒后消失。
     */
    const hasReport = failureReport !== undefined
    const finalStatus =
      cancelled || stats.error > 0 || filesFailed > 0 || hasReport ? 'error' : 'completed'
    window.dispatchEvent(
      new CustomEvent('project-import:complete', {
        detail: {
          id: taskId,
          name: taskName,
          projectName,
          progress: 100,
          stageText: summaryText,
          status: finalStatus,
          taskType: 'project-import',
          sourceFolderKeys,
          // 详情和重试要用的：出了什么问题、这批本来要导什么
          report: finalStatus === 'error' ? failureReport : undefined,
          retry:
            finalStatus === 'error' && unrealAssets.length > 0
              ? {
                  project: payloadProject,
                  sources: unrealAssets.map((a) => ({
                    assetKey: String(a?.assetKey || ''),
                    assetName: String(a?.assetName || a?.softPath || ''),
                    skipDependencyResolution
                  }))
                }
              : undefined,
          // 外部文件不在 retry.sources 里，混了就不算「全覆盖」
          retryCoversAll: externalFiles.length === 0
        }
      })
    )
    // 后台模式：结论说清「没导全」，具体缺什么在挂件的「查看详情」里 ——
    // 一句 toast 装不下，也留不住
    if (cancelled) {
      message.info(summaryText)
    } else if (stats.error > 0) {
      message.warning(t('importToProjectModal.doneWithFailures', { count: stats.error }))
    } else if (finalStatus === 'error') {
      // 有问题但归不到具体资产头上（孤儿文件失败、目标冲突）——
      // 别说「0 个资产没导全」，那句话是假的
      message.warning(t('importToProjectModal.doneWithIssues'))
    } else if (warnings.length > 0) {
      message.warning(t('importToProjectModal.doneWithWarnings', { count: warnings.length }))
    }
  } else {
    // 前台模式：正常流程
    displayPercent.value = 100
    if (cancelled) {
      message.info(summaryText)
    } else if (stats.error > 0 || filesFailed > 0 || failureReport) {
      // 前台也不许在没导全的时候报绿色的成功 —— 原来这里无条件走 doneImported
      message.warning(summaryText)
    } else {
      message.success(
        t('importToProjectModal.doneImported', { copied, total, existing: stats.existing })
      )
    }
    if (warnings.length > 0) message.warning(warnings.join('；'))
    await new Promise((r) => setTimeout(r, 300))
    visible.value = false
    loading.value = false
    stopProgressTick()
  }
}

/**
 * 单个资产后台导入（虚幻资产或外部文件）
 * 立即关闭模态框，在后台执行导入，通过全局进度条显示进度
 */
const doSingleAssetBackgroundImport = async (
  payloadProject: {
    projectKey: string
    projectName: string | null
    projectPath: string | null
    originPath: string | null
    EngineAssociation: string | null
  },
  source: any,
  filePath: string,
  assetName: string
): Promise<void> => {
  const targetConnectionId = importProjectConnection(payloadProject, connectedProjects.value)
  if (isExternalFile(source) && !targetConnectionId) {
    message.error(t('importToProjectModal.targetNotConnected'))
    return
  }
  const taskId = `project-import-${Date.now()}`
  const taskName = t('importToProjectModal.singleTaskName', { name: assetName })
  const projectName = payloadProject.projectName || t('importToProjectModal.unknownProject')

  // 发送后台任务进度事件的辅助函数
  const dispatchProgress = (
    progress: number,
    stageText: string,
    status: 'running' | 'completed' | 'error' = 'running'
  ): void => {
    window.dispatchEvent(
      new CustomEvent('project-import:progress', {
        detail: {
          id: taskId,
          name: taskName,
          projectName,
          progress,
          stageText,
          status,
          taskType: 'project-import'
        }
      })
    )
  }

  // 立即关闭模态框
  visible.value = false

  // 发送任务开始事件
  window.dispatchEvent(
    new CustomEvent('project-import:start', {
      detail: {
        id: taskId,
        name: taskName,
        projectName,
        progress: 0,
        stageText: t('importToProjectModal.stagePreparing'),
        status: 'running',
        taskType: 'project-import'
      }
    })
  )

  try {
    // 判断是否为外部文件
    if (isExternalFile(source)) {
      dispatchProgress(30, t('importToProjectModal.importingExternal'))

      const result = await (window as any).api.projectImport.importExternalFiles({
        files: [filePath],
        destinationPath: '/Game/Imported',
        targetConnectionId,
        overwrite: false
      })

      if (result?.success) {
        window.dispatchEvent(
          new CustomEvent('project-import:complete', {
            detail: {
              id: taskId,
              name: taskName,
              projectName,
              progress: 100,
              stageText: t('importToProjectModal.doneImportedFiles', {
                count: result.imported_count || 1
              }),
              status: 'completed',
              taskType: 'project-import'
            }
          })
        )
        message.success(
          t('importToProjectModal.doneImportedFiles', { count: result.imported_count || 1 })
        )
      } else if (result?.ue_not_connected) {
        window.dispatchEvent(
          new CustomEvent('project-import:complete', {
            detail: {
              id: taskId,
              name: taskName,
              projectName,
              progress: 100,
              stageText: t('importToProjectModal.ueNotConnected'),
              status: 'error',
              taskType: 'project-import'
            }
          })
        )
        message.error(t('importToProjectModal.ueNotConnectedImportFailed'))
      } else {
        const errMsg = result?.error ? String(result.error) : t('importToProjectModal.importFailed')
        window.dispatchEvent(
          new CustomEvent('project-import:complete', {
            detail: {
              id: taskId,
              name: taskName,
              projectName,
              progress: 100,
              stageText: errMsg,
              status: 'error',
              taskType: 'project-import'
            }
          })
        )
        message.error(errMsg)
      }
    } else {
      // 虚幻资产直接复制
      dispatchProgress(30, t('importToProjectModal.copyingUnrealAssets'))

      const payloadSource = {
        assetKey: (source as any).assetKey || '',
        softPath: (source as any).softPath || '',
        filePath: filePath,
        className: (source as any).className || ''
      }

      const result = await (window as any).api.projectImport.importUAssets(
        payloadProject,
        payloadSource
      )

      if ((result as any)?.alreadyExists) {
        window.dispatchEvent(
          new CustomEvent('project-import:complete', {
            detail: {
              id: taskId,
              name: taskName,
              projectName,
              progress: 100,
              stageText: t('importToProjectModal.assetExists'),
              status: 'completed',
              taskType: 'project-import'
            }
          })
        )
        message.info(t('importToProjectModal.assetExists'))
      } else if (result?.success) {
        const copied = Number(result.copied || 0)
        const total = Number(result.total || 0)
        const warnings: string[] = Array.isArray(result.warnings) ? result.warnings : []

        window.dispatchEvent(
          new CustomEvent('project-import:complete', {
            detail: {
              id: taskId,
              name: taskName,
              projectName,
              progress: 100,
              stageText: t('importToProjectModal.doneCopied', { copied, total }),
              // 这条**成功**返回里的 warnings 多半是「资产已存在，已跳过」这类良性提示。
              // 原来一有警告就标成 error，而 error 现在会永久钉在挂件上、又没有
              // report 可看 —— 等于给用户一张什么都不说的红卡片。成功就是成功。
              status: 'completed',
              taskType: 'project-import'
            }
          })
        )
        message.success(t('importToProjectModal.doneCopied', { copied, total }))
        if (warnings.length > 0) {
          message.warning(warnings.join('；'))
        }
      } else {
        const failure = result as { error?: unknown } | null
        const errMsg = failure?.error
          ? String(failure.error)
          : t('importToProjectModal.importFailed')
        window.dispatchEvent(
          new CustomEvent('project-import:complete', {
            detail: {
              id: taskId,
              name: taskName,
              projectName,
              progress: 100,
              stageText: errMsg,
              status: 'error',
              taskType: 'project-import'
            }
          })
        )
        message.error(errMsg)
      }
    }
  } catch (err: any) {
    const errMsg = String(err?.message || t('importToProjectModal.importException'))
    window.dispatchEvent(
      new CustomEvent('project-import:complete', {
        detail: {
          id: taskId,
          name: taskName,
          projectName,
          progress: 100,
          stageText: errMsg,
          status: 'error',
          taskType: 'project-import'
        }
      })
    )
    message.error(errMsg)
  }
}

/**
 * 规范化导入处理函数
 * 通过 UE 插件将 uasset/umap 资产导入到规范化的目录结构中
 */
const handleNormalizedImport = async (): Promise<void> => {
  const project = filteredProjects.value.find((p) => p.projectKey === selectedProjectKey.value)
  if (!project) {
    message.error(t('importToProjectModal.selectProjectFirst'))
    return
  }

  const source = props.source
  if (!source) {
    message.warning(t('importToProjectModal.noImportableAssets'))
    return
  }

  // 检查 UE 连接状态
  const isUEConnected = await checkUEConnection()
  if (!isUEConnected) {
    warningDialog({
      title: t('importToProjectModal.needUEConnection.title'),
      content: t('importToProjectModal.needUEConnection.content'),
      okText: t('importToProjectModal.needUEConnection.okText')
    })
    return
  }

  // 收集要导入的文件列表
  const filesToImport: string[] = []

  if ('type' in source && source.type === 'folder') {
    // 文件夹导入：获取所有虚幻资产
    const folderKey = String(
      (source as { id?: string; folderKey?: string }).id ||
        (source as { id?: string; folderKey?: string }).folderKey ||
        ''
    )
    if (!folderKey) {
      message.error(t('importToProjectModal.folderKeyNotFound'))
      return
    }

    interface AssetWithPath {
      filePath?: string
      originPath?: string
      assetName?: string
      fileExtension?: string
    }

    const resp = await (
      window as {
        api: {
          database: {
            assetData: {
              getByFolderKeyRecursive: (
                key: string
              ) => Promise<{ success: boolean; data?: AssetWithPath[] }>
            }
          }
        }
      }
    ).api.database.assetData.getByFolderKeyRecursive(folderKey)
    const assets = (resp?.success ? resp?.data : []) || []

    for (const asset of assets) {
      if (isUnrealAsset(asset)) {
        const filePath = String(asset.filePath || asset.originPath || '')
        if (filePath) {
          filesToImport.push(filePath)
        }
      }
    }
  } else if ('filePath' in source || 'originPath' in source) {
    // 单文件导入
    const filePath = String(
      (source as { filePath?: string; originPath?: string }).filePath ||
        (source as { filePath?: string; originPath?: string }).originPath ||
        ''
    )
    if (filePath) {
      filesToImport.push(filePath)
    }
  }

  if (filesToImport.length === 0) {
    message.warning(t('importToProjectModal.noUAssetFiles'))
    return
  }

  loading.value = true
  stats.total = filesToImport.length
  stats.processed = 0
  stats.success = 0
  stats.error = 0
  stats.existing = 0
  startProgressTick()

  try {
    message.info(t('importToProjectModal.normalizedImporting', { count: filesToImport.length }))

    const result = await (
      window as {
        api: {
          projectImport: {
            normalizedImportAssets: (params: {
              files: string[]
              targetRoot?: string
              projectEngineVersion?: string
            }) => Promise<{
              success: boolean
              successCount?: number
              failedCount?: number
              warnings?: string[]
              errors?: string[]
              error?: string
              ue_not_connected?: boolean
            }>
          }
        }
      }
    ).api.projectImport.normalizedImportAssets({
      files: filesToImport,
      targetRoot: normalizedImportPath.value.trim() || '/Game/Imported',
      projectEngineVersion: project.EngineAssociation || undefined
    })

    if (result?.success) {
      stats.success = result.successCount || 0
      stats.error = result.failedCount || 0
      stats.processed = stats.success + stats.error

      message.success(
        t('importToProjectModal.normalizedImportDone', {
          success: stats.success,
          error: stats.error
        })
      )

      if (result.warnings && result.warnings.length > 0) {
        message.warning(
          t('importToProjectModal.normalizedImportWarnings', {
            warnings: result.warnings.join('；')
          })
        )
      }
    } else if (result?.ue_not_connected) {
      message.error(t('importToProjectModal.normalizedImportUENotConnected'))
      stats.error = filesToImport.length
      stats.processed = filesToImport.length
    } else {
      const errorMsg = result?.error || t('importToProjectModal.normalizedImportFailed')
      message.error(errorMsg)
      stats.error = filesToImport.length
      stats.processed = filesToImport.length

      if (result?.errors && result.errors.length > 0) {
        console.error('[NormalizedImport] 错误:', result.errors)
      }
    }
  } catch (e: unknown) {
    const errorMsg = e instanceof Error ? e.message : String(e)
    message.error(t('importToProjectModal.normalizedImportException', { error: errorMsg }))
    stats.error = filesToImport.length
    stats.processed = filesToImport.length
  } finally {
    displayPercent.value = 100
    await new Promise((r) => setTimeout(r, 300))
    visible.value = false
    loading.value = false
    stopProgressTick()
  }
}

// ==============================
// 压缩包导入
// ==============================
type PayloadProject = {
  projectKey: string
  projectName: string | null
  projectPath: string | null
  originPath: string | null
  EngineAssociation: string | null
}

const archiveDialogVisible = ref(false)
const archiveDontAskAgain = ref(false)
/** 弹窗点了按钮之后要跑的东西，等用户选完再执行 */
const pendingArchive = ref<{
  project: PayloadProject
  zipPath: string
  assetName: string
} | null>(null)

const archiveAssetName = computed(() => pendingArchive.value?.assetName || '')

/**
 * 压缩包导入工程的入口。
 *
 * rar / 7z 我们解不了（没有对应的解压库，也不打算为此塞一个新依赖进来），
 * 这种情况不装作能解，直接说清楚，只留「原样复制」这一条路。
 */
const startArchiveImport = async (
  project: PayloadProject,
  zipPath: string,
  assetName: string,
  ext: string
): Promise<void> => {
  loading.value = false

  if (!project.projectPath) {
    message.error(t('importToProjectModal.projectPathNotFound'))
    return
  }
  if (!zipPath) {
    message.error(t('importToProjectModal.archive.pathNotFound'))
    return
  }

  if (ext !== 'zip') {
    visible.value = false
    warningDialog({
      title: t('importToProjectModal.archive.unsupportedTitle'),
      content: t('importToProjectModal.archive.unsupportedContent', { format: ext.toUpperCase() }),
      okText: t('importToProjectModal.archive.unsupportedOk')
    })
    return
  }

  pendingArchive.value = { project, zipPath, assetName }

  const remembered = readArchiveAction()
  if (remembered) {
    await runArchiveAction(remembered)
    return
  }

  archiveDontAskAgain.value = false
  archiveDialogVisible.value = true
}

/** 弹窗里选了某个处理方式 */
const chooseArchiveAction = async (action: ArchiveAction): Promise<void> => {
  if (archiveDontAskAgain.value) {
    rememberArchiveAction(action)
  }
  archiveDialogVisible.value = false
  await runArchiveAction(action)
}

const runArchiveAction = async (action: ArchiveAction): Promise<void> => {
  const pending = pendingArchive.value
  pendingArchive.value = null
  if (!pending) return

  visible.value = false
  const { project, zipPath, assetName } = pending
  const projectPath = project.projectPath as string
  const taskId = `project-import-${Date.now()}`
  const projectName = project.projectName || t('importToProjectModal.unknownProject')
  const taskName = t('importToProjectModal.archive.taskName', { name: assetName })

  const dispatchTask = (
    event: 'start' | 'complete',
    progress: number,
    stageText: string,
    status: 'running' | 'completed' | 'error'
  ): void => {
    window.dispatchEvent(
      new CustomEvent(`project-import:${event}`, {
        detail: {
          id: taskId,
          name: taskName,
          projectName,
          progress,
          stageText,
          status,
          taskType: 'project-import'
        }
      })
    )
  }

  dispatchTask('start', 0, t('importToProjectModal.stagePreparing'), 'running')

  try {
    if (action === 'extract') {
      const result = await window.api.projectImport.extractArchiveToProject({
        zipPath,
        projectPath
      })
      if (result?.success) {
        const done = t('importToProjectModal.archive.extractDone', {
          count: result.fileCount ?? 0,
          dir: result.destDir || ''
        })
        dispatchTask('complete', 100, done, 'completed')
        message.success(done)
        // 包里如果是 FBX/贴图，光解出来还不够，还得在编辑器里再导一次。
        // 不说这句话，用户会以为已经能用了。
        message.info(t('importToProjectModal.archive.extractHintAfter'))
      } else {
        const errMsg = result?.error || t('importToProjectModal.importFailed')
        dispatchTask('complete', 100, errMsg, 'error')
        message.error(errMsg)
      }
      return
    }

    const destDir = joinPath(projectPath, 'Content', 'Imported')
    await window.api.invoke('fs:ensureDir', destDir)
    const targetPath = joinPath(destDir, getBasename(zipPath))
    const copyResult = await window.api.fs.copyFile(zipPath, targetPath)
    if (copyResult && copyResult.success === false) {
      throw new Error(String(copyResult.error || ''))
    }
    const done = t('importToProjectModal.archive.copyDone', { dir: destDir })
    dispatchTask('complete', 100, done, 'completed')
    message.success(done)
  } catch (error) {
    const errMsg = String(error instanceof Error ? error.message : error)
    dispatchTask('complete', 100, errMsg, 'error')
    message.error(errMsg)
  }
}

const preparing = ref(false)
let importController: AbortController | null = null
const handleConfirm = async (): Promise<void> => {
  if (preparing.value || loading.value || projectsLoading.value || loadFailed.value) return
  importController?.abort()
  const controller = new AbortController()
  importController = controller
  const { signal } = controller
  const importFolder = (...args: Parameters<typeof doFolderImport>): Promise<void> =>
    doFolderImport(args[0], args[1], args[2], args[3], args[4], args[5], signal)

  // 从 sortedProjects 查找（包含合成的已连接但未添加到盒子的项目）
  const project = sortedProjects.value.find((p) => p.projectKey === selectedProjectKey.value)
  if (project) {
    emit('confirm', project as ProjectRecord)
  } else {
    message.error(t('importToProjectModal.selectProjectFirst'))
    return
  }
  const source = (props as any).source
  if (!source) {
    message.warning(t('importToProjectModal.noImportableAssets'))
    return
  }
  preparing.value = true
  try {
    const payloadProject = {
      projectKey: project.projectKey,
      projectName: project.projectName || null,
      projectPath: project.projectPath || null,
      originPath: project.originPath || null,
      EngineAssociation: project.EngineAssociation || null
    }

    // 插件特殊处理：直接复制到项目的 /Plugins 目录
    if (isPluginSource(source)) {
      try {
        const isUpluginFile = String(source.fileExtension || '').toLowerCase() === 'uplugin'
        let pluginSourceDir = ''
        let pluginName = source.name || source.folderName || ''

        if (isUpluginFile) {
          // .uplugin 文件：使用其 originPath 或 filePath 获取插件目录
          // originPath 是相对于保管库的路径，需要拼接保管库根路径
          const upluginRelativePath = String(source.originPath || source.filePath || '')
          if (!upluginRelativePath) {
            message.error(t('importToProjectModal.pluginPathNotFound'))
            loading.value = false
            return
          }

          // 获取当前保管库的根路径
          const vaultBasePath = vaultStore.currentVault?.path || ''
          if (!vaultBasePath) {
            message.error(t('importToProjectModal.vaultPathNotFound'))
            loading.value = false
            return
          }

          // 拼接完整的 .uplugin 文件路径（如果已经是绝对路径则直接使用）
          const fullUpluginPath = isAbsolutePath(upluginRelativePath)
            ? upluginRelativePath
            : joinPath(vaultBasePath, upluginRelativePath)
          console.log(
            `[ImportToProjectModal] .uplugin 完整路径: vault=${vaultBasePath}, relative=${upluginRelativePath}, full=${fullUpluginPath}`
          )

          // 获取 .uplugin 文件所在的目录
          const parts = fullUpluginPath.replace(/\\/g, '/').split('/')
          parts.pop() // 移除文件名
          pluginSourceDir = parts.join('/')
          pluginName = parts[parts.length - 1] || pluginName.replace('.uplugin', '')
        } else {
          // 插件文件夹：需要从文件夹内的资产获取路径
          const folderKey = String(source.id || source.folderKey || '')
          if (!folderKey) {
            message.error(t('importToProjectModal.pluginFolderKeyNotFound'))
            loading.value = false
            return
          }

          // 获取文件夹内的第一个资产来推导实际路径
          const resp = await window.api.database.assetData.getByFolderKeyRecursive(folderKey)
          const assets = (resp?.success ? resp?.data : []) || []

          if (assets.length === 0) {
            message.error(t('importToProjectModal.pluginFolderEmpty'))
            loading.value = false
            return
          }

          // 从第一个资产的路径推导出插件目录
          // 资产的 originPath 是相对于保管库的路径，需要拼接保管库根路径
          const firstAsset = assets[0] as unknown as Record<string, unknown>
          const assetRelativePath = String(firstAsset.originPath || firstAsset.filePath || '')
          if (!assetRelativePath) {
            message.error(t('importToProjectModal.assetPathNotFound'))
            loading.value = false
            return
          }

          // 获取当前保管库的根路径
          const vaultBasePath = vaultStore.currentVault?.path || ''
          if (!vaultBasePath) {
            message.error(t('importToProjectModal.vaultPathNotFound'))
            loading.value = false
            return
          }

          // 拼接完整的资产路径（如果已经是绝对路径则直接使用）
          const firstAssetPath = isAbsolutePath(assetRelativePath)
            ? assetRelativePath
            : joinPath(vaultBasePath, assetRelativePath)
          console.log(
            `[ImportToProjectModal] 插件资产完整路径: vault=${vaultBasePath}, relative=${assetRelativePath}, full=${firstAssetPath}`
          )

          // 使用文件夹名称来匹配插件目录
          const folderNameOrType = String(source.folderName || source.name || '')
          const normalizedAssetPath = firstAssetPath.replace(/\\/g, '/')
          const folderSearchName = folderNameOrType.toLowerCase()

          // 在路径中查找与文件夹名匹配的目录级别
          const pathParts = normalizedAssetPath.split('/')
          let foundIndex = -1
          for (let i = 0; i < pathParts.length; i++) {
            if (pathParts[i].toLowerCase() === folderSearchName) {
              foundIndex = i
              break
            }
          }

          if (foundIndex >= 0) {
            // 找到匹配的目录，截取到该级别
            pluginSourceDir = pathParts.slice(0, foundIndex + 1).join('/')
            pluginName = pathParts[foundIndex]
          } else {
            // 未找到匹配，尝试获取包含 .uplugin 的目录
            // 往上找直到发现包含 .uplugin 文件的目录
            const upluginAsset = assets.find((a) => {
              const asset = a as unknown as Record<string, unknown>
              return String(asset.fileExtension || '').toLowerCase() === 'uplugin'
            }) as Record<string, unknown> | undefined
            if (upluginAsset) {
              const upluginRelPath = String(upluginAsset.originPath || upluginAsset.filePath || '')
              // 如果是绝对路径则直接使用，否则拼接保管库根路径
              const upluginFullPath = isAbsolutePath(upluginRelPath)
                ? upluginRelPath
                : joinPath(vaultBasePath, upluginRelPath)
              const parts = upluginFullPath.replace(/\\/g, '/').split('/')
              parts.pop()
              pluginSourceDir = parts.join('/')
              pluginName = parts[parts.length - 1] || folderNameOrType
            } else {
              message.error(t('importToProjectModal.pluginDirNotFound'))
              loading.value = false
              return
            }
          }
        }

        if (!pluginSourceDir || !project.projectPath) {
          message.error(t('importToProjectModal.sourceOrProjectPathNotFound'))
          loading.value = false
          return
        }

        // 目标路径: 项目/Plugins/插件名
        const pluginsDir = joinPath(project.projectPath, 'Plugins')
        const targetPath = joinPath(pluginsDir, pluginName)

        // message.info(`正在导入插件 ${pluginName} 到项目...`)
        console.log(`[ImportToProjectModal] 插件导入: ${pluginSourceDir} -> ${targetPath}`)

        // 确保 Plugins 目录存在，然后复制整个插件文件夹
        signal.throwIfAborted()
        visible.value = false
        const result = await window.api.invoke('fs:copyDir', pluginSourceDir, targetPath, {
          overwrite: false
        })

        if (result?.success) {
          message.success(
            t('importToProjectModal.pluginImported', { name: pluginName, path: pluginsDir })
          )
        } else {
          message.error(
            t('importToProjectModal.pluginImportFailed', {
              error: result?.error || t('importToProjectModal.unknownError')
            })
          )
        }
      } catch (err: unknown) {
        if (signal.aborted) return
        const errorMsg = err instanceof Error ? err.message : String(err)
        message.error(t('importToProjectModal.pluginImportException', { error: errorMsg }))
      } finally {
        if (importController === controller) {
          loading.value = false
          visible.value = false
        }
      }
      return
    }

    // 批量导入：处理多个选中项
    if ((source as any).type === 'batch') {
      const children = (source as any).children || []
      console.log('[ImportToProjectModal] 批量导入: children 数量', children.length)
      console.log('[ImportToProjectModal] 批量导入: children[0] 示例', children[0])

      // 分离普通文件和文件夹
      const directFileAssets = (children as any[]).filter((a) => a.type !== 'folder')
      const folderItems = (children as any[]).filter((a) => a.type === 'folder')
      // 收集源文件夹 keys，用于在对应文件夹上显示进度覆盖层
      const sourceFolderKeys = folderItems
        .map((f) => String(f.id || f.folderKey || ''))
        .filter(Boolean)
      console.log(
        '[ImportToProjectModal] 批量导入: 直接文件数',
        directFileAssets.length,
        '文件夹数',
        folderItems.length,
        'sourceFolderKeys',
        sourceFolderKeys
      )

      // 递归获取所有文件夹内的资产
      const allFileAssets: any[] = [...directFileAssets]
      for (const folder of folderItems) {
        const folderKey = String(folder.id || folder.folderKey || '')
        if (!folderKey) continue
        try {
          const resp = await (window as any).api.database.assetData.getByFolderKeyRecursive(
            folderKey
          )
          const assets = (resp?.success ? resp?.data : []) || []
          console.log(`[ImportToProjectModal] 文件夹 ${folderKey} 包含 ${assets.length} 个资产`)
          allFileAssets.push(...assets)
        } catch (err) {
          console.error(`[ImportToProjectModal] 获取文件夹 ${folderKey} 资产失败:`, err)
        }
      }
      console.log('[ImportToProjectModal] 批量导入: 总文件数', allFileAssets.length)

      const unrealAssets = allFileAssets.filter((a) => isUnrealAsset(a))
      const externalFiles = allFileAssets.filter((a) => isExternalFile(a) && !isUnrealAsset(a))
      const shouldUseProjectQuickPath =
        directFileAssets.length === 0 &&
        sourceFolderKeys.length === 1 &&
        (await isStandardUEProjectImportFolder(sourceFolderKeys[0]))

      signal.throwIfAborted()
      if (shouldUseProjectQuickPath) {
        console.log(
          '[ImportToProjectModal] 检测到标准 UE 工程根目录，批量导入走快路径，跳过外部文件弹窗'
        )
        if (externalFiles.length > 0) {
          message.info(t('importToProjectModal.quickPathInfo', { count: unrealAssets.length }))
        }
        await importFolder(payloadProject, unrealAssets, [], true, sourceFolderKeys, true)
        return
      }
      console.log(
        '[ImportToProjectModal] 批量导入: unrealAssets',
        unrealAssets.length,
        'externalFiles',
        externalFiles.length
      )
      if (externalFiles.length > 0) {
        console.log('[ImportToProjectModal] 批量导入: externalFiles[0] 示例', externalFiles[0])
      }

      // 如果有外部文件，检查 UE 连接状态
      if (externalFiles.length > 0) {
        // 分离原生媒体文件和需要UE转换的文件
        const nativeMediaFiles = externalFiles.filter((a) => isNativeMediaFile(a))
        const ueConversionFiles = externalFiles.filter((a) => isUEConversionRequired(a))
        const fileTypesDesc = getExternalFileTypesDescription(ueConversionFiles)

        const isUEConnected = Boolean(
          importProjectConnection(payloadProject, connectedProjects.value)
        )
        signal.throwIfAborted()
        if (!isUEConnected) {
          loading.value = false

          // UE 未连接：使用三按钮对话框
          showImportOptionsDialog(
            {
              unrealCount: unrealAssets.length,
              nativeMediaCount: nativeMediaFiles.length,
              ueConversionCount: ueConversionFiles.length,
              fileTypesDesc
            },
            // 只导入虚幻资产
            async () => {
              await importFolder(payloadProject, unrealAssets, [], true, sourceFolderKeys)
            },
            // 导入全部（保留原生）：导入虚幻资产 + 所有外部文件（包括需UE转换的文件）
            async () => {
              await importFolder(
                payloadProject,
                unrealAssets,
                externalFiles,
                true,
                sourceFolderKeys
              )
            }
          )
          return
        } else {
          // UE 已连接：让用户选择转换还是保留原生
          loading.value = false

          showConnectedImportOptionsDialog(
            {
              unrealCount: unrealAssets.length,
              nativeMediaCount: nativeMediaFiles.length,
              ueConversionCount: ueConversionFiles.length,
              fileTypesDesc
            },
            // 转换为虚幻资产：通过 UE 导入所有外部文件
            async () => {
              await importFolder(
                payloadProject,
                unrealAssets,
                externalFiles,
                true,
                sourceFolderKeys
              )
            },
            // 保留原生格式：导入虚幻资产 + 所有外部文件（保留原始格式）
            async () => {
              await importFolder(
                payloadProject,
                unrealAssets,
                externalFiles,
                true,
                sourceFolderKeys
              )
            }
          )
          return
        }
      }

      await importFolder(payloadProject, unrealAssets, externalFiles, true, sourceFolderKeys) // 后台模式
      return
    }

    if ((source as any).type === 'folder') {
      const folderKey = String((source as any).id || (source as any).folderKey || '')
      if (!folderKey) {
        message.error(t('importToProjectModal.folderKeyNotFound'))
        return
      }
      const resp = await (window as any).api.database.assetData.getByFolderKeyRecursive(folderKey)
      const assets = (resp?.success ? resp?.data : []) || []
      // 分离虚幻资产和外部文件
      const unrealAssets = (assets as any[]).filter((a) => isUnrealAsset(a))
      const externalFiles = (assets as any[]).filter((a) => isExternalFile(a) && !isUnrealAsset(a))
      const shouldUseProjectQuickPath = await isStandardUEProjectImportFolder(folderKey)

      signal.throwIfAborted()
      if (shouldUseProjectQuickPath) {
        console.log('[ImportToProjectModal] 检测到标准 UE 工程根目录，单文件夹导入走快路径')
        if (externalFiles.length > 0) {
          message.info(t('importToProjectModal.quickPathInfo', { count: unrealAssets.length }))
        }
        await importFolder(payloadProject, unrealAssets, [], true, [folderKey], true)
        return
      }

      // 如果有外部文件，检查 UE 连接状态
      if (externalFiles.length > 0) {
        // 分离原生媒体文件和需要UE转换的文件
        const nativeMediaFiles = externalFiles.filter((a) => isNativeMediaFile(a))
        const ueConversionFiles = externalFiles.filter((a) => isUEConversionRequired(a))
        const fileTypesDesc = getExternalFileTypesDescription(ueConversionFiles)

        const isUEConnected = Boolean(
          importProjectConnection(payloadProject, connectedProjects.value)
        )
        signal.throwIfAborted()
        if (!isUEConnected) {
          loading.value = false

          // UE 未连接：使用三按钮对话框
          showImportOptionsDialog(
            {
              unrealCount: unrealAssets.length,
              nativeMediaCount: nativeMediaFiles.length,
              ueConversionCount: ueConversionFiles.length,
              fileTypesDesc
            },
            // 只导入虚幻资产
            async () => {
              await importFolder(payloadProject, unrealAssets, [], true, [folderKey])
            },
            // 导入全部（保留原生）：导入虚幻资产 + 所有外部文件（包括需UE转换的文件）
            async () => {
              await importFolder(payloadProject, unrealAssets, externalFiles, true, [folderKey])
            }
          )
          return
        } else {
          // UE 已连接：让用户选择转换还是保留原生
          loading.value = false

          showConnectedImportOptionsDialog(
            {
              unrealCount: unrealAssets.length,
              nativeMediaCount: nativeMediaFiles.length,
              ueConversionCount: ueConversionFiles.length,
              fileTypesDesc
            },
            // 转换为虚幻资产：通过 UE 导入所有外部文件
            async () => {
              await importFolder(payloadProject, unrealAssets, externalFiles, true, [folderKey])
            },
            // 保留原生格式：导入虚幻资产 + 所有外部文件（保留原始格式）
            async () => {
              await importFolder(payloadProject, unrealAssets, externalFiles, true, [folderKey])
            }
          )
          return
        }
      }

      await importFolder(payloadProject, unrealAssets, externalFiles, true, [folderKey])
      return
    }

    // 单个文件导入
    // 尝试从多个可能的属性中获取文件路径
    // 对于网络库资产，originPath 包含完整网络路径，应优先使用
    const filePath = String(
      (source as any).originPath ||
        (source as any).filePath ||
        (source as any).path ||
        (source as any).assetPath ||
        (source as any).localPath ||
        ''
    )

    console.log('[ImportToProjectModal] 单文件导入 source:', JSON.stringify(source, null, 2))
    console.log('[ImportToProjectModal] 单文件导入 filePath:', filePath)

    // 获取资产名称
    const named = source as { assetName?: string; name?: string }
    const assetName = String(
      named.assetName ||
        named.name ||
        getBasename(filePath) ||
        t('importToProjectModal.unknownAsset')
    )

    // 压缩包走自己的分支：它既不是虚幻资产也不是 UE 认得的外部文件，
    // 照现有路径走下去只会导进一个 UE 打不开的 .zip。
    const archiveExt = getArchiveExtension(source)
    signal.throwIfAborted()
    if (archiveExt) {
      await startArchiveImport(payloadProject, filePath, assetName, archiveExt)
      return
    }

    // 直接使用后台导入模式 - 立即关闭对话框，在全局底部进度条显示进度
    if (isUnrealAsset(source)) {
      await importFolder(payloadProject, [source], [], true)
    } else {
      await doSingleAssetBackgroundImport(payloadProject, source, filePath, assetName)
    }
    return
  } catch (err: any) {
    if (signal.aborted) return
    message.error(String(err?.message || t('importToProjectModal.importException')))
  } finally {
    if (importController === controller) {
      preparing.value = false
      loading.value = false
      stopProgressTick()
    }
  }
}

onUnmounted(() => {
  importController?.abort()
  stopProgressTick()
})

const handleCancel = () => {
  importController?.abort()
  preparing.value = false
  archiveDialogVisible.value = false
  pendingArchive.value = null
  visible.value = false
}

onMounted(async () => {
  await loadAllProjects()
})
</script>

<style scoped lang="less">
.archive-choice {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);

  .archive-hint {
    margin: 0;
    color: var(--color-text-secondary);
    font-size: var(--font-size-xs);
  }

  .archive-remember {
    margin-top: var(--space-3);
  }
}

.import-project-modal {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  // 固定高度，不是 max-height：搜索/筛选会让结果条数一直变，用 max-height 的话
  // 弹窗会跟着一下大一下小，正在挑工程的人等于每打一个字就被抖一次。
  // 数值只在这里算一次（扣掉遮罩留白 + 标题栏 + body 内边距 + 页脚），
  // 里面的列表一律 flex 撑满 —— 再在 .browse-list 上写第二个 vh 公式，
  // 就变成两个公式里紧的那个先生效，列表提前滚动、弹窗底下还空着一截
  height: calc(100vh - 240px);

  .progress-panel {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 6px 0;

    .progress-meta {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      color: var(--color-text-secondary);
      font-size: var(--font-size-sm);

      .progress-error {
        color: var(--color-danger-text);
      }
    }
  }

  /* 跟 .browse-list 一样 flex 撑开：写死 300px 会让有结果/没结果之间弹窗高度跳一下 */
  .empty-state {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 1;
    min-height: 200px;
    width: 100%;
  }

  .toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: var(--space-3);
  }

  /* 搜索和筛选是一组，贴在一起；「添加工程」是另一件事，推到右边 */
  .toolbar-filters {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
  }

  /* 可滚动的那一块。上下各画一条线，免得最后一行被切得像掉了半截 */
  .browse-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    overflow-y: auto;
    overflow-x: hidden;
    min-height: 0;
    flex: 1;
    padding: var(--space-4) 0;
    border-top: 1px solid var(--color-separator);
    border-bottom: 1px solid var(--color-separator);
    /* both-edges：只留右边的槽会让卡片右缘比上面的摘要条缩进一个滚动条，左右不对称 */
    scrollbar-gutter: stable both-edges;
  }

  .project-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    grid-auto-rows: max-content;
    align-content: start;
    gap: var(--space-4);
  }

  /* 集合是通栏的一条，点一下就地展开成员，不跳进下一层 */
  .collection-group {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    border: 1px solid var(--color-border-subtle);
    border-radius: var(--radius-md);
    /* 不能用 sunken：它和 AppCard 的 surface 是同一个灰，容器和它装的卡片一个色，
       等于没画这个容器 —— 展开之后看不出哪几张卡属于这个集合。
       page 比卡片再深一档，集合才真的「凹」下去 */
    background: var(--color-bg-page);
    padding: var(--space-3);

    .collection-header {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      min-width: 0;
      margin: 0;
      padding: 0;
      border: 0;
      background: none;
      color: var(--color-text-primary);
      font: inherit;
      text-align: left;
      cursor: pointer;

      &:focus-visible {
        outline: 2px solid var(--color-border-focus);
        outline-offset: 4px;
      }

      &:disabled {
        cursor: default;
      }
    }

    .collection-icon {
      flex: none;
      color: var(--color-folder);
    }

    .collection-name {
      overflow: hidden;
      font-weight: var(--font-weight-semibold);
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .collection-count,
    .collection-pin {
      flex: none;
      color: var(--color-text-muted);
      font-size: var(--font-size-xs);
    }

    /* 箭头推到最右边，展开时转 180° */
    .collection-chevron {
      flex: none;
      margin-left: auto;
      color: var(--color-text-secondary);
      transition: transform var(--motion-fast) var(--easing-standard);
    }

    &.open .collection-chevron {
      transform: rotate(180deg);
    }
  }
}

.modal-footer {
  display: flex;
  align-items: center;
  width: 100%;
  gap: var(--space-4);
}
.footer-actions {
  display: flex;
  flex-shrink: 0;
  gap: var(--space-2);
}
/* 页脚在固定高度的 .import-project-modal 外面，它长高整个弹窗就跟着长高。
   这里按「结论 + 一行警告」预留两行：换个工程有没有版本冲突，弹窗都不再抖 */
.selection-summary {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: calc(var(--font-size-base) * 1.5 * 2 + var(--space-2));
  flex-direction: column;
  justify-content: center;
  gap: var(--space-1);
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
}
/* 「本次导入：xxx」是这个弹窗的前提，不该混在灰色小字里。
   底色用 sunken 不用 soft —— soft 和弹窗自己的 raised 是同一个灰，铺上去等于没铺 */
.source-summary {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-md);
  background: var(--color-bg-sunken);
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
  overflow-wrap: anywhere;
}
.preparation-status {
  margin: 0;
  overflow-wrap: anywhere;
  color: var(--color-text-secondary);
  font-size: var(--font-size-base);
}
.project-search {
  width: 260px;
  max-width: 100%;
}
.engine-filter {
  width: calc(var(--space-8) * 4);
}
/* 弹窗是固定高度的，加载中/加载失败时列表整块不渲染，这里得把剩下的空间撑满，
   不然提示会孤零零贴在一大片空白的顶上 */
.list-status {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  padding: var(--space-4);
}

@media (prefers-reduced-motion: reduce) {
  .import-project-modal .collection-chevron {
    transition: none;
  }
}
@media (max-width: 900px) {
  .import-project-modal .project-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
@media (max-width: 700px) {
  .import-project-modal .project-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
