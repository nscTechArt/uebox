<template>
  <!--
    简约画风的任务板：一人一条泳道。

    一眼看到：一句话的进度（几人在干、交回几份、验收）、每条泳道上此刻在干嘛，
    以及一条时间轴 —— 色条是一件活从开工到交回，菱形是交付，红色虚线是编辑器崩溃。
    点一条泳道：就地展开他手上的活、最近几步、交回的成果（标题 + 前几行，点开看全文）、往来。
    不跳页、不弹层。

    跟着主题走（墨线单色），和简约版办公室一致。设计见 docs/团队任务板可读性-2026-10-14.md。
  -->
  <div class="lanes">
    <header class="headline">
      <div class="headline-main">
        <h3 class="headline-title" :class="`is-${model.phase}`">
          {{ phaseText }}
          <span v-if="busy" class="dots" aria-hidden="true"><i /><i /><i /></span>
        </h3>
        <span v-if="subline" class="headline-sub">{{ subline }}</span>
        <AppTag v-if="verdict" :tone="verdict.tone" :title="verdict.title">{{
          verdict.text
        }}</AppTag>
      </div>
      <p class="objective" :title="team.objective">
        <span class="objective-label">{{ t('assistant.teamBoard.objective') }}</span>
        {{ team.objective }}
      </p>
      <p v-if="team.latestRequest" class="objective" :title="team.latestRequest">
        <span class="objective-label">{{ t('assistant.teamBoard.latestRequestLabel') }}</span>
        {{ latestRequestLine(team.latestRequest) }}
      </p>
    </header>

    <p v-if="!model.crew.length" class="empty">{{ t('assistant.teamBoard.ui.recruiting') }}</p>
    <template v-else>
      <div class="axis" aria-hidden="true">
        <span />
        <span />
        <span class="axis-scale">
          <span>{{ ago(range.start) }}</span>
          <span>{{ t('assistant.teamBoard.ui.now') }}</span>
        </span>
        <span />
      </div>

      <ul class="lane-list">
        <li
          v-for="c in model.crew"
          :key="c.id"
          class="lane"
          :class="{ 'is-open': selected === c.id, 'is-alert': c.mood === 'alert' }"
          @mouseenter="emit('hover', c.id)"
          @mouseleave="emit('hover', null)"
        >
          <button
            type="button"
            class="lane-row"
            :aria-expanded="selected === c.id"
            @click="emit('select', selected === c.id ? null : c.id)"
          >
            <span class="lane-name">
              <span class="swatch" :style="{ background: colorOf(c.crew) }" />
              <span class="name-text">{{ c.name }}</span>
              <PhLock
                v-if="c.member.readOnly"
                class="lock"
                weight="bold"
                :aria-label="t('assistant.teamBoard.readOnly')"
              >
                <title>{{ t('assistant.teamBoard.readOnlyHint') }}</title>
              </PhLock>
            </span>
            <span class="lane-status" :title="statusText(c.status)">
              <span v-if="c.mood === 'work'" class="pulse" aria-hidden="true" />
              {{ statusText(c.status) }}
            </span>
            <span class="track" aria-hidden="true">
              <span class="track-axis" />
              <span
                v-for="crash in crashes"
                :key="`crash-${crash.at}`"
                class="track-crash"
                :style="{ left: pos(crash.at) }"
                :title="crashTitle(crash.at)"
              />
              <template v-for="job in laneJobs(c)" :key="job.id">
                <span
                  class="track-bar"
                  :class="`is-${job.state}`"
                  :style="{
                    left: pos(job.startedAt),
                    width: span(job.startedAt, job.endedAt ?? range.end),
                    '--c': colorOf(c.crew)
                  }"
                  :title="barTitle(job)"
                />
                <span
                  v-if="job.state === 'done'"
                  class="track-mark"
                  :style="{ left: pos(job.endedAt ?? job.startedAt), '--c': colorOf(c.crew) }"
                  :title="barTitle(job)"
                  @click.stop="openReport(c.id, job.id)"
                />
                <span
                  v-else-if="job.state !== 'writing'"
                  class="track-stop"
                  :style="{ left: pos(job.endedAt ?? job.startedAt) }"
                  :title="barTitle(job)"
                />
              </template>
            </span>
            <span class="lane-when">
              <template v-if="'at' in c.status && c.status.at">{{ ago(c.status.at) }}</template>
            </span>
          </button>

          <div v-if="selected === c.id" class="lane-body">
            <div v-if="c.assignment || c.open" class="body-block">
              <h5 class="body-label">{{ t('assistant.teamBoard.ui.job') }}</h5>
              <p class="body-text">{{ c.assignment || c.open?.brief }}</p>
            </div>

            <div v-if="reportsOf(c).length" class="body-block">
              <h5 class="body-label">{{ t('assistant.teamBoard.ui.reports') }}</h5>
              <article
                v-for="job in reportsOf(c)"
                :key="job.id"
                class="report"
                :class="{ 'is-open': openReports.has(job.id) }"
              >
                <button
                  type="button"
                  class="report-head"
                  :aria-expanded="openReports.has(job.id)"
                  @click="toggleReport(job.id)"
                >
                  <PhCaretRight class="report-caret" />
                  <span class="report-title">{{ job.title }}</span>
                  <span class="report-when">{{ ago(job.endedAt ?? job.startedAt) }}</span>
                </button>
                <div v-if="openReports.has(job.id)" class="report-body">
                  <div class="report-md" :class="{ 'is-clamped': !fullReports.has(job.id) }">
                    <MarkdownRenderer :content="job.body || job.title" />
                  </div>
                  <button type="button" class="link" @click="toggleFull(job.id)">
                    {{
                      fullReports.has(job.id)
                        ? t('assistant.teamBoard.ui.collapse')
                        : t('assistant.teamBoard.ui.expand')
                    }}
                    <template v-if="!fullReports.has(job.id) && job.sections > 1">
                      · {{ t('assistant.teamBoard.sections', { n: job.sections }) }}
                    </template>
                  </button>
                </div>
              </article>
            </div>

            <div v-if="stoppedOf(c).length" class="body-block">
              <p v-for="job in stoppedOf(c)" :key="job.id" class="stopped-line">
                {{
                  t('assistant.teamBoard.ui.stoppedJob', {
                    title: job.title,
                    reason: job.reason ?? ''
                  })
                }}
                <button
                  v-if="job.state === 'stopped'"
                  type="button"
                  class="stopped-reopen"
                  :title="t('assistant.teamBoard.reopenJobHint')"
                  @click="emit('reopen-job', job.id)"
                >
                  {{ t('assistant.teamBoard.reopen') }}
                </button>
              </p>
            </div>

            <div class="body-block">
              <h5 class="body-label">{{ t('assistant.teamBoard.steps') }}</h5>
              <ol v-if="stepsOf(c).length" class="steps">
                <li v-for="(step, index) in stepsOf(c)" :key="index" class="step">
                  <span class="step-when">{{ step.showTime ? ago(step.at) : '' }}</span>
                  <span
                    v-if="step.tool"
                    class="step-text"
                    :title="[step.tool, ...step.targets].join('\n')"
                  >
                    {{ toolVerb(step.tool) }}
                    <template v-if="step.targets.length">
                      · {{ shortTarget(step.targets.at(-1)!) }}
                      <span v-if="step.targets.length > 1" class="step-count">
                        {{ t('assistant.teamBoard.stepTimes', { n: step.targets.length }) }}
                      </span>
                    </template>
                  </span>
                  <span v-else class="step-text is-speech" :title="step.text">{{ step.text }}</span>
                </li>
              </ol>
              <p v-else class="muted">{{ t('assistant.teamBoard.noSteps') }}</p>
            </div>

            <div class="body-block">
              <button
                type="button"
                class="fold"
                :aria-expanded="threadOpen.has(c.id)"
                @click="toggleThread(c.id)"
              >
                <PhCaretRight class="report-caret" :class="{ 'is-open': threadOpen.has(c.id) }" />
                {{ t('assistant.teamBoard.ui.threadCount', { n: threadOf(c).length }) }}
              </button>
              <ul v-if="threadOpen.has(c.id)" class="thread">
                <li
                  v-for="entry in threadOf(c)"
                  :key="entry.key"
                  class="thread-item"
                  :class="`is-${entry.kind}`"
                >
                  <span class="thread-meta">
                    {{ entryWho(entry) }} ·
                    <span :title="exact(entry.at)">{{ ago(entry.at) }}</span>
                  </span>
                  <span class="thread-text">{{ entryText(entry) }}</span>
                </li>
                <li v-if="!threadOf(c).length" class="muted">
                  {{ t('assistant.teamBoard.ui.noThread') }}
                </li>
              </ul>
            </div>

            <div class="body-meta">
              <TeamMemberModel
                :member="c.member"
                :model-choices="modelChoices"
                :models-loaded="modelsLoaded"
                @open-models="emit('open-models')"
                @set-model="(name, m) => emit('set-model', name, m)"
              />
              <span v-if="c.member.persona" class="persona" :title="c.member.persona">
                {{ c.member.persona }}
              </span>
              <!-- 外部团队的名册在 Claude Code 那边管，盒子不替它辞人；混合团队的队员在盒子里，照常辞 -->
              <TeamMemberDismiss
                v-if="!team.external || team.hostedMembers"
                class="dismiss"
                :member="c.member"
                :team="team"
                :busy="!!c.open || !!c.assignment"
                @dismiss="(name, reason) => emit('dismiss', name, reason)"
              />
            </div>
          </div>
        </li>
      </ul>
    </template>

    <section v-if="model.earlier.length" class="tail">
      <button
        type="button"
        class="fold"
        :aria-expanded="earlierOpen"
        @click="earlierOpen = !earlierOpen"
      >
        <PhCaretRight class="report-caret" :class="{ 'is-open': earlierOpen }" />
        {{ t('assistant.teamBoard.ui.earlier', { n: model.earlier.length }) }}
      </button>
      <div v-if="earlierOpen" class="earlier">
        <article
          v-for="job in model.earlier"
          :key="job.id"
          class="report"
          :class="{ 'is-open': openReports.has(job.id) }"
        >
          <button
            type="button"
            class="report-head"
            :aria-expanded="openReports.has(job.id)"
            @click="toggleReport(job.id)"
          >
            <PhCaretRight class="report-caret" />
            <span class="swatch" :style="{ background: colorOfName(job.member) }" />
            <span class="report-title">{{ job.title }}</span>
            <span class="report-when"
              >{{ job.member }} · {{ ago(job.endedAt ?? job.startedAt) }}</span
            >
          </button>
          <div v-if="openReports.has(job.id)" class="report-body">
            <div class="report-md" :class="{ 'is-clamped': !fullReports.has(job.id) }">
              <MarkdownRenderer :content="job.body || job.title" />
            </div>
            <button type="button" class="link" @click="toggleFull(job.id)">
              {{
                fullReports.has(job.id)
                  ? t('assistant.teamBoard.ui.collapse')
                  : t('assistant.teamBoard.ui.expand')
              }}
            </button>
          </div>
        </article>
      </div>
    </section>

    <section v-if="team.board.length" class="tail">
      <button type="button" class="fold" :aria-expanded="boardOpen" @click="boardOpen = !boardOpen">
        <PhCaretRight class="report-caret" :class="{ 'is-open': boardOpen }" />
        {{ t('assistant.teamBoard.ui.boardCount', { n: team.board.length }) }}
        <span v-if="model.blocked" class="fold-alert">
          {{ t('assistant.teamBoard.ui.alertBlocked', { n: model.blocked }) }}
        </span>
      </button>
      <TeamTaskList
        v-if="boardOpen"
        class="board"
        :team="team"
        :selected="null"
        @reopen="emit('reopen', $event)"
      />
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { PhCaretRight, PhLock } from '@phosphor-icons/vue'

import AppTag from '@renderer/components/AppTag.vue'
import {
  PRODUCER,
  type TeamActivity,
  type TeamModel,
  type TeamModelCandidate,
  type TeamStateView
} from '@core/shared/agentTeam'

import MarkdownRenderer from '../MarkdownRenderer.vue'
import TeamMemberDismiss from '../TeamMemberDismiss.vue'
import TeamMemberModel from '../TeamMemberModel.vue'
import TeamTaskList from '../TeamTaskList.vue'
import {
  latestRequestLine,
  type BoardModel,
  type CrewView,
  type JobView,
  type LogEntry
} from '../teamBoardModel'
import { useTeamLabels } from '../teamBoardLabels'
import { recentSteps, shortTarget, type StepGroup } from '../teamBoardView'
import { crewColor, officeStyle } from '../teamOffice/officeStyle'

const props = defineProps<{
  team: TeamStateView
  model: BoardModel
  activity: TeamActivity[]
  selected: string | null
  modelChoices?: TeamModelCandidate[]
  modelsLoaded?: boolean
}>()
const emit = defineEmits<{
  select: [id: string | null]
  hover: [id: string | null]
  reopen: [taskId: string]
  'reopen-job': [jobId: string]
  'open-models': []
  'set-model': [name: string, model: TeamModel]
  dismiss: [name: string, reason: string]
}>()
const { t } = useI18n()
const { ago, exact, who, toolVerb, statusText, now } = useTeamLabels()

const colorOf = (crew: number): string => crewColor(crew, officeStyle.value)
const colorOfName = (name: string): string => {
  const id = name.trim().toLowerCase()
  if (id === PRODUCER) return crewColor(-1, officeStyle.value)
  return colorOf(props.model.crew.find((c) => c.id === id)?.crew ?? 0)
}

// ── 一句话 ──────────────────────────────────────────────────────────────

const busy = computed(() => props.model.phase === 'working' || props.model.phase === 'planning')

const phaseText = computed(() => {
  const m = props.model
  if (m.phase === 'alert') {
    return [
      m.stopped ? t('assistant.teamBoard.ui.alertStopped', { n: m.stopped }) : '',
      m.blocked ? t('assistant.teamBoard.ui.alertBlocked', { n: m.blocked }) : ''
    ]
      .filter(Boolean)
      .join(' · ')
  }
  return t(`assistant.teamBoard.ui.phase.${m.phase}`)
})

const subline = computed(() => {
  const m = props.model
  const parts: string[] = []
  if (m.working) parts.push(t('assistant.teamBoard.ui.workingCount', { n: m.working }))
  if (m.round.length) {
    parts.push(
      t('assistant.teamBoard.ui.roundCount', {
        done: m.round.filter((j) => j.state === 'done').length,
        total: m.round.length
      })
    )
  }
  return parts.join(' · ')
})

const verdict = computed(() => {
  const v = props.model.verdict
  if (!v) return null
  return {
    text: v.stale
      ? t('assistant.teamBoard.verdict.stale')
      : t(`assistant.teamBoard.verdict.${v.kind}`),
    tone: (v.stale
      ? 'neutral'
      : v.kind === 'pass'
        ? 'success'
        : v.kind === 'fail'
          ? 'warning'
          : 'danger') as 'neutral' | 'success' | 'warning' | 'danger',
    title:
      v.at !== undefined
        ? t('assistant.teamBoard.verdictTitle', { count: v.count, when: ago(v.at) })
        : undefined
  }
})

// ── 时间轴 ──────────────────────────────────────────────────────────────

/** 时间轴上画哪些活：这一轮的；这一轮还没派活就画最近交回的那几件 */
const shown = computed<JobView[]>(() =>
  props.model.round.length ? props.model.round : props.model.earlier.slice(0, 8)
)

/** 最短看十分钟，免得刚开工那一分钟里一件活占满整条轴 */
const MIN_SPAN = 10 * 60_000
const range = computed(() => {
  const end = now.value
  const first = Math.min(...shown.value.map((j) => j.startedAt), end - MIN_SPAN)
  return { start: first, end }
})

const ratio = (at: number): number => {
  const { start, end } = range.value
  return Math.min(1, Math.max(0, (at - start) / Math.max(1, end - start)))
}
const pos = (at: number): string => `${(ratio(at) * 100).toFixed(2)}%`
/** 再短的活也给 3 像素，看得见 */
const span = (from: number, to: number): string =>
  `max(3px, ${((ratio(to) - ratio(from)) * 100).toFixed(2)}%)`

const laneJobs = (c: CrewView): JobView[] => {
  const ids = new Set(shown.value.map((j) => j.id))
  return c.jobs.filter((j) => ids.has(j.id))
}

const crashes = computed(() =>
  props.model.events.filter((e) => e.kind === 'crashed' && e.at >= range.value.start)
)
const crashTitle = (at: number): string => `${ago(at)} · ${t('assistant.teamBoard.ui.logCrashed')}`

function barTitle(job: JobView): string {
  return `${job.title} · ${t(`assistant.teamBoard.ui.state.${job.state}`)}`
}

// ── 展开 ────────────────────────────────────────────────────────────────

const reportsOf = (c: CrewView): JobView[] => c.jobs.filter((j) => j.state === 'done' && j.current)
/** 停着没人管的那件（之后又接了活、或已经重开的不算，见 `pendingStops`） */
const stoppedOf = (c: CrewView): JobView[] =>
  props.model.stops.filter((j) => j.memberId === c.id).slice(0, 1)
const stepsOf = (c: CrewView): StepGroup[] => recentSteps(props.activity, c.name, 6)
const threadOf = (c: CrewView): LogEntry[] =>
  c.thread.filter((e) => e.kind === 'mail' || e.kind === 'crashed')

const openReports = reactive(new Set<string>())
const fullReports = reactive(new Set<string>())
const threadOpen = reactive(new Set<string>())
const earlierOpen = ref(false)
const boardOpen = ref(false)

function toggleReport(id: string): void {
  if (openReports.has(id)) openReports.delete(id)
  else openReports.add(id)
}
function toggleFull(id: string): void {
  if (fullReports.has(id)) fullReports.delete(id)
  else fullReports.add(id)
}
function toggleThread(id: string): void {
  if (threadOpen.has(id)) threadOpen.delete(id)
  else threadOpen.add(id)
}
/** 点时间轴上的菱形：展开这个人，并展开那份成果 */
function openReport(member: string, jobId: string): void {
  if (props.selected !== member) emit('select', member)
  openReports.add(jobId)
}

function entryWho(entry: LogEntry): string {
  if (entry.kind === 'crashed') return t('assistant.teamBoard.ui.editor')
  if (!entry.from) return ''
  return entry.to.length
    ? t('assistant.teamBoard.ui.mailTo', {
        from: who(entry.from),
        to: entry.to.map(who).join('、')
      })
    : who(entry.from)
}

function entryText(entry: LogEntry): string {
  if (entry.kind === 'crashed') {
    return entry.text
      ? t('assistant.teamBoard.ui.logCrashedDetail', { detail: entry.text })
      : t('assistant.teamBoard.ui.logCrashed')
  }
  return entry.text
}
</script>

<style scoped lang="less">
.lanes {
  container-type: inline-size;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-4);
  font-size: var(--font-size-sm);
  line-height: var(--line-height-normal);
}

.headline {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.headline-main {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-3);
}

.headline-title {
  margin: 0;
  color: var(--color-text-primary);
  font-size: var(--font-size-xl);
  font-weight: var(--font-weight-semibold);
  letter-spacing: -0.01em;

  &.is-alert {
    color: var(--color-danger-text);
  }

  &.is-done {
    color: var(--color-success-text);
  }
}

.headline-sub {
  color: var(--color-text-secondary);
}

.objective {
  margin: 0;
  overflow: hidden;
  color: var(--color-text-muted);
  white-space: nowrap;
  text-overflow: ellipsis;
}

.objective-label {
  margin-right: var(--space-2);
}

.dots {
  display: inline-flex;
  gap: 3px;
  margin-left: 4px;
  vertical-align: middle;

  i {
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: currentColor;
    animation: dot 1.2s ease-in-out infinite;
  }

  i:nth-child(2) {
    animation-delay: 0.2s;
  }

  i:nth-child(3) {
    animation-delay: 0.4s;
  }
}

@keyframes dot {
  0%,
  80%,
  100% {
    opacity: 0.25;
  }
  40% {
    opacity: 1;
  }
}

.empty,
.muted {
  margin: 0;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

/* 泳道的四列：名字、此刻在干嘛、时间轴、时间 */
.axis,
.lane-row {
  display: grid;
  grid-template-columns: minmax(80px, 116px) minmax(0, 1fr) minmax(96px, 32%) 52px;
  align-items: center;
  gap: var(--space-3);
}

.axis {
  margin-bottom: calc(var(--space-2) * -1);
  padding: 0 var(--space-2);
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.axis-scale {
  display: flex;
  justify-content: space-between;
}

@container (max-width: 520px) {
  .axis {
    display: none;
  }

  .lane-row {
    grid-template-columns: minmax(84px, 128px) minmax(0, 1fr) 56px;

    .track {
      grid-column: 1 / -1;
      grid-row: 2;
    }
  }
}

.lane-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.lane {
  border-radius: var(--radius-md);
  transition: background-color 140ms ease;

  &.is-open {
    background: var(--color-bg-sunken);
  }
}

.lane-row {
  width: 100%;
  min-height: 40px;
  padding: var(--space-2);
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text-secondary);
  font: inherit;
  text-align: left;
  cursor: pointer;

  &:hover {
    background: var(--color-bg-surface-hover);
  }

  .is-open > &:hover {
    background: transparent;
  }

  &:focus-visible {
    outline: 2px solid var(--color-border-focus);
    outline-offset: -2px;
  }
}

.lane-name {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.swatch {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  border-radius: var(--radius-full);
}

.name-text {
  min-width: 0;
  overflow: hidden;
  color: var(--color-text-primary);
  font-weight: var(--font-weight-medium);
  white-space: nowrap;
  text-overflow: ellipsis;
}

.lock {
  flex-shrink: 0;
  width: 12px;
  height: 12px;
  color: var(--color-text-muted);
}

.lane-status {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;

  .is-alert & {
    color: var(--color-danger-text);
  }
}

.pulse {
  flex-shrink: 0;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-success-solid);
  animation: pulse 1.6s ease-in-out infinite;
}

@keyframes pulse {
  50% {
    opacity: 0.3;
  }
}

.lane-when {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  text-align: right;
  white-space: nowrap;
}

/* 时间轴 */
.track {
  position: relative;
  height: 18px;
}

.track-axis {
  position: absolute;
  inset: 8px 0 auto;
  height: 1px;
  background: var(--color-border);
}

.track-crash {
  position: absolute;
  top: -6px;
  bottom: -6px;
  width: 0;
  border-left: 1.5px dashed var(--color-danger-text);
  opacity: 0.8;
}

.track-bar {
  position: absolute;
  top: 5px;
  height: 7px;
  border-radius: 4px;
  background: var(--c);
  opacity: 0.45;

  &.is-writing {
    opacity: 1;
    background: repeating-linear-gradient(
      -45deg,
      var(--c) 0 5px,
      color-mix(in srgb, var(--c) 60%, transparent) 5px 10px
    );
    background-size: 14px 14px;
    animation: crawl 1s linear infinite;
  }

  &.is-stopped,
  &.is-lost {
    background: var(--color-danger-solid);
    opacity: 0.35;
  }
}

@keyframes crawl {
  to {
    background-position: 14px 0;
  }
}

.track-mark {
  position: absolute;
  top: 3px;
  width: 11px;
  height: 11px;
  margin-left: -6px;
  transform: rotate(45deg);
  border: 2px solid var(--color-bg-surface);
  background: var(--c);
  cursor: pointer;

  &:hover {
    transform: rotate(45deg) scale(1.25);
  }
}

.track-stop {
  position: absolute;
  top: 2px;
  width: 12px;
  height: 12px;
  margin-left: -6px;
  background:
    linear-gradient(45deg, transparent 43%, var(--color-danger-text) 43% 57%, transparent 57%),
    linear-gradient(-45deg, transparent 43%, var(--color-danger-text) 43% 57%, transparent 57%);
}

/* 展开 */
.lane-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-2) var(--space-3) var(--space-4) calc(var(--space-2) + 16px);
  animation: open 160ms ease-out;
}

@keyframes open {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
}

.body-block {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
}

.body-label {
  margin: 0;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  letter-spacing: 0.04em;
}

.body-text {
  margin: 0;
  color: var(--color-text-primary);
}

.report {
  border-left: 2px solid var(--color-border-strong);
  padding-left: var(--space-3);

  &.is-open {
    border-left-color: var(--color-accent-solid);
  }
}

.report-head,
.fold {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-width: 0;
  padding: 2px 0;
  border: none;
  background: none;
  color: var(--color-text-primary);
  font: inherit;
  text-align: left;
  cursor: pointer;

  &:hover .report-title {
    text-decoration: underline;
    text-underline-offset: 3px;
  }

  &:focus-visible {
    outline: 2px solid var(--color-border-focus);
    outline-offset: 2px;
    border-radius: var(--radius-sm);
  }
}

.fold {
  width: auto;
  color: var(--color-text-secondary);
}

.fold-alert {
  color: var(--color-danger-text);
}

.report-caret {
  flex-shrink: 0;
  width: 12px;
  height: 12px;
  color: var(--color-text-muted);
  transition: transform 140ms ease;

  .is-open > .report-head > &,
  &.is-open {
    transform: rotate(90deg);
  }
}

.report-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-weight: var(--font-weight-medium);
  white-space: nowrap;
  text-overflow: ellipsis;
}

.report-when {
  flex-shrink: 0;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.report-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-2) 0 var(--space-1);
}

.report-md {
  position: relative;

  :deep(.markdown-body) {
    font-size: var(--font-size-sm);
  }

  &.is-clamped {
    max-height: 200px;
    overflow: hidden;
    mask-image: linear-gradient(black 70%, transparent);
  }
}

.link {
  align-self: flex-start;
  padding: 0;
  border: none;
  background: none;
  color: var(--color-accent-solid);
  font: inherit;
  font-size: var(--font-size-xs);
  cursor: pointer;

  &:hover {
    text-decoration: underline;
  }
}

.stopped-line {
  margin: 0;
  color: var(--color-danger-text);
}

.stopped-reopen {
  margin-left: 8px;
  padding: 0;
  border: none;
  background: none;
  color: var(--color-accent-text);
  font: inherit;
  cursor: pointer;

  &:hover {
    text-decoration: underline;
  }
}

.steps {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.step {
  display: grid;
  grid-template-columns: 4.5em minmax(0, 1fr);
  gap: var(--space-2);
  font-size: var(--font-size-xs);
}

.step-when {
  color: var(--color-text-muted);
}

.step-text {
  min-width: 0;
  overflow: hidden;
  color: var(--color-text-secondary);
  white-space: nowrap;
  text-overflow: ellipsis;

  &.is-speech {
    font-style: italic;
  }
}

.step-count {
  margin-left: 4px;
  color: var(--color-text-muted);
}

.thread {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0;
  padding: 0 0 0 20px;
  list-style: none;
}

.thread-item {
  display: flex;
  flex-direction: column;
  gap: 1px;
  font-size: var(--font-size-xs);

  &.is-crashed .thread-text {
    color: var(--color-danger-text);
  }
}

.thread-meta {
  color: var(--color-text-muted);
}

.thread-text {
  color: var(--color-text-primary);
  word-break: break-word;
}

.body-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-3);
}

.persona {
  min-width: 0;
  overflow: hidden;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  white-space: nowrap;
  text-overflow: ellipsis;
}

.dismiss {
  flex-shrink: 0;
  margin-left: auto;
}

.tail {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding-top: var(--space-3);
  border-top: 1px solid var(--color-border-subtle);
}

.earlier {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding-left: 20px;
}

@media (prefers-reduced-motion: reduce) {
  .lanes * {
    animation: none !important;
    transition: none !important;
  }
}
</style>
