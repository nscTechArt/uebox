<script setup lang="ts">
/**
 * 思维导图查看器组件
 * 使用 simple-mind-map 渲染只读的思维导图
 */
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { message } from '@renderer/utils/messageManager'
import MindMapCore from 'simple-mind-map'
import MindMapWithPlugins from 'simple-mind-map/full.js'
import { PhArrowLeft, PhCircleNotch, PhDownloadSimple, PhTreeStructure } from '@phosphor-icons/vue'
import type { MindmapNode } from '@renderer/services/mindmap/types'

const props = defineProps<{
  /** 思维导图数据 */
  data: MindmapNode | null
}>()

const emit = defineEmits<{
  /** 节点点击事件 */
  (e: 'node-click', node: MindmapNode['data']): void
  /** 节点双击事件 */
  (
    e: 'node-dblclick',
    payload: { data: MindmapNode['data']; parent: MindmapNode['data'] | null }
  ): void
  /** 返回事件 */
  (e: 'back'): void
}>()

const { t } = useI18n()

/** 容器引用 */
const containerRef = ref<HTMLDivElement | null>(null)

/** MindMap 实例 */
type MindMapInstance = InstanceType<typeof MindMapCore>
let mindMapInstance: MindMapInstance | null = null

/** 导出状态 */
const exportingType = ref<'png' | 'xmind' | null>(null)

/** 点击计数器，用于模拟双击 */
let clickTimer: number | null = null
let lastClickNodeUid: string | null = null

/**
 * 初始化思维导图
 */
function initMindMap(): void {
  if (!containerRef.value || !props.data) return

  // 销毁旧实例
  if (mindMapInstance) {
    mindMapInstance.destroy()
    mindMapInstance = null
  }

  // 创建新实例 - 使用类型断言避免参数类型检查
  // simple-mind-map 的类型定义要求全部参数，但实际只需要部分
  mindMapInstance = new MindMapWithPlugins({
    el: containerRef.value,
    data: props.data,
    readonly: true,
    layout: 'logicalStructure',
    theme: 'dark2',
    hoverRectColor: 'rgba(128, 151, 255, 0.92)',
    enableFreeDrag: false,
    // 设置为左键多选节点，右键拖动画布
    useLeftKeySelectionRightKeyDrag: true,
    // 鼠标滚轮缩放，以鼠标位置为中心
    mousewheelAction: 'zoom',
    mouseScaleCenterUseMousePosition: true,
    // 主题配置
    themeConfig: {
      backgroundColor: '#101720',
      lineColor: '#7c72ff',
      lineWidth: 2,
      lineStyle: 'curve',
      lineRadius: 8,
      rootLineKeepSameInCurve: true,
      rootLineStartPositionKeepSameInCurve: true,
      generalizationLineColor: '#5f8dff',
      generalizationLineWidth: 2,
      paddingX: 22,
      paddingY: 11,
      root: {
        shape: 'roundedRectangle',
        fillColor: '#6c63ff',
        color: '#ffffff',
        borderColor: '#9b96ff',
        borderWidth: 1,
        fontSize: 17,
        fontWeight: 'bold',
        borderRadius: 16,
        gradientStyle: true,
        startColor: '#7c72ff',
        endColor: '#5e7fff',
        hoverRectColor: '#c2bcff',
        hoverRectRadius: 18
      },
      second: {
        shape: 'roundedRectangle',
        marginX: 124,
        marginY: 56,
        fillColor: 'rgba(28, 39, 58, 0.92)',
        color: '#ffffff',
        borderColor: 'rgba(124, 114, 255, 0.9)',
        borderWidth: 1.3,
        fontSize: 14,
        fontWeight: 'bold',
        borderRadius: 14,
        hoverRectColor: '#9b96ff',
        hoverRectRadius: 16
      },
      node: {
        shape: 'roundedRectangle',
        marginX: 76,
        marginY: 18,
        fillColor: 'rgba(255, 255, 255, 0.08)',
        color: '#dbe6ff',
        borderColor: 'rgba(139, 157, 255, 0.26)',
        borderWidth: 1,
        fontSize: 13,
        borderRadius: 12,
        hoverRectColor: '#7d8fff',
        hoverRectRadius: 14
      }
    }
  } as unknown as ConstructorParameters<typeof MindMapCore>[0]) as MindMapInstance

  // 禁用左键拖拽，启用右键拖拽：通过监听鼠标事件实现
  if (containerRef.value) {
    containerRef.value.addEventListener('contextmenu', (e) => {
      e.preventDefault() // 禁用右键菜单
    })
  }

  // 绑定节点点击事件 (手动处理双击逻辑)
  mindMapInstance.on('node_click', (node: any) => {
    const data = node?.getData ? node.getData() : node?.data
    if (!data) return

    const uid = data.uid || data.text // 尝试获取唯一标识，如果没有uid用text

    if (clickTimer && lastClickNodeUid === uid) {
      // 双击触发
      clearTimeout(clickTimer)
      clickTimer = null
      lastClickNodeUid = null

      console.log('[MindmapViewer] Manual double-click detected', data)
      const parent = node?.parent
      const parentData = parent?.getData ? parent.getData() : parent?.data
      emit('node-dblclick', { data, parent: parentData || null })
    } else {
      // 单击，设置定时器
      if (clickTimer) {
        clearTimeout(clickTimer)
      }
      lastClickNodeUid = uid
      clickTimer = window.setTimeout(() => {
        console.log('[MindmapViewer] Single click confirmed', data)
        emit('node-click', data)
        clickTimer = null
        lastClickNodeUid = null
      }, 300) // 300ms 延迟以等待潜在的双击
    }
  })

  // 绑定节点双击事件 (同时保留，以防万一)
  mindMapInstance.on('node_dblclick', (node: any) => {
    console.log('[MindmapViewer] Library node_dblclick triggered', node)
    // 如果库触发了双击，我们也可以处理，但要注意不要重复触发
    // 由于我们用了 manual detection 并阻止了单击，这里的双击可能会配合使用
    // 但为了避免混乱，建议以 manual 为主，或者只监听 manual
    // 这里仅做 log 观察
  })

  // 初始化后向左偏移300px，使根节点更靠左显示，以便更好地查看右侧子节点
  setTimeout(() => {
    if (mindMapInstance && mindMapInstance.view) {
      // 使用 translateX 方法向左偏移300px（负值表示向左）
      mindMapInstance.view.translateX(-300)
    }
  }, 100)
}

function sanitizeFilename(value: string): string {
  return (
    value
      .trim()
      .replace(/[\r\n\t\\/:*?"<>|]/g, '_')
      .replace(/_+/g, '_')
      .replace(/[. ]+$/g, '')
      .slice(0, 80) || t('notebookMindmapViewer.titleFallback')
  )
}

function dataUrlToUint8Array(dataUrl: string): Uint8Array {
  const base64 = dataUrl.split(',')[1]
  if (!base64) {
    throw new Error('导出数据格式无效')
  }
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

async function saveExportedFile(dataUrl: string, extension: 'png' | 'xmind'): Promise<boolean> {
  const title = sanitizeFilename(props.data?.data?.text || t('notebookMindmapViewer.titleFallback'))
  const dialogResult = await window.electron.ipcRenderer.invoke('dialog:showSaveDialog', {
    title:
      extension === 'png'
        ? t('notebookMindmapViewer.exportPngDialogTitle')
        : t('notebookMindmapViewer.exportXmindDialogTitle'),
    defaultPath: `${title}.${extension}`,
    filters: [
      {
        name:
          extension === 'png'
            ? t('notebookMindmapViewer.pngFilterName')
            : t('notebookMindmapViewer.xmindFilterName'),
        extensions: [extension]
      }
    ]
  })

  if (dialogResult?.canceled || !dialogResult?.filePath) {
    return false
  }

  const bytes = dataUrlToUint8Array(dataUrl)
  await window.electron.ipcRenderer.invoke('fs:writeFile', dialogResult.filePath, Array.from(bytes))
  return true
}

async function handleExport(type: 'png' | 'xmind'): Promise<void> {
  if (!mindMapInstance || !props.data || exportingType.value) {
    return
  }

  exportingType.value = type
  try {
    const filename = sanitizeFilename(
      props.data.data.text || t('notebookMindmapViewer.titleFallback')
    )
    const exported = await mindMapInstance.export(type, false, filename)
    if (!exported || typeof exported !== 'string') {
      throw new Error('导出失败')
    }

    const saved = await saveExportedFile(exported, type)
    if (saved) {
      message.success(
        type === 'png'
          ? t('notebookMindmapViewer.pngExportedToast')
          : t('notebookMindmapViewer.xmindExportedToast')
      )
    }
  } catch (error) {
    console.error(`[MindmapViewer] 导出 ${type} 失败:`, error)
    message.error(
      type === 'png'
        ? t('notebookMindmapViewer.pngExportFailedToast')
        : t('notebookMindmapViewer.xmindExportFailedToast')
    )
  } finally {
    exportingType.value = null
  }
}

// 数据变化时重新渲染
watch(
  () => props.data,
  () => {
    if (props.data) {
      initMindMap()
    }
  },
  { deep: true }
)

/** 防抖 resize 计时器 */
let resizeTimer: ReturnType<typeof setTimeout> | null = null
/** ResizeObserver 实例 */
let resizeObserver: ResizeObserver | null = null

/**
 * 容器大小调整结束后重新适配思维导图大小
 * 使用 500ms 防抖，只在调整结束后触发
 */
function handleResize(): void {
  if (resizeTimer) {
    clearTimeout(resizeTimer)
  }
  resizeTimer = setTimeout(() => {
    if (mindMapInstance) {
      // 调用 resize 方法让思维导图重新适配容器大小
      mindMapInstance.resize()
    }
    resizeTimer = null
  }, 500)
}

onMounted(() => {
  if (props.data) {
    initMindMap()
  }
  // 监听窗口大小变化
  window.addEventListener('resize', handleResize)

  // 使用 ResizeObserver 监听容器大小变化（拖拽 resizer 时也能响应）
  if (containerRef.value) {
    resizeObserver = new ResizeObserver(() => {
      handleResize()
    })
    resizeObserver.observe(containerRef.value)
  }
})

onBeforeUnmount(() => {
  // 移除 resize 监听
  window.removeEventListener('resize', handleResize)
  // 移除 ResizeObserver
  if (resizeObserver) {
    resizeObserver.disconnect()
    resizeObserver = null
  }
  if (resizeTimer) {
    clearTimeout(resizeTimer)
    resizeTimer = null
  }
  if (mindMapInstance) {
    mindMapInstance.destroy()
    mindMapInstance = null
  }
})
</script>

<template>
  <div class="mindmap-viewer">
    <!-- 头部 -->
    <div class="viewer-header">
      <div class="header-left">
        <button class="back-btn" @click="emit('back')">
          <PhArrowLeft />
        </button>
        <div class="header-info">
          <div class="type-badge">
            <PhTreeStructure />
            <span>{{ $t('notebookMindmapViewer.badge') }}</span>
          </div>
          <h2 class="title">
            {{ data?.data?.text || $t('notebookMindmapViewer.titleFallback') }}
          </h2>
        </div>
      </div>
      <div class="toolbar">
        <button
          class="tool-btn"
          :disabled="!data || exportingType !== null"
          @click="handleExport('png')"
        >
          <PhCircleNotch v-if="exportingType === 'png'" class="icon-spin" />
          <PhDownloadSimple v-else />
          <span>{{
            exportingType === 'png'
              ? $t('notebookMindmapViewer.exporting')
              : $t('notebookMindmapViewer.exportPng')
          }}</span>
        </button>
        <button
          class="tool-btn"
          :disabled="!data || exportingType !== null"
          @click="handleExport('xmind')"
        >
          <PhCircleNotch v-if="exportingType === 'xmind'" class="icon-spin" />
          <PhTreeStructure v-else />
          <span>{{
            exportingType === 'xmind'
              ? $t('notebookMindmapViewer.exporting')
              : $t('notebookMindmapViewer.exportXmind')
          }}</span>
        </button>
      </div>
    </div>

    <div ref="containerRef" class="mindmap-container"></div>
    <div v-if="!data" class="empty-state">
      <span>{{ $t('notebookMindmapViewer.emptyState') }}</span>
    </div>
  </div>
</template>

<style scoped lang="less">
.mindmap-viewer {
  width: 100%;
  height: 100%;
  position: relative;
  background: var(--color-accent-bg);
  border-radius: 12px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.viewer-header {
  height: 85px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 24px;
  backdrop-filter: blur(14px);
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.04), rgba(255, 255, 255, 0.01));
  border-bottom: 1px solid var(--color-border-subtle);
  box-shadow: 0 18px 48px var(--shadow-color-weak);
  z-index: 10;
  flex-shrink: 0;
  gap: 16px;

  .header-left {
    display: flex;
    align-items: center;
    gap: 16px;

    .back-btn {
      width: 36px;
      height: 36px;
      border-radius: 50%;
      border: 1px solid var(--color-border-subtle);
      background: var(--color-bg-surface-hover);
      color: var(--color-text-primary);
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: all 0.2s;

      &:hover {
        background: var(--color-bg-surface-hover);
        transform: scale(1.05);
      }
    }

    .header-info {
      display: flex;
      flex-direction: column;
      gap: 4px;

      .type-badge {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 11px;
        color: var(--color-text-primary);
        background: var(--color-accent-bg);
        border: 1px solid var(--color-accent-border);
        padding: 4px 10px;
        border-radius: 999px;
        width: fit-content;
        box-shadow: inset 0 1px 0 var(--shadow-highlight);
      }

      .title {
        font-size: 17px;
        font-weight: 600;
        color: var(--color-text-primary);
        margin: 0;
        line-height: 1.2;
        letter-spacing: 0.02em;
      }
    }
  }

  .toolbar {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .tool-btn {
    height: 38px;
    border-radius: 10px;
    border: 1px solid var(--color-border-subtle);
    background: var(--color-bg-surface-hover);
    color: var(--color-text-primary);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 0 14px;
    cursor: pointer;
    transition: all 0.2s ease;
    font-size: 13px;

    &:hover:not(:disabled) {
      background: var(--color-bg-surface-hover);
      transform: translateY(-1px);
    }

    &:disabled {
      color: var(--color-text-disabled);
      cursor: not-allowed;
    }
  }
}

.mindmap-container {
  width: 100%;
  flex: 1;
  overflow: hidden;
  position: relative;
  background:
    radial-gradient(circle at center, rgba(255, 255, 255, 0.03), transparent 44%),
    linear-gradient(180deg, rgba(255, 255, 255, 0.015), rgba(255, 255, 255, 0));
}

.mindmap-container::before {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-image:
    linear-gradient(rgba(255, 255, 255, 0.028) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255, 255, 255, 0.028) 1px, transparent 1px);
  background-size: 28px 28px;
  mask-image: radial-gradient(circle at center, black 36%, transparent 90%);
  opacity: 0.28;
}

.mindmap-container::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: radial-gradient(circle at 50% 50%, transparent 58%, rgba(6, 10, 18, 0.45) 100%);
}

.mindmap-container :deep(.smm-node-shape) {
  filter: drop-shadow(0 14px 24px var(--shadow-color-weak));
}

.mindmap-container :deep(.smm-node.active .smm-node-shape),
.mindmap-container :deep(.smm-node:hover .smm-node-shape) {
  filter: drop-shadow(0 18px 34px var(--color-accent-border))
    drop-shadow(0 0 12px var(--color-accent-border));
}

.mindmap-container :deep(.smm-node .smm-text-node-wrap) {
  letter-spacing: 0.01em;
}

.mindmap-container :deep(.smm-hover-node) {
  stroke-width: 1.4px;
  opacity: 0.9;
}

.empty-state {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  color: var(--color-text-secondary);
  font-size: 14px;
}
</style>
