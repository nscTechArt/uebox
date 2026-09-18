<template>
  <aside
    v-if="open"
    ref="paneRef"
    class="agent-browser-pane"
    :class="{ 'is-standalone': standalone }"
    :style="{
      width: standalone ? undefined : paneWidth === undefined ? undefined : `${paneWidth}px`
    }"
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
    <div class="pane-tabs" role="tablist" :aria-label="t('assistant.browserPane.tabs')">
      <div v-if="reviewOpen" class="pane-tab">
        <AppButton
          variant="text"
          size="small"
          role="tab"
          :aria-selected="!!reviewActive"
          :class="{ 'is-selected': reviewActive }"
          @click="emit('selectReview')"
        >
          {{ t('assistant.fileDiff.review') }}
        </AppButton>
        <AppButton
          variant="text"
          size="small"
          :aria-label="t('assistant.fileDiff.closeReview')"
          @click="emit('closeReview')"
          ><template #icon><PhX /></template
        ></AppButton>
      </div>
      <div v-for="tab in group?.tabs ?? []" :key="tab.id" class="pane-tab">
        <AppButton
          variant="text"
          size="small"
          role="tab"
          :aria-selected="!reviewActive && tab.id === group?.activeTabId"
          :title="tab.url"
          :class="{ 'is-selected': !reviewActive && tab.id === group?.activeTabId }"
          @click="runTab({ action: 'select', tabId: tab.id })"
        >
          {{
            tab.title ||
            (tab.url === 'about:blank' ? '' : tab.url) ||
            t('assistant.browserPane.newTab')
          }}
        </AppButton>
        <AppButton
          variant="text"
          size="small"
          :aria-label="t('assistant.browserPane.closeTab')"
          @click="runTab({ action: 'close', tabId: tab.id })"
          ><template #icon><PhX /></template
        ></AppButton>
      </div>
      <AppButton
        v-if="sessionId"
        variant="text"
        size="small"
        :title="t('assistant.browserPane.newTab')"
        :aria-label="t('assistant.browserPane.newTab')"
        @click="runTab({ action: 'create' })"
      >
        <template #icon><PhPlus /></template>
      </AppButton>
    </div>
    <header v-show="!reviewActive" class="pane-header">
      <div class="pane-title" :title="t('assistant.browserPane.title')">
        <PhGlobe />
      </div>
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
        ><template #icon><PhStop v-if="navigation?.loading" /><PhArrowClockwise v-else /></template
      ></AppButton>
      <Input
        ref="addressRef"
        class="pane-address"
        :class="{ 'is-editing': editingAddress }"
        :value="editingAddress ? addressDraft : addressDomain"
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
      <AppButton
        variant="text"
        size="small"
        :title="t(standalone ? 'assistant.browserPane.embed' : 'assistant.browserPane.detach')"
        :aria-label="t(standalone ? 'assistant.browserPane.embed' : 'assistant.browserPane.detach')"
        @click="runTab({ action: 'mode', mode: standalone ? 'embedded' : 'window' })"
      >
        <template #icon><PhArrowsIn v-if="standalone" /><PhArrowSquareOut v-else /></template>
      </AppButton>
      <AppButton variant="text" size="small" class="pane-close" @click="handleClose">
        <template #icon><PhX /></template>
      </AppButton>
    </header>

    <!--
      这块是**占位**，网页并不在这个 div 里。

      嵌入模式下页面是主进程挂在主窗口上的一层 WebContentsView，浮在渲染层
      内容之上 —— 我们只负责把这块的位置量出来报过去（见 measure）。所以
      这里既不能放内容，也不能给它加圆角裁剪：视图不会跟着裁。
    -->
    <div v-show="!reviewActive" ref="surfaceRef" class="pane-surface">
      <span class="pane-hint">{{
        t(dragging ? 'assistant.browserPane.resizing' : 'assistant.browserPane.hint')
      }}</span>
    </div>
    <div v-if="reviewActive" class="pane-review">
      <div class="pane-review-content"><slot name="review" /></div>
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
 *   3. 给用户一个「关闭」。
 *
 * 位置要用**窗口内容区坐标**：`getBoundingClientRect()` 给的正是相对视口的值，
 * 而 WebContentsView 的 bounds 也是相对窗口内容区的，两者对得上。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Input } from 'ant-design-vue'
import { agentBrowserAPI } from '@renderer/api/agentBrowser'
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
  PhStop
} from '@phosphor-icons/vue'
import type {
  BrowserGroupState,
  BrowserTabCommand,
  BrowserNavigationState,
  BrowserToolbarAction
} from '../../../../../shared/agentBrowser'
import { useBrowserPaneResize } from '../composables/useBrowserPaneResize'

const props = defineProps<{
  reviewOpen?: boolean
  reviewActive?: boolean
  group?: BrowserGroupState
  standalone?: boolean
  navigation?: BrowserNavigationState
  sessionId: string
  url?: string
  /** 浏览器此刻开着吗（由父组件按主进程状态给） */
  open: boolean
  /** 助手页面此刻可见吗。切到别的路由要收起来 */
  visible: boolean
}>()
const emit = defineEmits<{ selectReview: []; closeReview: []; selectBrowser: [] }>()

const { t } = useI18n()
const surfaceRef = ref<HTMLElement | null>(null)
const paneRef = ref<HTMLElement | null>(null)
const addressRef = ref<{ select: () => void; blur: () => void } | null>(null)
const currentUrl = ref(props.url ?? '')
const addressDraft = ref('')
const editingAddress = ref(false)
const navigating = ref(false)
const addressDomain = computed(() => {
  try {
    return new URL(currentUrl.value).host.replace(/^www\./, '')
  } catch {
    return ''
  }
})
watch(
  () => props.url,
  (url) => {
    currentUrl.value = url ?? ''
  }
)

async function editAddress(): Promise<void> {
  addressDraft.value = currentUrl.value
  editingAddress.value = true
  await nextTick()
  addressRef.value?.select()
}

function cancelAddress(): void {
  editingAddress.value = false
  addressRef.value?.blur()
}

async function handleAddressKeydown(event: KeyboardEvent): Promise<void> {
  if (event.isComposing) return
  if (event.key === 'Escape') {
    event.preventDefault()
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
  } catch {
    message.error(t('assistant.browserPane.navigationFailed'))
  } finally {
    navigating.value = false
  }
}

const paneShown = computed(() => props.open && props.visible)
const shouldShow = computed(() => paneShown.value && !props.reviewActive && !!props.sessionId)
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
    if (rect.width <= 0 || rect.height <= 0) {
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
      await editAddress()
      addressDraft.value = ''
    }
  } catch {
    message.error(t('assistant.browserPane.navigationFailed'))
  }
}

async function runToolbar(action: BrowserToolbarAction): Promise<void> {
  try {
    await agentBrowserAPI.toolbar(props.sessionId, action)
  } catch {
    message.error(t('assistant.browserPane.navigationFailed'))
  }
}

async function handleClose(): Promise<void> {
  try {
    await window.api.agentBrowser.close(props.sessionId)
  } catch {
    message.error(t('assistant.browserPane.closeFailed'))
  }
}

watch(
  () => [props.open, props.visible, props.reviewActive],
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
  measure()
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', measure)
  window.removeEventListener('scroll', measure, true)
  observer?.disconnect()
  observer = null
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
.pane-tabs {
  display: flex;
  flex-shrink: 0;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-2);
  overflow-x: auto;
  border-bottom: 1px solid var(--color-border-subtle);
}
.pane-tab {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  max-width: 40%;
}
.pane-tab [role='tab'] {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.pane-tab .is-selected {
  background: var(--color-bg-selected);
  color: var(--color-text-primary);
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

.pane-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--color-border-subtle);
}

.pane-title {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--color-text-secondary);
}

.pane-address {
  flex: 1;
  min-width: 0;
  height: var(--space-7);
  border-radius: var(--radius-full);
  border-color: var(--color-border-subtle);
  background: var(--color-bg-sunken);
  color: var(--color-text-primary);
  text-align: center;
  font-size: var(--font-size-sm);
}

.pane-address.is-editing {
  text-align: left;
}

.pane-navigation {
  flex-shrink: 0;
}

.pane-close {
  color: var(--color-text-muted);
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
