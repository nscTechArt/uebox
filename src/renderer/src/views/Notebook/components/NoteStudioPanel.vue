<script setup lang="ts">
import AppDropdown from '@renderer/components/AppDropdown.vue'
import AppMenu from '@renderer/components/AppMenu.vue'
import AppMenuItem from '@renderer/components/AppMenuItem.vue'
import { ref, reactive, onBeforeUnmount, onMounted, computed, inject } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  PhBookmarkSimple,
  PhCaretDown,
  PhChartBar,
  PhDotsThree,
  PhFileText,
  PhGlobe,
  PhMicrophoneStage,
  PhGraph,
  PhLightbulb,
  PhPencilSimple,
  PhTrash,
  PhTreeStructure,
  PhVideoCamera
} from '@phosphor-icons/vue'
import { message } from '@renderer/utils/messageManager'
import type { SourceItem } from '@renderer/store/modules/notebookStore'
import type { ChatMessage } from '@renderer/store/modules/chatMessages'
import { createMindmapService, type MindmapNode } from '@renderer/services/mindmap'
import { createReportGenerationService } from '@renderer/services/reportGeneration'
import {
  createKnowledgeGraphService,
  type KnowledgeGraphData
} from '@renderer/services/knowledgeGraph'
import { useStudioOutputStore, type StudioOutput } from '@renderer/store/modules/studioOutputStore'
import { useNotebookStore } from '@renderer/store/modules/notebookStore'
import {
  canSaveOutputAsSource,
  studioOutputToMarkdown
} from '@renderer/services/notebook/studioOutputToMarkdown'
import { formatErrorMessage } from '@renderer/utils/errorMessage'

/**
 * notebookStore 实例（用于获取选中的来源）
 */
const nbStore = useNotebookStore()

type WorkbenchSerialTaskType = Extract<
  StudioOutput['type'],
  'mindmap' | 'report' | 'knowledgeGraph' | 'interview' | 'webpage' | 'brainstorm'
>

const serialWorkbenchTaskTypes: WorkbenchSerialTaskType[] = [
  'mindmap',
  'report',
  'knowledgeGraph',
  'interview',
  'webpage',
  'brainstorm'
]

const serialWorkbenchTaskTypeSet = new Set<WorkbenchSerialTaskType>(serialWorkbenchTaskTypes)
const WORKBENCH_SUBMIT_COOLDOWN_MS = 3000
const submittingWorkbenchTaskType = ref<WorkbenchSerialTaskType | null>(null)
const queuedWorkbenchTaskCounts = reactive<Partial<Record<WorkbenchSerialTaskType, number>>>({})
let nextWorkbenchSubmitAt = 0
let workbenchTaskSubmissionChain: Promise<void> = Promise.resolve()

function isSerialWorkbenchTaskType(type: string): type is WorkbenchSerialTaskType {
  return serialWorkbenchTaskTypeSet.has(type as WorkbenchSerialTaskType)
}

function getWorkbenchTaskLabel(type: WorkbenchSerialTaskType): string {
  const labelMap: Record<WorkbenchSerialTaskType, string> = {
    mindmap: '思维导图',
    report: '研究报告',
    knowledgeGraph: '知识图谱',
    interview: '模拟面试',
    webpage: '网页',
    brainstorm: '头脑风暴'
  }
  return labelMap[type]
}

function getQueuedWorkbenchTaskCount(type: string): number {
  if (!isSerialWorkbenchTaskType(type)) return 0
  return queuedWorkbenchTaskCounts[type] || 0
}

function getQueuedWorkbenchTaskTotal(): number {
  return serialWorkbenchTaskTypes.reduce(
    (total, type) => total + (queuedWorkbenchTaskCounts[type] || 0),
    0
  )
}

function getWorkbenchSubmitWaitSeconds(): number {
  const remainingMs = Math.max(0, nextWorkbenchSubmitAt - Date.now())
  return Math.ceil(remainingMs / 1000)
}

function getWorkbenchQueueHint(type: string): string {
  if (!isSerialWorkbenchTaskType(type)) return ''
  const count = getQueuedWorkbenchTaskCount(type)
  if (count <= 0) return ''
  return count > 1 ? `等待提交（队列中 ${count} 个）` : '等待提交'
}

async function enqueueWorkbenchTask<T>(
  type: WorkbenchSerialTaskType,
  task: () => Promise<T>
): Promise<T> {
  queuedWorkbenchTaskCounts[type] = (queuedWorkbenchTaskCounts[type] || 0) + 1

  let taskPromise: Promise<T> | null = null

  const submitTask = async (): Promise<void> => {
    queuedWorkbenchTaskCounts[type] = Math.max(0, (queuedWorkbenchTaskCounts[type] || 1) - 1)
    if (!queuedWorkbenchTaskCounts[type]) {
      delete queuedWorkbenchTaskCounts[type]
    }

    const waitMs = Math.max(0, nextWorkbenchSubmitAt - Date.now())
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs))
    }

    submittingWorkbenchTaskType.value = type
    nextWorkbenchSubmitAt = Date.now() + WORKBENCH_SUBMIT_COOLDOWN_MS

    try {
      taskPromise = task()
    } finally {
      if (submittingWorkbenchTaskType.value === type) {
        submittingWorkbenchTaskType.value = null
      }
    }
  }

  const scheduledSubmission = workbenchTaskSubmissionChain.then(submitTask, submitTask)
  workbenchTaskSubmissionChain = scheduledSubmission.then(
    () => undefined,
    () => undefined
  )

  await scheduledSubmission
  return await taskPromise!
}

/**
 * 组件 Props
 */
const props = withDefaults(
  defineProps<{
    /** 知识库ID */
    notebookId?: string
    /** 知识库标题 */
    notebookTitle?: string
    /** 知识库来源 */
    sources?: SourceItem[]
    /** 聊天消息 */
    messages?: ChatMessage[]
    /** 是否折叠 */
    collapsed?: boolean
  }>(),
  {
    notebookId: '',
    notebookTitle: '',
    sources: () => [],
    messages: () => [],
    collapsed: false
  }
)

const emit = defineEmits<{
  (e: 'click-empty'): void
  (e: 'toggle-collapse'): void
  /**
   * 把一份产出存回知识库当来源。
   *
   * 由 NotebookDetail 落库：它那边的 addSource 顺带会触发向量化，
   * 在这里自己写一遍的话新来源要等到下次手动「向量化」才检索得到。
   */
  (e: 'save-as-source', payload: { title: string; content: string }): void
}>()

const { t } = useI18n()

/**
 * 获取 Studio 产出的默认标题
 */
function getDefaultStudioOutputTitle(type: StudioOutput['type']): string {
  if (type === 'video') return t('notebook.studio.outputTypes.video')
  if (type === 'mindmap') return t('notebook.studio.outputTypes.mindmap')
  if (type === 'report') return t('notebook.studio.outputTypes.report')
  if (type === 'knowledgeGraph') return t('notebook.studio.outputTypes.knowledgeGraph')
  if (type === 'interview') return t('notebook.studio.outputTypes.interview')
  if (type === 'infographic') return t('notebook.studio.outputTypes.infographic')
  if (type === 'webpage') return t('notebook.studio.outputTypes.webpage')
  if (type === 'brainstorm') return t('notebook.studio.outputTypes.brainstorm')
  return t('notebook.studio.outputTypes.mindmap')
}

/**
 * 注入打开思维导图的方法
 */
const openMindmap = inject<(data: MindmapNode) => void>('openMindmap')

/**
 * 注入打开报告的方法
 */
const openReport = inject<(output: StudioOutput) => void>('openReport')

/**
 * 注入打开知识图谱的方法
 */
const openKnowledgeGraph = inject<(data: KnowledgeGraphData) => void>('openKnowledgeGraph')

/**
 * 注入打开信息图的方法
 */
const openInfographic = inject<(output: StudioOutput) => void>('openInfographic')

const studioOutputStore = useStudioOutputStore()

/**
 * 思维导图服务实例
 */
const mindmapService = createMindmapService()
const mindmapState = mindmapService.state

/**
 * 报告生成服务实例
 */
const reportService = createReportGenerationService()
const reportState = reportService.state

/**
 * 知识图谱服务实例
 */
const knowledgeGraphService = createKnowledgeGraphService()
const knowledgeGraphState = knowledgeGraphService.state

/**
 * 模拟面试服务实例
 */
import { createMockInterviewService } from '@renderer/services/mockInterview'
const mockInterviewService = createMockInterviewService()
const mockInterviewState = mockInterviewService.state

/**
 * 信息图生成 Store
 */
import { useInfographicGenerationStore } from '@renderer/store/modules/infographicGenerationStore'
const infographicGenStore = useInfographicGenerationStore()

/**
 * 信息图配置弹窗
 */
import InfographicConfigModal from './InfographicConfigModal.vue'
import TaskPromptModal from './TaskPromptModal.vue'
const showInfographicConfig = ref(false)

/** 正在编辑提示词的那个文字产出 */
const showTaskPromptModal = ref(false)
const editingPromptTask = ref<WorkbenchSerialTaskType | null>(null)
const editingPromptLabel = ref('')

/** AI 操作失败的统一提示出口。 */
function reportGenerationFailure(error: string | undefined, fallback: string): void {
  message.error(getAiActionErrorMessage(error, fallback))
}

function getAiActionErrorMessage(error: string | undefined, fallback: string): string {
  return formatErrorMessage(error, fallback)
}

/**
 * 网页生成服务实例
 */
import { createWebPageService } from '@renderer/services/webPage'
const webPageService = createWebPageService()
const webPageState = webPageService.state

/**
 * 头脑风暴服务实例
 */
import { createBrainstormService, type BrainstormSession } from '@renderer/services/brainstorm'
const brainstormService = createBrainstormService()
const brainstormState = brainstormService.state

/**
 * 思维导图模态框状态 - 已移除，改用中心区域显示
 */
// const showMindmapModal = ref(false)
// const currentMindmapData = ref<MindmapNode | null>(null)

/**
 * 获取当前知识库的产出列表
 */
const outputs = computed(() => {
  if (!props.notebookId) return []
  return studioOutputStore.getOutputs(props.notebookId)
})

type OutputTypeFilter = 'all' | StudioOutput['type']
type OutputStatusFilter = 'all' | 'generating' | 'completed' | 'failed'
type OutputTimeFilter = 'all' | 'today' | 'week' | 'earlier'
type OutputSortMode = 'latest' | 'oldest' | 'title'

interface OutputFilterOption<T extends string> {
  key: T
  label: string
  count?: number
}

interface OutputGroup {
  key: string
  label: string
  items: StudioOutput[]
}

type OutputGroupKey = 'today' | 'yesterday' | 'week' | 'earlier'

const outputTypeOrder: StudioOutput['type'][] = [
  'video',
  'report',
  'mindmap',
  'knowledgeGraph',
  'interview',
  'webpage',
  'infographic',
  'brainstorm'
]

const selectedOutputType = ref<OutputTypeFilter>('all')
const selectedOutputStatus = ref<OutputStatusFilter>('all')
const selectedOutputTime = ref<OutputTimeFilter>('all')
const selectedOutputSort = ref<OutputSortMode>('latest')
const scrollProgress = ref(0) // 0 = full, 1 = mini
const studioLayoutMini = ref(false) // triggers display:flex at near-full progress
const outputsAreaRef = ref<HTMLElement | null>(null)
const studioStickyRef = ref<HTMLElement | null>(null)

const outputStatusFilters = computed<OutputFilterOption<OutputStatusFilter>[]>(() => [
  { key: 'all', label: t('notebook.studio.filters.status.all') },
  { key: 'generating', label: t('notebook.studio.filters.status.generating') },
  { key: 'completed', label: t('notebook.studio.filters.status.completed') },
  { key: 'failed', label: t('notebook.studio.filters.status.failed') }
])

const outputTimeFilters = computed<OutputFilterOption<OutputTimeFilter>[]>(() => [
  { key: 'all', label: t('notebook.studio.filters.time.all') },
  { key: 'today', label: t('notebook.studio.filters.time.today') },
  { key: 'week', label: t('notebook.studio.filters.time.week') },
  { key: 'earlier', label: t('notebook.studio.filters.time.earlier') }
])

const outputSortModes = computed<OutputFilterOption<OutputSortMode>[]>(() => [
  { key: 'latest', label: t('notebook.studio.filters.sort.latest') },
  { key: 'oldest', label: t('notebook.studio.filters.sort.oldest') },
  { key: 'title', label: t('notebook.studio.filters.sort.title') }
])

/**
 * 产出列表是否已就绪（延迟渲染，避免首次加载卡顿）
 */
const isOutputsReady = ref(false)

/**
 * 组件挂载后延迟加载产出列表
 */
function handleOutputsScroll(): void {
  const scrollTop = outputsAreaRef.value?.scrollTop ?? 0
  const p = Math.min(scrollTop / 180, 1)
  scrollProgress.value = p
  studioLayoutMini.value = p >= 0.95
  // Keep output-toolbar top in sync with actual sticky header height
  const h = studioStickyRef.value?.offsetHeight ?? 56
  outputsAreaRef.value?.style.setProperty('--studio-sticky-h', `${h}px`)
}

onMounted(() => {
  // 延迟 100ms 渲染产出列表，让主要 UI 先显示
  setTimeout(() => {
    isOutputsReady.value = true
  }, 100)
  outputsAreaRef.value?.addEventListener('scroll', handleOutputsScroll, { passive: true })
})

/**
 * 获取选中的来源（用于 Studio 生成功能）
 * 只有选中的来源会参与内容生成
 */
const selectedSources = computed(() => {
  if (!props.sources) return []
  return props.sources.filter((s) => nbStore._selectedSourceIds.includes(s.id))
})

/**
 * 当前正在生成的产出 ID
 */
const currentGeneratingOutputId = ref<string | null>(null)

/**
 * 刚完成的产出 ID 列表（用于显示"新完成"视觉提示）
 * 用户点击后会从列表中移除
 */
const recentlyCompletedIds = ref<Set<string>>(new Set())

/**
 * 标记产出为刚完成
 */
function markAsRecentlyCompleted(outputId: string): void {
  recentlyCompletedIds.value.add(outputId)
  // 触发响应式更新
  recentlyCompletedIds.value = new Set(recentlyCompletedIds.value)
}

/**
 * 清除产出的"刚完成"标记
 */
function clearRecentlyCompleted(outputId: string): void {
  recentlyCompletedIds.value.delete(outputId)
  // 触发响应式更新
  recentlyCompletedIds.value = new Set(recentlyCompletedIds.value)
}

/**
 * 组件卸载时清理服务
 */
onBeforeUnmount(() => {
  outputsAreaRef.value?.removeEventListener('scroll', handleOutputsScroll)
})

/**
 * 处理思维导图点击
 */
/**
 * 处理思维导图点击
 */
async function handleMindmapClick(): Promise<void> {
  // 如果正在生成，提示等待
  if (
    mindmapState.value.status !== 'idle' &&
    mindmapState.value.status !== 'completed' &&
    mindmapState.value.status !== 'failed'
  ) {
    message.info(t('notebook.studio.generating'))
    return
  }

  // 检查是否有选中的来源
  if (selectedSources.value.length === 0 && props.messages.length === 0) {
    message.warning(t('notebook.source.noSourceSelected'))
    return
  }

  // 开始生成 - 立即添加到产出列表
  const outputId = Date.now().toString()
  if (props.notebookId) {
    studioOutputStore.addOutput(props.notebookId, {
      id: outputId,
      type: 'mindmap',
      title: getDefaultStudioOutputTitle('mindmap'),
      sourceCount: selectedSources.value.length,
      createdAt: new Date().toISOString(),
      mindmapData: undefined // 初始为空，表示生成中
    })
  }

  // 记录正在生成的 Output ID
  currentGeneratingOutputId.value = outputId

  mindmapService.reset()
  const result = await mindmapService.generateAsync(
    selectedSources.value,
    props.messages,
    props.notebookTitle || '知识库',
    props.notebookId
  )

  if (result) {
    // 更新产出列表 - 使用根节点文本作为标题
    if (props.notebookId) {
      studioOutputStore.updateOutput(props.notebookId, outputId, {
        title: result.data?.text || getDefaultStudioOutputTitle('mindmap'),
        mindmapData: result,
        status: 'completed'
      })
    }

    // 不再自动打开思维导图视图，让用户在output-list中查看生成状态
    // 生成完成后用户可以手动点击查看

    // 标记为刚完成，显示视觉提示
    markAsRecentlyCompleted(outputId)
  } else {
    reportGenerationFailure(mindmapState.value.error, '思维导图生成失败')
    // 如果失败，保留产出并记录错误信息
    if (props.notebookId) {
      studioOutputStore.updateOutput(props.notebookId, outputId, {
        status: 'failed',
        errorMessage: mindmapState.value.error || '思维导图生成失败'
      })
    }
  }
  currentGeneratingOutputId.value = null
}

/**
 * 处理报告点击
 */
async function handleReportClick(): Promise<void> {
  // 如果正在生成，提示等待
  if (
    reportState.value.status !== 'idle' &&
    reportState.value.status !== 'completed' &&
    reportState.value.status !== 'failed'
  ) {
    message.info(t('notebook.studio.generating'))
    return
  }

  // 检查是否有选中的来源
  if (selectedSources.value.length === 0 && props.messages.length === 0) {
    message.warning(t('notebook.source.noSourceSelected'))
    return
  }

  // 开始生成 - 立即添加到产出列表
  const outputId = Date.now().toString()
  if (props.notebookId) {
    studioOutputStore.addOutput(props.notebookId, {
      id: outputId,
      type: 'report',
      title: getDefaultStudioOutputTitle('report'),
      sourceCount: selectedSources.value.length,
      createdAt: new Date().toISOString(),
      reportContent: undefined // 初始为空，表示生成中
    })
  }

  // 记录正在生成的 Output ID
  currentGeneratingOutputId.value = outputId

  reportService.reset()
  const result = await reportService.generateAsync(
    selectedSources.value,
    props.messages,
    props.notebookTitle || '知识库',
    props.notebookId
  )

  if (result) {
    // 更新产出列表 - 从 Markdown 内容提取标题
    const titleMatch = result.match(/^#\s+(.+)$/m)
    const reportTitle = titleMatch ? titleMatch[1].trim() : getDefaultStudioOutputTitle('report')
    if (props.notebookId) {
      studioOutputStore.updateOutput(props.notebookId, outputId, {
        title: reportTitle,
        reportContent: result,
        status: 'completed'
      })
    }

    // 不再自动打开报告视图，让用户在output-list中查看生成状态
    // 生成完成后用户可以手动点击查看

    // 标记为刚完成，显示视觉提示
    markAsRecentlyCompleted(outputId)
  } else {
    reportGenerationFailure(reportState.value.error, '报告生成失败')
    // 如果失败，保留产出并记录错误信息
    if (props.notebookId) {
      studioOutputStore.updateOutput(props.notebookId, outputId, {
        status: 'failed',
        errorMessage: reportState.value.error || '报告生成失败'
      })
    }
  }
  currentGeneratingOutputId.value = null
}

/**
 * 处理知识图谱点击
 */
async function handleKnowledgeGraphClick(): Promise<void> {
  // 如果正在生成，提示等待
  if (
    knowledgeGraphState.value.status !== 'idle' &&
    knowledgeGraphState.value.status !== 'completed' &&
    knowledgeGraphState.value.status !== 'failed'
  ) {
    message.info(t('notebook.studio.generating'))
    return
  }

  // 检查是否有选中的来源
  if (selectedSources.value.length === 0 && props.messages.length === 0) {
    message.warning(t('notebook.source.noSourceSelected'))
    return
  }

  // 开始生成 - 立即添加到产出列表
  const outputId = Date.now().toString()
  if (props.notebookId) {
    studioOutputStore.addOutput(props.notebookId, {
      id: outputId,
      type: 'knowledgeGraph',
      title: getDefaultStudioOutputTitle('knowledgeGraph'),
      sourceCount: selectedSources.value.length,
      createdAt: new Date().toISOString(),
      knowledgeGraphData: undefined // 初始为空，表示生成中
    })
  }

  // 记录正在生成的 Output ID
  currentGeneratingOutputId.value = outputId

  knowledgeGraphService.reset()
  const result = await knowledgeGraphService.generateAsync(
    selectedSources.value,
    props.messages,
    props.notebookTitle || '知识库',
    props.notebookId
  )

  if (result) {
    // 更新产出列表 - 使用 AI 生成的主题标题
    if (props.notebookId) {
      studioOutputStore.updateOutput(props.notebookId, outputId, {
        title: result.title || getDefaultStudioOutputTitle('knowledgeGraph'),
        knowledgeGraphData: result,
        status: 'completed'
      })
    }

    // 不再自动打开知识图谱视图，让用户在output-list中查看生成状态
    // 生成完成后用户可以手动点击查看

    // 标记为刚完成，显示视觉提示
    markAsRecentlyCompleted(outputId)
  } else {
    reportGenerationFailure(knowledgeGraphState.value.error, '知识图谱生成失败')
    // 如果失败，保留产出并记录错误信息
    if (props.notebookId) {
      studioOutputStore.updateOutput(props.notebookId, outputId, {
        status: 'failed',
        errorMessage: knowledgeGraphState.value.error || '知识图谱生成失败'
      })
    }
  }
  currentGeneratingOutputId.value = null
}

/**
 * 注入打开面试的方法
 */
const openMockInterview = inject<(output: StudioOutput) => void>('openMockInterview')

/**
 * 处理模拟面试点击
 */
async function handleMockInterviewClick(): Promise<void> {
  // 如果正在生成，提示等待
  if (
    mockInterviewState.value.status !== 'idle' &&
    mockInterviewState.value.status !== 'ready' &&
    mockInterviewState.value.status !== 'completed' &&
    mockInterviewState.value.status !== 'failed'
  ) {
    message.info(t('notebook.studio.generating'))
    return
  }

  // 检查是否有选中的来源
  if (selectedSources.value.length === 0 && props.messages.length === 0) {
    message.warning(t('notebook.source.noSourceSelected'))
    return
  }

  // 开始生成 - 立即添加到产出列表
  const outputId = Date.now().toString()
  if (props.notebookId) {
    studioOutputStore.addOutput(props.notebookId, {
      id: outputId,
      type: 'interview',
      title: getDefaultStudioOutputTitle('interview'),
      sourceCount: selectedSources.value.length,
      createdAt: new Date().toISOString(),
      interviewConfig: undefined // 初始为空，表示生成中
    })
  }

  // 记录正在生成的 Output ID
  currentGeneratingOutputId.value = outputId

  mockInterviewService.reset()
  const result = await mockInterviewService.generateConfigAsync(
    selectedSources.value,
    props.messages,
    props.notebookTitle || '知识库',
    props.notebookId
  )

  if (result) {
    // 更新产出列表 - 使用 AI 生成的面试主题
    // @ts-expect-error title 是从 AI 返回的额外字段
    const interviewTitle = result.title || result.topic || getDefaultStudioOutputTitle('interview')
    if (props.notebookId) {
      studioOutputStore.updateOutput(props.notebookId, outputId, {
        title: interviewTitle,
        interviewConfig: result,
        status: 'completed'
      })
    }

    // 不再自动打开面试视图，让用户在output-list中查看生成状态
    // 生成完成后用户可以手动点击查看

    // 标记为刚完成，显示视觉提示
    markAsRecentlyCompleted(outputId)
  } else {
    reportGenerationFailure(mockInterviewState.value.error, '面试配置生成失败')
    // 如果失败，保留产出并记录错误信息
    if (props.notebookId) {
      studioOutputStore.updateOutput(props.notebookId, outputId, {
        status: 'failed',
        errorMessage: mockInterviewState.value.error || '面试配置生成失败'
      })
    }
  }
  currentGeneratingOutputId.value = null
}

/**
 * 处理信息图点击
 */
async function handleInfographicClick(): Promise<void> {
  // 如果正在生成，提示等待
  if (infographicGenStore.isGenerating) {
    message.info(t('notebook.studio.generating'))
    return
  }

  // 检查是否有选中的来源
  if (selectedSources.value.length === 0 && props.messages.length === 0) {
    message.warning(t('notebook.source.noSourceSelected'))
    return
  }

  // 开始生成 - 立即添加到产出列表
  const outputId = Date.now().toString()
  if (props.notebookId) {
    studioOutputStore.addOutput(props.notebookId, {
      id: outputId,
      type: 'infographic',
      title: getDefaultStudioOutputTitle('infographic'),
      sourceCount: selectedSources.value.length,
      createdAt: new Date().toISOString(),
      infographicImageUrl: undefined // 初始为空，表示生成中
    })
  }

  // 记录正在生成的 Output ID
  currentGeneratingOutputId.value = outputId

  // 使用 store 管理生成
  infographicGenStore.startGeneration(outputId)

  // 不再自动打开信息图视图，让用户在output-list中查看生成状态
  // 生成完成后用户可以手动点击查看

  // 开始生成
  const result = await infographicGenStore.service.generate(
    selectedSources.value,
    props.messages,
    props.notebookTitle || '知识库'
  )

  if (result) {
    // 保存信息图到本地资产库
    let localPath: string | undefined
    if (props.notebookId) {
      try {
        const saveResult = await window.electron.ipcRenderer.invoke(
          'notebook:infographic:saveLocal',
          {
            imageUrl: result.imageUrl,
            notebookId: props.notebookId,
            notebookTitle: props.notebookTitle || '知识库',
            imageTitle: result.title
          }
        )
        if (saveResult.success && saveResult.localPath) {
          localPath = saveResult.localPath
          console.log('[NoteStudioPanel] 信息图已保存到本地:', localPath)
        } else {
          console.warn('[NoteStudioPanel] 信息图保存到本地失败:', saveResult.error)
        }
      } catch (err) {
        console.error('[NoteStudioPanel] 保存信息图到本地异常:', err)
      }
    }

    // 更新产出列表 - 使用 AI 生成的主题标题，优先使用本地路径
    if (props.notebookId) {
      studioOutputStore.updateOutput(props.notebookId, outputId, {
        title: result.title || getDefaultStudioOutputTitle('infographic'),
        infographicImageUrl: result.imageUrl,
        infographicLocalPath: localPath,
        status: 'completed'
      })
    }

    // 标记为刚完成，显示视觉提示
    markAsRecentlyCompleted(outputId)
  } else {
    message.error(getAiActionErrorMessage(infographicGenStore.state.error, '信息图生成失败'))
    // 如果失败，保留产出并记录错误信息
    if (props.notebookId) {
      studioOutputStore.updateOutput(props.notebookId, outputId, {
        status: 'failed',
        errorMessage: infographicGenStore.state.error || '信息图生成失败'
      })
    }
  }
  currentGeneratingOutputId.value = null
}

/**
 * 注入打开网页的方法
 */
const openWebPage = inject<(output: StudioOutput) => void>('openWebPage')

/**
 * 处理网页生成点击
 */
async function handleWebPageClick(): Promise<void> {
  // 如果正在生成，提示等待
  if (
    webPageState.value.status !== 'idle' &&
    webPageState.value.status !== 'completed' &&
    webPageState.value.status !== 'failed'
  ) {
    message.info(t('notebook.studio.generating'))
    return
  }

  // 检查是否有选中的来源
  if (selectedSources.value.length === 0 && props.messages.length === 0) {
    message.warning(t('notebook.source.noSourceSelected'))
    return
  }

  // 开始生成 - 立即添加到产出列表
  const outputId = Date.now().toString()
  if (props.notebookId) {
    studioOutputStore.addOutput(props.notebookId, {
      id: outputId,
      type: 'webpage',
      title: getDefaultStudioOutputTitle('webpage'),
      sourceCount: selectedSources.value.length,
      createdAt: new Date().toISOString(),
      webpageHtml: undefined // 初始为空，表示生成中
    })
  }

  // 记录正在生成的 Output ID
  currentGeneratingOutputId.value = outputId

  // 不再自动打开网页视图，让用户在output-list中查看生成状态
  // 生成完成后用户可以手动点击查看

  webPageService.reset()
  const result = await webPageService.generateAsync(
    selectedSources.value,
    props.messages,
    props.notebookId
  )

  if (result) {
    // 更新产出列表 - 从 HTML 中提取 title 标签作为标题
    const titleTagMatch = result.match(/<title[^>]*>([^<]+)<\/title>/i)
    const webpageTitle = titleTagMatch
      ? titleTagMatch[1].trim()
      : getDefaultStudioOutputTitle('webpage')
    if (props.notebookId) {
      studioOutputStore.updateOutput(props.notebookId, outputId, {
        title: webpageTitle,
        webpageHtml: result,
        status: 'completed'
      })
    }

    // 标记为刚完成，显示视觉提示
    markAsRecentlyCompleted(outputId)
  } else {
    reportGenerationFailure(webPageState.value.error, '网页生成失败')
    // 如果失败，保留产出并记录错误信息
    if (props.notebookId) {
      studioOutputStore.updateOutput(props.notebookId, outputId, {
        status: 'failed',
        errorMessage: webPageState.value.error || '网页生成失败'
      })
    }
  }
  currentGeneratingOutputId.value = null
}

/**
 * 注入打开头脑风暴的方法
 */
const openBrainstorm = inject<(output: StudioOutput) => void>('openBrainstorm')

/**
 * 处理头脑风暴点击
 */
async function handleBrainstormClick(): Promise<void> {
  // 如果正在生成，提示等待
  if (
    brainstormState.value.status !== 'idle' &&
    brainstormState.value.status !== 'completed' &&
    brainstormState.value.status !== 'failed'
  ) {
    message.info(t('notebook.studio.generating'))
    return
  }

  // 检查是否有选中的来源
  if (selectedSources.value.length === 0 && props.messages.length === 0) {
    message.warning(t('notebook.source.noSourceSelected'))
    return
  }

  // 开始生成 - 立即添加到产出列表
  const outputId = Date.now().toString()
  if (props.notebookId) {
    studioOutputStore.addOutput(props.notebookId, {
      id: outputId,
      type: 'brainstorm',
      title: getDefaultStudioOutputTitle('brainstorm'),
      sourceCount: selectedSources.value.length,
      createdAt: new Date().toISOString(),
      brainstormData: undefined // 初始为空，表示生成中
    })
  }

  // 记录正在生成的 Output ID
  currentGeneratingOutputId.value = outputId

  // 不再自动打开头脑风暴视图，让用户在output-list中查看生成状态
  // 生成完成后用户可以手动点击查看

  brainstormService.reset()
  const result = await brainstormService.generateAsync(
    selectedSources.value,
    props.messages,
    props.notebookId
  )

  if (result) {
    // 更新产出列表
    if (props.notebookId) {
      studioOutputStore.updateOutput(props.notebookId, outputId, {
        title: result.topicSummary || getDefaultStudioOutputTitle('brainstorm'),
        brainstormData: result,
        status: 'completed'
      })
    }

    // 标记为刚完成，显示视觉提示
    markAsRecentlyCompleted(outputId)
  } else {
    reportGenerationFailure(brainstormState.value.error, '头脑风暴生成失败')
    // 如果失败，保留产出并记录错误信息
    if (props.notebookId) {
      studioOutputStore.updateOutput(props.notebookId, outputId, {
        status: 'failed',
        errorMessage: brainstormState.value.error || '头脑风暴生成失败'
      })
    }
  }
  currentGeneratingOutputId.value = null
}

/**
 * 处理 Studio 项目点击
 */
function handleItemClick(type: string): void {
  if (isSerialWorkbenchTaskType(type) && submittingWorkbenchTaskType.value === type) {
    return
  }

  if (isSerialWorkbenchTaskType(type) && getQueuedWorkbenchTaskCount(type) > 0) {
    return
  }

  if (type === 'mindmap') {
    void enqueueWorkbenchTask('mindmap', handleMindmapClick)
  } else if (type === 'report') {
    void enqueueWorkbenchTask('report', handleReportClick)
  } else if (type === 'knowledgeGraph') {
    void enqueueWorkbenchTask('knowledgeGraph', handleKnowledgeGraphClick)
  } else if (type === 'interview') {
    void enqueueWorkbenchTask('interview', handleMockInterviewClick)
  } else if (type === 'infographic') {
    handleInfographicClick()
  } else if (type === 'webpage') {
    void enqueueWorkbenchTask('webpage', handleWebPageClick)
  } else if (type === 'brainstorm') {
    void enqueueWorkbenchTask('brainstorm', handleBrainstormClick)
  } else {
    message.info(t('notebook.studio.generating'))
  }
}

/** 工具卡片的淡色底色 */
const STUDIO_TOOL_TINTS: Partial<Record<StudioOutput['type'], string>> = {
  infographic: 'rgba(115, 77, 94, 0.12)',
  mindmap: 'rgba(139, 72, 102, 0.12)',
  report: 'rgba(115, 107, 63, 0.12)',
  knowledgeGraph: 'rgba(115, 87, 63, 0.12)',
  interview: 'rgba(77, 94, 115, 0.12)',
  webpage: 'rgba(52, 152, 219, 0.12)',
  brainstorm: 'rgba(167, 255, 255, 0.09)'
}

/**
 * Studio 项目列表，包含图标、标签和对应的淡入背景色
 */
const studioItems = computed(() => [
  {
    icon: PhChartBar,
    type: 'infographic',
    label: t('notebook.studio.tools.infographic'),
    color: STUDIO_TOOL_TINTS.infographic,
    isAIGC: true // 走生图模型，消耗用户自己那家服务商的额度
  },
  {
    icon: PhTreeStructure,
    type: 'mindmap',
    label: t('notebook.studio.tools.mindmap'),
    color: STUDIO_TOOL_TINTS.mindmap
  },
  {
    icon: PhFileText,
    type: 'report',
    label: t('notebook.studio.tools.report'),
    color: STUDIO_TOOL_TINTS.report
  },
  {
    icon: PhGraph,
    type: 'knowledgeGraph',
    label: t('notebook.studio.tools.knowledgeGraph'),
    color: STUDIO_TOOL_TINTS.knowledgeGraph
  },
  {
    icon: PhMicrophoneStage,
    type: 'interview',
    label: t('notebook.studio.tools.interview'),
    color: STUDIO_TOOL_TINTS.interview
  },
  {
    icon: PhGlobe,
    type: 'webpage',
    label: t('notebook.studio.tools.webpage'),
    color: STUDIO_TOOL_TINTS.webpage
  },
  {
    icon: PhLightbulb,
    type: 'brainstorm',
    label: t('notebook.studio.tools.brainstorm'),
    color: STUDIO_TOOL_TINTS.brainstorm
  }
])

/**
 * 根据输出类型获取对应的颜色配置
 * @param type 输出类型
 * @returns 包含背景色和图标颜色的对象
 */
function getOutputTypeColor(type: StudioOutput['type']): { background: string; color: string } {
  const colorMap: Record<StudioOutput['type'], { background: string; color: string }> = {
    video: {
      background: 'linear-gradient(135deg, rgba(52,211,153,0.24), rgba(16,185,129,0.14))',
      color: '#34d399'
    },
    mindmap: {
      background: 'linear-gradient(135deg, rgba(244,63,94,0.24), rgba(236,72,153,0.14))',
      color: '#fb7185'
    },
    report: {
      background: 'linear-gradient(135deg, rgba(245,158,11,0.24), rgba(234,179,8,0.14))',
      color: '#fbbf24'
    },
    knowledgeGraph: {
      background: 'linear-gradient(135deg, rgba(249,115,22,0.24), rgba(239,68,68,0.14))',
      color: '#fb923c'
    },
    interview: {
      background: 'linear-gradient(135deg, rgba(59,130,246,0.24), rgba(99,102,241,0.14))',
      color: '#60a5fa'
    },
    infographic: {
      background: 'linear-gradient(135deg, rgba(217,70,239,0.24), rgba(168,85,247,0.14))',
      color: '#e879f9'
    },
    webpage: {
      background: 'linear-gradient(135deg, rgba(6,182,212,0.24), rgba(59,130,246,0.14))',
      color: '#22d3ee'
    },
    brainstorm: {
      background: 'linear-gradient(135deg, rgba(20,184,166,0.24), rgba(16,185,129,0.14))',
      color: '#2dd4bf'
    }
  }
  return (
    colorMap[type] || {
      background: 'linear-gradient(135deg, rgba(99,102,241,0.28), rgba(168,85,247,0.18))',
      color: '#a78bfa'
    }
  )
}

function getOutputTypeLabel(type: StudioOutput['type']): string {
  const labelKeyMap: Record<StudioOutput['type'], string> = {
    video: 'notebook.studio.filters.type.video',
    mindmap: 'notebook.studio.filters.type.mindmap',
    report: 'notebook.studio.filters.type.report',
    knowledgeGraph: 'notebook.studio.filters.type.knowledgeGraph',
    interview: 'notebook.studio.filters.type.interview',
    infographic: 'notebook.studio.filters.type.infographic',
    webpage: 'notebook.studio.filters.type.webpage',
    brainstorm: 'notebook.studio.filters.type.brainstorm'
  }
  return t(labelKeyMap[type])
}

function getOutputStatus(output: StudioOutput): 'generating' | 'completed' | 'failed' {
  if (output.status === 'failed') return 'failed'
  if (isOutputGenerating(output)) return 'generating'
  return 'completed'
}

function getOutputGeneratingMessage(output: StudioOutput): string {
  if (output.type === 'mindmap') {
    return output.id === currentGeneratingOutputId.value
      ? mindmapState.value.message || '正在生成思维导图...'
      : '正在生成思维导图...'
  }
  if (output.type === 'report') {
    return output.id === currentGeneratingOutputId.value
      ? reportState.value.message || '正在生成报告...'
      : '正在生成报告...'
  }
  if (output.type === 'knowledgeGraph') {
    return output.id === currentGeneratingOutputId.value
      ? knowledgeGraphState.value.message || '正在生成知识图谱...'
      : '正在生成知识图谱...'
  }
  if (output.type === 'interview') {
    return output.id === currentGeneratingOutputId.value
      ? mockInterviewState.value.message || '正在生成面试题...'
      : '正在生成面试题...'
  }
  if (output.type === 'infographic') {
    return infographicGenStore.isOutputGenerating(output.id)
      ? infographicGenStore.state.message || '正在生成信息图...'
      : '正在生成信息图...'
  }
  if (output.type === 'webpage') {
    return output.id === currentGeneratingOutputId.value
      ? webPageState.value.message || '正在生成网页...'
      : '正在生成网页...'
  }
  if (output.type === 'brainstorm') {
    return output.id === currentGeneratingOutputId.value
      ? brainstormState.value.message || '正在生成头脑风暴...'
      : '正在生成头脑风暴...'
  }
  return '正在生成中...'
}

function getOutputPrimaryActionLabel(output: StudioOutput): string {
  const status = getOutputStatus(output)
  if (status === 'generating') return '生成中'
  if (status === 'failed') return '查看原因'
  return '打开'
}

function getStartOfToday(): Date {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate())
}

function getOutputDateGroupKey(dateStr: string): OutputGroupKey {
  const createdAt = new Date(dateStr)
  if (Number.isNaN(createdAt.getTime())) return 'earlier'

  const startOfToday = getStartOfToday()
  const startOfYesterday = new Date(startOfToday)
  startOfYesterday.setDate(startOfYesterday.getDate() - 1)
  const startOfWeekWindow = new Date(startOfToday)
  startOfWeekWindow.setDate(startOfWeekWindow.getDate() - 6)

  if (createdAt >= startOfToday) return 'today'
  if (createdAt >= startOfYesterday) return 'yesterday'
  if (createdAt >= startOfWeekWindow) return 'week'
  return 'earlier'
}

function getOutputGroupLabel(groupKey: OutputGroupKey): string {
  if (groupKey === 'today') return '今天'
  if (groupKey === 'yesterday') return '昨天'
  if (groupKey === 'week') return '近 7 天'
  return '更早'
}

function matchesOutputTimeFilter(output: StudioOutput, filter: OutputTimeFilter): boolean {
  if (filter === 'all') return true

  const createdAt = new Date(output.createdAt)
  if (Number.isNaN(createdAt.getTime())) return filter === 'earlier'

  const startOfToday = getStartOfToday()
  const startOfWeekWindow = new Date(startOfToday)
  startOfWeekWindow.setDate(startOfWeekWindow.getDate() - 6)

  if (filter === 'today') return createdAt >= startOfToday
  if (filter === 'week') return createdAt >= startOfWeekWindow
  return createdAt < startOfWeekWindow
}

const outputTypeFilters = computed<OutputFilterOption<OutputTypeFilter>[]>(() => {
  const baseList = outputs.value.filter((output) => {
    const statusMatched =
      selectedOutputStatus.value === 'all' || getOutputStatus(output) === selectedOutputStatus.value
    return statusMatched && matchesOutputTimeFilter(output, selectedOutputTime.value)
  })

  return [
    {
      key: 'all',
      label: t('notebook.studio.filters.type.all'),
      count: baseList.length
    },
    ...outputTypeOrder.map((type) => ({
      key: type,
      label: getOutputTypeLabel(type),
      count: baseList.filter((output) => output.type === type).length
    }))
  ]
})

const visibleOutputTypeFilters = computed(() => {
  return outputTypeFilters.value.filter(
    (filter) =>
      filter.key === 'all' || filter.key === selectedOutputType.value || Boolean(filter.count)
  )
})

const filteredOutputs = computed(() => {
  const filtered = outputs.value.filter((output) => {
    const typeMatched =
      selectedOutputType.value === 'all' || output.type === selectedOutputType.value
    const statusMatched =
      selectedOutputStatus.value === 'all' || getOutputStatus(output) === selectedOutputStatus.value
    const timeMatched = matchesOutputTimeFilter(output, selectedOutputTime.value)
    return typeMatched && statusMatched && timeMatched
  })

  return filtered.sort((left, right) => {
    if (selectedOutputSort.value === 'title') {
      return left.title.localeCompare(right.title, 'zh-CN')
    }

    const leftTime = new Date(left.createdAt).getTime()
    const rightTime = new Date(right.createdAt).getTime()

    if (selectedOutputSort.value === 'oldest') {
      return leftTime - rightTime
    }
    return rightTime - leftTime
  })
})

const groupedOutputs = computed<OutputGroup[]>(() => {
  const groups: Record<OutputGroupKey, StudioOutput[]> = {
    today: [],
    yesterday: [],
    week: [],
    earlier: []
  }

  filteredOutputs.value.forEach((output) => {
    const groupKey = getOutputDateGroupKey(output.createdAt)
    if (groupKey === 'today') {
      groups.today.push(output)
      return
    }
    if (groupKey === 'yesterday') {
      groups.yesterday.push(output)
      return
    }
    if (groupKey === 'week') {
      groups.week.push(output)
      return
    }
    groups.earlier.push(output)
  })

  return (['today', 'yesterday', 'week', 'earlier'] as const)
    .map((key) => ({
      key,
      label: getOutputGroupLabel(key),
      items: groups[key]
    }))
    .filter((group) => group.items.length > 0)
})

const hasActiveOutputFilters = computed(() => {
  return (
    selectedOutputType.value !== 'all' ||
    selectedOutputStatus.value !== 'all' ||
    selectedOutputTime.value !== 'all'
  )
})

function resetOutputFilters(): void {
  selectedOutputType.value = 'all'
  selectedOutputStatus.value = 'all'
  selectedOutputTime.value = 'all'
}

/**
 * 处理产出项点击
 */
function handleOutputClick(output: StudioOutput): void {
  // 清除"刚完成"视觉提示
  clearRecentlyCompleted(output.id)

  // 处理失败状态的点击 - 显示错误信息
  if (output.status === 'failed') {
    message.error(output.errorMessage || '生成失败，请重试')
    return
  }

  // 处理思维导图点击
  if (output.type === 'mindmap') {
    if (output.mindmapData) {
      if (openMindmap) {
        openMindmap(output.mindmapData as MindmapNode)
      }
    } else {
      message.info(t('notebook.studio.generating'))
    }
    return
  }

  // 处理报告点击
  if (output.type === 'report') {
    if (output.reportContent) {
      if (openReport) {
        openReport(output)
      }
    } else {
      message.info(t('notebook.studio.generating'))
    }
    return
  }

  // 处理知识图谱点击
  if (output.type === 'knowledgeGraph') {
    if (output.knowledgeGraphData) {
      if (openKnowledgeGraph) {
        openKnowledgeGraph(output.knowledgeGraphData)
      }
    } else {
      message.info(t('notebook.studio.generating'))
    }
    return
  }

  // 处理面试点击
  if (output.type === 'interview') {
    if (output.interviewConfig?.questions?.length) {
      if (openMockInterview) {
        openMockInterview(output)
      }
    } else {
      message.info(t('notebook.studio.generating'))
    }
    return
  }

  // 处理信息图点击
  if (output.type === 'infographic') {
    if (output.infographicImageUrl || output.infographicLocalPath) {
      if (openInfographic) {
        openInfographic(output)
      }
    } else {
      message.info(t('notebook.studio.generating'))
    }
    return
  }

  // 处理网页点击
  if (output.type === 'webpage') {
    if (output.webpageHtml) {
      if (openWebPage) {
        openWebPage(output)
      }
    } else {
      message.info(t('notebook.studio.generating'))
    }
    return
  }

  // 处理头脑风暴点击
  if (output.type === 'brainstorm') {
    if (output.brainstormData) {
      if (openBrainstorm) {
        openBrainstorm(output)
      }
    } else {
      message.info(t('notebook.studio.generating'))
    }
    return
  }

  message.info(t('notebook.studio.generating'))
}

/**
 * 格式化相对时间
 */
function formatTime(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diff = now.getTime() - date.getTime()
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return t('notebook.studio.justNow')
  if (minutes < 60) return t('notebook.studio.minutesAgo', { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('notebook.studio.hoursAgo', { count: hours })
  const days = Math.floor(hours / 24)
  return t('notebook.studio.daysAgo', { count: days })
}

/**
 * 把产出存回知识库当来源。
 *
 * 存进去之后它就是一条普通来源：能被检索、能进下一次生成的上下文。
 * 在这之前产出是死路 —— 生成完就只能看，AI 再也想不起来。
 */
function handleSaveOutputAsSource(output: StudioOutput): void {
  const converted = studioOutputToMarkdown(output)
  if (!converted) {
    message.warning(t('notebook.studio.saveAsSourceEmpty'))
    return
  }

  emit('save-as-source', { title: converted.title, content: converted.markdown })
  message.success(t('notebook.studio.saveAsSourceDone', { title: converted.title }))
}

/**
 * 删除产出
 */
function handleDeleteOutput(output: StudioOutput): void {
  if (props.notebookId) {
    studioOutputStore.removeOutput(props.notebookId, output.id)
    // message.success('已删除')
  }
}

/**
 * 判断输出是否正在生成中（排除失败状态）
 * @param output 输出项
 * @returns 是否正在生成中
 */
function isOutputGenerating(output: StudioOutput): boolean {
  // 如果已标记为失败，则不是生成中
  if (output.status === 'failed') {
    return false
  }
  // 如果已标记为完成，则不是生成中
  if (output.status === 'completed') {
    return false
  }
  // 根据类型和数据判断是否生成中
  switch (output.type) {
    case 'mindmap':
      return !output.mindmapData
    case 'report':
      return !output.reportContent
    case 'knowledgeGraph':
      return !output.knowledgeGraphData
    case 'interview':
      return !output.interviewConfig || !output.interviewConfig.questions?.length
    case 'infographic':
      return !output.infographicImageUrl && !output.infographicLocalPath
    case 'webpage':
      return !output.webpageHtml
    case 'brainstorm':
      return !output.brainstormData
    default:
      return false
  }
}

/**
 * 重命名相关状态
 */
const showRenameModal = ref(false)
const renameInput = ref('')
const renamingOutputId = ref<string | null>(null)

/**
 * 打开重命名模态框
 */
function openRenameModal(output: StudioOutput): void {
  renamingOutputId.value = output.id
  renameInput.value = output.title
  showRenameModal.value = true
}

/**
 * 确认重命名
 */
function confirmRename(): void {
  if (!renamingOutputId.value || !renameInput.value.trim() || !props.notebookId) return

  studioOutputStore.updateOutput(props.notebookId, renamingOutputId.value, {
    title: renameInput.value.trim()
  })

  showRenameModal.value = false
  message.success(t('notebook.studio.renameSuccess'))
}

/**
 * 处理编辑信息图配置
 * @param e 点击事件
 */
function handleEditInfographic(e: Event): void {
  e.stopPropagation()
  showInfographicConfig.value = true
}

/**
 * 打开某个文字类产出的提示词编辑器。
 *
 * 信息图走的是另一个弹窗（它还要选生图模型），所以这里只管六个文字产出。
 */
function handleEditTaskPrompt(type: string, label: string, e: Event): void {
  e.stopPropagation()
  if (!isSerialWorkbenchTaskType(type)) return
  editingPromptTask.value = type
  editingPromptLabel.value = label
  showTaskPromptModal.value = true
}
</script>

<template>
  <div class="note-studio-panel" :class="{ 'is-collapsed': collapsed }">
    <!-- 折叠视图：只显示图标列表 -->
    <template v-if="collapsed">
      <div class="collapsed-view">
        <div class="collapse-toggle" @click="emit('toggle-collapse')">
          <svg
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <polyline points="15 18 9 12 15 6"></polyline>
          </svg>
        </div>
        <div class="collapsed-icons">
          <div
            v-for="(item, index) in studioItems"
            :key="index"
            class="collapsed-icon-item"
            :style="{ backgroundColor: item.color }"
            :title="item.label"
            @click="handleItemClick(item.type)"
          >
            <component :is="item.icon" />
          </div>
        </div>
      </div>
    </template>

    <!-- 展开视图：完整面板 -->
    <template v-else>
      <!-- 单一滚动容器：studio-header sticky + outputs 在同一个滚动区 -->
      <div ref="outputsAreaRef" class="panel-body" @click="emit('click-empty')">
        <div
          ref="studioStickyRef"
          class="studio-sticky-header"
          :style="{
            '--mini-p': scrollProgress,
            '--mini-p-label': Math.min(scrollProgress / 0.4, 1)
          }"
          :class="{ 'panel-mini-layout': studioLayoutMini }"
          @click.stop
        >
          <div class="panel-header">
            <span class="title">{{ t('notebook.studio.title') }}</span>
            <div class="actions">
              <div class="action-btn" @click="emit('toggle-collapse')">
                <svg
                  viewBox="0 0 24 24"
                  width="18"
                  height="18"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                >
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                  <line x1="15" y1="3" x2="15" y2="21"></line>
                </svg>
              </div>
            </div>
          </div>

          <!-- Grid of Tools -->
          <div class="studio-grid">
            <div
              v-for="(item, index) in studioItems"
              :key="index"
              class="studio-item"
              :class="{
                'has-edit-btn': item.type === 'infographic',
                'is-generating':
                  getQueuedWorkbenchTaskCount(item.type) > 0 ||
                  (item.type === 'mindmap' &&
                    mindmapState.status !== 'idle' &&
                    mindmapState.status !== 'completed' &&
                    mindmapState.status !== 'failed') ||
                  (item.type === 'report' &&
                    reportState.status !== 'idle' &&
                    reportState.status !== 'completed' &&
                    reportState.status !== 'failed') ||
                  (item.type === 'knowledgeGraph' &&
                    knowledgeGraphState.status !== 'idle' &&
                    knowledgeGraphState.status !== 'completed' &&
                    knowledgeGraphState.status !== 'failed')
              }"
              :style="{ backgroundColor: item.color }"
              @click="handleItemClick(item.type)"
            >
              <div class="item-main">
                <div class="icon-wrapper">
                  <component :is="item.icon" />
                </div>
                <div class="item-label">{{ item.label }}</div>
                <!-- 思维导图状态提示 -->
                <div
                  v-if="
                    item.type === 'mindmap' &&
                    mindmapState.status !== 'idle' &&
                    mindmapState.status !== 'completed' &&
                    mindmapState.status !== 'failed'
                  "
                  class="status-hint"
                >
                  {{ mindmapState.message || t('notebook.studio.generating') }}
                </div>
                <!-- 报告生成状态提示 -->
                <div
                  v-if="
                    item.type === 'report' &&
                    reportState.status !== 'idle' &&
                    reportState.status !== 'completed' &&
                    reportState.status !== 'failed'
                  "
                  class="status-hint"
                >
                  {{ reportState.message || t('notebook.studio.generating') }}
                </div>
                <!-- 知识图谱状态提示 -->
                <div
                  v-if="
                    item.type === 'knowledgeGraph' &&
                    knowledgeGraphState.status !== 'idle' &&
                    knowledgeGraphState.status !== 'completed' &&
                    knowledgeGraphState.status !== 'failed'
                  "
                  class="status-hint"
                >
                  {{ knowledgeGraphState.message || t('notebook.studio.generating') }}
                </div>
                <div v-if="getQueuedWorkbenchTaskCount(item.type) > 0" class="status-hint">
                  {{ getWorkbenchQueueHint(item.type) }}
                </div>
              </div>
              <div
                v-if="item.type === 'infographic'"
                class="edit-btn"
                :title="t('notebook.studio.editConfig')"
                @click.stop="handleEditInfographic"
              >
                <PhPencilSimple />
              </div>
              <!-- 文字类产出：改的是提示词，不涉及生图模型 -->
              <div
                v-else
                class="edit-btn"
                :title="t('notebook.studio.editPrompt')"
                @click.stop="handleEditTaskPrompt(item.type, item.label, $event)"
              >
                <PhPencilSimple />
              </div>
            </div>
          </div>
        </div>
        <!-- 产出列表 -->
        <!-- 空状态 -->
        <div v-if="outputs.length === 0 && isOutputsReady" class="empty-state">
          <div class="info-title">{{ t('notebook.studio.emptyTitle') }}</div>
          <div class="info-desc">{{ t('notebook.studio.emptyDesc') }}</div>
        </div>
        <!-- 加载中占位 -->
        <div v-else-if="!isOutputsReady" class="output-list">
          <div v-for="i in 3" :key="i" class="output-item loading-placeholder">
            <div class="output-icon" style="background: rgba(255, 255, 255, 0.1)"></div>
            <div class="output-info">
              <div
                class="output-title"
                style="
                  background: var(--color-bg-surface-hover);
                  height: 16px;
                  width: 60%;
                  border-radius: 4px;
                "
              ></div>
              <div
                class="output-meta"
                style="
                  background: var(--color-bg-surface-hover);
                  height: 12px;
                  width: 40%;
                  border-radius: 4px;
                  margin-top: 6px;
                "
              ></div>
            </div>
          </div>
        </div>
        <!-- 产出列表 -->
        <div v-else class="output-workbench" @click.stop>
          <div class="output-toolbar">
            <div id="output-filter-panel" class="output-filter-panel">
              <label class="output-filter-field output-type-filter">
                <select
                  v-model="selectedOutputType"
                  :aria-label="t('notebook.studio.filters.typeLabel')"
                >
                  <option
                    v-for="filter in visibleOutputTypeFilters"
                    :key="filter.key"
                    :value="filter.key"
                  >
                    {{ filter.label }}
                  </option>
                </select>
                <PhCaretDown class="output-filter-select-icon" aria-hidden="true" />
              </label>

              <label class="output-filter-field output-status-filter">
                <select
                  v-model="selectedOutputStatus"
                  :aria-label="t('notebook.studio.filters.statusLabel')"
                >
                  <option
                    v-for="filter in outputStatusFilters"
                    :key="filter.key"
                    :value="filter.key"
                  >
                    {{ filter.label }}
                  </option>
                </select>
                <PhCaretDown class="output-filter-select-icon" aria-hidden="true" />
              </label>

              <label class="output-filter-field output-time-filter">
                <select
                  v-model="selectedOutputTime"
                  :aria-label="t('notebook.studio.filters.timeLabel')"
                >
                  <option v-for="filter in outputTimeFilters" :key="filter.key" :value="filter.key">
                    {{ filter.label }}
                  </option>
                </select>
                <PhCaretDown class="output-filter-select-icon" aria-hidden="true" />
              </label>

              <label class="output-filter-field output-sort-filter">
                <select
                  v-model="selectedOutputSort"
                  :aria-label="t('notebook.studio.filters.sortLabel')"
                >
                  <option
                    v-for="sortMode in outputSortModes"
                    :key="sortMode.key"
                    :value="sortMode.key"
                  >
                    {{ sortMode.label }}
                  </option>
                </select>
                <PhCaretDown class="output-filter-select-icon" aria-hidden="true" />
              </label>
            </div>
          </div>

          <div v-if="filteredOutputs.length === 0" class="empty-state filtered-empty-state">
            <div class="magic-icon">🗂️</div>
            <div class="info-title">{{ t('notebook.studio.filters.emptyTitle') }}</div>
            <div class="info-desc">{{ t('notebook.studio.filters.emptyDescription') }}</div>
            <button
              v-if="hasActiveOutputFilters"
              class="reset-filters-btn"
              @click.stop="resetOutputFilters"
            >
              {{ t('notebook.studio.filters.reset') }}
            </button>
          </div>

          <div v-else class="output-groups">
            <section v-for="group in groupedOutputs" :key="group.key" class="output-group">
              <div class="output-group-header">
                <div class="output-group-title">{{ group.label }}</div>
                <div class="output-group-count">{{ group.items.length }} 项</div>
              </div>

              <div class="output-list">
                <div
                  v-for="output in group.items"
                  :key="output.id"
                  class="output-item"
                  :class="{
                    generating: isOutputGenerating(output),
                    failed: output.status === 'failed',
                    'recently-completed': recentlyCompletedIds.has(output.id)
                  }"
                  @click.stop="handleOutputClick(output)"
                >
                  <div v-if="recentlyCompletedIds.has(output.id)" class="completed-badge">✓</div>

                  <div
                    class="output-icon"
                    :style="{
                      background: getOutputTypeColor(output.type).background,
                      color: getOutputTypeColor(output.type).color
                    }"
                  >
                    <PhVideoCamera v-if="output.type === 'video'" />
                    <PhTreeStructure v-else-if="output.type === 'mindmap'" />
                    <PhFileText v-else-if="output.type === 'report'" />
                    <PhGraph v-else-if="output.type === 'knowledgeGraph'" />
                    <PhMicrophoneStage v-else-if="output.type === 'interview'" />
                    <PhChartBar v-else-if="output.type === 'infographic'" />
                    <PhGlobe v-else-if="output.type === 'webpage'" />
                    <PhLightbulb v-else-if="output.type === 'brainstorm'" />
                    <span class="status-dot" :class="getOutputStatus(output)"></span>
                  </div>

                  <div class="output-info">
                    <div class="output-title">{{ output.title }}</div>
                    <div class="output-footer">
                      <template v-if="output.status === 'failed'">
                        <span class="error-text">{{
                          output.errorMessage || '生成失败，请稍后重试'
                        }}</span>
                      </template>
                      <template v-else-if="isOutputGenerating(output)">
                        <span class="generating-text">{{
                          getOutputGeneratingMessage(output)
                        }}</span>
                      </template>
                      <template v-else>
                        <span
                          class="output-type-label"
                          :style="{ color: getOutputTypeColor(output.type).color }"
                          >{{ getOutputTypeLabel(output.type) }}</span
                        >
                        <span class="footer-sep">·</span>
                        <span class="output-time">{{ formatTime(output.createdAt) }}</span>
                      </template>
                    </div>
                  </div>

                  <div class="output-actions">
                    <div class="output-indicator">
                      <div v-if="isOutputGenerating(output)" class="loading-indicator">
                        <span class="dot"></span>
                        <span class="dot"></span>
                        <span class="dot"></span>
                      </div>
                    </div>

                    <AppDropdown :trigger="['click']" @click.stop>
                      <span class="more-btn" @click.stop>
                        <PhDotsThree />
                      </span>
                      <template #overlay>
                        <AppMenu>
                          <AppMenuItem
                            v-if="canSaveOutputAsSource(output)"
                            key="save-as-source"
                            item-key="save-as-source"
                            @click="handleSaveOutputAsSource(output)"
                          >
                            <PhBookmarkSimple /> {{ t('notebook.studio.saveAsSource') }}
                          </AppMenuItem>
                          <AppMenuItem
                            key="rename"
                            item-key="rename"
                            @click="openRenameModal(output)"
                          >
                            <PhPencilSimple /> {{ t('notebook.studio.rename') }}
                          </AppMenuItem>
                          <AppMenuItem
                            key="delete"
                            item-key="delete"
                            danger
                            @click="handleDeleteOutput(output)"
                          >
                            <PhTrash /> {{ t('notebook.studio.delete') }}
                          </AppMenuItem>
                        </AppMenu>
                      </template>
                    </AppDropdown>
                  </div>
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>

      <!-- 重命名模态框 -->
      <div
        v-if="showRenameModal"
        class="mindmap-modal-overlay"
        style="z-index: 2000"
        @click.self="showRenameModal = false"
      >
        <div class="mindmap-modal" style="width: 400px; height: auto">
          <div class="modal-header">
            <span class="modal-title">{{ t('notebook.studio.renameModalTitle') }}</span>
            <button class="close-btn" @click="showRenameModal = false">✕</button>
          </div>
          <div class="modal-body" style="padding: 24px">
            <input
              ref="renameInputRef"
              v-model="renameInput"
              style="
                width: 100%;
                padding: 8px 12px;
                border-radius: 6px;
                background: var(--color-bg-surface-hover);
                border: 1px solid var(--color-border-subtle);
                color: var(--color-text-primary);
                margin-bottom: 24px;
                outline: none;
              "
              :placeholder="t('notebook.studio.renameModalPlaceholder')"
              @keyup.enter="confirmRename"
            />
            <div style="display: flex; justify-content: flex-end; gap: 12px">
              <button
                class="cancel-btn"
                style="
                  padding: 8px 16px;
                  border-radius: 6px;
                  background: transparent;
                  border: 1px solid var(--color-border);
                  color: var(--color-text-primary);
                  cursor: pointer;
                  transition: all 0.2s;
                "
                @click="showRenameModal = false"
              >
                {{ t('notebook.studio.renameModalCancel') }}
              </button>
              <button
                class="confirm-btn"
                style="
                  padding: 8px 16px;
                  border-radius: 6px;
                  background: var(--color-accent-solid);
                  border: none;
                  color: var(--color-text-on-solid);
                  cursor: pointer;
                  transition: all 0.2s;
                "
                @click="confirmRename"
              >
                {{ t('notebook.studio.renameModalConfirm') }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- 信息图配置弹窗 -->
    <InfographicConfigModal v-model:visible="showInfographicConfig" />
    <TaskPromptModal
      v-model:visible="showTaskPromptModal"
      :task="editingPromptTask"
      :task-label="editingPromptLabel"
    />
  </div>
</template>

<style scoped lang="less">
.note-studio-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;

  // 折叠状态样式
  &.is-collapsed {
    padding: 8px;
    width: 56px;
    min-width: 56px;
  }
}

// 折叠视图样式
.collapsed-view {
  display: flex;
  flex-direction: column;
  align-items: center;
  height: 100%;
  gap: 8px;
}

.collapse-toggle {
  cursor: pointer;
  color: var(--color-text-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 8px;
  border-radius: 6px;
  transition: all 0.2s;
  margin-bottom: 4px;

  &:hover {
    background: var(--color-bg-surface-hover);
    color: var(--color-text-primary);
  }
}

.collapsed-icons {
  display: flex;
  flex-direction: column;
  gap: 4px;
  overflow-y: auto;
  flex: 1;

  &::-webkit-scrollbar {
    width: 0;
  }
}

.collapsed-icon-item {
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s;
  color: var(--color-text-primary);

  &:hover {
    transform: scale(1.05);
    filter: brightness(1.2);
  }

  :deep(svg) {
    font-size: 18px;
  }
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: calc(24px - 14px * var(--mini-p, 0));

  .title {
    font-size: 18px;
    font-weight: 500;
    color: var(--color-text-primary);
    transition: font-size 0.3s ease;
  }

  .action-btn {
    cursor: pointer;
    color: var(--color-text-secondary);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 4px;
    border-radius: 4px;
    transition: all 0.2s;

    &:hover {
      background: var(--color-bg-surface-hover);
      color: var(--color-text-primary);
    }
  }
}

.studio-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
  gap: 12px;
  min-height: 0;
}

// 滚动驱动动画：--mini-p (0→1) 连续插值所有属性
// --mini-p-label 更快淡出（0.4 progress = 100% faded）

.panel-header {
  margin-bottom: calc(24px - 14px * var(--mini-p, 0));

  .title {
    font-size: calc(18px - 4px * var(--mini-p, 0));
    transition: font-size 0.3s ease;
  }
}

.studio-grid {
  gap: calc(12px - 5px * var(--mini-p, 0));
}

.studio-item {
  padding: calc(16px * (1 - var(--mini-p, 0)));
  align-items: center;
  justify-content: center;

  .item-main {
    gap: calc(12px * (1 - var(--mini-p, 0)));
    align-items: center;
    justify-content: center;
  }
}

.item-label,
.status-hint {
  opacity: calc(1 - var(--mini-p-label, 0));
  max-height: calc(60px * (1 - var(--mini-p-label, 0)));
  overflow: hidden;
}

// 布局切换：仅在 progress≥95% 时生效（内容已完全收缩）
.panel-mini-layout {
  .studio-grid {
    display: flex;
    flex-direction: row;
    flex-wrap: nowrap;
    overflow-x: auto;
    overflow-y: hidden;
    padding-bottom: 4px;

    &::-webkit-scrollbar {
      height: 0;
    }
  }

  .studio-item {
    flex-shrink: 0;
    width: 40px;
    min-width: 40px;
    height: 40px;

    // 40px 方块里放不下徽章/提示/编辑按钮，且它们的残留宽度会把图标挤出居中位置
    .edit-btn,
    .status-hint {
      display: none;
    }
  }
}

.studio-item {
  position: relative;
  border-radius: 12px;
  padding: 16px;
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  cursor: pointer;
  transition:
    filter 0.2s ease,
    transform 0.2s ease,
    box-shadow 0.2s ease;
  border: 1px solid transparent;

  &:hover {
    filter: brightness(1.2);
    transform: translateY(-1px);
    box-shadow: 0 4px 12px var(--shadow-color-weak);
  }

  .item-main {
    display: flex;
    flex-direction: column;
    gap: 12px;
    flex: 1;
    min-width: 0;
  }

  .icon-wrapper {
    font-size: 18px;
    color: var(--color-text-primary);
    opacity: 0.9;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .item-label {
    font-size: 13px;
    font-weight: 500;
    color: var(--color-text-primary);
    opacity: 0.95;
  }

  .edit-btn {
    font-size: 14px;
    color: var(--color-text-primary);
    opacity: 0.5;
    background: var(--color-bg-surface-hover);
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    transition: all 0.2s;
    position: absolute;
    right: 8px;
    top: 8px;

    &:hover {
      opacity: 1;
      background: var(--color-bg-surface-hover);
    }
  }

  .status-hint {
    font-size: 11px;
    color: var(--color-text-primary);
    margin-top: 4px;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &.is-generating {
    animation: pulse 2s ease-in-out infinite;
    pointer-events: none;
  }
}

// 窄面板（内容区放不下两列 130px 卡片）时改为紧凑单列行：
// 图标在左、标签在右，避免出现一列"图标上标签下"的超高卡片
@container studio-panel (max-width: 271px) {
  .studio-grid {
    grid-template-columns: 1fr;
    gap: 8px;
  }

  .studio-item {
    align-items: center;
    padding: calc(10px * (1 - var(--mini-p, 0))) calc(12px * (1 - var(--mini-p, 0)));
  }

  .studio-item .item-main {
    flex-direction: row;
    align-items: center;
    justify-content: flex-start;
    gap: calc(10px * (1 - var(--mini-p, 0)));
  }

  .studio-item .icon-wrapper {
    flex-shrink: 0;
  }

  .studio-item .item-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .studio-item .status-hint {
    margin-top: 0;
  }

  // 紧凑行内编辑按钮挂到行尾垂直居中，避免盖住标签
  .studio-item .edit-btn {
    top: 50%;
    bottom: auto;
    transform: translateY(-50%);
    right: 8px;
  }

  .studio-item.has-edit-btn .item-main {
    padding-right: 30px;
  }

  // 收缩成 40px 图标条后恢复居中，标签按收缩进度收拢宽度，避免挤出方块
  .panel-mini-layout .studio-item .item-main {
    justify-content: center;
  }

  .panel-mini-layout .studio-item .item-label {
    max-width: calc(200px * (1 - var(--mini-p-label, 1)));
  }
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.6;
  }
}

/* 产出列表区域 */
// 单一滚动容器
.panel-body {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  min-height: 0;
  padding: 0 20px;
  // 尺寸容器：工具卡片网格按面板实际宽度（而非窗口宽度）切换布局
  container: studio-panel / inline-size;

  &::-webkit-scrollbar {
    width: 4px;
  }

  &::-webkit-scrollbar-thumb {
    background: var(--color-bg-surface-hover);
    border-radius: 2px;
  }
}

// Studio 区：粘附顶部，随滚动进度收缩
.studio-sticky-header {
  position: sticky;
  top: 0;
  z-index: 10;
  padding-top: 20px;
  padding-bottom: calc(16px - 8px * var(--mini-p, 0));
  margin: 0 -20px;
  padding-left: 20px;
  padding-right: 20px;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  text-align: center;
  padding: 20px;

  .magic-icon {
    font-size: 32px;
    margin-bottom: 12px;
  }

  .info-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--color-text-primary);
    margin-bottom: 8px;
  }

  .info-desc {
    font-size: 12px;
    color: var(--color-text-secondary);
    line-height: 1.5;
  }
}

.panel-body > .empty-state:not(.filtered-empty-state) {
  height: auto;
  min-height: 150px;
  padding: 24px 12px 32px;
}

.output-workbench {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.output-toolbar {
  position: sticky;
  top: var(--studio-sticky-h, 56px);
  z-index: 5;
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-md);
  background: var(--color-bg-surface);
  border: 1px solid var(--color-border-subtle);
}

.output-filter-panel {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

.output-filter-field {
  position: relative;
  display: inline-flex;
  align-items: center;
  min-width: 0;
  white-space: nowrap;

  select {
    appearance: none;
    min-width: 0;
    min-height: var(--space-8);
    padding: 0 var(--space-6) 0 var(--space-2);
    border: 1px solid var(--color-border-subtle);
    border-radius: var(--radius-sm);
    background: var(--color-bg-surface-hover);
    color: var(--color-text-secondary);
    font-size: 11px;
    cursor: pointer;

    &:hover {
      border-color: var(--color-border);
      background: var(--color-accent-bg);
    }

    &:focus-visible {
      outline: 2px solid var(--color-border-focus);
      outline-offset: 2px;
    }

    option {
      background: var(--color-accent-bg);
      color: var(--color-accent-text);
    }
  }
}

.output-filter-select-icon {
  position: absolute;
  right: var(--space-2);
  color: var(--color-text-primary);
  font-size: 9px;
  pointer-events: none;
}

.output-type-filter select {
  width: calc(var(--space-20) + var(--space-4));
}

.output-status-filter select,
.output-sort-filter select {
  width: calc(var(--space-20) + var(--space-2));
}

.output-time-filter select {
  width: var(--space-20);
}

.output-sort-filter {
  margin-left: auto;
  padding-left: var(--space-2);
  border-left: 1px solid var(--color-border-subtle);
}

@media (pointer: coarse) {
  .output-filter-field select {
    min-height: calc(var(--space-10) - var(--space-1));
  }
}

@container studio-panel (max-width: 460px) {
  .output-filter-panel {
    flex-wrap: wrap;
  }

  .output-sort-filter {
    margin-left: 0;
  }
}

.output-groups {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.output-group {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.output-group-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 4px;
}

.output-group-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-primary);
  letter-spacing: 0.04em;
}

.output-group-count {
  font-size: 12px;
  color: var(--color-text-secondary);
}

.output-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.output-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 11px 12px;
  background: var(--color-bg-surface-hover);
  border: 1px solid var(--color-border-subtle);
  border-radius: 14px;
  cursor: pointer;
  transition:
    background 0.2s ease,
    border-color 0.2s ease,
    box-shadow 0.2s ease,
    transform 0.2s ease;
  position: relative;

  .more-btn {
    opacity: 0;
    transition: opacity 0.15s ease;
  }

  &:hover {
    background: var(--color-bg-surface-hover);
    border-color: var(--color-border-subtle);
    box-shadow: 0 8px 24px var(--shadow-color-weak);
    transform: translateY(-1px);

    .more-btn {
      opacity: 1;
    }
  }

  &.recently-completed {
    background: var(--color-success-bg);
    border-color: var(--color-success-border);
    animation: pulse-border 2s ease-in-out infinite;
  }

  &.generating .output-icon {
    animation: generating-pulse 1.5s ease-in-out infinite;
  }

  &.failed {
    background: var(--color-danger-bg);
    border-color: var(--color-danger-border);

    .output-icon {
      opacity: 0.65;
    }
  }
}

.completed-badge {
  position: absolute;
  top: -4px;
  right: -4px;
  width: 18px;
  height: 18px;
  background: var(--color-success-solid);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: var(--color-text-primary);
  font-weight: 700;
  box-shadow: 0 2px 6px var(--color-success-border);
  animation: badge-pop 0.3s ease-out;
}

.output-icon {
  position: relative;
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 12px;
  flex-shrink: 0;
  font-size: 16px;
}

.status-dot {
  position: absolute;
  bottom: -2px;
  right: -2px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  box-shadow: 0 0 0 2px var(--shadow-color-strong);

  &.completed {
    background: var(--color-success-solid);
  }

  &.generating {
    background: var(--color-accent-solid);
    animation: dot-pulse 1.5s ease-in-out infinite;
  }

  &.failed {
    background: var(--color-danger-solid);
  }
}

@keyframes dot-pulse {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.5;
    transform: scale(0.75);
  }
}

.output-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.output-title {
  font-size: 13px;
  font-weight: 500;
  line-height: 1.45;
  color: var(--color-text-primary);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.output-footer {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}

.output-type-label {
  font-size: 11px;
  font-weight: 500;
  white-space: nowrap;
}

.footer-sep {
  font-size: 11px;
  color: var(--color-text-muted);
  flex-shrink: 0;
}

.output-time {
  font-size: 11px;
  color: var(--color-text-muted);
  white-space: nowrap;
}

.generating-text {
  font-size: 11px;
  color: var(--color-accent-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.error-text {
  font-size: 11px;
  color: var(--color-danger-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.output-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.output-indicator {
  width: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.output-primary-btn {
  min-width: 68px;
  height: 34px;
  padding: 0 14px;
  border-radius: 999px;
  border: 1px solid var(--color-border-subtle);
  background: var(--color-bg-surface-hover);
  color: var(--color-text-primary);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;

  &:hover {
    background: var(--color-bg-surface-hover);
    border-color: var(--color-border);
  }

  &.completed {
    background: var(--color-accent-bg);
    border-color: var(--color-accent-border);
  }

  &.generating {
    color: var(--color-accent-text);
  }

  &.failed {
    color: var(--color-danger-text);
    background: var(--color-danger-bg);
    border-color: var(--color-danger-border);
  }
}

.more-btn {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-secondary);
  transition: all 0.2s ease;

  &:hover {
    color: var(--color-text-primary);
    background: var(--color-bg-surface-hover);
  }
}

.loading-indicator {
  display: flex;
  align-items: center;
  gap: 3px;

  .dot {
    width: 4px;
    height: 4px;
    background: var(--color-accent-solid);
    border-radius: 50%;
    animation: loading-pulse 1.2s ease-in-out infinite;

    &:nth-child(1) {
      animation-delay: 0s;
    }
    &:nth-child(2) {
      animation-delay: 0.2s;
    }
    &:nth-child(3) {
      animation-delay: 0.4s;
    }
  }
}

.failed-indicator {
  display: flex;
  align-items: center;
  justify-content: center;

  .failed-icon {
    width: 18px;
    height: 18px;
    background: var(--color-danger-bg);
    border: 1px solid var(--color-danger-border);
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    font-weight: 700;
    color: var(--color-danger-text);
  }
}

.filtered-empty-state {
  min-height: 220px;
  border-radius: 16px;
  background: var(--color-bg-surface-hover);
  border: 1px dashed var(--color-border-subtle);
}

.reset-filters-btn {
  margin-top: 14px;
  border: 1px solid var(--color-accent-border);
  background: var(--color-accent-bg);
  color: var(--color-text-primary);
  border-radius: 999px;
  height: 34px;
  padding: 0 16px;
  cursor: pointer;
  transition: all 0.2s ease;

  &:hover {
    background: var(--color-accent-bg);
  }
}

@keyframes loading-pulse {
  0%,
  80%,
  100% {
    opacity: 0.3;
    transform: scale(0.8);
  }
  40% {
    opacity: 1;
    transform: scale(1);
  }
}

@keyframes generating-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
}

/* 思维导图模态框 */
.mindmap-modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: var(--color-bg-scrim);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.mindmap-modal {
  width: 80vw;
  height: 70vh;
  background: var(--color-bg-surface);
  border-radius: 16px;
  display: flex;
  flex-direction: column;
  overflow: hidden;

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    border-bottom: 1px solid var(--color-border-subtle);

    .modal-title {
      font-size: 16px;
      font-weight: 600;
      color: var(--color-text-primary);
    }

    .close-btn {
      background: none;
      border: none;
      color: var(--color-text-secondary);
      font-size: 18px;
      cursor: pointer;
      padding: 4px 8px;
      border-radius: 4px;
      transition: all 0.2s;

      &:hover {
        color: var(--color-text-primary);
        background: var(--color-bg-surface-hover);
      }
    }
  }

  .modal-body {
    flex: 1;
    padding: 20px;
    overflow: hidden;
  }

  .loading-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    gap: 16px;
    color: var(--color-text-secondary);

    .loading-spinner {
      width: 32px;
      height: 32px;
      border: 3px solid var(--color-accent-border);
      border-top-color: var(--color-accent-border);
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }
  }
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@keyframes pulse-border {
  0%,
  100% {
    border-color: var(--color-success-border);
    box-shadow: 0 0 0 0 var(--color-success-border);
  }
  50% {
    border-color: var(--color-success-border);
    box-shadow: 0 0 8px 2px var(--color-success-border);
  }
}

@keyframes badge-pop {
  0% {
    transform: scale(0);
    opacity: 0;
  }
  70% {
    transform: scale(1.2);
  }
  100% {
    transform: scale(1);
    opacity: 1;
  }
}
</style>
