<template>
  <!--
    辞退档案：默认只露一行「已辞退 N 人」，点开逐条看谁辞的、依据、理由、证据、
    盒子数出的事实、任务交接。读的是主进程的 `dismissals.json`，不截断。
  -->
  <section v-if="records.length" class="dismissals" :class="{ 'is-pixel': pixel }">
    <button type="button" class="fold" :aria-expanded="open" @click="open = !open">
      <PhCaretRight class="caret" :class="{ 'is-open': open }" />
      {{ t('assistant.teamBoard.dismiss.records', { n: records.length }) }}
    </button>
    <ul v-if="open" class="records">
      <li v-for="record in records" :key="`${record.name}-${record.at}`" class="record">
        <div class="record-head">
          <span class="record-name">{{ record.name }}</span>
          <span class="record-meta">
            {{
              record.by === 'user'
                ? t('assistant.teamBoard.dismiss.byUser')
                : t('assistant.teamBoard.dismiss.byProducer')
            }}
            <template v-if="record.by === 'producer'">
              · {{ t(`assistant.teamBoard.dismiss.grounds.${record.grounds}`) }}
            </template>
            · <span :title="exact(record.at)">{{ ago(record.at) }}</span>
          </span>
        </div>
        <p class="record-reason">{{ record.reason }}</p>
        <p class="record-line">
          {{
            t('assistant.teamBoard.dismiss.facts', {
              done: record.facts.jobsDone,
              stopped: record.facts.jobsStopped
            })
          }}
          <template v-if="record.memoryArchive">
            · {{ t('assistant.teamBoard.dismiss.memoryArchived') }}
          </template>
        </p>
        <ul v-if="record.evidence.length" class="record-evidence">
          <li v-for="item in record.evidence" :key="item.id">
            {{ t('assistant.teamBoard.dismiss.evidence') }} · {{ item.id }} {{ item.text }}
          </li>
        </ul>
        <p v-if="record.handover.tasks.length" class="record-line">
          {{
            record.handover.to
              ? t('assistant.teamBoard.dismiss.handedTo', {
                  name: record.handover.to,
                  tasks: record.handover.tasks.join(', ')
                })
              : t('assistant.teamBoard.dismiss.unassigned', {
                  tasks: record.handover.tasks.join(', ')
                })
          }}
        </p>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { PhCaretRight } from '@phosphor-icons/vue'

import type { TeamDismissal } from '@core/shared/agentTeam'

import { useTeamLabels } from './teamBoardLabels'

const props = defineProps<{
  dismissals?: TeamDismissal[]
  /** 像素画风：底是深木色，字换成委托板那套颜色 */
  pixel?: boolean
}>()
const { t } = useI18n()
const { ago, exact } = useTeamLabels()

const open = ref(false)
/** 新的在前 */
const records = computed(() => [...(props.dismissals ?? [])].reverse())
</script>

<style scoped lang="less">
.dismissals {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.fold {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: 0;
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  font-family: inherit;
  font-size: var(--font-size-sm);
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

.caret {
  flex-shrink: 0;
  transition: transform 0.15s ease;

  &.is-open {
    transform: rotate(90deg);
  }
}

.records {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin: 0;
  padding: 0;
  list-style: none;
}

.record {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  font-size: var(--font-size-sm);

  p {
    margin: 0;
  }
}

.record-head {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
}

.record-name {
  color: var(--color-text-primary);
  font-weight: 600;
}

.record-meta,
.record-line,
.record-evidence {
  color: var(--color-text-secondary);
}

.record-reason {
  color: var(--color-text-primary);
  white-space: pre-wrap;
}

.record-evidence {
  margin: 0;
  padding-left: var(--space-4);
}

.is-pixel {
  .fold,
  .record-meta,
  .record-line,
  .record-evidence {
    color: var(--q-dim);
  }

  .fold:hover,
  .record-name,
  .record-reason {
    color: var(--q-paper);
  }
}
</style>
