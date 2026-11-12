<template>
  <aside
    v-if="open"
    ref="paneRef"
    class="agent-browser-pane"
    :class="{ 'is-standalone': standalone }"
    :style="{
      width: standalone ? undefined : paneWidth === undefined ? undefined : `${paneWidth}px`
    }"
    @keydown="handlePaneKeydown"
  >
    <div
      v-if="!standalone"
      class="pane-resizer"
      :class="{ 'is-dragging': dragging }"
      role="separator"
      aria-orientation="vertical"
      :aria-label="t('assistant.browserPane.resize')"
      :aria-valuemin="minWidth"
      :aria-valuemax="maxWidth"
      :aria-valuenow="paneWidth"
      tabindex="0"
      @pointerdown="startResize"
      @keydown="resizeKeydown"
      @dblclick="resetWidth"
    />
    <div
      ref="tabStripRef"
      class="pane-tabs"
      role="tablist"
      :aria-label="t('assistant.browserPane.tabs')"
      @wheel="scrollTabs"
      @dblclick.self="newTab"
    >
      <div
        v-for="tab in paneTabs"
        :key="tab.key"
        class="pane-tab"
        :class="{
          'is-selected': tab.selected,
          'is-drop-target': dropTarget === tab.key && draggingTab !== tab.key
        }"
        role="tab"
        tabindex="0"
        :aria-selected="tab.selected"
        :title="tab.tooltip"
        :data-tab-key="tab.key"
        :draggable="tab.browserId !== undefined"
        @click="tab.select()"
        @keydown.enter.self="tab.select()"
        @mousedown.middle.prevent
        @auxclick="handleTabAuxClick($event, tab)"
        @dragstart="startTabDrag($event, tab)"
        @dragover="overTab($event, tab)"
        @dragleave="dropTarget = null"
        @drop="dropOnTab($event, tab)"
        @dragend="endTabDrag"
      >
        <span class="pane-tab-icon" aria-hidden="true">
          <PhCircleNotch v-if="tab.loading" class="is-spinning" />
          <img
            v-else-if="tab.favicon && !brokenIcons.has(tab.favicon)"
            :src="tab.favicon"
            alt=""
            draggable="false"
            referrerpolicy="no-referrer"
            @error="brokenIcons.add(tab.favicon)"
          />
          <component :is="tab.icon" v-else />
        </span>
        <span class="pane-tab-title">{{ tab.title }}</span>
        <button
          type="button"
          class="pane-tab-close"
          :aria-label="tab.closeLabel"
          :title="tab.closeLabel"
          @click.stop="tab.close()"
        >
          <PhX />
        </button>
      </div>
      <AppButton
        v-if="sessionId"
        variant="text"
        size="small"
        class="pane-new-tab"
        :title="t('assistant.browserPane.newTab')"
        :aria-label="t('assistant.browserPane.newTab')"
        @click="newTab"
      >
        <template #icon><PhPlus /></template>
      </AppButton>
    </div>
    <header v-show="!panelActive" class="pane-header">
      <AppButton
        variant="text"
        size="small"
        class="pane-navigation"
        data-action="back"
        :disabled="!navigation?.canGoBack"
        :title="t('assistant.browserPane.back')"
        :aria-label="t('assistant.browserPane.back')"
        @click="runToolbar('back')"
        ><template #icon><PhArrowLeft /></template
      ></AppButton>
      <AppButton
        variant="text"
        size="small"
        class="pane-navigation"
        data-action="forward"
        :disabled="!navigation?.canGoForward"
        :title="t('assistant.browserPane.forward')"
        :aria-label="t('assistant.browserPane.forward')"
        @click="runToolbar('forward')"
        ><template #icon><PhArrowRight /></template
      ></AppButton>
      <AppButton
        variant="text"
        size="small"
        class="pane-navigation"
        data-action="reload-stop"
        :title="
          t(navigation?.loading ? 'assistant.browserPane.stop' : 'assistant.browserPane.reload')
        "
        :aria-label="
          t(navigation?.loading ? 'assistant.browserPane.stop' : 'assistant.browserPane.reload')
        "
        @click="runToolbar(navigation?.loading ? 'stop' : 'reload')"
        ><template #icon><PhX v-if="navigation?.loading" /><PhArrowClockwise v-else /></template
      ></AppButton>
      <div class="pane-address-wrap">
        <PhLockSimple v-if="secure && !editingAddress" class="pane-address-lock" />
        <Input
          ref="addressRef"
          class="pane-address"
          :class="{ 'is-editing': editingAddress }"
          :value="editingAddress ? addressDraft : addressDisplay"
          :title="currentUrl"
          :aria-label="t('assistant.browserPane.address')"
          :placeholder="t('assistant.browserPane.addressPlaceholder')"
          :disabled="navigating"
          autocomplete="off"
          :spellcheck="false"
          @focus="editAddress"
          @blur="editingAddress = false"
          @update:value="addressDraft = $event"
          @keydown="handleAddressKeydown"
        />
      </div>
      <AppButton
        v-if="zoomPercent !== null"
        variant="text"
        size="small"
        class="pane-zoom"
        :title="t('assistant.browserPane.resetZoom')"
        @click="runCommand({ name: 'zoomReset' })"
      >
        {{ zoomPercent }}%
      </AppButton>
      <AppButton
        variant="text"
        size="small"
        :title="t(standalone ? 'assistant.browserPane.embed' : 'assistant.browserPane.detach')"
        :aria-label="t(standalone ? 'assistant.browserPane.embed' : 'assistant.browserPane.detach')"
        @click="runTab({ action: 'mode', mode: standalone ? 'embedded' : 'window' })"
      >
        <template #icon><PhArrowsIn v-if="standalone" /><PhArrowSquareOut v-else /></template>
      </AppButton>
      <AppButton
        variant="text"
        size="small"
        class="pane-close"
        :title="t('assistant.browserPane.closeBrowser')"
        :aria-label="t('assistant.browserPane.closeBrowser')"
        @click="handleClose"
      >
        <template #icon><PhX /></template>
      </AppButton>
      <div v-if="navigation?.loading" class="pane-progress" aria-hidden="true" />
    </header>
    <div v-if="findOpen && !panelActive" class="pane-find" role="search">
      <Input
        ref="findRef"
        class="pane-find-input"
        size="small"
        :value="findText"
        :placeholder="t('assistant.browserPane.find')"
        :aria-label="t('assistant.browserPane.find')"
        autocomplete="off"
        :spellcheck="false"
        @update:value="updateFind"
        @keydown="handleFindKeydown"
      />
      <span v-if="findText" class="pane-find-count" :class="{ 'is-empty': find?.matches === 0 }">
        {{ find ? `${find.active}/${find.matches}` : '' }}
      </span>
      <AppButton
        variant="text"
        size="small"
        :disabled="!findText"
        :title="t('assistant.browserPane.findPrevious')"
        :aria-label="t('assistant.browserPane.findPrevious')"
        @click="stepFind(false)"
        ><template #icon><PhCaretUp /></template
      ></AppButton>
      <AppButton
        variant="text"
        size="small"
        :disabled="!findText"
        :title="t('assistant.browserPane.findNext')"
        :aria-label="t('assistant.browserPane.findNext')"
        @click="stepFind(true)"
        ><template #icon><PhCaretDown /></template
      ></AppButton>
      <AppButton
        variant="text"
        size="small"
        :title="t('assistant.browserPane.findClose')"
        :aria-label="t('assistant.browserPane.findClose')"
        @click="closeFind"
        ><template #icon><PhX /></template
      ></AppButton>
    </div>

    <!--
      这块是**占位**，网页并不在这个 div 里。

      嵌入模式下页面是主进程挂在主窗口上的一层 WebContentsView，浮在渲染层
      内容之上 —— 我们只负责把这块的位置量出来报过去（见 measure）。所以
      这里既不能放内容，也不能给它加圆角裁剪：视图不会跟着裁。
    -->
    <div v-show="!panelActive" ref="surfaceRef" class="pane-surface">
      <span class="pane-hint">{{
        t(dragging ? 'assistant.browserPane.resizing' : 'assistant.browserPane.hint')
      }}</span>
    </div>
    <div v-if="reviewActive" class="pane-review">
      <div class="pane-review-content"><slot name="review" /></div>
    </div>
    <div v-else-if="teamActive" class="pane-review">
      <div class="pane-review-content"><slot name="team" /></div>
    </div>
    <div v-else-if="activeReport" class="pane-review">
      <div class="pane-review-content"><slot name="report" /></div>
    </div>
  </aside>
</template>

<script setup lang="ts">
import AppButton from '@renderer/components/AppButton.vue'
import { message } from '@renderer/utils/messageManager'
/**
 * 嵌入模式下的浏览器分屏面板。
 *
 * 它自己不渲染网页，只做三件事：
 *   1. 占住右侧的位置，把这块矩形持续报给主进程；
 *   2. 页面不该露出来的时候（组件卸载、窗口隐藏、切到别的页面）报 null ——
 *      不报的话那层网页会盖在别的界面上面；
 *   3. 浏览器的外壳：标签栏、地址栏、查找条，键位和 Chrome 一致。
 *
 * 位置要用**窗口内容区坐标**：`getBoundingClientRect()` 给的正是相对视口的值，
 * 而 WebContentsView 的 bounds 也是相对窗口内容区的，两者对得上。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import type { Component } from 'vue'
import { Input } from 'ant-design-vue'
import { AgentBrowserActionError, agentBrowserAPI } from '@renderer/api/agentBrowser'
import { useI18n } from 'vue-i18n'
import {
  PhPlus,
  PhArrowsIn,
  PhArrowSquareOut,
  PhGlobe,
  PhX,
  PhArrowLeft,
  PhArrowRight,
  PhArrowClockwise,
  PhCircleNotch,
  PhLockSimple,
  PhCaretUp,
  PhCaretDown,
  PhGitDiff,
  PhUsersThree,
  PhFileText
} from '@phosphor-icons/vue'
import {
  resolveBrowserShortcut,
  type BrowserCommand,
  type BrowserFindState,
  type BrowserGroupState,
  type BrowserTabCommand,
  type BrowserNavigationState,
  type BrowserToolbarAction
} from '../../../../../shared/agentBrowser'
import { useBrowserPaneResize } from '../composables/useBrowserPaneResize'
import type { TeamReportTab } from '../composables/useTeamTab'

const props = defineProps<{
  reviewOpen?: boolean
  reviewActive?: boolean
  /** 工作室对话的「团队任务」页签。和审查一样是渲染层内容，选中时网页让位 */
  teamOpen?: boolean
  teamActive?: boolean
  /** 团队日志里点开的交付，一份一个页签 */
  reports?: TeamReportTab[]
  activeReport?: string | null
  group?: BrowserGroupState
  standalone?: boolean
  navigation?: BrowserNavigationState
  /** 页内查找的结果，主进程随状态推过来 */
  find?: BrowserFindState | null
  sessionId: string
  url?: string
  /** 浏览器此刻开着吗（由父组件按主进程状态给） */
  open: boolean
  /** 助手页面此刻可见吗。切到别的路由要收起来 */
  visible: boolean
}>()
const emit = defineEmits<{
  selectReview: []
  closeReview: []
  selectTeam: []
  closeTeam: []
  selectReport: [report: TeamReportTab]
  closeReport: [id: string]
  selectBrowser: []
}>()

const { t } = useI18n()
const platform = window.api?.platform ?? ''
const surfaceRef = ref<HTMLElement | null>(null)
const paneRef = ref<HTMLElement | null>(null)
const tabStripRef = ref<HTMLElement | null>(null)
const addressRef = ref<{ focus: () => void; select: () => void; blur: () => void } | null>(null)
const findRef = ref<{ focus: () => void; select: () => void } | null>(null)
const currentUrl = ref(props.url ?? '')
const addressDraft = ref('')
const editingAddress = ref(false)
const navigating = ref(false)
/** 加载失败的图标地址，换回地球图标，别显示一个裂图 */
const brokenIcons = reactive(new Set<string>())

const parsedUrl = computed(() => {
  try {
    return new URL(currentUrl.value)
  } catch {
    return null
  }
})
/** 没在编辑时只显示域名和路径，协议和 www 省掉 —— 和现代浏览器一样 */
const addressDisplay = computed(() => {
  const url = parsedUrl.value
  if (!url || !/^https?:$/.test(url.protocol)) return ''
  const path = url.pathname === '/' && !url.search ? '' : `${url.pathname}${url.search}`
  const shown = `${url.host.replace(/^www\./, '')}${path}`
  // 中文搜索词显示成 %E6%9D%90 没法读，浏览器都会解码给人看
  try {
    return decodeURI(shown)
  } catch {
    return shown
  }
})
const secure = computed(() => parsedUrl.value?.protocol === 'https:')
const zoomPercent = computed(() => {
  const zoom = props.navigation?.zoom
  return zoom && Math.abs(zoom - 1) > 0.001 ? Math.round(zoom * 100) : null
})
watch(
  () => props.url,
  (url) => {
    currentUrl.value = url ?? ''
  }
)

interface PaneTab {
  key: string
  title: string
  tooltip: string
  selected: boolean
  loading?: boolean
  favicon?: string
  icon: Component
  closeLabel: string
  /** 只有网页标签能拖动换位置 */
  browserId?: string
  select: () => void
  close: () => void
}

/** 审查、团队任务、交付和网页标签排在同一条标签栏里，长相和行为一致 */
const paneTabs = computed<PaneTab[]>(() => {
  const tabs: PaneTab[] = []
  if (props.reviewOpen) {
    tabs.push({
      key: 'review',
      title: t('assistant.fileDiff.review'),
      tooltip: t('assistant.fileDiff.review'),
      selected: !!props.reviewActive,
      icon: PhGitDiff,
      closeLabel: t('assistant.fileDiff.closeReview'),
      select: () => emit('selectReview'),
      close: () => emit('closeReview')
    })
  }
  if (props.teamOpen) {
    tabs.push({
      key: 'team',
      title: t('assistant.teamBoard.tab'),
      tooltip: t('assistant.teamBoard.tab'),
      selected: !!props.teamActive,
      icon: PhUsersThree,
      closeLabel: t('assistant.teamBoard.closeTab'),
      select: () => emit('selectTeam'),
      close: () => emit('closeTeam')
    })
  }
  for (const report of props.reports ?? []) {
    tabs.push({
      key: `report:${report.id}`,
      title: report.title,
      tooltip: report.title,
      selected: props.activeReport === report.id,
      icon: PhFileText,
      closeLabel: t('assistant.teamBoard.closeReport'),
      select: () => emit('selectReport', report),
      close: () => emit('closeReport', report.id)
    })
  }
  for (const tab of props.group?.tabs ?? []) {
    const title =
      tab.title || (tab.url === 'about:blank' ? '' : tab.url) || t('assistant.browserPane.newTab')
    tabs.push({
      key: tab.id,
      title,
      tooltip: tab.url && tab.url !== 'about:blank' ? `${title}\n${tab.url}` : title,
      selected: !panelActive.value && tab.id === props.group?.activeTabId,
      loading: tab.loading,
      favicon: tab.favicon,
      icon: PhGlobe,
      closeLabel: t('assistant.browserPane.closeTab'),
      browserId: tab.id,
      select: () => void runTab({ action: 'select', tabId: tab.id }),
      close: () => void runTab({ action: 'close', tabId: tab.id })
    })
  }
  return tabs
})

/** 中键关标签，和浏览器一样 */
function handleTabAuxClick(event: MouseEvent, tab: PaneTab): void {
  if (event.button !== 1) return
  event.preventDefault()
  tab.close()
}

/** 鼠标竖着滚也能横着翻标签 */
function scrollTabs(event: WheelEvent): void {
  const strip = tabStripRef.value
  if (!strip || strip.scrollWidth <= strip.clientWidth || event.deltaX !== 0) return
  strip.scrollLeft += event.deltaY
  event.preventDefault()
}

// 切到的标签可能在可视区外面（Ctrl+Tab、Agent 新开的标签）
watch(
  () => paneTabs.value.find((tab) => tab.selected)?.key,
  async (key) => {
    if (!key) return
    await nextTick()
    tabStripRef.value
      ?.querySelector<HTMLElement>(`[data-tab-key="${CSS.escape(key)}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }
)

const draggingTab = ref<string | null>(null)
const dropTarget = ref<string | null>(null)

function startTabDrag(event: DragEvent, tab: PaneTab): void {
  if (!tab.browserId) {
    event.preventDefault()
    return
  }
  draggingTab.value = tab.browserId
  event.dataTransfer?.setData('text/plain', tab.browserId)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

function overTab(event: DragEvent, tab: PaneTab): void {
  if (!draggingTab.value || !tab.browserId) return
  event.preventDefault()
  dropTarget.value = tab.key
}

function dropOnTab(event: DragEvent, tab: PaneTab): void {
  const tabId = draggingTab.value
  endTabDrag()
  if (!tabId || !tab.browserId || tabId === tab.browserId) return
  event.preventDefault()
  const index = (props.group?.tabs ?? []).findIndex((item) => item.id === tab.browserId)
  if (index >= 0) void runTab({ action: 'move', tabId, index })
}

function endTabDrag(): void {
  draggingTab.value = null
  dropTarget.value = null
}

async function editAddress(): Promise<void> {
  addressDraft.value = currentUrl.value === 'about:blank' ? '' : currentUrl.value
  editingAddress.value = true
  await nextTick()
  addressRef.value?.select()
}

/** Ctrl+L / F6：把焦点放进地址栏并全选 */
async function focusAddress(): Promise<void> {
  addressRef.value?.focus()
  await editAddress()
}

function cancelAddress(): void {
  editingAddress.value = false
  addressRef.value?.blur()
}

async function handleAddressKeydown(event: KeyboardEvent): Promise<void> {
  if (event.isComposing) return
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    cancelAddress()
  } else if (event.key === 'Enter') {
    await submitAddress(event)
  }
}

async function submitAddress(event: KeyboardEvent): Promise<void> {
  if (event.isComposing || navigating.value) return
  event.preventDefault()
  const address = addressDraft.value.trim()
  if (!address) {
    cancelAddress()
    return
  }
  navigating.value = true
  try {
    const result = await agentBrowserAPI.openUrl(props.sessionId, address)
    currentUrl.value = result.url
    cancelAddress()
  } catch (error) {
    showFailure(error, 'assistant.browserPane.navigationFailed')
  } finally {
    navigating.value = false
  }
}

const findOpen = ref(false)
const findText = ref('')

async function openFind(): Promise<void> {
  findOpen.value = true
  await nextTick()
  findRef.value?.focus()
  findRef.value?.select()
  if (findText.value) runFind({ text: findText.value })
}

function runFind(query: { text: string; forward?: boolean; findNext?: boolean } | null): void {
  if (!props.sessionId) return
  void window.api.agentBrowser.find(props.sessionId, query).catch(() => undefined)
}

function updateFind(text: string): void {
  findText.value = text
  runFind(text ? { text } : null)
}

function stepFind(forward: boolean): void {
  if (findText.value) runFind({ text: findText.value, forward, findNext: true })
}

function closeFind(): void {
  if (!findOpen.value) return
  findOpen.value = false
  runFind(null)
}

function handleFindKeydown(event: KeyboardEvent): void {
  if (event.isComposing) return
  if (event.key === 'Enter') {
    event.preventDefault()
    stepFind(!event.shiftKey)
  } else if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    closeFind()
  }
}

// 主进程换标签时已经把高亮收了，查找条跟着关
watch(
  () => props.group?.activeTabId,
  () => {
    findOpen.value = false
  }
)

const paneShown = computed(() => props.open && props.visible)
/** 选中的是渲染层自己画的页签（审查 / 团队任务 / 交付），网页那层要收起来 */
const panelActive = computed(
  () => !!props.reviewActive || !!props.teamActive || !!props.activeReport
)
const shouldShow = computed(() => paneShown.value && !panelActive.value && !!props.sessionId)
const {
  width: paneWidth,
  minWidth,
  maxWidth,
  dragging,
  start: startResize,
  reset: resetWidth,
  keydown: resizeKeydown
} = useBrowserPaneResize(paneRef, paneShown)

// WebContentsView 在 DOM 上方，拖动时先隐藏，避免移到网页上丢失鼠标事件。
// 松手后 ResizeObserver/measure 按最终矩形恢复，页面实例和滚动位置都保留。
watch(
  dragging,
  (value) => {
    if (value && props.sessionId) window.api.agentBrowser.setBounds(null, props.sessionId)
    else measure()
  },
  { flush: 'sync' }
)

let observer: ResizeObserver | null = null
let frame = 0

/**
 * 弹窗、下拉、右键菜单都 Teleport 到 body 下，而那层网页是原生视图，永远盖在 DOM 上。
 * 有浮层压到面板上时先把网页收起来，浮层关掉再按原位置放回。
 */
let overlayObserver: MutationObserver | null = null
let offUi: (() => void) | null = null

function intersects(a: DOMRect, b: DOMRect): boolean {
  return (
    a.width > 0 &&
    a.height > 0 &&
    a.left < b.right &&
    a.right > b.left &&
    a.top < b.bottom &&
    a.bottom > b.top
  )
}

function overlayCovers(surface: HTMLElement, target: DOMRect): boolean {
  return Array.from(document.body.children).some(
    (node) =>
      !node.contains(surface) &&
      node.tagName !== 'SCRIPT' &&
      node.tagName !== 'STYLE' &&
      [node, ...Array.from(node.children)].some((el) =>
        intersects(el.getBoundingClientRect(), target)
      )
  )
}

/**
 * 把当前位置报给主进程。
 *
 * 用 rAF 合并：拖动窗口和调分栏宽度时 resize 事件密集得多，逐个发 IPC
 * 只会让那层视图跟不上手。
 */
function measure(): void {
  if (!props.sessionId) return
  if (frame) cancelAnimationFrame(frame)
  frame = requestAnimationFrame(() => {
    frame = 0
    const element = surfaceRef.value
    if (!shouldShow.value || dragging.value || !element) {
      window.api?.agentBrowser?.setBounds?.(null, props.sessionId)
      return
    }

    const rect = element.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0 || overlayCovers(element, rect)) {
      window.api?.agentBrowser?.setBounds?.(null, props.sessionId)
      return
    }

    window.api?.agentBrowser?.setBounds?.(
      {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      },
      props.sessionId
    )
  })
}

async function runTab(command: BrowserTabCommand): Promise<void> {
  try {
    await agentBrowserAPI.tab(props.sessionId, command)
    if (command.action === 'select' || command.action === 'create') emit('selectBrowser')
    if (command.action === 'create') {
      await focusAddress()
      addressDraft.value = ''
    }
  } catch (error) {
    showFailure(error, 'assistant.browserPane.actionFailed')
  }
}

function newTab(): void {
  if (props.sessionId) void runTab({ action: 'create' })
}

async function runToolbar(action: BrowserToolbarAction): Promise<void> {
  try {
    await agentBrowserAPI.toolbar(props.sessionId, action)
  } catch (error) {
    showFailure(error, 'assistant.browserPane.actionFailed')
  }
}

async function runCommand(command: BrowserCommand): Promise<void> {
  try {
    await agentBrowserAPI.command(props.sessionId, command)
  } catch (error) {
    showFailure(error, 'assistant.browserPane.actionFailed')
  }
}

/**
 * 焦点在面板上（标签、地址栏、按钮）时的浏览器快捷键。
 *
 * 焦点在网页里时按键到不了这里，由主进程拦下同一张表（`resolveBrowserShortcut`）。
 * 地址栏和查找条自己的 Esc 先处理掉了，这里只在它们没接的时候才把 Esc 当「停止加载」。
 */
function handlePaneKeydown(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.isComposing || !props.sessionId || panelActive.value) return
  const command = resolveBrowserShortcut(
    {
      key: event.key,
      control: event.ctrlKey,
      meta: event.metaKey,
      shift: event.shiftKey,
      alt: event.altKey
    },
    platform
  )
  if (!command || (command.name === 'stop' && !props.navigation?.loading)) return
  event.preventDefault()
  event.stopPropagation()
  if (command.name === 'focusAddress') void focusAddress()
  else if (command.name === 'find') void openFind()
  else if (command.name === 'newTab') newTab()
  else void runCommand(command)
}

/** 助手正占着浏览器时，点什么都会被拒 —— 那时要说清是在等它，而不是网址或网络有问题 */
function showFailure(error: unknown, fallback: string): void {
  const busy = error instanceof AgentBrowserActionError && error.code === 'BROWSER_BUSY'
  message.error(t(busy ? 'assistant.browserPane.busy' : fallback))
}

async function handleClose(): Promise<void> {
  try {
    await window.api.agentBrowser.close(props.sessionId)
  } catch {
    message.error(t('assistant.browserPane.closeFailed'))
  }
}

watch(
  () => [props.open, props.visible, panelActive.value],
  () => {
    if (!shouldShow.value && props.sessionId)
      window.api?.agentBrowser?.setBounds?.(null, props.sessionId)
    // 等这一帧的布局落定再量，否则拿到的是上一帧的位置
    requestAnimationFrame(measure)
  }
)

watch(surfaceRef, (element) => {
  observer?.disconnect()
  if (!element) return
  observer = new ResizeObserver(measure)
  observer.observe(element)
  measure()
})

onMounted(() => {
  window.addEventListener('resize', measure)
  // 滚动会改变面板在视口里的位置，而那层视图不会跟着滚
  window.addEventListener('scroll', measure, true)
  // 浮层出现/定位完成都要重查；动画中的位置变化靠 attributes 捕获
  const app = document.getElementById('app')
  overlayObserver = new MutationObserver((records) => {
    // #app 里的变化（比如对话流式输出）与浮层无关，不必每次都量
    if (records.every((r) => r.target !== document.body && app?.contains(r.target))) return
    measure()
  })
  overlayObserver.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['style', 'class']
  })
  // 焦点在网页里按了 Ctrl+L / Ctrl+F / Ctrl+T：主进程把焦点交回来，这里打开对应的输入框
  const onUi = (...args: unknown[]): void => {
    const request = args[0] as { sessionId?: string; action?: string } | undefined
    if (!request || request.sessionId !== props.sessionId || !shouldShow.value) return
    if (request.action === 'focusAddress') void focusAddress()
    else if (request.action === 'find') void openFind()
  }
  const handler = window.api?.on?.('agent-browser:ui', onUi)
  offUi = () => window.api?.off?.('agent-browser:ui', handler)
  measure()
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', measure)
  window.removeEventListener('scroll', measure, true)
  observer?.disconnect()
  observer = null
  overlayObserver?.disconnect()
  overlayObserver = null
  offUi?.()
  offUi = null
  if (frame) cancelAnimationFrame(frame)
  // 组件没了，那层网页也不能继续浮在界面上
  if (props.sessionId) window.api?.agentBrowser?.setBounds?.(null, props.sessionId)
})
</script>

<style scoped>
.pane-review {
  flex: 1;
  position: relative;
  min-height: 0;
}
.pane-review-content {
  position: absolute;
  inset: 0;
}
.agent-browser-pane.is-standalone {
  width: 100%;
  height: 100vh;
  border: none;
}

/* ── 标签栏：像 Chrome 一样均分宽度，挤不下再横向滚 ─────────────── */
.pane-tabs {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 2px;
  padding: var(--space-1) var(--space-2) 0;
  overflow-x: auto;
  scrollbar-width: none;
  background: var(--color-bg-page);
}
.pane-tabs::-webkit-scrollbar {
  display: none;
}
.pane-tab {
  position: relative;
  display: flex;
  flex: 0 1 200px;
  align-items: center;
  gap: 6px;
  min-width: 56px;
  height: 30px;
  padding: 0 4px 0 10px;
  border-radius: var(--radius-md) var(--radius-md) 0 0;
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  cursor: default;
  user-select: none;
  transition: background var(--motion-fast);
}
.pane-tab:hover {
  background: color-mix(in srgb, var(--color-bg-surface) 55%, var(--color-bg-page));
}
.pane-tab:focus-visible {
  outline: 2px solid var(--color-border-focus);
  outline-offset: -2px;
}
.pane-tab.is-selected {
  background: var(--color-bg-surface);
  color: var(--color-text-primary);
}
.pane-tab.is-drop-target {
  box-shadow: inset 2px 0 0 var(--color-accent-solid);
}
.pane-tab-icon {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  font-size: 14px;
}
.pane-tab-icon img {
  width: 16px;
  height: 16px;
  object-fit: contain;
}
.pane-tab-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  /* 标题尾部淡出，比省略号更接近浏览器 */
  mask-image: linear-gradient(to right, black calc(100% - 16px), transparent);
}
.pane-tab-close {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--color-text-muted);
  font-size: 12px;
  opacity: 0;
  cursor: pointer;
}
.pane-tab:hover .pane-tab-close,
.pane-tab.is-selected .pane-tab-close,
.pane-tab-close:focus-visible {
  opacity: 1;
}
.pane-tab-close:hover {
  background: var(--color-bg-soft-hover);
  color: var(--color-text-primary);
}
.pane-new-tab {
  flex-shrink: 0;
}
.is-spinning {
  animation: pane-spin 0.8s linear infinite;
}
@keyframes pane-spin {
  to {
    transform: rotate(360deg);
  }
}

.agent-browser-pane {
  position: relative;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  width: min(52%, 900px);
  min-width: 0;
  /* 父级只有 min-height；保持 auto 高度，才能沿横向 flex 的交叉轴拉满。 */
  align-self: stretch;
  min-height: 0;
  border-left: 1px solid var(--color-border-subtle);
  background: var(--color-bg-surface);
}

.pane-resizer {
  position: absolute;
  inset-block: 0;
  right: 100%;
  width: var(--space-2);
  cursor: col-resize;
  touch-action: none;
  user-select: none;
}

.pane-resizer::after {
  content: '';
  position: absolute;
  inset-block: 0;
  right: 0;
  width: 1px;
  background: var(--color-border-subtle);
}

.pane-resizer:hover::after,
.pane-resizer:focus-visible::after,
.pane-resizer.is-dragging::after {
  width: var(--space-1);
  background: var(--color-border-strong);
}

.pane-resizer:focus-visible {
  outline: none;
}

/* ── 工具栏 ─────────────────────────────────────────────────────── */
.pane-header {
  position: relative;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: var(--space-1) var(--space-2);
  border-bottom: 1px solid var(--color-border-subtle);
}

.pane-address-wrap {
  position: relative;
  display: flex;
  flex: 1;
  align-items: center;
  min-width: 0;
  margin: 0 var(--space-1);
}

.pane-address-lock {
  position: absolute;
  left: 12px;
  z-index: 1;
  font-size: 12px;
  color: var(--color-text-muted);
  pointer-events: none;
}

.pane-address {
  flex: 1;
  min-width: 0;
  height: var(--space-7);
  padding-left: 30px;
  border-radius: var(--radius-full);
  border-color: transparent;
  background: var(--color-bg-page);
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
}

.pane-address:hover {
  border-color: var(--color-border-subtle);
}

.pane-address.is-editing {
  padding-left: 12px;
  border-color: var(--color-border-focus);
  background: var(--color-bg-surface);
}

.pane-navigation {
  flex-shrink: 0;
}

.pane-zoom {
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}

.pane-close {
  color: var(--color-text-muted);
}

/* 加载中的细进度条。Electron 不报加载进度，用来回扫的不定进度 */
.pane-progress {
  position: absolute;
  right: 0;
  bottom: -1px;
  left: 0;
  height: 2px;
  overflow: hidden;
  pointer-events: none;
}
.pane-progress::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 40%;
  background: var(--color-accent-solid);
  animation: pane-progress 1.2s ease-in-out infinite;
}
@keyframes pane-progress {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(250%);
  }
}
@media (prefers-reduced-motion: reduce) {
  .pane-progress::after {
    width: 100%;
    animation: none;
    opacity: 0.6;
  }
  .is-spinning {
    animation: none;
  }
}

/* ── 查找条 ─────────────────────────────────────────────────────── */
.pane-find {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: var(--space-1) var(--space-2);
  border-bottom: 1px solid var(--color-border-subtle);
}
.pane-find-input {
  flex: 1;
  min-width: 0;
  max-width: 280px;
  margin-right: auto;
}
.pane-find-count {
  padding: 0 var(--space-2);
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
  font-variant-numeric: tabular-nums;
}
.pane-find-count.is-empty {
  color: var(--color-danger-text);
}

.pane-surface {
  position: relative;
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 0;
  /* 网页由主进程盖在这块上面，这里的内容只有在它还没加载出来时才看得见 */
  background: var(--color-bg-sunken);
}

.pane-hint {
  font-size: 12px;
  color: var(--color-text-muted);
}
</style>
