<script setup lang="ts">
import AppModal from '@renderer/components/AppModal.vue'
import AppButton from '@renderer/components/AppButton.vue'
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useBlueprintLibraryStore } from '@renderer/store/modules/blueprintLibraryStore'
import { appExecuteAgent } from '@renderer/views/Assistant/composables/appAgentRunner'
import { ensureSessionWithTitle } from '@renderer/views/Assistant/composables/chatSendPrimitives'
import { useChatSessionsStore } from '@renderer/store/modules/chatSessions'
import { useTabsStore } from '@renderer/store/modules/tabs'
import BlueprintMigrationWizard from './BlueprintMigrationWizard.vue'
import ImageCropperModal from '@renderer/views/AssetManagement/components/modals/ImageCropperModal.vue'
import { message } from '@/utils/messageManager'
import { confirmDialog } from '@renderer/utils/dialog'
import { toLocalResourceUrl } from '@renderer/utils/localResource'
import {
  getBlueprintTypeLabel,
  getBlueprintStats,
  getCoverForType,
  getIconForType,
  isBlueprintCoverVideo
} from '@renderer/views/BlueprintLibrary/types/blueprint'
import { ensureFFmpeg } from '@renderer/utils/ffmpegGuard'
import { buildBlueprintEditorRoute } from '@renderer/views/BlueprintLibrary/utils/blueprintTabRoute'
import LibraryFormModal from '@renderer/views/library-common/components/LibraryFormModal.vue'
import { LibraryBrowser } from '@renderer/views/library-common/browser'
import type { BrowserItem, BrowserScope } from '@renderer/views/library-common/browser'
import {
  buildTypeFacet,
  toBrowserFolders,
  toBrowserItems
} from '@renderer/views/BlueprintLibrary/services/blueprintBrowser'
import type { Blueprint, BlueprintType } from '@renderer/views/BlueprintLibrary/types/blueprint'

const router = useRouter()
const route = useRoute()
const { t } = useI18n()
const store = useBlueprintLibraryStore()

// ========== 新建蓝图弹窗 ==========
const showCreateModal = ref(false)
/** 高级区展开状态存在 store 里（跨次打开保持），这里桥接成 v-model */
const createAdvancedExpanded = computed({
  get: () => store.createModalAdvancedExpanded,
  set: (v: boolean) => store.setCreateModalAdvancedExpanded(v)
})
const DEFAULT_BLUEPRINT_NAME = t('blueprintGallery.create.defaultName')
const newBpName = ref('')
const newBpType = ref<BlueprintType>('BlueprintClass')
const newBpEngine = ref('5.4')
const newBpDesc = ref('')

const blueprintTypeOptions: BlueprintType[] = [
  'BlueprintClass',
  'WidgetBlueprint',
  'LevelBlueprint',
  'AnimationBlueprint',
  'ActorComponentBlueprint',
  'GameModeBlueprint',
  'BlueprintInterface',
  'BlueprintMacroLibrary',
  'BlueprintFunctionLibrary'
]

// ========== 编辑信息弹窗 ==========
const showRenameModal = ref(false)
const renameId = ref('')
const renameTitle = ref('')
const renameDescription = ref('')

const cropperModalOpen = ref(false)
const cropperImage = ref('')
const cropTargetId = ref<string | null>(null)
const coverActionLoading = ref(false)

const recordingModalOpen = ref(false)
const recordingPreviewUrl = ref('')
const recordingFilePath = ref('')
const recordingDuration = ref(0)
const recordingFormat = ref<'gif' | 'mp4'>('gif')
const recordingTargetId = ref<string | null>(null)
const recordingExporting = ref(false)
let recordingChannel: BroadcastChannel | null = null

// ========== 计算属性 ==========
// ========== 库浏览器 ==========
//
// 这个页面不再自己画搜索框、筛选下拉、网格和列表 —— 那些是每个库都一样的
// 「浏览」，交给 LibraryBrowser。这里只负责把蓝图翻译成它认识的形状，
// 以及那些确实只有蓝图才有的东西（新建、封面、迁移）。

const browserItems = computed(() => toBrowserItems(store.blueprints, getStatsText))
const browserFolders = computed(() => toBrowserFolders(store.collections))

const browserScope = computed<BrowserScope>(() => ({
  id: 'blueprint',
  title: 'blueprintGallery.header.title',
  kinds: ['blueprint'],
  openOnClick: true,
  // 库里通常只有几十条，用不上面包屑和详情面板那一套
  density: 'light',
  facets: [buildTypeFacet(store.blueprints, blueprintTypeOptions)],
  open: (item) => handleOpen(item.id)
}))

/** 建完把 id 交回树，它才知道该把改名弹窗开在哪个文件夹上。建不出来就不回调 */
function handleCreateFolder(name: string, onCreated: (folderKey: string) => void): void {
  const created = store.createFolder(name)
  if (created) onCreated(created.id)
}

/**
 * 删文件夹只删这个「地方」，里面的蓝图回到「全部」。
 *
 * 一并删掉里面的东西太危险，而且用户想删的往往只是分类方式，不是内容。
 */
function handleDeleteFolder(folderKey: string): void {
  const folder = store.collections.find((c) => c.id === folderKey)
  if (!folder) return

  confirmDialog({
    title: t('libraryBrowser.deleteFolder'),
    content: t('libraryBrowser.deleteFolderConfirm', { name: folder.name }),
    danger: true,
    onOk: () => store.deleteCollection(folderKey)
  })
}

function handleMoveToFolder(items: BrowserItem[], folderKey: string): void {
  store.moveBlueprintsToFolder(
    items.map((item) => item.id),
    folderKey
  )
}

function handleOpen(id: string): void {
  router.push(buildBlueprintEditorRoute(id))
}

function handleCreate(): void {
  const blueprintName = newBpName.value.trim() || DEFAULT_BLUEPRINT_NAME
  const bp = store.createBlueprint({
    name: blueprintName,
    blueprintType: newBpType.value,
    engineVersion: newBpEngine.value,
    description: newBpDesc.value.trim()
  })
  showCreateModal.value = false
  newBpName.value = ''
  newBpDesc.value = ''
  router.push(buildBlueprintEditorRoute(bp.id))
}

function openCreateModal(): void {
  newBpName.value = ''
  newBpType.value = 'BlueprintClass'
  newBpEngine.value = '5.4'
  newBpDesc.value = ''
  showCreateModal.value = true
}

/**
 * 从活的引擎里存一段片段进来。
 *
 * 不弹表单，直接把活派给 AI。理由是「要存哪一段」这个信息只有引擎知道 ——
 * 用户是在 UE 的蓝图编辑器里框的节点，盒子这边做不出那个选择器，
 * 硬做只会变成让用户手抄一串 node_id。
 *
 * 走 `appExecuteAgent` 而不是助手页的运行器：用户点完按钮很可能就切走了，
 * 助手页没有 keepAlive，借它的运行器会跟着页面一起卸载。
 */
async function handleCaptureFromEngine(): Promise<void> {
  const chatSid = `library-capture-${Date.now()}`
  const prompt = t('snippetCapture.prompt')
  try {
    ensureSessionWithTitle(chatSid, prompt, {
      chatStore: useChatSessionsStore(),
      tabsStore: useTabsStore(),
      route,
      unnamedTitle: t('assistant.chatFlow.unnamedSession')
    })
    await appExecuteAgent(prompt, undefined, { chatSid })
  } catch (error) {
    message.error(
      t('snippetCapture.failed', {
        reason: error instanceof Error ? error.message : String(error)
      })
    )
  }
  /*
   * 这里**不**手动刷新列表。
   *
   * `appExecuteAgent` 是后台发起、立刻返回的（见 `api/ai.ts`：
   * 「不 await —— 用户要能在执行过程中随时 stop()」），在这儿刷的话，
   * 条目多半还没存下来，而真正存完之后就再也没人刷了。
   *
   * 改成由主进程在**每条真的落盘之后**广播 `library:entry-saved`，
   * store 收到再重读 —— 一轮里存好几条也每条都能及时出现。
   */
}

function handleDelete(bp: Blueprint): void {
  confirmDialog({
    title: t('blueprintGallery.delete.title'),
    content: t('blueprintGallery.delete.content', { name: bp.name }),
    okText: t('blueprintGallery.delete.okText'),
    danger: true,
    cancelText: t('blueprintGallery.delete.cancelText'),
    centered: true,
    onOk: () => {
      store.deleteBlueprint(bp.id)
      message.success(t('blueprintGallery.delete.successMessage'))
    }
  })
}

function handleRename(bp: Blueprint): void {
  renameId.value = bp.id
  renameTitle.value = bp.name
  renameDescription.value = bp.description || ''
  showRenameModal.value = true
}

function confirmRename(): void {
  if (!renameTitle.value.trim()) return
  store.updateBlueprint(renameId.value, {
    name: renameTitle.value.trim(),
    description: renameDescription.value.trim()
  })
  showRenameModal.value = false
}

function handleFavorite(bp: Blueprint): void {
  store.toggleFavorite(bp.id)
}

function getFileExtension(filePath: string): string {
  return filePath.split('.').pop()?.toLowerCase() || ''
}

async function handleChangeCover(bp: Blueprint): Promise<void> {
  try {
    const result = await window.api.dialog.showOpenDialog({
      title: t('blueprintGallery.cover.dialogTitle'),
      properties: ['openFile'],
      filters: [
        {
          name: t('blueprintGallery.cover.dialogFilterName'),
          extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'mp4', 'webm', 'ogg', 'mov']
        }
      ]
    })
    if (result?.canceled || !result?.filePaths?.[0]) return

    const filePath = result.filePaths[0] as string
    const ext = getFileExtension(filePath)
    const directCoverExts = new Set(['gif', 'mp4', 'webm', 'ogg', 'mov'])

    if (directCoverExts.has(ext)) {
      store.updateBlueprint(bp.id, { thumbnail: toLocalResourceUrl(filePath) })
      message.success(t('blueprintGallery.cover.updateSuccess'))
      return
    }

    const fileData = await window.api.fs.readFile(filePath, {
      encoding: 'base64',
      maxLines: -1,
      maxBytes: -1
    })
    if (!fileData?.success || !fileData?.content) {
      message.error(t('blueprintGallery.cover.readImageFailed'))
      return
    }

    const mimeType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
    cropTargetId.value = bp.id
    cropperImage.value = `data:${mimeType};base64,${fileData.content}`
    cropperModalOpen.value = true
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : t('blueprintGallery.cover.chooseFailed')
    message.error(errorMessage)
  }
}

function handleRecordCover(bp: Blueprint): void {
  recordingTargetId.value = bp.id
  window.api.screenRecorder.openQuickWindow().then((result) => {
    if (result?.success === false) {
      message.error(result.error || t('blueprintGallery.cover.openRecorderFailed'))
    }
  })
}

function resetRecordingState(): void {
  recordingPreviewUrl.value = ''
  recordingFilePath.value = ''
  recordingDuration.value = 0
  recordingFormat.value = 'gif'
  recordingExporting.value = false
  recordingTargetId.value = null
}

function handleCloseRecordingModal(): void {
  if (recordingExporting.value) return
  recordingModalOpen.value = false
}

function handleRecordingMetadata(event: Event): void {
  const videoEl = event.target as HTMLVideoElement | null
  const duration = Number(videoEl?.duration || 0)
  recordingDuration.value = Number.isFinite(duration) ? duration : 0
}

function handleRecordingMessage(data: unknown): void {
  if (!recordingTargetId.value) return
  if (!data || typeof data !== 'object') return
  const payload = data as { type?: string; filePath?: string }
  if (payload.type !== 'recording-complete' || !payload.filePath) return
  recordingFilePath.value = payload.filePath
  recordingPreviewUrl.value = toLocalResourceUrl(payload.filePath) ?? ''
  recordingDuration.value = 0
  recordingFormat.value = 'gif'
  recordingModalOpen.value = true
}

function buildRecordingExportPath(
  filePath: string,
  format: 'gif' | 'mp4'
): Promise<string | undefined> {
  return window.api.screenRecorder.getRecordingsDir().then((result) => {
    if (!result?.success || !result.dirPath) return undefined
    const baseName =
      filePath
        .split(/[\\/]/)
        .pop()
        ?.replace(/\.[^/.\\]+$/, '') || 'recording'
    const normalizedDir = result.dirPath.replace(/[\\/]+$/, '')
    return `${normalizedDir}\\${baseName}-cover-${Date.now()}.${format}`
  })
}

async function handleConfirmRecordingCover(): Promise<void> {
  if (recordingExporting.value) return
  if (!recordingTargetId.value || !recordingFilePath.value) {
    message.error(t('blueprintGallery.cover.noRecordingAvailable'))
    return
  }

  recordingExporting.value = true
  try {
    const outputPath = await buildRecordingExportPath(
      recordingFilePath.value,
      recordingFormat.value
    )
    // 没装 FFmpeg 就弹安装指引，别让用户拿到一句「导出失败」
    if (!(await ensureFFmpeg())) return

    const result = await window.api.screenRecorder.exportRecording({
      inputPath: recordingFilePath.value,
      format: recordingFormat.value,
      quality: 'balanced',
      resolution: 'original',
      fps: 30,
      bitrate: 12,
      includeAudio: recordingFormat.value === 'mp4',
      highQualityScale: true,
      trimStart: 0,
      trimEnd: recordingDuration.value > 0 ? recordingDuration.value : 0,
      outputPath
    })
    if (!result?.success || !result.filePath) {
      message.error(result?.error || t('blueprintGallery.cover.exportFailed'))
      return
    }

    store.updateBlueprint(recordingTargetId.value, {
      thumbnail: toLocalResourceUrl(result.filePath)
    })
    recordingModalOpen.value = false
    message.success(t('blueprintGallery.cover.updateSuccess'))
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : t('blueprintGallery.cover.exportFailed')
    message.error(errorMessage)
  } finally {
    recordingExporting.value = false
  }
}

function handleResetCover(bp: Blueprint): void {
  store.updateBlueprint(bp.id, { thumbnail: undefined })
  message.success(t('blueprintGallery.cover.resetSuccess'))
}

function handleCropConfirm(dataUrl: string): void {
  if (!cropTargetId.value) {
    cropperModalOpen.value = false
    cropperImage.value = ''
    return
  }
  coverActionLoading.value = true
  try {
    store.updateBlueprint(cropTargetId.value, { thumbnail: dataUrl })
    cropperModalOpen.value = false
    cropperImage.value = ''
    message.success(t('blueprintGallery.cover.updateSuccess'))
  } finally {
    coverActionLoading.value = false
  }
}

function getStatsText(bp: Blueprint): string {
  const s = getBlueprintStats(bp)
  const parts: string[] = []
  if (s.functionCount > 0)
    parts.push(t('blueprintGallery.stats.functions', { count: s.functionCount }))
  if (s.variableCount > 0)
    parts.push(t('blueprintGallery.stats.variables', { count: s.variableCount }))
  if (s.graphCount > 0) parts.push(t('blueprintGallery.stats.graphs', { count: s.graphCount }))
  if (s.componentCount > 0)
    parts.push(t('blueprintGallery.stats.components', { count: s.componentCount }))
  return parts.join(' · ') || t('blueprintGallery.stats.empty')
}

onMounted(() => {
  recordingChannel = new BroadcastChannel('screen-recorder-cover')
  recordingChannel.onmessage = (event) => {
    handleRecordingMessage(event.data)
  }
})

watch(recordingModalOpen, (open) => {
  if (!open) {
    resetRecordingState()
  }
})

watch(cropperModalOpen, (open) => {
  if (!open) {
    cropTargetId.value = null
    cropperImage.value = ''
    coverActionLoading.value = false
  }
})

onUnmounted(() => {
  recordingChannel?.close()
  recordingChannel = null
})

// ========== 旧版迁移 ==========
const showMigrationWizard = ref(false)

// 自定义指令：自动获取焦点
const vFocus = {
  mounted: (el: HTMLElement) => el.focus()
}
</script>

<template>
  <div class="library-gallery-page">
    <LibraryBrowser
      class="gallery-browser"
      :scope="browserScope"
      :items="browserItems"
      :folders="browserFolders"
      @move="handleMoveToFolder"
      @create-folder="handleCreateFolder"
      @rename-folder="store.renameCollection"
      @delete-folder="handleDeleteFolder"
    >
      <template #toolbar>
        <div class="action-island">
          <button
            type="button"
            class="icon-btn btn-import"
            :title="$t('blueprintMigration.title')"
            :aria-label="$t('blueprintMigration.title')"
            @click="showMigrationWizard = true"
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </button>

          <!--
            从活的引擎里存一段进来。

            交给 AI 而不是自己弹个表单：要存哪一段得先在 UE 里框选节点，
            而框选状态只有引擎知道 —— 盒子这边做不出那个选择器。
            让 agent 先 blueprint_get_graph 读回来、跟用户确认要哪几个节点，
            再 blueprint_library_save。
          -->
          <button
            type="button"
            class="icon-btn btn-capture"
            :title="$t('snippetCapture.title')"
            :aria-label="$t('snippetCapture.title')"
            @click="handleCaptureFromEngine"
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M3 9V5a2 2 0 0 1 2-2h4" />
              <path d="M21 9V5a2 2 0 0 0-2-2h-4" />
              <path d="M3 15v4a2 2 0 0 0 2 2h4" />
              <path d="M21 15v4a2 2 0 0 1-2 2h-4" />
              <line x1="12" y1="8" x2="12" y2="16" />
              <polyline points="9 13 12 16 15 13" />
            </svg>
          </button>
        </div>

        <button type="button" class="btn-primary-create" @click="openCreateModal">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
          <span>{{ $t('blueprintGallery.create.button') }}</span>
        </button>
      </template>

      <!-- 封面：渐变底 + 录屏/图片，都没有就画类型图标 -->
      <template #card-cover="{ item }">
        <div class="card-cover" :style="item.coverStyle">
          <video
            v-if="isBlueprintCoverVideo(item.thumbnail)"
            class="cover-media"
            :src="item.thumbnail"
            autoplay
            loop
            muted
            playsinline
          ></video>
          <img
            v-else-if="item.thumbnail"
            class="cover-media"
            :src="item.thumbnail"
            :alt="item.name"
          />
          <svg v-else class="cover-type-icon" viewBox="0 0 24 24">
            <path :d="getIconForType((item.source as Blueprint).blueprintType)" />
          </svg>
          <span v-if="item.isFavorite" class="fav-badge">★</span>
        </div>
      </template>

      <!-- 删除 / 改名 / 换封面是蓝图自己的事，浏览器只把条目递出来 -->
      <template #card-menu="{ item }">
        <div class="menu-item" @click.stop="handleChangeCover(item.source as Blueprint)">
          {{ $t('blueprintGallery.menu.changeCover') }}
        </div>
        <div class="menu-item" @click.stop="handleRecordCover(item.source as Blueprint)">
          {{ $t('blueprintGallery.menu.recordCover') }}
        </div>
        <div
          v-if="(item.source as Blueprint).thumbnail"
          class="menu-item"
          @click.stop="handleResetCover(item.source as Blueprint)"
        >
          {{ $t('blueprintGallery.menu.resetCover') }}
        </div>
        <div class="menu-item" @click.stop="handleRename(item.source as Blueprint)">
          {{ $t('blueprintGallery.menu.editInfo') }}
        </div>
        <div class="menu-item" @click.stop="handleFavorite(item.source as Blueprint)">
          {{
            (item.source as Blueprint).isFavorite
              ? $t('blueprintGallery.menu.unfavorite')
              : $t('blueprintGallery.menu.favorite')
          }}
        </div>
        <div class="menu-item danger" @click.stop="handleDelete(item.source as Blueprint)">
          {{ $t('blueprintGallery.menu.delete') }}
        </div>
      </template>
    </LibraryBrowser>

    <!-- 新建蓝图 -->
    <LibraryFormModal
      v-model:open="showCreateModal"
      v-model:advanced-expanded="createAdvancedExpanded"
      size="wide"
      icon="plus"
      :title="$t('blueprintGallery.create.modalTitle')"
      :advanced-hint="$t('blueprintGallery.create.advancedHint')"
      :advanced-label="$t('blueprintGallery.create.advancedToggle')"
      :cancel-text="$t('blueprintGallery.create.cancel')"
      :confirm-text="$t('blueprintGallery.create.confirm')"
      @confirm="handleCreate"
    >
      <div class="name-section">
        <label class="form-label">{{ $t('blueprintGallery.create.nameLabel') }}</label>
        <input
          v-model="newBpName"
          v-focus
          class="form-input name-input"
          :placeholder="$t('blueprintGallery.create.namePlaceholder')"
          @keyup.enter="handleCreate"
        />
      </div>

      <template #advanced>
        <div class="advanced-item">
          <label class="form-label">{{ $t('blueprintGallery.create.typeLabel') }}</label>
          <div class="type-selector-grid compact">
            <div
              v-for="bt in blueprintTypeOptions"
              :key="bt"
              class="type-card"
              :class="{ active: newBpType === bt }"
              @click="newBpType = bt"
            >
              <div class="type-icon-wrapper" :style="getCoverForType(bt)">
                <svg class="type-icon" viewBox="0 0 24 24">
                  <path :d="getIconForType(bt)" />
                </svg>
              </div>
              <div class="type-label">{{ getBlueprintTypeLabel(bt) }}</div>
            </div>
          </div>
        </div>

        <div class="advanced-item">
          <label class="form-label">{{ $t('blueprintGallery.create.engineLabel') }}</label>
          <div class="engine-capsules">
            <button
              v-for="v in store.engineVersionList"
              :key="v"
              class="capsule-btn"
              :class="{ active: newBpEngine === v }"
              @click="newBpEngine = v"
            >
              {{ v }}
            </button>
          </div>
        </div>

        <div class="advanced-item">
          <label class="form-label">{{ $t('blueprintGallery.create.descLabel') }}</label>
          <textarea
            v-model="newBpDesc"
            class="form-input form-textarea"
            :placeholder="$t('blueprintGallery.create.descPlaceholder')"
            rows="2"
          />
        </div>
      </template>
    </LibraryFormModal>

    <!-- 编辑蓝图信息 -->
    <LibraryFormModal
      v-model:open="showRenameModal"
      icon="edit"
      :title="$t('blueprintGallery.rename.modalTitle')"
      :cancel-text="$t('blueprintGallery.rename.cancel')"
      :confirm-text="$t('blueprintGallery.rename.confirm')"
      :confirm-disabled="!renameTitle.trim()"
      @confirm="confirmRename"
    >
      <div class="name-section">
        <label class="form-label">{{ $t('blueprintGallery.rename.nameLabel') }}</label>
        <input
          v-model="renameTitle"
          v-focus
          class="form-input name-input"
          :placeholder="$t('blueprintGallery.rename.namePlaceholder')"
          @keyup.enter="confirmRename"
        />
      </div>
      <div class="form-group">
        <label class="form-label">{{ $t('blueprintGallery.rename.descLabel') }}</label>
        <textarea
          v-model="renameDescription"
          class="form-input form-textarea"
          :placeholder="$t('blueprintGallery.rename.descPlaceholder')"
          maxlength="500"
          rows="4"
        />
      </div>
    </LibraryFormModal>

    <AppModal
      v-model:open="recordingModalOpen"
      :title="$t('blueprintGallery.cover.modalTitle')"
      class="recording-cover-modal"
      :mask-closable="!recordingExporting"
      :closable="!recordingExporting"
      @cancel="handleCloseRecordingModal"
    >
      <div class="recording-cover-body">
        <video
          v-if="recordingPreviewUrl"
          class="recording-cover-video"
          controls
          :src="recordingPreviewUrl"
          @loadedmetadata="handleRecordingMetadata"
        />
        <div v-else class="recording-cover-empty">
          {{ $t('blueprintGallery.cover.notFound') }}
        </div>
      </div>
      <div class="recording-cover-options">
        <div class="recording-cover-label">{{ $t('blueprintGallery.cover.formatLabel') }}</div>
        <a-radio-group
          v-model:value="recordingFormat"
          class="recording-cover-group"
          :disabled="recordingExporting"
        >
          <a-radio-button value="gif">GIF</a-radio-button>
          <a-radio-button value="mp4">MP4</a-radio-button>
        </a-radio-group>
      </div>
      <template #footer>
        <AppButton :disabled="recordingExporting" @click="handleCloseRecordingModal">
          {{ $t('blueprintGallery.cover.cancel') }}
        </AppButton>
        <AppButton
          variant="primary"
          :loading="recordingExporting"
          @click="handleConfirmRecordingCover"
        >
          {{ $t('blueprintGallery.cover.confirm') }}
        </AppButton>
      </template>
    </AppModal>

    <ImageCropperModal
      v-model:open="cropperModalOpen"
      :image="cropperImage"
      :loading="coverActionLoading"
      @confirm="handleCropConfirm"
    />

    <!-- 旧版迁移向导 -->
    <BlueprintMigrationWizard
      v-if="showMigrationWizard"
      @close="showMigrationWizard = false"
      @done="showMigrationWizard = false"
    />
  </div>
</template>

<style scoped lang="less">
.library-gallery-page {
  // 列布局 + overflow: hidden，让浏览器自己的内容区成为**唯一**的滚动容器。
  // 页面这一层也开 overflow-y: auto 的话会出现两条滚动条，内容区还会被挤扁。
  display: flex;
  flex-direction: column;
  padding: var(--space-4) var(--space-1);
  height: 100%;
  min-height: 0;
  color: var(--color-text-secondary);
  overflow: hidden;
}

.recording-cover-body {
  min-height: 240px;
  border-radius: 12px;
  overflow: hidden;
  background: var(--color-bg-surface-hover);
}

.recording-cover-video {
  width: 100%;
  max-height: 420px;
  display: block;
  background: var(--color-bg-page);
}

.recording-cover-empty {
  min-height: 240px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-muted);
}

.recording-cover-options {
  margin-top: 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.recording-cover-label {
  font-size: 13px;
  color: var(--color-text-secondary);
}

.recording-cover-group {
  display: inline-flex;
}

// ========== 新建弹窗里的蓝图专属控件 ==========
// 弹窗外壳与通用表单样式在 library-common/components/LibraryFormModal.vue，
// 这里只留蓝图独有的类型网格与引擎版本胶囊（它们通过插槽渲染，走本页 scope）。
.advanced-item {
  margin-bottom: 16px;

  &:last-child {
    margin-bottom: 0;
  }
}

// 蓝图类型选择网格
.type-selector-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
  gap: 12px;

  &.compact {
    grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
    gap: 8px;
  }
}

.type-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: var(--color-bg-surface);
  border: 1px solid var(--color-border);
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);

  .type-icon-wrapper {
    width: 32px;
    height: 32px;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    box-shadow: 0 2px 8px var(--shadow-color-weak);

    .type-icon {
      width: 20px;
      height: 20px;
      fill: var(--color-text-secondary);
      filter: drop-shadow(0 1px 2px var(--shadow-color));
    }
  }

  .type-label {
    font-size: 12px;
    font-weight: 500;
    color: var(--color-text-secondary);
    line-height: 1.3;
  }

  &:hover {
    background: var(--color-bg-surface-hover);
    border-color: var(--color-border-strong);
  }

  &.active {
    background: var(--color-bg-selected);
    box-shadow:
      inset 0 0 0 1px var(--color-accent-border),
      0 4px 12px var(--shadow-color-weak);

    .type-label {
      color: var(--color-text-primary);
    }
    .type-icon {
      fill: var(--color-text-primary);
    }
  }
}

.engine-capsules {
  display: flex;
  gap: 4px;
  background: var(--color-bg-sunken);
  padding: 4px;
  border-radius: 8px;
  border: 1px solid var(--color-border);
  flex-wrap: nowrap;

  .capsule-btn {
    flex: 0 0 auto;
    min-width: 44px;
    padding: 7px 10px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--color-text-muted);
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
    white-space: nowrap;

    &:hover {
      color: var(--color-text-secondary);
      background: var(--color-bg-surface-hover);
    }

    &.active {
      background: var(--color-bg-raised);
      color: var(--color-text-primary);
      box-shadow: 0 2px 6px var(--shadow-color-weak);
    }
  }
}
</style>
