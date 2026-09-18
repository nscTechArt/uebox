<script setup lang="ts">
/**
 * 知识图谱查看器组件
 * 使用 AntV G6 渲染力导向图
 */
import { ref, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { Graph } from '@antv/g6'
import { PhArrowLeft, PhStar } from '@phosphor-icons/vue'
import type {
  KnowledgeGraphData,
  KGNode,
  EntityCategory,
  RelationType
} from '@renderer/services/knowledgeGraph/types'
import {
  CATEGORY_CONFIG,
  RELATION_CONFIG,
  categoryLabel,
  relationLabel
} from '@renderer/services/knowledgeGraph/types'

const props = defineProps<{
  /** 知识图谱数据 */
  data: KnowledgeGraphData | null
}>()

const emit = defineEmits<{
  /** 节点双击事件 - 触发 AI 对话 */
  (e: 'node-dblclick', nodeLabel: string): void
  /** 返回事件 */
  (e: 'back'): void
}>()

// locale 要单独拿出来：边上的字是 initGraph 时烘进去的，语言变了得重画（见下面的 watch）
const { t, locale } = useI18n()

/** 容器引用 */
const containerRef = ref<HTMLDivElement | null>(null)

/** G6 实例 */
let graphInstance: Graph | null = null

/** ResizeObserver 实例，用于监听容器大小变化 */
let resizeObserver: ResizeObserver | null = null

/** resize 防抖定时器 */
let resizeDebounceTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 设置 ResizeObserver 监听容器大小变化
 * 使用 debounce 优化：拖动结束后（150ms 无新变化）才执行一次 resize
 */
function setupResizeObserver(): void {
  if (!containerRef.value) return

  // 清理旧的观察器
  if (resizeObserver) {
    resizeObserver.disconnect()
  }

  resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      if (graphInstance && entry.target === containerRef.value) {
        const { width, height } = entry.contentRect
        // 只有当尺寸有效时才调整
        if (width > 0 && height > 0) {
          // 清除之前的定时器，实现 debounce 效果
          if (resizeDebounceTimer) {
            clearTimeout(resizeDebounceTimer)
          }
          // 延迟 150ms 执行，确保拖动结束后才 resize
          resizeDebounceTimer = setTimeout(() => {
            graphInstance?.resize(width, height)
            resizeDebounceTimer = null
          }, 150)
        }
      }
    }
  })

  resizeObserver.observe(containerRef.value)
}

/**
 * 获取节点颜色
 */
function getNodeColor(category: EntityCategory): string {
  return CATEGORY_CONFIG[category]?.color || '#9E9E9E'
}

/**
 * 初始化知识图谱
 */
async function initGraph(): Promise<void> {
  if (!containerRef.value || !props.data) return

  // 销毁旧实例
  if (graphInstance) {
    graphInstance.destroy()
    graphInstance = null
  }

  // 等待 DOM 更新
  await nextTick()

  const container = containerRef.value
  const width = container.offsetWidth
  const height = container.offsetHeight

  // 计算每个节点的连接数（度）
  const degreeMap = new Map<string, number>()
  props.data.edges.forEach((edge) => {
    degreeMap.set(edge.source, (degreeMap.get(edge.source) || 0) + 1)
    degreeMap.set(edge.target, (degreeMap.get(edge.target) || 0) + 1)
  })

  // 转换数据格式，添加度数信息
  const nodes = props.data.nodes.map((node: KGNode) => ({
    id: node.id,
    data: {
      label: node.label,
      category: node.category,
      description: node.description,
      degree: degreeMap.get(node.id) || 0
    }
  }))

  const edges = props.data.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    data: {
      relation: edge.relation,
      label: relationLabel(edge.relation)
    }
  }))

  // 创建 G6 实例
  graphInstance = new Graph({
    container,
    width,
    height,
    data: { nodes, edges },
    autoFit: 'view',
    layout: {
      type: 'd3-force',
      // 模拟收敛优化参数
      alphaDecay: 0.05, // 加速模拟冷却 (默认 0.0228)
      alphaMin: 0.01, // 更早结束模拟 (默认 0.001)
      velocityDecay: 0.4, // 增加速度衰减,减少振荡 (默认 0.4)
      // 链接力配置 - 增大边的理想长度
      link: {
        distance: 180,
        strength: 0.5 // 增强链接力加速稳定
      },
      // 多体力配置 - 增强节点间排斥力
      manyBody: {
        strength: -400 // 增强排斥力让节点更快分散
      },
      // 碰撞力配置 - 增大碰撞半径防止重叠
      collide: {
        radius: 90,
        strength: 1,
        iterations: 2 // 增加碰撞检测迭代次数
      },
      // 中心力配置 - 适当增加引力
      center: {
        strength: 0.05 // 略微增加以加速聚合
      }
    },
    behaviors: ['zoom-canvas', 'drag-canvas', 'drag-element-force'],
    node: {
      style: {
        // 根据节点度数动态调整大小：基础30 + 度数*5，最大60
        size: (d: { data?: { degree?: number } }) => {
          const degree = d.data?.degree || 0
          return Math.min(30 + degree * 5, 60)
        },
        fill: (d: { data?: { category?: EntityCategory } }) => {
          const color = getNodeColor(d.data?.category || 'concept')
          // 返回径向渐变填充
          return `radial-gradient(circle, ${color} 0%, ${color}88 70%, ${color}44 100%)`
        },
        stroke: (d: { data?: { category?: EntityCategory } }) => {
          const color = getNodeColor(d.data?.category || 'concept')
          return `${color}aa`
        },
        lineWidth: 2,
        shadowColor: (d: { data?: { category?: EntityCategory } }) => {
          return getNodeColor(d.data?.category || 'concept')
        },
        shadowBlur: 15,
        shadowOffsetX: 0,
        shadowOffsetY: 0,
        labelText: (d: { data?: { label?: string } }) => d.data?.label || '',
        labelFill: '#fff',
        labelFontSize: 12,
        labelPlacement: 'bottom',
        labelOffsetY: 8
      },
      // 状态样式：用于悬停聚焦效果
      state: {
        inactive: {
          fillOpacity: 0.15,
          strokeOpacity: 0.15,
          labelOpacity: 0.2,
          shadowBlur: 0
        },
        active: {
          fillOpacity: 1,
          strokeOpacity: 1,
          labelOpacity: 1
        }
      }
    },
    edge: {
      style: {
        // 根据关系类型使用不同颜色
        stroke: (d: { data?: { relation?: RelationType } }) => {
          const relation = d.data?.relation
          return relation && RELATION_CONFIG[relation]
            ? `${RELATION_CONFIG[relation].color}99`
            : 'rgba(255, 255, 255, 0.3)'
        },
        lineWidth: 1.5,
        endArrow: true,
        labelText: (d: { data?: { label?: string } }) => d.data?.label || '',
        labelFill: 'rgba(255, 255, 255, 0.7)',
        labelFontSize: 10,
        labelBackground: true,
        labelBackgroundFill: 'rgba(0, 0, 0, 0.7)',
        labelBackgroundRadius: 4,
        labelPadding: [2, 6, 2, 6]
      },
      // 状态样式：用于悬停聚焦效果
      state: {
        inactive: {
          strokeOpacity: 0.08,
          labelOpacity: 0.1
        },
        active: {
          strokeOpacity: 1,
          labelOpacity: 1,
          lineWidth: 2
        }
      }
    },
    plugins: [
      {
        type: 'tooltip',
        key: 'node-tooltip',
        enable: (event) => event.targetType === 'node',
        offsetX: 20,
        offsetY: -10,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        getContent: (_event: any, items: any[]) => {
          if (!items || items.length === 0) return ''
          const nodeData = items[0].data
          if (!nodeData) return ''

          const category = nodeData.category || 'concept'
          /*
            颜色走 `getNodeColor`，和画节点用的是同一个函数。

            图谱是模型生成的，分类名可能不在表里。这里原来自己写了一份「取不到就退回
            concept」的兜底，而画节点那边退回的是灰色 —— 同一个节点于是灰底配琥珀色
            徽章，图例里还没有它。兜底只能有一份。
          */
          const categoryColor = getNodeColor(category)
          // 分类文案走 categoryLabel()：CATEGORY_CONFIG 里已经没有 label 字段了
          const categoryText = categoryLabel(category)
          const label = nodeData.label || t('notebookKnowledgeGraphViewer.tooltip.unnamedNode')
          const description =
            nodeData.description || t('notebookKnowledgeGraphViewer.tooltip.noDescription')

          return `
            <div style="
              padding: 8px 12px;
              background: var(--color-bg-surface);
              border: none;
              border-radius: 4px;
              color: var(--color-text-primary);
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
              min-width: 180px;
              max-width: 280px;
            ">
              <div style="
                display: flex;
                align-items: center;
                gap: 8px;
                margin-bottom: 6px;
              ">
                <div style="
                  font-size: 13px;
                  font-weight: 500;
                  color: var(--color-text-primary);
                ">${label}</div>
                <div style="
                  font-size: 12px;
                  color: ${categoryColor};
                  background: ${categoryColor}20;
                  padding: 2px 6px;
                  border-radius: 3px;
                  white-space: nowrap;
                ">${categoryText}</div>
              </div>
              <div style="
                font-size: 11px;
                line-height: 1.4;
                color: var(--color-text-primary);
              ">${description}</div>
            </div>
          `
        }
      }
    ]
  })

  // 渲染图谱
  await graphInstance.render()

  // 悬停聚焦功能：延迟1秒后淡化非关联节点
  let hoverTimer: ReturnType<typeof setTimeout> | null = null
  let focusedNodeId: string | null = null

  /**
   * 获取节点的相邻节点ID集合
   */
  function getNeighborIds(nodeId: string): Set<string> {
    const neighbors = new Set<string>([nodeId])
    props.data?.edges.forEach((edge) => {
      if (edge.source === nodeId) neighbors.add(edge.target)
      if (edge.target === nodeId) neighbors.add(edge.source)
    })
    return neighbors
  }

  /**
   * 应用聚焦效果：淡化非关联元素
   */
  function applyFocusEffect(nodeId: string): void {
    if (!graphInstance) return
    focusedNodeId = nodeId
    const neighbors = getNeighborIds(nodeId)

    // 设置节点状态 - G6 v5 使用数组形式
    props.data?.nodes.forEach((node) => {
      const states = neighbors.has(node.id) ? ['active'] : ['inactive']
      graphInstance!.setElementState(node.id, states)
    })

    // 设置边状态
    props.data?.edges.forEach((edge) => {
      const isRelated = edge.source === nodeId || edge.target === nodeId
      graphInstance!.setElementState(edge.id, isRelated ? ['active'] : ['inactive'])
    })
  }

  /**
   * 清除聚焦效果：恢复所有元素
   */
  function clearFocusEffect(): void {
    if (!graphInstance || !focusedNodeId) return
    focusedNodeId = null

    // 恢复所有节点和边的状态 - 清空状态数组
    props.data?.nodes.forEach((node) => {
      graphInstance!.setElementState(node.id, [])
    })
    props.data?.edges.forEach((edge) => {
      graphInstance!.setElementState(edge.id, [])
    })
  }

  // 节点悬停事件 - 延迟1秒触发聚焦
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  graphInstance.on('node:mouseenter', (evt: any) => {
    // G6 v5 中使用 itemId 获取节点 ID
    const nodeId = evt.itemId || evt.target?.id
    console.log('[KG] mouseenter nodeId:', nodeId, evt)
    if (!nodeId) return

    // 清除之前的计时器
    if (hoverTimer) clearTimeout(hoverTimer)

    // 延迟1秒后应用聚焦效果
    hoverTimer = setTimeout(() => {
      console.log('[KG] applying focus effect for:', nodeId)
      applyFocusEffect(nodeId)
    }, 1000)
  })

  // 节点离开事件 - 清除聚焦
  graphInstance.on('node:mouseleave', () => {
    console.log('[KG] mouseleave')
    if (hoverTimer) {
      clearTimeout(hoverTimer)
      hoverTimer = null
    }
    clearFocusEffect()
  })

  // 绑定双击事件
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  graphInstance.on('node:dblclick', (evt: any) => {
    const nodeId = evt.target?.id
    if (!nodeId) return
    const node = props.data?.nodes.find((n) => n.id === nodeId)
    if (node) {
      emit('node-dblclick', node.label)
    }
  })

  // 设置 ResizeObserver 监听容器大小变化
  setupResizeObserver()
}

// 数据变化时重新渲染
watch(
  () => props.data,
  () => {
    if (props.data) {
      initGraph()
    }
  },
  { deep: true }
)

/*
 * 语言变了也要重画。
 *
 * 边上的字是 `initGraph()` 里一次性烘进图数据的（`relationLabel(edge.relation)`），
 * 不像节点提示那样每次渲染现查。所以用户在设置里切了语言、切回来，整张图的
 * 连线仍是旧语言，直到数据变或者视图重挂。
 */
watch(locale, () => {
  if (props.data) {
    initGraph()
  }
})

onMounted(() => {
  if (props.data) {
    initGraph()
  }
})

onBeforeUnmount(() => {
  // 清理 resize 防抖定时器
  if (resizeDebounceTimer) {
    clearTimeout(resizeDebounceTimer)
    resizeDebounceTimer = null
  }
  // 清理 ResizeObserver
  if (resizeObserver) {
    resizeObserver.disconnect()
    resizeObserver = null
  }
  // 销毁 G6 实例
  if (graphInstance) {
    graphInstance.destroy()
    graphInstance = null
  }
})
</script>

<template>
  <div class="knowledge-graph-viewer">
    <!-- 头部 -->
    <div class="viewer-header">
      <div class="header-row">
        <div class="header-left">
          <button class="back-btn" @click="emit('back')">
            <PhArrowLeft />
          </button>
          <div class="header-info">
            <div class="type-badge">
              <PhStar />
              <span>{{ t('notebookKnowledgeGraphViewer.title') }}</span>
            </div>
            <h2 class="title">{{ t('notebookKnowledgeGraphViewer.title') }}</h2>
          </div>
        </div>
      </div>
      <!-- 图例 - 移到标题下方 -->
      <div class="legend">
        <span v-for="(config, key) in CATEGORY_CONFIG" :key="key" class="legend-item">
          <span class="legend-dot" :style="{ background: config.color }"></span>
          <span class="legend-label">{{ categoryLabel(key) }}</span>
        </span>
      </div>
    </div>

    <div ref="containerRef" class="graph-container"></div>
    <div v-if="!data" class="empty-state">
      <span>{{ t('notebookKnowledgeGraphViewer.emptyState') }}</span>
    </div>
  </div>
</template>

<style scoped lang="less">
.knowledge-graph-viewer {
  width: 100%;
  height: 100%;
  position: relative;
  background: var(--color-bg-surface-hover);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.viewer-header {
  display: flex;
  flex-direction: column;
  padding: 16px 24px 12px;
  backdrop-filter: blur(10px);
  border-bottom: 1px solid var(--color-border-subtle);
  z-index: 10;
  flex-shrink: 0;
  gap: 12px;

  .header-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

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
        background: var(--color-bg-surface-hover);
        padding: 2px 8px;
        border-radius: 4px;
        width: fit-content;
      }

      .title {
        font-size: 16px;
        font-weight: 500;
        color: var(--color-text-primary);
        margin: 0;
        line-height: 1.2;
      }
    }
  }

  .legend {
    display: flex;
    gap: 10px 16px;
    flex-wrap: wrap;
    padding-left: 52px; // 与标题对齐 (返回按钮36px + gap 16px)

    .legend-item {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      color: var(--color-text-primary);

      .legend-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
      }
    }
  }
}

.graph-container {
  width: 100%;
  flex: 1;
  overflow: hidden;
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
