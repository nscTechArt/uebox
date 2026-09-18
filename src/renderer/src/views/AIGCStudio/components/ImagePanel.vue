<script setup lang="ts">
import AppSpin from '@renderer/components/AppSpin.vue'
import AppModal from '@renderer/components/AppModal.vue'
import { computed, nextTick, onActivated, onMounted, onUnmounted, ref, watch } from 'vue'
import { aiProviderAPI } from '@renderer/api/aiProvider'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { toLocalResourceUrl } from '@renderer/utils/localResource'
import {
  PhCaretDown,
  PhCircleNotch,
  PhFolderOpen,
  PhGear,
  PhLock,
  PhPlus,
  PhSparkle,
  PhX
} from '@phosphor-icons/vue'
import { message } from '@renderer/utils/messageManager'
import { aigcEventBus, AIGC_EVENTS } from '../aigcEventBus'
import {
  buildInfographicModelOptions,
  type InfographicModelOption
} from '@renderer/services/infographic'
import { usePromptOptimizer } from '../composables/usePromptOptimizer'
import { setValueWithUndo } from '../composables/useUndoableInput'
import { useImageStudioStore } from '../imageStore'
import { openReferenceLibraryFolder } from '../referenceLibraryNavigation'
import { useVaultStore } from '@renderer/store/modules/vaultStore'
import {
  getActiveSizeTier,
  getResolutionPixels,
  getSizeTierOptions,
  resolveResolutionForRatio,
  resolveResolutionForTier,
  type ImageSizeTier
} from '../imageSizeTiers'
import {
  AIGC_IMAGE_REFERENCE_LIMIT,
  AIGC_REFERENCE_LIBRARY_FOLDER_NAME
} from '../../../../../shared/aigcReferenceLibrary'
import {
  GPT_IMAGE_MODEL,
  IMAGE_MODEL_OPTIONS,
  getImageModelOption,
  getGptImageRatioForSize,
  normalizeImageQuality,
  normalizeImageResolutionForModel,
  normalizeImageRatioForModel,
  type ImageAspectRatio,
  type ImageQuality,
  type ImageResolution
} from '../../../../../shared/imageGenerationModels'

const MAX_REFERENCE_IMAGES = AIGC_IMAGE_REFERENCE_LIMIT
const MIN_GENERATION_COUNT = 1
const MAX_GENERATION_COUNT = 10
/** 常用张数。1–10 的离散小范围用滑块最难点准，先给四个一步到位的 */
const COUNT_PRESETS = [1, 2, 4, 8] as const
/** 档位下面那行灰字：说清这个档位到底会出多大的图 */
const SIZE_TIER_SUMMARY_KEYS: Record<ImageSizeTier, string> = {
  auto: 'aigcImagePanel.resolution.hints.auto',
  '1K': 'aigcImagePanel.resolution.hints.k1',
  '2K': 'aigcImagePanel.resolution.hints.k2',
  '4K': 'aigcImagePanel.resolution.hints.k4'
}
const DEFAULT_STYLE = '智能推荐'
const COMMON_RATIO_KEYS = ['1:1', '3:4', '4:3', '16:9', '9:16'] as const
const BATCH_SUBMIT_INTERVAL_MS = 1700
const GENERATION_START_TIMEOUT_MS = 20_000
const SELECTED_MODEL_STORAGE_KEY = 'aigc-image-selected-model'

const modelOptions = IMAGE_MODEL_OPTIONS

const ratioOptions = [
  { key: '1:1', label: '1:1' },
  { key: '1:4', label: '1:4' },
  { key: '1:8', label: '1:8' },
  { key: '2:3', label: '2:3' },
  { key: '3:2', label: '3:2' },
  { key: '3:4', label: '3:4' },
  { key: '4:1', label: '4:1' },
  { key: '4:3', label: '4:3' },
  { key: '4:5', label: '4:5' },
  { key: '5:4', label: '5:4' },
  { key: '8:1', label: '8:1' },
  { key: '9:16', label: '9:16' },
  { key: '16:9', label: '16:9' },
  { key: '21:9', label: '21:9' }
] as const

const qualityOptions = computed(
  () =>
    [
      { key: 'auto', label: 'Auto', hint: t('aigcImagePanel.quality.hints.auto') },
      { key: 'low', label: 'Low', hint: t('aigcImagePanel.quality.hints.low') },
      { key: 'medium', label: 'Medium', hint: t('aigcImagePanel.quality.hints.medium') },
      { key: 'high', label: 'High', hint: t('aigcImagePanel.quality.hints.high') }
    ] as const satisfies readonly { key: ImageQuality; label: string; hint: string }[]
)

function getStoredModelSelection(): string {
  try {
    return localStorage.getItem(SELECTED_MODEL_STORAGE_KEY) || ''
  } catch {
    return ''
  }
}

const emit = defineEmits<{
  (e: 'generating', isGenerating: boolean): void
}>()

const { t } = useI18n()
const router = useRouter()
const imageStore = useImageStudioStore()
const vaultStore = useVaultStore()
const { isOptimizing, optimizePrompt } = usePromptOptimizer()
const storedModelSelection = getStoredModelSelection()
const initialSelectedModel = modelOptions.some((option) => option.model === storedModelSelection)
  ? storedModelSelection
  : GPT_IMAGE_MODEL

interface ReferenceLibraryAsset extends AssetData {
  filePath?: string
  originPath?: string
  fileExtension?: string
  modifiedTime?: string
}

const prompt = ref('')
const promptInputRef = ref<HTMLTextAreaElement | null>(null)
const fileInputRef = ref<HTMLInputElement | null>(null)
const referenceImages = ref<string[]>([])
const lockedReferenceImages = ref<string[]>([])
const selectedRatio = ref<ImageAspectRatio>('1:1')
const selectedResolution = ref<ImageResolution>(
  getImageModelOption(initialSelectedModel).defaultResolution
)
const generationCount = ref<number>(1)
const selectedStyle = ref(DEFAULT_STYLE)
const selectedModel = ref(initialSelectedModel)
const selectedQuality = ref<ImageQuality>(getImageModelOption(initialSelectedModel).defaultQuality)
const isGenerating = ref(false)
const generatedImages = ref<string[]>([])
const showAllRatios = ref(false)
const advancedOpen = ref(false)
const showCustomCount = ref(false)
const localModelOptions = ref<InfographicModelOption[]>([])
const selectedLocalModelId = ref('')
const localModelLoading = ref(false)
const referenceLibraryVisible = ref(false)
const referenceLibraryLoading = ref(false)
const referenceLibrarySubmitting = ref(false)
const referenceLibraryAssets = ref<ReferenceLibraryAsset[]>([])
const selectedReferenceLibraryKeys = ref<string[]>([])
const referenceLibraryVaultPath = ref('')
const referenceLibraryFolderName = ref(AIGC_REFERENCE_LIBRARY_FOLDER_NAME)
const selectedModelConfig = computed(() => getImageModelOption(selectedModel.value))
const selectedLocalModel = computed(() =>
  localModelOptions.value.find((option) => option.id === selectedLocalModelId.value)
)
const selectedProvider = computed(
  () => selectedLocalModel.value?.providerId ?? selectedModelConfig.value.provider
)
interface DisplayModelOption {
  id: string
  label: string
}
const displayModelOptions = computed<DisplayModelOption[]>(() =>
  localModelOptions.value.map((option) => ({ id: option.id, label: option.modelName }))
)
const selectedDisplayModelId = computed(() => selectedLocalModelId.value)
const supportsQuality = computed(() => selectedModelConfig.value.usesQuality)
const showsResolution = computed(() => selectedModelConfig.value.usesResolution)
const showsQuality = computed(() => selectedModelConfig.value.usesQuality)
const showsAspectRatio = computed(() => selectedModelConfig.value.ratios.length > 0)
const availableRatioOptions = computed(() => {
  const optionMap = new Map(ratioOptions.map((opt) => [opt.key, opt]))
  return selectedModelConfig.value.ratios
    .map((ratio) => optionMap.get(ratio))
    .filter((opt): opt is (typeof ratioOptions)[number] => Boolean(opt))
})
/**
 * 「尺寸」这一块：上面选形状，下面选大小。
 *
 * 档位只列这个比例下真的存在的 —— 列一个点了就会把比例改掉的尺寸，
 * 就是这次改版要修的那件事本身。详见 `imageSizeTiers.ts`。
 */
const sizeTierOptions = computed(() => getSizeTierOptions(selectedModel.value, selectedRatio.value))
const activeSizeTier = computed(() =>
  getActiveSizeTier(selectedModel.value, selectedResolution.value)
)
const selectedSizePixels = computed(() =>
  getResolutionPixels(selectedModel.value, selectedResolution.value)
)
/** 当前选择真正会出多大的图：有确定像素就直接报数，没有就说清这个档位是什么意思 */
const sizeSummary = computed(() =>
  selectedSizePixels.value
    ? selectedSizePixels.value.replace('x', ' × ')
    : t(SIZE_TIER_SUMMARY_KEYS[activeSizeTier.value])
)
/** 折叠起来的高级参数，标题右边挂当前值 —— 不展开也知道里面是什么 */
const qualitySummary = computed(
  () => qualityOptions.value.find((opt) => opt.key === selectedQuality.value)?.label ?? 'Auto'
)
const isCustomCount = computed(
  () => !(COUNT_PRESETS as readonly number[]).includes(generationCount.value)
)
const showCountSlider = computed(() => showCustomCount.value || isCustomCount.value)
const shouldCollapseRatioOptions = computed(() => availableRatioOptions.value.length > 5)
const collapsedRatioOptions = computed(() =>
  availableRatioOptions.value.filter(
    (opt) =>
      COMMON_RATIO_KEYS.includes(opt.key as (typeof COMMON_RATIO_KEYS)[number]) ||
      opt.key === selectedRatio.value
  )
)

const visibleRatioOptions = computed(() =>
  !shouldCollapseRatioOptions.value || showAllRatios.value
    ? availableRatioOptions.value
    : collapsedRatioOptions.value
)

const hasHiddenRatios = computed(
  () =>
    shouldCollapseRatioOptions.value &&
    availableRatioOptions.value.length > collapsedRatioOptions.value.length
)

const requestedImageCount = computed(() => generationCount.value)

// 面板在父页面异步检查完成后才挂载，可能错过首次 activated，必须同时处理 mounted。
async function refreshLocalModels(): Promise<void> {
  if (localModelLoading.value) return
  localModelLoading.value = true
  try {
    const settings = await aiProviderAPI.getSettings()
    const options = buildInfographicModelOptions(settings)
    localModelOptions.value = options
    const bound = options.find(
      (option) =>
        option.providerId === settings.roles.image?.providerId &&
        option.modelId === settings.roles.image?.modelId
    )
    const current = options.find((option) => option.id === selectedLocalModelId.value)
    const savedSelection = getStoredModelSelection()
    const stored = options.find((option) => option.id === savedSelection)
    const legacy = options.find((option) => option.modelId === savedSelection)
    selectedLocalModelId.value = (current ?? stored ?? legacy ?? bound ?? options[0])?.id ?? ''
    const selected = selectedLocalModel.value
    if (selected) selectedModel.value = selected.modelId
  } catch (error) {
    console.error('[ImagePanel] 加载生图模型失败:', error)
  } finally {
    localModelLoading.value = false
  }
}

onMounted(refreshLocalModels)
onActivated(refreshLocalModels)

watch(selectedLocalModelId, (id) => {
  // 空列表或读取失败不抹掉上次选择；下次加载后再验证是否仍可用。
  if (!id) return
  try {
    localStorage.setItem(SELECTED_MODEL_STORAGE_KEY, id)
  } catch {
    // Storage may be unavailable; selection still works for this session.
  }
})

const canGenerate = computed(
  () => !isGenerating.value && (prompt.value.trim().length > 0 || referenceImages.value.length > 0)
)
const isImageToImage = computed(() => referenceImages.value.length > 0)
const remainingReferenceSlots = computed(() =>
  Math.max(0, MAX_REFERENCE_IMAGES - referenceImages.value.length)
)

function getLockedReferenceImageSet(): Set<string> {
  return new Set(lockedReferenceImages.value)
}

function sanitizeLockedReferenceImages(images: string[] = referenceImages.value): void {
  const existing = new Set(images)
  lockedReferenceImages.value = lockedReferenceImages.value.filter((image) => existing.has(image))
}

function mergeReferenceImagesPreservingLocked(nextImages: string[]): string[] {
  const currentLockedImages = referenceImages.value.filter((image) =>
    getLockedReferenceImageSet().has(image)
  )
  const merged: string[] = [...currentLockedImages]

  for (const image of nextImages) {
    if (merged.includes(image)) continue
    if (merged.length >= MAX_REFERENCE_IMAGES) break
    merged.push(image)
  }

  return merged.slice(0, MAX_REFERENCE_IMAGES)
}

function setReferenceImages(nextImages: string[]): void {
  referenceImages.value = mergeReferenceImagesPreservingLocked(nextImages)
  sanitizeLockedReferenceImages()
}

function isReferenceImageLocked(image: string): boolean {
  return getLockedReferenceImageSet().has(image)
}

function toggleReferenceImageLock(image: string): void {
  if (isReferenceImageLocked(image)) {
    lockedReferenceImages.value = lockedReferenceImages.value.filter((item) => item !== image)
    return
  }

  lockedReferenceImages.value = [...lockedReferenceImages.value, image]
}

function normalizeImageMimeType(extension?: string): string {
  const ext = String(extension || '')
    .trim()
    .toLowerCase()
    .replace(/^\./, '')

  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'svg':
      return 'image/svg+xml'
    case 'tga':
      return 'image/x-tga'
    default:
      return ext ? `image/${ext}` : 'image/png'
  }
}

function resolveReferenceLibraryAssetPath(asset: ReferenceLibraryAsset): string | undefined {
  const directPath = String(asset.originPath || asset.filePath || '').trim()
  if (!directPath) return undefined

  if (
    /^[a-zA-Z]:[\\/]/.test(directPath) ||
    directPath.startsWith('/') ||
    directPath.startsWith('\\\\')
  ) {
    return directPath
  }

  const basePath = String(referenceLibraryVaultPath.value || '').replace(/[\\/]+$/, '')
  if (!basePath) return directPath

  return `${basePath}/${directPath.replace(/^[\\/]+/, '')}`.replace(/\//g, '\\')
}

function getReferenceLibraryPreviewSrc(asset: ReferenceLibraryAsset): string | undefined {
  const previewPath = resolveReferenceLibraryAssetPath(asset)
  return toLocalResourceUrl(previewPath)
}

function isReferenceLibrarySelected(assetKey: string): boolean {
  return selectedReferenceLibraryKeys.value.includes(assetKey)
}

function toggleReferenceLibrarySelection(assetKey: string) {
  if (isReferenceLibrarySelected(assetKey)) {
    selectedReferenceLibraryKeys.value = selectedReferenceLibraryKeys.value.filter(
      (key) => key !== assetKey
    )
    return
  }

  if (selectedReferenceLibraryKeys.value.length >= remainingReferenceSlots.value) {
    message.warning(
      t('aigcImagePanel.toast.remainingReferences', { count: remainingReferenceSlots.value })
    )
    return
  }

  selectedReferenceLibraryKeys.value = [...selectedReferenceLibraryKeys.value, assetKey]
}

function formatReferenceLibraryDate(value?: string): string {
  if (!value) return ''
  return value.replace('T', ' ').slice(0, 16)
}

async function loadReferenceLibraryAssets(): Promise<void> {
  referenceLibraryLoading.value = true

  try {
    const result = await window.api.invoke('aigc:getReferenceLibraryAssets')
    if (!result?.success) {
      throw new Error(result?.error || '读取参考素材失败')
    }

    referenceLibraryAssets.value = Array.isArray(result.data?.assets) ? result.data.assets : []
    referenceLibraryVaultPath.value = String(result.data?.vaultPath || '')
    referenceLibraryFolderName.value = String(
      result.data?.folderName || AIGC_REFERENCE_LIBRARY_FOLDER_NAME
    )
    selectedReferenceLibraryKeys.value = []
  } catch (error) {
    console.error('[ImagePanel] 加载参考库失败:', error)
    message.error(error instanceof Error ? error.message : '加载参考库失败')
  } finally {
    referenceLibraryLoading.value = false
  }
}

async function openReferenceLibrary(): Promise<void> {
  if (remainingReferenceSlots.value <= 0) {
    message.warning(t('aigcImagePanel.reference.maxReached', { max: MAX_REFERENCE_IMAGES }))
    return
  }

  referenceLibraryVisible.value = true
  await loadReferenceLibraryAssets()
}

async function handleOpenReferenceLibraryFolder(): Promise<void> {
  try {
    const opened = await openReferenceLibraryFolder(vaultStore, router)
    if (!opened) {
      message.error(t('aigcImagePanel.reference.vaultNotFound'))
      return
    }

    referenceLibraryVisible.value = false
  } catch (error) {
    console.error('[ImagePanel] 打开参考素材库失败:', error)
    message.error(
      error instanceof Error ? error.message : t('aigcImagePanel.reference.openFolderFailed')
    )
  }
}

async function addSelectedReferenceLibraryAssets(): Promise<void> {
  if (selectedReferenceLibraryKeys.value.length === 0) {
    message.warning(t('aigcImagePanel.toast.selectReferences'))
    return
  }

  referenceLibrarySubmitting.value = true

  try {
    const assetMap = new Map(referenceLibraryAssets.value.map((asset) => [asset.assetKey, asset]))
    const nextImages = [...referenceImages.value]
    let addedCount = 0
    let duplicateCount = 0
    let failedCount = 0

    for (const assetKey of selectedReferenceLibraryKeys.value) {
      if (nextImages.length >= MAX_REFERENCE_IMAGES) break

      const asset = assetMap.get(assetKey)
      if (!asset) {
        failedCount += 1
        continue
      }

      const localPath = resolveReferenceLibraryAssetPath(asset)
      if (!localPath) {
        failedCount += 1
        continue
      }

      try {
        const base64Result = await window.api.asset.readFileAsBase64(localPath)
        if (!base64Result?.success || !base64Result.data) {
          failedCount += 1
          continue
        }

        const mimeType = normalizeImageMimeType(asset.fileExtension)
        const dataUrl = `data:${mimeType};base64,${base64Result.data}`

        if (nextImages.includes(dataUrl)) {
          duplicateCount += 1
          continue
        }

        nextImages.push(dataUrl)
        addedCount += 1
      } catch (error) {
        console.error('[ImagePanel] 读取参考素材失败:', error)
        failedCount += 1
      }
    }

    referenceImages.value = nextImages

    if (addedCount > 0) {
      message.success(
        `已从参考库加入 ${addedCount} 张参考图${duplicateCount > 0 ? `，${duplicateCount} 张已存在` : ''}${failedCount > 0 ? `，${failedCount} 张读取失败` : ''}`
      )
      referenceLibraryVisible.value = false
      selectedReferenceLibraryKeys.value = []
      return
    }

    if (duplicateCount > 0 || failedCount > 0) {
      message.warning(
        `${duplicateCount > 0 ? `${duplicateCount} 张已存在` : '未添加新图片'}${failedCount > 0 ? `，${failedCount} 张读取失败` : ''}`
      )
      return
    }

    message.warning(t('aigcImagePanel.reference.noneAdded'))
  } finally {
    referenceLibrarySubmitting.value = false
  }
}

function syncResolutionForModel(): void {
  selectedResolution.value = normalizeImageResolutionForModel(
    selectedModel.value,
    selectedResolution.value
  )
}

function syncGptRatioFromResolution(): void {
  if (selectedModel.value !== GPT_IMAGE_MODEL) return
  // Auto 里没有比例这个信息。照着它反推会把用户刚选的 16:9 改回 1:1，
  // 而主进程在拿不到像素尺寸时正是靠这个比例出图（见 imageGeneration.ts 的 asSize）——
  // 于是「16:9 + Auto」会安安静静地画出一张方图。
  if (getResolutionPixels(selectedModel.value, selectedResolution.value) === null) return
  selectedRatio.value = getGptImageRatioForSize(selectedResolution.value)
}

function handleRatioSelect(ratio: ImageAspectRatio): void {
  selectedRatio.value = ratio
  selectedResolution.value = resolveResolutionForRatio(
    selectedModel.value,
    ratio,
    selectedResolution.value
  )
}

function handleSizeTierSelect(tier: ImageSizeTier): void {
  selectedResolution.value = resolveResolutionForTier(
    selectedModel.value,
    selectedRatio.value,
    tier,
    selectedResolution.value
  )
}

function handleCountPreset(count: number): void {
  generationCount.value = count
  showCustomCount.value = false
}

/** 本地生图模型是在偏好设置里绑的 —— 与其把那条路径写成一行灰字，不如让它能点 */
function openModelSettings(): void {
  router.push('/preferences?tab=models')
}

watch(selectedModel, () => {
  const option = selectedModelConfig.value
  selectedRatio.value = normalizeImageRatioForModel(option.model, selectedRatio.value)
  selectedQuality.value = normalizeImageQuality(selectedQuality.value)
  syncResolutionForModel()
  syncGptRatioFromResolution()
  showAllRatios.value = false
})

watch(selectedResolution, () => {
  syncResolutionForModel()
  syncGptRatioFromResolution()
})

function handleLocalModelSelect(option: InfographicModelOption): void {
  selectedLocalModelId.value = option.id
  selectedModel.value = option.modelId
}

function handleDisplayModelSelect(optionId: string): void {
  const option = localModelOptions.value.find((item) => item.id === optionId)
  if (option) handleLocalModelSelect(option)
}

async function handleOptimize(): Promise<void> {
  const result = await optimizePrompt('image', prompt.value, {
    referenceImages: referenceImages.value.map((url, index) => ({
      url,
      label: `参考图 ${index + 1}`
    }))
  })
  if (result) {
    setValueWithUndo(promptInputRef, prompt, result)
  }
}

async function ensurePromptForGeneration(): Promise<string | null> {
  const existingPrompt = prompt.value.trim()
  if (existingPrompt) return existingPrompt
  if (referenceImages.value.length === 0) return null

  const inferredPrompt = await optimizePrompt('image', '', {
    referenceImages: referenceImages.value.map((url, index) => ({
      url,
      label: `参考图 ${index + 1}`
    }))
  })

  if (!inferredPrompt) return null

  setValueWithUndo(promptInputRef, prompt, inferredPrompt)
  return inferredPrompt
}

function setGeneratingState(nextValue: boolean): void {
  if (isGenerating.value === nextValue) return
  isGenerating.value = nextValue
  emit('generating', nextValue)
}

function resetGeneratingState(): void {
  setGeneratingState(false)
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs)
    })
  ])
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

interface ImageSubmissionSnapshot {
  prompt: string
  referenceImages?: string[]
  provider: string
  model: string
  quality?: ImageQuality
  ratio: ImageAspectRatio
  resolution: ImageResolution
  style: string
  count: number
}

async function submitImageGenerationTask(
  snapshot: ImageSubmissionSnapshot
): Promise<{ success: boolean; taskId: string; error?: string }> {
  const task = imageStore.createTask({
    prompt: snapshot.prompt,
    referenceImages: snapshot.referenceImages,
    ratio: snapshot.ratio,
    resolution: snapshot.resolution,
    provider: snapshot.provider,
    model: snapshot.model,
    quality: snapshot.quality,
    style: snapshot.style,
    count: snapshot.count
  })

  imageStore.setPreviewTask(task.id)

  try {
    const result = await withTimeout(
      window.electron.ipcRenderer.invoke('image:startGeneration', {
        taskId: task.id,
        prompt: snapshot.prompt,
        referenceImages: snapshot.referenceImages,
        ratio: snapshot.ratio,
        resolution: snapshot.resolution,
        provider: snapshot.provider,
        model: snapshot.model,
        quality: snapshot.quality,
        style: snapshot.style,
        count: snapshot.count
      }),
      GENERATION_START_TIMEOUT_MS,
      '图片任务启动超时，请重试。'
    )

    if (!result.success) {
      const errorMessage = result.error || '生成失败'
      imageStore.updateTaskStatus(task.id, 'failed', { error: errorMessage })
      return { success: false, taskId: task.id, error: errorMessage }
    }

    return { success: true, taskId: task.id }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : '生成失败'
    imageStore.updateTaskStatus(task.id, 'failed', { error: errorMessage })
    return { success: false, taskId: task.id, error: errorMessage }
  }
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

async function appendReferenceImages(files: File[] | FileList): Promise<number> {
  let addedCount = 0

  for (const file of Array.from(files)) {
    if (!file.type.startsWith('image/')) continue
    if (referenceImages.value.length >= MAX_REFERENCE_IMAGES) break
    const base64 = await fileToBase64(file)
    referenceImages.value.push(base64)
    addedCount += 1
  }

  return addedCount
}

async function handleFileSelect(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files || [])
  await appendReferenceImages(files)

  input.value = ''
}

function removeImage(index: number) {
  const image = referenceImages.value[index]
  referenceImages.value.splice(index, 1)
  lockedReferenceImages.value = lockedReferenceImages.value.filter((item) => item !== image)
}

async function handlePromptPaste(event: ClipboardEvent) {
  const clipboardItems = Array.from(event.clipboardData?.items || [])
  const imageItems = clipboardItems.filter((item) => item.type.startsWith('image/'))

  if (imageItems.length === 0) return

  event.preventDefault()

  let addedCount = 0

  for (const item of imageItems) {
    if (referenceImages.value.length >= MAX_REFERENCE_IMAGES) break

    const file = item.getAsFile()
    if (!file) continue

    const base64 = await fileToBase64(file)
    referenceImages.value.push(base64)
    addedCount += 1
  }

  if (addedCount > 0) {
    message.success(t('aigcImagePanel.toast.pastedReferences', { count: addedCount }))
    nextTick(() => {
      promptInputRef.value?.focus()
    })
    return
  }

  if (referenceImages.value.length >= MAX_REFERENCE_IMAGES) {
    message.warning(t('aigcImagePanel.reference.maxReached', { max: MAX_REFERENCE_IMAGES }))
  }
}

async function handleGenerate() {
  if (!canGenerate.value) return

  setGeneratingState(true)

  try {
    const effectivePrompt = await ensurePromptForGeneration()
    if (!effectivePrompt) {
      message.warning(t('aigcImagePanel.toast.promptOrReferenceRequired'))
      return
    }

    const referenceImagesSnapshot =
      referenceImages.value.length > 0 ? [...referenceImages.value] : undefined
    const modelSnapshot = selectedModel.value
    const providerSnapshot = selectedProvider.value
    const resolutionSnapshot = normalizeImageResolutionForModel(
      modelSnapshot,
      selectedResolution.value
    )
    const ratioSnapshot = normalizeImageRatioForModel(modelSnapshot, selectedRatio.value)
    const styleSnapshot = selectedStyle.value
    const qualitySnapshot = supportsQuality.value ? selectedQuality.value : undefined

    // 社区版这一步查的是本地生图模型而不是登录状态，措辞得跟着改
    if (!selectedLocalModel.value) {
      message.error(t('aigcImagePanel.access.noImageModel'))
      return
    }
    const submitCount = generationCount.value
    const snapshot: ImageSubmissionSnapshot = {
      prompt: effectivePrompt,
      referenceImages: referenceImagesSnapshot,
      provider: providerSnapshot,
      model: modelSnapshot,
      quality: qualitySnapshot,
      ratio: ratioSnapshot,
      resolution: resolutionSnapshot,
      style: styleSnapshot,
      count: 1
    }

    let successCount = 0
    let failureCount = 0
    let lastErrorMessage = ''

    for (let index = 0; index < submitCount; index += 1) {
      if (index > 0) {
        await sleep(BATCH_SUBMIT_INTERVAL_MS)
      }

      const submitResult = await submitImageGenerationTask(snapshot)
      if (submitResult.success) {
        successCount += 1
      } else {
        failureCount += 1
        lastErrorMessage = submitResult.error || lastErrorMessage
      }
    }

    if (failureCount === 0) {
      const successMessage =
        successCount === 1
          ? t('aigcImagePanel.toast.taskSubmitted')
          : t('aigcImagePanel.toast.taskBatchSubmitted', { count: successCount })
      message.info(successMessage)
      return
    }

    if (successCount > 0) {
      message.warning(
        t('aigcImagePanel.toast.taskBatchPartial', {
          success: successCount,
          failed: failureCount
        }) + (lastErrorMessage ? `：${lastErrorMessage}` : '')
      )
      return
    }

    message.error(lastErrorMessage || '生成失败')
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : '生成失败'
    message.error(errorMessage)
  } finally {
    resetGeneratingState()
  }
}

function handleSetReferenceImage(imagePaths: string[]) {
  setReferenceImages(imagePaths.slice(0, MAX_REFERENCE_IMAGES))
  nextTick(() => {
    promptInputRef.value?.focus()
  })
}

function handleSetPrompt(newPrompt: string) {
  setValueWithUndo(promptInputRef, prompt, newPrompt)
  nextTick(() => {
    promptInputRef.value?.focus()
  })
}

/**
 * 把一整套生成参数填回面板。
 *
 * 由父组件通过 ref 调用，不走事件总线 —— 总线会打到每一个标签页的 ImagePanel 上，
 * 而用户点的「填回参数」只该作用在**这一页**。
 */
function fillForm(payload: {
  prompt?: string
  referenceImages?: string[]
  model?: string
  quality?: string
  ratio?: ImageAspectRatio
  resolution?: ImageResolution
  count?: number
  style?: string
}): void {
  setValueWithUndo(promptInputRef, prompt, payload.prompt ?? '')
  setReferenceImages((payload.referenceImages || []).slice(0, MAX_REFERENCE_IMAGES))
  if (payload.model && modelOptions.some((item) => item.model === payload.model)) {
    selectedModel.value = payload.model
  }
  selectedQuality.value = normalizeImageQuality(payload.quality)

  if (payload.ratio && ratioOptions.some((item) => item.key === payload.ratio)) {
    selectedRatio.value = normalizeImageRatioForModel(selectedModel.value, payload.ratio)
  }
  if (payload.resolution) {
    selectedResolution.value = normalizeImageResolutionForModel(
      selectedModel.value,
      payload.resolution
    )
    syncGptRatioFromResolution()
  }
  if (typeof payload.count === 'number') {
    generationCount.value = Math.min(
      MAX_GENERATION_COUNT,
      Math.max(MIN_GENERATION_COUNT, Math.round(payload.count))
    )
  }
  if (payload.style) {
    selectedStyle.value = payload.style
  }

  nextTick(() => {
    promptInputRef.value?.focus()
  })
}

onMounted(() => {
  aigcEventBus.on(AIGC_EVENTS.SET_REFERENCE_IMAGE, handleSetReferenceImage)
  aigcEventBus.on(AIGC_EVENTS.SET_PROMPT, handleSetPrompt)
})

onUnmounted(() => {
  resetGeneratingState()
  aigcEventBus.off(AIGC_EVENTS.SET_REFERENCE_IMAGE, handleSetReferenceImage)
  aigcEventBus.off(AIGC_EVENTS.SET_PROMPT, handleSetPrompt)
})

defineExpose({
  prompt,
  referenceImages,
  setReferenceImages,
  selectedRatio,
  selectedResolution,
  generationCount,
  selectedModel,
  selectedQuality,
  selectedStyle,
  generatedImages,
  isGenerating,
  promptInputRef,
  appendReferenceImages,
  fillForm
})
</script>

<template>
  <div class="image-panel">
    <!--
      模型不是每次生成都要动的东西，占不到一整块。缩成标题栏右边一个 chip，
      把面板最上面那块地让给真正要写的东西 —— 提示词。
    -->
    <div class="panel-header">
      <span class="panel-header-label">{{ $t('aigcImagePanel.model.label') }}</span>
      <a-select
        class="model-select"
        :value="selectedDisplayModelId"
        :loading="localModelLoading"
        :disabled="localModelOptions.length === 0"
        @change="handleDisplayModelSelect"
      >
        <a-select-option v-for="option in displayModelOptions" :key="option.id" :value="option.id">
          {{ option.label }}
        </a-select-option>
      </a-select>
      <button
        v-if="!localModelLoading && localModelOptions.length === 0"
        class="model-settings-button"
        type="button"
        @click="openModelSettings"
      >
        <PhGear aria-hidden="true" />
        {{ $t('aigcImagePanel.gate.action') }}
      </button>
    </div>

    <div class="section">
      <label class="section-label">
        {{
          isImageToImage
            ? $t('aigcImagePanel.prompt.editLabel')
            : $t('aigcImagePanel.prompt.describeLabel')
        }}
        <span class="hint">{{ $t('aigcImagePanel.prompt.hint') }}</span>
      </label>
      <div class="prompt-container">
        <textarea
          ref="promptInputRef"
          v-model="prompt"
          class="prompt-input"
          :placeholder="
            isImageToImage
              ? $t('aigcImagePanel.prompt.placeholderEdit')
              : $t('aigcImagePanel.prompt.placeholderDescribe')
          "
          rows="8"
          @paste="handlePromptPaste"
        />
        <div class="prompt-footer">
          <span class="char-count">{{ prompt.length }}/1000</span>
          <button
            class="optimize-icon-btn"
            :title="$t('aigcImagePanel.prompt.optimizeTitle')"
            :disabled="isOptimizing || (!prompt.trim() && referenceImages.length === 0)"
            @click="handleOptimize"
          >
            <PhCircleNotch v-if="isOptimizing" class="icon-spin" />
            <PhSparkle v-else />
          </button>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-title-row">
        <label class="section-label">
          {{ $t('aigcImagePanel.reference.label') }}
          <span v-if="referenceImages.length > 0" class="image-count">
            {{ referenceImages.length }}/{{ MAX_REFERENCE_IMAGES }}
          </span>
        </label>
        <button
          class="library-btn"
          :disabled="remainingReferenceSlots === 0"
          @click="openReferenceLibrary"
        >
          {{ $t('aigcImagePanel.reference.libraryButton') }}
        </button>
      </div>
      <div class="reference-images-grid">
        <div v-for="(img, index) in referenceImages" :key="index" class="reference-item">
          <button
            class="lock-btn"
            :class="{ active: isReferenceImageLocked(img) }"
            @click.stop="toggleReferenceImageLock(img)"
          >
            <PhLock />
          </button>
          <img :src="img" alt="reference" class="reference-img" />
          <button class="remove-btn" @click.stop="removeImage(index)">
            <PhX />
          </button>
        </div>
        <div
          v-if="referenceImages.length < MAX_REFERENCE_IMAGES"
          class="add-reference-btn"
          @click="fileInputRef?.click()"
        >
          <PhPlus class="add-icon" />
        </div>
      </div>
      <input
        ref="fileInputRef"
        type="file"
        accept="image/*"
        multiple
        style="display: none"
        @change="handleFileSelect"
      />

      <AppModal
        v-model:open="referenceLibraryVisible"
        :title="
          $t('aigcImagePanel.reference.libraryTitle', { folderName: referenceLibraryFolderName })
        "
        hide-footer
        width="760px"
      >
        <div class="reference-library-toolbar">
          <div class="reference-library-tip">
            {{
              $t('aigcImagePanel.reference.libraryTip', {
                folderName: referenceLibraryFolderName,
                slots: remainingReferenceSlots
              })
            }}
          </div>
          <button
            class="reference-library-refresh"
            :disabled="referenceLibraryLoading"
            @click="loadReferenceLibraryAssets"
          >
            {{ $t('aigcImagePanel.reference.refresh') }}
          </button>
        </div>

        <AppSpin :spinning="referenceLibraryLoading || referenceLibrarySubmitting">
          <div v-if="referenceLibraryAssets.length > 0" class="reference-library-grid">
            <button
              v-for="asset in referenceLibraryAssets"
              :key="asset.assetKey"
              class="reference-library-card"
              :class="{ active: isReferenceLibrarySelected(asset.assetKey) }"
              @click="toggleReferenceLibrarySelection(asset.assetKey)"
            >
              <img
                v-if="getReferenceLibraryPreviewSrc(asset)"
                :src="getReferenceLibraryPreviewSrc(asset)"
                :alt="asset.assetName"
                class="reference-library-image"
              />
              <div v-else class="reference-library-placeholder">
                {{ $t('aigcImagePanel.reference.noPreview') }}
              </div>
              <div class="reference-library-meta">
                <div class="reference-library-name" :title="asset.assetName">
                  {{ asset.assetName }}
                </div>
                <div class="reference-library-date">
                  {{ formatReferenceLibraryDate(asset.updated_at || asset.modifiedTime) }}
                </div>
              </div>
            </button>
          </div>

          <div v-else class="reference-library-empty">
            <div class="reference-library-empty-title">
              {{ $t('aigcImagePanel.reference.emptyTitle') }}
            </div>
            <div class="reference-library-empty-desc">
              {{
                $t('aigcImagePanel.reference.emptyDesc', {
                  folderName: referenceLibraryFolderName
                })
              }}
            </div>
            <button
              class="reference-library-primary reference-library-empty-action"
              type="button"
              @click="handleOpenReferenceLibraryFolder"
            >
              <PhFolderOpen aria-hidden="true" />
              {{ $t('aigcImagePanel.reference.openFolder') }}
            </button>
          </div>
        </AppSpin>

        <div class="reference-library-footer">
          <span class="reference-library-selection">
            {{
              $t('aigcImagePanel.reference.selectedCount', {
                count: selectedReferenceLibraryKeys.length
              })
            }}
          </span>
          <div class="reference-library-actions">
            <button class="reference-library-secondary" @click="referenceLibraryVisible = false">
              {{ $t('aigcImagePanel.reference.cancel') }}
            </button>
            <button
              class="reference-library-primary"
              :disabled="selectedReferenceLibraryKeys.length === 0 || referenceLibrarySubmitting"
              @click="addSelectedReferenceLibraryAssets"
            >
              {{ $t('aigcImagePanel.reference.addButton') }}
            </button>
          </div>
        </div>
      </AppModal>
    </div>

    <!--
      「宽高比」和「分辨率」原本是两个控件，说的却是同一件事：1536x1024 就是 3:2。
      合成一块之后，上面选形状、下面选大小，最后一行灰字如实报出真正会出多大的图。
    -->
    <div v-if="showsAspectRatio" class="section">
      <div class="section-title-row">
        <label class="section-label">{{ $t('aigcImagePanel.size.label') }}</label>
        <button
          v-if="hasHiddenRatios"
          class="toggle-more-btn"
          @click="showAllRatios = !showAllRatios"
        >
          {{
            showAllRatios ? $t('aigcImagePanel.ratio.collapse') : $t('aigcImagePanel.ratio.more')
          }}
        </button>
      </div>
      <div class="ratio-options">
        <button
          v-for="opt in visibleRatioOptions"
          :key="opt.key"
          class="ratio-btn"
          :class="{ active: selectedRatio === opt.key }"
          @click="handleRatioSelect(opt.key)"
        >
          <span class="ratio-icon-wrapper">
            <span class="ratio-icon" :class="'ratio-' + opt.key.replace(':', '-')"></span>
          </span>
          <span class="ratio-label">{{ opt.label }}</span>
        </button>
      </div>

      <div v-if="showsResolution && sizeTierOptions.length > 0" class="size-tier-row">
        <button
          v-for="opt in sizeTierOptions"
          :key="opt.tier"
          class="size-tier-btn"
          :class="{ active: activeSizeTier === opt.tier }"
          type="button"
          @click="handleSizeTierSelect(opt.tier)"
        >
          {{ opt.tier === 'auto' ? 'Auto' : opt.tier }}
        </button>
      </div>
      <div v-if="showsResolution" class="size-summary">{{ sizeSummary }}</div>
    </div>

    <div class="section">
      <label class="section-label">{{ $t('aigcImagePanel.batch.countLabel') }}</label>
      <!-- 1–10 的离散小范围拿滑块拖最难点准，常用的四个直接给出来 -->
      <div class="count-options">
        <button
          v-for="count in COUNT_PRESETS"
          :key="count"
          class="count-btn"
          :class="{ active: !showCountSlider && generationCount === count }"
          type="button"
          @click="handleCountPreset(count)"
        >
          {{ count }}
        </button>
        <button
          class="count-btn count-custom"
          :class="{ active: showCountSlider }"
          type="button"
          @click="showCustomCount = !showCustomCount"
        >
          {{ $t('aigcImagePanel.batch.custom') }}
        </button>
      </div>
      <div v-if="showCountSlider" class="batch-slider-card">
        <div class="batch-slider-row">
          <span class="batch-slider-bound">{{ MIN_GENERATION_COUNT }}</span>
          <input
            v-model.number="generationCount"
            class="batch-count-slider"
            type="range"
            :min="MIN_GENERATION_COUNT"
            :max="MAX_GENERATION_COUNT"
            :step="1"
          />
          <span class="batch-slider-bound">{{ MAX_GENERATION_COUNT }}</span>
        </div>
        <span class="batch-count-value">
          {{ $t('aigcImagePanel.batch.countValue', { count: generationCount }) }}
        </span>
      </div>
    </div>

    <!-- 质量不是每次都要改的东西，收起来；标题右边挂着当前值，不展开也知道是什么 -->
    <div v-if="showsQuality" class="section advanced-section">
      <button class="advanced-toggle" type="button" @click="advancedOpen = !advancedOpen">
        <PhCaretDown class="advanced-arrow" :class="{ open: advancedOpen }" />
        <span class="advanced-title">{{ $t('aigcImagePanel.advanced.label') }}</span>
        <span class="advanced-summary">
          {{ $t('aigcImagePanel.quality.label') }} {{ qualitySummary }}
        </span>
      </button>
      <div v-if="advancedOpen" class="advanced-body">
        <label class="section-label">
          {{ $t('aigcImagePanel.quality.label') }}
          <span class="hint">{{ $t('aigcImagePanel.quality.hint') }}</span>
        </label>
        <div class="resolution-options">
          <button
            v-for="opt in qualityOptions"
            :key="opt.key"
            class="resolution-btn"
            :class="{ active: selectedQuality === opt.key }"
            @click="selectedQuality = opt.key"
          >
            <span class="resolution-title">{{ opt.label }}</span>
            <span class="resolution-hint">{{ opt.hint }}</span>
          </button>
        </div>
      </div>
    </div>

    <!--
      参数一多，生成按钮就被挤到折叠线以下了 —— 而它是这一屏唯一的出口。
      钉在底部，并且把「这一下会出几张」直接写在按钮上。
    -->
    <div class="generate-footer">
      <button class="generate-btn" :disabled="!canGenerate" @click="handleGenerate">
        <PhCircleNotch v-if="isGenerating" class="loading-icon" />
        <span class="generate-label">{{
          isGenerating
            ? t('aigcImagePanel.prompt.generating')
            : t('aigcImagePanel.batch.generateCount', { count: requestedImageCount })
        }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
/*
 * 撑满左栏的高度。内容不够高时面板就只有内容那么高，
 * 底部的 margin-top: auto 和 sticky 都会失效 —— 按钮于是停在半空。
 */
.image-panel {
  min-height: 100%;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.section-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.section-label {
  font-size: 12px;
  color: var(--color-text-primary);
  display: flex;
  align-items: center;
  gap: 8px;
}

.section-label .hint {
  color: var(--color-text-muted);
  font-size: 12px;
  padding-top: 3px;
}

.toggle-more-btn {
  border: none;
  background: transparent;
  color: var(--color-accent-text);
  font-size: 12px;
  cursor: pointer;
  padding: 0;
  white-space: nowrap;
}

.toggle-more-btn:hover {
  color: var(--color-accent-text);
}

.library-btn {
  border: 1px solid var(--color-border);
  background: var(--color-bg-surface-hover);
  color: var(--color-text-primary);
  border-radius: 8px;
  padding: 4px 12px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.library-btn:hover:not(:disabled) {
  border-color: var(--color-accent-border);
  color: var(--color-accent-text);
}

.library-btn:disabled {
  color: var(--color-text-disabled);
  cursor: not-allowed;
}

.prompt-container {
  background: var(--color-bg-surface);
  border: 1px solid var(--color-border-subtle);
  border-radius: 8px;
  overflow: hidden;
}

.prompt-container:focus-within {
  border-color: var(--color-accent-border);
}

/*
 * 面板里最重要的输入框曾经只有 100px 高，而用户真正写进来的提示词
 * 动辄两百字 —— 尺寸得配得上它的分量，剩下的交给用户自己拖。
 */
.prompt-input {
  width: 100%;
  min-height: 200px;
  max-height: 420px;
  background: transparent;
  border: none;
  padding: 12px;
  color: var(--color-text-primary);
  font-size: 14px;
  resize: vertical;
  overflow-y: auto;
}

.prompt-input:focus {
  outline: none;
}

.prompt-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1px 12px;
  border-top: 1px solid var(--color-border-subtle);
}

.char-count {
  font-size: 12px;
  color: var(--color-text-muted);
}

.optimize-icon-btn {
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  border-radius: 4px;
  color: var(--color-accent-text);
  font-size: 14px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s;
}

.optimize-icon-btn:hover {
  background: var(--color-accent-bg);
}

.reference-images-grid {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.reference-item {
  position: relative;
  width: 80px;
  height: 80px;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid var(--color-border-subtle);
}

.reference-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.add-reference-btn {
  width: 80px;
  height: 80px;
  border: 2px dashed var(--color-border);
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.2s ease;
}

.add-reference-btn:hover {
  border-color: var(--color-accent-border);
}

.add-icon {
  font-size: 20px;
  color: var(--color-text-primary);
}

.remove-btn,
.lock-btn {
  position: absolute;
  top: 4px;
  width: 20px;
  height: 20px;
  border: none;
  background: var(--color-bg-overlay);
  color: var(--color-text-on-solid);
  border-radius: 50%;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}

.remove-btn {
  right: 4px;
}

.remove-btn:hover {
  background: var(--color-danger-solid);
}

.lock-btn {
  left: 4px;
  z-index: 1;
}

.lock-btn.active {
  color: var(--color-text-selected);
  box-shadow: inset 0 0 0 1px var(--color-accent-border);
}

.lock-btn:hover {
  background: var(--color-bg-overlay);
}

.reference-library-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
}

.reference-library-tip {
  color: var(--color-text-primary);
  font-size: 13px;
  line-height: 1.5;
}

.reference-library-refresh,
.reference-library-secondary,
.reference-library-primary {
  border-radius: 8px;
  padding: 8px 14px;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.reference-library-refresh,
.reference-library-secondary {
  border: 1px solid var(--color-border);
  background: var(--color-bg-surface-hover);
  color: var(--color-text-primary);
}

.reference-library-refresh:hover:not(:disabled),
.reference-library-secondary:hover:not(:disabled) {
  border-color: var(--color-border);
}

.reference-library-primary {
  border: none;
  background: var(--color-accent-solid);
  color: var(--color-text-on-solid);
}

.reference-library-primary:hover:not(:disabled) {
  background: var(--color-accent-solid-hover);
}

.reference-library-refresh:disabled,
.reference-library-secondary:disabled,
.reference-library-primary:disabled {
  color: var(--color-text-disabled);
  cursor: not-allowed;
}

.reference-library-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
  gap: 12px;
  margin-bottom: 16px;
  max-height: 420px;
  overflow-y: auto;
}

.reference-library-card {
  border: 1px solid var(--color-border-subtle);
  background: var(--color-bg-surface-hover);
  border-radius: 12px;
  padding: 8px;
  text-align: left;
  cursor: pointer;
  transition: all 0.2s ease;
}

.reference-library-card:hover {
  border-color: var(--color-border);
  transform: translateY(-1px);
}

.reference-library-card.active {
  background: var(--color-bg-selected);
  box-shadow: 0 0 0 1px var(--color-accent-border) inset;
}

.reference-library-image,
.reference-library-placeholder {
  width: 100%;
  aspect-ratio: 1 / 1;
  border-radius: 10px;
}

.reference-library-image {
  object-fit: cover;
  background: var(--color-bg-surface-hover);
}

.reference-library-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-bg-surface-hover);
  color: var(--color-text-muted);
  font-size: 12px;
}

.reference-library-meta {
  margin-top: 8px;
}

.reference-library-name {
  color: var(--color-text-primary);
  font-size: 12px;
  line-height: 1.45;
  overflow: hidden;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  word-break: break-all;
}

.reference-library-date {
  margin-top: 4px;
  color: var(--color-text-primary);
  font-size: 11px;
}

.reference-library-empty {
  min-height: 220px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: 8px;
  color: var(--color-text-primary);
}

.reference-library-empty-title {
  color: var(--color-text-primary);
  font-size: 14px;
}

.reference-library-empty-desc {
  max-width: 420px;
  line-height: 1.6;
  font-size: 13px;
}

.reference-library-empty-action {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
}

.reference-library-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 4px;
}

.reference-library-selection {
  color: var(--color-text-primary);
  font-size: 12px;
}

.reference-library-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ratio-options {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.ratio-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 8px 12px;
  background: transparent;
  border: 1px solid var(--color-border-subtle);
  border-radius: 6px;
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: all 0.2s;
}

.ratio-btn:hover {
  border-color: var(--color-border);
}

.ratio-btn.disabled {
  color: var(--color-text-disabled);
  cursor: not-allowed;
}

.ratio-btn.active {
  color: var(--color-text-selected);
  background: var(--color-bg-selected);
}

.ratio-icon-wrapper {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
}

.ratio-icon {
  border: 1.5px solid currentColor;
  border-radius: 3px;
  transition: all 0.2s ease;
}

.ratio-icon.ratio-1-1 {
  width: 20px;
  height: 20px;
}

.ratio-icon.ratio-1-4 {
  width: 8px;
  height: 24px;
}

.ratio-icon.ratio-1-8 {
  width: 5px;
  height: 24px;
}

.ratio-icon.ratio-2-3 {
  width: 16px;
  height: 24px;
}

.ratio-icon.ratio-3-2 {
  width: 24px;
  height: 16px;
}

.ratio-icon.ratio-3-4 {
  width: 16px;
  height: 22px;
}

.ratio-icon.ratio-4-1 {
  width: 24px;
  height: 8px;
}

.ratio-icon.ratio-4-3 {
  width: 22px;
  height: 16px;
}

.ratio-icon.ratio-4-5 {
  width: 18px;
  height: 22px;
}

.ratio-icon.ratio-5-4 {
  width: 22px;
  height: 18px;
}

.ratio-icon.ratio-8-1 {
  width: 24px;
  height: 5px;
}

.ratio-icon.ratio-9-16 {
  width: 14px;
  height: 24px;
}

.ratio-icon.ratio-16-9 {
  width: 24px;
  height: 14px;
}

.ratio-icon.ratio-21-9 {
  width: 24px;
  height: 10px;
}

.ratio-label {
  font-size: 11px;
  margin-top: 2px;
}

/* 比例下面那行大小档位：只有 Auto / 1K / 2K / 4K，具体像素由下面那行灰字负责说 */
.size-tier-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.size-tier-btn,
.count-btn {
  min-width: 44px;
  height: 30px;
  padding: 0 12px;
  background: var(--color-bg-surface);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-sm);
  color: var(--color-text-secondary);
  font-family: inherit;
  font-size: var(--font-size-sm);
  cursor: pointer;
  transition: all var(--motion-fast) var(--easing-standard);
}

.size-tier-btn:hover,
.count-btn:hover {
  border-color: var(--color-border-strong);
  color: var(--color-text-primary);
}

/* 选中态给背景而不只是描边 —— 只换边框色在深底上几乎看不出来 */
.size-tier-btn.active,
.count-btn.active {
  background: var(--color-bg-selected);
  color: var(--color-text-primary);
}

.size-summary {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}

.count-options {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.count-custom {
  min-width: 0;
}

/* 折叠的高级参数 */
.advanced-section {
  padding-top: 4px;
  border-top: 1px solid var(--color-border);
}

.advanced-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 0;
  background: transparent;
  border: none;
  color: var(--color-text-secondary);
  font-family: inherit;
  font-size: var(--font-size-sm);
  text-align: left;
  cursor: pointer;
}

.advanced-arrow {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  transform: rotate(-90deg);
  transition: transform var(--motion-fast) var(--easing-standard);
}

.advanced-arrow.open {
  transform: rotate(0deg);
}

.advanced-title {
  color: var(--color-text-secondary);
}

.advanced-summary {
  margin-left: auto;
  color: var(--color-text-muted);
}

.advanced-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 4px;
}

.resolution-options {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(112px, 1fr));
  gap: 8px;
}

.batch-count-value {
  font-size: 12px;
  color: var(--color-accent-text);
  font-weight: 600;
  text-align: center;
}

.batch-slider-card {
  padding: 12px;
  border-radius: 14px;
  border: 1px solid var(--color-border-subtle);
  background: var(--color-bg-surface-hover);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.batch-slider-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.batch-slider-bound {
  width: 18px;
  flex-shrink: 0;
  text-align: center;
  font-size: 12px;
  color: var(--color-text-primary);
}

.batch-count-slider {
  flex: 1;
  height: 6px;
  margin: 0;
  appearance: none;
  border-radius: 999px;
  background: transparent;
  outline: none;
}

.batch-count-slider::-webkit-slider-runnable-track {
  height: 6px;
  border-radius: 999px;
  background: var(--color-border-strong);
}

.batch-count-slider::-webkit-slider-thumb {
  width: 16px;
  height: 16px;
  margin-top: -5px;
  appearance: none;
  border-radius: 50%;
  border: 2px solid var(--color-border-subtle);
  background: var(--color-accent-solid);
  box-shadow: 0 4px 14px var(--color-accent-border);
  cursor: pointer;
}

.batch-count-slider::-moz-range-track {
  height: 6px;
  border-radius: 999px;
  background: var(--color-border-strong);
}

.batch-count-slider::-moz-range-thumb {
  width: 16px;
  height: 16px;
  border: 2px solid var(--color-border-subtle);
  border-radius: 50%;
  background: var(--color-accent-solid);
  box-shadow: 0 4px 14px var(--color-accent-border);
  cursor: pointer;
}

.batch-slider-hint {
  font-size: 12px;
  color: var(--color-text-primary);
}

.resolution-btn {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  padding: 10px 16px;
  background: transparent;
  border: 1px solid var(--color-border-subtle);
  border-radius: 6px;
  color: var(--color-text-secondary);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
}

.resolution-btn:hover {
  border-color: var(--color-border);
  background: var(--color-bg-surface-hover);
}

.resolution-btn.active {
  color: var(--color-text-selected);
  background: var(--color-bg-selected);
}

.resolution-title {
  font-size: 13px;
  font-weight: 600;
}

.resolution-hint {
  font-size: 11px;
  line-height: 1.45;
  color: var(--color-text-primary);
  text-align: left;
}

/* 面板抬头：一行放下「模型」标签和当前模型，剩下的高度全留给提示词 */
.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.panel-header-label {
  flex-shrink: 0;
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}

.model-select {
  flex: 1;
  min-width: 0;
}

.model-settings-button {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-xs);
  padding: 5px 8px;
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  font-family: inherit;
  font-size: var(--font-size-sm);
  cursor: pointer;
}

.model-settings-button:hover {
  color: var(--color-text-primary);
}

/*
 * 钉在面板底部。左栏本身是滚动容器，按钮跟着内容滚就会掉到折叠线以下 ——
 * 负边距把这条带子铺到面板左右边缘，滚动时才不会从缝里透出内容。
 */
/*
 * 底色不能写死一个灰：面板本身是透明的，背后是各主题自己的 --app-surface-bg 渐变，
 * 铺一块不透明色就等于在深蓝上贴一张灰纸。用主题的半透明面色 + 模糊，
 * 跟着主题走，滚动的内容也不会从底下透出来。
 */
.generate-footer {
  position: sticky;
  bottom: 0;
  z-index: 5;
  margin: auto -16px -16px;
  padding: 12px 16px;
  background: var(--color-bg-surface-hover);
  border-top: 1px solid var(--color-border);
  backdrop-filter: blur(16px) brightness(0.65);
}

.generate-btn {
  width: 100%;
  height: 49px;
  padding: 14px;
  background: var(--color-accent-solid);
  border: none;
  border-radius: var(--radius-md);
  color: var(--color-text-on-solid);
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-semibold);
  cursor: pointer;
  transition: all var(--motion-fast) var(--easing-standard);
}

.generate-btn:hover:not(:disabled) {
  background: var(--color-accent-solid-hover);
  transform: translateY(-1px);
}

.generate-btn:disabled {
  color: var(--color-text-disabled);
  background: var(--color-bg-surface-hover);
  box-shadow: none;
  cursor: not-allowed;
}

.generate-btn .loading-icon {
  margin-right: 8px;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

.generate-label {
  font-weight: var(--font-weight-semibold);
  color: var(--color-text-primary);
}

@media (max-width: 640px) {
  .resolution-options {
    grid-template-columns: 1fr;
  }
}
</style>
