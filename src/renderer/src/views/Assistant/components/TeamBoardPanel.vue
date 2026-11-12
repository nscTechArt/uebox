<template>
  <!--
    工作室模式（/team）的任务板：办公室，加上下面这块「谁在干、交回了什么」。

    两处出现：输入框正上方只有一行摘要 —— 跑起来之后用户最常问的是「做到哪了」，
    几个人、到了哪一步、交回几份就答了；点它在右侧面板打开「团队任务」页签（docked），
    整块高度给办公室和任务板。不另开页面 —— 它是这条对话的一部分
    （见 docs/AI游戏工作室设计-2026-09-25.md 第 3 节）。

    办公室有两种画风，下面跟着走：像素画风是「委托板」（TeamQuestBoard），
    简约画风是一人一条泳道（TeamLaneBoard）。两者读同一份模型（teamBoardModel.ts），
    设计见 docs/团队任务板可读性-2026-10-14.md。
  -->
  <section
    class="team-board"
    :class="{ 'is-docked': docked }"
    :aria-label="t('assistant.teamBoard.title')"
  >
    <component
      :is="docked ? 'div' : 'button'"
      :type="docked ? undefined : 'button'"
      class="team-board-head"
      :title="docked ? undefined : t('assistant.teamBoard.openTab')"
      @click="docked || emit('open')"
    >
      <PhUsersThree class="head-icon" />
      <span class="head-title">{{ t('assistant.teamBoard.title') }}</span>
      <span class="head-meta">{{ summary }}</span>
      <AppTag v-if="!docked && verdictTag" :tone="verdictTag.tone" :title="verdictTag.title">
        {{ verdictTag.label }}
      </AppTag>
      <!-- 外部团队：大脑在 Claude Code，队员用什么模型盒子不知道，照实说。混合团队的队员在盒子里，不用说 -->
      <AppTag
        v-if="team.external && !team.hostedMembers"
        tone="info"
        :title="t('assistant.teamBoard.external.hint')"
      >
        {{ t('assistant.teamBoard.external.label') }}
      </AppTag>

      <!-- 团队花了多少：默认只露总数，点开按人看。不进上面的摘要句：那句说的是进度 -->
      <AppDropdown v-if="docked && usageLabel" placement="bottomRight">
        <AppButton
          class="team-board-usage"
          size="small"
          variant="text"
          :title="t('assistant.teamBoard.usage.open')"
        >
          {{ usageLabel }}
        </AppButton>
        <template #overlay>
          <div class="usage-pop" role="dialog" :aria-label="t('assistant.teamBoard.usage.title')">
            <div class="usage-pop-title">{{ t('assistant.teamBoard.usage.title') }}</div>
            <div v-for="row in usageRows" :key="row.who" class="usage-pop-row">
              <span class="usage-pop-who">{{ row.label }}</span>
              <span>{{ row.value }}</span>
            </div>
            <div class="usage-pop-row is-total">
              <span>{{ t('assistant.teamBoard.usage.total') }}</span>
              <span>{{ usageLabel }}</span>
            </div>
            <div class="usage-pop-hint">{{ t('assistant.teamBoard.usage.hint') }}</div>
            <div v-if="usagePartial" class="usage-pop-hint">
              {{ t('assistant.teamBoard.usage.partialCost') }}
            </div>
          </div>
        </template>
      </AppDropdown>
      <PhCaretRight v-if="!docked" class="caret" />
      <AppButton
        v-else
        class="team-board-end"
        size="small"
        variant="text"
        :disabled="running || team.ended"
        :title="endTitle"
        @click="emit('end')"
      >
        {{ team.ended ? t('assistant.teamBoard.external.ended') : t('assistant.teamBoard.end') }}
      </AppButton>
    </component>

    <div
      v-if="docked"
      class="team-board-body"
      :class="`is-${style}`"
      :style="style === 'v2' ? QUEST_VARS : undefined"
    >
      <div class="office-wrap">
        <TeamOffice
          :team="team"
          :running="running"
          :session-id="sessionId"
          :activity="activity ?? []"
          :model-choices="modelChoices"
          :selected="selected"
          :highlight="hovered"
          @select="select"
        />
      </div>
      <component
        :is="style === 'v2' ? TeamQuestBoard : TeamLaneBoard"
        :team="team"
        :model="model"
        :activity="activity ?? []"
        :selected="selected"
        :model-choices="modelChoices"
        :models-loaded="modelsLoaded"
        @select="select"
        @hover="hovered = $event"
        @reopen="emit('reopen', $event)"
        @reopen-job="emit('reopen-job', $event)"
        @open-models="emit('open-models')"
        @set-model="(name: string, m: TeamModel) => emit('set-model', name, m)"
        @dismiss="(name: string, reason: string) => emit('dismiss', name, reason)"
        @open-report="emit('open-report', $event)"
      />
      <TeamDismissalList
        class="team-board-dismissals"
        :dismissals="team.dismissals"
        :pixel="style === 'v2'"
      />
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { PhCaretRight, PhUsersThree } from '@phosphor-icons/vue'

import AppButton from '@renderer/components/AppButton.vue'
import AppDropdown from '@renderer/components/AppDropdown.vue'
import AppTag from '@renderer/components/AppTag.vue'
import {
  ACCEPTOR,
  PRODUCER,
  type TeamActivity,
  type TeamModel,
  type TeamModelCandidate,
  type TeamStateView,
  type TeamUsage,
  type TeamVerdict
} from '@core/shared/agentTeam'
import type { TeamReportTab } from '../composables/useTeamTab'
import TeamDismissalList from './TeamDismissalList.vue'
import TeamLaneBoard from './teamLanes/TeamLaneBoard.vue'
import TeamOffice from './teamOffice/TeamOffice.vue'
import { officeStyle } from './teamOffice/officeStyle'
import TeamQuestBoard from './teamQuest/TeamQuestBoard.vue'
import { QUEST_VARS } from './teamQuest/questPalette'
import { useTeamLabels } from './teamBoardLabels'
import { buildBoardModel } from './teamBoardModel'
import { teamUsageRows, usageCostIsPartial } from './teamUsage'
import { formatTokenCount, formatUsageCost } from '../composables/tokenUsageFormat'

const props = defineProps<{
  team: TeamStateView
  /** 这条对话正在跑：这时候不能结束团队模式（这一轮收尾会把团队状态写回去） */
  running?: boolean
  /** 队员能换成哪些模型。和制作人招人时的候选同一份 */
  modelChoices?: TeamModelCandidate[]
  /** 模型设置读到过没有。没读到时不能说某个模型「用不了」 */
  modelsLoaded?: boolean
  /** 在右侧面板里整块显示；不带时只有输入框上方那一行摘要 */
  docked?: boolean
  /** 内核 session：办公室按它认制作人的实时进度 */
  sessionId?: string
  /** 队员最近的动态，旧的在前 */
  activity?: TeamActivity[]
}>()
const emit = defineEmits<{
  /** 用户点了摘要行：在右侧面板打开「团队任务」 */
  open: []
  /** 用户把一项卡住的改回待办 */
  reopen: [taskId: string]
  /** 用户把一件停下的活交回制作人 */
  'reopen-job': [jobId: string]
  /** 用户结束团队模式 */
  end: []
  /** 用户在日志里点了一份交付：右侧面板另开页签看全文 */
  'open-report': [report: TeamReportTab]
  /** 用户打开了团队任务或换模型菜单：重读一次模型设置 */
  'open-models': []
  /** 用户给队员换了模型 */
  'set-model': [name: string, model: TeamModel]
  /** 用户辞退了一个队员（理由必填） */
  dismiss: [name: string, reason: string]
}>()
const { t } = useI18n()
const { ago, now } = useTeamLabels()
const style = officeStyle

/** 打开时顺手重读模型名单：用户可能刚在设置页增删过来源，模型名和「用不了」要跟上 */
onMounted(() => {
  if (props.docked) emit('open-models')
})

const model = computed(() =>
  buildBoardModel(props.team, props.activity ?? [], { running: !!props.running, now: now.value })
)

/** 外部团队结束只是标记：它的循环在 Claude Code 里，要用户自己去那边停 */
const endTitle = computed(() => {
  if (props.running) return t('assistant.teamBoard.endWhileRunning')
  return props.team.external
    ? t('assistant.teamBoard.external.endHint')
    : t('assistant.teamBoard.endHint')
})

// ── 团队用量 ────────────────────────────────────────────────────────────

/** 「12k tokens · $0.42」。没价目的模型不显示金额，全团队都没价目就只有 token 数 */
function usageText(usage: TeamUsage): string {
  const total = formatTokenCount(usage.total)
  const cost = formatUsageCost(usage.cost)
  return cost
    ? t('assistant.teamBoard.usage.labelWithCost', { total, cost })
    : t('assistant.teamBoard.usage.label', { total })
}

const usageLabel = computed(() => {
  const total = props.team.usage?.total
  return total && (total.total > 0 || total.cost > 0) ? usageText(total) : ''
})
const usagePartial = computed(() => usageCostIsPartial(props.team.usage?.total))
const usageRows = computed(() =>
  teamUsageRows(props.team.usage, props.team.members).map((row) => ({
    who: row.who,
    label:
      row.who === PRODUCER
        ? t('assistant.teamBoard.producer')
        : row.who === ACCEPTOR
          ? t('assistant.teamBoard.usage.acceptor')
          : row.who,
    value: usageText(row.usage)
  }))
)

// ── 摘要行 ──────────────────────────────────────────────────────────────

const phaseLabel = computed(() => {
  const m = model.value
  if (m.phase !== 'alert') return t(`assistant.teamBoard.ui.phase.${m.phase}`)
  return m.stopped
    ? t('assistant.teamBoard.ui.alertStopped', { n: m.stopped })
    : t('assistant.teamBoard.ui.alertBlocked', { n: m.blocked })
})

const summary = computed(() => {
  const m = model.value
  const parts = [
    t('assistant.teamBoard.ui.people', { n: props.team.members.length }),
    phaseLabel.value
  ]
  if (m.round.length) {
    parts.push(
      t('assistant.teamBoard.ui.roundCount', {
        done: m.round.filter((j) => j.state === 'done').length,
        total: m.round.length
      })
    )
  }
  // 收起时这一行是唯一看得到的地方，总数跟在后面；展开后挪到右边那个能点开的按钮上
  if (!props.docked && usageLabel.value) parts.push(usageLabel.value)
  return parts.join(' · ')
})

type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info'
const VERDICT_TONE: Record<TeamVerdict, Tone> = {
  pass: 'success',
  fail: 'warning',
  blocked: 'danger'
}

/**
 * 摘要行上的验收标签：只挂这一轮、没人在跑时的结论（见 buildBoardModel）。
 * 验收之后工程又改过：那次结论只说明当时的游戏，换成中性的「改动后未重验」（2026-09-30 真机）
 */
const verdictTag = computed(() => {
  const v = model.value.verdict
  if (!v) return null
  return {
    label: v.stale
      ? t('assistant.teamBoard.verdict.stale')
      : t(`assistant.teamBoard.verdict.${v.kind}`),
    tone: v.stale ? ('neutral' as Tone) : VERDICT_TONE[v.kind],
    title:
      v.at !== undefined
        ? t('assistant.teamBoard.verdictTitle', { count: v.count, when: ago(v.at) })
        : undefined
  }
})

// ── 只看某个队员（在办公室里点人，或点下面的卡片 / 泳道） ───────────────

const memberId = (name: string): string => name.trim().toLowerCase()
const selected = ref<string | null>(null)
/** 鼠标停在哪个人身上：办公室里把那个人标出来 */
const hovered = ref<string | null>(null)
function select(id: string | null): void {
  selected.value = id
}
// 名册里没这个人了（结束重开、换了一批人），选中跟着撤掉
watch(
  () => props.team.members.map((m) => memberId(m.name)),
  (ids) => {
    if (selected.value && !ids.includes(selected.value)) selected.value = null
  }
)
</script>

<style scoped lang="less">
.team-board {
  margin-bottom: var(--space-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-surface);
  overflow: hidden;
}

.team-board.is-docked {
  display: flex;
  flex-direction: column;
  height: 100%;
  margin: 0;
  border: none;
  border-radius: 0;
}

.team-board-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-2) var(--space-3);
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  font-family: inherit;
  font-size: var(--font-size-sm);
  text-align: left;
  cursor: pointer;
  transition: background-color 140ms ease;

  &:hover {
    background: var(--color-bg-surface-hover);
  }

  &:focus-visible {
    outline: 2px solid var(--color-border-focus);
    outline-offset: -2px;
  }

  .is-docked > & {
    flex-shrink: 0;
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--color-border-subtle);
    cursor: default;

    &:hover {
      background: transparent;
    }
  }
}

.head-icon {
  flex-shrink: 0;
  color: var(--color-text-primary);
}

.head-title {
  color: var(--color-text-primary);
  font-weight: var(--font-weight-semibold);
}

.head-meta {
  flex: 1;
  min-width: 0;
  color: var(--color-text-muted);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.caret,
.team-board-usage,
.team-board-end {
  flex-shrink: 0;
  color: var(--color-text-muted);
}

.team-board-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;

  /* 像素画风下，办公室下面接一整块深木色的委托板，滚到底也是它 */
  &.is-v2 {
    background: var(--q-bg);
  }
}

.team-board-dismissals {
  padding: var(--space-3) var(--space-4) var(--space-4);
}

.office-wrap {
  padding: var(--space-4) var(--space-4) 0;

  /* 像素画风：办公室装进一个缺角的木框，和下面委托板的框是一套 */
  .is-v2 > & {
    padding: 19px 19px 0;

    :deep(.team-office),
    :deep(.office-canvas) {
      border-radius: 0;
    }

    :deep(.team-office) {
      background: var(--q-ink);
      box-shadow:
        0 -3px 0 0 var(--q-banner-edge),
        0 3px 0 0 var(--q-banner-edge),
        -3px 0 0 0 var(--q-banner-edge),
        3px 0 0 0 var(--q-banner-edge);
    }
  }
}

.team-board-usage {
  font-variant-numeric: tabular-nums;
}

.usage-pop {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 220px;
  max-width: 320px;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-md);
  background: var(--color-bg-raised);
  box-shadow: var(--shadow-menu);
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
}

.usage-pop-title {
  color: var(--color-text-primary);
  font-weight: var(--font-weight-semibold);
}

.usage-pop-row {
  display: flex;
  justify-content: space-between;
  gap: var(--space-3);
  font-variant-numeric: tabular-nums;

  &.is-total {
    margin-top: var(--space-1);
    padding-top: var(--space-1);
    border-top: 1px solid var(--color-border-subtle);
    color: var(--color-text-primary);
  }
}

.usage-pop-who {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.usage-pop-hint {
  color: var(--color-text-muted);
}

@media (prefers-reduced-motion: reduce) {
  .team-board-head {
    transition: none;
  }
}
</style>
