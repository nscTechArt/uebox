<template>
  <div class="asset-dependency-graph">
    <div ref="networkContainer" class="network-container"></div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch, nextTick, onActivated, computed } from 'vue'
import { Network, Options } from 'vis-network'
import type { IdType } from 'vis-network'
import { DataSet } from 'vis-data'
import { buildThumbnailUrl } from '@renderer/utils/thumbnails'
import { toLocalResourceUrl } from '@renderer/utils/localResource'
import { useVaultStore } from '@renderer/store/modules/vaultStore'
import { useI18n } from 'vue-i18n'
import type { DependencyEdgeKind, DependencyNodeKind } from '@core/shared/assetDependency'

// 导入UE图标资源
import iconAi from '@renderer/assets/imgs/ue/ue-item-ai.png'
import iconAnimation from '@renderer/assets/imgs/ue/ue-item-animation.png'
import iconBlueprint from '@renderer/assets/imgs/ue/ue-item-blueprint.png'
import iconDefault from '@renderer/assets/imgs/ue/ue-item-default.png'
import iconMaterial from '@renderer/assets/imgs/ue/ue-item-material.png'
import iconMetasound from '@renderer/assets/imgs/ue/ue-item-metasound.png'
import iconNiagara from '@renderer/assets/imgs/ue/ue-item-niagara.png'
import iconPcg from '@renderer/assets/imgs/ue/ue-item-pcg.png'
import iconWeight from '@renderer/assets/imgs/ue/ue-item-weight.png'

// 主进程只给语义字段，颜色和文案都在这一层决定 —— 它既不知道用户开的是
// 深色还是浅色主题，也不知道界面语言
interface DependencyNode {
  id: string
  label: string
  kind?: DependencyNodeKind
  className?: string
  classNameCn?: string
  softPath?: string
  imgLocalPath?: string
  customPoster?: string
  assetKey?: string
  level?: number
  isRoot?: boolean
  isMissing?: boolean
  x?: number
  y?: number
}

interface DependencyEdge {
  from: string
  to: string
  kind?: DependencyEdgeKind
  arrows?: string
  dashes?: boolean
}

/**
 * vis-network 要的是具体色值，给不了 CSS 变量，所以每次重建数据时把用到的
 * token 读成实际颜色。换主题会走 watch 重建，这里跟着重算。
 */
const readToken = (name: string, fallback: string): string => {
  if (typeof window === 'undefined') return fallback
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

const resolveGraphColors = (): {
  missing: string
  root: string
  nodeBorder: string
  dependsOn: string
  referencedBy: string
  highlight: string
} => ({
  missing: readToken('--color-warning-solid', '#EF4444'),
  root: readToken('--color-accent-solid', '#22D3EE'),
  nodeBorder: readToken('--color-border-subtle', 'rgba(255,255,255,0.1)'),
  // 「它引用的」和「引用它的」用两种颜色分开，方向一眼看得出
  dependsOn: readToken('--color-accent-solid', '#22D3EE'),
  referencedBy: readToken('--color-warning-solid', '#F59E0B'),
  highlight: readToken('--color-accent-text', '#67E8F9')
})

interface Props {
  nodes: DependencyNode[]
  edges: DependencyEdge[]
  rootAssetKey?: string
  showLabels?: boolean
  showThumbnails?: boolean
  enableCollision?: boolean
}

const props = defineProps<Props>()
const emit = defineEmits<{
  nodeHover: [node: DependencyNode | null]
  nodeDoubleClick: [node: DependencyNode]
  nodeClick: [node: DependencyNode | null]
}>()

const vaultStore = useVaultStore()
const currentVault = computed(() => vaultStore.currentVault)
const { t } = useI18n()

const networkContainer = ref<HTMLElement | null>(null)
let network: Network | null = null
let nodesDataSet: DataSet<any> | null = null
let edgesDataSet: DataSet<any> | null = null
let rightDragStart = { x: 0, y: 0 }
let rightViewStart = { x: 0, y: 0 }
let registeredContainerEl: HTMLElement | null = null
const isRightDragging = ref(false)

const handleContextMenu = (event: MouseEvent) => {
  if (networkContainer.value && networkContainer.value.contains(event.target as Node)) {
    event.preventDefault()
  }
}

const handleRightMouseDown = (event: MouseEvent) => {
  if (event.button !== 2 || !network) return
  event.preventDefault()

  isRightDragging.value = true
  rightDragStart = { x: event.clientX, y: event.clientY }
  const viewPos = network.getViewPosition()
  rightViewStart = { x: viewPos.x, y: viewPos.y }
}

const handleRightMouseMove = (event: MouseEvent) => {
  if (!isRightDragging.value || !network) return

  const scale = network.getScale()
  const dx = (event.clientX - rightDragStart.x) / scale
  const dy = (event.clientY - rightDragStart.y) / scale

  network.moveTo({
    position: {
      x: rightViewStart.x - dx,
      y: rightViewStart.y - dy
    },
    scale,
    animation: false
  })
}

const handleRightMouseUp = (event: MouseEvent) => {
  if (!isRightDragging.value) return
  if (event.button === 2 || event.buttons === 0) {
    isRightDragging.value = false
  }
}

const registerRightDragEvents = () => {
  if (!networkContainer.value || registeredContainerEl) return

  registeredContainerEl = networkContainer.value
  registeredContainerEl.addEventListener('contextmenu', handleContextMenu)
  registeredContainerEl.addEventListener('mousedown', handleRightMouseDown)
  window.addEventListener('mousemove', handleRightMouseMove)
  window.addEventListener('mouseup', handleRightMouseUp)
}

const unregisterRightDragEvents = () => {
  if (!registeredContainerEl) return

  registeredContainerEl.removeEventListener('contextmenu', handleContextMenu)
  registeredContainerEl.removeEventListener('mousedown', handleRightMouseDown)
  window.removeEventListener('mousemove', handleRightMouseMove)
  window.removeEventListener('mouseup', handleRightMouseUp)
  registeredContainerEl = null
}

// UE 风格颜色映射
const getAssetTypeColor = (type: string): string => {
  const colors: Record<string, string> = {
    Material: '#00A651',
    MaterialInstanceConstant: '#00A651',
    Texture2D: '#B73C39',
    Texture: '#B73C39',
    Blueprint: '#3A7CD8',
    BlueprintGeneratedClass: '#3A7CD8',
    StaticMesh: '#00A4A6',
    SkeletalMesh: '#CF55A7',
    Skeleton: '#CF55A7',
    Animation: '#557967',
    AnimSequence: '#557967',
    SoundWave: '#2A9393',
    SoundCue: '#2A9393',
    Level: '#FF7F00',
    World: '#FF7F00',
    ParticleSystem: '#12B0E2',
    NiagaraSystem: '#12B0E2'
  }

  // 模糊匹配
  for (const key in colors) {
    if (type && type.includes(key)) {
      return colors[key]
    }
  }
  return '#555555' // 默认灰色
}

// 加载图片辅助函数
const loadImage = (url: string): Promise<HTMLImageElement> => {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'Anonymous'
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = url
  })
}

// 获取资产类型对应的图标
const getAssetTypeIcon = (type: string): string => {
  if (!type) return iconDefault

  const lowerType = type.toLowerCase()

  if (lowerType.includes('material')) return iconMaterial
  if (lowerType.includes('texture')) return iconDefault // 纹理通常显示自身预览，如果没有则使用默认
  if (lowerType.includes('blueprint')) return iconBlueprint
  if (
    lowerType.includes('animation') ||
    lowerType.includes('animsequence') ||
    lowerType.includes('skeleton')
  )
    return iconAnimation
  if (lowerType.includes('sound') || lowerType.includes('audio') || lowerType.includes('metasound'))
    return iconMetasound
  if (lowerType.includes('particle') || lowerType.includes('niagara')) return iconNiagara
  if (
    lowerType.includes('ai') ||
    lowerType.includes('behavior') ||
    lowerType.includes('blackboard')
  )
    return iconAi
  if (lowerType.includes('pcg')) return iconPcg
  if (lowerType.includes('weight')) return iconWeight

  return iconDefault
}

// 生成圆角矩形路径
const roundRect = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number | { tl: number; tr: number; br: number; bl: number }
) => {
  ctx.beginPath()
  let radius = typeof r === 'number' ? { tl: r, tr: r, br: r, bl: r } : r
  ctx.moveTo(x + radius.tl, y)
  ctx.lineTo(x + w - radius.tr, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius.tr)
  ctx.lineTo(x + w, y + h - radius.br)
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius.br, y + h)
  ctx.lineTo(x + radius.bl, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius.bl)
  ctx.lineTo(x, y + radius.tl)
  ctx.quadraticCurveTo(x, y, x + radius.tl, y)
  ctx.closePath()
}

// 生成节点图片
const generateNodeImage = async (node: DependencyNode, thumbnailUrl?: string): Promise<string> => {
  const minimalMode = props.showThumbnails === false

  const width = 136
  // 如果是极简模式，高度仅保留 Header 部分 (46px)，否则为完整高度 (182px)
  const height = minimalMode ? 46 : 182
  const headerHeight = 46 // 增加头部高度以容纳两行文字
  const radius = 8

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''

  const typeColor = getAssetTypeColor(node.className || 'Default')
  const isMissing = node.isMissing
  const palette = resolveGraphColors()

  // 1. 绘制背景（主体）
  // 卡片本体固定深色：节点上要压缩略图，浅底压不住图。整张卡跟随主题是另一件
  // 更大的事，这里只把「缺失」这种语义色换成 token
  ctx.fillStyle = '#1B1B1B'
  ctx.strokeStyle = isMissing ? palette.missing : 'rgba(255,255,255,0.1)'
  ctx.lineWidth = isMissing ? 2 : 1
  roundRect(ctx, 0, 0, width, height, radius)
  ctx.fill()
  ctx.stroke()

  // 2. 绘制标题栏背景
  // 在极简模式下，背景就是标题栏，所以不需要单独绘制
  // 但为了保持样式一致，如果不是极简模式或者需要特殊高亮，可以绘制
  ctx.fillStyle = isMissing ? palette.missing : typeColor
  // 如果是极简模式，四个角都是圆角；否则只有上面两个角是圆角
  const headerRadius = minimalMode ? radius : { tl: radius, tr: radius, br: 0, bl: 0 }
  roundRect(ctx, 0, 0, width, headerHeight, headerRadius)
  ctx.fill()

  // 3. 绘制标题栏高光（可选，增加立体感）
  const grad = ctx.createLinearGradient(0, 0, 0, headerHeight)
  grad.addColorStop(0, 'rgba(255,255,255,0.2)')
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = grad
  roundRect(ctx, 0, 0, width, headerHeight, headerRadius)
  ctx.fill()

  // 4. 绘制文字
  // 资产名称
  ctx.font = 'bold 13px Arial'
  ctx.fillStyle = '#FFFFFF'
  ctx.textBaseline = 'top'
  const name = node.label || t('assetDependencyGraphPage.messages.unknownAsset')
  // 简单的文本截断
  let displayName = name
  if (ctx.measureText(displayName).width > width - 20) {
    while (ctx.measureText(displayName + '...').width > width - 20 && displayName.length > 0) {
      displayName = displayName.slice(0, -1)
    }
    displayName += '...'
  }
  ctx.fillText(displayName, 10, 8)

  // 资产类型（副标题）
  ctx.font = 'italic 11px Arial'
  ctx.fillStyle = 'rgba(255,255,255,0.8)'
  // 缺失节点没有类名，副标题直接说「缺失的引用」，别退化成泛泛的 Asset
  const typeName = isMissing
    ? t('assetDependencyGraphPage.messages.missingReference')
    : node.classNameCn || node.className || t('assetDependencyGraphPage.header.defaultAssetType')
  let displayType = typeName
  if (ctx.measureText(displayType).width > width - 20) {
    while (ctx.measureText(displayType + '...').width > width - 20 && displayType.length > 0) {
      displayType = displayType.slice(0, -1)
    }
    displayType += '...'
  }
  ctx.fillText(displayType, 10, 26)

  // 如果是极简模式，直接返回
  if (minimalMode) {
    return canvas.toDataURL()
  }

  // 5. 绘制缩略图区域
  // 移除边距，使缩略图占满下半部分
  const thumbY = headerHeight
  const thumbW = width
  const thumbH = height - headerHeight

  // 创建缩略图区域的剪切路径（底部圆角）
  ctx.save()
  ctx.beginPath()
  roundRect(ctx, 0, thumbY, thumbW, thumbH, { tl: 0, tr: 0, br: radius, bl: radius })
  ctx.clip()

  // 缩略图背景
  ctx.fillStyle = '#000000'
  ctx.fillRect(0, thumbY, thumbW, thumbH)

  // 绘制缩略图
  if (thumbnailUrl) {
    try {
      const img = await loadImage(thumbnailUrl)

      // 计算 cover 效果
      const imgRatio = img.width / img.height
      const canvasRatio = thumbW / thumbH
      let drawW, drawH, drawX, drawY

      if (imgRatio > canvasRatio) {
        drawH = thumbH
        drawW = thumbH * imgRatio
        drawY = thumbY
        drawX = (thumbW - drawW) / 2
      } else {
        drawW = thumbW
        drawH = thumbW / imgRatio
        drawX = 0
        drawY = thumbY + (thumbH - drawH) / 2
      }

      ctx.drawImage(img, drawX, drawY, drawW, drawH)
    } catch (e) {
      // 图片加载失败，使用类型图标作为回退
      try {
        const iconUrl = getAssetTypeIcon(node.className || '')
        const icon = await loadImage(iconUrl)

        // 占满显示（可能会有裁剪，但更美观）
        ctx.drawImage(icon, 0, thumbY, thumbW, thumbH)
      } catch (iconErr) {
        // 图标也加载失败，显示占位文本
        ctx.font = '10px Arial'
        ctx.fillStyle = '#666'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText('No Preview', width / 2, thumbY + thumbH / 2)
      }
    }
  } else {
    // 无缩略图，显示类型图标
    try {
      const iconUrl = getAssetTypeIcon(node.className || '')
      const icon = await loadImage(iconUrl)

      // 占满显示
      ctx.drawImage(icon, 0, thumbY, thumbW, thumbH)
    } catch (e) {
      // 图标加载失败，显示类型首字母
      ctx.font = 'bold 40px Arial'
      ctx.fillStyle = '#333'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(typeName.charAt(0).toUpperCase(), width / 2, thumbY + thumbH / 2)
    }
  }

  // 恢复剪切状态
  ctx.restore()

  // 绘制分割线（Header 和 Body 之间）
  ctx.strokeStyle = 'rgba(255,255,255,0.1)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(0, headerHeight)
  ctx.lineTo(width, headerHeight)
  ctx.stroke()

  return canvas.toDataURL()
}

// 获取节点缩略图URL
const getNodeThumbnailUrl = (node: DependencyNode): string | undefined => {
  // 获取 vault 信息
  const vault = currentVault.value
  const isNetwork = vault?.vaultType === 'network'
  const vaultPath = isNetwork ? vault?.networkPath : vault?.path

  // 🔧 修复：customPoster 和 imgLocalPath 都可能只是文件名，需要构建完整 URL
  // customPoster 优先级更高
  const thumbnailFilename = node.customPoster || node.imgLocalPath
  if (thumbnailFilename) {
    // 检查是否已经是完整的 URL（以 file:// 或 http 开头）
    if (thumbnailFilename.startsWith('file://') || thumbnailFilename.startsWith('http')) {
      console.log('[DependencyGraph] 使用完整URL:', thumbnailFilename)
      return toLocalResourceUrl(thumbnailFilename)
    }
    // 否则使用 buildThumbnailUrl 构建完整路径
    const url = buildThumbnailUrl(vaultPath, thumbnailFilename, isNetwork)
    console.log('[DependencyGraph] 构建缩略图URL:', {
      nodeLabel: node.label,
      thumbnailFilename,
      vaultPath,
      isNetwork,
      resultUrl: url
    })
    return url
  }
  return undefined
}

// 已移除未使用的 createNodeHTML 函数，避免类型检查告警

// 获取去重后的节点映射表
const getNodeMap = (): Map<string, DependencyNode> => {
  const nodeMap = new Map<string, DependencyNode>()

  // 遍历所有节点，如果遇到重复 ID，保留第一个出现的节点
  props.nodes.forEach((node) => {
    if (!nodeMap.has(node.id)) {
      nodeMap.set(node.id, node)
    } else {
      // 如果遇到重复 ID，可以选择保留更重要的节点（例如 isRoot 或 level 更小的）
      const existingNode = nodeMap.get(node.id)!
      if (
        node.isRoot ||
        (node.level !== undefined &&
          (existingNode.level === undefined || node.level < existingNode.level))
      ) {
        nodeMap.set(node.id, node)
      }
    }
  })

  return nodeMap
}

// 准备节点数据
const prepareNodes = async () => {
  console.log('[DependencyGraph] ====== prepareNodes 开始 ======')
  const nodeMap = getNodeMap()
  const palette = resolveGraphColors()
  console.log('[DependencyGraph] 节点数量:', nodeMap.size)

  // 将去重后的节点转换为 vis-network 格式
  const promises = Array.from(nodeMap.values()).map(async (node) => {
    const isRoot = node.isRoot || node.level === 0
    const isMissing = node.isMissing || false
    console.log('[DependencyGraph] 处理节点:', node.label, {
      customPoster: node.customPoster,
      imgLocalPath: node.imgLocalPath
    })
    const thumbnailUrl = getNodeThumbnailUrl(node)
    console.log('[DependencyGraph] 节点缩略图URL:', node.label, thumbnailUrl)

    // 生成基础图片（先不带缩略图，快速显示）
    const baseImage = await generateNodeImage(node, undefined)

    // 如果有缩略图且允许显示，启动异步任务更新节点图片
    if (thumbnailUrl && props.showThumbnails !== false) {
      generateNodeImage(node, thumbnailUrl)
        .then((fullImage) => {
          if (nodesDataSet) {
            nodesDataSet.update({ id: node.id, image: fullImage })
          }
        })
        .catch(() => {
          // 加载失败，保持基础图片
        })
    }

    return {
      id: node.id,
      label: '', // 清空标签，因为已绘制在图片中
      shape: 'image',
      image: baseImage,
      shapeProperties: {
        useImageSize: true // 使用生成图片的原始尺寸 (220x180)
      },
      // 颜色配置（仅用于边框高亮等，大部分已在 Canvas 中绘制）
      color: {
        border: isRoot ? palette.root : isMissing ? palette.missing : palette.nodeBorder,
        background: 'rgba(0,0,0,0)', // 背景透明，因为图片自带背景
        highlight: {
          border: palette.root,
          background: 'rgba(0,0,0,0)'
        }
      },
      borderWidth: 2,
      borderWidthSelected: 4,
      // 阴影
      shadow: {
        enabled: true,
        color: 'rgba(0,0,0,0.5)',
        size: 10,
        x: 5,
        y: 5
      },
      // 自定义数据
      nodeData: node,
      // 不设置固定位置，让物理引擎自动布局
      // 只在有明确层级信息时设置大致位置
      ...(node.level !== undefined && node.level !== null
        ? {
            // 根据层级设置大致位置，但让物理引擎微调
            x: node.level === 0 ? 0 : (node.level > 0 ? 400 : -400) + (Math.random() * 100 - 50),
            y: Math.random() * 300 - 150
          }
        : {})
    }
  })

  return Promise.all(promises)
}

// 准备边数据
const prepareEdges = () => {
  const palette = resolveGraphColors()

  // 这段区分「依赖」和「引用」的配色以前是写好了但从来没生效过 ——
  // 主进程每条边都带一个 color，下面原本是 `edge.color || {…}`，
  // 于是永远走主进程那个灰色。现在主进程只给 kind，这里才真的说了算。
  return props.edges.map((edge) => {
    const edgeColor =
      edge.kind === 'missing'
        ? palette.missing
        : edge.kind === 'referenced-by'
          ? palette.referencedBy
          : palette.dependsOn
    const highlightColor = edge.kind === 'missing' ? palette.missing : palette.highlight

    return {
      from: edge.from,
      to: edge.to,
      arrows: {
        to: {
          enabled: true,
          scaleFactor: 1.2,
          type: 'arrow'
        }
      },
      color: {
        color: edgeColor,
        highlight: highlightColor,
        hover: highlightColor
      },
      width: 2,
      smooth: {
        enabled: true,
        type: 'cubicBezier',
        roundness: 0.5
      },
      dashes: edge.dashes || false
    }
  })
}

const initNetwork = async () => {
  if (!networkContainer.value) return

  const nodesData = await prepareNodes()
  nodesDataSet = new DataSet<any>(nodesData)
  edgesDataSet = new DataSet<any>(prepareEdges() as any[])
  const data = { nodes: nodesDataSet, edges: edgesDataSet }

  // 配置选项
  const options: Options = {
    nodes: {
      shape: 'image',
      font: {
        color: '#FFFFFF',
        size: 12,
        face: 'Arial',
        multi: false,
        align: 'left'
      },
      borderWidth: 2,
      shadow: {
        enabled: true,
        color: 'rgba(0,0,0,0.5)',
        size: 10,
        x: 5,
        y: 5
      }
    },
    edges: {
      arrows: {
        to: {
          enabled: true,
          scaleFactor: 1.2,
          type: 'arrow'
        }
      },
      color: {
        color: 'rgba(255,255,255,0.6)',
        highlight: '#22D3EE',
        hover: '#22D3EE'
      },
      width: 2,
      smooth: {
        enabled: true,
        type: 'cubicBezier',
        roundness: 0.5
      }
    },
    physics: {
      enabled: true,
      stabilization: {
        enabled: true,
        iterations: 500,
        updateInterval: 25,
        onlyDynamicEdges: false,
        fit: true
      },
      barnesHut: {
        gravitationalConstant: -3000, // 增加斥力
        centralGravity: 0.01, // 减小中心引力
        springLength: 200, // 增加弹簧长度，因为节点变大了
        springConstant: 0.05,
        damping: 0.3,
        avoidOverlap: props.enableCollision !== false ? 1 : 0
      }
    },
    interaction: {
      dragNodes: true,
      dragView: false,
      zoomView: true,
      hover: true,
      tooltipDelay: 100,
      selectConnectedEdges: true,
      hideEdgesOnDrag: false,
      hideEdgesOnZoom: false
    },
    layout: {
      improvedLayout: true
    }
  }

  // 创建网络图
  network = new Network(networkContainer.value, data, options)
  registerRightDragEvents()

  // 拖拽开始和结束事件处理
  let dragEndTimeout: number | null = null
  let isDragging = false

  network.on('dragStart', () => {
    isDragging = true
    // 拖拽开始时，优化性能
    if (network) {
      const performanceOptions: any = {
        physics: {
          enabled: false
        },
        nodes: {
          shadow: {
            enabled: false
          }
        },
        edges: {
          smooth: {
            enabled: true,
            type: 'straightCross',
            roundness: 0
          },
          width: 1.5,
          arrows: {
            to: {
              enabled: true,
              scaleFactor: 0.8,
              type: 'arrow'
            }
          }
        },
        interaction: {
          hover: false
        }
      }
      network.setOptions(performanceOptions)
    }
  })

  network.on('dragEnd', () => {
    isDragging = false
    if (dragEndTimeout) {
      clearTimeout(dragEndTimeout)
    }

    dragEndTimeout = window.setTimeout(() => {
      if (network && !isDragging) {
        const restoreOptions: any = {
          nodes: {
            shadow: {
              enabled: true
            }
          },
          edges: {
            smooth: {
              enabled: true,
              type: 'cubicBezier',
              roundness: 0.5
            },
            width: 2,
            arrows: {
              to: {
                enabled: true,
                scaleFactor: 1.2,
                type: 'arrow'
              }
            }
          },
          interaction: {
            hover: true
          }
        }

        if (props.enableCollision) {
          restoreOptions.physics = { enabled: true }
          network.once('stabilized', () => {
            if (network && !isDragging) {
              network.setOptions({
                physics: {
                  enabled: false
                }
              })
            }
          })
        }

        network.setOptions(restoreOptions)
      }
    }, 300)
  })

  // 事件监听
  network.on('click', (params) => {
    if (params.nodes.length > 0) {
      const nodeId = params.nodes[0]
      const node = props.nodes.find((n) => n.id === nodeId)
      if (node) {
        console.log('点击节点:', node)
        emit('nodeClick', node)
      }
    } else {
      emit('nodeClick', null)
    }
  })

  // 双击事件
  network.on('doubleClick', (params) => {
    if (params.nodes.length > 0) {
      const nodeId = params.nodes[0]
      const node = props.nodes.find((n) => n.id === nodeId)
      if (node && !node.isRoot) {
        emit('nodeDoubleClick', node)
      }
    }
  })

  // 鼠标悬停
  let hoverTimeout: number | null = null
  network.on('hoverNode', (params) => {
    if (networkContainer.value) {
      networkContainer.value.style.cursor = 'pointer'
    }

    if (params.node) {
      const connectedEdges = network?.getConnectedEdges(params.node) || []
      connectedEdges.forEach((edgeId: IdType) => {
        network?.updateEdge(edgeId, { color: { color: '#22D3EE' } })
      })
    }

    if (hoverTimeout) clearTimeout(hoverTimeout)
    hoverTimeout = window.setTimeout(() => {
      const nodeId = params.node
      const node = props.nodes.find((n) => n.id === nodeId)
      emit('nodeHover', node || null)
    }, 100)
  })

  network.on('blurNode', () => {
    if (networkContainer.value) {
      networkContainer.value.style.cursor = 'default'
    }

    if (hoverTimeout) {
      clearTimeout(hoverTimeout)
      hoverTimeout = null
    }
    emit('nodeHover', null)

    if (edgesDataSet) {
      const allEdges = edgesDataSet.get()
      allEdges.forEach((edge: any) => {
        if (edge.id && network) {
          network.updateEdge(edge.id, { color: { color: 'rgba(255,255,255,0.2)' } })
        }
      })
    }
  })

  network.once('stabilized', () => {
    if (network) {
      network.setOptions({
        physics: {
          enabled: false
        }
      })
      network.fit({
        animation: {
          duration: 500,
          easingFunction: 'easeInOutQuad'
        }
      })
    }
  })

  setTimeout(() => {
    if (network) {
      network.setOptions({
        physics: {
          enabled: false
        }
      })
      network.fit({
        animation: {
          duration: 500,
          easingFunction: 'easeInOutQuad'
        }
      })
    }
  }, 2000)
}

const updateNetwork = async () => {
  if (!network || !networkContainer.value) return

  const nodesData = await prepareNodes()
  nodesDataSet = new DataSet<any>(nodesData)
  edgesDataSet = new DataSet<any>(prepareEdges() as any[])

  network.setOptions({
    physics: {
      enabled: true,
      stabilization: {
        enabled: true,
        iterations: 500,
        updateInterval: 25,
        onlyDynamicEdges: false,
        fit: true
      },
      barnesHut: {
        gravitationalConstant: -3000,
        centralGravity: 0.01,
        springLength: 200,
        springConstant: 0.05,
        damping: 0.3,
        avoidOverlap: props.enableCollision !== false ? 1 : 0
      }
    }
  })

  network.setData({ nodes: nodesDataSet, edges: edgesDataSet })

  network.once('stabilized', () => {
    if (network) {
      network.setOptions({
        physics: {
          enabled: false
        }
      })
      network.fit({
        animation: {
          duration: 500,
          easingFunction: 'easeInOutQuad'
        }
      })
    }
  })

  setTimeout(() => {
    if (network) {
      network.setOptions({
        physics: {
          enabled: false
        }
      })
      network.fit({
        animation: {
          duration: 500,
          easingFunction: 'easeInOutQuad'
        }
      })
    }
  }, 2000)
}

watch(
  () => [props.nodes, props.edges, props.showLabels, props.showThumbnails, props.enableCollision],
  () => {
    nextTick(() => {
      if (network) {
        updateNetwork()
      } else {
        initNetwork()
      }
    })
  },
  { deep: true }
)

// 处理窗口大小变化
const handleResize = () => {
  if (network && networkContainer.value) {
    network.redraw()
  }
}

onMounted(() => {
  nextTick(() => {
    initNetwork()
    window.addEventListener('resize', handleResize)
  })
})

onActivated(() => {
  nextTick(() => {
    if (network && networkContainer.value) {
      network.fit({
        animation: false
      })
    }
  })
})

// 聚焦到指定节点
const focusNode = (nodeId: string) => {
  if (network && nodeId) {
    network.focus(nodeId, {
      scale: 1.5,
      animation: {
        duration: 1000,
        easingFunction: 'easeInOutQuad'
      }
    })

    // 选中该节点
    network.selectNodes([nodeId])

    // 触发点击事件，更新父组件的选中状态
    const node = props.nodes.find((n) => n.id === nodeId)
    if (node) {
      emit('nodeClick', node)
    }
  }
}

// 重置视图
const resetView = () => {
  if (network) {
    network.fit({
      animation: {
        duration: 500,
        easingFunction: 'easeInOutQuad'
      }
    })
  }
}

// 暴露方法给父组件
defineExpose({
  focusNode,
  resetView
})

onUnmounted(() => {
  window.removeEventListener('resize', handleResize)
  unregisterRightDragEvents()
  if (network) {
    network.destroy()
    network = null
  }
})
</script>

<style lang="less" scoped>
.asset-dependency-graph {
  width: 100%;
  height: 100%;
  min-height: 600px;
  // background: var(--color-bg-surface);
  border-radius: 6px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  position: relative;

  // 点阵网格背景
  &::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background-image: radial-gradient(circle, rgba(255, 255, 255, 0.1) 1px, transparent 1px);
    background-size: 20px 20px;
    background-position: 0 0;
    pointer-events: none;
    z-index: 0;
    opacity: 0.3;
  }

  .network-container {
    width: 100%;
    height: 100%;
    flex: 1;
    min-height: 600px;
    position: relative;
    z-index: 1;
    // 磨砂玻璃效果
    backdrop-filter: blur(20px);
  }
}

// 自定义节点样式（通过全局样式注入）
:deep(.custom-node) {
  transition: all 0.2s ease;

  &:hover {
    transform: scale(1.05);
    box-shadow: 0 4px 12px var(--color-accent-border) !important;
  }
}
</style>
