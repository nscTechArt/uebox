<template>
  <!-- 一步都读不出来的组（只有被滤掉的状态通知）跑完就不占位 -->
  <div v-if="live || view.rows.length > 0" class="step-group" :class="{ live }">
    <!--
      默认只有这一行。两段正文之间原来夹着好几个带底色的框（推理一个、工具一段一个），
      现在只剩一行灰字：做完了是摘要，正在做是它此刻在干什么。点开才看每一步。
    -->
    <button
      type="button"
      class="step-summary"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      <PhCaretRight class="step-caret" :class="{ open: expanded }" />
      <span v-if="live" class="step-summary-text step-live">{{ liveText }}</span>
      <span v-else class="step-summary-text">{{ summaryText }}</span>
      <span v-for="stat in stats" :key="stat" class="step-stat">{{ stat }}</span>
    </button>

    <!--
      整组只有推理时，点开就是推理正文：再套一行「思考过程」等于让人点两次看同一个东西
    -->
    <div v-if="expanded && onlyThinking" class="step-rows">
      <div v-for="row in view.rows" :key="row.key" class="step-thinking">
        <MarkdownRenderer v-if="row.kind === 'thinking'" :content="row.text" :streaming="live" />
      </div>
    </div>

    <div v-else-if="expanded" class="step-rows">
      <template v-for="row in view.rows" :key="row.key">
        <div v-if="row.kind === 'tool'" class="step-row" :class="`is-${row.status}`">
          <!-- 看图的那一步（截图、预览）不展开：图就是结果，直接挂在这一行下面 -->
          <div v-if="row.viewedImages.length > 0" class="step-row-head is-static">
            <span class="step-verb">{{ toolLabel(row.toolName) }}</span>
            <span v-if="row.target" class="step-target" :title="row.target">{{ row.target }}</span>
          </div>
          <button
            v-else
            type="button"
            class="step-row-head"
            :aria-expanded="openRows.has(row.key)"
            @click="toggleRow(row.key)"
          >
            <PhCircleNotch v-if="row.status === 'running'" class="step-spin" />
            <span
              v-else-if="row.status === 'failed'"
              class="step-dot"
              :title="t('assistant.agentProcess.steps.failedHint')"
            />
            <span class="step-verb">{{ toolLabel(row.toolName) }}</span>
            <span v-if="row.target" class="step-target" :title="row.target">{{ row.target }}</span>
            <span v-if="rowOutcome(row)" class="step-outcome">— {{ rowOutcome(row) }}</span>
          </button>
          <div v-if="openRows.has(row.key)" class="step-detail">
            <pre v-if="row.argsText || row.resultText" class="step-raw">{{ rawText(row) }}</pre>
            <FileChangeCard v-if="row.fileChange" :change="row.fileChange" />
            <p v-if="row.fileChangeUnavailable" class="step-note">
              {{ t('assistant.fileDiff.unavailable') }}
            </p>
          </div>
          <div v-if="row.viewedImages.length > 0" class="step-detail">
            <StepMediaStrip :images="row.viewedImages" :max="0" small />
          </div>
        </div>

        <div v-else-if="row.kind === 'thinking'" class="step-row">
          <button
            type="button"
            class="step-row-head"
            :aria-expanded="openRows.has(row.key)"
            @click="toggleRow(row.key)"
          >
            <span class="step-verb">{{ t('assistant.agentProcess.steps.thinking') }}</span>
            <!-- 只写「思考过程」四个字的话，一列里隔一行就是一样的字，什么也没说 -->
            <span v-if="!openRows.has(row.key)" class="step-preview">{{
              thinkingPreview(row.text)
            }}</span>
          </button>
          <!-- 收着时不挂 Markdown：流式推理每来一段都要重新解析一遍 -->
          <div v-if="openRows.has(row.key)" class="step-thinking">
            <MarkdownRenderer :content="row.text" :streaming="live" />
          </div>
        </div>

        <div v-else-if="row.kind === 'subtask'" class="step-row">
          <button
            type="button"
            class="step-row-head"
            :aria-expanded="openRows.has(row.key)"
            @click="toggleRow(row.key)"
          >
            <span class="step-lane" :class="`is-${row.lane.status}`" />
            <!-- 标题可以有九十个字，不让它缩的话后面的「进行中 · 12 步」整个被挤没 -->
            <span class="step-verb step-lane-title" :title="row.lane.title">{{
              row.lane.title || t('assistant.agentProcess.subtask.untitled')
            }}</span>
            <span class="step-outcome">— {{ laneOutcome(row.lane) }}</span>
          </button>
          <!--
            点开一路：它走过的每一步，和主 agent 的步骤行一个说法；跑完了再跟一句结论。
            派出去的任务书是长段落，再收一层，要核对时才看。
          -->
          <div v-if="openRows.has(row.key)" class="step-detail">
            <ol v-if="row.lane.history.length > 0" class="lane-steps">
              <li v-for="(step, i) in row.lane.history" :key="i" class="lane-step">
                <template v-if="step.kind === 'tool'">
                  <span class="step-verb">{{ toolLabel(step.toolName) }}</span>
                  <span v-if="step.target" class="step-target" :title="step.target">{{
                    step.target
                  }}</span>
                </template>
                <span v-else class="step-preview" :title="step.text">{{ step.text }}</span>
              </li>
            </ol>
            <p v-else-if="row.lane.status === 'running'" class="step-note">
              {{ t('assistant.agentProcess.subtask.noSteps') }}
            </p>
            <p v-if="row.lane.summary" class="step-note">{{ row.lane.summary }}</p>
            <div v-if="row.lane.prompt">
              <button
                type="button"
                class="step-row-head"
                :aria-expanded="openRows.has(`${row.key}:brief`)"
                @click="toggleRow(`${row.key}:brief`)"
              >
                <PhCaretRight
                  class="step-caret"
                  :class="{ open: openRows.has(`${row.key}:brief`) }"
                />
                <span>{{ t('assistant.agentProcess.subtask.brief') }}</span>
              </button>
              <pre v-if="openRows.has(`${row.key}:brief`)" class="step-raw">{{
                row.lane.prompt
              }}</pre>
            </div>
          </div>
        </div>

        <p v-else class="step-note" :class="`is-${row.tone}`">{{ row.text }}</p>
      </template>
    </div>

    <!--
      产出的东西不跟着过程收起来：生成的图和视频是这一步的结果，人要立刻看见。
    -->
    <StepMediaStrip :images="view.deliverableImages" :videos="view.videos" />
  </div>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { PhCaretRight, PhCircleNotch } from '@phosphor-icons/vue'
import FileChangeCard from './FileChangeCard.vue'
import MarkdownRenderer from './MarkdownRenderer.vue'
import StepMediaStrip from './StepMediaStrip.vue'
import type { SubtaskLane, SubtaskStep } from './agentSubtasks'
import { buildStepGroup, type StepPart, type ToolStepRow } from './agentSteps'
import { formatStepDuration, resolveToolLabel } from './agentStepLabels'

const props = defineProps<{
  parts: StepPart[]
  /** 这一组是不是此刻还在跑的那一组。只有它转圈、计时 */
  live?: boolean
  /** 计时起点。第一组从用户发消息算起，后面几组从各自第一条事件算起 */
  startTime?: number
}>()

const { t, te } = useI18n()

const expanded = ref(false)
const openRows = ref(new Set<string>())

const view = computed(() => buildStepGroup(props.parts))

function toggleRow(key: string): void {
  const next = new Set(openRows.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  openRows.value = next
}

function toolLabel(toolName: string): string {
  return resolveToolLabel(toolName, t, te)
}

/** 行尾那一句结果：跑着报进度，失败说原因，成功只在结果明说了数量时才说 */
function rowOutcome(row: ToolStepRow): string {
  if (row.status === 'running') return row.progress
  if (row.status === 'failed') return row.error || t('assistant.agentProcess.compactFailed')
  if (typeof row.count === 'number') {
    return t('assistant.agentProcess.steps.count', { count: row.count })
  }
  return ''
}

function rawText(row: ToolStepRow): string {
  return [row.argsText, row.resultText].filter(Boolean).join('\n\n')
}

const onlyThinking = computed(
  () => view.value.rows.length > 0 && view.value.rows.every((row) => row.kind === 'thinking')
)

/** 推理的第一句，去掉 Markdown 记号。行宽放不下由 CSS 截断，这里只防一整段塞进 DOM */
function thinkingPreview(text: string): string {
  const line =
    text
      .split('\n')
      // 只去掉行首的 Markdown 记号（标题、引用、列表符、「1. 」这种编号），
      // 「3D」「5.3」这类正文开头的数字要留着
      .map((part) => part.replace(/^\s*(?:#+|>+|[*+-]|\d+[.)])\s+/, '').trim())
      .find(Boolean) ?? ''
  // 只去掉成对的加粗 / 斜体 / 行内代码记号；资产名里的下划线（BP_Night_Car_5）不动
  return line.replace(/(\*\*|__|\*|`)(.+?)\1/g, '$2').slice(0, 160)
}

// ── 计时 ──
const MIN_DURATION_MS = 100
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null

watch(
  () => props.live,
  (live) => {
    if (timer) clearInterval(timer)
    timer = null
    if (!live) return
    now.value = Date.now()
    timer = setInterval(() => {
      now.value = Date.now()
    }, 1000)
  },
  { immediate: true }
)

onUnmounted(() => {
  if (timer) clearInterval(timer)
})

const durationText = computed(() => {
  const start = props.startTime ?? view.value.startedAt
  const end = props.live ? now.value : view.value.endedAt
  // 只有一个时刻的组（单独一轮推理）量不出时长，写 0.0s 等于瞎报
  if (start === undefined || end === undefined || end - start < MIN_DURATION_MS) return ''
  return formatStepDuration(end - start, t)
})

function laneOutcome(lane: SubtaskLane): string {
  const status =
    lane.status === 'success'
      ? t('assistant.agentProcess.subtask.success')
      : lane.status === 'failed'
        ? t('assistant.agentProcess.subtask.failed')
        : t('assistant.agentProcess.subtask.running')
  const steps =
    lane.steps > 0 ? t('assistant.agentProcess.subtask.steps', { count: lane.steps }) : ''
  const latest = lane.history[lane.history.length - 1]
  const detail = lane.status === 'running' && latest ? stepText(latest) : ''
  return [status, steps, detail].filter(Boolean).join(' · ')
}

function stepText(step: SubtaskStep): string {
  if (step.kind === 'say') return step.text
  return [toolLabel(step.toolName), step.target].filter(Boolean).join(' ')
}

// ── 摘要那一行 ──
const MAX_SUMMARY_LABELS = 3

const summaryText = computed(() => {
  const { toolCounts, toolCount, rows } = view.value
  if (toolCount === 0) {
    if (rows.some((row) => row.kind === 'thinking')) {
      return t('assistant.agentProcess.steps.thinking')
    }
    // 只有说明的组用最后一条：目标复核先说「正在复核」，最后才说结论
    const note = [...rows].reverse().find((row) => row.kind === 'note')
    return note?.kind === 'note' ? note.text : t('assistant.agentProcess.processFinished')
  }

  const labels = toolCounts
    .slice(0, MAX_SUMMARY_LABELS)
    .map(({ toolName, count }) =>
      count > 1 ? `${toolLabel(toolName)} ×${count}` : toolLabel(toolName)
    )
  const text = labels.join(t('assistant.agentProcess.steps.separator'))
  return toolCounts.length > MAX_SUMMARY_LABELS
    ? t('assistant.agentProcess.steps.more', { text, count: toolCount })
    : text
})

const stats = computed(() => {
  const { failedCount, viewedImageCount, fileChangeCount } = view.value
  const items: string[] = []
  if (!props.live && failedCount > 0) {
    items.push(t('assistant.agentProcess.steps.failed', { count: failedCount }))
  }
  if (!props.live && viewedImageCount > 0) {
    items.push(t('assistant.agentProcess.steps.viewedImages', { count: viewedImageCount }))
  }
  if (!props.live && fileChangeCount > 0) {
    items.push(t('assistant.agentProcess.steps.changedFiles', { count: fileChangeCount }))
  }
  if (durationText.value) items.push(durationText.value)
  return items
})

/** 正在做的时候这一行说它此刻在干什么，而不是笼统的「处理中」 */
const liveText = computed(() => {
  const last = view.value.rows[view.value.rows.length - 1]
  const lastPart = props.parts[props.parts.length - 1]
  if (lastPart?.kind === 'thinking') return t('assistant.agentProcess.steps.thinkingNow')
  if (last?.kind === 'tool' && last.status === 'running') {
    return [toolLabel(last.toolName), last.target].filter(Boolean).join(' ')
  }
  if (last?.kind === 'subtask' && last.lane.status === 'running') {
    return last.lane.title || t('assistant.agentProcess.steps.working')
  }
  // 网关重发、断线续跑、编辑器崩溃重开这些说明，是用户此刻唯一能看到的解释
  if (last?.kind === 'note') return last.text
  return t('assistant.agentProcess.steps.working')
})
</script>

<style scoped lang="less">
.step-group {
  max-width: 100%;
  margin: 0 0 var(--space-4);
  font-size: var(--font-size-sm);
  line-height: var(--line-height-normal);
  color: var(--color-text-muted);
}

// 摘要行和每一步的行共用一套样子：没有底色和边框，悬停才浮出来
.step-summary,
.step-row-head {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  max-width: 100%;
  min-width: 0;
  margin-left: calc(-1 * var(--space-1));
  padding: 3px var(--space-1);
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition:
    color var(--motion-fast) var(--easing-standard),
    background var(--motion-fast) var(--easing-standard);

  &:hover {
    color: var(--color-text-secondary);
    background: var(--color-bg-surface-hover);
  }

  &:focus-visible {
    outline: 2px solid var(--color-border-focus);
    outline-offset: 1px;
  }
}

.step-row-head.is-static {
  cursor: default;

  &:hover {
    color: inherit;
    background: transparent;
  }
}

.step-caret {
  flex: none;
  font-size: 10px;
  transition: transform var(--motion-fast) var(--easing-standard);

  &.open {
    transform: rotate(90deg);
  }
}

.step-summary-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.step-stat {
  flex: none;
  white-space: nowrap;

  &::before {
    content: '·';
    margin-right: var(--space-1);
    opacity: 0.6;
  }
}

// 正在做的那一步：一道光从字上扫过去，不转圈、不闪
.step-live {
  background: linear-gradient(
    90deg,
    var(--color-text-muted) 0%,
    var(--color-text-primary) 50%,
    var(--color-text-muted) 100%
  );
  background-size: 200% 100%;
  background-clip: text;
  -webkit-background-clip: text;
  color: transparent;
  animation: step-shimmer 1.8s linear infinite;
}

@keyframes step-shimmer {
  from {
    background-position: 100% 0;
  }

  to {
    background-position: -100% 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .step-live {
    animation: none;
    color: var(--color-text-secondary);
    background: none;
  }
}

.step-rows {
  // 不能是 flex-start：行宽按内容收缩时，行头的负边距会从内容里再扣掉 4px，
  // 短的对象（「拱门参考图」）就被截掉最后一个字
  display: flex;
  flex-direction: column;
  margin: var(--space-1) 0 var(--space-1) var(--space-1);
  padding-left: var(--space-3);
  border-left: 1px solid var(--color-border-subtle);
}

.step-row {
  max-width: 100%;
}

.step-verb {
  flex: none;
  color: var(--color-text-secondary);
}

.step-target {
  // 放不下时先截对象，再截结果：「共 12 项」被截成「共 12…」就什么也没说
  flex: 0 10 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-family-mono);
  font-size: var(--font-size-xs);
}

.step-outcome {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

// 推理那一行后面跟的第一句：比工具行再淡一档，扫过去分得出「想」和「做」
.step-preview {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-style: italic;
  opacity: 0.75;
}

.step-spin {
  flex: none;
  animation: step-spin 1s linear infinite;
}

@keyframes step-spin {
  to {
    transform: rotate(360deg);
  }
}

// 失败只标一个小点：中途试错又自己改过来的事，不值得一块警告色
.step-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-warning-text);
}

.step-lane {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--color-text-muted);

  &.is-success {
    background: var(--color-success-text);
  }

  &.is-failed {
    background: var(--color-warning-text);
  }

  &.is-running {
    background: var(--color-text-secondary);
    animation: step-pulse 1.2s ease-in-out infinite;
  }
}

.step-lane-title {
  flex: 0 3 auto;
  min-width: 6em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

// 一路子任务走过的步骤：跑上几十步也只占一块，滚着看
.lane-steps {
  max-height: 320px;
  margin: 0;
  padding: 0 0 0 var(--space-3);
  overflow: auto;
  list-style: none;
  border-left: 1px solid var(--color-border-subtle);
}

.lane-step {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
  padding: 2px 0;
}

@keyframes step-pulse {
  50% {
    opacity: 0.25;
  }
}

.step-detail {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: var(--space-1) 0 var(--space-2);
}

// 参数和返回原文：一个等宽字块，不再一层套一层
.step-raw {
  max-height: 320px;
  margin: 0;
  padding: var(--space-2) var(--space-3);
  overflow: auto;
  border-radius: var(--radius-md);
  background: var(--color-bg-soft);
  color: var(--color-text-secondary);
  font-family: var(--font-family-mono);
  font-size: var(--font-size-xs);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
}

.step-thinking {
  padding: var(--space-1) var(--space-1) var(--space-2);

  :deep(.markdown-body) {
    font-size: var(--font-size-sm);
    color: var(--color-text-muted);
  }
}

.step-note {
  margin: 0;
  padding: 2px 0;

  &.is-warning {
    color: var(--color-warning-text);
  }
}
</style>
