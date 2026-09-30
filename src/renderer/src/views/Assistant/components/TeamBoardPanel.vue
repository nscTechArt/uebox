<template>
  <!--
    工作室模式（/team）的任务板：名册、任务、留言、验收结论。

    挂在输入框正上方、默认收起成一行：跑起来之后用户最常问的是「做到哪了」，
    一行摘要（几个人、几件完成、验收过没过）就答了；要细看再展开。
    不另开页面 —— 它是这条会话的一部分（见 docs/AI游戏工作室设计-2026-09-25.md 第 3 节）。
  -->
  <section class="team-board" :aria-label="t('assistant.teamBoard.title')">
    <button
      type="button"
      class="team-board-head"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      <PhUsersThree class="head-icon" />
      <span class="head-title">{{ t('assistant.teamBoard.title') }}</span>
      <span class="head-meta">
        {{
          t('assistant.teamBoard.summary', {
            members: team.members.length,
            done: doneCount,
            total: team.board.length
          })
        }}
      </span>
      <AppTag v-if="team.verdict" :tone="verdictTone" :title="verdictTitle">
        {{ verdictLabel }}
      </AppTag>
      <PhCaretDown class="caret" :class="{ open: expanded }" />
    </button>

    <div v-if="expanded" class="team-board-body">
      <p class="objective">
        <span class="label">{{ t('assistant.teamBoard.objective') }}</span>
        {{ team.objective }}
      </p>

      <ul v-if="team.members.length" class="members">
        <li v-for="member in team.members" :key="member.name" :title="member.persona">
          <span class="member-name">{{ member.name }}</span>
          <span v-if="member.tier === 'fast'" class="member-flag">
            {{ t('assistant.teamBoard.fast') }}
          </span>
          <span v-if="member.readOnly" class="member-flag">
            {{ t('assistant.teamBoard.readOnly') }}
          </span>
        </li>
      </ul>
      <p v-else class="empty">{{ t('assistant.teamBoard.noMembers') }}</p>

      <ul v-if="sortedTasks.length" class="tasks">
        <li
          v-for="task in sortedTasks"
          :key="task.id"
          class="task"
          :class="{ 'task--old': isOld(task) }"
        >
          <div class="task-line">
            <AppTag :tone="STATUS_TONE[task.status]" :title="statusHint(task.status)">
              {{ statusLabel(task.status) }}
            </AppTag>
            <span class="task-title">{{ task.title }}</span>
            <span v-if="task.owner" class="task-owner">@{{ task.owner }}</span>
            <span
              class="task-when"
              :title="isOld(task) ? t('assistant.teamBoard.oldHint') : undefined"
            >
              <template v-if="task.reopenedAt">{{ t('assistant.teamBoard.reopened') }} · </template>
              <template v-else-if="isOld(task)">{{ t('assistant.teamBoard.old') }} · </template>
              {{ ago(task.reopenedAt ?? task.updatedAt) }}
            </span>
            <AppButton
              v-if="task.status === 'blocked'"
              class="task-reopen"
              size="small"
              variant="text"
              :title="t('assistant.teamBoard.reopenHint')"
              @click="emit('reopen', task.id)"
            >
              {{ t('assistant.teamBoard.reopen') }}
            </AppButton>
          </div>
          <p v-if="task.note" class="task-detail">
            {{
              task.status === 'blocked'
                ? t('assistant.teamBoard.blockedReason')
                : t('assistant.teamBoard.note')
            }}{{ task.note }}
          </p>
          <p v-if="task.evidence" class="task-detail">
            {{ t('assistant.teamBoard.evidence') }}{{ task.evidence }}
          </p>
        </li>
      </ul>
      <p v-else class="empty">{{ t('assistant.teamBoard.noTasks') }}</p>

      <div v-if="recentMail.length" class="mail">
        <h4>{{ t('assistant.teamBoard.mail') }}</h4>
        <ul>
          <li v-for="mail in recentMail" :key="mail.id">
            <span class="mail-route">{{ who(mail.from) }} → {{ who(mail.to) }}</span>
            <span class="mail-text">{{ mail.text }}</span>
            <span class="mail-receipt">{{ receipt(mail) }}</span>
          </li>
        </ul>
      </div>

      <div class="team-board-foot">
        <AppButton
          size="small"
          variant="text"
          :disabled="running"
          :title="
            running ? t('assistant.teamBoard.endWhileRunning') : t('assistant.teamBoard.endHint')
          "
          @click="emit('end')"
        >
          {{ t('assistant.teamBoard.end') }}
        </AppButton>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { PhCaretDown, PhUsersThree } from '@phosphor-icons/vue'

import AppButton from '@renderer/components/AppButton.vue'
import AppTag from '@renderer/components/AppTag.vue'
import {
  PRODUCER,
  type BoardTask,
  type TaskStatus,
  type TeamMail,
  type TeamStateView,
  type TeamVerdict
} from '@core/shared/agentTeam'

const props = defineProps<{
  team: TeamStateView
  /** 这条会话正在跑：这时候不能结束团队模式（这一轮收尾会把团队状态写回去） */
  running?: boolean
}>()
const emit = defineEmits<{
  /** 用户把一项卡住的改回待办 */
  reopen: [taskId: string]
  /** 用户结束团队模式 */
  end: []
}>()
const { t } = useI18n()

const expanded = ref(false)

type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info'

const STATUS_TONE: Record<TaskStatus, Tone> = {
  doing: 'info',
  blocked: 'danger',
  todo: 'neutral',
  done: 'success'
}

const VERDICT_TONE: Record<TeamVerdict, Tone> = {
  pass: 'success',
  fail: 'warning',
  blocked: 'danger'
}

/** 正在干的和卡住的排前面 —— 用户展开来看，多半是想知道现在在忙什么、哪里堵了 */
const STATUS_ORDER: Record<TaskStatus, number> = { doing: 0, blocked: 1, todo: 2, done: 3 }

/** 展开后最多显示几条留言。全量在主进程的账本里 */
const MAIL_SHOWN = 8

const doneCount = computed(() => props.team.board.filter((task) => task.status === 'done').length)

const sortedTasks = computed(() =>
  [...props.team.board].sort(
    (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.updatedAt - a.updatedAt
  )
)

const recentMail = computed(() => props.team.mail.slice(-MAIL_SHOWN).reverse())

/**
 * 「完成」是队员自己标的，盒子不核实。2026-09-26 真机：美术队员标了完成，
 * 证据里自己写着材质没建，用户看到「完成」却对着一块纯色蓝板。
 * 所以验收通过之前一律叫「自报完成」，真正的完成以验收结论为准。
 */
const accepted = computed(() => props.team.verdict === 'pass' && !props.team.verdictStale)

/**
 * 验收之后工程又改过：那次结论只说明当时的游戏。红牌「未过」一直挂着，
 * 用户会以为现在还是那样（2026-09-30 真机），所以换成中性的「改动后未重验」。
 */
const verdictLabel = computed(() =>
  props.team.verdictStale
    ? t('assistant.teamBoard.verdict.stale')
    : t(`assistant.teamBoard.verdict.${props.team.verdict}`)
)
const verdictTone = computed<Tone>(() =>
  props.team.verdictStale || !props.team.verdict ? 'neutral' : VERDICT_TONE[props.team.verdict]
)
const verdictTitle = computed(() =>
  props.team.verdictAt === undefined
    ? undefined
    : t('assistant.teamBoard.verdictTitle', {
        count: props.team.deliveries,
        when: ago(props.team.verdictAt)
      })
)

/**
 * 「进行中 / 卡住」是对「现在」的断言。这一轮开始之后没人再碰过的，
 * 是上一轮留下的说法，灰掉 —— 2026-09-30 真机：第一轮标的 5 个「卡住」，
 * 之后几轮一直挂着，用户分不清是现在卡着还是早就过去了。
 */
function isOld(task: BoardTask): boolean {
  const since = props.team.roundStartedAt
  return (
    since !== undefined &&
    task.reopenedAt === undefined &&
    (task.status === 'doing' || task.status === 'blocked') &&
    task.updatedAt < since
  )
}

function ago(at: number): string {
  const minutes = Math.round((Date.now() - at) / 60_000)
  if (minutes < 1) return t('assistant.teamBoard.ago.justNow')
  if (minutes < 60) return t('assistant.teamBoard.ago.minutes', { n: minutes })
  const hours = Math.round(minutes / 60)
  if (hours < 48) return t('assistant.teamBoard.ago.hours', { n: hours })
  return t('assistant.teamBoard.ago.days', { n: Math.round(hours / 24) })
}

function statusLabel(status: TaskStatus): string {
  if (status === 'done' && !accepted.value) return t('assistant.teamBoard.status.selfReported')
  return t(`assistant.teamBoard.status.${status}`)
}

function statusHint(status: TaskStatus): string | undefined {
  return status === 'done' && !accepted.value
    ? t('assistant.teamBoard.selfReportedHint')
    : undefined
}

function who(name: string): string {
  return name === PRODUCER ? t('assistant.teamBoard.producer') : name
}

/** 回执：读到了、塞进去了还没读、还在信箱里 */
function receipt(mail: TeamMail): string {
  if (mail.readAt) return t('assistant.teamBoard.receipt.read')
  if (mail.deliveredAt) return t('assistant.teamBoard.receipt.delivered')
  return t('assistant.teamBoard.receipt.queued')
}
</script>

<style scoped lang="less">
.team-board {
  margin-bottom: var(--space-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-surface);
  overflow: hidden;
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
}

.head-icon {
  flex-shrink: 0;
  color: var(--color-text-primary);
}

.head-title {
  color: var(--color-text-primary);
  font-weight: 600;
}

.head-meta {
  flex: 1;
  min-width: 0;
  color: var(--color-text-muted);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.caret {
  flex-shrink: 0;
  color: var(--color-text-muted);
  transition: transform 160ms ease;

  &.open {
    transform: rotate(180deg);
  }
}

.team-board-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  max-height: 280px;
  padding: 0 var(--space-3) var(--space-3);
  overflow-y: auto;
  font-size: var(--font-size-sm);
}

.objective {
  margin: 0;
  color: var(--color-text-primary);

  .label {
    margin-right: var(--space-1);
    color: var(--color-text-muted);
  }
}

.members {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  margin: 0;
  padding: 0;
  list-style: none;

  li {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    padding: 2px var(--space-2);
    border: 1px solid var(--color-border-subtle);
    border-radius: var(--radius-full);
    background: var(--color-bg-sunken);
    color: var(--color-text-primary);
  }
}

.member-flag {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.tasks {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
}

.task {
  padding: var(--space-1) 0;
  border-top: 1px solid var(--color-separator);

  &:first-child {
    border-top: none;
  }
}

.task-line {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.task-title {
  flex: 1;
  min-width: 0;
  color: var(--color-text-primary);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.task-owner,
.task-when,
.task-detail {
  color: var(--color-text-muted);
}

.task-when {
  flex-shrink: 0;
  font-size: var(--font-size-xs);
  white-space: nowrap;
}

.task-reopen {
  flex-shrink: 0;
}

/* 上一轮留下的说法：退到背景里，但还读得清 */
.task--old {
  .task-title {
    color: var(--color-text-muted);
  }

  :deep(.app-tag) {
    opacity: 0.6;
  }
}

.team-board-foot {
  display: flex;
  justify-content: flex-end;
}

.task-detail {
  margin: 2px 0 0;
  overflow-wrap: anywhere;
}

.mail {
  h4 {
    margin: 0 0 var(--space-1);
    color: var(--color-text-secondary);
    font-size: var(--font-size-sm);
    font-weight: 600;
  }

  ul {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    margin: 0;
    padding: 0;
    list-style: none;
  }
}

.mail-route {
  margin-right: var(--space-2);
  color: var(--color-text-muted);
  white-space: nowrap;
}

.mail-text {
  color: var(--color-text-primary);
  overflow-wrap: anywhere;
}

.mail-receipt {
  margin-left: var(--space-2);
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  white-space: nowrap;
}

.empty {
  margin: 0;
  color: var(--color-text-muted);
}

@media (prefers-reduced-motion: reduce) {
  .team-board-head,
  .caret {
    transition: none;
  }
}
</style>
