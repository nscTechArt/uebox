<template>
  <!--
    任务：回答「还剩什么」。按状态排，受阻的在最前，完成的折起来。

    默认：状态图标、标题、负责人、时间；受阻的多一个红标签和「重开」，原因始终露一行。
    点一行：展开备注全文和证据。
  -->
  <div class="task-list">
    <ul v-if="open.length" class="tasks">
      <li v-for="item in open" :key="item.id" class="task" :class="{ 'is-old': isOld(item) }">
        <TaskRow :task="item" />
      </li>
    </ul>
    <p v-else-if="!done.length" class="empty">
      {{
        selectedName
          ? t('assistant.teamBoard.office.noTasksFor', { name: selectedName })
          : t('assistant.teamBoard.noTasks')
      }}
    </p>

    <template v-if="done.length">
      <button
        type="button"
        class="done-fold"
        :aria-expanded="showDone"
        @click="doneOpen = !doneOpen"
      >
        <PhCaretRight class="fold-caret" :class="{ 'is-open': showDone }" />
        {{ t('assistant.teamBoard.doneFold', { n: done.length }) }}
      </button>
      <ul v-if="showDone" class="tasks">
        <li v-for="item in done" :key="item.id" class="task">
          <TaskRow :task="item" />
        </li>
      </ul>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, defineComponent, h, reactive, ref, type PropType } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  PhCaretRight,
  PhCheckCircle,
  PhCircle,
  PhCircleNotch,
  PhWarningCircle
} from '@phosphor-icons/vue'

import AppButton from '@renderer/components/AppButton.vue'
import AppTag from '@renderer/components/AppTag.vue'
import type { BoardTask, TaskStatus, TeamStateView } from '@core/shared/agentTeam'

import { useTeamLabels } from './teamBoardLabels'
import { crewColor, crewIndexOf, officeStyle } from './teamOffice/officeStyle'

const props = defineProps<{
  team: TeamStateView
  selected: string | null
}>()
const emit = defineEmits<{ reopen: [taskId: string] }>()
const { t } = useI18n()
const { ago, exact } = useTeamLabels()

const memberId = (name: string): string => name.trim().toLowerCase()

const selectedName = computed(
  () => props.team.members.find((m) => memberId(m.name) === props.selected)?.name ?? null
)

/** 受阻的最要紧，然后是在做的、没开始的 */
const ORDER: Record<TaskStatus, number> = { blocked: 0, doing: 1, todo: 2, done: 3 }

const mine = computed(() =>
  props.team.board.filter(
    (task) => !props.selected || (task.owner && memberId(task.owner) === props.selected)
  )
)
const open = computed(() =>
  mine.value
    .filter((task) => task.status !== 'done')
    .sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.updatedAt - a.updatedAt)
)
const done = computed(() =>
  mine.value.filter((task) => task.status === 'done').sort((a, b) => b.updatedAt - a.updatedAt)
)

/** 完成的默认折着；没有别的可看（全做完了）就直接摊开 */
const doneOpen = ref(false)
const showDone = computed(() => doneOpen.value || open.value.length === 0)

/**
 * 「完成」是队员自己标的，盒子不核实。验收通过之前一律叫「自报完成」，
 * 真正的完成以验收结论为准（2026-09-26 真机：标了完成，证据里自己写着没做完）。
 */
const accepted = computed(() => props.team.verdict === 'pass' && !props.team.verdictStale)

/**
 * 「进行中 / 卡住」是对「现在」的断言。这一轮开始之后没人再碰过的，
 * 是上一轮留下的说法，退到背景里（2026-09-30 真机）。
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

/** 只读队员写的「未修改任何文件，纯只读」：和名册上的锁说的是同一件事，不再重复 */
function noteOf(task: BoardTask): string {
  const owner = props.team.members.find(
    (m) => task.owner && memberId(m.name) === memberId(task.owner)
  )
  const note = task.note?.trim() ?? ''
  if (owner?.readOnly && /只读|未修改/.test(note) && note.length < 30) return ''
  return note
}

const expanded = reactive(new Set<string>())

const STATUS_ICON = {
  doing: PhCircleNotch,
  blocked: PhWarningCircle,
  todo: PhCircle,
  done: PhCheckCircle
} as const

/** 一行任务。写成局部组件，完成和未完成两组共用 */
const TaskRow = defineComponent({
  props: { task: { type: Object as PropType<BoardTask>, required: true } },
  setup(rowProps) {
    return () => {
      const task = rowProps.task
      const note = noteOf(task)
      const isOpen = expanded.has(task.id)
      const hasMore = !!task.evidence || note.length > 60
      const status = task.status
      const label =
        status === 'done' && !accepted.value
          ? t('assistant.teamBoard.status.selfReported')
          : t(`assistant.teamBoard.status.${status}`)
      const when = task.reopenedAt ?? task.updatedAt
      const whenText = task.reopenedAt
        ? `${t('assistant.teamBoard.reopened')} · ${ago(when)}`
        : isOld(task)
          ? `${t('assistant.teamBoard.old')} · ${ago(when)}`
          : t(
              status === 'done' ? 'assistant.teamBoard.doneAgo' : 'assistant.teamBoard.updatedAgo',
              {
                ago: ago(when)
              }
            )
      const toggle = (): void => {
        if (!hasMore) return
        if (isOpen) expanded.delete(task.id)
        else expanded.add(task.id)
      }
      const ownerColor = task.owner
        ? crewColor(crewIndexOf(props.team, task.owner), officeStyle.value)
        : undefined
      return [
        h(
          'div',
          {
            class: ['task-line', { 'is-clickable': hasMore }],
            role: hasMore ? 'button' : undefined,
            tabindex: hasMore ? 0 : undefined,
            'aria-expanded': hasMore ? isOpen : undefined,
            onClick: toggle,
            onKeydown: (event: KeyboardEvent) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                toggle()
              }
            }
          },
          [
            h(STATUS_ICON[status], {
              class: [
                'task-icon',
                `is-${status}`,
                { 'is-accepted': status === 'done' && accepted.value }
              ],
              weight: status === 'done' && accepted.value ? 'fill' : 'regular',
              role: 'img',
              'aria-label': label,
              title:
                status === 'done' && !accepted.value
                  ? t('assistant.teamBoard.selfReportedHint')
                  : label
            }),
            h('span', { class: 'task-title', title: task.title }, task.title),
            status === 'blocked'
              ? h(AppTag, { tone: 'danger', size: 'small' }, () =>
                  t('assistant.teamBoard.status.blocked')
                )
              : null,
            task.owner
              ? h('span', { class: 'task-owner' }, [
                  h('span', { class: 'owner-swatch', style: { background: ownerColor } }),
                  task.owner
                ])
              : null,
            h('span', { class: 'task-when', title: exact(when) }, whenText),
            status === 'blocked'
              ? h(
                  AppButton,
                  {
                    class: 'task-reopen',
                    size: 'small',
                    variant: 'text',
                    title: t('assistant.teamBoard.reopenHint'),
                    onClick: (event: MouseEvent) => {
                      event.stopPropagation()
                      emit('reopen', task.id)
                    }
                  },
                  () => t('assistant.teamBoard.reopen')
                )
              : null
          ]
        ),
        note
          ? h(
              'p',
              { class: ['task-note', { clamp: !isOpen, 'is-blocked': status === 'blocked' }] },
              [
                status === 'blocked'
                  ? h('span', { class: 'note-label' }, t('assistant.teamBoard.blockedReason'))
                  : null,
                note
              ]
            )
          : null,
        task.evidence && isOpen
          ? h('div', { class: 'task-evidence' }, [
              h('span', { class: 'note-label' }, t('assistant.teamBoard.evidence')),
              task.evidence
            ])
          : null
      ]
    }
  }
})
</script>

<style scoped lang="less">
.task-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.tasks {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
}

.task {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--space-2) 0;
  border-top: 1px solid var(--color-separator);

  &:first-child {
    border-top: none;
  }
}

:deep(.task-line) {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  font-size: var(--font-size-sm);
  line-height: var(--line-height-normal);
  border-radius: var(--radius-sm);

  &.is-clickable {
    cursor: pointer;
  }

  &:focus-visible {
    outline: 2px solid var(--color-border-focus);
    outline-offset: 2px;
  }
}

:deep(.task-icon) {
  flex-shrink: 0;
  width: 14px;
  height: 14px;

  &.is-doing {
    color: var(--color-accent-text);
  }

  &.is-blocked {
    color: var(--color-danger-text);
  }

  &.is-todo {
    color: var(--color-text-muted);
  }

  &.is-done {
    color: var(--color-text-secondary);
  }

  &.is-accepted {
    color: var(--color-success-text);
  }
}

:deep(.task-title) {
  flex: 1;
  min-width: 0;
  color: var(--color-text-primary);
  font-weight: var(--font-weight-medium);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* 上一轮留下的说法：标题退成次要色，不用透明度（规范：禁用态之外也不拿 opacity 降级） */
.is-old :deep(.task-title),
.is-old :deep(.task-icon) {
  color: var(--color-text-muted);
}

:deep(.task-owner) {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  gap: var(--space-1);
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  white-space: nowrap;
}

:deep(.owner-swatch) {
  width: 6px;
  height: 6px;
  border-radius: var(--radius-full);
}

:deep(.task-when) {
  flex-shrink: 0;
  min-width: 6em;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  font-variant-numeric: tabular-nums;
  text-align: right;
  white-space: nowrap;
}

:deep(.task-reopen) {
  flex-shrink: 0;
}

:deep(.task-note) {
  margin: 0;
  padding-left: calc(14px + var(--space-2));
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  line-height: var(--line-height-relaxed);
  overflow-wrap: anywhere;

  &.clamp {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 1;
    overflow: hidden;
  }
}

:deep(.note-label) {
  margin-right: var(--space-1);
  color: var(--color-text-muted);

  .is-blocked & {
    color: var(--color-danger-text);
  }
}

:deep(.task-evidence) {
  margin: var(--space-1) 0 0 calc(14px + var(--space-2));
  padding: var(--space-2) var(--space-3);
  border-left: 2px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-sunken);
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  line-height: var(--line-height-relaxed);
  white-space: pre-line;
  overflow-wrap: anywhere;
}

.done-fold {
  display: inline-flex;
  align-self: flex-start;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1) 0;
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  font-family: inherit;
  font-size: var(--font-size-xs);
  cursor: pointer;

  &:hover {
    color: var(--color-text-primary);
  }

  &:focus-visible {
    outline: 2px solid var(--color-border-focus);
    outline-offset: 1px;
    border-radius: var(--radius-sm);
  }
}

.fold-caret {
  transition: transform 140ms ease;

  &.is-open {
    transform: rotate(90deg);
  }
}

.empty {
  margin: 0;
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
}

@media (prefers-reduced-motion: reduce) {
  .fold-caret {
    transition: none;
  }
}
</style>
