<template>
  <!--
    像素画风的任务板：「委托 → 队员 → 成果 → 任务板 → 日志」，和上面的像素办公室是同一个世界。

    一眼看到：委托进行到哪（状态 + 进度格 + 验收章）、每人此刻在干嘛（角色卡上的小人和气泡）、
    交回了什么（成果架上的卷轴）、最近一件事（日志第一行）。
    点了才出现，而且都在原地展开、不跳页：角色详情插在那一行下面，卷轴展开在那一行下面，
    任务板和日志点开往下长。

    颜色是美术数据（同 artV2 的理由）：这块是一幅「游戏界面」，不跟主题反相。
    设计见 docs/团队任务板可读性-2026-10-14.md。
  -->
  <div class="quest" :style="QUEST_VARS">
    <!-- 委托 -->
    <section class="q-banner q-frame" :class="`is-${model.phase}`">
      <div class="banner-main">
        <div class="banner-kicker">
          <PixelSprite :art="FLAG" :scale="2" />
          <PixelLabel
            :text="t('assistant.teamBoard.ui.quest')"
            :color="P.muted"
            :size="12"
            :scale="1"
          />
        </div>
        <p class="banner-goal" :title="objective">{{ objective }}</p>
        <p v-if="team.latestRequest" class="banner-latest" :title="team.latestRequest">
          {{ t('assistant.teamBoard.latestRequest') }}{{ latestRequestLine(team.latestRequest) }}
        </p>
      </div>
      <div class="banner-side">
        <div class="banner-phase">
          <PixelLabel :text="phaseText" :color="phaseColor" :shadow="P.ink" :size="12" :scale="2" />
          <span v-if="busy" class="q-dots" aria-hidden="true"><i /><i /><i /></span>
        </div>
        <div v-if="model.round.length" class="banner-progress">
          <!-- 任务多了折成几行，不往外撑：一行撑出框会把目标挤没、把状态和计数截掉 -->
          <div class="pips" :class="{ 'is-dense': model.round.length > DENSE_PIPS }">
            <span
              v-for="job in model.round"
              :key="job.id"
              class="pip"
              :class="`is-${job.state}`"
              :title="pipTitle(job)"
            />
          </div>
          <PixelText :text="`${roundDone}/${model.round.length}`" :color="P.muted" :scale="2" />
        </div>
      </div>
      <div v-if="stamp" class="stamp" :class="`is-${stamp.tone}`" :title="stamp.title">
        <PixelLabel :text="stamp.text" :color="stamp.color" :size="12" :scale="2" />
      </div>
    </section>

    <!-- 队员 -->
    <header class="q-head">
      <PixelLabel :text="t('assistant.teamBoard.ui.crew')" :color="P.paper" :shadow="P.ink" />
      <PixelText :text="String(model.crew.length)" :color="P.muted" :scale="2" />
    </header>
    <p v-if="!model.crew.length" class="q-empty">{{ t('assistant.teamBoard.ui.recruiting') }}</p>
    <div v-else ref="crewGridRef" class="crew-grid">
      <button
        v-for="(c, i) in model.crew"
        :key="c.id"
        type="button"
        class="crew-card q-frame"
        :class="[`is-${c.mood}`, { 'is-selected': selected === c.id }]"
        :style="{ order: i * 2 }"
        :data-row-item="i"
        :aria-expanded="selected === c.id"
        @click="emit('select', selected === c.id ? null : c.id)"
        @mouseenter="emit('hover', c.id)"
        @mouseleave="emit('hover', null)"
      >
        <span class="card-figure">
          <span v-if="fxOf(c) === 'alert'" class="card-fx is-bounce">
            <PixelText text="!" :color="P.red" :shadow="P.ink" :scale="3" />
          </span>
          <span
            v-else-if="fxOf(c) === 'shaken'"
            class="card-fx is-bounce"
            :title="t('assistant.teamBoard.ui.shaken')"
          >
            <PixelSprite :art="BOLT" :scale="3" />
          </span>
          <span v-else-if="fxOf(c) === 'sleep'" class="card-fx is-float">
            <PixelSprite :art="ZZ" :scale="2" />
          </span>
          <span v-else-if="fxOf(c) === 'wait'" class="card-fx">
            <span class="q-dots is-small" aria-hidden="true"><i /><i /><i /></span>
          </span>
          <CrewPortrait
            :crew="c.crew"
            :hair-style="c.style"
            :look="c.look"
            :pose="poseOf(c)"
            :scale="3"
          />
          <span class="card-floor" />
        </span>
        <span class="card-body">
          <span class="bubble" :class="`is-${c.mood}`" :title="sayOf(c)">
            <span class="bubble-text">{{ sayOf(c) }}</span>
          </span>
          <span class="card-name-row">
            <span class="card-swatch" :style="{ background: colorOf(c) }" />
            <span class="card-name">{{ c.name }}</span>
            <span
              v-if="c.member.readOnly"
              class="card-lock"
              :title="t('assistant.teamBoard.readOnlyHint')"
              :aria-label="t('assistant.teamBoard.readOnly')"
            >
              <PixelSprite :art="LOCK" :scale="2" />
            </span>
            <span
              v-if="c.delivered"
              class="card-loot"
              :title="t('assistant.teamBoard.ui.deliveredCount', { n: c.delivered })"
            >
              <PixelSprite :art="SCROLL" :scale="1" />
              <PixelText :text="`×${c.delivered}`" :color="P.gold" :scale="2" />
            </span>
          </span>
        </span>
      </button>

      <section
        v-if="selectedCrew"
        class="crew-detail q-frame is-gold"
        :style="{ order: crewRow.order.value }"
      >
        <span class="detail-arrow" :style="{ left: `${crewRow.arrow.value - 6}px` }" />
        <div class="detail-col">
          <template v-if="selectedCrew.assignment || selectedCrew.open">
            <h5 class="detail-label">{{ t('assistant.teamBoard.ui.job') }}</h5>
            <p class="detail-job">{{ selectedCrew.assignment || selectedCrew.open?.brief }}</p>
          </template>
          <h5 class="detail-label">{{ t('assistant.teamBoard.steps') }}</h5>
          <ol v-if="steps.length" class="steps">
            <li v-for="(step, index) in steps" :key="index" class="step">
              <span class="step-when">{{ step.showTime ? ago(step.at) : '' }}</span>
              <span
                v-if="step.tool"
                class="step-text"
                :title="[step.tool, ...step.targets].join('\n')"
              >
                {{ toolVerb(step.tool) }}
                <template v-if="step.targets.length">
                  · {{ shortTarget(step.targets.at(-1)!) }}
                  <span v-if="step.targets.length > 1" class="step-count"
                    >×{{ step.targets.length }}</span
                  >
                </template>
              </span>
              <span v-else class="step-text is-speech" :title="step.text">{{ step.text }}</span>
            </li>
          </ol>
          <p v-else class="detail-muted">{{ t('assistant.teamBoard.noSteps') }}</p>
          <div class="detail-meta">
            <TeamMemberModel
              :member="selectedCrew.member"
              :model-choices="modelChoices"
              :models-loaded="modelsLoaded"
              pixel
              @open-models="emit('open-models')"
              @set-model="(name, m) => emit('set-model', name, m)"
            />
            <span
              v-if="selectedCrew.member.persona"
              class="detail-persona"
              :title="selectedCrew.member.persona"
            >
              {{ selectedCrew.member.persona }}
            </span>
            <!-- 外部团队的名册在 Claude Code 那边管，盒子不替它辞人；混合团队的队员在盒子里，照常辞 -->
            <TeamMemberDismiss
              v-if="!team.external || team.hostedMembers"
              class="detail-dismiss"
              :member="selectedCrew.member"
              :team="team"
              :busy="!!selectedCrew.open || !!selectedCrew.assignment"
              pixel
              @dismiss="(name, reason) => emit('dismiss', name, reason)"
            />
          </div>
        </div>
        <div class="detail-col">
          <h5 class="detail-label">
            {{ t('assistant.teamBoard.ui.thread') }}
            <span class="detail-count">{{ threadOf(selectedCrew).length }}</span>
          </h5>
          <ul v-if="threadOf(selectedCrew).length" class="thread">
            <li
              v-for="entry in threadShown"
              :key="entry.key"
              class="thread-item"
              :class="`is-${entry.kind}`"
            >
              <span class="thread-dot" :style="{ background: entryColor(entry) }" />
              <span class="thread-body">
                <span class="thread-meta">{{ entryWho(entry) }} · {{ ago(entry.at) }}</span>
                <span class="thread-text">{{ entryText(entry) }}</span>
              </span>
            </li>
          </ul>
          <p v-else class="detail-muted">{{ t('assistant.teamBoard.ui.noThread') }}</p>
          <button
            v-if="threadOf(selectedCrew).length > THREAD_SHOWN"
            type="button"
            class="q-link"
            @click="threadOpen = !threadOpen"
          >
            {{
              threadOpen
                ? t('assistant.teamBoard.ui.less')
                : t('assistant.teamBoard.ui.more', {
                    n: threadOf(selectedCrew).length - THREAD_SHOWN
                  })
            }}
          </button>
          <template v-if="selectedCrew.tasks.length">
            <h5 class="detail-label">{{ t('assistant.teamBoard.ui.tasksOf') }}</h5>
            <ul class="mini-tasks">
              <li v-for="task in selectedCrew.tasks" :key="task.id" class="mini-task">
                <span class="note" :style="{ background: NOTE_COLORS[task.status] }" />
                <span class="mini-title" :title="task.note || task.title">{{ task.title }}</span>
                <button
                  v-if="task.status === 'blocked'"
                  type="button"
                  class="q-btn is-small"
                  :title="t('assistant.teamBoard.reopenHint')"
                  @click="emit('reopen', task.id)"
                >
                  {{ t('assistant.teamBoard.reopen') }}
                </button>
              </li>
            </ul>
          </template>
        </div>
      </section>
    </div>

    <!-- 成果 -->
    <header class="q-head">
      <PixelLabel :text="t('assistant.teamBoard.ui.loot')" :color="P.paper" :shadow="P.ink" />
      <PixelText :text="String(shelfDone)" :color="P.muted" :scale="2" />
      <span v-if="shelf.some((j) => j.state === 'done')" class="q-hint">
        {{ t('assistant.teamBoard.ui.lootHint') }}
      </span>
    </header>
    <p v-if="!shelf.length" class="q-empty">
      {{
        model.phase === 'planning'
          ? t('assistant.teamBoard.ui.planning')
          : t('assistant.teamBoard.ui.noLoot')
      }}
    </p>
    <div v-else ref="shelfGridRef" class="shelf-grid">
      <template v-for="(job, i) in shelf" :key="job.id">
        <button
          v-if="job.state === 'done'"
          type="button"
          class="slot q-frame"
          :class="{
            'is-open': openJobId === job.id,
            'is-fresh': isFresh(job)
          }"
          :style="{ order: i * 2 }"
          :data-row-item="i"
          :aria-expanded="openJobId === job.id"
          @click="toggleScroll(job.id)"
        >
          <span v-if="isFresh(job)" class="slot-new">
            <PixelText text="NEW" :color="P.ink" :scale="2" />
          </span>
          <span class="slot-top">
            <PixelSprite :art="SCROLL" :scale="3" />
            <span class="slot-title" :title="job.title">{{ job.title }}</span>
          </span>
          <span class="slot-foot">
            <span class="card-swatch" :style="{ background: memberColor(job.member) }" />
            <span class="slot-who">{{ job.member }}</span>
            <span class="slot-when">{{ ago(job.endedAt ?? job.startedAt) }}</span>
          </span>
        </button>
        <div
          v-else
          class="slot q-frame is-empty"
          :class="`is-${job.state}`"
          :style="{ order: i * 2 }"
          :data-row-item="i"
          :title="job.reason || job.brief"
        >
          <span class="slot-top">
            <PixelSprite v-if="job.state !== 'writing'" :art="TORN" :scale="3" />
            <span class="slot-title is-dim">{{ job.title }}</span>
          </span>
          <span v-if="job.state === 'writing'" class="slot-bar" aria-hidden="true"><i /></span>
          <span class="slot-foot">
            <span class="card-swatch" :style="{ background: memberColor(job.member) }" />
            <span class="slot-who">{{ job.member }}</span>
            <span v-if="job.state === 'writing'" class="slot-state">
              {{ t('assistant.teamBoard.ui.writing')
              }}<span class="q-dots is-inline"><i /><i /><i /></span>
            </span>
            <span v-else class="slot-state is-bad">
              {{
                job.state === 'lost'
                  ? t('assistant.teamBoard.ui.lost')
                  : t('assistant.teamBoard.ui.stopped')
              }}
            </span>
          </span>
        </div>
      </template>

      <section
        v-if="openJob"
        :key="openJob.id"
        class="scroll-open"
        :style="{ order: shelfRow.order.value }"
      >
        <span class="detail-arrow is-brass" :style="{ left: `${shelfRow.arrow.value - 6}px` }" />
        <div class="rod" />
        <div class="parchment">
          <div class="parch-head">
            <h4 class="parch-title">{{ openJob.title }}</h4>
            <span class="parch-meta">
              {{
                t('assistant.teamBoard.ui.deliveredBy', {
                  name: openJob.member,
                  ago: ago(openJob.endedAt ?? openJob.startedAt)
                })
              }}
            </span>
          </div>
          <div class="parch-body" :class="{ 'is-clamped': !fullText }">
            <div class="parch-md">
              <MarkdownRenderer :content="openJob.body || openJob.title" />
            </div>
          </div>
          <div class="parch-actions">
            <button type="button" class="q-link is-ink" @click="fullText = !fullText">
              {{
                fullText ? t('assistant.teamBoard.ui.collapse') : t('assistant.teamBoard.ui.expand')
              }}
              <template v-if="!fullText && openJob.sections > 1">
                · {{ t('assistant.teamBoard.sections', { n: openJob.sections }) }}
              </template>
            </button>
            <button type="button" class="q-link is-ink" @click="openJobId = null">
              {{ t('assistant.teamBoard.ui.roll') }}
            </button>
          </div>
        </div>
        <div class="rod" />
      </section>
    </div>
    <button
      v-if="earlierToFold.length"
      type="button"
      class="q-link is-fold"
      :aria-expanded="earlierOpen"
      @click="earlierOpen = !earlierOpen"
    >
      {{
        earlierOpen
          ? t('assistant.teamBoard.ui.earlierHide')
          : t('assistant.teamBoard.ui.earlier', { n: earlierToFold.length })
      }}
    </button>

    <!-- 停下的活：不占成果架的格子，折成一行；点开看原因、停前在做什么，能交回制作人 -->
    <section v-if="stops.length" class="q-fold-box q-frame is-stops">
      <button
        type="button"
        class="fold-head"
        :aria-expanded="stopsOpen"
        @click="stopsOpen = !stopsOpen"
      >
        <PixelSprite :art="TORN" :scale="2" />
        <span class="stops-line" :title="stopsLine">{{ stopsLine }}</span>
        <span class="fold-toggle">{{
          stopsOpen ? t('assistant.teamBoard.ui.less') : t('assistant.teamBoard.ui.logAll')
        }}</span>
      </button>
      <ul v-if="stopsOpen" class="log-list">
        <li v-for="job in stops" :key="job.id" class="stop-item">
          <div class="stop-top">
            <span class="card-swatch" :style="{ background: memberColor(job.member) }" />
            <span class="slot-who">{{ job.member }}</span>
            <span class="stop-when" :title="exact(job.endedAt ?? job.startedAt)">{{
              ago(job.endedAt ?? job.startedAt)
            }}</span>
            <button
              v-if="job.state === 'stopped'"
              type="button"
              class="q-link"
              :title="t('assistant.teamBoard.reopenJobHint')"
              @click="emit('reopen-job', job.id)"
            >
              {{ t('assistant.teamBoard.reopen') }}
            </button>
          </div>
          <p class="stop-brief">{{ job.brief || job.title }}</p>
          <p v-if="job.reason" class="stop-reason">
            {{ t('assistant.teamBoard.ui.stopReason', { reason: job.reason }) }}
          </p>
          <template v-if="stopSteps(job).length">
            <h5 class="detail-label">{{ t('assistant.teamBoard.ui.stopSteps') }}</h5>
            <ol class="steps">
              <li v-for="(step, index) in stopSteps(job)" :key="index" class="step">
                <span class="step-when">{{ step.showTime ? ago(step.at) : '' }}</span>
                <span
                  v-if="step.tool"
                  class="step-text"
                  :title="[step.tool, ...step.targets].join('\n')"
                >
                  {{ toolVerb(step.tool) }}
                  <template v-if="step.targets.length">
                    · {{ shortTarget(step.targets.at(-1)!) }}
                  </template>
                </span>
                <span v-else class="step-text is-speech" :title="step.text">{{ step.text }}</span>
              </li>
            </ol>
          </template>
        </li>
      </ul>
    </section>

    <!-- 任务板 -->
    <section v-if="team.board.length" class="q-fold-box q-frame">
      <button
        type="button"
        class="fold-head"
        :aria-expanded="boardOpen"
        @click="boardOpen = !boardOpen"
      >
        <PixelLabel :text="t('assistant.teamBoard.ui.board')" :color="P.paper" :shadow="P.ink" />
        <PixelText :text="String(team.board.length)" :color="P.muted" :scale="2" />
        <span v-if="model.blocked" class="fold-alert">
          {{ t('assistant.teamBoard.ui.alertBlocked', { n: model.blocked }) }}
        </span>
        <span class="fold-toggle">{{
          boardOpen ? t('assistant.teamBoard.ui.less') : t('assistant.teamBoard.ui.open')
        }}</span>
      </button>
      <ul v-if="boardOpen" class="board-list">
        <li
          v-for="task in boardSorted"
          :key="task.id"
          class="board-item"
          :class="`is-${task.status}`"
        >
          <span class="note" :style="{ background: NOTE_COLORS[task.status] }" />
          <span class="board-text">
            <span class="board-title">{{ task.title }}</span>
            <span v-if="task.note || task.evidence" class="board-note">{{
              task.note || task.evidence
            }}</span>
          </span>
          <span class="board-owner">
            <template v-if="task.owner">
              <span class="card-swatch" :style="{ background: memberColor(task.owner) }" />{{
                task.owner
              }}
            </template>
          </span>
          <span class="board-status">{{ taskStatus(task) }}</span>
          <button
            v-if="task.status === 'blocked'"
            type="button"
            class="q-btn is-small"
            :title="t('assistant.teamBoard.reopenHint')"
            @click="emit('reopen', task.id)"
          >
            {{ t('assistant.teamBoard.reopen') }}
          </button>
        </li>
      </ul>
    </section>

    <!-- 日志 -->
    <section v-if="model.log.length" class="q-fold-box q-frame is-log">
      <button type="button" class="fold-head" :aria-expanded="logOpen" @click="logOpen = !logOpen">
        <PixelSprite :art="QUILL" :scale="2" />
        <PixelLabel :text="t('assistant.teamBoard.ui.log')" :color="P.paper" :shadow="P.ink" />
        <PixelText :text="String(model.log.length)" :color="P.muted" :scale="2" />
        <span class="fold-toggle">{{
          logOpen ? t('assistant.teamBoard.ui.less') : t('assistant.teamBoard.ui.logAll')
        }}</span>
      </button>
      <ul class="log-list">
        <li v-for="entry in logShown" :key="entry.key" class="log-item" :class="`is-${entry.kind}`">
          <span class="log-when" :title="exact(entry.at)">{{ ago(entry.at) }}</span>
          <span class="log-icon">
            <PixelSprite v-if="entry.kind === 'delivered'" :art="SCROLL" :scale="1" />
            <PixelSprite v-else-if="entry.kind === 'stopped'" :art="TORN" :scale="1" />
            <PixelSprite
              v-else-if="entry.kind === 'verdict'"
              :art="entry.verdict === 'pass' ? CHECK : CROSS"
              :scale="2"
            />
            <PixelSprite
              v-else-if="entry.kind === 'crashed' || entry.kind === 'recoverFailed'"
              :art="BOLT"
              :scale="2"
            />
            <span v-else class="thread-dot" :style="{ background: entryColor(entry) }" />
          </span>
          <span class="log-body">
            <button
              v-if="entry.kind === 'delivered' && entry.jobId && shelfHas(entry.jobId)"
              type="button"
              class="log-text is-link"
              @click="openFromLog(entry.jobId)"
            >
              {{ entryText(entry) }}
            </button>
            <!-- 队员之间的信是模型写的，满是 Markdown；系统事件是我们拼的一句话，照原样 -->
            <template v-else-if="entry.kind === 'mail'">
              <span class="log-who is-block">{{ entryWho(entry) }}</span>
              <div class="log-md">
                <MarkdownRenderer :content="entry.text" />
              </div>
            </template>
            <span v-else class="log-text">{{ entryText(entry) }}</span>
          </span>
        </li>
      </ul>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import {
  PRODUCER,
  type BoardTask,
  type TeamActivity,
  type TeamModel,
  type TeamModelCandidate,
  type TeamStateView
} from '@core/shared/agentTeam'

import type { TeamReportTab } from '../../composables/useTeamTab'
import MarkdownRenderer from '../MarkdownRenderer.vue'
import TeamMemberDismiss from '../TeamMemberDismiss.vue'
import TeamMemberModel from '../TeamMemberModel.vue'
import {
  latestRequestLine,
  type BoardModel,
  type CrewView,
  type JobView,
  type LogEntry
} from '../teamBoardModel'
import { useTeamLabels } from '../teamBoardLabels'
import { recentSteps, shortTarget } from '../teamBoardView'
import type { Pose } from '../teamOffice/officeSim'
import { crewColor } from '../teamOffice/officeStyle'
import CrewPortrait from './CrewPortrait.vue'
import PixelLabel from './PixelLabel.vue'
import PixelSprite from './PixelSprite.vue'
import PixelText from './PixelText.vue'
import { BOLT, CHECK, CROSS, FLAG, LOCK, NOTE_COLORS, QUILL, SCROLL, TORN, ZZ } from './pixelArt'
import { QUEST_PALETTE, QUEST_VARS } from './questPalette'
import { useRowInsert } from './useRowInsert'

const props = defineProps<{
  team: TeamStateView
  model: BoardModel
  activity: TeamActivity[]
  /** 选中的队员（名字小写）。办公室里点人也会改它 */
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
  'open-report': [report: TeamReportTab]
}>()
const { t } = useI18n()
const { ago, exact, who, toolVerb, statusText } = useTeamLabels()

/** 画在小画布上的字（点阵标题、数字）要直接给颜色，取同一套配色 */
const P = {
  ink: QUEST_PALETTE.ink,
  paper: QUEST_PALETTE.paper,
  muted: QUEST_PALETTE.muted,
  gold: QUEST_PALETTE.gold,
  red: QUEST_PALETTE.red,
  green: QUEST_PALETTE.green
} as const

const objective = computed(() => props.team.objective)
const memberColor = (name: string): string => {
  const c = props.model.crew.find((x) => x.id === name.trim().toLowerCase())
  return name.trim().toLowerCase() === PRODUCER
    ? crewColor(-1, 'v2')
    : crewColor(c?.crew ?? 0, 'v2')
}
const colorOf = (c: CrewView): string => crewColor(c.crew, 'v2')

// ── 委托 ────────────────────────────────────────────────────────────────

const busy = computed(() => props.model.phase === 'working' || props.model.phase === 'planning')
const roundDone = computed(() => props.model.round.filter((j) => j.state === 'done').length)
/** 进度格超过这么多就收窄，一行放得更多（见 `.pips.is-dense`） */
const DENSE_PIPS = 24

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
const phaseColor = computed(() =>
  props.model.phase === 'alert'
    ? P.red
    : props.model.phase === 'done'
      ? P.green
      : props.model.phase === 'idle'
        ? P.muted
        : P.gold
)

function pipTitle(job: JobView): string {
  return `${job.member} · ${job.title} · ${t(`assistant.teamBoard.ui.state.${job.state}`)}`
}

/** 验收章：只盖这一轮、没人在跑时的结论（见 buildBoardModel） */
const stamp = computed(() => {
  const v = props.model.verdict
  if (!v) return null
  const text = v.stale
    ? t('assistant.teamBoard.verdict.stale')
    : t(`assistant.teamBoard.verdict.${v.kind}`)
  const tone = v.stale ? 'muted' : v.kind === 'pass' ? 'pass' : 'fail'
  return {
    text,
    tone,
    color: tone === 'pass' ? P.green : tone === 'fail' ? P.red : P.muted,
    title:
      v.at !== undefined
        ? t('assistant.teamBoard.verdictTitle', { count: v.count, when: ago(v.at) })
        : undefined
  }
})

// ── 队员 ────────────────────────────────────────────────────────────────

const LONG_IDLE_MS = 30 * 60_000
const FRESH_MS = 10 * 60_000

function lastDeliveredAt(c: CrewView): number | undefined {
  return c.jobs.find((j) => j.state === 'done')?.endedAt
}

function poseOf(c: CrewView): Pose {
  if (c.mood === 'alert') return 'facepalm'
  if (c.mood === 'work') return 'write'
  if (c.mood === 'wait') return 'chat'
  const done = lastDeliveredAt(c)
  const now = Date.now()
  if (done !== undefined && now - done < FRESH_MS) return 'cheer'
  if (done === undefined || now - done > LONG_IDLE_MS) return 'sleep'
  return 'drink'
}

function fxOf(c: CrewView): 'alert' | 'shaken' | 'sleep' | 'wait' | null {
  if (c.mood === 'alert') return 'alert'
  // 闲下来以后崩没崩过就不要紧了，只在还在干的人头上挂
  if (c.shaken && (c.mood === 'work' || c.mood === 'wait')) return 'shaken'
  if (c.mood === 'wait') return 'wait'
  if (poseOf(c) === 'sleep') return 'sleep'
  return null
}

function sayOf(c: CrewView): string {
  return statusText(c.status)
}

const crewGridRef = ref<HTMLElement | null>(null)
const selectedIndex = (): number => props.model.crew.findIndex((c) => c.id === props.selected)
const crewRow = useRowInsert(crewGridRef, () => props.model.crew.length, selectedIndex)
const selectedCrew = computed(() => props.model.crew.find((c) => c.id === props.selected) ?? null)

const steps = computed(() =>
  selectedCrew.value ? recentSteps(props.activity, selectedCrew.value.name, 6) : []
)

/** 往来只看说的话和崩溃：他交的活在成果架上，不在这里重复 */
const threadOf = (c: CrewView): LogEntry[] =>
  c.thread.filter((e) => e.kind === 'mail' || e.kind === 'crashed')
const THREAD_SHOWN = 3
const threadOpen = ref(false)
watch(
  () => props.selected,
  () => (threadOpen.value = false)
)
const threadShown = computed(() => {
  const list = selectedCrew.value ? threadOf(selectedCrew.value) : []
  return threadOpen.value ? list : list.slice(0, THREAD_SHOWN)
})

// ── 成果 ────────────────────────────────────────────────────────────────

/**
 * 成果架：这一轮的活。交回的新的在前，然后是在写的。
 * 停下的不上架 —— 它没交回任何东西，折在架子下面那一行里（`model.stops`）。
 * 这一轮还没派活时，拿之前交回的摆上去 —— 刚打开面板不该是一个空架子
 */
const shelfBase = computed(() => {
  const { round, earlier } = props.model
  const current = round.length
    ? [
        ...round.filter((j) => j.state === 'done').reverse(),
        ...round.filter((j) => j.state === 'writing')
      ]
    : earlier.slice(0, 6)
  if (!props.selected) return current
  // 点了某个人：架子上只摆他的，之前几轮的也一起摆出来，不再折
  const all = round.length ? [...current, ...earlier] : earlier
  return all.filter((j) => j.memberId === props.selected)
})
const earlierToFold = computed(() =>
  props.selected
    ? []
    : props.model.round.length
      ? props.model.earlier
      : props.model.earlier.slice(6)
)
const earlierOpen = ref(false)
const shelf = computed(() =>
  earlierOpen.value ? [...shelfBase.value, ...earlierToFold.value] : shelfBase.value
)
const shelfDone = computed(() => shelf.value.filter((j) => j.state === 'done').length)

const isFresh = (job: JobView): boolean =>
  job.state === 'done' && job.current && Date.now() - (job.endedAt ?? 0) < FRESH_MS

const openJobId = ref<string | null>(null)
const fullText = ref(false)
const openJob = computed(
  () => shelf.value.find((j) => j.id === openJobId.value && j.state === 'done') ?? null
)
function toggleScroll(id: string): void {
  openJobId.value = openJobId.value === id ? null : id
  fullText.value = false
}
const shelfGridRef = ref<HTMLElement | null>(null)
const shelfRow = useRowInsert(
  shelfGridRef,
  () => shelf.value.length,
  () => shelf.value.findIndex((j) => j.id === openJobId.value)
)

// ── 停下的活 ──────────────────────────────────────────────────────────────

const stopsOpen = ref(false)
/** 停下的活跟成果架一样，点了某个人就只看他的 */
const stops = computed(() =>
  props.selected
    ? props.model.stops.filter((j) => j.memberId === props.selected)
    : props.model.stops
)

/** 折起来那一行：几件、谁的；原因全一样（多半是同一个环境问题）就直接写出来 */
const stopsLine = computed(() => {
  const list = stops.value
  const names = [...new Set(list.map((j) => j.member))].join('、')
  const reasons = new Set(list.map((j) => j.reason ?? ''))
  const [reason] = reasons
  return reasons.size === 1 && reason
    ? t('assistant.teamBoard.ui.stopsLineReason', { n: list.length, who: names, reason })
    : t('assistant.teamBoard.ui.stopsLine', { n: list.length, who: names })
})

/** 这件活从开工到停下之间，这个人最后几步。动态只存在这次打开盒子之后，早的就没有 */
function stopSteps(job: JobView): ReturnType<typeof recentSteps> {
  const end = job.endedAt ?? Number.POSITIVE_INFINITY
  const during = props.activity.filter((line) => line.at >= job.startedAt && line.at <= end)
  return recentSteps(during, job.member, 4)
}

const shelfHas = (jobId: string): boolean =>
  props.model.round.some((j) => j.id === jobId) || props.model.earlier.some((j) => j.id === jobId)
/** 日志里点一份交付：右侧面板另开一个页签看全文，不在上面的架子里就地展开（离得远，点了像没反应） */
function openFromLog(jobId: string): void {
  const job = [...props.model.round, ...props.model.earlier].find((j) => j.id === jobId)
  if (job) emit('open-report', { id: job.id, title: job.title })
}

// ── 任务板 ──────────────────────────────────────────────────────────────

const boardOpen = ref(false)
const ORDER = { blocked: 0, doing: 1, todo: 2, done: 3 } as const
const boardSorted = computed(() =>
  [...props.team.board].sort(
    (a, b) => ORDER[a.status] - ORDER[b.status] || b.updatedAt - a.updatedAt
  )
)
const accepted = computed(() => props.team.verdict === 'pass' && !props.team.verdictStale)
function taskStatus(task: BoardTask): string {
  return task.status === 'done' && !accepted.value
    ? t('assistant.teamBoard.status.selfReported')
    : t(`assistant.teamBoard.status.${task.status}`)
}

// ── 日志 ────────────────────────────────────────────────────────────────

const logOpen = ref(false)
const LOG_MAX = 60
const logShown = computed(() =>
  logOpen.value ? props.model.log.slice(0, LOG_MAX) : props.model.log.slice(0, 1)
)

function entryColor(entry: LogEntry): string {
  return entry.from ? memberColor(entry.from) : P.muted
}

function entryWho(entry: LogEntry): string {
  if (entry.kind !== 'mail' || !entry.from) return entry.from ? who(entry.from) : ''
  return t('assistant.teamBoard.ui.mailTo', {
    from: who(entry.from),
    to: entry.to.map(who).join('、')
  })
}

function entryText(entry: LogEntry): string {
  switch (entry.kind) {
    case 'mail':
      return entry.text
    case 'delivered':
      return t('assistant.teamBoard.ui.logDelivered', { name: entry.from ?? '', title: entry.text })
    case 'stopped':
      return t('assistant.teamBoard.ui.logStopped', { name: entry.from ?? '', reason: entry.text })
    case 'crashed':
      return entry.text
        ? t('assistant.teamBoard.ui.logCrashedDetail', { detail: entry.text })
        : t('assistant.teamBoard.ui.logCrashed')
    case 'recovered':
      return t('assistant.teamBoard.ui.logRecovered')
    case 'recoverFailed':
      return t('assistant.teamBoard.ui.logRecoverFailed', { detail: entry.text })
    case 'verdict':
      return t(`assistant.teamBoard.verdict.${entry.verdict ?? 'fail'}`)
  }
}
</script>

<style scoped lang="less">
/*
 * 像素界面的几条规矩：
 *   - 边框是「缺角」的：四条 box-shadow 拼出来，角上留空，像老游戏的对话框
 *   - 立体感靠内侧一亮一暗两道，不用渐变和模糊阴影
 *   - 动画按格走（steps），不做缓动
 */
.quest {
  container-type: inline-size;
  display: flex;
  flex-direction: column;
  padding: 16px 16px 20px;
  background:
    linear-gradient(var(--q-ink-soft) 0 0) top / 100% 3px no-repeat,
    var(--q-bg);
  color: var(--q-paper);
  font-size: 13px;
  line-height: 1.55;
}

.q-frame {
  --f: var(--q-edge);
  background: var(--q-panel);
  box-shadow:
    0 -3px 0 0 var(--f),
    0 3px 0 0 var(--f),
    -3px 0 0 0 var(--f),
    3px 0 0 0 var(--f),
    inset 3px 3px 0 0 rgba(255, 236, 200, 0.06),
    inset -3px -3px 0 0 rgba(0, 0, 0, 0.28);
}

button.q-frame {
  font: inherit;
  color: inherit;
  border: none;
  text-align: left;
  cursor: pointer;
}

.q-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 26px 0 14px;
}

.q-hint {
  margin-left: 4px;
  color: var(--q-dim);
  font-size: 12px;
}

.q-empty {
  margin: 0;
  padding: 14px 16px;
  color: var(--q-muted);
  font-size: 12px;
  border: 2px dashed var(--q-edge);
}

.card-swatch {
  display: inline-block;
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  margin-right: 6px;
  vertical-align: 1px;
  box-shadow: 1px 1px 0 0 var(--q-ink);
}

/* 三个方点轮流亮：等着、在写 */
.q-dots {
  display: inline-flex;
  gap: 3px;
  margin-left: 6px;

  i {
    width: 4px;
    height: 4px;
    background: currentColor;
    animation: q-dot 1.2s steps(1) infinite;
  }

  i:nth-child(2) {
    animation-delay: 0.4s;
  }

  i:nth-child(3) {
    animation-delay: 0.8s;
  }

  &.is-small i {
    width: 3px;
    height: 3px;
  }

  &.is-inline {
    margin-left: 3px;
    vertical-align: 2px;
  }
}

@keyframes q-dot {
  0%,
  66% {
    opacity: 0.25;
  }
  33% {
    opacity: 1;
  }
}

/* ── 委托 ── */

.q-banner {
  --f: var(--q-banner-edge);
  position: relative;
  display: flex;
  align-items: center;
  gap: 16px;
  margin: 3px;
  padding: 14px 16px;
  background:
    repeating-linear-gradient(90deg, transparent 0 22px, var(--q-stripe) 22px 24px), var(--q-banner);

  &.is-alert {
    --f: var(--q-red-edge);
  }

  &.is-done {
    --f: var(--q-green-edge);
  }
}

.banner-main {
  flex: 1;
  min-width: 0;
}

/* 窄面板：目标独占一行，状态、进度、验收章排到下一行 */
@container (max-width: 460px) {
  .q-banner {
    flex-wrap: wrap;
  }

  .banner-main {
    flex-basis: 100%;
  }

  .banner-side {
    flex: 1;
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
  }
}

.banner-kicker {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}

.banner-goal {
  margin: 0;
  color: var(--q-paper);
  font-size: 14px;
  font-weight: 600;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.banner-latest {
  margin: 4px 0 0;
  color: var(--q-muted);
  font-size: 12px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.banner-side {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  flex-shrink: 1;
  min-width: 0;
  max-width: 60%;
}

.banner-phase {
  display: flex;
  align-items: center;
  color: var(--q-gold);

  .is-alert & {
    color: var(--q-red);
  }
}

.banner-progress {
  display: flex;
  align-items: flex-end;
  gap: 9px;
  min-width: 0;
  max-width: 100%;
}

/* 一行最多 24 格（12px + 3px 间距），多了往下折；超过 24 项时格子收窄，一行放得更多 */
.pips {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 3px;
  min-width: 0;
  max-width: calc(24 * 15px);

  &.is-dense .pip {
    width: 8px;
  }
}

.pip {
  flex-shrink: 0;
  width: 12px;
  height: 8px;
  background: var(--q-edge);
  box-shadow: inset -2px -2px 0 0 rgba(0, 0, 0, 0.3);

  &.is-done {
    background: var(--q-gold);
  }

  &.is-writing {
    background: var(--q-edge-hi);
    animation: q-blink 1s steps(1) infinite;
  }

  &.is-stopped,
  &.is-lost {
    background: var(--q-red);
  }
}

@keyframes q-blink {
  50% {
    opacity: 0.3;
  }
}

.stamp {
  flex-shrink: 0;
  padding: 4px 8px;
  transform: rotate(-7deg);
  box-shadow:
    0 -3px 0 0 currentColor,
    0 3px 0 0 currentColor,
    -3px 0 0 0 currentColor,
    3px 0 0 0 currentColor;
  animation: q-stamp 0.32s steps(4);

  &.is-pass {
    color: var(--q-green);
  }

  &.is-fail {
    color: var(--q-red);
  }

  &.is-muted {
    color: var(--q-muted);
  }
}

@keyframes q-stamp {
  0% {
    transform: rotate(-7deg) scale(1.8);
    opacity: 0;
  }
  100% {
    transform: rotate(-7deg) scale(1);
    opacity: 1;
  }
}

/* ── 队员 ── */

.crew-grid {
  position: relative;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(176px, 1fr));
  gap: 18px 16px;
  padding: 3px;
}

.crew-card {
  display: flex;
  align-items: flex-end;
  gap: 10px;
  min-width: 0;
  min-height: 124px;
  padding: 26px 12px 10px 6px;

  &:hover {
    background: var(--q-panel-hi);
  }

  &:focus-visible {
    outline: 2px solid var(--q-gold);
    outline-offset: 5px;
  }

  &.is-selected {
    --f: var(--q-gold);
    background: var(--q-panel-hi);
  }

  &.is-alert {
    --f: var(--q-red-edge);
  }

  &.is-alert.is-selected {
    --f: var(--q-red);
  }
}

.card-figure {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  flex-shrink: 0;
}

.card-floor {
  width: 40px;
  height: 3px;
  margin-top: -3px;
  background: var(--q-shade);
}

.card-fx {
  position: absolute;
  top: -4px;
  left: 50%;
  transform: translateX(-50%);
  color: var(--q-paper);
  z-index: 1;

  &.is-bounce {
    animation: q-bounce 0.8s steps(2) infinite;
  }

  &.is-float {
    top: 0;
    left: 70%;
    animation: q-float 2.4s steps(4) infinite;
  }
}

@keyframes q-bounce {
  50% {
    transform: translate(-50%, -3px);
  }
}

@keyframes q-float {
  0% {
    transform: translate(-50%, 4px);
    opacity: 0;
  }
  40% {
    opacity: 1;
  }
  100% {
    transform: translate(-20%, -8px);
    opacity: 0;
  }
}

.card-body {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
}

/* 头顶的对话气泡：缺角的白底 + 左下一个方尾巴 */
.bubble {
  --b: var(--q-bubble);
  position: relative;
  display: block;
  margin: 2px 2px 14px;
  padding: 5px 8px;
  background: var(--b);
  color: var(--q-ink-soft);
  font-size: 12px;
  line-height: 1.45;
  box-shadow:
    0 -2px 0 0 var(--b),
    0 2px 0 0 var(--b),
    -2px 0 0 0 var(--b),
    2px 0 0 0 var(--b),
    0 4px 0 0 rgba(0, 0, 0, 0.25);

  &::after {
    content: '';
    position: absolute;
    left: 4px;
    bottom: -8px;
    width: 6px;
    height: 4px;
    background: var(--b);
    box-shadow: -2px 2px 0 0 var(--b);
  }

  &.is-idle,
  &.is-wait {
    --b: var(--q-rule);
    color: var(--q-muted);
  }

  &.is-alert {
    --b: var(--q-alert-bubble);
    color: var(--q-alert-ink);
  }
}

.bubble-text {
  display: -webkit-box;
  overflow: hidden;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow-wrap: anywhere;
}

.card-name-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.card-name {
  min-width: 0;
  overflow: hidden;
  color: var(--q-paper);
  font-weight: 600;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.card-lock {
  display: inline-flex;
  flex-shrink: 0;
}

.crew-card {
  position: relative;
}

/* 交回几份：右上角一枚小牌子，不占名字那一行 */
.card-loot {
  position: absolute;
  top: 8px;
  right: 8px;
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

/* 详情：插在那一行下面，小三角指着那张卡 */
.crew-detail {
  --f: var(--q-gold);
  position: relative;
  grid-column: 1 / -1;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr);
  gap: 22px;
  padding: 16px 18px;
  animation: q-open 0.24s steps(3);
}

@container (max-width: 520px) {
  .crew-detail {
    grid-template-columns: minmax(0, 1fr);
  }
}

@keyframes q-open {
  from {
    clip-path: inset(0 0 100% 0);
  }
  to {
    clip-path: inset(0 0 0 0);
  }
}

.detail-arrow {
  position: absolute;
  top: -12px;
  width: 12px;
  height: 9px;
  background: var(--q-gold);
  clip-path: polygon(50% 0, 100% 100%, 0 100%);

  &.is-brass {
    top: -14px;
    background: var(--q-brass);
  }
}

.detail-col {
  min-width: 0;
}

.detail-label {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 8px;
  color: var(--q-gold);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.08em;

  &:not(:first-child) {
    margin-top: 16px;
  }
}

.detail-count {
  color: var(--q-dim);
  font-weight: 400;
}

.detail-job {
  margin: 0;
  color: var(--q-paper);
}

.detail-muted {
  margin: 0;
  color: var(--q-dim);
  font-size: 12px;
}

.steps {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.step {
  display: grid;
  grid-template-columns: 4.6em minmax(0, 1fr);
  gap: 8px;
  font-size: 12px;
}

.step-when {
  color: var(--q-dim);
}

.step-text {
  min-width: 0;
  overflow: hidden;
  color: var(--q-muted);
  white-space: nowrap;
  text-overflow: ellipsis;

  &::before {
    content: '';
    display: inline-block;
    width: 4px;
    height: 4px;
    margin-right: 6px;
    vertical-align: 2px;
    background: var(--q-brass);
  }

  &.is-speech {
    font-style: italic;
  }
}

.step-count {
  margin-left: 4px;
  color: var(--q-dim);
}

.detail-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 16px;
}

.detail-persona {
  min-width: 0;
  overflow: hidden;
  color: var(--q-dim);
  font-size: 12px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.detail-dismiss {
  flex-shrink: 0;
  margin-left: auto;
}

.thread {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.thread-item {
  display: grid;
  grid-template-columns: 8px minmax(0, 1fr);
  gap: 8px;
  font-size: 12px;
}

.thread-dot {
  width: 8px;
  height: 8px;
  margin-top: 5px;
  box-shadow: 1px 1px 0 0 var(--q-ink);
}

.thread-body {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.thread-meta {
  color: var(--q-dim);
}

.thread-text {
  display: -webkit-box;
  overflow: hidden;
  color: var(--q-paper);
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  word-break: break-word;

  .is-crashed & {
    color: var(--q-red);
  }
}

.mini-tasks {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.mini-task {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.mini-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--q-paper);
  white-space: nowrap;
  text-overflow: ellipsis;
}

.note {
  flex-shrink: 0;
  width: 10px;
  height: 10px;
  box-shadow:
    inset -2px -2px 0 0 rgba(0, 0, 0, 0.2),
    1px 1px 0 0 var(--q-ink);
}

/* ── 成果 ── */

.shelf-grid {
  position: relative;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(156px, 1fr));
  gap: 18px 16px;
  padding: 3px;
}

.slot {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  min-height: 92px;
  padding: 12px;

  &:is(button):hover {
    background: var(--q-panel-hi);
  }

  &:focus-visible {
    outline: 2px solid var(--q-gold);
    outline-offset: 5px;
  }

  &.is-open {
    --f: var(--q-brass);
    background: var(--q-panel-hi);
  }

  &.is-fresh {
    animation: q-drop 0.5s steps(5);
  }

  &.is-empty {
    --f: var(--q-rule);
    background: transparent;
    box-shadow:
      0 -3px 0 0 var(--f),
      0 3px 0 0 var(--f),
      -3px 0 0 0 var(--f),
      3px 0 0 0 var(--f);
  }

  &.is-stopped,
  &.is-lost {
    --f: var(--q-red-deep);
  }
}

@keyframes q-drop {
  0% {
    transform: translateY(-14px);
    opacity: 0;
  }
  60% {
    transform: translateY(3px);
    opacity: 1;
  }
  100% {
    transform: none;
  }
}

.slot-new {
  position: absolute;
  top: -9px;
  right: -6px;
  padding: 2px 3px 1px;
  background: var(--q-gold);
  box-shadow: 2px 2px 0 0 var(--q-ink);
  animation: q-blink 1.4s steps(1) infinite;
}

.slot-top {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  min-width: 0;
}

.slot-title {
  display: -webkit-box;
  min-width: 0;
  overflow: hidden;
  color: var(--q-paper);
  font-weight: 600;
  line-height: 1.4;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  word-break: break-all;

  &.is-dim {
    color: var(--q-muted);
    font-weight: 400;
  }
}

.slot-foot {
  display: flex;
  align-items: center;
  gap: 0;
  min-width: 0;
  margin-top: auto;
  color: var(--q-muted);
  font-size: 12px;
}

.slot-who {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.slot-when,
.slot-state {
  flex-shrink: 0;
  margin-left: auto;
  padding-left: 8px;
  color: var(--q-dim);
}

.slot-state.is-bad {
  color: var(--q-red);
}

/* 在写：一条一格一格往前走的进度条 */
.slot-bar {
  position: relative;
  height: 6px;
  overflow: hidden;
  background: var(--q-ink-soft);

  i {
    position: absolute;
    inset: 0 auto 0 0;
    width: 30%;
    background: repeating-linear-gradient(90deg, var(--q-edge-hi) 0 6px, transparent 6px 8px);
    animation: q-crawl 1.8s steps(9) infinite;
  }
}

@keyframes q-crawl {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(340%);
  }
}

/* 展开的卷轴：上下两根黄铜轴，中间羊皮纸逐格展开 */
.scroll-open {
  position: relative;
  grid-column: 1 / -1;
  margin: 4px 6px 0;
}

.rod {
  height: 10px;
  background: var(--q-brass);
  box-shadow:
    inset 0 3px 0 0 var(--q-gold),
    inset 0 -3px 0 0 var(--q-brass-dark),
    -8px 0 0 0 var(--q-brass-deep),
    8px 0 0 0 var(--q-brass-deep);
}

.parchment {
  margin: 0 8px;
  padding: 16px 22px 14px;
  background: var(--q-parchment);
  color: var(--q-parch-ink);
  animation: q-unroll 0.42s steps(6);
}

@keyframes q-unroll {
  from {
    clip-path: inset(0 0 100% 0);
  }
  to {
    clip-path: inset(0 0 0 0);
  }
}

.parch-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 4px 14px;
  margin-bottom: 10px;
  padding-bottom: 10px;
  border-bottom: 2px dashed var(--q-parch-rule);
}

.parch-title {
  margin: 0;
  color: var(--q-ink-soft);
  font-size: 15px;
  font-weight: 700;
}

.parch-meta {
  color: var(--q-parch-meta);
  font-size: 12px;
}

.parch-body {
  position: relative;

  &.is-clamped {
    max-height: 220px;
    overflow: hidden;

    /* 折起来的下沿：两排棋盘格抖动淡出，像素画里的「渐隐」 */
    &::after {
      content: '';
      position: absolute;
      inset: auto 0 0 0;
      height: 16px;
      background:
        linear-gradient(var(--q-parchment) 0 0) bottom / 100% 8px no-repeat,
        conic-gradient(
            var(--q-parchment) 25%,
            transparent 0 50%,
            var(--q-parchment) 0 75%,
            transparent 0
          )
          top / 4px 4px;
    }
  }
}

.parch-md {
  /* 羊皮纸上是深色墨水：把正文渲染器读的那几个主题色就地换成墨色 */
  --color-text-primary: var(--q-parch-ink);
  --color-text-secondary: var(--q-parch-meta);
  --color-text-muted: var(--q-parch-meta);
  --color-border: var(--q-parch-rule);
  --color-border-subtle: var(--q-parch-rule);
  --color-border-strong: var(--q-parch-quote);
  --color-accent-text: var(--q-parch-link);
  --color-accent-border: var(--q-parch-quote);
  --color-accent-bg: var(--q-parch-code);
  --color-bg-sunken: var(--q-parch-code);
  --color-bg-surface: var(--q-parchment);
  --color-bg-surface-hover: var(--q-parch-code);

  color: var(--q-parch-ink);

  :deep(.markdown-body) {
    font-size: 13px;
    color: var(--q-parch-ink);
  }

  :deep(h1),
  :deep(h2),
  :deep(h3),
  :deep(h4) {
    margin: 14px 0 6px;
    padding: 0;
    border: none;
    color: var(--q-ink-soft);
    font-size: 14px;
    font-weight: 700;
  }

  :deep(h1:first-child),
  :deep(h2:first-child) {
    margin-top: 0;
  }

  :deep(p),
  :deep(ul),
  :deep(ol) {
    margin-bottom: 8px;
  }

  :deep(code) {
    background: var(--q-parch-code);
    color: var(--q-edge);
  }

  :deep(blockquote) {
    color: var(--q-parch-quote-ink);
  }
}

.parch-actions {
  display: flex;
  gap: 18px;
  margin-top: 10px;
}

/* ── 链接、按钮、折叠 ── */

.q-link {
  align-self: flex-start;
  padding: 0;
  border: none;
  background: none;
  color: var(--q-gold);
  font: inherit;
  font-size: 12px;
  cursor: pointer;

  &:hover {
    text-decoration: underline;
    text-underline-offset: 3px;
  }

  &:focus-visible {
    outline: 2px solid var(--q-gold);
    outline-offset: 3px;
  }

  &.is-ink {
    color: var(--q-parch-link);
    font-weight: 600;
  }

  &.is-fold {
    margin-top: 14px;
  }
}

.q-btn {
  flex-shrink: 0;
  padding: 2px 8px;
  border: none;
  background: var(--q-brass);
  color: var(--q-ink);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  box-shadow:
    inset -2px -2px 0 0 var(--q-brass-dark),
    inset 2px 2px 0 0 var(--q-gold);

  &:hover {
    background: var(--q-gold);
  }

  &:active {
    box-shadow:
      inset 2px 2px 0 0 var(--q-brass-dark),
      inset -2px -2px 0 0 var(--q-gold);
  }

  &:focus-visible {
    outline: 2px solid var(--q-paper);
    outline-offset: 2px;
  }
}

.q-fold-box {
  margin: 28px 3px 0;
  padding: 0;
}

.fold-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 12px 16px;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;

  &:hover .fold-toggle {
    color: var(--q-gold);
  }

  &:focus-visible {
    outline: 2px solid var(--q-gold);
    outline-offset: -4px;
  }
}

.fold-alert {
  color: var(--q-red);
  font-size: 12px;
}

.fold-toggle {
  margin-left: auto;
  color: var(--q-muted);
  font-size: 12px;
}

/* 停下的活：紧贴成果架的一行，不像任务板、日志那样隔开一大段 */
.q-fold-box.is-stops {
  margin-top: 12px;
}

.stops-line {
  overflow: hidden;
  min-width: 0;
  color: var(--q-red);
  font-size: 12px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.stop-item {
  padding: 8px 0;
  border-top: 2px dotted var(--q-rule);
  font-size: 12px;

  &:first-child {
    border-top: none;
  }
}

.stop-top {
  display: flex;
  align-items: center;
  gap: 8px;

  .q-link {
    margin-left: auto;
  }
}

.stop-when {
  color: var(--q-dim);
}

.stop-brief {
  margin: 4px 0 0;
  color: var(--q-paper);
  word-break: break-word;
}

.stop-reason {
  margin: 4px 0 0;
  color: var(--q-red);
  word-break: break-word;
}

.board-list,
.log-list {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0 16px 12px;
  list-style: none;
}

.board-item {
  display: grid;
  grid-template-columns: 10px minmax(0, 1fr) auto auto auto;
  align-items: center;
  gap: 10px;
  padding: 7px 0;
  border-top: 2px dotted var(--q-rule);
  font-size: 12px;

  &.is-done .board-title {
    color: var(--q-muted);
  }
}

.board-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.board-title {
  overflow: hidden;
  color: var(--q-paper);
  white-space: nowrap;
  text-overflow: ellipsis;
}

.board-note {
  overflow: hidden;
  color: var(--q-dim);
  white-space: nowrap;
  text-overflow: ellipsis;

  .is-blocked & {
    color: var(--q-red);
  }
}

.board-owner {
  color: var(--q-muted);
  white-space: nowrap;
}

.board-status {
  color: var(--q-dim);
  white-space: nowrap;
}

.log-list {
  padding-top: 0;
}

.log-item {
  display: grid;
  grid-template-columns: 5.4em 14px minmax(0, 1fr);
  align-items: start;
  gap: 8px;
  padding: 6px 0;
  border-top: 2px dotted var(--q-rule);
  font-size: 12px;

  &:first-child {
    border-top: none;
  }
}

.log-when {
  color: var(--q-dim);
  white-space: nowrap;
}

.log-icon {
  display: flex;
  justify-content: center;
  padding-top: 4px;
}

.log-body {
  min-width: 0;
}

.log-who {
  margin-right: 8px;
  color: var(--q-muted);

  &.is-block {
    display: block;
    margin: 0 0 2px;
  }
}

.log-md {
  /* 深木底上的浅色字：正文渲染器读的主题色就地换成委托板的那几个 */
  --color-text-primary: var(--q-paper);
  --color-text-secondary: var(--q-muted);
  --color-text-muted: var(--q-dim);
  --color-border: var(--q-rule);
  --color-border-subtle: var(--q-rule);
  --color-border-strong: var(--q-edge-hi);
  --color-accent-text: var(--q-gold);
  --color-accent-border: var(--q-edge-hi);
  --color-accent-bg: var(--q-panel-hi);
  --color-bg-sunken: var(--q-ink-soft);
  --color-bg-surface: var(--q-panel);
  --color-bg-surface-hover: var(--q-panel-hi);

  word-break: break-word;

  :deep(.markdown-body) {
    font-size: 12px;
    color: var(--q-paper);
  }

  :deep(h1),
  :deep(h2),
  :deep(h3),
  :deep(h4) {
    margin: 8px 0 4px;
    padding: 0;
    border: none;
    color: var(--q-gold);
    font-size: 13px;
    font-weight: 700;
  }

  :deep(p),
  :deep(ul),
  :deep(ol) {
    margin-bottom: 4px;
  }

  :deep(.markdown-body > *:last-child) {
    margin-bottom: 0;
  }

  :deep(code) {
    background: var(--q-ink-soft);
    color: var(--q-gold);
  }
}

.log-text {
  color: var(--q-paper);
  word-break: break-word;

  .is-crashed &,
  .is-recoverFailed &,
  .is-stopped & {
    color: var(--q-red);
  }

  .is-recovered & {
    color: var(--q-green);
  }

  &.is-link {
    padding: 0;
    border: none;
    background: none;
    color: var(--q-gold);
    font: inherit;
    text-align: left;
    cursor: pointer;

    &:hover {
      text-decoration: underline;
      text-underline-offset: 3px;
    }
  }
}

@media (prefers-reduced-motion: reduce) {
  .quest *,
  .quest *::before,
  .quest *::after {
    animation: none !important;
  }
}
</style>
