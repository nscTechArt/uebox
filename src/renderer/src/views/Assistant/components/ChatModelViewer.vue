<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import ModelViewer from '@renderer/components/ModelViewer.vue'
import { PhCaretDown, PhCube } from '@phosphor-icons/vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

/**
 * ChatModelViewer 组件 - 专用于对话气泡中的 3D 模型展示
 *
 * 简化版 ModelViewer，避免无限 resize 问题：
 * 1. 固定高度容器
 * 2. 移除复杂的 ResizeObserver 和手动 canvas 调整
 * 3. 保留核心的本地文件协议处理
 */

const props = withDefaults(
  defineProps<{
    filePath?: string | null
    /** 一个气泡里有多个模型时，只有最新的那个默认展开，见 AIBubble 的 modelPreviewPaths */
    defaultCollapsed?: boolean
  }>(),
  { filePath: null, defaultCollapsed: false }
)

const emit = defineEmits<{ resize: [] }>()

/** 模型真的转起来了才接管滚轮，见 onWheel */
const loaded = ref(false)
/** 预览器有 600px 高，还挂在最后一条消息的末尾 —— 不想看的时候要能一键收掉 */
const isCollapsed = ref(props.defaultCollapsed)
/** 用户自己点过之后一切听他的：新模型再来也不去动这一个的开合 */
const userToggled = ref(false)

/** 标题栏显示文件名，收起之后还能认出这是哪个模型 */
const fileName = computed(() => {
  if (!props.filePath) return ''
  const last = props.filePath.split(/[?#]/)[0].split(/[\\/]/).pop() ?? ''
  // 路径已经是 local-resource:// 形式，中文名在里面是百分号编码的
  try {
    return decodeURIComponent(last)
  } catch {
    return last
  }
})

// 路径原样交给 ModelViewer：本地路径、local-resource:// 和 http(s) 它都认
watch(
  () => props.filePath,
  () => {
    loaded.value = false
  }
)

const onLoad = (): void => {
  loaded.value = true
}

const onError = (message: string): void => {
  loaded.value = false
  console.error('[ChatModelViewer] 模型加载失败:', message)
}

/**
 * 滚轮停在这个盒子里：在模型上滚是缩放，不该顺手把聊天记录也翻走。
 *
 * 光靠 OrbitControls 自己 preventDefault 挡不住 —— ChatLog 的列表是
 * `scaleY(-1)` 翻过来的，它在容器上挂了 `@wheel`，自己 preventDefault 之后
 * 手动改 scrollTop（见 ChatLog.vue 的 handleWheel）。那是 JS 干的，不是浏览器
 * 的默认行为，只要事件冒泡上去就照样滚。所以这里两件事都要做：
 * stopPropagation 掐掉上面那个手动滚动，preventDefault 掐掉浏览器的滚动链。
 *
 * 只在模型真的加载出来之后才拦。加载中或加载失败时放行，免得留一块 600px 高、
 * 既不能缩放也滚不动的死区。
 */
const onWheel = (e: WheelEvent): void => {
  if (!loaded.value) return
  e.preventDefault()
  e.stopPropagation()
}

/** 收起后只剩一条标题栏。收起时整个 loader 卸载，顺手把 WebGL 上下文还回去 */
const setCollapsed = (collapsed: boolean): void => {
  if (isCollapsed.value === collapsed) return
  isCollapsed.value = collapsed
  if (collapsed) loaded.value = false
  // 高度变了，让外面的消息列表重新量一次
  emit('resize')
}

const toggleCollapse = (): void => {
  userToggled.value = true
  setCollapsed(!isCollapsed.value)
}

// 又出了个新模型 → 这一个不再是最新的，自动收起把上下文让出去；
// 但用户自己点开过的就别抢，他要的就是把这个摊着看。
watch(
  () => props.defaultCollapsed,
  (collapsed) => {
    if (!userToggled.value) setCollapsed(collapsed)
  }
)
</script>

<template>
  <div class="chat-model-viewer" :class="{ collapsed: isCollapsed }">
    <button
      type="button"
      class="viewer-header"
      :aria-expanded="!isCollapsed"
      :title="
        isCollapsed
          ? t('assistant.chatModelViewer.expand')
          : t('assistant.chatModelViewer.collapse')
      "
      @click="toggleCollapse"
    >
      <span class="header-left">
        <PhCube class="model-icon" />
        <span class="header-title">{{ fileName || t('assistant.chatModelViewer.title') }}</span>
      </span>
      <PhCaretDown class="collapse-icon" :class="{ expanded: !isCollapsed }" />
    </button>

    <div v-if="!isCollapsed" class="viewer-body" @wheel="onWheel">
      <ModelViewer
        v-if="props.filePath"
        :file-path="props.filePath"
        :auto-play="true"
        @load="onLoad"
        @error="onError"
      />
      <div v-else class="loading-placeholder">
        <div class="loading-spinner"></div>
        <span>{{ t('assistant.chatModelViewer.preparing') }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped lang="less">
.chat-model-viewer {
  width: 100%;
  position: relative;
  background: var(--color-bg-surface-hover);
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid var(--color-border-subtle);
}

.viewer-header {
  display: flex;
  align-items: center;
  width: 100%;
  padding: 6px 8px;
  border: 0;
  cursor: pointer;
  background: var(--color-bg-surface-hover);
  color: var(--color-text-secondary);
  font: inherit;
  font-size: 13px;
  text-align: left;
  transition: background 0.2s;

  &:hover {
    opacity: 0.8;
  }
}

.header-left {
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
  gap: 6px;
}

.header-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-icon {
  flex-shrink: 0;
  font-size: 14px;
}

.collapse-icon {
  flex-shrink: 0;
  font-size: 12px;
  transition: transform 0.2s;

  &.expanded {
    transform: rotate(180deg);
  }
}

.viewer-body {
  width: 100%;
  height: 600px; /* 固定高度，避免高度塌陷或无限增长 */
  position: relative;
  border-top: 1px solid var(--color-border-subtle);
}

.loading-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--color-text-primary);
  gap: 12px;
  font-size: 13px;

  .loading-spinner {
    width: 24px;
    height: 24px;
    border: 2px solid var(--color-border-subtle);
    border-top-color: var(--color-accent-border);
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

:deep(canvas) {
  outline: none;
}
</style>
