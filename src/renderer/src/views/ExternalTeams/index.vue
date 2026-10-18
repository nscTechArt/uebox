<template>
  <!--
    外部团队：Claude Code 当大脑、盒子当工作室的那些团队（docs/外部大脑跑团队设计-2026-10-17.md）。
    它们没有盒子里的对话，所以单独一页：左边列团队，右边是和盒子里团队同一块任务板。
  -->
  <div class="external-teams">
    <aside class="team-list" :aria-label="t('externalTeams.title')">
      <header class="list-head">
        <h2 class="list-title">{{ t('externalTeams.title') }}</h2>
        <p class="list-intro">{{ t('externalTeams.intro') }}</p>
      </header>
      <AppEmpty
        v-if="loaded && teams.length === 0"
        class="list-empty"
        :title="t('externalTeams.empty')"
        :description="t('externalTeams.emptyHint')"
      />
      <ul v-else class="list-items">
        <li v-for="item in teams" :key="item.id">
          <button
            type="button"
            class="team-item"
            :class="{ 'is-selected': item.id === selectedId }"
            :aria-current="item.id === selectedId ? 'true' : undefined"
            @click="selectedId = item.id"
          >
            <span class="item-objective" :title="item.objective">{{ item.objective }}</span>
            <span class="item-meta">
              <AppTag :tone="statusOf(item).tone">{{ statusOf(item).label }}</AppTag>
              <span>{{ t('externalTeams.members', { n: item.members }) }}</span>
              <span>{{ formatDate(item.createdAt) }}</span>
            </span>
            <span v-if="item.projectPath" class="item-path" :title="item.projectPath">
              {{ item.projectPath }}
            </span>
          </button>
        </li>
      </ul>
    </aside>

    <section class="team-detail">
      <TeamBoardPanel
        v-if="board.team.value"
        docked
        :team="board.team.value"
        :session-id="selectedId"
        :activity="board.activity.value"
        @reopen="board.reopen"
        @reopen-job="board.reopenJob"
        @end="endSelected"
      />
      <AppEmpty v-else class="detail-empty" :title="t('externalTeams.pick')" />
    </section>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import AppEmpty from '@renderer/components/AppEmpty.vue'
import AppTag from '@renderer/components/AppTag.vue'
import type { TagTone } from '@renderer/components/AppTag.types'
import type { ExternalTeamSummary } from '@core/shared/agentTeam'
import { agentV3API } from '@renderer/api/agentV3'
import { message } from '@renderer/utils/messageManager'
import TeamBoardPanel from '@renderer/views/Assistant/components/TeamBoardPanel.vue'
import { useTeamBoard } from '@renderer/views/Assistant/composables/useTeamBoard'
import { externalTeamStatus } from './externalTeamStatus'

const { t, locale } = useI18n()
const teams = ref<ExternalTeamSummary[]>([])
const loaded = ref(false)
const selectedId = ref('')
const board = useTeamBoard(ref(''), selectedId)

async function load(): Promise<void> {
  try {
    teams.value = await agentV3API.externalTeams()
  } catch {
    // 读不到保留上一次的列表，别让页面闪空
  }
  loaded.value = true
  if (!teams.value.some((item) => item.id === selectedId.value)) {
    selectedId.value = teams.value[0]?.id ?? ''
  }
}

function statusOf(item: ExternalTeamSummary): { tone: TagTone; label: string } {
  const status = externalTeamStatus(item)
  return { tone: status.tone, label: t(`externalTeams.status.${status.key}`) }
}

function formatDate(at: number): string {
  return new Date(at).toLocaleString(locale.value, {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

/** 结束只是标记；Claude Code 那头还在跑的话，提醒用户自己去停 */
async function endSelected(): Promise<void> {
  const id = selectedId.value
  if (!id) return
  const result = await agentV3API.teamEnd(id).catch(() => null)
  if (!result?.success) {
    message.error(t('assistant.teamBoard.endFailed'))
    return
  }
  message.info(t('externalTeams.endedNotice'))
  await load()
}

// 任何外部团队的账变了（队员交活、记验收）都重读列表：状态标签跟着走
const onBoard = (...args: unknown[]): void => {
  const payload = args[0] as { sessionId?: string } | undefined
  if (payload?.sessionId?.startsWith('ext-')) void load()
}
const handler = window.api.on('agent-v3:team-board', onBoard)
onUnmounted(() => window.api.off('agent-v3:team-board', handler))
onMounted(load)
watch(selectedId, () => void board.refresh())
</script>

<style scoped lang="less">
.external-teams {
  display: flex;
  height: 100%;
  min-height: 0;
  background: var(--color-bg-page);
}

.team-list {
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  width: 300px;
  min-height: 0;
  border-right: 1px solid var(--color-border-subtle);
  background: var(--color-bg-surface);
}

.list-head {
  padding: var(--space-4);
  border-bottom: 1px solid var(--color-border-subtle);
}

.list-title {
  margin: 0;
  color: var(--color-text-primary);
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-semibold);
}

.list-intro {
  margin: var(--space-2) 0 0;
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
  line-height: 1.5;
}

.list-items {
  flex: 1;
  min-height: 0;
  margin: 0;
  padding: var(--space-2);
  overflow-y: auto;
  list-style: none;
}

.list-empty,
.detail-empty {
  margin: auto;
  padding: var(--space-4);
}

.team-item {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  width: 100%;
  padding: var(--space-2) var(--space-3);
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text-primary);
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

  &.is-selected {
    border-color: var(--color-border);
    background: var(--color-bg-selected);
  }
}

.item-objective {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-weight: var(--font-weight-semibold);
}

.item-meta {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.item-path {
  overflow: hidden;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  white-space: nowrap;
  text-overflow: ellipsis;
}

.team-detail {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
}
</style>
