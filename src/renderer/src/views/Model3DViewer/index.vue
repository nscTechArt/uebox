<script setup lang="ts">
/**
 * Model3DViewer 页面 —— 本地 3D 模型查看器
 *
 * 2026-09-14 重做右栏。原来这里是一个 dat.GUI：四种灯 × 颜色/强度/XYZ 差不多二十个控件，
 * 还把 three 的类名（AmbientLight/DirectionalLight）用等宽字体印在中文名旁边。
 * 那是调参面板，不是产品 —— 看模型的人要的是"这东西长什么样"，不是方向光的 Z 坐标。
 * 现在只留三件：选氛围（预设）、调亮度、看规格。
 */
import { ref, computed, onMounted, watch, onActivated } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import ModelViewer from '@renderer/components/ModelViewer.vue'
import ViewModeToolbar from './ViewModeToolbar.vue'
import { useModel3DViewerStore, type LightPreset } from './viewerStore'
import AppSegmented from '@renderer/components/AppSegmented.vue'
import { assetDataAPI } from '@renderer/api/assetData'
import { message } from '@renderer/utils/messageManager'
import {
  PhArrowCounterClockwise,
  PhArrowsOutCardinal,
  PhFolderOpen,
  PhUploadSimple
} from '@phosphor-icons/vue'

const route = useRoute()
const { t } = useI18n()
const store = useModel3DViewerStore()

const currentFile = ref<File | null>(null)
const currentFilePath = ref<string | null>(null)
const currentFileUrl = ref<string | null>(null)
const assetKey = ref('')
const isDragging = ref(false)
const showPathDetails = ref(false)
const fileSize = ref<number | null>(null)
const modelViewerRef = ref<InstanceType<typeof ModelViewer> | null>(null)

const LIGHT_PRESETS: readonly LightPreset[] = ['studio', 'daylight', 'night']

const lightPreset = computed<LightPreset>({
  get: () => store.lightPreset,
  set: (value) => store.setLightPreset(value)
})

const modelStats = ref<{
  vertices?: number
  faces?: number
  materials?: number
  meshCount?: number
  textureCount?: number
  boundingBox?: { x: number; y: number; z: number }
  hasAnimations?: boolean
  animationCount?: number
}>({})

const hasModel = computed(
  () => !!(currentFile.value || currentFilePath.value || currentFileUrl.value)
)

/** 从路由参数读取文件路径（从资产库等页面跳过来） */
const loadFilePathFromRoute = (): void => {
  const filePath = route.query.filePath as string | undefined
  const fileUrl = route.query.fileUrl as string | undefined
  if (filePath || fileUrl) {
    currentFilePath.value = filePath || null
    currentFileUrl.value = fileUrl || null
    currentFile.value = null
    assetKey.value = typeof route.query.assetKey === 'string' ? route.query.assetKey : ''
  }
}

onMounted(loadFilePathFromRoute)

watch(
  () => [route.query.filePath, route.query.fileUrl, route.query.assetKey],
  loadFilePathFromRoute
)

/** 选文件走 Electron 的 dialog，拿得到真实路径，贴图才解析得出来 */
const handleFileSelect = async (): Promise<void> => {
  try {
    const result = await window.api.dialog.showOpenDialog({
      title: t('model3dViewer.dialog.selectModelTitle'),
      properties: ['openFile'],
      filters: [
        {
          name: t('model3dViewer.dialog.modelFilesFilter'),
          extensions: ['fbx', 'obj', 'glb', 'gltf']
        },
        { name: t('model3dViewer.dialog.allFilesFilter'), extensions: ['*'] }
      ]
    })

    if (!result.canceled && result.filePaths?.length) {
      assetKey.value = ''
      currentFilePath.value = result.filePaths[0]
      currentFileUrl.value = null
      currentFile.value = null
    }
  } catch (error) {
    console.error('[Model3DViewer] 文件选择失败:', error)
  }
}

const handleDrop = async (event: DragEvent): Promise<void> => {
  event.preventDefault()
  event.stopPropagation()
  isDragging.value = false

  const file = event.dataTransfer?.files?.[0]
  if (!file) return

  const validExtensions = ['.fbx', '.obj', '.glb', '.gltf']
  if (!validExtensions.some((ext) => file.name.toLowerCase().endsWith(ext))) {
    alert(t('model3dViewer.alerts.invalidFormat'))
    return
  }

  try {
    const filePath = await window.api.getPathForFile(file)
    const fallbackPath = (file as File & { path?: string }).path
    assetKey.value = ''
    if (filePath || fallbackPath) {
      currentFilePath.value = filePath || fallbackPath || null
      currentFileUrl.value = null
      currentFile.value = null
    } else {
      // 拿不到路径就退回 File 对象：模型还能看，贴图多半丢
      currentFile.value = file
      currentFilePath.value = null
      currentFileUrl.value = null
    }
  } catch (error) {
    console.error('[Model3DViewer] 获取文件路径失败:', error)
    alert(t('model3dViewer.alerts.getPathFailed'))
  }
}

const handleDragOver = (event: DragEvent): void => {
  event.preventDefault()
  event.stopPropagation()
  isDragging.value = true
}

const handleDragLeave = (event: DragEvent): void => {
  event.preventDefault()
  event.stopPropagation()
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const { clientX: x, clientY: y } = event
  if (x <= rect.left || x >= rect.right || y <= rect.top || y >= rect.bottom) {
    isDragging.value = false
  }
}

const handleModelStats = (stats: typeof modelStats.value): void => {
  modelStats.value = stats
}

/**
 * 从资产库点进来才带 assetKey —— 那才有"更新谁的缩略图"这回事。
 * 自己拖进来的文件不属于任何资产，按钮就该是灰的，而不是点了没反应。
 */
const canSnapshot = computed(() => hasModel.value && !!assetKey.value)

const handleSnapshot = async (base64: string): Promise<void> => {
  const targetAssetKey = assetKey.value
  if (!targetAssetKey) return
  try {
    await assetDataAPI.saveThumbnail(targetAssetKey, base64)
    // 资产库那边列表是进页面时读的，不说一声它还显示旧图
    window.dispatchEvent(
      new CustomEvent('asset-thumbnail:updated', { detail: { assetKey: targetAssetKey } })
    )
    message.success(t('model3dViewer.snapshot.saved'))
  } catch (error) {
    console.error('[Model3DViewer] 更新缩略图失败:', error)
    message.error(
      t('model3dViewer.snapshot.failed', {
        reason: error instanceof Error ? error.message : String(error)
      })
    )
  }
}

const fileFormat = computed<string | null>(() => {
  const source = currentFilePath.value || currentFileUrl.value || currentFile.value?.name
  if (!source) return null
  const match = source.match(/\.([a-zA-Z0-9]+)(?:[?#].*)?$/i)
  return match ? match[1].toUpperCase() : null
})

const displayFileName = computed(() => {
  if (currentFile.value?.name) return currentFile.value.name
  const explicitName = route.query.fileName as string | undefined
  if (explicitName) return explicitName

  const source = currentFilePath.value || currentFileUrl.value
  if (!source) return t('model3dViewer.unknownFileName')

  const rawName = source.split(/[/\\]/).pop() || source
  try {
    return decodeURIComponent(rawName)
  } catch {
    return rawName
  }
})

const displaySource = computed(() => currentFilePath.value || currentFileUrl.value || '')

/** 规格表。没有值的行不显示，免得满屏都是「-」 */
const infoRows = computed(() => {
  const stats = modelStats.value
  const rows: { label: string; value: string; mono?: boolean }[] = []
  if (fileFormat.value) {
    rows.push({ label: t('model3dStudio.modelInfo.fileFormat'), value: fileFormat.value })
  }
  if (fileSize.value !== null) {
    rows.push({ label: t('model3dStudio.modelInfo.fileSize'), value: formatBytes(fileSize.value) })
  }
  const numeric: [string, number | undefined][] = [
    [t('model3dStudio.modelInfo.vertices'), stats.vertices],
    [t('model3dStudio.modelInfo.faces'), stats.faces],
    [t('model3dStudio.modelInfo.materials'), stats.materials],
    [t('model3dStudio.modelInfo.meshCount'), stats.meshCount],
    [t('model3dStudio.modelInfo.textureCount'), stats.textureCount]
  ]
  numeric.forEach(([label, value]) => {
    if (value !== undefined) rows.push({ label, value: value.toLocaleString(), mono: true })
  })
  if (stats.boundingBox) {
    const { x, y, z } = stats.boundingBox
    rows.push({
      label: t('model3dStudio.modelInfo.boundingBox'),
      value: `${x} × ${y} × ${z}`,
      mono: true
    })
  }
  return rows
})

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, index)).toFixed(2)} ${units[index]}`
}

watch(
  () => currentFilePath.value,
  async (newPath) => {
    if (!newPath) {
      fileSize.value = null
      return
    }
    try {
      const result = await window.electron.ipcRenderer.invoke('s3:getFileSize', newPath)
      fileSize.value = result?.size ?? null
    } catch {
      fileSize.value = null
    }
  },
  { immediate: true }
)

onActivated(() => {
  modelViewerRef.value?.forceResize()
})
</script>

<template>
  <div class="model-3d-viewer-page">
    <div class="toolbar">
      <div class="toolbar-left">
        <template v-if="hasModel">
          <div class="file-name" :title="displayFileName">{{ displayFileName }}</div>
          <button
            v-if="displaySource"
            class="source-chip"
            :title="displaySource"
            @click="showPathDetails = !showPathDetails"
          >
            <PhFolderOpen :size="14" />
            <span class="source-text">{{
              showPathDetails ? displaySource : $t('model3dViewer.fileMeta.viewSource')
            }}</span>
          </button>
        </template>
        <div v-else class="file-name muted">{{ $t('model3dViewer.placeholder.title') }}</div>
      </div>

      <button class="file-select-btn" @click="handleFileSelect">
        {{ $t('model3dViewer.toolbar.selectFile') }}
      </button>
    </div>

    <div class="main-content">
      <div
        class="viewer-container"
        :class="{ 'is-dragging': isDragging }"
        @drop="handleDrop"
        @dragover="handleDragOver"
        @dragleave="handleDragLeave"
      >
        <ModelViewer
          ref="modelViewerRef"
          :file="currentFile"
          :file-path="currentFilePath"
          :file-url="currentFileUrl"
          :light-preset="store.lightPreset"
          :exposure="store.exposure"
          :view-mode="store.viewMode"
          :auto-rotate="store.autoRotate"
          :auto-play="store.autoPlay"
          @model-stats="handleModelStats"
          @snapshot="handleSnapshot"
        />

        <ViewModeToolbar
          v-if="hasModel"
          :can-snapshot="canSnapshot"
          @capture-snapshot="modelViewerRef?.captureSnapshot()"
        />

        <div v-if="isDragging" class="drag-overlay">
          <PhUploadSimple :size="32" />
          <p class="drag-text">{{ $t('model3dViewer.dragOverlay.text') }}</p>
        </div>
      </div>

      <aside class="side-panel">
        <section class="panel-section">
          <h3 class="section-title">{{ $t('model3dViewer.panel.lightTitle') }}</h3>
          <AppSegmented
            v-model="lightPreset"
            :options="LIGHT_PRESETS"
            :aria-label="$t('model3dViewer.panel.lightTitle')"
          >
            <template #default="{ option }">{{
              $t(`model3dViewer.lightPresets.${option}`)
            }}</template>
          </AppSegmented>

          <label class="slider-row">
            <span class="slider-label">{{ $t('model3dViewer.panel.brightness') }}</span>
            <input
              class="slider"
              type="range"
              min="0.4"
              max="1.8"
              step="0.05"
              :value="store.exposure"
              @input="store.setExposure(Number(($event.target as HTMLInputElement).value))"
            />
          </label>
        </section>

        <section class="panel-section">
          <h3 class="section-title">{{ $t('model3dViewer.panel.viewTitle') }}</h3>
          <div class="view-actions">
            <button class="ghost-btn" :disabled="!hasModel" @click="modelViewerRef?.resetView()">
              <PhArrowCounterClockwise :size="15" />
              <span>{{ $t('model3dViewer.panel.resetView') }}</span>
            </button>
            <button class="ghost-btn" :disabled="!hasModel" @click="modelViewerRef?.toggleUpAxis()">
              <PhArrowsOutCardinal :size="15" />
              <span>{{ $t('model3dViewer.panel.flipUpAxis') }}</span>
            </button>
          </div>
        </section>

        <section v-if="infoRows.length" class="panel-section">
          <h3 class="section-title">{{ $t('model3dViewer.panel.infoTitle') }}</h3>
          <dl class="info-grid">
            <template v-for="row in infoRows" :key="row.label">
              <dt class="info-label">{{ row.label }}</dt>
              <dd class="info-value" :class="{ mono: row.mono }">{{ row.value }}</dd>
            </template>
          </dl>
        </section>
      </aside>
    </div>
  </div>
</template>

<style scoped lang="less">
.model-3d-viewer-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  color: var(--color-text-primary);
}

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  min-height: 48px;
  padding: var(--space-3) var(--space-6);
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.toolbar-left {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}

.file-name {
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;

  &.muted {
    color: var(--color-text-muted);
    font-weight: var(--font-weight-normal);
  }
}

.source-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  max-width: 420px;
  padding: var(--space-1) var(--space-2);
  border: 0;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  cursor: pointer;
  transition: background-color var(--motion-fast) var(--easing-standard);

  &:hover {
    background: var(--color-bg-surface-hover);
    color: var(--color-text-secondary);
  }
}

.source-text {
  font-family: var(--font-family-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-select-btn {
  padding: var(--space-2) var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-surface);
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
  cursor: pointer;
  transition: border-color var(--motion-fast) var(--easing-standard);

  &:hover {
    border-color: var(--color-border-strong);
  }
}

.main-content {
  display: flex;
  flex: 1;
  gap: var(--space-4);
  padding: var(--space-4) var(--space-6) var(--space-6);
  min-height: 0;
}

.viewer-container {
  position: relative;
  flex: 1;
  min-width: 0;
  border: 1px solid transparent;
  border-radius: var(--radius-container);
  transition: border-color var(--motion-fast) var(--easing-standard);

  &.is-dragging {
    border-color: var(--color-accent-border);
  }
}

.drag-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  border-radius: var(--radius-container);
  background: var(--color-bg-overlay);
  color: var(--color-text-on-solid);
  pointer-events: none;
}

.drag-text {
  margin: 0;
  font-size: var(--font-size-sm);
}

.side-panel {
  width: 280px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
  padding: var(--space-5);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-container);
  background: var(--color-bg-surface);
  overflow-y: auto;
}

.panel-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.section-title {
  margin: 0;
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--color-text-muted);
}

/*
 * AppSegmented 本来是按内容宽度摆的（设置页里它旁边还有别的东西），
 * 这里它是一栏里唯一的控件，三项的最小宽度加起来正好比侧栏内宽多几个像素 ——
 * 最后一项就被挤出容器、圆角被切掉。让三项平分这一行，多宽都对得齐。
 */
.panel-section :deep(.app-segmented) {
  display: flex;
  width: 100%;
}

.panel-section :deep(.app-segmented__item) {
  flex: 1;
  min-width: 0;
}

.slider-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.slider-label {
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  flex-shrink: 0;
}

.slider {
  flex: 1;
  height: 4px;
  min-width: 0;
  border-radius: 2px;
  background: var(--color-bg-surface-hover);
  outline: none;
  cursor: pointer;

  &::-webkit-slider-thumb {
    appearance: none;
    width: 13px;
    height: 13px;
    border-radius: 50%;
    background: var(--color-accent-solid);
    cursor: pointer;
  }

  &::-moz-range-thumb {
    width: 13px;
    height: 13px;
    border: none;
    border-radius: 50%;
    background: var(--color-accent-solid);
    cursor: pointer;
  }
}

.view-actions {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.ghost-btn {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  text-align: left;
  cursor: pointer;
  transition:
    border-color var(--motion-fast) var(--easing-standard),
    color var(--motion-fast) var(--easing-standard);

  &:hover:not(:disabled) {
    border-color: var(--color-border-strong);
    color: var(--color-text-primary);
  }

  &:disabled {
    border-color: var(--color-border-subtle);
    color: var(--color-text-disabled);
    cursor: default;
  }
}

.info-grid {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: var(--space-2) var(--space-4);
  margin: 0;
}

.info-label {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}

.info-value {
  margin: 0;
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  text-align: right;

  &.mono {
    font-family: var(--font-family-mono);
  }
}
</style>
