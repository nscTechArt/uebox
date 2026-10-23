<template>
  <!-- 团队日志里点开的一份交付：右侧面板一个页签，整页看全文 -->
  <article class="team-report">
    <header class="report-head">
      <h3 class="report-title">{{ job?.title ?? title }}</h3>
      <span v-if="job" class="report-meta" :title="exact(job.endedAt ?? job.startedAt)">
        {{
          t('assistant.teamBoard.ui.deliveredBy', {
            name: job.member,
            ago: ago(job.endedAt ?? job.startedAt)
          })
        }}
      </span>
    </header>
    <div class="report-body">
      <MarkdownRenderer v-if="job" :content="job.body || job.title" />
      <p v-else class="report-gone">{{ t('assistant.teamBoard.reportGone') }}</p>
    </div>
  </article>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import type { TeamActivity, TeamStateView } from '@core/shared/agentTeam'

import MarkdownRenderer from './MarkdownRenderer.vue'
import { useTeamLabels } from './teamBoardLabels'
import { buildBoardModel } from './teamBoardModel'

const props = defineProps<{
  team: TeamStateView
  activity?: TeamActivity[]
  /** 活的 id */
  jobId: string
  /** 打开时的标题：活从记录里没了也能说清是哪一份 */
  title: string
}>()
const { t } = useI18n()
const { ago, exact } = useTeamLabels()

const job = computed(() => {
  const model = buildBoardModel(props.team, props.activity ?? [], { running: false, now: 0 })
  return [...model.round, ...model.earlier].find((j) => j.id === props.jobId && j.state === 'done')
})
</script>

<style scoped>
.team-report {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  color: var(--color-text-primary);
}
.report-head {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-3);
  border-bottom: 1px solid var(--color-border-subtle);
}
.report-title {
  margin: 0;
  font-size: var(--font-size-md);
  font-weight: 600;
}
.report-meta {
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
}
.report-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: var(--space-3);
}
.report-gone {
  margin: 0;
  color: var(--color-text-secondary);
}
</style>
