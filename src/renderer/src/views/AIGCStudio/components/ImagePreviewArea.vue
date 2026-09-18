<script setup lang="ts">
/**
 * ImagePreviewArea - 图片预览区域
 * 支持显示多张生成的图片，以及加载状态和进度
 */
import { ref, computed, nextTick, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  PhArrowClockwise,
  PhCaretLeft,
  PhCaretRight,
  PhCircleNotch,
  PhCopy,
  PhDotsThree,
  PhDownloadSimple,
  PhImage,
  PhXCircle
} from '@phosphor-icons/vue'
import AppDropdown from '@renderer/components/AppDropdown.vue'
import AppMenu from '@renderer/components/AppMenu.vue'
import AppMenuItem from '@renderer/components/AppMenuItem.vue'
import { openImageViewer, type ImageViewerItemInput } from '@renderer/services/imageViewer'
import {
  getAvailableImageTaskActions,
  type ImageTaskActionKey
} from '../composables/useImageTaskActions'

const { t } = useI18n()

/**
 * 定义组件事件
 * 使用事件而非全局事件总线，确保只影响当前 TAB 页面
 */
const emit = defineEmits<{
  /**
   * 图片动作。清单和实现都在 composables/useImageTaskActions.ts，
   * 这里只负责说「用户对第几张图点了哪一项」—— 右侧历史卡片抛的是同一件事。
   */
  (e: 'action', payload: { key: ImageTaskActionKey; index: number }): void
  /** 重试生成 */
  (e: 'retry'): void
  /** 把这条提示词填回左侧输入框，接着改了再生成 */
  (e: 'reuse-prompt', prompt: string): void
}>()

const props = defineProps<{
  images?: string[]
  /** 从历史记录打开大图时可翻阅的完整图片序列 */
  viewerItems?: ImageViewerItemInput[]
  isLoading?: boolean
  progress?: number
  error?: string
  prompt?: string
  modelLabel?: string
  /** 这条记录是否已生成成功 —— 只有成功的图在资产库里才有落点 */
  isCompleted?: boolean
}>()

/** 当前预览的图片索引 */
const currentIndex = ref(0)

/**
 * 生成任务结束不等于浏览器已经拿到图片像素。
 * 先等 load，再展示图片；切换多图预览时也走同一套落点。
 */
const previewImageRef = ref<HTMLImageElement | null>(null)
const previewImageReady = ref(false)

/** 底部提示词是否展开。默认收成一行，把画布还给图 */
const promptExpanded = ref(false)

/** 是否有图片 */
const hasImages = computed(() => Boolean(props.images && props.images.length > 0))

/** 当前显示的图片 */
const currentImage = computed(() => {
  if (!props.images || props.images.length === 0) return null
  return props.images[currentIndex.value] || props.images[0]
})

function revealPreviewImage(): void {
  previewImageReady.value = true
}

watch(
  currentImage,
  (image) => {
    previewImageReady.value = false
    if (!image) return

    // 缓存命中时可能来不及触发 load；检查 complete，不能让结果一直隐藏。
    void nextTick(() => {
      if (previewImageRef.value?.complete) {
        revealPreviewImage()
      }
    })
  },
  { immediate: true }
)

/** 图片总数 */
const totalImages = computed(() => props.images?.length || 0)

/**
 * 切换到上一张
 */
function prevImage() {
  if (currentIndex.value > 0) {
    currentIndex.value--
  }
}

/**
 * 切换到下一张
 */
function nextImage() {
  if (props.images && currentIndex.value < props.images.length - 1) {
    currentIndex.value++
  }
}

/**
 * 抛给父组件去执行的图片动作。
 *
 * 带上 `index` 是因为多视图任务一条记录四张图 ——「下载」下的必须是**你正看着的这张**，
 * 而不是永远第一张。
 */
function runAction(key: ImageTaskActionKey): void {
  emit('action', { key, index: currentIndex.value })
}

/**
 * 「⋯」里的完整动作清单，和右侧历史卡片的那份逐字相同。
 * 顶部平铺的几个只是快捷方式，不从这里去掉 —— 找不到就点「⋯」，这条规则要在哪儿都成立。
 */
const menuActions = computed(() =>
  getAvailableImageTaskActions({
    hasImage: hasImages.value,
    hasPrompt: Boolean(props.prompt),
    isCompleted: props.isCompleted === true
  })
)

/**
 * 打开图片查看器查看当前图片
 */
async function openViewer(): Promise<void> {
  if (!props.images || props.images.length === 0) return

  const items = props.viewerItems?.length ? props.viewerItems : props.images.map((src) => ({ src }))
  const historyIndex = items.findIndex((item) => item.src === currentImage.value)
  await openImageViewer({
    items,
    index: historyIndex >= 0 ? historyIndex : currentIndex.value
  })
}
</script>

<template>
  <div class="image-preview-area">
    <!-- 加载状态 -->
    <template v-if="isLoading">
      <div class="loading-state">
        <PhCircleNotch class="icon-spin loading-icon" />
        <p class="loading-text">
          {{
            $t('aigcImagePreviewArea.generatingWithModel', {
              model: modelLabel || $t('aigcImagePreviewArea.defaultModelLabel')
            })
          }}
        </p>
        <p v-if="progress !== undefined" class="loading-progress">{{ progress }}%</p>
      </div>
    </template>

    <!-- 图片预览 -->
    <template v-else-if="hasImages">
      <img
        ref="previewImageRef"
        :key="currentImage ?? ''"
        :src="currentImage!"
        alt="Generated Image"
        class="preview-image clickable"
        :class="{ 'is-ready': previewImageReady }"
        :title="$t('aigcImagePreviewArea.clickToViewLarge')"
        @load="revealPreviewImage"
        @error="revealPreviewImage"
        @click="openViewer"
      />
      <div
        v-if="!previewImageReady"
        class="result-preparing-state"
        role="status"
        aria-live="polite"
      >
        <PhCircleNotch class="icon-spin result-preparing-icon" />
        <p>{{ $t('aigcImagePreviewArea.preparingResult') }}</p>
      </div>

      <!-- 导航控制 -->
      <div v-if="totalImages > 1" class="nav-controls">
        <button class="nav-btn prev" :disabled="currentIndex === 0" @click="prevImage">
          <PhCaretLeft />
        </button>
        <span class="nav-indicator">{{ currentIndex + 1 }} / {{ totalImages }}</span>
        <button class="nav-btn next" :disabled="currentIndex >= totalImages - 1" @click="nextImage">
          <PhCaretRight />
        </button>
      </div>

      <!-- 缩略图列表 -->
      <div v-if="totalImages > 1" class="thumbnail-list">
        <div
          v-for="(img, index) in images"
          :key="index"
          class="thumbnail"
          :class="{ active: index === currentIndex }"
          @click="currentIndex = index"
        >
          <img :src="img" alt="" />
        </div>
      </div>

      <!--
        底部提示词。原来三行小字压着画布，既读不完也用不上 ——
        收成一行，把「展开 / 复制 / 用这段再生成」做成三个明确的动作。
      -->
      <div v-if="prompt" class="prompt-bar">
        <span class="prompt-label">{{ $t('aigcImagePreviewArea.promptLabel') }}</span>
        <p class="prompt-text" :class="{ expanded: promptExpanded }">{{ prompt }}</p>
        <button class="prompt-action" type="button" @click="promptExpanded = !promptExpanded">
          {{
            promptExpanded
              ? $t('aigcImagePreviewArea.promptBar.collapse')
              : $t('aigcImagePreviewArea.promptBar.expand')
          }}
        </button>
        <button
          class="prompt-action icon"
          type="button"
          :title="$t('aigcImageActions.copyPrompt')"
          :aria-label="$t('aigcImageActions.copyPrompt')"
          @click="runAction('copyPrompt')"
        >
          <PhCopy />
        </button>
        <button
          class="prompt-action icon"
          type="button"
          :title="$t('aigcImagePreviewArea.promptBar.reuse')"
          :aria-label="$t('aigcImagePreviewArea.promptBar.reuse')"
          @click="emit('reuse-prompt', prompt)"
        >
          <PhArrowClockwise />
        </button>
      </div>
    </template>

    <!-- 错误状态 -->
    <template v-else-if="error">
      <div class="error-state">
        <PhXCircle class="error-icon" />
        <p class="error-title">{{ $t('aigcImagePreviewArea.generationFailed') }}</p>
        <p class="error-message">{{ error }}</p>
        <p v-if="prompt" class="error-prompt">
          {{ $t('aigcImagePreviewArea.errorPromptLabel', { prompt }) }}
        </p>
        <button class="retry-btn" @click="emit('retry')">
          <PhArrowClockwise />
          {{ $t('aigcImagePreviewArea.retryButton') }}
        </button>
      </div>
    </template>

    <!--
      工具栏：图标旁边补上文字。
      纯图标按钮既是可访问性硬伤（读屏念不出来），也让人不敢点。

      平铺的只是最常用的几个，末尾那个「⋯」里是**完整清单**，
      和右侧历史卡片的「⋯」逐字相同 —— 一个动作在这边找不到，在那边也不会有。
      生成失败时也留着：那条记录同样可以回填参数、复制提示词、删掉。
    -->
    <div v-if="!isLoading && (hasImages || error)" class="toolbar">
      <button
        v-if="hasImages"
        class="tool-btn"
        :title="$t('aigcImageActions.useAsReference')"
        :aria-label="$t('aigcImageActions.useAsReference')"
        @click="runAction('useAsReference')"
      >
        <PhImage />
        <span class="tool-label">{{ $t('aigcImagePreviewArea.labels.useAsReference') }}</span>
      </button>
      <button
        v-if="hasImages"
        class="tool-btn"
        :title="$t('aigcImageActions.copyImage')"
        :aria-label="$t('aigcImageActions.copyImage')"
        @click="runAction('copyImage')"
      >
        <PhCopy />
        <span class="tool-label">{{ $t('aigcImagePreviewArea.labels.copyImage') }}</span>
      </button>
      <button
        v-if="hasImages"
        class="tool-btn"
        :title="$t('aigcImageActions.download')"
        :aria-label="$t('aigcImageActions.download')"
        @click="runAction('download')"
      >
        <PhDownloadSimple />
        <span class="tool-label">{{ $t('aigcImagePreviewArea.labels.download') }}</span>
      </button>
      <AppDropdown v-if="menuActions.length > 0" :trigger="['click']" placement="bottomRight">
        <button
          class="tool-btn icon-only"
          :title="$t('aigcImageActions.more')"
          :aria-label="$t('aigcImageActions.more')"
        >
          <PhDotsThree />
        </button>
        <template #overlay>
          <AppMenu @click="(info) => runAction(info.key as ImageTaskActionKey)">
            <AppMenuItem
              v-for="action in menuActions"
              :key="action.key"
              :item-key="action.key"
              :danger="action.danger === true"
            >
              <template #icon><component :is="action.icon" /></template>
              {{ $t(action.labelKey) }}
            </AppMenuItem>
          </AppMenu>
        </template>
      </AppDropdown>
    </div>

    <!-- 空状态 -->
    <template v-if="!isLoading && !hasImages && !error">
      <div class="empty-state">
        <PhImage class="empty-icon" />
        <p class="empty-text">{{ $t('aigcImagePreviewArea.emptyText') }}</p>
        <p class="empty-hint">{{ $t('aigcImagePreviewArea.emptyHint') }}</p>
      </div>
    </template>
  </div>
</template>

<style scoped>
.image-preview-area {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: var(--color-bg-surface);
  overflow: hidden;
  position: relative;
}

.preview-image {
  max-width: 100%;
  max-height: calc(100% - 120px);
  object-fit: contain;
  border-radius: 4px;
  opacity: 0;
  transform: translateY(6px) scale(0.985);
}

.preview-image.clickable {
  cursor: pointer;
  transition: opacity var(--motion-normal) var(--easing-decelerate);
}

.preview-image.is-ready {
  opacity: 1;
  transform: translateY(0) scale(1);
  animation: image-result-reveal var(--motion-normal) var(--easing-decelerate) both;
}

.preview-image.clickable:hover {
  opacity: 0.9;
}

.result-preparing-state {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
  pointer-events: none;
}

.result-preparing-state p {
  margin: 0;
}

.result-preparing-icon {
  color: var(--color-accent-text);
  font-size: var(--font-size-xl);
}

@keyframes image-result-reveal {
  from {
    opacity: 0;
    transform: translateY(6px) scale(0.985);
  }

  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

/* 导航控制 */
.nav-controls {
  position: absolute;
  bottom: 150px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 16px;
  background: var(--color-bg-overlay);
  padding: 8px 16px;
  border-radius: 20px;
  opacity: 0;
  transition: opacity 0.3s ease;
}

.image-preview-area:hover .nav-controls {
  opacity: 1;
}

.nav-btn {
  width: 28px;
  height: 28px;
  border: none;
  background: var(--color-bg-surface-hover);
  color: var(--color-text-primary);
  border-radius: 50%;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.2s;
}

.nav-btn:hover:not(:disabled) {
  background: var(--color-bg-surface-hover);
}

.nav-btn:disabled {
  color: var(--color-text-disabled);
  cursor: not-allowed;
}

.nav-indicator {
  font-size: 13px;
  color: var(--color-text-primary);
}

/* 工具栏 */
.toolbar {
  position: absolute;
  top: 16px;
  right: 16px;
  display: flex;
  gap: 8px;
}

.tool-btn {
  height: 32px;
  padding: 0 10px;
  border: none;
  background: var(--color-bg-surface-hover);
  color: var(--color-text-primary);
  border-radius: 8px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
  justify-content: center;
  font-family: inherit;
  font-size: var(--font-size-sm);
  transition: background 0.2s;
}

.tool-label {
  white-space: nowrap;
}

.tool-btn:hover {
  background: var(--color-bg-surface-hover);
}

/* 「⋯」不配文字：它不是一个动作，是「还有别的」 */
.tool-btn.icon-only {
  width: 32px;
  padding: 0;
  font-size: var(--font-size-lg);
}

/* 缩略图列表 */
.thumbnail-list {
  position: absolute;
  bottom: 66px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 8px;
  background: var(--color-bg-overlay);
  padding: 8px;
  border-radius: 8px;
  opacity: 0;
  transition: opacity 0.3s ease;
}

.image-preview-area:hover .thumbnail-list {
  opacity: 1;
}

.thumbnail {
  width: 48px;
  height: 48px;
  border-radius: 4px;
  overflow: hidden;
  cursor: pointer;
  border: 2px solid transparent;
  transition: border-color 0.2s;
}

.thumbnail.active {
  border-color: var(--color-accent-border);
}

.thumbnail img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

/* 加载状态 */
.loading-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  color: var(--color-text-primary);
}

.loading-icon {
  font-size: 48px;
  color: var(--color-accent-text);
}

.loading-text {
  font-size: 14px;
  margin: 0;
}

/* 空状态 */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  color: var(--color-text-muted);
}

.empty-icon {
  font-size: 48px;
}

.empty-text {
  font-size: 14px;
  margin: 0;
}

.empty-hint {
  font-size: 12px;
  margin: 0;
  color: var(--color-text-primary);
}

.loading-progress {
  font-size: 24px;
  font-weight: 600;
  color: var(--color-accent-text);
  margin: 8px 0 0 0;
}

@media (prefers-reduced-motion: reduce) {
  .preview-image,
  .preview-image.clickable,
  .preview-image.is-ready {
    animation: none;
    transform: none;
    transition: none;
  }

  .result-preparing-state :deep(.icon-spin) {
    animation: none;
  }
}

/* 错误状态 */
.error-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  color: var(--color-danger-text);
  text-align: center;
  padding: 32px;
}

.error-icon {
  font-size: 48px;
}

.error-title {
  font-size: 16px;
  font-weight: 500;
  margin: 0;
}

.error-message {
  font-size: 14px;
  color: var(--color-text-primary);
  margin: 0;
  max-width: 400px;
  line-height: 1.5;
}

.error-prompt {
  font-size: 13px;
  color: var(--color-text-primary);
  margin: 8px 0 0 0;
  max-width: 400px;
}

.retry-btn {
  margin-top: 16px;
  padding: 10px 24px;
  background: var(--color-accent-solid);
  color: var(--color-text-on-solid);
  border: none;
  border-radius: 8px;
  font-size: 14px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 8px;
  transition: background 0.2s;
}

.retry-btn:hover {
  background: var(--color-accent-solid-hover);
}

/* 底部提示词区域 */
.prompt-bar {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  background: var(--color-bg-surface-hover);
  padding: 8px 16px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.prompt-label {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--color-accent-text);
  font-weight: 500;
}

.prompt-text {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: 12px;
  color: var(--color-text-primary);
  line-height: 1.5;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 展开后最多五行，再长就自己滚 —— 别让提示词把整张图吃掉 */
.prompt-text.expanded {
  max-height: 90px;
  overflow-y: auto;
  text-overflow: clip;
  white-space: pre-wrap;
  word-break: break-word;
}

.prompt-action {
  flex-shrink: 0;
  align-self: flex-start;
  padding: 2px 6px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--color-text-primary);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: color 0.2s ease;
}

.prompt-action:hover {
  color: var(--color-accent-text);
}

.prompt-action.icon {
  font-size: 14px;
}
</style>
