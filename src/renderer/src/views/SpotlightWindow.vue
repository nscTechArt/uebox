<template>
  <div class="spotlight-window" @keydown="handleKeyDown">
    <div class="spotlight-container">
      <!-- 输入框 -->
      <div class="spotlight-input-wrapper">
        <!-- 图标就是状态指示器：放大镜 = 在打字，麦克风 = 正在收音。
             脉动跟着实时响度走，用户据此知道麦克风真的听见了他 -->
        <PhMicrophone
          v-if="dictating"
          class="search-icon mic-icon"
          :class="{ 'is-listening': dictation.state.value === 'listening' }"
          :style="{ '--mic-level': micPulse }"
          :aria-label="t('spotlightWindow.dictation.micIconLabel')"
        />
        <PhMagnifyingGlass v-else class="search-icon" />
        <textarea
          ref="inputRef"
          v-model="query"
          class="spotlight-input"
          :placeholder="t('spotlightWindow.inputPlaceholder')"
          autocomplete="off"
          spellcheck="false"
          rows="1"
          @input="handleInput"
          @keydown.enter.exact.prevent="handleEnter"
          @keydown.shift.enter.stop
        ></textarea>
        <PhCircleNotch v-if="isSearching" class="icon-spin loading-icon" />
        <!-- 拖拽手柄 -->
        <div class="drag-handle" :title="t('spotlightWindow.dragHandleTitle')">
          <PhArrowsOutCardinal />
        </div>
      </div>

      <!-- 结果列表 -->
      <div v-if="results.length > 0" class="spotlight-results">
        <div
          v-for="(item, index) in results"
          :key="item.id"
          :class="['result-item', { selected: index === selectedIndex }]"
          @click="executeAt(index)"
          @mouseenter="selectedIndex = index"
        >
          <div class="result-icon">
            <component :is="getResultIcon(item.icon)" />
          </div>
          <div class="result-content">
            <div class="result-title">{{ item.title }}</div>
            <div v-if="item.description" class="result-description">
              {{ item.description }}
            </div>
          </div>
          <div class="result-hint">↵</div>
        </div>
      </div>

      <!-- 听写状态条。只在语音这一路出现，打字时一行都不占 -->
      <div v-if="dictationHint" class="spotlight-hint">
        <span>{{ dictationHint }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  PhArchive,
  PhArrowsOutCardinal,
  PhBookOpen,
  PhCircleNotch,
  PhFile,
  PhImage,
  PhMagnifyingGlass,
  PhMicrophone,
  PhPalette,
  PhRobot,
  PhSpeakerHigh,
  PhSquaresFour
} from '@phosphor-icons/vue'
import type { Component } from 'vue'
import { spotlightAPI } from '@renderer/api/spotlight'
import { useVoiceDictation } from '@renderer/composables/useVoiceDictation'
import { useAIConfigStore } from '@renderer/store/modules/aiConfig'
import type { SpotlightSearchResult as ResultItem } from '@core/shared/spotlight'

/**
 * Spotlight 独立窗口页面
 * 用于系统级全局快捷键唤起，支持多维度搜索
 */

const { t } = useI18n()

const query = ref('')
const results = ref<ResultItem[]>([])
const selectedIndex = ref(0)
const isSearching = ref(false)
const inputRef = ref<HTMLTextAreaElement | null>(null)

// 搜索防抖定时器
let searchTimeout: ReturnType<typeof setTimeout> | null = null
let unsubscribeShow: (() => void) | null = null
let unsubscribeHide: (() => void) | null = null

/* ── 语音听写 ───────────────────────────────────────────────────────────── */

/**
 * 说完之后等这么久再提交。
 *
 * 这一路的意义就在这两秒：转写有可能听岔，而 Agent 拿到的是会动工程的指令。
 * 两秒够看清一句话，也短到不用动手 —— 一动键盘倒计时就推迟（`handleInput`），
 * 所以「要改」的人永远不会被抢在前面提交。
 */
const DICTATION_SUBMIT_DELAY_MS = 2_000

/** 这一次唤起是不是语音的。打字唤起时整条听写链路一个字节都不加载 */
const dictating = ref(false)
/** 倒计时还剩几秒。0 表示没在倒计时 */
const submitCountdown = ref(0)
/** 退回打字、或者没听清时的一句话。空字符串表示不显示状态条 */
const dictationNotice = ref('')

let submitTimer: ReturnType<typeof setInterval> | null = null
/**
 * 这一轮听到过话没有。
 *
 * 「倒计时该不该重起」判的是它，**不是「倒计时还在跑吗」**。用户把输入框整句删掉
 * 重打时，倒计时已经被自己停掉了（空内容不该提交），拿「还在跑吗」当判据的话
 * 它从此再也起不来 —— 状态条还写着「说完自动提交」，而那句话永远不会发出去。
 */
let submitArmed = false

const dictation = useVoiceDictation({
  // 和语音通话读同一个偏好。不带的话浏览器给系统默认设备，用户挑的那个麦白挑了
  microphoneDeviceId: () => useAIConfigStore().voiceMicrophoneDeviceId,
  onText: (text) => {
    /*
     * 追加而不是覆盖。VAD 把一段长指令切成两轮是常事（中间停顿想词超过了
     * 判停时长），覆盖的话用户会眼睁睁看着前半句消失。
     */
    query.value = query.value ? `${query.value} ${text}` : text
    dictationNotice.value = ''
    nextTick(adjustHeight)
    submitArmed = true
    startSubmitCountdown()
  },
  onUnheard: () => {
    dictationNotice.value = t('spotlightWindow.dictation.unheard')
  },
  onError: (message) => {
    dictationNotice.value = message || t('spotlightWindow.dictation.unavailable')
    dictating.value = false
  }
})

/** 响度映射成脉动幅度。开平方是因为人耳对响度的感觉是压缩的，线性映射看着太迟钝 */
const micPulse = computed(() => Math.min(1, Math.sqrt(dictation.level.value * 6)).toFixed(3))

const dictationHint = computed(() => {
  if (dictationNotice.value) return dictationNotice.value
  if (submitCountdown.value > 0) {
    return t('spotlightWindow.dictation.autoSubmit', { seconds: submitCountdown.value })
  }
  if (!dictating.value) return ''
  return dictation.state.value === 'listening'
    ? t('spotlightWindow.dictation.listening')
    : t('spotlightWindow.dictation.starting')
})

function clearSubmitCountdown(): void {
  if (submitTimer) clearInterval(submitTimer)
  submitTimer = null
  submitCountdown.value = 0
}

/**
 * 起（或者重起）自动提交的倒计时。
 *
 * 做成每秒一跳的可见倒计时而不是一个哑定时器：用户得看得见还剩多久，
 * 否则「它什么时候会自己发出去」只能靠试，而试错的代价是一条已经跑起来的指令。
 */
function startSubmitCountdown(): void {
  clearSubmitCountdown()
  if (!query.value.trim()) return
  submitCountdown.value = Math.round(DICTATION_SUBMIT_DELAY_MS / 1000)
  submitTimer = setInterval(() => {
    submitCountdown.value -= 1
    if (submitCountdown.value > 0) return
    clearSubmitCountdown()
    void submitDictated()
  }, 1000)
}

/** 倒计时跑完：收掉麦克风，把这句话交出去 */
async function submitDictated(): Promise<void> {
  const message = query.value.trim()
  await endDictation()
  if (!message) return
  spotlightAPI.execute('ai', { message })
}

/**
 * 收掉听写。重复调用无害。
 *
 * **没在听就什么都不做。** 这一路的 `stop()` 会去关主进程那条全局会话，而
 * 普通打字唤起 Spotlight（以及每一次关窗、回车、卸载）走的也是这个出口 ——
 * 不拦的话，开一次搜索框就把助手页正在进行的通话挂断了，而且原主收不到任何事件。
 */
async function endDictation(): Promise<void> {
  clearSubmitCountdown()
  submitArmed = false
  dictating.value = false
  if (dictation.state.value === 'idle') return
  await dictation.stop()
}

/**
 * 热键唤起：开麦。
 *
 * 开不起来的两类原因（助手页正在通话、绑的模型做不了只转写）**不报错**，
 * 退回普通打字：图标退回放大镜，状态条给一句话说明这会儿没在听。
 * 用户按热键的那一下本来就是「顺手」，顺手的操作不配弹一个错误框。
 */
async function beginDictation(): Promise<void> {
  dictationNotice.value = ''
  dictating.value = true
  const failure = await dictation.start()
  if (!failure) return
  dictating.value = false
  if (failure === 'busy' || failure === 'vendor-unsupported') {
    dictationNotice.value = t('spotlightWindow.dictation.unavailable')
  }
  // 其余几类 `start` 已经通过 onError 把话说清楚了，这里不再覆盖它
}

/**
 * 处理输入并自动调整高度
 */
function handleInput(): void {
  // 用户动手了：自动提交往后推。正在改一句话的时候被抢着发出去是最糟的一种失败。
  // 判据见 `submitArmed` —— 不能拿「倒计时还在跑吗」来判
  if (submitArmed) startSubmitCountdown()
  adjustHeight()
  handleSearch()
}

/**
 * 自动调整输入框高度
 */
function adjustHeight(): void {
  const el = inputRef.value
  if (!el) return

  // 重置高度以计算正确的 scrollHeight
  el.style.height = 'auto'
  // 限制最大高度，两行大约 48px (16px * 1.5 * 2)
  const newHeight = Math.min(el.scrollHeight, 48)
  el.style.height = `${newHeight}px`

  // 如果内容高度超过最大高度，显示滚动条
  el.style.overflowY = el.scrollHeight > newHeight ? 'auto' : 'hidden'
}

/**
 * 处理搜索（调用主进程搜索 IPC）
 */
async function handleSearch(): Promise<void> {
  const q = query.value.trim()

  // 清除之前的定时器
  if (searchTimeout) {
    clearTimeout(searchTimeout)
  }

  if (!q) {
    results.value = []
    isSearching.value = false
    // 重置高度
    if (inputRef.value) inputRef.value.style.height = 'auto'
    return
  }

  // 防抖 150ms
  searchTimeout = setTimeout(async () => {
    isSearching.value = true

    try {
      // 调用主进程搜索接口
      results.value = await spotlightAPI.search(q)
      selectedIndex.value = 0
    } catch (error) {
      console.error('[Spotlight] 搜索失败:', error)
      // 搜索失败时提供 AI 兜底
      results.value = [
        {
          id: `ai-${Date.now()}`,
          type: 'ai',
          title: t('spotlightWindow.aiFallback.title', { query: q }),
          description: t('spotlightWindow.aiFallback.description'),
          icon: 'robot',
          data: { message: q }
        }
      ]
    } finally {
      isSearching.value = false
    }
  }, 150)
}

/**
 * 执行选中项
 */
function executeAt(index: number): void {
  const item = results.value[index]
  if (item) {
    // 通过 IPC 发送到主进程，传递类型和数据
    // 使用 JSON 序列化确保数据可通过 IPC 传输
    const cleanData = JSON.parse(JSON.stringify(item.data || {}))
    spotlightAPI.execute(item.type, cleanData)
  }
}

/**
 * 图标类型到 Ant Design 图标组件的映射
 */
const iconMap: Record<string, Component> = {
  robot: PhRobot,
  book: PhBookOpen,
  project: PhSquaresFour,
  model: PhPalette,
  image: PhImage,
  audio: PhSpeakerHigh,
  package: PhArchive,
  file: PhFile
}

/**
 * 根据图标类型获取对应的 Ant Design 图标组件
 * @param iconType 图标类型标识符
 * @returns 对应的图标组件
 */
function getResultIcon(iconType: string): Component {
  return iconMap[iconType] || PhFile
}

/**
 * 执行当前选中项或直接发送
 */
function executeSelected(): void {
  if (results.value.length > 0) {
    executeAt(selectedIndex.value)
  } else if (query.value.trim()) {
    // 没有结果时直接发送 AI 消息
    spotlightAPI.execute('ai', {
      message: query.value.trim()
    })
  }
}

/**
 * 关闭窗口
 */
function closeWindow(): void {
  query.value = ''
  results.value = []
  selectedIndex.value = 0
  // Esc 要能救场：听岔了、或者根本不想发了，这一下必须把麦克风也关掉
  void endDictation()
  spotlightAPI.close()
}

/**
 * 键盘事件处理
 */
/**
 * 处理 Enter 键
 */
function handleEnter(): void {
  // 手动回车压过倒计时。用户已经确认过了，没必要再让他等完那两秒。
  // 走 `endDictation` 而不是自己拼一遍：收尾以后要加的每一步都只写在那一处
  void endDictation()
  executeSelected()
}

/**
 * 键盘事件处理 (保留快捷键导航)
 */
function handleKeyDown(event: KeyboardEvent): void {
  // 不要在 IME 输入过程中触发
  if (event.isComposing) return

  switch (event.key) {
    case 'Escape':
      event.preventDefault()
      closeWindow()
      break
    case 'ArrowUp':
      event.preventDefault()
      if (results.value.length > 0) {
        selectedIndex.value =
          selectedIndex.value > 0 ? selectedIndex.value - 1 : results.value.length - 1
      }
      break
    case 'ArrowDown':
      event.preventDefault()
      if (results.value.length > 0) {
        selectedIndex.value =
          selectedIndex.value < results.value.length - 1 ? selectedIndex.value + 1 : 0
      }
      break
    // Enter 由 textarea 的 @keydown.enter 处理，这里不再处理
  }
}

/**
 * 窗口显示时聚焦输入框
 */
function handleShow(payload: { dictate: boolean }): void {
  query.value = ''
  results.value = []
  selectedIndex.value = 0
  dictationNotice.value = ''
  clearSubmitCountdown()
  // 新的一次唤起，上一轮「听到过话」不算数了
  submitArmed = false
  nextTick(() => {
    inputRef.value?.focus()
  })
  /*
   * 语音热键再按一次走的也是这里（`showForDictation` 不 toggle）。上面已经把
   * 输入框清空了，`start()` 自己会收掉上一轮 —— 效果是「刚才没说清，重来」。
   */
  if (payload.dictate) {
    void beginDictation()
  } else {
    void endDictation()
  }
}

/**
 * 窗口隐藏时重置状态
 */
function handleHide(): void {
  query.value = ''
  results.value = []
  // 窗口没了麦克风不能还开着。这条真漏了的话表现是一个看不见的常驻录音
  void endDictation()
}

onMounted(() => {
  // 初始聚焦
  inputRef.value?.focus()

  // 监听主进程事件
  unsubscribeShow = spotlightAPI.onShow(handleShow)
  unsubscribeHide = spotlightAPI.onHide(handleHide)
})

onUnmounted(() => {
  unsubscribeShow?.()
  unsubscribeHide?.()
  if (searchTimeout) clearTimeout(searchTimeout)
  void endDictation()
})
</script>

<style scoped>
/* 确保 html/body 层透明 */
:deep(html),
:deep(body) {
  background: transparent !important;
}

.spotlight-window {
  width: 100vw;
  height: 100vh;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding-top: 20px;
  background: transparent;
  -webkit-app-region: no-drag;
}

.spotlight-container {
  width: 100%;
  max-width: 560px;
  background: var(--color-bg-surface);
  backdrop-filter: blur(20px);
  border: 1px solid var(--color-border-subtle);
  border-radius: 12px;
  overflow: hidden;
}

.spotlight-input-wrapper {
  display: flex;
  align-items: flex-start;
  padding: 14px 16px;
  border-bottom: 1px solid var(--color-border-subtle);
  gap: 10px;
  -webkit-app-region: no-drag;
}

.drag-handle {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  color: var(--color-text-primary);
  border-radius: 6px;
  transition: all 0.15s ease;
  flex-shrink: 0;
  -webkit-app-region: drag;
  margin-top: -2px;
}

.drag-handle:hover {
  color: var(--color-text-primary);
  background: var(--color-bg-surface-hover);
}

.drag-handle:active {
  color: var(--color-accent-text);
}

.search-icon {
  font-size: 18px;
  color: var(--color-text-primary);
  flex-shrink: 0;
  margin-top: 3px;
}

/*
 * 正在收音的麦克风。**亮度跟着实时响度走，不是一个固定的呼吸动画** ——
 * 固定动画只能说明「程序以为自己在录」，跟着响度动才说明麦克风真的听见了人。
 * 这两件事在真机上经常不一致（选错了输入设备、系统级静音）。
 */
.mic-icon.is-listening {
  color: var(--color-accent-text);
  /* --mic-level 由 JS 每 20ms 喂一次；transition 把台阶抹平成连续的动 */
  opacity: calc(0.55 + 0.45 * var(--mic-level, 0));
  transform: scale(calc(1 + 0.18 * var(--mic-level, 0)));
  transition:
    opacity 80ms linear,
    transform 80ms linear;
}

@media (prefers-reduced-motion: reduce) {
  .mic-icon.is-listening {
    transform: none;
  }
}

.spotlight-input {
  flex: 1;
  background: transparent;
  border: none;
  outline: none;
  font-size: 16px;
  color: var(--color-text-primary);
  caret-color: var(--color-accent-text);
  resize: none;
  line-height: 1.5;
  font-family: inherit;
  padding: 0;
  margin: 0;
  max-height: 48px; /* 限制由于CSS优先级可能被覆盖，JS也会控制 */
  overflow-y: hidden; /* 默认隐藏，由 JS 控制 */
}

.spotlight-input::placeholder {
  color: var(--color-text-primary);
}

.loading-icon {
  font-size: 14px;
  color: var(--color-accent-text);
  flex-shrink: 0;
  margin-top: 5px;
}

.spotlight-results {
  max-height: 300px;
  overflow-y: auto;
  padding: 6px;
}

.result-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.15s ease;
}

/* 鼠标划过 ≠ 键盘选中。以前两者同色，方向键停在第一条、鼠标停在第三条时，
   屏幕上两条一模一样亮，回车下去到底执行哪条只能靠猜。 */
.result-item:hover {
  background: var(--color-bg-surface-hover);
}

.result-item.selected {
  background: var(--color-bg-selected);
}

.result-icon {
  font-size: 20px;
  flex-shrink: 0;
  width: 28px;
  text-align: center;
}

.result-content {
  flex: 1;
  min-width: 0;
}

.result-title {
  color: var(--color-text-primary);
  font-size: 14px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.result-description {
  color: var(--color-text-primary);
  font-size: 12px;
  margin-top: 2px;
}

.result-hint {
  flex-shrink: 0;
  color: var(--color-text-muted);
  font-size: 12px;
  padding: 2px 6px;
  background: var(--color-bg-surface-hover);
  border-radius: 4px;
}

.spotlight-hint {
  padding: 16px;
  text-align: center;
  color: var(--color-text-primary);
  font-size: 13px;
}
</style>
