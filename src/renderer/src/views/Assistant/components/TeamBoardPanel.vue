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
      <AppTag v-if="team.verdict" :tone="VERDICT_TONE[team.verdict]">
        {{ t(`assistant.teamBoard.verdict.${team.verdict}`) }}
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
        <li v-for="task in sortedTasks" :key="task.id" class="task">
          <div class="task-line">
            <AppTag :tone="STATUS_TONE[task.status]">
              {{ t(`assistant.teamBoard.status.${task.status}`) }}
            </AppTag>
            <span class="task-title">{{ task.title }}</span>
            <span v-if="task.owner" class="task-owner">@{{ task.owner }}</span>
          </div>
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
          </li>
        </ul>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { PhCaretDown, PhUsersThree } from '@phosphor-icons/vue'

import AppTag from '@renderer/components/AppTag.vue'
import {
  PRODUCER,
  type TaskStatus,
  type TeamStateView,
  type TeamVerdict
} from '@core/shared/agentTeam'

const props = defineProps<{ team: TeamStateView }>()
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

function who(name: string): string {
  return name === PRODUCER ? t('assistant.teamBoard.producer') : name
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
.task-detail {
  color: var(--color-text-muted);
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
