<script setup lang="ts">
import { ref, watch } from 'vue'
import ModelViewer from '@renderer/components/ModelViewer.vue'
import { toLocalResourceUrl } from '@renderer/utils/localResource'

interface QueueItem {
  assetKey: string
  filePath: string
  fileType: string
}

const props = defineProps<{
  queue: QueueItem[]
}>()

const emit = defineEmits<{
  (e: 'generated', payload: { assetKey: string; base64: string }): void
  (e: 'error', payload: { assetKey: string; error: string }): void
}>()

const containerRef = ref<HTMLElement | null>(null)
const viewerRef = ref<InstanceType<typeof ModelViewer> | null>(null)
const currentItem = ref<QueueItem | null>(null)
const modelUrl = ref<string | null>(null)
const isProcessing = ref(false)
let snapshotTaken = false

const processNext = (): void => {
  if (isProcessing.value) return

  if (props.queue.length === 0) {
    console.log('[ThumbnailGenerator] Queue empty, stopping')
    isProcessing.value = false
    currentItem.value = null
    modelUrl.value = null
    return
  }

  isProcessing.value = true
  snapshotTaken = false
  const item = props.queue[0] // 获取队首元素但不移除，等待处理完成后移除
  currentItem.value = item

  // 构建文件 URL（本地路径走 local-resource://，dev 模式下 file:/// 加载不了）
  const url = toLocalResourceUrl(item.filePath) ?? item.filePath
  modelUrl.value = url
  console.log('[ThumbnailGenerator] Processing:', item.assetKey, url)
}

const onLoad = (): void => {
  console.log('[ThumbnailGenerator] Model loaded:', currentItem.value?.assetKey)
  // 取景动画和首帧渲染要一点时间，早截会拍到空画面
  setTimeout(() => {
    const item = currentItem.value
    viewerRef.value?.captureSnapshot()
    // 截图是同步 emit 的：拿到图 onSnapshot 已经处理完；没拿到就报错，
    // 不然这一项永远留在队首，会被反复重载重拍
    if (item && !snapshotTaken) emit('error', { assetKey: item.assetKey, error: 'empty snapshot' })
    if (currentItem.value) finishCurrentItem()
  }, 400)
}

const onError = (message: string): void => {
  console.error('[ThumbnailGenerator] Load error:', message, currentItem.value?.assetKey)
  if (currentItem.value) {
    emit('error', { assetKey: currentItem.value.assetKey, error: message })
    finishCurrentItem()
  }
}

const onSnapshot = (base64: string): void => {
  if (!currentItem.value) return
  snapshotTaken = true
  emit('generated', { assetKey: currentItem.value.assetKey, base64 })
}

const finishCurrentItem = (): void => {
  console.log('[ThumbnailGenerator] Finished item:', currentItem.value?.assetKey)
  isProcessing.value = false
  currentItem.value = null
  modelUrl.value = null // 重置 modelUrl 以强制重新加载组件

  // 稍微延迟一下再处理下一个，避免 UI 卡顿，并等待父组件更新 props
  setTimeout(() => {
    processNext()
  }, 200)
}

// 监听队列变化，如果当前没有处理任务且队列不为空，则开始处理
watch(
  () => props.queue,
  (newQueue) => {
    if (!isProcessing.value && newQueue.length > 0) {
      processNext()
    }
  },
  { deep: true, immediate: true }
)
</script>

<template>
  <div ref="containerRef" class="thumbnail-generator">
    <ModelViewer
      v-if="modelUrl"
      ref="viewerRef"
      :key="modelUrl"
      :file-url="modelUrl"
      :auto-play="false"
      @load="onLoad"
      @error="onError"
      @snapshot="onSnapshot"
    />
  </div>
</template>

<style scoped>
.thumbnail-generator {
  width: 512px;
  height: 512px;
  position: fixed;
  left: -9999px; /* 移出可视区域 */
  top: 0;
  /* visibility: hidden 可能会导致 canvas 不渲染，建议用 opacity: 0 和 pointer-events: none */
  visibility: visible;
  opacity: 0;
  pointer-events: none;
  z-index: -1;
  background: transparent;
}
</style>
